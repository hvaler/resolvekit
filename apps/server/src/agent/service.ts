/**
 * The buying agent on the server: starts runs in the background (one per person, three at a time), persists every
 * event of a run as it happens, and settles what MeterMCP holds.
 *
 * Write-ahead: the engine announces each MeterMCP call (step_started) and waits for onEvent, which writes the record
 * before the call is made. A write that fails rejects onEvent: the engine makes no further tool call and ends
 * stopped/persistence; the store keeps the latest state in memory and the reconcile sweep writes it.
 *
 * On a restart, `recover()` marks every unfinished run interrupted (a call announced but never answered becomes
 * uncertain and is never made again), closes its session through MeterMCP's admin route and re-reads the receipt.
 * `reconcile()` (every 5 min) does the same for runs whose settlement is not final. The settlement is only ever
 * what a receipt of the run's own session says; when no receipt could be read it is `unverified`.
 */
import { connectMeter, runAgent, type AgentModel, type MeterConnection, type RunEvent, type RunInput, type RunLimits, type RunResult, type Settlement, type Step } from '@resolvekit/agent';
import type { MeterMcpClient } from '../metermcp.ts';
import { UNSETTLED, type RunRecord, type RunStore } from './runs.ts';

/** Runs going at once on the server, and per person. */
export const MAX_RUNNING = 3;
export const MAX_RUNNING_PER_PERSON = 1;
/** How often main.ts should call `reconcile()`. */
export const RECONCILE_EVERY_MS = 5 * 60_000;
/** A call announced before a restart whose answer was never recorded (Ruling A1). */
export const RECOVERED_SUMMARY = 'Result unknown: the server restarted during this call; the receipt shows whether it was charged';

/** The MeterMCP admin routes the service needs (MeterMcpClient). */
export type MeterAdmin = Pick<MeterMcpClient, 'close' | 'reconcile' | 'receipt'>;

export type StartError = 'RUN_IN_PROGRESS' | 'BUSY' | 'MODEL_UNAVAILABLE' | 'STORAGE' | 'STOPPING';

const RECEIPT_SETTLEMENTS: ReadonlySet<string> = new Set(['open', 'captured', 'capture_pending', 'capture_declined', 'voided', 'failed', 'not_approved']);
const UNFINISHED = new Set(['running', 'awaiting_approval']);

interface Active {
  personId: string;
  controller: AbortController;
  done: Promise<void>;
}

export class AgentService {
  private readonly store: RunStore;
  private readonly models: { primary: AgentModel; fallback: AgentModel | null } | null;
  private readonly meterUrl: string;
  private readonly meterHeaders: (runId: string) => Record<string, string>;
  private readonly admin: MeterAdmin | null;
  private readonly limits: RunLimits;
  private readonly returnTo: (runId: string) => string | undefined;
  private readonly log: (l: string) => void;
  private readonly now: () => Date;
  private readonly connect: (o: { url: string; headers: Record<string, string> }) => Promise<MeterConnection>;
  private readonly active = new Map<string, Active>();
  /** Admin settlements in flight, per run: a second caller waits for the first instead of closing again. */
  private readonly settling = new Map<string, Promise<void>>();
  private stopping = false;

  /** `connect`: how a run reaches MeterMCP (tests inject a fake); defaults to connectMeter. */
  constructor(o: {
    store: RunStore;
    models: { primary: AgentModel; fallback: AgentModel | null } | null;
    meterUrl: string;
    meterHeaders: (runId: string) => Record<string, string>;
    meterAdmin: MeterAdmin | null;
    limits: RunLimits;
    returnTo: (runId: string) => string | undefined;
    log: (l: string) => void;
    now?: () => Date;
    connect?: (o: { url: string; headers: Record<string, string> }) => Promise<MeterConnection>;
  }) {
    this.store = o.store;
    this.models = o.models;
    this.meterUrl = o.meterUrl;
    this.meterHeaders = o.meterHeaders;
    this.admin = o.meterAdmin;
    this.limits = o.limits;
    this.returnTo = o.returnTo;
    this.log = o.log;
    this.now = o.now ?? (() => new Date());
    this.connect = o.connect ?? connectMeter;
  }

  /** Whether `runId` is going in this process. */
  isRunning(runId: string): boolean {
    return this.active.has(runId);
  }

  /**
   * Starts in the background; refuses with 'RUN_IN_PROGRESS' (that person has one going), 'BUSY' (three going),
   * 'MODEL_UNAVAILABLE' (no model keys), 'STORAGE' (the record could not be written, so nothing started) or
   * 'STOPPING' (the server is shutting down).
   */
  start(by: RunRecord['by'], input: RunInput): { ok: true; run: RunRecord } | { ok: false; error: StartError } {
    if (this.stopping) return { ok: false, error: 'STOPPING' };
    if (!this.models) return { ok: false, error: 'MODEL_UNAVAILABLE' };
    const mine = [...this.active.values()].filter((a) => a.personId === by.personId).length;
    if (mine >= MAX_RUNNING_PER_PERSON) return { ok: false, error: 'RUN_IN_PROGRESS' };
    if (this.active.size >= MAX_RUNNING) return { ok: false, error: 'BUSY' };
    let run: RunRecord;
    try {
      run = this.store.create({
        finishedAt: null,
        by: { ...by },
        goal: input.goal,
        cap: input.cap,
        failFirst: [...input.failFirst],
        state: 'running',
        stopReason: null,
        answer: null,
        steps: [],
        approvalUrl: null,
        provider: null,
        model: null,
        usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, reported: false },
        sessionId: null,
        orderId: null,
        captureId: null,
        settlement: 'none',
        receiptSha256: null,
        kept: false,
      });
    } catch (e) {
      this.log(`agent run: not started, the record could not be saved (${(e as Error).message})`);
      return { ok: false, error: 'STORAGE' };
    }
    const controller = new AbortController();
    const entry: Active = { personId: by.personId, controller, done: Promise.resolve() };
    this.active.set(run.id, entry);
    entry.done = this.execute(run.id, input, this.models, controller.signal).finally(() => this.active.delete(run.id));
    this.log(`agent run ${run.id}: started by ${by.label}`);
    return { ok: true, run };
  }

  /**
   * On boot: every running/awaiting_approval record → interrupted (written first, for all of them); then their
   * sessions are closed via admin close and the receipts re-read, concurrently, so a MeterMCP that is down costs one
   * timeout, not one per run. main.ts does not await this before listening: the records are already interrupted
   * when the first write lands, and a settlement still in flight shows as unverified.
   */
  async recover(): Promise<void> {
    const settle: string[] = [];
    for (const r of this.store.all()) {
      if (!UNFINISHED.has(r.state) || this.active.has(r.id)) continue;
      const steps = r.steps.map((s): Step => (s.state === 'pending' ? { ...s, state: 'uncertain', summary: RECOVERED_SUMMARY } : s));
      const uncertain = steps.filter((s) => s.state === 'uncertain').length;
      // A paid call announced without a recorded session may have opened a budget nobody can name: not 'none'.
      const unknownBudget = !r.sessionId && r.steps.some((s) => s.state === 'pending' && s.kind === 'call');
      const settlement: Settlement = r.sessionId || unknownBudget ? 'unverified' : r.settlement;
      this.write(r.id, { state: 'interrupted', steps, approvalUrl: null, finishedAt: this.now().toISOString(), settlement });
      this.log(`agent run ${r.id}: interrupted by a restart (was ${r.state}${uncertain ? `, ${uncertain} call(s) with unknown result` : ''})${unknownBudget ? ' · a budget may exist without a known session: settlement unverified' : ''}`);
      if (r.sessionId) settle.push(r.id);
    }
    await Promise.allSettled(settle.map((id) => this.settleThroughAdmin(id)));
  }

  /** Every 5 min: unsaved records are written; records whose settlement is open/capture_pending/failed/unverified are closed or reconciled and their receipt re-read. */
  async reconcile(): Promise<void> {
    for (const id of this.store.retryUnsaved()) this.log(`agent run ${id}: saved by the reconcile sweep`);
    for (const r of this.store.all()) {
      if (UNFINISHED.has(r.state) || this.active.has(r.id) || !r.sessionId || !UNSETTLED.has(r.settlement)) continue;
      await this.settleThroughAdmin(r.id);
    }
  }

  /** Shutdown: aborts running loops (they end interrupted and settle). */
  async stop(): Promise<void> {
    const going = [...this.active.values()];
    this.stopping = true;
    for (const a of going) a.controller.abort();
    await Promise.allSettled([...going.map((a) => a.done), ...this.settling.values()]);
  }

  // -------------------------------------------------------------------------------------------

  private async execute(id: string, input: RunInput, models: { primary: AgentModel; fallback: AgentModel | null }, signal: AbortSignal): Promise<void> {
    const headers = this.meterHeaders(id);
    let meter: MeterConnection;
    try {
      meter = await this.connect({ url: this.meterUrl, headers });
    } catch (e) {
      // Nothing was called: no MeterMCP, no budget.
      this.log(`agent run ${id}: stopped, MeterMCP unreachable (${redact(e instanceof Error ? e.message : String(e), Object.values(headers))})`);
      this.write(id, { state: 'stopped', stopReason: 'meter_unavailable', finishedAt: this.now().toISOString(), approvalUrl: null });
      return;
    }
    let result: RunResult;
    try {
      result = await runAgent({
        input: { ...input, returnTo: this.returnTo(id) },
        meter,
        models,
        limits: this.limits,
        now: this.now,
        signal,
        onEvent: (e) => this.onEvent(id, e),
      });
    } catch (e) {
      // The engine failed outside its loop: no result. A call it announced has an unknown answer, as after a restart.
      const rec = this.store.get(id)!;
      this.log(`agent run ${id}: stopped, internal error (${redact(e instanceof Error ? e.message : String(e), Object.values(headers))})`);
      this.write(id, {
        state: 'stopped',
        stopReason: 'internal_error',
        steps: rec.steps.map((s): Step => (s.state === 'pending' ? { ...s, state: 'uncertain', summary: RECOVERED_SUMMARY } : s)),
        finishedAt: this.now().toISOString(),
        approvalUrl: null,
        settlement: rec.sessionId || rec.steps.some((s) => s.state === 'pending' && s.kind === 'call') ? 'unverified' : rec.settlement,
      });
      if (rec.sessionId) await this.settleThroughAdmin(id);
      return;
    } finally {
      await meter.close().catch(() => {});
    }
    const rec = this.write(id, {
      state: result.outcome,
      stopReason: result.stopReason,
      answer: result.answer,
      steps: result.steps,
      approvalUrl: null,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      sessionId: result.sessionId,
      orderId: result.orderId,
      captureId: result.captureId,
      settlement: result.settlement,
      receiptSha256: result.receiptSha256,
      finishedAt: this.now().toISOString(),
    });
    this.log(`agent run ${id}: ${result.outcome}${result.stopReason ? ` (${result.stopReason})` : ''} · settlement ${result.settlement}`);
    if (rec.sessionId && UNSETTLED.has(rec.settlement)) await this.settleThroughAdmin(id);
  }

  /** One engine event into the record. Rejects when the write fails, which the engine reads as a persistence failure. */
  private onEvent(id: string, e: RunEvent): void {
    const r = this.store.get(id)!;
    let patch: Partial<RunRecord>;
    if (e.type === 'step_started' || e.type === 'step') {
      const i = r.steps.findIndex((s) => s.n === e.step.n);
      patch = { steps: i < 0 ? [...r.steps, e.step] : r.steps.map((s, k) => (k === i ? e.step : s)) };
    } else if (e.type === 'awaiting_approval') {
      patch = { state: 'awaiting_approval', approvalUrl: e.approvalUrl, sessionId: e.sessionId, orderId: e.orderId || null };
    } else if (e.type === 'approved') {
      patch = { state: 'running', approvalUrl: null };
    } else {
      patch = { provider: e.provider, model: e.model, usage: { modelCalls: e.modelCalls, inputTokens: e.inputTokens, outputTokens: e.outputTokens, reported: e.reported } };
    }
    try {
      this.store.update(id, patch);
    } catch (err) {
      this.log(`agent run ${id}: not saved at ${e.type} (${(err as Error).message}); kept in memory, the run stops and the reconcile sweep writes it`);
      throw err;
    }
  }

  /** store.update that never throws: a failed write is logged; the store keeps the state for the sweep. */
  private write(id: string, patch: Partial<RunRecord>): RunRecord {
    try {
      return this.store.update(id, patch);
    } catch (e) {
      this.log(`agent run ${id}: not saved (${(e as Error).message}); kept in memory for the reconcile sweep`);
      return this.store.get(id)!;
    }
  }

  /** Close the run's session (a pending capture: reconcile) and re-read its receipt, once at a time per run. */
  private settleThroughAdmin(id: string): Promise<void> {
    const inFlight = this.settling.get(id);
    if (inFlight) return inFlight;
    const p = this.settleOnce(id).finally(() => this.settling.delete(id));
    this.settling.set(id, p);
    return p;
  }

  private async settleOnce(id: string): Promise<void> {
    // Read now, not from the caller's snapshot: a sweep that just settled this run leaves nothing to do.
    const r = this.store.get(id);
    const sid = r?.sessionId;
    if (!r || !sid || !UNSETTLED.has(r.settlement) || !this.admin) return;
    try {
      if (r.settlement === 'capture_pending') await this.admin.reconcile(sid);
      else await this.admin.close(sid);
    } catch (e) {
      this.log(`agent run ${id}: MeterMCP ${r.settlement === 'capture_pending' ? 'reconcile' : 'close'} of ${sid} failed (${(e as Error).message}); the sweep retries`);
    }
    let receipt: Record<string, any> | null = null;
    try {
      receipt = (await this.admin.receipt(sid)) as unknown as Record<string, any>;
    } catch (e) {
      this.log(`agent run ${id}: receipt of ${sid} not read (${(e as Error).message}); settlement unverified`);
    }
    const status = receipt?.settlement?.status;
    if (receipt && receipt.session?.id === sid && typeof status === 'string' && RECEIPT_SETTLEMENTS.has(status)) {
      this.write(id, {
        settlement: status as Settlement,
        captureId: typeof receipt.settlement.capture_id === 'string' ? receipt.settlement.capture_id : null,
        receiptSha256: typeof receipt.receipt_sha256 === 'string' ? receipt.receipt_sha256 : null,
        ...(typeof receipt.mandate?.order_id === 'string' ? { orderId: receipt.mandate.order_id } : {}),
      });
      if (status !== r.settlement) this.log(`agent run ${id}: settlement ${status} (from the receipt)`);
    } else if (r.settlement !== 'unverified') this.write(id, { settlement: 'unverified' });
  }
}

/** `text` without any of the secret values (header values), for logs. */
function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 8) out = out.split(s).join('[redacted]');
  return out;
}
