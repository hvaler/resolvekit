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
  assert.deepEqual(JSON.parse(text), { paypal: 'sandbox', bound: [CASE] });
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

test('POST reads the dispute, sends multipart with server-built PDFs and the request id, answers 202 sent (never "recorded")', async () => {
  const { app, pp, lines } = setup([{ status: 200, body: waitingDispute() }, { status: 200, body: { links: [] } }]);
  const r = await app(post(`/api/disputes/${CASE}/evidence`, submission()));
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { sent: true });
  const [read, send] = pp.apiCalls();
  assert.equal(read!.method, 'GET');
  assert.equal(send!.path, `/v1/customer/disputes/${REAL}/provide-evidence`);
  assert.equal(new Headers(send!.init.headers).get('paypal-request-id'), 'rk-req-abc123');
  const form = send!.init.body as FormData;
  const input = JSON.parse(await (form.get('input') as Blob).text());
  assert.deepEqual(input.evidences[0], {
    evidence_type: 'PROOF_OF_FULFILLMENT',
    evidence_info: { tracking_info: [{ carrier_name: 'UPS', tracking_number: '1Z999AA10123456784' }] },
    notes: 'Delivered and signed on 8 Oct 2026.',
  });
  const files = form.getAll('evidence-file') as File[];
  assert.deepEqual(files.map((f) => f.name), ['ups-tracking-1Z999AA10123456784.pdf', 'shipping-label-10482.pdf']);
  assert.equal(files[0]!.type, 'application/pdf');
  assert.equal(Buffer.from(await files[0]!.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.ok(lines.every((l) => !l.includes('super-secret-value') && !l.includes('tok ')));
});

const rejects = async (name: string, over: Record<string, unknown>, dispute: object, status: number, error: string) =>
  test(`POST refuses ${name} (${error}) and sends nothing`, async () => {
    const { app, pp } = setup([{ status: 200, body: { ...waitingDispute(), ...dispute } }]);
    const r = await app(post(`/api/disputes/${CASE}/evidence`, submission(over)));
    assert.equal(r.status, status);
    assert.equal((await r.json()).error, error);
    assert.ok(pp.apiCalls().every((c) => c.method === 'GET'));
  });

await rejects('when provide_evidence is not allowed now', {}, { status: 'UNDER_REVIEW', links: [{ rel: 'self' }, { rel: 'send_message' }] }, 409, 'PROVIDE_EVIDENCE_NOT_ALLOWED');
await rejects('an evidence type PayPal is not requesting', { evidenceType: 'PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED' }, {}, 422, 'EVIDENCE_TYPE_NOT_REQUESTED');
await rejects('notes over 2000 characters', { notes: 'x'.repeat(2001) }, {}, 422, 'NOTES_TOO_LONG');
await rejects('proof of fulfillment without tracking', { tracking: '  ' }, {}, 422, 'TRACKING_REQUIRED');
await rejects('a file that is not a document of the case', { files: [{ name: 'invented.pdf', size: '1 KB' }] }, {}, 422, 'UNKNOWN_FILE');
await rejects('a malformed body', { files: 'nope' }, {}, 400, 'INVALID_SUBMISSION');
await rejects('a disputeId that differs from the URL', { disputeId: 'PP-R-OTHER-1' }, {}, 400, 'INVALID_SUBMISSION');

test('POST for an unbound case never calls PayPal', async () => {
  const { app, pp } = setup();
  const r = await app(post('/api/disputes/PP-R-MMC-10190702/evidence', submission({ disputeId: 'PP-R-MMC-10190702' })));
  assert.equal(r.status, 404);
  assert.equal(pp.calls.length, 0);
});

test('POST returns PayPal’s issue code when PayPal rejects the evidence', async () => {
  const { app } = setup([
    { status: 200, body: waitingDispute() },
    { status: 422, body: { name: 'UNPROCESSABLE_ENTITY', message: 'The requested action could not be performed.', details: [{ issue: 'EVIDENCE_TYPE_IS_NOT_ALLOWED' }] } },
  ]);
  const r = await app(post(`/api/disputes/${CASE}/evidence`, submission()));
  assert.equal(r.status, 422);
  const b = await r.json();
  assert.equal(b.paypalIssue, 'EVIDENCE_TYPE_IS_NOT_ALLOWED');
  assert.equal(b.debugId, 'dbg123');
  assert.equal(b.sent, undefined);
});
