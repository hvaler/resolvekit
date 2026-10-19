import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getOnly, parseArgs, redact } from '../scripts/contract-read.ts';

test('getOnly refuses every write before the network', async () => {
  const seen: string[] = [];
  const f = getOnly((async (u: string | URL, i: RequestInit = {}) => {
    seen.push(`${i.method ?? 'GET'} ${u}`);
    return new Response('{}');
  }) as typeof fetch);
  await f('https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-1', { method: 'GET' });
  await f('https://api-m.sandbox.paypal.com/v1/oauth2/token', { method: 'POST' });
  await assert.rejects(f('https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-1/send-message', { method: 'POST' }), /only GET reads are allowed/);
  assert.equal(seen.length, 2);
});

test('getOnly: no method is GET; every other method, and a token POST to another path or host, is refused', async () => {
  const seen: string[] = [];
  const f = getOnly((async (u: string | URL, i: RequestInit = {}) => {
    seen.push(`${i.method ?? 'GET'} ${u}`);
    return new Response('{}');
  }) as typeof fetch);
  await f('https://api-m.sandbox.paypal.com/v1/customer/disputes');
  await f(new URL('https://api-m.sandbox.paypal.com/v2/payments/refunds/R1'), { method: 'get' });
  for (const method of ['PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    await assert.rejects(f('https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-1', { method }), /only GET reads are allowed/);
  }
  await assert.rejects(f('https://api-m.sandbox.paypal.com/v1/oauth2/token/extra', { method: 'POST' }), /only GET reads are allowed/);
  await assert.rejects(f('https://evil.example/v1/oauth2/token', { method: 'POST' }), /only GET reads are allowed/);
  await assert.rejects(f('https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-1/accept-claim?x=/v1/oauth2/token', { method: 'POST' }), /only GET reads are allowed/);
  // A Request object carries its own method.
  await assert.rejects(f(new Request('https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-1/escalate', { method: 'POST' })), /only GET reads are allowed/);
  assert.equal(seen.length, 2);
});

test('getOnly: a GET Request passes; an unparseable URL and a token POST to the live host are refused; redirects are errors', async () => {
  const seen: Array<{ url: string; method: string; redirect: RequestRedirect | undefined }> = [];
  const f = getOnly((async (u: string | URL | Request, i: RequestInit = {}) => {
    seen.push({ url: u instanceof Request ? u.url : String(u), method: i.method ?? (u instanceof Request ? u.method : 'GET'), redirect: i.redirect });
    return new Response('{}');
  }) as typeof fetch);
  await f(new Request('https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-1', { method: 'GET' }));
  await f('https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-1', { redirect: 'follow' });
  await f('https://api-m.sandbox.paypal.com/v1/oauth2/token', { method: 'POST' });
  await assert.rejects(f('not a url'), /only GET reads are allowed/);
  await assert.rejects(f('https://api-m.paypal.com/v1/oauth2/token', { method: 'POST' }), /only GET reads are allowed/);
  assert.deepEqual(seen.map((s) => s.method), ['GET', 'GET', 'POST']);
  assert.ok(seen.every((s) => s.redirect === 'error'), JSON.stringify(seen));
});

const SELLER = 'SELLERMERCHANT1';
const dispute = () => ({
  dispute_id: 'PP-R-ABC-10000001',
  status: 'WAITING_FOR_SELLER_RESPONSE',
  disputed_transactions: [
    {
      seller_transaction_id: '59U14501KS700990K',
      buyer: { name: 'Jane Buyer', payer_id: 'BUYERPAYER1', email: 'jane@example.com' },
      seller: { merchant_id: SELLER, name: 'Test Store', email: 'store@example.com' },
      buyer_transaction_id: 'BUYERTXN1',
    },
  ],
  messages: [
    { posted_by: 'BUYER', time_posted: '2026-10-19T10:00:00.000Z', content: 'Where is my parcel? Call me on 555-0100.' },
    { posted_by: 'SELLER', time_posted: '2026-10-19T11:00:00.000Z', content: 'It was delivered on Monday.' },
  ],
  offer: { buyer_requested_amount: { currency_code: 'USD', value: '7.00' }, history: [{ offer_time: 't', actor: 'SELLER', event_type: 'PROPOSED', offer_type: 'REFUND' }] },
  evidences: [
    { evidence_type: 'OTHER', source: 'SUBMITTED_BY_BUYER', notes: 'I never got it, my address is 1 Main St', documents: [{ name: 'jane-photo.jpg' }] },
    { evidence_type: 'PROOF_OF_FULFILLMENT', source: 'SUBMITTED_BY_SELLER', notes: 'Tracking attached.', documents: [{ name: 'tracking.png' }] },
  ],
  extensions: { merchant_contacted_outcome: 'NO_RESPONSE', return_shipping_address: { address_line_1: '1 Main St', country_code: 'US' } },
  communication_details: { email: 'jane@example.com', note: 'please', time_posted: 't' },
  payer: { payer_id: SELLER },
  links: [{ rel: 'send_message', href: 'https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-ABC-10000001/send-message', method: 'POST' }],
});

test('redact drops names, emails, addresses and buyer message text; keeps sandbox ids', () => {
  const r = redact(dispute()) as ReturnType<typeof dispute>;
  const text = JSON.stringify(r);
  for (const leak of ['Jane', 'jane@', 'store@', 'Test Store', '1 Main St', 'BUYERPAYER1', '555-0100', 'Where is my parcel', 'jane-photo', 'please']) assert.ok(!text.includes(leak), `leaked ${leak}: ${text}`);
  // Ids and the shape stay.
  assert.equal(r.dispute_id, 'PP-R-ABC-10000001');
  assert.equal(r.disputed_transactions[0]!.seller_transaction_id, '59U14501KS700990K');
  assert.equal(r.disputed_transactions[0]!.seller.merchant_id, SELLER);
  assert.equal(r.disputed_transactions[0]!.buyer_transaction_id, 'BUYERTXN1');
  assert.equal(r.payer.payer_id, SELLER, "the seller's payer id is kept");
  assert.equal(r.links[0]!.href, 'https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-ABC-10000001/send-message');
  // Buyer text becomes its length; the seller's own text stays (it is the proof under test).
  assert.equal(r.messages[0]!.content, `<buyer message, ${dispute().messages[0]!.content.length} chars>`);
  assert.equal(r.messages[0]!.posted_by, 'BUYER');
  assert.equal(r.messages[0]!.time_posted, '2026-10-19T10:00:00.000Z');
  assert.equal(r.messages[1]!.content, 'It was delivered on Monday.');
  assert.equal(r.evidences[0]!.notes, `<buyer message, ${dispute().evidences[0]!.notes.length} chars>`);
  assert.equal(r.evidences[1]!.notes, 'Tracking attached.');
  assert.deepEqual(r.evidences[1]!.documents, [{}]);
  assert.equal(r.offer.history[0]!.actor, 'SELLER');
  assert.equal(r.extensions.merchant_contacted_outcome, 'NO_RESPONSE');
  assert.equal('return_shipping_address' in r.extensions, false);
  // The input is not changed.
  assert.equal(dispute().messages[0]!.content.startsWith('Where'), true);
});

test('redact: a list of summaries (no seller known) drops every payer id', () => {
  const r = redact({ items: [{ dispute_id: 'PP-R-1', buyer: { payer_id: 'X', name: 'N' } }], links: [] }) as { items: Array<{ dispute_id: string; buyer: object }> };
  assert.deepEqual(r.items[0], { dispute_id: 'PP-R-1', buyer: {} });
});

test('parseArgs: one of --list, --dispute PP-…, --refund <id>, and an optional --out', () => {
  assert.deepEqual(parseArgs(['--list']), { kind: 'list', out: null });
  assert.deepEqual(parseArgs(['--dispute', 'PP-R-ABC-10000001', '--out', 'x.json']), { kind: 'dispute', id: 'PP-R-ABC-10000001', out: 'x.json' });
  assert.deepEqual(parseArgs(['--refund', '1AB23456CD789012E']), { kind: 'refund', id: '1AB23456CD789012E', out: null });
  for (const bad of [[], ['--list', '--dispute', 'PP-R-1'], ['--dispute'], ['--dispute', 'nope/../x'], ['--refund', 'a/b'], ['--send-message']]) {
    assert.ok('error' in parseArgs(bad), JSON.stringify(bad));
  }
});
