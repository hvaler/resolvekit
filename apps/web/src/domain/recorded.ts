import type { DisputeSnapshot, RecordedEvidence, TimelineItem } from './types';

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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const pad = (n: number) => String(n).padStart(2, '0');
/** "26 Sep 11:05" (UTC), the timeline's format for multi-day cases. */
function dayTime(iso: string): string | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * What happened at PayPal after the documents, from the dispute as read: the seller's evidence going in and the
 * outcome. Appended to the analyst's timeline (which is built from the documents only), labelled by who recorded it.
 */
export function payPalEvents(s: DisputeSnapshot, by: 'PayPal' | 'the simulator'): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const e of sellerEvidence(s)) {
    const t = e.date ? dayTime(e.date) : null;
    if (t) out.push({ kind: 'event', time: t, title: 'Evidence sent', sub: `${e.evidenceType} · recorded by ${by}`, tag: 'PP', evidenceId: null });
  }
  const closed = s.status === 'RESOLVED' && s.outcome?.closedAt ? dayTime(s.outcome.closedAt) : null;
  if (closed) out.push({ kind: 'event', time: closed, title: 'Dispute closed', sub: `${s.outcome!.code} · ${by}`, tag: 'PP', evidenceId: null });
  return out;
}
