/**
 * Checks on an evidence submission before anything goes to PayPal. Shape checks run on the request alone; the
 * dispute checks run on the dispute as just read from PayPal.
 */
import { chooseEvidenceType, requestedEvidence, sellerActions, type Dispute } from '@resolvekit/paypal';
import type { EvidenceSubmission } from '../../web/src/domain/types.ts';

export const NOTES_LIMIT = 2000;

export interface Problem {
  status: number;
  error: string;
  detail: string;
}

export type SubmissionRequest = EvidenceSubmission & { requestId: string };

const isStr = (v: unknown): v is string => typeof v === 'string';

/** Parse the JSON body; returns the submission or the first problem found. */
export function parseSubmission(body: unknown): SubmissionRequest | Problem {
  const b = body as Partial<SubmissionRequest> | null;
  const bad = (detail: string): Problem => ({ status: 400, error: 'INVALID_SUBMISSION', detail });
  if (!b || typeof b !== 'object') return bad('Body must be a JSON object');
  if (b.action !== 'provide_evidence') return bad('action must be provide_evidence');
  for (const k of ['evidenceType', 'carrier', 'tracking', 'notes', 'requestId'] as const) if (!isStr(b[k])) return bad(`${k} must be a string`);
  if (!/^[\w.:-]{1,64}$/.test(b.requestId!)) return bad('requestId must be 1-64 letters, digits, ".", ":", "_" or "-"');
  if (!Array.isArray(b.files) || !b.files.every((f) => f && isStr(f.name) && isStr(f.size))) return bad('files must be a list of { name, size }');
  if (b.files.length > 10) return bad('At most 10 files');
  return {
    disputeId: isStr(b.disputeId) ? b.disputeId : '',
    action: 'provide_evidence',
    evidenceType: b.evidenceType!,
    carrier: b.carrier!.trim(),
    tracking: b.tracking!.trim(),
    notes: b.notes!,
    files: b.files.map((f) => ({ name: f.name, size: f.size })),
    requestId: b.requestId!,
  };
}

export function isProblem(x: unknown): x is Problem {
  return !!x && typeof x === 'object' && 'error' in x && 'status' in x;
}

/** Rules that depend on the dispute as PayPal shows it right now. */
export function checkAgainstDispute(s: SubmissionRequest, d: Dispute): Problem | null {
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
