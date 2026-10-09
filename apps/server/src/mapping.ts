/**
 * PayPal dispute → the web app's DisputeSnapshot. Pure: no I/O, no clock (the read time is passed in). Codes stay
 * verbatim; personal data PayPal returns (buyer and seller emails, names, messages) is not copied.
 */
import { requestedEvidence, sellerActions, type Dispute, type Evidence, type PayPalEnv } from '@resolvekit/paypal';
import type { ActionCode, DisputeSnapshot, DisputeStatus, RecordedEvidence } from '../../web/src/domain/types.ts';
import { utcStamp } from '../../web/src/domain/time.ts';

const STATUSES: readonly DisputeStatus[] = ['OPEN', 'WAITING_FOR_BUYER_RESPONSE', 'WAITING_FOR_SELLER_RESPONSE', 'UNDER_REVIEW', 'RESOLVED', 'OTHER'];

export function mapStatus(s: string | undefined): DisputeStatus {
  return STATUSES.includes(s as DisputeStatus) ? (s as DisputeStatus) : 'OTHER';
}

export function mapEvidence(e: Evidence): RecordedEvidence {
  const t = e.evidence_info?.tracking_info?.[0];
  const date = e.date ?? null;
  return {
    evidenceType: e.evidence_type,
    source: e.source ?? 'UNKNOWN',
    action: e.action_info?.action ?? null,
    date,
    carrier: t?.carrier_name ?? '',
    tracking: t?.tracking_number ?? '',
    notes: e.notes ?? '',
    files: (e.documents ?? []).map((d) => d.name),
    storedAt: date && !Number.isNaN(Date.parse(date)) ? utcStamp(new Date(date)) : '',
  };
}

/**
 * @param caseId the web case the dispute is bound to: the snapshot keeps that id so the app updates the right case.
 */
export function toSnapshot(d: Dispute, caseId: string, env: PayPalEnv, readAt: Date): DisputeSnapshot {
  return {
    id: caseId,
    status: mapStatus(d.status),
    stage: d.dispute_life_cycle_stage ?? null,
    reason: d.reason ?? null,
    buyerItemType: d.disputed_transactions?.[0]?.items?.[0]?.item_type ?? null,
    allowedActions: sellerActions(d) as ActionCode[],
    requestedEvidence: requestedEvidence(d),
    evidences: (d.evidences ?? []).map(mapEvidence),
    respondBy: d.seller_response_due_date ?? null,
    amount: d.dispute_amount ? { value: d.dispute_amount.value, currency: d.dispute_amount.currency_code } : null,
    readAt: utcStamp(readAt),
    origin: { kind: 'paypal', env, disputeId: d.dispute_id ?? '' },
  };
}
