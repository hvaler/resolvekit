/**
 * The analyst behind the API: returns a stored analysis (cached live run or committed golden) for the documents the
 * web app shows, or runs the pipeline live (rate-limited) and reports its progress for polling. Model keys stay in
 * the server's environment; responses and logs carry no prompt or document text.
 */
import {
  ModelError,
  RateLimiter,
  analysisKey,
  analyzeCase,
  recheckSentence,
  type AnalysisInput,
  type AnalysisStore,
  type AnalystModel,
  type CallUsage,
  type CaseAnalysis,
  type Progress,
} from '@resolvekit/analyst/node';
import { canonicalJson } from '@resolvekit/analyst';
import { documentsSignature } from '@resolvekit/cases';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface LiveState {
  configured: boolean;
  model: string | null;
  remaining: number;
  limit: number;
  resetInSec: number;
}

interface Job {
  key: string;
  caseId: string;
  progress: Progress[];
  status: 'running' | 'done' | 'failed';
  error?: string;
  result?: CaseAnalysis;
  /** Settles when the run is done or failed. */
  done: Promise<void>;
}

export interface AnalystServiceOptions {
  /** null when no model key is configured: stored analyses are still served. */
  model: AnalystModel | null;
  /** The primary model's id: part of the cache key and the label. */
  primaryModel: string;
  store: AnalysisStore;
  liveLimit?: RateLimiter;
  verifyLimit?: RateLimiter;
  log?: (line: string) => void;
  onUsage?: (caseId: string, u: CallUsage) => void;
  now?: () => Date;
}

export type ServiceAnswer = { status: number; body: unknown };

/**
 * A quota reservation: taken atomically (check and count in one synchronous step, so concurrent requests can never
 * overshoot a cap) before the costly work starts; `release` refunds it when the work did not happen.
 */
export type Reservation = { ok: true; release: () => void } | { ok: false; refusal: ServiceAnswer };

/** Hosted mode: reserves a live model run (demo code, daily cap) right before it would start. Stored analyses never reach it. */
export type LiveGate = () => Reservation;

const HOUR = 3_600_000;

export class AnalystService {
  readonly primaryModel: string;
  private readonly o: AnalystServiceOptions;
  private readonly live: RateLimiter;
  private readonly verifies: RateLimiter;
  private readonly jobs = new Map<string, Job>();
  private readonly log: (line: string) => void;

  constructor(o: AnalystServiceOptions) {
    this.o = o;
    this.primaryModel = o.primaryModel;
    this.live = o.liveLimit ?? new RateLimiter({ limit: 6, windowMs: HOUR });
    this.verifies = o.verifyLimit ?? new RateLimiter({ limit: 30, windowMs: HOUR });
    this.log = o.log ?? (() => {});
  }

  liveState(): LiveState {
    const s = this.live.state();
    return { configured: !!this.o.model, model: this.o.model ? this.primaryModel : null, ...s };
  }

  key(input: AnalysisInput): Promise<string> {
    return analysisKey(input, this.primaryModel);
  }

  /** Stored analysis, running job, or a new live run. */
  async request(caseId: string, input: AnalysisInput, refresh: boolean, gate?: LiveGate): Promise<ServiceAnswer> {
    const key = await this.key(input);
    const live = () => this.liveState();
    const running = this.jobs.get(key);
    if (running?.status === 'running') return { status: 202, body: { status: 'running', key, progress: running.progress, live: live() } };
    if (!refresh) {
      const stored = this.o.store.get(key);
      if (stored) return { status: 200, body: { status: 'ready', key, origin: stored.origin, analysis: stored.analysis, live: live() } };
    }
    if (!this.o.model) {
      return { status: 503, body: { error: 'ANALYST_UNCONFIGURED', detail: 'No analysis is stored for these documents and no model key (GEMINI_API_KEY / GROQ_API_KEY) is set on the server', key, live: live() } };
    }
    const s = live();
    if (s.remaining <= 0) {
      return { status: 429, body: { error: 'RATE_LIMITED', detail: `Live analyses are limited to ${s.limit} per hour on this server; try again in ${Math.ceil(s.resetInSec / 60)} min`, key, live: s } };
    }
    // From here to start() nothing awaits: the hourly slot and the gate's reservation are taken together.
    const r = gate?.();
    if (r && !r.ok) return { status: r.refusal.status, body: { ...(r.refusal.body as object), key, live: s } };
    this.live.take();
    this.start(key, caseId, input);
    return { status: 202, body: { status: 'running', key, progress: [], live: live() } };
  }

  private start(key: string, caseId: string, input: AnalysisInput) {
    const job: Job = { key, caseId, progress: [], status: 'running', done: Promise.resolve() };
    this.jobs.set(key, job);
    const t = Date.now();
    this.log(`analysis started · case ${caseId} · ${key.slice(0, 12)} · ${this.primaryModel}`);
    job.done = analyzeCase(input, {
      model: this.o.model!,
      requestedModel: this.primaryModel,
      key,
      ...(this.o.now ? { now: this.o.now } : {}),
      onProgress: (p) => job.progress.push(p),
      onUsage: (u) => this.o.onUsage?.(caseId, u),
    }).then(
      (a) => {
        this.o.store.put(a);
        job.result = a;
        job.status = 'done';
        this.log(`analysis done · case ${caseId} · ${a.provider}/${a.model} · ${a.usage.calls.length} calls · in ${a.usage.inputTokens} out ${a.usage.outputTokens} thinking ${a.usage.thinkingTokens} tokens · ${Date.now() - t} ms`);
      },
      (e) => {
        job.status = 'failed';
        job.error = e instanceof ModelError ? e.message : 'The analysis failed';
        this.log(`analysis failed · case ${caseId} · ${job.error}`);
      },
    );
  }

  /** The answer once the run of `key` (if one is running) has finished. */
  async settled(key: string): Promise<ServiceAnswer> {
    await this.jobs.get(key)?.done;
    return this.progress(key);
  }

  progress(key: string): ServiceAnswer {
    const job = this.jobs.get(key);
    if (job?.status === 'running') return { status: 200, body: { status: 'running', key, progress: job.progress, live: this.liveState() } };
    if (job?.status === 'failed') return { status: 200, body: { status: 'failed', key, error: job.error, progress: job.progress, live: this.liveState() } };
    if (job?.result) return { status: 200, body: { status: 'ready', key, origin: 'live', analysis: job.result, progress: job.progress, live: this.liveState() } };
    const stored = this.o.store.get(key);
    if (stored) return { status: 200, body: { status: 'ready', key, origin: stored.origin, analysis: stored.analysis, live: this.liveState() } };
    return { status: 404, body: { error: 'NO_ANALYSIS', key } };
  }

  /** Re-verify one edited sentence against the analysis of these documents (live, rate-limited). */
  async verify(input: AnalysisInput, text: string, gate?: LiveGate): Promise<ServiceAnswer> {
    const key = await this.key(input);
    const job = this.jobs.get(key);
    const analysis = job?.result ?? this.o.store.get(key)?.analysis;
    if (!analysis) return { status: 404, body: { error: 'NO_ANALYSIS', detail: 'Analyse these documents before re-checking a sentence', key } };
    if (!this.o.model) return { status: 503, body: { error: 'ANALYST_UNCONFIGURED', detail: 'No model key is set on the server' } };
    const vs = this.verifies.state();
    if (vs.remaining <= 0) {
      return { status: 429, body: { error: 'RATE_LIMITED', detail: `Re-checks are limited to ${vs.limit} per hour on this server`, resetInSec: vs.resetInSec } };
    }
    const r = gate?.();
    if (r && !r.ok) return r.refusal;
    this.verifies.take();
    try {
      const r = await recheckSentence(analysis, input, text, { model: this.o.model, onUsage: (u) => this.o.onUsage?.(input.caseId, u) });
      return { status: 200, body: { verdict: r.verdict, reason: r.reason, rewrite: r.rewrite, decidedBy: r.decidedBy, citations: r.citations, model: r.usage.model, provider: r.usage.provider } };
    } catch (e) {
      if (r?.ok) r.release(); // the re-check did not happen: refund the daily reservation
      return { status: 502, body: { error: 'ANALYST_FAILED', detail: e instanceof ModelError ? e.message : 'The re-check failed' } };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Pinned inputs

/**
 * The input each case was last analysed with, while PayPal still waited for the seller. Once the seller's evidence is
 * in, PayPal's allowed actions change but the documents do not: the case keeps the analysis of its pinned input (same
 * documents), as the merchant saw it before sending, instead of needing a new model run. Persisted when given a file.
 */
export class InputPins {
  private readonly file: string | null;
  private readonly pins = new Map<string, AnalysisInput>();
  constructor(o: { file?: string } = {}) {
    this.file = o.file ?? null;
    if (!this.file) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, AnalysisInput>;
      for (const [k, v] of Object.entries(saved)) if (v && typeof v === 'object') this.pins.set(k, v);
    } catch {
      /* no pins yet */
    }
  }

  /**
   * The input to analyse for a case. `submitted`: PayPal shows the seller's evidence; then the pinned input of the same
   * documents is used, if there is one. Otherwise `input` is used and becomes the pin.
   */
  resolve(caseId: string, input: AnalysisInput, submitted: boolean): AnalysisInput {
    const pinned = this.pins.get(caseId);
    if (submitted) return pinned && documentsSignature(pinned) === documentsSignature(input) ? pinned : input;
    if (!pinned || canonicalJson(pinned) !== canonicalJson(input)) {
      this.pins.set(caseId, input);
      this.save();
    }
    return input;
  }

  private save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.pins)));
    } catch {
      /* best effort: without it, a restart needs one new run after sending */
    }
  }
}
