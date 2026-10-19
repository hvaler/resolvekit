/**
 * How an approved action intent goes to PayPal (B0): one POST by action, in the body format its contract records
 * (apps/web/src/domain/actionContracts.ts), with the intent's PayPal-Request-Id. Nothing here retries: PayPal documents
 * no deduplication by PayPal-Request-Id on these routes, so an unclear outcome is read back first ([A4]).
 *
 * Field names follow PayPal's Disputes v1 reference (accept-claim `note`, `accept_claim_type`, `refund_amount`;
 * make-offer `note`, `offer_type`, `offer_amount`; escalate `note`; send-message `message`). Each action's task pins
 * them against its recorded contract before the variant becomes available.
 */
import { PayPalError, type EvidenceFile, type PayPalClient } from '@resolvekit/paypal';
import { CONTRACTS, variantOf, type VariantContract } from '../../../web/src/domain/actionContracts.ts';
import { intentAction, type IntentAction } from '../../../web/src/domain/actions.ts';
import type { IntentContent } from '../../../web/src/domain/intent.ts';
import type { CostlyAction } from '../app.ts';

/** A refusal before any request: the intent cannot be sent as it is (never reaches PayPal, proves nothing was done). */
export class NotSendable extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'NotSendable';
  }
}

/** The hosted daily cap an action counts against: evidence, messages, or the settling actions. */
export function capOf(a: IntentAction): CostlyAction {
  if (a === 'provide_evidence') return 'evidence';
  return a === 'send_message' ? 'message' : 'settle';
}

/** The registry entry of the variant an intent sends; null when it is not a variant of the registry. */
export function contractOf(c: IntentContent, contracts: Readonly<Record<string, VariantContract>> = CONTRACTS): VariantContract | null {
  const p = c.payload;
  const action = intentAction(c);
  const type =
    action === 'send_message' ? (c.files.length ? 'file' : null) : p?.kind === 'accept_claim' ? p.acceptType : p?.kind === 'make_offer' ? p.offerType : action === 'provide_evidence' ? c.evidenceType : null;
  const v = variantOf(action, type);
  return v ? (contracts[v] ?? null) : null;
}

const amountOf = (m: { value: string; currency: string } | null) => (m ? { currency_code: m.currency, value: m.value } : undefined);

/**
 * POST the intent's action to PayPal. Throws what PayPal throws (see {@link isAmbiguous}), or {@link NotSendable} before
 * any request when the content or its contract cannot be sent (no body format, a file on a JSON-only variant).
 */
export async function callPayPal(
  paypal: PayPalClient,
  disputeId: string,
  c: IntentContent,
  files: EvidenceFile[],
  requestId: string,
  contracts: Readonly<Record<string, VariantContract>> = CONTRACTS,
): Promise<unknown> {
  if (!requestId) throw new NotSendable('An action is sent only with its intent’s request id');
  const contract = contractOf(c, contracts);
  const format = contract?.body ?? null;
  if (!contract || contract.status === 'not_available') throw new NotSendable(`Not available: ${contract?.reason ?? 'not a variant ResolveKit can send'}`);
  if (!format) throw new NotSendable('This variant has no recorded body format');
  const opts = { requestId, format };
  const p = c.payload;
  switch (intentAction(c)) {
    case 'send_message':
      if (p?.kind !== 'send_message') break;
      if (files.length > 1) throw new NotSendable('A message carries at most one file');
      return paypal.disputes.sendMessage(disputeId, p.text, files[0] ?? null, opts);
    case 'accept_claim': {
      if (p?.kind !== 'accept_claim') break;
      const amount = amountOf(p.amount);
      return paypal.disputes.acceptClaim(disputeId, { accept_claim_type: p.acceptType, ...(p.note ? { note: p.note } : {}), ...(amount ? { refund_amount: amount } : {}) }, opts);
    }
    case 'make_offer': {
      if (p?.kind !== 'make_offer') break;
      const amount = amountOf(p.amount);
      return paypal.disputes.makeOffer(disputeId, { offer_type: p.offerType, note: p.note, ...(amount ? { offer_amount: amount } : {}) }, opts);
    }
    case 'escalate':
      if (p?.kind !== 'escalate') break;
      return paypal.disputes.escalate(disputeId, p.note, opts);
    case 'appeal':
      return paypal.disputes.appeal(disputeId, { evidence_type: c.evidenceType, notes: c.notes }, files, opts);
    case 'provide_evidence':
      throw new NotSendable('Evidence is sent from its own route');
  }
  throw new NotSendable('The intent’s payload does not match its action');
}

/**
 * Why {@link callPayPal} would refuse this content before any request, or null: the route asks before send_started, so
 * nothing that cannot be sent is ever started.
 */
export function sendProblem(c: IntentContent, files: readonly EvidenceFile[], contracts: Readonly<Record<string, VariantContract>> = CONTRACTS): string | null {
  const action = intentAction(c);
  if (action === 'provide_evidence') return 'Evidence is sent from its own route';
  const contract = contractOf(c, contracts);
  if (!contract || contract.status === 'not_available') return contract?.reason ?? 'not a variant ResolveKit can send';
  if (!contract.body) return 'This variant has no recorded body format';
  if (action !== 'appeal' && c.payload?.kind !== action) return 'The intent’s payload does not match its action';
  if (action === 'send_message' && files.length > 1) return 'A message carries at most one file';
  if (files.length && contract.body !== 'multipart') return 'A file goes only with a multipart variant';
  return null;
}

/** PayPal's issue code from `details[].issue`, if it gave one. */
function issueOf(e: PayPalError): string | null {
  const b = e.body as { details?: Array<{ issue?: unknown }> } | null;
  const d = Array.isArray(b?.details) ? b.details.find((x) => typeof x?.issue === 'string' && x.issue) : undefined;
  return (d?.issue as string | undefined) ?? null;
}

/**
 * Whether a failed action POST leaves its outcome unknown (the dispute is then held as uncertain, [A1]): timeouts,
 * network errors, 5xx, a body that is not JSON, and a 4xx without a PayPal issue code. Only a 4xx with an issue code
 * (`details[].issue`) proves PayPal refused it without acting. Anything else, {@link NotSendable} included, is
 * ambiguous: the route checks {@link sendProblem} before send_started, so a NotSendable never gets this far.
 */
export function isAmbiguous(e: unknown): boolean {
  if (!(e instanceof PayPalError)) return true;
  if (e.status < 400 || e.status >= 500) return true;
  if ((e.body as { name?: unknown } | null)?.name === 'NON_JSON_RESPONSE') return true;
  return issueOf(e) === null;
}
