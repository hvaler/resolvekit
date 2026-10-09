import type { DisputeSnapshot, RecordedEvidence } from './types';

/**
 * Evidence the merchant submitted, as PayPal reports it. A real dispute also lists the buyer's own entry
 * (CREATE, SUBMITTED_BY_BUYER) and what PayPal requests (REQUESTED_FROM_SELLER); neither is the merchant's
 * evidence. When PayPal reports `action_info.action`, it must be PROVIDE_EVIDENCE.
 */
export function isSellerSubmission(e: RecordedEvidence): boolean {
  return e.source === 'SUBMITTED_BY_SELLER' && (e.action == null || e.action === 'PROVIDE_EVIDENCE');
}

export function sellerEvidence(s: DisputeSnapshot): RecordedEvidence[] {
  return s.evidences.filter(isSellerSubmission);
}

/** PayPal shows evidence submitted by the seller on this dispute. */
export function hasSellerEvidence(s: DisputeSnapshot): boolean {
  return s.evidences.some(isSellerSubmission);
}

const key = (e: RecordedEvidence) => JSON.stringify([e.source, e.action ?? null, e.evidenceType, e.date ?? e.storedAt, e.tracking, [...e.files].sort(), e.notes]);

/**
 * Seller evidence that PayPal shows now and did not show in `before` (the dispute as read before sending).
 * Only this can be reported as "recorded": evidence already on the dispute is not proof of this submission.
 * Returns the latest such entry, or null.
 */
export function newSellerEvidence(after: DisputeSnapshot, before: DisputeSnapshot): RecordedEvidence | null {
  const seen = new Set(sellerEvidence(before).map(key));
  const fresh = sellerEvidence(after).filter((e) => !seen.has(key(e)));
  return fresh.length ? (fresh[fresh.length - 1] ?? null) : null;
}
