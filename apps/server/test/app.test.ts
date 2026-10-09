import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PayPalClient } from '@resolvekit/paypal';
import { createApp, DEFAULT_ORIGINS, TOKEN_HEADER } from '../src/app.ts';
import { fakePayPal, waitingDispute } from './fixtures.ts';

const CASE = 'PP-R-TVH-10190665';
const REAL = 'PP-R-REAL-1';
const TOKEN = 'a'.repeat(64);
const BASE = 'http://127.0.0.1:8787';

function setup(replies: Parameters<typeof fakePayPal>[0] = [], o: { configured?: boolean } = {}) {
  const pp = fakePayPal(replies);
  const lines: string[] = [];
  const paypal = o.configured === false ? null : new PayPalClient({ clientId: 'cid', clientSecret: 'super-secret-value', env: 'sandbox', fetch: pp.fetch });
  const app = createApp({
    paypal,
    env: 'sandbox',
    bindings: { [CASE]: REAL },
    now: () => new Date(Date.UTC(2026, 9, 9, 8, 0, 0)),
    log: (l) => lines.push(l),
    port: 8787,
    token: TOKEN,
    allowedOrigins: DEFAULT_ORIGINS,
  });
  return { pp, app, lines };
}

const get = (path: string, headers: Record<string, string> = {}) => new Request(BASE + path, { headers: { [TOKEN_HEADER]: TOKEN, ...headers } });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(BASE + path, {
    method: 'POST',
    headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json', origin: 'http://127.0.0.1:4173', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const submission = (over: Record<string, unknown> = {}) => ({
  disputeId: CASE,
  action: 'provide_evidence',
  evidenceType: 'PROOF_OF_FULFILLMENT',
  carrier: 'UPS',
  tracking: '1Z999AA10123456784',
  notes: 'Delivered and signed on 8 Oct 2026.',
  files: [
    { name: 'ups-tracking-1Z999AA10123456784.pdf', size: '112 KB' },
    { name: 'shipping-label-10482.pdf', size: '84 KB' },
  ],
  requestId: 'rk-req-abc123',
  ...over,
});

// ---------------------------------------------------------------------------------------------- guard

test('guard: a foreign Host (DNS rebinding) is refused on every route', async () => {
  const { app, pp } = setup();
  const r = await app(get('/api/health', { host: 'evil.example:8787' }));
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'FORBIDDEN_HOST');
  assert.equal(pp.calls.length, 0);
});

test('guard: a foreign Origin is refused', async () => {
  const { app, pp } = setup([{ status: 200, body: waitingDispute() }]);
  const r = await app(post(`/api/disputes/${CASE}/evidence`, submission(), { origin: 'https://evil.example' }));
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'FORBIDDEN_ORIGIN');
  assert.equal(pp.apiCalls().length, 0);
});

test('guard: a missing or wrong token is refused', async () => {
  const { app } = setup();
  const missing = await app(new Request(BASE + '/api/health'));
  assert.equal(missing.status, 401);
  const wrong = await app(get('/api/health', { [TOKEN_HEADER]: 'b'.repeat(64) }));
  assert.equal(wrong.status, 401);
});

test('guard: a text/plain POST (simple cross-site request) is refused with 415, nothing read or sent', async () => {
  const { app, pp } = setup([{ status: 200, body: waitingDispute() }]);
  const r = await app(post(`/api/disputes/${CASE}/evidence`, JSON.stringify(submission()), { 'content-type': 'text/plain' }));
  assert.equal(r.status, 415);
  assert.equal(pp.apiCalls().length, 0);
});

test('guard: the local web app through the proxy (localhost Host, local Origin, token) is allowed', async () => {
  const { app } = setup();
  const r = await app(get('/api/health', { host: 'localhost:8787', origin: 'http://localhost:5173' }));
  assert.equal(r.status, 200);
});

// ---------------------------------------------------------------------------------------------- health

test('health: sandbox after a lazy OAuth check, with the bound cases; no secret in the answer', async () => {
  const { app, pp } = setup();
  const r = await app(get('/api/health'));
  const text = await r.text();
  assert.deepEqual(JSON.parse(text), { paypal: 'sandbox', bound: [CASE], bindings: { [CASE]: { status: 'unchecked', reasons: [], checkedAt: null } } });
  assert.ok(!text.includes('super-secret-value') && !text.includes('tok'));
  assert.deepEqual(pp.calls.map((c) => c.path), ['/v1/oauth2/token']);
});

test('health: unconfigured without credentials, and when OAuth fails (error without secrets)', async () => {
  const none = await setup([], { configured: false }).app(get('/api/health'));
  assert.equal((await none.json()).paypal, 'unconfigured');
  const s = setup();
  s.pp.failOAuth();
  const text = await (await s.app(get('/api/health'))).text();
  const h = JSON.parse(text);
  assert.equal(h.paypal, 'unconfigured');
  assert.match(h.error, /OAuth failed \(401\)/);
  assert.ok(!text.includes('super-secret-value') && !text.includes('cid'));
  assert.deepEqual(h.bound, []);
});

// ---------------------------------------------------------------------------------------------- GET

test('GET maps the real dispute to a snapshot under the case id', async () => {
  const { app, pp } = setup([{ status: 200, body: waitingDispute() }]);
  const r = await app(get(`/api/disputes/${CASE}`));
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(pp.apiCalls()[0]!.path, `/v1/customer/disputes/${REAL}`);
  assert.equal(s.id, CASE);
  assert.deepEqual(s.origin, { kind: 'paypal', env: 'sandbox', disputeId: REAL });
  assert.equal(s.status, 'WAITING_FOR_SELLER_RESPONSE');
  assert.deepEqual(s.requestedEvidence, ['PROOF_OF_FULFILLMENT']);
  assert.ok(s.allowedActions.includes('provide_evidence'));
});

test('GET of an unbound case never calls PayPal', async () => {
  const { app, pp } = setup();
  const r = await app(get('/api/disputes/PP-R-MMC-10190702'));
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, 'NOT_BOUND');
  assert.equal(pp.calls.length, 0);
});

test('GET passes PayPal errors through with the issue code', async () => {
  const { app } = setup([{ status: 404, body: { name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'INVALID_RESOURCE_ID' }] } }]);
  const r = await app(get(`/api/disputes/${CASE}`));
  assert.equal(r.status, 404);
  assert.equal((await r.json()).paypalIssue, 'INVALID_RESOURCE_ID');
});

test('GET reports a PayPal timeout as 504', async () => {
  const err = new Error('The operation was aborted due to timeout');
  err.name = 'TimeoutError';
  const { app } = setup([err]);
  assert.equal((await app(get(`/api/disputes/${CASE}`))).status, 504);
});

// ---------------------------------------------------------------------------------------------- POST

test('POST evidence: a client-built submission (notes, files, tracking) is refused; nothing is read or sent (see intent.test.ts)', async () => {
  const { app, pp } = setup([{ status: 200, body: waitingDispute() }]);
  const r = await app(post(`/api/disputes/${CASE}/evidence`, submission()));
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'INVALID_SUBMISSION');
  assert.equal(pp.apiCalls().length, 0);
});

test('POST evidence for an unbound case never calls PayPal', async () => {
  const { app, pp } = setup();
  const r = await app(post('/api/disputes/PP-R-MMC-10190702/evidence', { intentId: 'int-' + '0'.repeat(24) }));
  assert.equal(r.status, 404);
  assert.equal(pp.calls.length, 0);
});
