/**
 * The contract registry of the dispute actions (B, [A2], [A7]): one entry per action variant, with what PayPal's
 * documentation says (route, body format) and what the sandbox reads have shown (the fields a read-back proof can
 * use). A variant is available only once its contract is recorded: documentation, GET reads AND one write the owner
 * approved, its response and its read-back (packages/paypal/contracts/README.md). Until then it is «Not available»
 * with its reason, in the product, the simulator and the docs.
 *
 * Sources (accessed 2026-10-19): the Disputes v1 reference and schema
 * (https://developer.paypal.com/api/customer-disputes/v1/schema.json), the «Use the Disputes API» guide
 * (https://developer.paypal.com/platforms/disputes/handle-disputes/use-disputes-api) and «Test and go live»
 * (https://developer.paypal.com/platforms/disputes/test-go-live). Reads: packages/paypal/contracts/reads/.
 */
import type { IntentAction } from './actions.ts';

export type VariantId =
  | 'send_message'
  | 'send_message:file'
  | 'accept_claim:REFUND'
  | 'accept_claim:PARTIAL_REFUND'
  | 'escalate'
  | 'make_offer:REFUND'
  | 'make_offer:REPLACEMENT_WITHOUT_REFUND'
  | 'make_offer:withdraw'
  | 'appeal'
  | 'evidence:PROOF_OF_REFUND'
  | 'evidence:after_escalation'
  | 'return_address';

export type VariantStatus = 'not_available' | 'implemented' | 'tested_locally' | 'verified_in_sandbox' | 'deployed';

/** Where in a fresh dispute read a proof of the action is found, and how an entry is matched to this send. */
export interface ProofFields {
  list: 'messages' | 'offerHistory' | 'evidences' | 'adjudications' | null;
  actorField: string | null;
  actorValue: string | null;
  timeField: string | null;
  /** Fields of the entry compared with the approved content (dotted paths). */
  matchFields: string[];
  /** What PayPal is seen to do to the text before storing it; empty: stored as sent. */
  normalise: Array<'trim' | 'crlf' | 'nfc'>;
}

export interface VariantContract {
  id: VariantId;
  status: VariantStatus;
  reason: string | null;
  docUrl: string | null;
  body: 'json' | 'multipart' | null;
  route: string | null;
  proof: ProofFields | null;
  /** After how long without a proof the action may be taken as absent (only from a recorded contract). */
  absentAfterMs: number | null;
  /** Whether PayPal-Request-Id deduplicates on this route (only from a recorded contract). */
  requestIdDedupes: boolean | null;
  /** packages/paypal/contracts/<file>.json */
  recorded: string | null;
  /** evidencia file name */
  evidence: string | null;
}

const REF = 'https://developer.paypal.com/api/customer-disputes/v1/';
const NOT_RECORDED = 'Contract not recorded yet';
const route = (action: string) => `POST /v1/customer/disputes/{id}/${action}`;

const base = (id: VariantId, docUrl: string | null, body: VariantContract['body'], r: string | null, proof: ProofFields | null = null, evidence: string | null = null, reason = NOT_RECORDED): VariantContract => ({
  id,
  status: 'not_available',
  reason,
  docUrl,
  body,
  route: r,
  proof,
  absentAfterMs: null,
  requestIdDedupes: null,
  recorded: null,
  evidence,
});

/**
 * Seen in the sandbox reads: a seller message is a `messages[]` entry `posted_by: SELLER` with `time_posted` and the
 * text in `content`, stored as sent (one observation, PP-R-TVH-10190665, sent 2026-10-08; reads/inquiry-after-evidence-TVH.json).
 */
const MESSAGE_PROOF: ProofFields = { list: 'messages', actorField: 'posted_by', actorValue: 'SELLER', timeField: 'time_posted', matchFields: ['content'], normalise: [] };

/**
 * Seen in the sandbox reads: an accepted claim leaves an `evidences[]` entry `source: SUBMITTED_BY_SELLER` with `date`,
 * `action_info.action: ACCEPT_CLAIM`, `action_info.response_option` (the accept type) and the note in `notes`
 * (PP-R-GFC-10190664, accepted 2026-10-08; reads/resolved-GFC.json).
 */
const ACCEPT_PROOF: ProofFields = {
  list: 'evidences',
  actorField: 'source',
  actorValue: 'SUBMITTED_BY_SELLER',
  timeField: 'date',
  matchFields: ['action_info.action', 'action_info.response_option', 'notes'],
  normalise: [],
};

const ev = (action: string) => `contrato-${action}-2026-10-19.md`;

export const CONTRACTS: Readonly<Record<VariantId, VariantContract>> = Object.freeze({
  send_message: base('send_message', `${REF}disputes-send-message`, 'json', route('send-message'), MESSAGE_PROOF, ev('send-message')),
  'send_message:file': base('send_message:file', `${REF}disputes-send-message`, 'multipart', route('send-message'), null, ev('send-message')),
  'accept_claim:REFUND': base('accept_claim:REFUND', `${REF}disputes-accept-claim`, 'json', route('accept-claim'), ACCEPT_PROOF, ev('accept-claim')),
  'accept_claim:PARTIAL_REFUND': base('accept_claim:PARTIAL_REFUND', `${REF}disputes-accept-claim`, 'json', route('accept-claim'), null, ev('accept-claim')),
  escalate: base('escalate', `${REF}disputes-escalate`, 'json', route('escalate'), null, ev('escalate')),
  'make_offer:REFUND': base('make_offer:REFUND', `${REF}disputes-make-offer`, 'json', route('make-offer'), null, ev('make-offer')),
  'make_offer:REPLACEMENT_WITHOUT_REFUND': base('make_offer:REPLACEMENT_WITHOUT_REFUND', `${REF}disputes-make-offer`, 'json', route('make-offer'), null, ev('make-offer')),
  // Disputes v1 lists no operation that withdraws an offer (schema read 2026-10-19).
  'make_offer:withdraw': base('make_offer:withdraw', `${REF}disputes-make-offer`, null, null, null, ev('make-offer'), 'PayPal documents no route to withdraw an offer'),
  appeal: base('appeal', `${REF}disputes-appeal`, 'multipart', route('appeal'), null, ev('appeal')),
  'evidence:PROOF_OF_REFUND': base('evidence:PROOF_OF_REFUND', `${REF}disputes-provide-evidence`, 'multipart', route('provide-evidence'), null, ev('proof-of-refund')),
  'evidence:after_escalation': base('evidence:after_escalation', `${REF}disputes-provide-evidence`, 'multipart', route('provide-evidence'), null, ev('escalate')),
  // The return types of both accept-claim (REFUND_WITH_RETURN, REFUND_WITH_RETURN_SHIPMENT_LABEL) and make-offer
  // (REFUND_WITH_RETURN): not in this delivery, by the owner's decision.
  return_address: base('return_address', `${REF}disputes-make-offer`, null, null, null, null, 'Not in this delivery (owner decision)'),
});

const ACCEPT: Partial<Record<string, VariantId>> = { REFUND: 'accept_claim:REFUND', PARTIAL_REFUND: 'accept_claim:PARTIAL_REFUND' };
const OFFER: Partial<Record<string, VariantId>> = { REFUND: 'make_offer:REFUND', REPLACEMENT_WITHOUT_REFUND: 'make_offer:REPLACEMENT_WITHOUT_REFUND', withdraw: 'make_offer:withdraw' };
const EVIDENCE: Partial<Record<string, VariantId>> = { PROOF_OF_REFUND: 'evidence:PROOF_OF_REFUND', after_escalation: 'evidence:after_escalation' };
/** Accept and offer types that ask the buyer to return the item (to the seller's return address). */
const RETURN_TYPES = new Set(['REFUND_WITH_RETURN', 'REFUND_WITH_RETURN_SHIPMENT_LABEL']);

/**
 * The variant of an action with its type (accept or offer type, evidence type, `file` for a message with an
 * attachment). Null when the combination is not a variant of the registry (e.g. evidence of another type, which keeps
 * the existing provide-evidence flow).
 */
export function variantOf(action: IntentAction, type?: string | null): VariantId | null {
  switch (action) {
    case 'send_message':
      return type === 'file' ? 'send_message:file' : type ? null : 'send_message';
    case 'escalate':
      return type ? null : 'escalate';
    case 'appeal':
      return type ? null : 'appeal';
    case 'accept_claim':
      return type ? (RETURN_TYPES.has(type) ? 'return_address' : (ACCEPT[type] ?? null)) : null;
    case 'make_offer':
      return type ? (RETURN_TYPES.has(type) ? 'return_address' : (OFFER[type] ?? null)) : null;
    case 'provide_evidence':
      return type ? (EVIDENCE[type] ?? null) : null;
  }
}

/** Available means its contract is recorded: any status but «Not available». */
export const available = (v: VariantId): boolean => CONTRACTS[v].status !== 'not_available';
