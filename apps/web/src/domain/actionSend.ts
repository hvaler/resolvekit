/**
 * Send an approved action intent and say only what a read-back proves ([A4]). Real PayPal: the server sends it once
 * (`POST /send`) and reads it back (`POST …/readback`, which only reads PayPal, with the proof of actionReadback.ts). The simulator: this browser
 * reads the simulated dispute before and after, with the same matcher. «Recorded» needs an entry attributable to this
 * send; anything else is «Outcome pending confirmation» (checked again, never resent blindly) or, when nothing reached
 * PayPal, «Not sent».
 */
import { CONTRACTS } from './actionContracts';
import { proveSend, readBackBase, variantOfContent, type ProofState, type ReadBackBase } from './actionReadback';
import type { ConfirmationTerms, ContractRegistry } from './actions';
import { GatewayTimeoutError, type DisputeGateway } from './gateway';
import { GatewayRequestError, type GatewayMode } from './httpGateway';
import type { SubmissionIntent } from './intent';
import { IntentError, type DisputeHoldView, type IntentRef, type IntentSource } from './intentClient';
import type { DisputeMessage, DisputeSnapshot } from './types';

export type ActionPhase = 'reading' | 'sending' | 'rereading';

/** Why a send did not reach PayPal, with what the person needs to go on. */
export interface ActionRefusal {
  code: string;
  /** NEEDS_REVIEW: the buyer's messages since approval, and their keys (what acknowledging echoes). */
  messages?: DisputeMessage[];
  messageKeys?: string[];
  /** CONFIRMATION_REQUIRED: the terms to confirm. */
  terms?: ConfirmationTerms;
}

export interface ActionResult {
  kind: ProofState | 'not_sent';
  detail: string;
  snapshot: DisputeSnapshot | null;
  /** The simulator's read-back base (the read before the send); null for real PayPal, whose server keeps its own. */
  base: ReadBackBase | null;
  refusal?: ActionRefusal;
  /**
   * Another send holds the dispute (409 DISPUTE_UNCERTAIN names it): this one was not sent, and «Check again» reads back
   * THAT send, never this one.
   */
  holder?: IntentRef;
}

export interface ActionSendOptions {
  intent: SubmissionIntent;
  /** The gateway serving this case, captured once when the flow opened. */
  gateway: DisputeGateway;
  intents: IntentSource;
  mode: GatewayMode;
  /** Test only: another registry. */
  contracts?: ContractRegistry;
  now?: () => Date;
  onPhase?: (p: ActionPhase) => void;
}

export const PENDING = 'Outcome pending confirmation';
const recordedBy = (mode: GatewayMode) => (mode.kind === 'paypal' ? 'Recorded by PayPal' : 'Recorded by the simulator');
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const contractOf = (o: ActionSendOptions) => {
  const v = variantOfContent(o.intent);
  return v ? (o.contracts ?? CONTRACTS)[v] : null;
};

/**
 * The codes with which the server refuses a send before anything reaches PayPal (apps/server/src/actions/routes.ts,
 * intents.ts, hosted.ts), plus PAYPAL_REFUSED (422: PayPal refused it with an issue code, proving nothing was done).
 * Anything else — a 5xx, a 4xx without one of these codes, a network error — proves nothing and is read back.
 */
const NOT_SENT_CODES: ReadonlySet<string> = new Set([
  'CONFIRMATION_REQUIRED',
  'NEEDS_REVIEW',
  'INTENT_STALE',
  'ACTION_STAGE',
  'ACTION_NOT_OFFERED',
  'VARIANT_NOT_AVAILABLE',
  'DUPLICATE_ACTION',
  'OWNER_ONLY',
  'NOT_THE_SELLER',
  'BINDING_CHANGED',
  'BINDING_INVALID',
  'BINDING_UNAVAILABLE',
  'NOT_BOUND',
  'SIMULATED_CASE',
  'UNKNOWN_INTENT',
  'UNKNOWN_CASE',
  'WRONG_SEND_ROUTE',
  'INVALID_SUBMISSION',
  'INVALID_JSON',
  'UPLOAD_CHANGED',
  'DISPUTE_BUSY',
  'SELLER_EVIDENCE_EXISTS',
  'INTENT_PROPOSED',
  'INTENT_INVALIDATED',
  'INTENT_EXPIRED',
  'INTENT_CANCELLED',
  'TEXT_REQUIRED',
  'TEXT_TOO_LONG',
  // The amount checks of composing again at send (actions.ts), before anything reaches PayPal.
  'AMOUNT_NOT_ALLOWED',
  'AMOUNT_REQUIRED',
  'AMOUNT_ABOVE_DISPUTE',
  'AMOUNT_ABOVE_REFUNDABLE',
  'CURRENCY_MISMATCH',
  'UNKNOWN_CURRENCY',
  'INVALID_AMOUNT',
  'DISPUTE_AMOUNT_UNKNOWN',
  'DAILY_CAP',
  'PERSON_CAP',
  'RATE_LIMITED',
  'TOO_MANY_INTENTS',
]);

/** A refusal the server gave before anything reached PayPal; null when the outcome may be anything (read back). */
function refusalOf(e: unknown): ActionResult | null {
  if (!(e instanceof GatewayRequestError)) return null;
  const b = e.body;
  // An uncertain dispute is never «not sent»: an earlier send is not proven yet.
  if (e.code === 'DISPUTE_UNCERTAIN') {
    const h = b.holder as { intentId?: unknown; caseId?: unknown } | undefined;
    const holder = h && typeof h.intentId === 'string' && typeof h.caseId === 'string' ? { id: h.intentId, caseId: h.caseId } : undefined;
    return { kind: 'pending', detail: typeof b.detail === 'string' ? b.detail : PENDING, snapshot: null, base: null, ...(holder ? { holder } : {}) };
  }
  const definite = e.status >= 400 && e.status < 500 && (NOT_SENT_CODES.has(e.code) || (e.code === 'PAYPAL_REFUSED' && e.status === 422));
  if (!definite) return null;
  const refusal: ActionRefusal = { code: e.code };
  if (e.code === 'NEEDS_REVIEW' && Array.isArray(b.messages)) {
    refusal.messages = b.messages as DisputeMessage[];
    refusal.messageKeys = Array.isArray(b.messageKeys) ? (b.messageKeys as string[]) : [];
  }
  if (e.code === 'CONFIRMATION_REQUIRED' && b.terms && typeof b.terms === 'object') refusal.terms = b.terms as ConfirmationTerms;
  return { kind: 'not_sent', detail: e.message, snapshot: null, base: null, refusal };
}

/** Real PayPal: what the server's read-back proves now (of `ref`, this intent by default). */
async function serverReadBack(o: ActionSendOptions, fallback: string, ref: IntentRef = o.intent): Promise<ActionResult> {
  try {
    const r = await o.intents.readBack(ref);
    if (!r) return { kind: 'pending', detail: fallback, snapshot: null, base: null };
    const state = r.readBack.state;
    return { kind: state, detail: state === 'recorded' ? recordedBy(o.mode) : r.readBack.detail, snapshot: r.snapshot, base: null };
  } catch (e) {
    // The send never started (refused before PayPal, e.g. a read that failed first): nothing reached PayPal.
    if (e instanceof IntentError && e.code === 'INTENT_NOT_SENT') return { kind: 'not_sent', detail: 'Nothing was sent to PayPal', snapshot: null, base: null };
    return { kind: 'pending', detail: `${PENDING}: ${message(e)}`, snapshot: null, base: null };
  }
}

/** The simulator: what the simulated dispute shows now, by the contract's proof. */
async function simulatorReadBack(o: ActionSendOptions, base: ReadBackBase): Promise<ActionResult> {
  const contract = contractOf(o);
  const snapshot = await o.gateway.getDispute(o.intent.caseId);
  if (!contract) return { kind: 'pending', detail: PENDING, snapshot, base };
  const r = proveSend(o.intent, base, snapshot, contract, (o.now?.() ?? new Date()).getTime());
  // A proven send is recorded as the server records it: a later identical message is a repeat.
  if (r.state === 'recorded') o.intents.proven?.(o.intent);
  return { kind: r.state, detail: r.state === 'recorded' ? recordedBy(o.mode) : r.state === 'pending' ? PENDING : 'The simulator shows no trace of this send and still offers the action', snapshot, base };
}

/**
 * Send once, then read back. The result is «recorded» only from a read-back proof; an unclear answer (a timeout, an
 * error that proves nothing) is «pending», never «not sent».
 */
export async function sendActionWithReadBack(o: ActionSendOptions): Promise<ActionResult> {
  if (o.mode.kind === 'paypal') {
    o.onPhase?.('sending');
    try {
      const answer = await o.gateway.sendAction(o.intent, { requestId: o.intent.requestId });
      o.onPhase?.('rereading');
      return await serverReadBack(o, answer.sent === 'unknown' ? `${PENDING}: PayPal did not answer clearly` : PENDING);
    } catch (e) {
      const refused = refusalOf(e);
      if (refused) return refused;
      o.onPhase?.('rereading');
      return serverReadBack(o, e instanceof GatewayTimeoutError ? `${PENDING}: the ResolveKit server did not answer in time` : PENDING);
    }
  }
  // The simulator: the base is the read right before the send, timed before it (as the server does).
  const contract = contractOf(o);
  const sentStartedAt = (o.now?.() ?? new Date()).toISOString();
  o.onPhase?.('reading');
  let before: DisputeSnapshot;
  try {
    before = await o.gateway.getDispute(o.intent.caseId);
  } catch (e) {
    return { kind: 'not_sent', detail: `The simulator could not be read; nothing was sent (${message(e)})`, snapshot: null, base: null };
  }
  const base = contract?.proof ? readBackBase(before, contract.proof, sentStartedAt) : { entryKeys: [], stage: before.stage ?? null, status: before.status, sentStartedAt };
  o.onPhase?.('sending');
  try {
    await o.gateway.sendAction(o.intent, { requestId: o.intent.requestId });
  } catch (e) {
    return { kind: 'not_sent', detail: message(e), snapshot: before, base: null };
  }
  o.onPhase?.('rereading');
  return simulatorReadBack(o, base);
}

/** The words for a holder's send that is settled, while this intent was refused because of it. */
export const HOLDER_SETTLED = 'HOLDER_SETTLED';

/**
 * «Check again» on the send holding the dispute (another intent): read it back only. Still unproven: pending, about
 * that send. Settled (recorded or absent): the dispute is free and THIS intent was never sent — said so, and it may be
 * sent now (its own send re-checks everything).
 */
async function holderReadBack(o: ActionSendOptions, holder: IntentRef): Promise<ActionResult> {
  const settled = (what: string, snapshot: DisputeSnapshot | null): ActionResult => ({
    kind: 'not_sent',
    detail: `The earlier send on this dispute is settled (${what}). Yours was not sent: it waited for that send. Send it now; it is checked again against PayPal first.`,
    snapshot,
    base: null,
    refusal: { code: HOLDER_SETTLED },
  });
  let r: ActionResult;
  try {
    const rb = await o.intents.readBack(holder);
    r = rb ? { kind: rb.readBack.state, detail: rb.readBack.detail, snapshot: rb.snapshot, base: null } : { kind: 'pending', detail: PENDING, snapshot: null, base: null };
  } catch (e) {
    // A colleague's send that no longer holds the dispute is unknown to this person (404): the hold route says whether
    // anything still holds it. Nothing, or another send: this holder is settled.
    if (e instanceof IntentError && e.status === 404 && e.code === 'UNKNOWN_INTENT') {
      const now = await currentHold(o.intents, holder.caseId);
      if (now !== undefined && now?.intentId !== holder.id) return settled('it is not held any more', null);
    }
    if (e instanceof IntentError && e.code === 'INTENT_NOT_SENT') return settled('it is not held any more', null);
    return { kind: 'pending', detail: `${PENDING}: ${message(e)}`, snapshot: null, base: null, holder };
  }
  if (r.kind === 'pending') return { ...r, holder };
  return settled(r.kind === 'recorded' ? 'PayPal recorded it' : r.kind === 'absent' ? 'PayPal shows no trace of it' : 'it is not held any more', r.snapshot);
}

/** What holds the case's dispute now (null: nothing); undefined when the server could not say. */
export async function currentHold(intents: Pick<IntentSource, 'hold'>, caseId: string): Promise<DisputeHoldView | null | undefined> {
  try {
    return await intents.hold(caseId);
  } catch {
    return undefined;
  }
}

/** «Check again»: read back only, never send. With `holder`, the send holding the dispute is the one read back. */
export async function checkAgain(o: ActionSendOptions & { base: ReadBackBase | null; holder?: IntentRef }): Promise<ActionResult> {
  if (o.mode.kind === 'paypal' && o.holder && o.holder.id !== o.intent.id) return holderReadBack(o, o.holder);
  if (o.mode.kind === 'paypal') return serverReadBack(o, PENDING);
  if (!o.base) return { kind: 'pending', detail: PENDING, snapshot: null, base: null };
  return simulatorReadBack(o, o.base);
}
