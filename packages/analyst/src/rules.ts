/**
 * Domain rules, deterministic. What a dispute reason needs (the checklist's requirements) and which action to
 * recommend are decided here, from PayPal's allowed actions and requested evidence type and from the verified
 * analysis. The model assesses each requirement against the facts and explains the chosen action; it never picks it.
 */
import type { ChecklistItem, DisputeContext, RecommendedAction, Sentence } from './types.ts';

export interface Requirement {
  id: string;
  label: string;
  critical: boolean;
  /** What counts, told to the model. */
  hint: string;
}

const PHYSICAL_NOT_RECEIVED: Requirement[] = [
  { id: 'tracking', label: 'Tracking number with delivery confirmation', critical: true, hint: 'a carrier tracking record that says the parcel was delivered' },
  { id: 'carrier', label: 'Carrier and ship date', critical: true, hint: 'which carrier shipped it and when' },
  { id: 'address', label: 'Delivery address matches the order', critical: false, hint: 'the delivered-to address equals the order ship-to address (any difference: contradicts)' },
  { id: 'signature', label: 'Signature or proof of receipt', critical: false, hint: 'a signature, photo or receipt confirmation at delivery' },
  { id: 'payment', label: 'Payment record for the disputed amount', critical: false, hint: 'a payment/capture record whose amount equals the disputed amount' },
];

const SERVICE_NOT_RECEIVED: Requirement[] = [
  { id: 'mandate', label: 'Buyer authorised the spend', critical: true, hint: 'the buyer approved a budget/mandate for the purchase' },
  { id: 'calls', label: 'Per-call record with status', critical: true, hint: 'each delivered unit (call) listed with time, price and status' },
  { id: 'charges', label: 'Charges match completed calls only', critical: true, hint: 'the captured amount equals the sum of the successful calls; failed ones not charged' },
  { id: 'delivery', label: 'Delivery to the buyer recorded', critical: false, hint: 'a record that each completed call returned a response (e.g. a request/response hash)' },
  { id: 'settlement', label: 'Settlement record', critical: false, hint: 'the PayPal capture and any released remainder' },
];

/**
 * "Not as described" (PayPal reason MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED). PayPal's reasons-and-evidence table
 * asks for notes or documents (evidence type OTHER) such as the product description, the item URL and the return
 * policy, or a refund ID. What decides it is whether the item sent matches what the listing said.
 */
const NOT_AS_DESCRIBED: Requirement[] = [
  { id: 'description', label: 'Listing as the buyer saw it', critical: true, hint: 'the listing or product description in force when the buyer paid' },
  { id: 'match', label: 'Item sent matches the listing', critical: false, hint: 'a record of the very unit shipped (packing photo, measurement, batch) that matches the listing; catalogue photos alone do not show the unit sent' },
  { id: 'complaint', label: 'What the buyer says differs', critical: false, hint: 'the buyer’s own description of the difference, compared with the listing (a conflicting value: contradicts)' },
  { id: 'returns', label: 'Return policy', critical: false, hint: 'the return policy that applies to the order' },
  { id: 'payment', label: 'Order and payment for the disputed amount', critical: false, hint: 'an order or capture record whose amount equals the disputed amount' },
];

/**
 * "Unauthorised" (PayPal reason UNAUTHORISED): the buyer does not recognise the payment. PayPal's table takes proof
 * of fulfillment, a refund ID, or notes and documents (OTHER) such as proof of receipt. What decides it is whether
 * the account holder placed the order and received what it bought.
 */
const UNAUTHORISED: Requirement[] = [
  { id: 'account', label: 'Ordered from the buyer’s account', critical: true, hint: 'the order or booking record shows the payer’s own account, email or a device used before' },
  { id: 'delivered', label: 'Item delivered or booking used', critical: true, hint: 'a delivery, check-in or attendance record' },
  { id: 'history', label: 'Earlier undisputed purchases', critical: false, hint: 'a previous order by the same account, email or address that was not disputed' },
  { id: 'contact', label: 'Confirmation sent to the buyer', critical: false, hint: 'a confirmation or reminder sent to the payer’s email or phone' },
  { id: 'payment', label: 'Payment record for the disputed amount', critical: false, hint: 'a payment/capture record whose amount equals the disputed amount' },
];

/**
 * "Incorrect amount" (PayPal reason INCORRECT_AMOUNT): the buyer says the charge differs from what was agreed.
 * PayPal's table takes a refund ID for the difference, or notes and documents (OTHER) giving the reason for the
 * price difference. What decides it is the approved amount against what was actually captured.
 */
const INCORRECT_AMOUNT: Requirement[] = [
  { id: 'approved', label: 'Amount the buyer approved', critical: true, hint: 'the price, budget or mandate the buyer agreed to before paying' },
  { id: 'charged', label: 'Amount actually captured', critical: true, hint: 'the capture/settlement record with the amount taken' },
  { id: 'breakdown', label: 'Itemised breakdown of the charge', critical: true, hint: 'line items or per-call charges that add up to the captured amount' },
  { id: 'within', label: 'Capture within the approved amount', critical: false, hint: 'the captured amount does not exceed the approved amount (a capture above it: contradicts)' },
  { id: 'holds', label: 'Holds released, nothing taken twice', critical: false, hint: 'an authorization hold or remainder voided/released rather than captured' },
];

const GENERIC: Requirement[] = [
  { id: 'payment', label: 'Payment record for the disputed amount', critical: true, hint: 'a payment record whose amount equals the disputed amount' },
  { id: 'description', label: 'What was sold, as described', critical: false, hint: 'the order or listing describing the item or service' },
  { id: 'fulfilment', label: 'Proof of delivery or service', critical: true, hint: 'a record that the item or service was delivered' },
  { id: 'messages', label: 'Communication with the buyer', critical: false, hint: 'messages exchanged with the buyer about the issue' },
];

export function requirementsFor(d: Pick<DisputeContext, 'reason' | 'buyerItemType'>): { title: string; items: Requirement[] } {
  if (d.reason === 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED') {
    const physical = /physical|product|PRODUCT/i.test(d.buyerItemType);
    return physical
      ? { title: 'What "not received" disputes need', items: PHYSICAL_NOT_RECEIVED }
      : { title: 'What "not received" needs for a service', items: SERVICE_NOT_RECEIVED };
  }
  if (d.reason === 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED') return { title: 'What "not as described" disputes need', items: NOT_AS_DESCRIBED };
  if (d.reason === 'UNAUTHORISED') return { title: 'What "unauthorised payment" disputes need', items: UNAUTHORISED };
  if (d.reason === 'INCORRECT_AMOUNT') return { title: 'What "incorrect amount" disputes need', items: INCORRECT_AMOUNT };
  return { title: 'What this dispute needs', items: GENERIC };
}

export interface RecommendationInput {
  dispute: DisputeContext;
  checklist: readonly ChecklistItem[];
  sentences: readonly Sentence[];
}

/**
 * The action to recommend and the rule that chose it. Only actions PayPal allows now are ever recommended;
 * `null` when PayPal allows none of them.
 */
export function decideAction(x: RecommendationInput): { action: RecommendedAction; rule: string } | null {
  const allowed = (a: RecommendedAction) => x.dispute.allowedActions.includes(a);
  const supported = x.sentences.filter((s) => s.verdict === 'supported').length;
  const missingCritical = x.checklist.filter((i) => i.critical && i.status === 'missing');
  const requested = x.dispute.requestedEvidence;
  const option = requested ? x.dispute.evidenceOptions.find((o) => o.type === requested) : undefined;
  const canProve = !!requested && !!option?.satisfied;

  if (allowed('provide_evidence') && canProve && missingCritical.length === 0 && supported > 0) {
    return { action: 'provide_evidence', rule: `PayPal requests ${requested}; the case file has what it needs, no critical requirement is missing, and ${supported} sentence(s) are supported` };
  }
  if (missingCritical.length > 0) {
    const names = missingCritical.map((i) => i.label.toLowerCase()).join(', ');
    if (allowed('send_message')) return { action: 'send_message', rule: `Critical evidence is missing (${names}); ask or explain before deciding` };
    if (allowed('accept_claim')) return { action: 'accept_claim', rule: `Critical evidence is missing (${names}) and PayPal offers no message` };
  }
  if (allowed('provide_evidence') && requested && !canProve && allowed('send_message')) {
    return { action: 'send_message', rule: `PayPal requests ${requested}, which the case file cannot satisfy` };
  }
  if (allowed('provide_evidence') && supported > 0) return { action: 'provide_evidence', rule: `${supported} supported sentence(s); PayPal allows providing evidence` };
  if (allowed('send_message')) {
    return { action: 'send_message', rule: supported > 0 ? 'PayPal does not take evidence now; a message is the way to add to the case' : 'No supported defence yet' };
  }
  if (allowed('accept_claim')) return { action: 'accept_claim', rule: 'No supported defence and no other action allowed' };
  return null;
}

export const ACTION_TITLE: Record<RecommendedAction, string> = {
  provide_evidence: 'Recommended: Provide evidence.',
  send_message: 'Recommended: Send a message.',
  accept_claim: 'Recommended: Accept the claim.',
  make_offer: 'Recommended: Make an offer.',
};
