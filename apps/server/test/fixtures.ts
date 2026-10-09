import type { Dispute } from '@resolvekit/paypal';

/** Shaped like a real sandbox read of a "not received" dispute (2026-10-09), personal data removed. */
export function waitingDispute(): Dispute {
  return {
    dispute_id: 'PP-R-REAL-1',
    create_time: '2026-10-08T19:31:23.864Z',
    status: 'WAITING_FOR_SELLER_RESPONSE',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    dispute_life_cycle_stage: 'INQUIRY',
    dispute_amount: { currency_code: 'USD', value: '1.37' },
    seller_response_due_date: '2026-10-28T19:31:23.864Z',
    disputed_transactions: [
      {
        seller_transaction_id: '4FT237453Y5353014',
        create_time: '2026-10-08T19:30:33.000Z',
        gross_amount: { currency_code: 'USD', value: '1.37' },
        items: [{ item_type: 'PRODUCT' }],
      },
    ],
    evidences: [
      { evidence_type: 'CREATE', notes: 'lorem', source: 'SUBMITTED_BY_BUYER', date: '2026-10-08T19:31:23.864Z' },
      { evidence_type: 'PROOF_OF_FULFILLMENT', source: 'REQUESTED_FROM_SELLER', date: '2026-10-08T19:34:53.797Z' },
    ],
    links: [{ rel: 'self' }, { rel: 'accept_claim' }, { rel: 'provide_evidence' }, { rel: 'send_message' }, { rel: 'escalate' }, { rel: 'make_offer' }],
  };
}

/**
 * The same dispute after the seller's evidence is in, as read in the sandbox (2026-10-09): waiting for the buyer,
 * no seller due date (PayPal stops returning it), a buyer due date, no REQUESTED_FROM_SELLER entry.
 */
export function evidenceInDispute(): Dispute {
  const d = waitingDispute();
  delete d.seller_response_due_date;
  return {
    ...d,
    status: 'WAITING_FOR_BUYER_RESPONSE',
    buyer_response_due_date: '2026-10-19T04:37:54.000Z',
    evidences: [
      d.evidences![0]!,
      { evidence_type: 'PROOF_OF_FULFILLMENT', source: 'SUBMITTED_BY_SELLER', date: '2026-10-09T04:37:54.098Z', action_info: { action: 'PROVIDE_EVIDENCE' } },
    ],
    links: [{ rel: 'self' }, { rel: 'accept_claim' }, { rel: 'send_message' }, { rel: 'escalate' }],
  };
}

type Reply = { status: number; body: unknown } | Error;

/** Fake PayPal: answers OAuth itself, then each API call from the queue, and records the calls. */
export function fakePayPal(replies: Reply[]) {
  const calls: Array<{ method: string; path: string; init: RequestInit }> = [];
  let oauth: { status: number; body: unknown } = { status: 200, body: { access_token: 'tok', expires_in: 32400 } };
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    calls.push({ method: init.method ?? 'GET', path: u.pathname + u.search, init });
    if (u.pathname === '/v1/oauth2/token') return new Response(JSON.stringify(oauth.body), { status: oauth.status });
    const next = replies.shift() ?? { status: 500, body: { name: 'NO_FAKE_REPLY' } };
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'paypal-debug-id': 'dbg123' } });
  }) as typeof globalThis.fetch;
  return {
    fetch,
    calls,
    apiCalls: () => calls.filter((c) => c.path !== '/v1/oauth2/token'),
    failOAuth: () => (oauth = { status: 401, body: { error: 'invalid_client', error_description: 'Client Authentication failed' } }),
  };
}
