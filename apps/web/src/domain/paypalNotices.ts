/**
 * What PayPal's webhooks told the server about this merchant's disputes (`GET /api/paypal/notices`, hosted mode). Each
 * notice is a verified PayPal notification after which the server read the dispute again from PayPal: the status shown
 * is PayPal's, not the notification's.
 */
export interface PayPalNotice {
  eventId: string;
  eventType: string;
  disputeId: string;
  /** The demo case bound to the dispute, or null when no case is linked to it yet. */
  caseId: string | null;
  status: string | null;
  reason: string | null;
  amount: { value: string; currency: string } | null;
  at: string;
}

const EVENT_TEXT: Record<string, string> = {
  'CUSTOMER.DISPUTE.CREATED': 'New dispute',
  'CUSTOMER.DISPUTE.UPDATED': 'Dispute updated',
  'CUSTOMER.DISPUTE.RESOLVED': 'Dispute resolved',
};

const words = (s: string) => s.toLowerCase().replace(/_/g, ' ');

/** One line of the notices strip: "New dispute PP-R-… · 24.50 USD · merchandise or service not as described · waiting for seller response". */
export function noticeText(n: PayPalNotice): string {
  return [
    `${EVENT_TEXT[n.eventType] ?? words(n.eventType)} ${n.disputeId}`,
    n.amount ? `${n.amount.value} ${n.amount.currency}` : null,
    n.reason ? words(n.reason) : null,
    n.status ? `PayPal: ${words(n.status)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Minutes since the notice, as shown ("just now", "5 min ago", "2 h ago"). */
export function noticeAge(n: PayPalNotice, now: number): string {
  const min = Math.floor((now - Date.parse(n.at)) / 60_000);
  if (!Number.isFinite(min) || min < 1) return 'just now';
  return min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ago`;
}

export async function fetchNotices(fetchFn: typeof fetch = (...a) => globalThis.fetch(...a), base = '/api'): Promise<PayPalNotice[]> {
  const r = await fetchFn(`${base}/paypal/notices`, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) return [];
  const body = (await r.json()) as { notices?: PayPalNotice[] };
  return Array.isArray(body.notices) ? body.notices : [];
}
