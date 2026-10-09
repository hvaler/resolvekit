/**
 * The analyst API on the ResolveKit server (`/api/cases/:id/analysis…`). The browser only sends the documents it
 * shows; the model keys and the model calls stay on the server.
 */
import type { AnalysisInput, CaseAnalysis, CitationCheck, Progress, Verdict } from '@resolvekit/analyst';

export type AnalysisOrigin = 'golden' | 'cache' | 'live';

export interface LiveState {
  configured: boolean;
  model: string | null;
  remaining: number;
  limit: number;
  resetInSec: number;
}

export type AnalysisAnswer =
  | { status: 'ready'; key: string; origin: AnalysisOrigin; analysis: CaseAnalysis; live?: LiveState }
  | { status: 'running'; key: string; progress: Progress[]; live?: LiveState }
  | { status: 'failed'; key: string; error: string; progress?: Progress[]; live?: LiveState };

export class AnalysisRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly live: LiveState | null;
  constructor(status: number, body: { error?: string; detail?: string; live?: LiveState }) {
    super(body.detail ?? body.error ?? `HTTP ${status}`);
    this.name = 'AnalysisRequestError';
    this.status = status;
    this.code = body.error ?? `HTTP_${status}`;
    this.live = body.live ?? null;
  }
}

/** The server could not be reached at all (not running, proxy without a target). */
export class AnalysisUnreachableError extends Error {
  constructor() {
    super('The ResolveKit server could not be reached');
    this.name = 'AnalysisUnreachableError';
  }
}

export interface VerifyAnswer {
  verdict: Verdict;
  reason: string | null;
  rewrite: string | null;
  citations: CitationCheck[];
  model: string;
}

export class AnalysisClient {
  private readonly base: string;
  private readonly fetch: typeof fetch;
  constructor(o: { base?: string; fetch?: typeof fetch } = {}) {
    this.base = o.base ?? '/api';
    this.fetch = o.fetch ?? ((...a) => globalThis.fetch(...a));
  }

  private async call<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
    let r: Response;
    try {
      r = await this.fetch(this.base + path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new AnalysisUnreachableError();
    }
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // A dev/preview proxy with no server behind it answers 5xx without JSON.
      throw new AnalysisUnreachableError();
    }
    if (!r.ok && r.status !== 202) throw new AnalysisRequestError(r.status, (body ?? {}) as { error?: string });
    return body as T;
  }

  /** Stored analysis for these documents, or a live run (`refresh` forces one). */
  analyse(caseId: string, input: AnalysisInput, refresh = false): Promise<AnalysisAnswer> {
    const q = refresh ? '?refresh=1' : '';
    return this.call(`/cases/${encodeURIComponent(caseId)}/analysis${q}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input }) }, 20_000);
  }

  progress(caseId: string, key: string): Promise<AnalysisAnswer> {
    return this.call(`/cases/${encodeURIComponent(caseId)}/analysis/progress?key=${key}`, { method: 'GET' }, 10_000);
  }

  verify(caseId: string, input: AnalysisInput, text: string): Promise<VerifyAnswer> {
    return this.call(
      `/cases/${encodeURIComponent(caseId)}/analysis/verify`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input, text }) },
      120_000,
    );
  }
}
