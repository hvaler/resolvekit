import { utcStamp } from './time';
import type { ActionCode, DisputeSnapshot, DisputeStatus, EvidenceSubmission, RecordedEvidence } from './types';

/**
 * Everything the web app needs from PayPal. The browser never talks to PayPal: the real
 * implementation will be a server endpoint backed by `packages/paypal`. For now the app runs on
 * {@link SimulatedDisputeGateway}.
 */
export interface DisputeGateway {
  getDispute(disputeId: string): Promise<DisputeSnapshot>;
  provideEvidence(submission: EvidenceSubmission, opts: { requestId: string }): Promise<void>;
}

/** The request did not get an answer in time. PayPal may or may not have stored the evidence. */
export class GatewayTimeoutError extends Error {
  constructor(message = 'The request to PayPal timed out') {
    super(message);
    this.name = 'GatewayTimeoutError';
  }
}

export type SendPhase = 'checking' | 'sending' | 'awaiting' | 'rereading';

export type SendResult =
  | { kind: 'recorded'; snapshot: DisputeSnapshot; recorded: RecordedEvidence; resent: boolean }
  | { kind: 'not_recorded'; snapshot: DisputeSnapshot; error: string };

export interface SendOptions {
  requestId: string;
  onPhase?: (phase: SendPhase) => void;
  /** Pause between PayPal's answer and the read-back. */
  confirmDelayMs?: number;
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

function latestEvidence(s: DisputeSnapshot): RecordedEvidence | null {
  return s.evidences.length ? (s.evidences[s.evidences.length - 1] ?? null) : null;
}

/**
 * Send the evidence, then read the dispute back. "Recorded" is only reported from the read-back,
 * never from the send call's answer. A timeout is not treated as success or failure: we read back
 * and report what PayPal shows.
 */
export async function submitWithReadBack(gw: DisputeGateway, submission: EvidenceSubmission, opts: SendOptions): Promise<SendResult> {
  let error: string | null = null;
  opts.onPhase?.('sending');
  try {
    await gw.provideEvidence(submission, { requestId: opts.requestId });
    opts.onPhase?.('awaiting');
    await sleep(opts.confirmDelayMs ?? 0);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  opts.onPhase?.('rereading');
  const snapshot = await gw.getDispute(submission.disputeId);
  const recorded = latestEvidence(snapshot);
  if (recorded) return { kind: 'recorded', snapshot, recorded, resent: false };
  return { kind: 'not_recorded', snapshot, error: error ?? 'PayPal shows no evidence recorded' };
}

/**
 * Retry after an unconfirmed submission: read the dispute back first and only send again if PayPal
 * shows no evidence recorded.
 */
export async function safeRetry(gw: DisputeGateway, submission: EvidenceSubmission, opts: SendOptions): Promise<SendResult> {
  opts.onPhase?.('checking');
  const before = await gw.getDispute(submission.disputeId);
  const already = latestEvidence(before);
  if (already) return { kind: 'recorded', snapshot: before, recorded: already, resent: false };
  const r = await submitWithReadBack(gw, submission, opts);
  return r.kind === 'recorded' ? { ...r, resent: true } : r;
}

// ---------------------------------------------------------------------------------------------

export type SimulatedOutcome = 'waiting_for_buyer' | 'under_review' | 'timeout';

/** How the simulated PayPal opens a new (UNDER_REVIEW, no actions) dispute to the seller after a while. */
export interface ScheduledOpening {
  afterMs: number;
  status: DisputeStatus;
  stage: string;
  respondBy: string;
  allowedActions: readonly ActionCode[];
}

/** PayPal could not be reached at all (no answer). Nothing was read. */
export class GatewayUnavailableError extends Error {
  constructor(message = 'PayPal could not be reached') {
    super(message);
    this.name = 'GatewayUnavailableError';
  }
}

export interface SimulatedGatewayOptions {
  outcome: () => SimulatedOutcome;
  latencyMs?: number;
  now?: () => Date;
  /** New disputes that PayPal opens to the seller once `afterMs` have passed since the gateway started. */
  openings?: Readonly<Record<string, ScheduledOpening>>;
}

/**
 * In-memory stand-in for PayPal that follows the sandbox findings: after evidence is submitted,
 * provide_evidence disappears from the actions and the status moves to WAITING_FOR_BUYER_RESPONSE
 * or UNDER_REVIEW. The "timeout" outcome makes the first submission per dispute time out without
 * storing anything.
 */
export class SimulatedDisputeGateway implements DisputeGateway {
  private readonly disputes = new Map<string, DisputeSnapshot>();
  private readonly timedOut = new Set<string>();
  private readonly pending = new Map<string, ScheduledOpening>();
  private readonly startedAt: number;
  private offline = false;
  private readonly opts: Required<Omit<SimulatedGatewayOptions, 'openings'>>;
  readonly sent: { submission: EvidenceSubmission; requestId: string }[] = [];

  constructor(initial: readonly DisputeSnapshot[], opts: SimulatedGatewayOptions) {
    for (const d of initial) this.disputes.set(d.id, structuredClone(d));
    this.opts = { outcome: opts.outcome, latencyMs: opts.latencyMs ?? 0, now: opts.now ?? (() => new Date()) };
    this.startedAt = this.opts.now().getTime();
    for (const [id, o] of Object.entries(opts.openings ?? {})) this.pending.set(id, o);
  }

  /** Simulate a network outage: reads fail until it is turned off again. */
  setOffline(offline: boolean): void {
    this.offline = offline;
  }

  /** Open a scheduled dispute now instead of waiting (demo control). */
  openNow(disputeId: string): void {
    this.open(disputeId);
  }

  private open(disputeId: string): void {
    const o = this.pending.get(disputeId);
    const d = this.disputes.get(disputeId);
    if (!o || !d) return;
    this.pending.delete(disputeId);
    if (d.status !== 'UNDER_REVIEW' || d.evidences.length) return;
    d.status = o.status;
    d.stage = o.stage;
    d.respondBy = o.respondBy;
    d.allowedActions = [...o.allowedActions];
  }

  async getDispute(disputeId: string): Promise<DisputeSnapshot> {
    await sleep(this.opts.latencyMs);
    if (this.offline) throw new GatewayUnavailableError();
    const o = this.pending.get(disputeId);
    if (o && this.opts.now().getTime() - this.startedAt >= o.afterMs) this.open(disputeId);
    const d = this.disputes.get(disputeId);
    if (!d) throw new Error(`RESOURCE_NOT_FOUND: ${disputeId}`);
    return { ...structuredClone(d), readAt: utcStamp(this.opts.now()) };
  }

  async provideEvidence(submission: EvidenceSubmission, opts: { requestId: string }): Promise<void> {
    await sleep(this.opts.latencyMs);
    const d = this.disputes.get(submission.disputeId);
    if (!d) throw new Error(`RESOURCE_NOT_FOUND: ${submission.disputeId}`);
    if (!d.allowedActions.includes('provide_evidence')) throw new Error('NOT_AUTHORIZED: provide_evidence is not allowed for this dispute');
    const outcome = this.opts.outcome();
    if (outcome === 'timeout' && !this.timedOut.has(d.id)) {
      this.timedOut.add(d.id);
      throw new GatewayTimeoutError();
    }
    this.sent.push({ submission, requestId: opts.requestId });
    const status: DisputeStatus = outcome === 'under_review' ? 'UNDER_REVIEW' : 'WAITING_FOR_BUYER_RESPONSE';
    const allowed: ActionCode[] = status === 'UNDER_REVIEW' ? ['send_message'] : ['send_message', 'make_offer', 'accept_claim'];
    d.status = status;
    d.allowedActions = allowed;
    d.evidences.push({
      evidenceType: submission.evidenceType,
      carrier: submission.carrier,
      tracking: submission.tracking,
      notes: submission.notes,
      files: submission.files.map((f) => f.name),
      storedAt: utcStamp(this.opts.now()),
    });
  }
}
