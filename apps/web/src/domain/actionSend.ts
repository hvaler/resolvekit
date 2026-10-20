/**
 * Send an approved action intent and say only what a read-back proves ([A4]). Real PayPal: the server sends it once
 * (`POST /send`) and reads it back (`GET …/readback`, with the proof of actionReadback.ts). The simulator: this browser
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
import { IntentError, type IntentSource } from './intentClient';
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

/** A refusal the server gave before anything reached PayPal; null when the outcome may be anything. */
function refusalOf(e: unknown): ActionResult | null {
  if (!(e instanceof GatewayRequestError)) return null;
  const b = e.body;
  // An uncertain dispute is never «not sent»: an earlier send is not proven yet.
  if (e.code === 'DISPUTE_UNCERTAIN') return { kind: 'pending', detail: typeof b.detail === 'string' ? b.detail : PENDING, snapshot: null, base: null };
  const refusal: ActionRefusal = { code: e.code };
  if (e.code === 'NEEDS_REVIEW' && Array.isArray(b.messages)) {
    refusal.messages = b.messages as DisputeMessage[];
    refusal.messageKeys = Array.isArray(b.messageKeys) ? (b.messageKeys as string[]) : [];
  }
  if (e.code === 'CONFIRMATION_REQUIRED' && b.terms && typeof b.terms === 'object') refusal.terms = b.terms as ConfirmationTerms;
  return { kind: 'not_sent', detail: e.message, snapshot: null, base: null, refusal };
}

/** Real PayPal: what the server's read-back proves now. */
async function serverReadBack(o: ActionSendOptions, fallback: string): Promise<ActionResult> {
  try {
    const r = await o.intents.readBack(o.intent);
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

/** «Check again»: read back only, never send. */
export async function checkAgain(o: ActionSendOptions & { base: ReadBackBase | null }): Promise<ActionResult> {
  if (o.mode.kind === 'paypal') return serverReadBack(o, PENDING);
  if (!o.base) return { kind: 'pending', detail: PENDING, snapshot: null, base: null };
  return simulatorReadBack(o, o.base);
}
