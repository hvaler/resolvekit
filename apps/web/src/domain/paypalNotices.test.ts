import { describe, expect, it } from 'vitest';
import { fetchNotices, noticeAge, noticeText, type PayPalNotice } from './paypalNotices';

const notice = (over: Partial<PayPalNotice> = {}): PayPalNotice => ({
  eventId: 'WH-1',
  eventType: 'CUSTOMER.DISPUTE.CREATED',
  disputeId: 'PP-R-ABC-123',
  caseId: null,
  status: 'WAITING_FOR_SELLER_RESPONSE',
  reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
  amount: { value: '24.50', currency: 'USD' },
  at: '2026-10-13T10:00:00Z',
  ...over,
});

describe('PayPal notices', () => {
  it('reads as a line: event, dispute, amount, reason and PayPal’s own status', () => {
    expect(noticeText(notice())).toBe('New dispute PP-R-ABC-123 · 24.50 USD · merchandise or service not as described · PayPal: waiting for seller response');
    expect(noticeText(notice({ eventType: 'CUSTOMER.DISPUTE.RESOLVED', amount: null, reason: null, status: 'RESOLVED' }))).toBe('Dispute resolved PP-R-ABC-123 · PayPal: resolved');
  });

  it('a dispute that became a case says which order it came from', () => {
    expect(noticeText(notice({ caseId: 'PP-R-ABC-123', orderRef: 'rk-std-a1' }))).toBe(
      'New dispute PP-R-ABC-123 · 24.50 USD · merchandise or service not as described · PayPal: waiting for seller response · case created from order rk-std-a1',
    );
    expect(noticeText(notice({ amount: null, reason: null, status: null, orderRef: 'rk-stl-b2' }))).toBe('New dispute PP-R-ABC-123 · case created from order rk-stl-b2');
    expect(noticeText(notice())).not.toContain('case created from order');
  });

  it('says how long ago', () => {
    const at = Date.parse('2026-10-13T10:00:00Z');
    expect(noticeAge(notice(), at + 20_000)).toBe('just now');
    expect(noticeAge(notice(), at + 5 * 60_000)).toBe('5 min ago');
    expect(noticeAge(notice(), at + 130 * 60_000)).toBe('2 h ago');
  });

  it('a server without notices (or an error) is an empty list', async () => {
    const ok = (async () => new Response(JSON.stringify({ notices: [notice()] }), { status: 200 })) as typeof fetch;
    expect(await fetchNotices(ok)).toHaveLength(1);
    const no = (async () => new Response('{"error":"NOT_FOUND"}', { status: 404 })) as typeof fetch;
    expect(await fetchNotices(no)).toEqual([]);
  });
});
