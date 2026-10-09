/**
 * H2: a binding is verified on a fresh read right before an intent is composed and right before it is sent; a
 * dispute that is not exactly this case's payment, or that cannot be read, blocks the send (fail closed).
 * Fake PayPal only: nothing is sent anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PayPalClient, type Dispute } from '@resolvekit/paypal';
import { caseInput, standardCase } from '@resolvekit/cases';
import { createApi, TOKEN_HEADER } from '../src/app.ts';
import { verifyBinding, type Binding } from '../src/bindings.ts';
import { toSnapshot } from '../src/mapping.ts';
import { RESOLVED, STD_CAPTURE, analystFor, standardDispute } from './kit.ts';

const CASE = standardCase.summary.id;
const REAL = 'PP-R-REAL-1';
const TOKEN = 'a'.repeat(64);
const BASE = 'http://127.0.0.1:8787';
const EXPECTED = { value: standardCase.summary.amount, currency: standardCase.summary.currency, transactionId: standardCase.summary.transactionId };
const BOUND: Binding = { dispute: REAL, capture: STD_CAPTURE };
const tx0 = () => standardDispute().disputed_transactions![0]!;

const variants: Array<[string, Dispute]> = [
  ['a different amount', standardDispute({ dispute_amount: { currency_code: 'USD', value: '6.00' } })],
  ['the same amount but another capture', standardDispute({ disputed_transactions: [{ ...tx0(), seller_transaction_id: '9ZZ00000AA0000000' }] })],
  ['another currency', standardDispute({ dispute_amount: { currency_code: 'EUR', value: '7.00' } })],
  ['no disputed amount', standardDispute({ dispute_amount: undefined })],
  ['two disputed transactions', standardDispute({ disputed_transactions: [tx0(), { ...tx0(), seller_transaction_id: '9ZZ00000AA0000000' }] })],
  ['another dispute id', standardDispute({ dispute_id: 'PP-R-OTHER-9' })],
  ['a transaction of another gross amount', standardDispute({ disputed_transactions: [{ ...tx0(), gross_amount: { currency_code: 'USD', value: '70.00' } }] })],
];

test('verifyBinding: exactly this payment is verified; anything else (or missing) is invalid, with the reason', () => {
  assert.deepEqual(verifyBinding(EXPECTED, BOUND, standardDispute()), { status: 'verified', reasons: [] });
  for (const [name, d] of variants) {
    const c = verifyBinding(EXPECTED, BOUND, d);
    assert.equal(c.status, 'invalid', name);
    assert.ok(c.reasons.length > 0, name);
  }
  assert.match(verifyBinding(EXPECTED, BOUND, variants[0]![1]).reasons.join(), /6\.00 USD; this case’s order is 7\.00 USD/);
});

test('verifyBinding: the old string form (no capture) only passes when the dispute is about the case’s own capture record', () => {
  const legacy: Binding = { dispute: REAL, capture: null };
  const c = verifyBinding(EXPECTED, legacy, standardDispute());
  assert.equal(c.status, 'invalid');
  assert.match(c.reasons[0]!, /names no capture/);
  const own = standardDispute({ disputed_transactions: [{ ...tx0(), seller_transaction_id: EXPECTED.transactionId }] });
  assert.equal(verifyBinding(EXPECTED, legacy, own).status, 'verified');
});

// ------------------------------------------------------------------------------------------------ through the API

async function setup(o: { atCompose: () => Dispute; atSend?: () => Dispute; binding?: string | Binding }) {
  let phase: 'compose' | 'send' = 'compose';
  const sends: unknown[] = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
    if (u.pathname.endsWith('/provide-evidence')) {
      sends.push(init);
      return new Response(JSON.stringify({ links: [] }), { status: 200 });
    }
    const d = phase === 'compose' ? o.atCompose() : (o.atSend ?? o.atCompose)();
    if (!d) return new Response(JSON.stringify({ name: 'RESOURCE_NOT_FOUND' }), { status: 404 });
    return new Response(JSON.stringify(d), { status: 200 });
  }) as typeof globalThis.fetch;
  const input = caseInput(standardCase, { kind: 'live', snap: toSnapshot(standardDispute(), CASE, 'sandbox', new Date()), failed: null });
  const { analyst } = await analystFor([[CASE, input]]);
  const lines: string[] = [];
  const bindings: Record<string, string | Binding> = { [CASE]: o.binding ?? BOUND };
  const app = createApi({ paypal: new PayPalClient({ clientId: 'cid', clientSecret: 'secret', env: 'sandbox', fetch }), env: 'sandbox', bindings, analyst, log: (l) => lines.push(l) });
  return { app, sends, lines, bindings, toSend: () => void (phase = 'send') };
}
const post = (path: string, body: unknown) =>
  new Request(BASE + path, { method: 'POST', headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = (path: string) => new Request(BASE + path, { headers: { [TOKEN_HEADER]: TOKEN } });
const intentPath = `/api/disputes/${CASE}/intent`;

test('H2: the correct binding proceeds: compose, approve, send', async () => {
  const { app, sends } = await setup({ atCompose: () => standardDispute() });
  const r = await app(post(intentPath, { evidenceType: 'PROOF_OF_FULFILLMENT', resolutions: RESOLVED }));
  const i = (await r.json()) as { id: string; contentHash: string };
  assert.equal(r.status, 201);
  assert.equal((await app(post(`${intentPath}/${i.id}/approve`, { contentHash: i.contentHash }))).status, 200);
  assert.equal((await app(post(`/api/disputes/${CASE}/evidence`, { intentId: i.id }))).status, 202);
  assert.equal(sends.length, 1);
  const h = (await (await app(get('/api/health'))).json()) as { bindings: Record<string, { status: string }> };
  assert.equal(h.bindings[CASE]!.status, 'verified');
});

for (const [name, d] of variants.slice(0, 3)) {
  test(`H2: a binding to ${name} is refused at composition (409, with the reasons); provide-evidence is never called`, async () => {
    const { app, sends } = await setup({ atCompose: () => d });
    const r = await app(post(intentPath, { evidenceType: 'PROOF_OF_FULFILLMENT', resolutions: RESOLVED }));
    assert.equal(r.status, 409);
    const b = (await r.json()) as { error: string; reasons: string[] };
    assert.equal(b.error, 'BINDING_INVALID');
    assert.ok(b.reasons.length > 0);
    assert.equal(sends.length, 0);
  });

  test(`H2: a dispute that turns into ${name} after approval is refused at send time; provide-evidence is never called`, async () => {
    const { app, sends, toSend } = await setup({ atCompose: () => standardDispute(), atSend: () => d });
    const r = await app(post(intentPath, { evidenceType: 'PROOF_OF_FULFILLMENT', resolutions: RESOLVED }));
    const i = (await r.json()) as { id: string; contentHash: string };
    assert.equal((await app(post(`${intentPath}/${i.id}/approve`, { contentHash: i.contentHash }))).status, 200);
    toSend();
    const s = await app(post(`/api/disputes/${CASE}/evidence`, { intentId: i.id }));
    assert.equal(s.status, 409);
    assert.equal(((await s.json()) as { error: string }).error, 'BINDING_INVALID');
    assert.equal(sends.length, 0);
    const h = (await (await app(get('/api/health'))).json()) as { bindings: Record<string, { status: string; reasons: string[] }> };
    assert.equal(h.bindings[CASE]!.status, 'invalid');
  });
}

test('H2: an unreadable dispute blocks composing and sending (409 BINDING_UNAVAILABLE); provide-evidence is never called', async () => {
  let readable = true;
  const { app, sends, toSend } = await setup({ atCompose: () => standardDispute(), atSend: () => (readable ? standardDispute() : (null as unknown as Dispute)) });
  const r = await app(post(intentPath, { evidenceType: 'PROOF_OF_FULFILLMENT', resolutions: RESOLVED }));
  const i = (await r.json()) as { id: string; contentHash: string };
  assert.equal((await app(post(`${intentPath}/${i.id}/approve`, { contentHash: i.contentHash }))).status, 200);
  toSend();
  readable = false;
  const s = await app(post(`/api/disputes/${CASE}/evidence`, { intentId: i.id }));
  assert.equal(s.status, 409);
  assert.equal(((await s.json()) as { error: string }).error, 'BINDING_UNAVAILABLE');
  assert.equal(sends.length, 0);
  // Not invalidated: once PayPal can be read again (and the binding verifies), the same approved intent goes.
  readable = true;
  assert.equal((await app(post(`/api/disputes/${CASE}/evidence`, { intentId: i.id }))).status, 202);
  assert.equal(sends.length, 1);
});

test('H2: an old string binding (no capture) to a real sandbox payment cannot be sent; it can still be read', async () => {
  const { app, sends } = await setup({ atCompose: () => standardDispute(), binding: REAL });
  assert.equal((await app(get(`/api/disputes/${CASE}`))).status, 200);
  const r = await app(post(intentPath, { evidenceType: 'PROOF_OF_FULFILLMENT', resolutions: RESOLVED }));
  assert.equal(r.status, 409);
  assert.match(((await r.json()) as { reasons: string[] }).reasons.join(), /names no capture/);
  assert.equal(sends.length, 0);
});

test('H2: changing the bindings forgets prior verifications and invalidates open intents', async () => {
  const { app, bindings } = await setup({ atCompose: () => standardDispute() });
  const r = await app(post(intentPath, { evidenceType: 'PROOF_OF_FULFILLMENT', resolutions: RESOLVED }));
  const i = (await r.json()) as { id: string; contentHash: string };
  assert.equal((await app(post(`${intentPath}/${i.id}/approve`, { contentHash: i.contentHash }))).status, 200);
  const status = async () => ((await (await app(get('/api/health'))).json()) as { bindings: Record<string, { status: string }> }).bindings[CASE]!.status;
  assert.equal(await status(), 'verified');
  // What main.ts (file watch) and hosted mode do when the bindings change: change in place, then forget.
  bindings[CASE] = { dispute: REAL, capture: '9ZZ00000AA0000000' };
  app.forgetReads();
  assert.equal(await status(), 'unchecked');
  const s = await app(post(`/api/disputes/${CASE}/evidence`, { intentId: i.id }));
  assert.equal(s.status, 409);
  assert.equal(((await s.json()) as { error: string }).error, 'INTENT_INVALIDATED');
});
