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

/**
 * Recorded 20/10/2026 (W-4, and W-9 for a partial accept): an offer is an `offer.history[]` entry `actor: SELLER`,
 * `event_type: PROPOSED`, with `offer_time`, `offer_type` and `offer_amount` as sent (reads/W-4-*.json, W-9-*.json).
 * PayPal also echoes the note as a seller `messages[]` entry at the offer's time; the proof is the offer entry only.
 */
const OFFER_PROOF: ProofFields = {
  list: 'offerHistory',
  actorField: 'actor',
  actorValue: 'SELLER',
  timeField: 'offer_time',
  matchFields: ['event_type', 'offer_type', 'offer_amount.value', 'offer_amount.currency_code'],
  normalise: [],
};

/** Recorded 20/10/2026 (W-5): an escalation is an `evidences[]` entry by the seller with action ESCALATE and the note. */
const ESCALATE_PROOF: ProofFields = {
  list: 'evidences',
  actorField: 'source',
  actorValue: 'SUBMITTED_BY_SELLER',
  timeField: 'date',
  matchFields: ['action_info.action', 'notes'],
  normalise: [],
};

const ev = (action: string) => `contrato-${action}-2026-10-19.md`;

export const CONTRACTS: Readonly<Record<VariantId, VariantContract>> = Object.freeze({
  // Recorded 20/10/2026 (owner-approved W-1, PP-R-VQD-10193598): JSON accepted, the entry visible ≈3 s after the send
  // started, content stored byte-identical. absentAfterMs: that lag rounded up to the 30 s read step, ×2. After a seller
  // message PayPal stopped offering make_offer (WAITING_FOR_BUYER_RESPONSE); a brief UNDER_REVIEW with no links came
  // first. PayPal-Request-Id does NOT dedupe (W-2: the same request id posted a second message).
  // Tested locally (Task 8): the server route, the web flow and the simulator's recorded transitions.
  // Verified through the app flow 20/10/2026 (V-1).
  send_message: {
    ...base('send_message', `${REF}disputes-send-message`, 'json', route('send-message'), MESSAGE_PROOF, ev('send-message')),
    status: 'verified_in_sandbox',
    reason: null,
    absentAfterMs: 60_000,
    requestIdDedupes: false,
    recorded: 'packages/paypal/contracts/send_message.json',
  },
  // Recorded 20/10/2026 (owner-approved W-3): multipart parts `input` (the JSON message) and `message_document` (the
  // file) accepted; the entry is a seller message with the exact content and one `documents[]` item, ≈3.5 s after the
  // send started. Same proof as a text message (the content is matched; the attachment's presence is not).
  // Tested locally (Task 8), like the text message; the simulator plays it only from WAITING_FOR_BUYER_RESPONSE (W-3).
  // The web composer cannot attach an upload yet, so the UI does not offer it; the server path is tested. Not verified
  // through the app flow (20/10/2026): it stays tested locally.
  'send_message:file': {
    ...base('send_message:file', `${REF}disputes-send-message`, 'multipart', route('send-message'), MESSAGE_PROOF, ev('send-message')),
    status: 'tested_locally',
    reason: null,
    absentAfterMs: 60_000,
    requestIdDedupes: false,
    recorded: 'packages/paypal/contracts/send_message-file.json',
  },
  // Recorded 20/10/2026 (owner-approved W-10, PP-R-PAU-10193600): JSON accepted; the attributable entry (ACCEPT_CLAIM,
  // response_option REFUND, the note) ≈5 s after the send started, a 7.00 USD refund at once, RESOLVED (buyer's favour,
  // SELLER_ISSUED_REFUND) by +2 min after UNDER_REVIEW. Irreversible: money moved and the dispute closed.
  // Tested locally (Task 9): owner only, the bound second confirmation (REFUNDS_BUYER, the dispute amount), the
  // recorded body, the ACCEPT_CLAIM proof and the simulator's recorded transition.
  // Verified through the app flow 20/10/2026 (V-4).
  'accept_claim:REFUND': {
    ...base('accept_claim:REFUND', `${REF}disputes-accept-claim`, 'json', route('accept-claim'), ACCEPT_PROOF, ev('accept-claim')),
    status: 'verified_in_sandbox',
    reason: null,
    absentAfterMs: 60_000,
    recorded: 'packages/paypal/contracts/accept_claim-refund.json',
  },
  // Recorded 20/10/2026 (owner-approved W-9, PP-R-KMJ-10193602): accepted (200), but PayPal records a partial accept as
  // an OFFER awaiting the buyer: an offer.history SELLER PROPOSED entry, type REFUND, the partial amount; no evidences[]
  // entry; nothing closes, no money moves until the buyer agrees. The note is echoed as a seller message at the offer's
  // time. Proof = the offer shape (the accept type is not in it): the read-back maps event_type PROPOSED, offer_type
  // 'REFUND' and offer_amount from the accept payload.
  // Tested locally (Task 9): owner only, its own consequence (OFFERS_PARTIAL_REFUND, the partial amount), the recorded
  // body, the offer proof and the simulator's recorded transition (a pending offer, never a closed dispute).
  // Verified through the app flow 20/10/2026 (V-3).
  'accept_claim:PARTIAL_REFUND': {
    ...base('accept_claim:PARTIAL_REFUND', `${REF}disputes-accept-claim`, 'json', route('accept-claim'), OFFER_PROOF, ev('accept-claim')),
    status: 'verified_in_sandbox',
    reason: null,
    absentAfterMs: 60_000,
    recorded: 'packages/paypal/contracts/accept_claim-partial_refund.json',
  },
  // Recorded 20/10/2026 (owner-approved W-5, PP-R-NDZ-10193597): JSON accepted; an attributable evidences[] entry
  // (SUBMITTED_BY_SELLER, action_info.action ESCALATE, the note) ≈3.9 s after the send started. The stage moved to
  // CHARGEBACK ≈2 min 46 s later; in between the status was UNDER_REVIEW and the links flickered (never "closed").
  // The read-back maps action_info.action 'ESCALATE' and the note from the approved content; a stage change alone is
  // never proof (the buyer or PayPal can escalate too).
  // Tested locally (Task 10): owner only, the bound second confirmation (MOVES_TO_CLAIM, no amount), a note required,
  // only from the recorded state (INQUIRY, a not-received dispute), the recorded body, the ESCALATE proof and the
  // simulator's recorded transition (the transient UNDER_REVIEW, the claim stage after a delay). No closure lock.
  // Verified through the app flow 20/10/2026 (V-5).
  escalate: {
    ...base('escalate', `${REF}disputes-escalate`, 'json', route('escalate'), ESCALATE_PROOF, ev('escalate')),
    status: 'verified_in_sandbox',
    reason: null,
    absentAfterMs: 60_000,
    recorded: 'packages/paypal/contracts/escalate.json',
  },
  // Recorded 20/10/2026 (owner-approved W-4, PP-R-OZY-10193601): JSON accepted; offer.history gains a SELLER PROPOSED
  // entry with the approved type and amount ≈3.5 s after the send started, and the note echoed as a seller message at the
  // same time (the proof is the offer entry). No money moves and
  // nothing closes until the buyer accepts; afterwards PayPal waits for the buyer, stops offering make_offer and offers
  // accept_claim REFUND only.
  // Tested locally (Task 11): owner only, the bound second confirmation (OFFERS_SETTLEMENT, the amount offered), a note
  // and an amount below the dispute amount and within PayPal's refundable amount, only from the recorded state (INQUIRY,
  // a not-received dispute), refused while a seller offer is pending, the recorded body, the offer proof and the
  // simulator's recorded transition (a pending offer, never a refund or a closed dispute).
  // Verified through the app flow 20/10/2026 (V-2).
  'make_offer:REFUND': {
    ...base('make_offer:REFUND', `${REF}disputes-make-offer`, 'json', route('make-offer'), OFFER_PROOF, ev('make-offer')),
    status: 'verified_in_sandbox',
    reason: null,
    absentAfterMs: 60_000,
    recorded: 'packages/paypal/contracts/make_offer-refund.json',
  },
  // 20/10/2026: the not-as-described sandbox dispute F (PP-R-GCV-10193596) offered only REFUND and REFUND_WITH_RETURN
  // (reads/W-12-pre.json), so the prepared W-12 was not sent: never observed, not available.
  'make_offer:REPLACEMENT_WITHOUT_REFUND': base('make_offer:REPLACEMENT_WITHOUT_REFUND', `${REF}disputes-make-offer`, 'json', route('make-offer'), null, ev('make-offer'), 'Not verified with PayPal: never offered on a sandbox dispute'),
  // Disputes v1 lists no operation that withdraws an offer (schema read 2026-10-19).
  'make_offer:withdraw': base('make_offer:withdraw', `${REF}disputes-make-offer`, null, null, null, ev('make-offer'), 'PayPal documents no route to withdraw an offer'),
  // 20/10/2026 (owner-approved W-7): the sandbox's adjudicate helper was refused on the escalated dispute B while it was
  // UNDER_REVIEW (400 ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE; packages/paypal/contracts/appeal-setup-adjudicate.json),
  // so no appealable state could be produced and no appeal was ever sent.
  appeal: base('appeal', `${REF}disputes-appeal`, 'multipart', route('appeal'), null, ev('appeal'), 'Not verified with PayPal: the sandbox could not produce an appealable dispute'),
  // Owner decision 20/10/2026: not sent in this delivery. W-11 stays a pending sandbox test (sequence in the evidence
  // file): a payment refunded in part before its dispute opens (a disputed payment is held and cannot be refunded
  // outside the case, observed 19/10), then PROOF_OF_REFUND with the refund id, approved, then read back.
  'evidence:PROOF_OF_REFUND': base('evidence:PROOF_OF_REFUND', `${REF}disputes-provide-evidence`, 'multipart', route('provide-evidence'), null, ev('proof-of-refund'), 'Not verified with PayPal: pending sandbox test (W-11)'),
  // Recorded 20/10/2026 (owner-approved W-6, after W-5): evidence is accepted again in CHARGEBACK; each evidences[]
  // entry carries `dispute_life_cycle_stage` (the escalation's INQUIRY, this one CHARGEBACK), which is what ties sent
  // evidence to a stage. Read back by the existing provide-evidence matcher (no proof here).
  // Tested locally (Task 10): the evidence memory by (dispute, stage) from each entry's dispute_life_cycle_stage
  // (recorded.ts), evidence after an escalation only in the recorded state (the claim waiting for the seller), and the
  // simulator's recorded transition (UNDER_REVIEW in the claim, no seller action).
  // Verified through the app flow 20/10/2026 (V-6).
  'evidence:after_escalation': {
    ...base('evidence:after_escalation', `${REF}disputes-provide-evidence`, 'multipart', route('provide-evidence'), null, ev('escalate')),
    status: 'verified_in_sandbox',
    reason: null,
    absentAfterMs: 60_000,
    recorded: 'packages/paypal/contracts/evidence-after-escalation.json',
  },
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

/** The registry's reason when a variant is «Not available» (its own reason, or that its contract is not recorded); null otherwise. */
export function unavailableReason(v: VariantId, contracts: Readonly<Record<VariantId, Pick<VariantContract, 'status' | 'reason'>>> = CONTRACTS): string | null {
  const c = contracts[v];
  return c.status === 'not_available' ? (c.reason ?? NOT_RECORDED) : null;
}

/** Each status as the product and the docs name it ([A7]). */
export const STATUS_LABEL: Readonly<Record<VariantStatus, string>> = Object.freeze({
  not_available: 'Not available',
  implemented: 'Implemented',
  tested_locally: 'Tested locally',
  verified_in_sandbox: 'Verified in sandbox',
  deployed: 'Deployed',
});

/** «Not available: <reason>», or the status by name: a variant is never described beyond its status. */
export function statusLabel(c: Pick<VariantContract, 'status' | 'reason'>): string {
  if (c.status !== 'not_available') return STATUS_LABEL[c.status];
  return c.reason ? `${STATUS_LABEL.not_available}: ${c.reason}` : STATUS_LABEL.not_available;
}
