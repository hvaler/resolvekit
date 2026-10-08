import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PayPalClient } from '../src/client.ts';
import { chooseEvidenceType, requestedEvidence, sellerActions } from '../src/disputes.ts';

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
