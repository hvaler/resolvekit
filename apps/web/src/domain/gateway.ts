import { CONTRACTS, type VariantId } from './actionContracts';
import { variantOfContent, type ProofState } from './actionReadback';
import { intentAction, type ContractRegistry } from './actions';
import type { SubmissionIntent } from './intent';
import { hasSellerEvidence, newSellerEvidence, submissionMismatch } from './recorded';
import { SIM_TRANSITIONS, transitionFrom, type SimStep, type SimTransition } from './simulatedActions';
import { utcStamp } from './time';
import type { ActionCode, DisputeMessage, DisputeSnapshot, DisputeStatus, EvidenceSubmission, OfferEvent, RecordedEvidence } from './types';

/**
 * Everything the web app needs from PayPal. The browser never talks to PayPal: the real implementation
 * ({@link HttpDisputeGateway} in `httpGateway.ts`) calls the ResolveKit server (`apps/server`), which uses
 * `packages/paypal`. Cases not bound to a real dispute run on {@link SimulatedDisputeGateway}.
 */
export interface DisputeGateway {
  getDispute(disputeId: string): Promise<DisputeSnapshot>;
  provideEvidence(submission: EvidenceSubmission, opts: { requestId: string }): Promise<void>;
  /**
   * Send an approved action intent (not evidence). The real gateway sends only its id (`POST /send`); the server sends
   * the intent's own content. PayPal's answer is never proof: the caller reads back (actionSend.ts).
   */
  sendAction(intent: SubmissionIntent, opts: { requestId: string }): Promise<ActionSendAnswer>;
}

/** What a send answered: accepted (`true`), unknown, or settled by a read-back the server did first (a reconcile). */
export interface ActionSendAnswer {
  sent: true | 'unknown';
  reconciled?: boolean;
  readBack?: { state: ProofState; detail: string; at?: string };
  intent?: SubmissionIntent;
}

/** The simulator refuses what no recorded contract shows ([A7]): a variant, or a starting state, never recorded. */
export const NOT_IN_SIMULATOR = 'NOT_AUTHORIZED: not available in the simulator';

/** The request did not get an answer in time. PayPal may or may not have stored the evidence. */
export class GatewayTimeoutError extends Error {
  constructor(message = 'The request to PayPal timed out') {
    super(message);
    this.name = 'GatewayTimeoutError';
  }
}

export type SendPhase = 'checking' | 'sending' | 'awaiting' | 'rereading';

export type SendResult =
  | { kind: 'recorded'; snapshot: DisputeSnapshot; recorded: RecordedEvidence; resent: boolean; baseline: DisputeSnapshot }
  | { kind: 'not_recorded'; snapshot: DisputeSnapshot; error: string; baseline: DisputeSnapshot }
  /**
   * PayPal shows new seller evidence that is not what we sent (another operator or process, or PayPal stored something
   * else). Never reported as "recorded"; no automatic retry: a person reviews it.
   */
  | { kind: 'mismatch'; snapshot: DisputeSnapshot; recorded: RecordedEvidence; differs: string[]; baseline: DisputeSnapshot };

/** A new seller entry is ours only if it matches what we sent field by field. */
function classify(submission: EvidenceSubmission, snapshot: DisputeSnapshot, recorded: RecordedEvidence, baseline: DisputeSnapshot, resent: boolean): SendResult {
  const differs = submissionMismatch(submission, recorded);
  return differs.length ? { kind: 'mismatch', snapshot, recorded, differs, baseline } : { kind: 'recorded', snapshot, recorded, resent, baseline };
}

export interface SendOptions {
  requestId: string;
  onPhase?: (phase: SendPhase) => void;
  /** Pause between PayPal's answer and the read-back. */
  confirmDelayMs?: number;
  /**
   * The dispute as read before the first attempt. Seller evidence already in it is never reported as
   * recorded. When absent, the dispute is read before sending (nothing has been sent yet).
   */
  baseline?: DisputeSnapshot;
  /** Extra read-backs when PayPal accepted the send but does not show the evidence yet. */
  rereads?: number;
  rereadDelayMs?: number;
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * Send the evidence, then read the dispute back. "Recorded" is only reported from the read-back, never
 * from the send call's answer, and only for seller evidence (SUBMITTED_BY_SELLER, PROVIDE_EVIDENCE) that
 * was not on the dispute before sending: a real dispute always lists the buyer's entry and PayPal's
 * request, and those are not this submission. A timeout is not treated as success or failure: we read
 * back and report what PayPal shows.
 */
export async function submitWithReadBack(gw: DisputeGateway, submission: EvidenceSubmission, opts: SendOptions): Promise<SendResult> {
  const id = submission.disputeId;
  const baseline = opts.baseline ?? (await gw.getDispute(id));
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
  let snapshot = await gw.getDispute(id);
  let recorded = newSellerEvidence(snapshot, baseline);
  // PayPal accepted the send: give it a moment to show the evidence before saying it is not there.
  for (let i = 0; !recorded && error == null && i < (opts.rereads ?? 0); i++) {
    await sleep(opts.rereadDelayMs ?? 0);
    snapshot = await gw.getDispute(id);
    recorded = newSellerEvidence(snapshot, baseline);
  }
  if (recorded) return classify(submission, snapshot, recorded, baseline, false);
  return { kind: 'not_recorded', snapshot, error: error ?? 'PayPal shows no evidence recorded', baseline };
}

/**
 * Retry after an unconfirmed submission: read the dispute back first and only send again if PayPal
 * shows no new seller evidence compared with `baseline` (the dispute as read before the first attempt,
 * which is required: without it, evidence the first attempt did store could not be told apart).
 */
export async function safeRetry(
  gw: DisputeGateway,
  submission: EvidenceSubmission,
  opts: SendOptions & { baseline: DisputeSnapshot },
): Promise<SendResult> {
  opts.onPhase?.('checking');
  const now = await gw.getDispute(submission.disputeId);
  const { baseline } = opts;
  const already = newSellerEvidence(now, baseline);
  // Something new is there: ours (recorded) or someone else's (mismatch). Either way, nothing is sent again.
  if (already) return classify(submission, now, already, baseline, false);
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
  /** Test only: other recorded transitions and registry (the product uses SIM_TRANSITIONS and CONTRACTS). */
  transitions?: Readonly<Partial<Record<VariantId, readonly SimTransition[]>>>;
  contracts?: ContractRegistry;
}

/** The entry an action leaves, in the list the recorded reads show it in. */
type PlayEntry = { kind: 'message'; message: DisputeMessage } | { kind: 'evidence'; evidence: RecordedEvidence } | { kind: 'offer'; offer: OfferEvent };

/** An action the simulator is playing: the recorded reads still to come, and the entry they show. */
interface Play {
  answeredAt: number;
  steps: SimStep[];
  entry: PlayEntry;
  shown: boolean;
  /** What a recorded refund or outcome shows (a full accept: the disputed amount, refunded to the buyer). */
  refund: { value: string; currency: string } | null;
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
  private readonly opts: Required<Omit<SimulatedGatewayOptions, 'openings' | 'transitions' | 'contracts'>>;
  private readonly transitions: Readonly<Partial<Record<VariantId, readonly SimTransition[]>>>;
  private readonly contracts: ContractRegistry;
  private readonly plays = new Map<string, Play>();
  readonly sent: { submission: EvidenceSubmission; requestId: string }[] = [];
  /** The actions the simulator recorded (never sent anywhere). */
  readonly sentActions: { intentId: string; requestId: string }[] = [];

  constructor(initial: readonly DisputeSnapshot[], opts: SimulatedGatewayOptions) {
    for (const d of initial) this.disputes.set(d.id, structuredClone(d));
    this.opts = { outcome: opts.outcome, latencyMs: opts.latencyMs ?? 0, now: opts.now ?? (() => new Date()) };
    this.transitions = opts.transitions ?? SIM_TRANSITIONS;
    this.contracts = opts.contracts ?? CONTRACTS;
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
    if (d.status !== 'UNDER_REVIEW' || hasSellerEvidence(d)) return;
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
    this.advance(d);
    return { ...structuredClone(d), readAt: utcStamp(this.opts.now()) };
  }

  /** Apply the recorded reads whose time has come (each once, in order); the entry shows from its first visible read. */
  private advance(d: DisputeSnapshot): void {
    const play = this.plays.get(d.id);
    if (!play) return;
    const elapsed = this.opts.now().getTime() - play.answeredAt;
    while (play.steps[0] && play.steps[0].afterMs <= elapsed) {
      const s = play.steps.shift()!;
      d.status = s.status;
      d.stage = s.stage;
      d.allowedActions = [...s.allowedActions];
      d.responseOptions = { acceptClaimTypes: [...s.responseOptions.acceptClaimTypes], offerTypes: [...s.responseOptions.offerTypes] };
      const at = new Date(play.answeredAt + s.afterMs).toISOString();
      if (s.refunded && play.refund && !d.refunds?.length) d.refunds = [{ id: null, amount: { ...play.refund }, time: new Date(play.answeredAt).toISOString() }];
      if (s.outcome && !d.outcome) d.outcome = { code: s.outcome, closedAt: s.status === 'RESOLVED' ? at : null, amountRefunded: play.refund ? { ...play.refund } : null };
      if (s.entryVisible && !play.shown) {
        const e = play.entry;
        if (e.kind === 'message') (d.messages ??= []).push({ ...e.message });
        else if (e.kind === 'evidence') d.evidences.push({ ...e.evidence });
        else (d.offerHistory ??= []).push({ ...e.offer, amount: e.offer.amount ? { ...e.offer.amount } : null });
        play.shown = true;
      }
    }
    if (!play.steps.length) this.plays.delete(d.id);
  }

  /**
   * Before a new write on the dispute: an earlier action's recorded reads due by now are applied; one whose entry the
   * simulator does not show yet is still uncertain, and nothing else is written until it is. A write that is accepted
   * then drops the earlier action's remaining reads (the dispute moved on); a refused one leaves them playing.
   */
  private beforeWrite(d: DisputeSnapshot): void {
    this.advance(d);
    const earlier = this.plays.get(d.id);
    if (earlier && !earlier.shown) throw new Error('DISPUTE_UNCERTAIN: the last action is not shown yet; check again first');
  }

  /**
   * Play an action exactly as a recorded contract shows it ([A7]): its entry (a seller message with the approved text;
   * for a full accept, the ACCEPT_CLAIM entry with the type and the note; for a partial accept, the seller's offer with
   * the amount), timed when the simulator answered, and the recorded reads that follow (status, stage, links, response
   * options, a refund and an outcome where recorded), each from the time it was read after PayPal answered. A variant
   * with no recorded transition, or a dispute in a state no write was recorded from, is refused: nothing is invented to
   * complete the demo.
   */
  async sendAction(intent: SubmissionIntent, opts: { requestId: string }): Promise<ActionSendAnswer> {
    await sleep(this.opts.latencyMs);
    if (this.offline) throw new GatewayUnavailableError();
    const d = this.disputes.get(intent.caseId);
    if (!d) throw new Error(`RESOURCE_NOT_FOUND: ${intent.caseId}`);
    const variant = variantOfContent(intent);
    const transitions = variant && this.contracts[variant]?.status !== 'not_available' ? (this.transitions[variant] ?? []) : [];
    if (!transitions.length) throw new Error(NOT_IN_SIMULATOR);
    this.beforeWrite(d);
    const action = intentAction(intent);
    if (!d.allowedActions.includes(action)) throw new Error(`NOT_AUTHORIZED: ${action} is not allowed for this dispute`);
    const t = transitionFrom(transitions, d);
    if (!t) throw new Error(NOT_IN_SIMULATOR);
    const now = this.opts.now();
    const played = playEntry(t, intent, d, now);
    if (!played) throw new Error(NOT_IN_SIMULATOR);
    this.sentActions.push({ intentId: intent.id, requestId: opts.requestId });
    this.plays.set(d.id, { answeredAt: now.getTime(), steps: t.steps.map((s) => ({ ...s })), entry: played.entry, shown: false, refund: played.refund });
    return { sent: true };
  }

  async provideEvidence(submission: EvidenceSubmission, opts: { requestId: string }): Promise<void> {
    await sleep(this.opts.latencyMs);
    const d = this.disputes.get(submission.disputeId);
    if (!d) throw new Error(`RESOURCE_NOT_FOUND: ${submission.disputeId}`);
    this.beforeWrite(d);
    if (!d.allowedActions.includes('provide_evidence')) throw new Error('NOT_AUTHORIZED: provide_evidence is not allowed for this dispute');
    const outcome = this.opts.outcome();
    if (outcome === 'timeout' && !this.timedOut.has(d.id)) {
      this.timedOut.add(d.id);
      throw new GatewayTimeoutError();
    }
    this.sent.push({ submission, requestId: opts.requestId });
    // The dispute moved on: an earlier message's later recorded reads no longer apply.
    this.plays.delete(d.id);
    // In the claim stage PayPal decides on the evidence (and send-message / make-offer exist only in the inquiry
    // stage), so the dispute goes to review with no seller actions, as the sandbox shows right after a submission.
    const claim = !!d.stage && d.stage !== 'INQUIRY';
    const status: DisputeStatus = claim || outcome === 'under_review' ? 'UNDER_REVIEW' : 'WAITING_FOR_BUYER_RESPONSE';
    // After a seller message PayPal no longer offers make_offer and accepts REFUND only (W-1, send_message.json).
    const messaged = (d.messages ?? []).some((m) => m.postedBy === 'SELLER');
    const waiting: ActionCode[] = messaged ? ['send_message', 'accept_claim'] : ['send_message', 'make_offer', 'accept_claim'];
    const allowed: ActionCode[] = claim ? [] : status === 'UNDER_REVIEW' ? ['send_message'] : waiting;
    d.status = status;
    d.allowedActions = allowed;
    if (messaged && status === 'WAITING_FOR_BUYER_RESPONSE' && !claim) d.responseOptions = { acceptClaimTypes: ['REFUND'], offerTypes: [] };
    const now = this.opts.now();
    d.evidences.push({
      evidenceType: submission.evidenceType,
      source: 'SUBMITTED_BY_SELLER',
      action: 'PROVIDE_EVIDENCE',
      date: now.toISOString(),
      carrier: submission.carrier,
      tracking: submission.tracking,
      notes: submission.notes,
      files: submission.files.map((f) => f.name),
      storedAt: utcStamp(now),
    });
  }
}

/**
 * The entry a recorded transition shows for this intent, or null when the intent is not what the transition recorded
 * (the simulator then refuses it). A full accept refunds the disputed amount (W-10); a partial one is an offer (W-9).
 */
function playEntry(t: SimTransition, intent: SubmissionIntent, d: DisputeSnapshot, now: Date): { entry: PlayEntry; refund: { value: string; currency: string } | null } | null {
  const p = intent.payload;
  const time = now.toISOString();
  switch (t.entry) {
    case 'message':
      // PayPal gives the document back without a name, so the thread names no file (as the server's mapping does).
      return p?.kind === 'send_message' ? { entry: { kind: 'message', message: { postedBy: 'SELLER', time, content: p.text, files: [] } }, refund: null } : null;
    case 'accept_claim': {
      if (p?.kind !== 'accept_claim' || p.acceptType !== 'REFUND' || p.amount || !d.amount) return null;
      const evidence: RecordedEvidence = {
        evidenceType: 'OTHER',
        source: 'SUBMITTED_BY_SELLER',
        action: 'ACCEPT_CLAIM',
        responseOption: p.acceptType,
        stage: d.stage ?? null,
        date: time,
        carrier: '',
        tracking: '',
        notes: p.note,
        files: [],
        storedAt: utcStamp(now),
      };
      return { entry: { kind: 'evidence', evidence }, refund: { value: d.amount.value, currency: d.amount.currency } };
    }
    case 'offer':
      if (p?.kind !== 'accept_claim' || p.acceptType !== 'PARTIAL_REFUND' || !p.amount) return null;
      return { entry: { kind: 'offer', offer: { time, actor: 'SELLER', event: 'PROPOSED', type: 'REFUND', amount: { ...p.amount } } }, refund: null };
  }
}
