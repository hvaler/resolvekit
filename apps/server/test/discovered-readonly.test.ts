/**
 * An ended discovered case is read-only (docs/09-DISENO-DESCUBRIMIENTO.md, lifecycle decision A), enforced by the
 * server: once it has ended (closed, seller evidence recorded, chargeback, past due), composing, approving, confirming,
 * sending and new uploads are refused with 409 CASE_ENDED; cancelling, acknowledging, reading back, the hold, the audit
 * trail and every read stay open (the read-back after the send that ended it still works). A send whose own fresh read
 * finds the case ended is refused the same way, before anything is POSTed. Fixed cases are unaffected. Fake PayPal only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseInput, discoveredCaseFile, standardCase } from '@resolvekit/cases';
import { PayPalClient, type Dispute } from '@resolvekit/paypal';
import { createApp, DEFAULT_ORIGINS, TOKEN_HEADER } from '../src/app.ts';
import type { Binding } from '../src/bindings.ts';
import { CaseStore, type DiscoveredCase } from '../src/caseStore.ts';
import { IntentStore } from '../src/intents.ts';
import { toSnapshot } from '../src/mapping.ts';
import { REAL, T0, TEST_CONTRACTS, TEST_RULES, actionPayPal, recordedDispute } from './actions-kit.ts';
import { RESOLVED, SELLER_ID, STD_CAPTURE, analystFor, standardDispute } from './kit.ts';

const CASE = standardCase.summary.id;
const DISC = 'PP-R-DSC-40001';
const DISC_CAPTURE = '5AB12345CD678901E';
const TOKEN = 'a'.repeat(64);
const BASE = 'http://127.0.0.1:8787';
const DAY = 86_400_000;
const TEXT = 'Your order shipped on 7 Oct; tracking 1Z999AA10123456784.';

const post = (path: string, body: unknown) =>
  new Request(BASE + path, { method: 'POST', headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json', origin: 'http://127.0.0.1:4173' }, body: JSON.stringify(body) });
const get = (path: string) => new Request(BASE + path, { headers: { [TOKEN_HEADER]: TOKEN } });
const upload = (caseId: string) =>
  new Request(`${BASE}/api/cases/${caseId}/uploads`, { method: 'POST', headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'image/png', 'x-upload-name': 'receipt.png', origin: 'http://127.0.0.1:4173' }, body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) });
const answer = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> });

/** The discovered case's dispute: the given read, re-bound to its own id, capture, 7.00 USD and the test seller. */
const rebound = (d: Dispute, due: number): Dispute => {
  const usd = { currency_code: 'USD', value: '7.00' };
  return {
    ...d,
    dispute_id: DISC,
    dispute_amount: usd,
    seller_response_due_date: new Date(due).toISOString(),
    disputed_transactions: [{ ...d.disputed_transactions![0]!, seller_transaction_id: DISC_CAPTURE, gross_amount: usd, seller: { merchant_id: SELLER_ID } }],
  };
};

const record = (createdAt: number): DiscoveredCase => ({
  caseId: DISC,
  merchantId: SELLER_ID,
  disputeId: DISC,
  captureId: DISC_CAPTURE,
  template: 'standard',
  orderRef: 'rk-std-r1',
  source: 'webhook',
  createdAt: new Date(createdAt).toISOString(),
});

async function withDir(f: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'rk-readonly-'));
  try {
    await f(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The local app on a movable clock: the fixed standard case bound to REAL and the discovered case DISC, both on the
 * recorded INQUIRY read (due 3 days after T0); the test-only action registry (a message can be sent).
 */
function actionsApp(dir: string) {
  const state = { t: T0, disputes: { [REAL]: { ...recordedDispute(), seller_response_due_date: new Date(T0 + 3 * DAY).toISOString() }, [DISC]: rebound(recordedDispute(), T0 + 3 * DAY) } as Record<string, Dispute> };
  const pp = actionPayPal({ dispute: (id) => state.disputes[id]! });
  const now = () => new Date(state.t);
  const store = new CaseStore({ file: join(dir, 'cases.json') });
  store.add(record(T0 - DAY));
  const bindings: Record<string, Binding> = { [CASE]: { dispute: REAL, capture: STD_CAPTURE } };
  const app = createApp({
    paypal: pp.client,
    env: 'sandbox',
    bindings,
    caseStore: store,
    now,
    port: 8787,
    token: TOKEN,
    allowedOrigins: DEFAULT_ORIGINS,
    intents: new IntentStore({ now }),
    actionRegistry: { contracts: TEST_CONTRACTS, rules: TEST_RULES },
  });
  return { app, pp, state, store };
}

const composeMessage = async (app: ReturnType<typeof createApp>, caseId = DISC) => answer(await app(post(`/api/disputes/${caseId}/intent`, { action: 'send_message', text: TEXT })));

test('ended discovered case: composing, approving, confirming, sending and new uploads are 409 CASE_ENDED; the read-back of the send that ended it, the hold, the audit trail and reads stay open', async () => {
  await withDir(async (dir) => {
    const { app, pp, state, store } = actionsApp(dir);
    // While open: a message is composed, approved and sent (held until read back).
    const c = await composeMessage(app);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const i = c.body as { id: string; contentHash: string };
    assert.equal((await app(post(`/api/disputes/${DISC}/intent/${i.id}/approve`, { contentHash: i.contentHash }))).status, 200);
    state.t += 1_000;
    const s = await answer(await app(post(`/api/disputes/${DISC}/send`, { intentId: i.id })));
    assert.equal(s.status, 202, JSON.stringify(s.body));
    // A second message, approved before the case ends (its send is refused below).
    const c2 = await composeMessage(app);
    // PayPal closes the dispute; the next read of the case sees it.
    state.disputes[DISC] = { ...state.disputes[DISC]!, status: 'RESOLVED', update_time: new Date(state.t).toISOString(), dispute_outcome: { outcome_code: 'RESOLVED_BUYER_FAVOUR' } };
    state.t += 2_000;
    assert.equal((await app(get(`/api/disputes/${DISC}`))).status, 200);
    assert.equal(store.get(DISC)!.endedBy, 'resolved');

    const ended = (r: { status: number; body: Record<string, unknown> }, what: string) => {
      assert.equal(r.status, 409, `${what}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, 'CASE_ENDED', what);
      assert.equal(r.body.detail, 'This case has ended (resolved); it is read-only', what);
    };
    ended(await composeMessage(app), 'compose an action');
    ended(await answer(await app(post(`/api/disputes/${DISC}/intent`, { evidenceType: 'PROOF_OF_FULFILLMENT', resolutions: RESOLVED }))), 'compose evidence');
    const i2 = c2.body as { id: string; contentHash: string };
    ended(await answer(await app(post(`/api/disputes/${DISC}/intent/${i2.id}/approve`, { contentHash: i2.contentHash }))), 'approve');
    ended(await answer(await app(post(`/api/disputes/${DISC}/intent/${i2.id}/confirm`, { terms: {} }))), 'confirm');
    ended(await answer(await app(post(`/api/disputes/${DISC}/send`, { intentId: i2.id }))), 'send');
    ended(await answer(await app(post(`/api/disputes/${DISC}/evidence`, { intentId: i2.id }))), 'evidence');
    ended(await answer(await app(upload(DISC))), 'new upload');
    assert.equal(pp.posts.length, 1);

    // Still open: the read-back of the send (it records what PayPal proves), the hold, the audit trail, the reads,
    // the uploads list, cancelling the unsent intent.
    const rb = await answer(await app(post(`/api/disputes/${DISC}/intent/${i.id}/readback`, {})));
    assert.equal(rb.status, 200, JSON.stringify(rb.body));
    assert.equal((await app(get(`/api/disputes/${DISC}/hold`))).status, 200);
    assert.equal((await app(get(`/api/disputes/${DISC}/audit`))).status, 200);
    assert.equal((await app(get(`/api/disputes/${DISC}`))).status, 200);
    assert.equal((await app(get(`/api/cases/${DISC}/uploads`))).status, 200);
    assert.equal((await app(post(`/api/disputes/${DISC}/intent/${i2.id}/cancel`, {}))).status, 200);
  });
});

test('ended discovered case: an action send whose own fresh read shows the due date passed is CASE_ENDED, nothing is POSTed', async () => {
  await withDir(async (dir) => {
    const { app, pp, state, store } = actionsApp(dir);
    const c = await composeMessage(app);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const i = c.body as { id: string; contentHash: string };
    assert.equal((await app(post(`/api/disputes/${DISC}/intent/${i.id}/approve`, { contentHash: i.contentHash }))).status, 200);
    // PayPal moved the due date into the past; this server's last read still says open, so only the send's read sees it.
    state.disputes[DISC] = { ...state.disputes[DISC]!, seller_response_due_date: new Date(state.t - 60_000).toISOString() };
    const s = await answer(await app(post(`/api/disputes/${DISC}/send`, { intentId: i.id })));
    assert.equal(s.status, 409, JSON.stringify(s.body));
    assert.equal(s.body.error, 'CASE_ENDED');
    assert.equal(s.body.detail, 'This case has ended (past-due); it is read-only');
    assert.equal(pp.posts.length, 0);
    assert.equal(store.get(DISC)!.endedBy, 'past-due');
  });
});

test('fixed case: the same past due date and close never answer CASE_ENDED (the lifecycle is the discovered cases’ only)', async () => {
  await withDir(async (dir) => {
    const { app, state } = actionsApp(dir);
    state.disputes[REAL] = { ...state.disputes[REAL]!, seller_response_due_date: new Date(state.t - 60_000).toISOString() };
    assert.equal((await app(get(`/api/disputes/${CASE}`))).status, 200);
    const c = await composeMessage(app, CASE);
    assert.notEqual(c.body.error, 'CASE_ENDED', JSON.stringify(c.body));
    assert.notEqual((await answer(await app(upload(CASE)))).body.error, 'CASE_ENDED');
    state.disputes[REAL] = { ...state.disputes[REAL]!, status: 'RESOLVED' };
    assert.equal((await app(get(`/api/disputes/${CASE}`))).status, 200);
    assert.notEqual((await composeMessage(app, CASE)).body.error, 'CASE_ENDED');
  });
});

// ------------------------------------------------------------------------------------------- evidence (sendIntent)

test('ended discovered case: an evidence send whose own fresh read shows the due date passed is CASE_ENDED, nothing is sent', async () => {
  await withDir(async (dir) => {
    const sends: string[] = [];
    const disputes: Record<string, Dispute> = {
      [DISC]: {
        ...standardDispute(),
        dispute_id: DISC,
        seller_response_due_date: new Date(Date.now() + 3 * DAY).toISOString(),
        disputed_transactions: [{ ...standardDispute().disputed_transactions![0]!, seller_transaction_id: DISC_CAPTURE }],
      },
    };
    const fetch = (async (url: string | URL, init: RequestInit = {}) => {
      const u = new URL(String(url));
      if (u.pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
      if ((init.method ?? 'GET') === 'POST') {
        sends.push(u.pathname);
        return new Response(JSON.stringify({ links: [] }), { status: 200 });
      }
      const found = disputes[decodeURIComponent(u.pathname.split('/').pop()!)];
      return found ? new Response(JSON.stringify(found), { status: 200 }) : new Response('{"name":"RESOURCE_NOT_FOUND"}', { status: 404 });
    }) as typeof globalThis.fetch;
    const paypal = new PayPalClient({ clientId: 'cid', clientSecret: 'secret', env: 'sandbox', fetch });
    const store = new CaseStore({ file: join(dir, 'cases.json') });
    store.add(record(Date.now() - DAY));
    const input = caseInput(discoveredCaseFile('standard', DISC), { kind: 'live', snap: toSnapshot(disputes[DISC]!, DISC, 'sandbox', new Date()), failed: null });
    const { analyst } = await analystFor([[CASE, input]]);
    const app = createApp({ paypal, env: 'sandbox', bindings: {}, caseStore: store, analyst, port: 8787, token: TOKEN, allowedOrigins: DEFAULT_ORIGINS });
    const r = await answer(await app(post(`/api/disputes/${DISC}/intent`, { evidenceType: 'PROOF_OF_FULFILLMENT', resolutions: RESOLVED })));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const i = r.body as { id: string; contentHash: string };
    assert.equal((await app(post(`/api/disputes/${DISC}/intent/${i.id}/approve`, { contentHash: i.contentHash }))).status, 200);
    disputes[DISC] = { ...disputes[DISC]!, seller_response_due_date: new Date(Date.now() - 60_000).toISOString() };
    const s = await answer(await app(post(`/api/disputes/${DISC}/evidence`, { intentId: i.id })));
    assert.equal(s.status, 409, JSON.stringify(s.body));
    assert.equal(s.body.error, 'CASE_ENDED');
    assert.deepEqual(sends, []);
  });
});
