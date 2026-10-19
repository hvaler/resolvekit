import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PayPalClient } from '../src/client.ts';
import { readFileSync } from 'node:fs';
import { chooseEvidenceType, requestedEvidence, SELLER_ACTIONS, sellerActions, type Dispute } from '../src/disputes.ts';

type Call = { url: string; init: RequestInit };

// Fake fetch: answers OAuth, then whatever the test queues, and records every call.
function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const fn = async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/v1/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400, scope: '' }), { status: 200 });
    }
    const next = responses.shift() ?? { status: 500, body: { name: 'NO_FAKE_RESPONSE' } };
    return new Response(JSON.stringify(next.body), { status: next.status });
  };
  return { fn: fn as typeof fetch, calls };
}

const client = (f: typeof fetch) => new PayPalClient({ clientId: 'id', clientSecret: 'secret', env: 'sandbox', fetch: f });

test('finds a dispute by capture with disputed_transaction_id (the plain list omits disputed_transactions)', async () => {
  const { fn, calls } = fakeFetch([{ status: 200, body: { items: [{ dispute_id: 'PP-R-1', status: 'WAITING_FOR_SELLER_RESPONSE' }] } }]);
  const d = await client(fn).disputes.findByCapture('CAP123');
  assert.equal(d?.dispute_id, 'PP-R-1');
  assert.match(calls[1].url, /\/v1\/customer\/disputes\?disputed_transaction_id=CAP123$/);
});

test('returns null when PayPal has not propagated the dispute yet', async () => {
  const { fn } = fakeFetch([{ status: 200, body: { items: [] } }]);
  assert.equal(await client(fn).disputes.findByCapture('CAP123'), null);
});

test('reads the evidence PayPal requests from the seller and the allowed actions', () => {
  const dispute = {
    status: 'WAITING_FOR_SELLER_RESPONSE',
    evidences: [
      { evidence_type: 'CREATE', source: 'SUBMITTED_BY_BUYER' },
      { evidence_type: 'PROOF_OF_FULFILLMENT', source: 'REQUESTED_FROM_SELLER' },
    ],
    links: [{ rel: 'self' }, { rel: 'provide_evidence' }, { rel: 'accept_claim' }],
  };
  assert.deepEqual(requestedEvidence(dispute), ['PROOF_OF_FULFILLMENT']);
  assert.deepEqual(sellerActions(dispute), ['provide_evidence', 'accept_claim']);
});

test('a just-created dispute under review exposes no seller actions', () => {
  assert.deepEqual(sellerActions({ status: 'UNDER_REVIEW', links: [{ rel: 'self' }] }), []);
});

test('sends proof of fulfillment when PayPal requests it, even for a service (verified 2026-10-08)', () => {
  assert.equal(chooseEvidenceType(['PROOF_OF_FULFILLMENT'], 'SERVICE'), 'PROOF_OF_FULFILLMENT');
  assert.equal(chooseEvidenceType([], 'SERVICE'), 'PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED');
  assert.equal(chooseEvidenceType([], 'PRODUCT'), 'PROOF_OF_FULFILLMENT');
});

test('provides evidence as multipart: JSON "input" part plus "evidence-file" parts', async () => {
  const { fn, calls } = fakeFetch([{ status: 200, body: { links: [] } }]);
  await client(fn).disputes.provideEvidence('PP-R-1', {
    evidence_type: 'PROOF_OF_FULFILLMENT',
    evidence_info: { tracking_info: [{ carrier_name: 'UPS', tracking_number: '1Z999AA10123456784' }] },
    notes: 'Delivered and signed.',
  }, [{ name: 'proof.pdf', type: 'application/pdf', data: new Uint8Array([37, 80, 68, 70]) }]);

  const call = calls[1];
  assert.match(call.url, /\/v1\/customer\/disputes\/PP-R-1\/provide-evidence$/);
  assert.equal(call.init.method, 'POST');
  const form = call.init.body as FormData;
  const input = JSON.parse(await (form.get('input') as Blob).text());
  assert.equal(input.evidences[0].evidence_type, 'PROOF_OF_FULFILLMENT');
  assert.equal((form.get('evidence-file') as File).name, 'proof.pdf');
  // The multipart boundary must come from fetch, so no explicit Content-Type header.
  assert.equal(new Headers(call.init.headers).get('content-type'), null);
  assert.ok(new Headers(call.init.headers).get('paypal-request-id'));
});

test('surfaces PayPal error details instead of hiding them', async () => {
  const { fn } = fakeFetch([{ status: 400, body: { name: 'INVALID_REQUEST', details: [{ issue: 'EVIDENCE_TYPE_IS_NOT_ALLOWED' }] } }]);
  await assert.rejects(
    client(fn).disputes.provideEvidence('PP-R-1', { evidence_type: 'PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED', notes: 'x' }, []),
    /400 INVALID_REQUEST.*EVIDENCE_TYPE_IS_NOT_ALLOWED/,
  );
});

test('uses the caller request id as PayPal-Request-Id so a retry of the same approval is not a new action', async () => {
  const { fn, calls } = fakeFetch([{ status: 200, body: {} }]);
  await client(fn).disputes.provideEvidence('PP-R-1', { evidence_type: 'PROOF_OF_FULFILLMENT', notes: 'x' }, [], { requestId: 'rk-req-abc123' });
  assert.equal(new Headers(calls[1].init.headers).get('paypal-request-id'), 'rk-req-abc123');
});

test('verifies credentials with an OAuth token only, without reading any dispute', async () => {
  const { fn, calls } = fakeFetch([]);
  await client(fn).verifyCredentials();
  assert.deepEqual(calls.map((c) => new URL(c.url).pathname), ['/v1/oauth2/token']);
});

test('a credentials failure is reported without the secret', async () => {
  const fn = (async () => new Response(JSON.stringify({ error: 'invalid_client', error_description: 'Client Authentication failed' }), { status: 401 })) as typeof fetch;
  await assert.rejects(client(fn).verifyCredentials(), (e: Error) => /401/.test(e.message) && !e.message.includes('secret'));
});

test('identity: starts a no-charge agreement token and reads the approving payer only once APPROVED', async () => {
  const approval = 'https://www.sandbox.paypal.com/agreements/approve?ba_token=BA-9BU79859F44918800';
  const { fn, calls } = fakeFetch([
    { status: 201, body: { token_id: 'BA-9BU79859F44918800', links: [{ rel: 'approval_url', href: approval }] } },
    { status: 200, body: { token_id: 'BA-9BU79859F44918800', token_status: 'PENDING' } },
    { status: 200, body: { token_id: 'BA-9BU79859F44918800', token_status: 'APPROVED', payer_info: { payer_id: 'SELLER123', email: 's@example.com', first_name: 'John', last_name: 'Doe', country_code: 'ES' } } },
  ]);
  const c = client(fn);
  const t = await c.identity.start({ returnUrl: 'https://app.example/r', cancelUrl: 'https://app.example/c', description: 'confirm' });
  assert.deepEqual(t, { tokenId: 'BA-9BU79859F44918800', approvalUrl: approval });
  const body = JSON.parse(String(calls[1].init.body));
  assert.equal(body.plan.type, 'MERCHANT_INITIATED_BILLING');
  assert.equal(body.plan.merchant_preferences.return_url, 'https://app.example/r');
  assert.equal((await c.identity.read(t.tokenId)).payer, null);
  const approved = await c.identity.read(t.tokenId);
  assert.equal(approved.status, 'APPROVED');
  assert.equal(approved.payer?.payerId, 'SELLER123');
  assert.match(calls[3].url, /\/v1\/billing-agreements\/agreement-tokens\/BA-9BU79859F44918800$/);
  // Only POSTs to start: reading never creates an agreement.
  assert.equal(calls.filter((x) => x.init.method === 'POST' && !x.url.endsWith('/oauth2/token')).length, 1);
});

test('identity: a malformed token id is refused before any request', async () => {
  const { fn, calls } = fakeFetch([]);
  await assert.rejects(client(fn).identity.read('BA-1/../../v1/x'), /not an agreement token id/);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Dispute actions (B0): fakes are the recorded sandbox reads in contracts/reads/.

const readContract = (f: string): Dispute => JSON.parse(readFileSync(new URL(`../contracts/${f}`, import.meta.url), 'utf8')) as Dispute;
const KHH = readContract('reads/inquiry-waiting-seller-KHH.json');
const OK = { status: 200, body: { links: KHH.links } };

test('send-message honours the contract’s format and the intent’s Request-Id', async () => {
  const { fn, calls } = fakeFetch([OK, OK, OK]);
  const c = client(fn);
  await c.disputes.sendMessage('PP-R-KHH-10193360', 'Hello', null, { requestId: 'rk-int-1', format: 'json' });
  const j = calls[1]!;
  assert.match(j.url, /\/v1\/customer\/disputes\/PP-R-KHH-10193360\/send-message$/);
  assert.equal(j.init.method, 'POST');
  assert.equal(j.init.body, '{"message":"Hello"}');
  assert.equal(new Headers(j.init.headers).get('content-type'), 'application/json');
  assert.equal(new Headers(j.init.headers).get('paypal-request-id'), 'rk-int-1');

  await c.disputes.sendMessage('PP-R-KHH-10193360', 'Hello', null, { requestId: 'rk-int-1', format: 'multipart' });
  const m = calls[2]!;
  const form = m.init.body as FormData;
  assert.ok(form instanceof FormData);
  assert.deepEqual(JSON.parse(await (form.get('input') as Blob).text()), { message: 'Hello' });
  assert.equal(form.get('message_document'), null);
  assert.equal(new Headers(m.init.headers).get('content-type'), null);
  assert.equal(new Headers(m.init.headers).get('paypal-request-id'), 'rk-int-1');

  // A file goes only as multipart, in the part the schema names (message_document).
  await c.disputes.sendMessage('PP-R-KHH-10193360', 'See the label', { name: 'label.pdf', type: 'application/pdf', data: new Uint8Array([37, 80, 68, 70]) }, { requestId: 'rk-int-2', format: 'multipart' });
  assert.equal(((calls[3]!.init.body as FormData).get('message_document') as File).name, 'label.pdf');
  await assert.rejects(
    c.disputes.sendMessage('PP-R-KHH-10193360', 'x', { name: 'a.pdf', type: 'application/pdf', data: new Uint8Array([1]) }, { requestId: 'rk-int-3', format: 'json' }),
    /multipart/,
  );
  assert.equal(calls.length, 4);
});

test('accept/offer/escalate/appeal post to their routes with the bodies given', async () => {
  const { fn, calls } = fakeFetch([OK, OK, OK, OK, OK]);
  const c = client(fn).disputes;
  const id = 'PP-R-KHH-10193360';
  const accept = { note: 'Refunding in full.', accept_claim_type: 'REFUND' };
  const offer = { note: 'Partial refund offered.', offer_type: 'REFUND', offer_amount: { currency_code: 'USD', value: '1.00' } };
  await c.acceptClaim(id, accept, { requestId: 'rk-a', format: 'json' });
  await c.makeOffer(id, offer, { requestId: 'rk-o', format: 'json' });
  await c.escalate(id, 'Escalating to PayPal.', { requestId: 'rk-e', format: 'json' });
  await c.appeal(id, { evidence_type: 'PROOF_OF_FULFILLMENT', notes: 'Delivered.' }, [{ name: 'pod.pdf', type: 'application/pdf', data: new Uint8Array([37]) }], { requestId: 'rk-p', format: 'multipart' });
  await c.acceptClaim(id, accept, { requestId: 'rk-a2', format: 'multipart' });

  const api = calls.slice(1);
  assert.deepEqual(api.map((x) => [new URL(x.url).pathname, x.init.method, new Headers(x.init.headers).get('paypal-request-id')]), [
    [`/v1/customer/disputes/${id}/accept-claim`, 'POST', 'rk-a'],
    [`/v1/customer/disputes/${id}/make-offer`, 'POST', 'rk-o'],
    [`/v1/customer/disputes/${id}/escalate`, 'POST', 'rk-e'],
    [`/v1/customer/disputes/${id}/appeal`, 'POST', 'rk-p'],
    [`/v1/customer/disputes/${id}/accept-claim`, 'POST', 'rk-a2'],
  ]);
  assert.deepEqual(JSON.parse(String(api[0]!.init.body)), accept);
  assert.deepEqual(JSON.parse(String(api[1]!.init.body)), offer);
  assert.deepEqual(JSON.parse(String(api[2]!.init.body)), { note: 'Escalating to PayPal.' });
  const appeal = api[3]!.init.body as FormData;
  assert.deepEqual(JSON.parse(await (appeal.get('input') as Blob).text()), { evidences: [{ evidence_type: 'PROOF_OF_FULFILLMENT', notes: 'Delivered.' }] });
  assert.equal((appeal.get('evidence-file') as File).name, 'pod.pdf');
  assert.deepEqual(JSON.parse(await ((api[4]!.init.body as FormData).get('input') as Blob).text()), accept);
  // Appeal has no JSON contract (the guide's example is multipart only): refused before any request.
  await assert.rejects(c.appeal(id, { evidence_type: 'OTHER', notes: 'x' }, [], { requestId: 'rk-p2', format: 'json' }), /multipart/);
  assert.equal(calls.length, 6);
});

test('appeal is a seller action when PayPal links it; the recorded reads link it nowhere yet', () => {
  assert.ok(SELLER_ACTIONS.includes('appeal'));
  assert.ok(!sellerActions(KHH).includes('appeal'));
  assert.deepEqual(sellerActions({ links: [{ rel: 'appeal' }] }), ['appeal']);
});
