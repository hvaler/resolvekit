/**
 * Checks on an evidence submission against the dispute as just read from PayPal, right before anything is sent. The
 * submission itself is never parsed from a client: it is a server-composed intent (see app.ts and domain/intent.ts).
 */
import { chooseEvidenceType, requestedEvidence, sellerActions, type Dispute } from '@resolvekit/paypal';
import type { EvidenceSubmission } from '../../web/src/domain/types.ts';

export const NOTES_LIMIT = 2000;

export interface Problem {
  status: number;
  error: string;
  detail: string;
}

/** Rules that depend on the dispute as PayPal shows it right now. */
export function checkAgainstDispute(s: EvidenceSubmission, d: Dispute): Problem | null {
  if (!sellerActions(d).includes('provide_evidence')) {
    return { status: 409, error: 'PROVIDE_EVIDENCE_NOT_ALLOWED', detail: `PayPal does not offer provide_evidence on this dispute now (status ${d.status ?? 'unknown'})` };
  }
  const requested = requestedEvidence(d);
  const expected = chooseEvidenceType(requested, d.disputed_transactions?.[0]?.items?.[0]?.item_type);
  if (requested.length > 0 && !requested.includes(s.evidenceType)) {
    return { status: 422, error: 'EVIDENCE_TYPE_NOT_REQUESTED', detail: `PayPal requests ${requested.join(', ')}; got ${s.evidenceType}. Send ${expected}.` };
  }
  if (s.notes.trim().length === 0) return { status: 422, error: 'NOTES_REQUIRED', detail: 'Notes must not be empty' };
  if (s.notes.length > NOTES_LIMIT) return { status: 422, error: 'NOTES_TOO_LONG', detail: `Notes are ${s.notes.length} characters; PayPal takes at most ${NOTES_LIMIT}` };
  if (s.evidenceType === 'PROOF_OF_FULFILLMENT' && (!s.tracking || !s.carrier)) {
    return { status: 422, error: 'TRACKING_REQUIRED', detail: 'Proof of fulfillment needs a carrier and a tracking number or reference' };
  }
  return null;
}
