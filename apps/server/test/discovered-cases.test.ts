/**
 * Discovered cases wired into the server (docs/09-DISENO-DESCUBRIMIENTO.md, decisions 3–8, 14, 16, 17): a webhook (or
 * the owner's scan) makes a new dispute its own case, bound to its one dispute, visible like a bound fixed case,
 * checked at send time against the template's payment and the stored capture, never rotated. Fake PayPal only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DailyCounters } from '@resolvekit/hosting';
import { SETTLEMENT_CASE_ID, caseInput, discoveredCaseFile, standardCase } from '@resolvekit/cases';
import { PayPalClient, type Capture, type Dispute, type WebhookEvent } from '@resolvekit/paypal';
import { createApi, TOKEN_HEADER } from '../src/app.ts';
import { isBoundDispute, type Binding } from '../src/bindings.ts';
import { CaseStore, bindDiscovered, type DiscoveredCase } from '../src/caseStore.ts';
import { createDiscovery } from '../src/discovery.ts';
import { createHostedApp } from '../src/hosted.ts';
import { toSnapshot } from '../src/mapping.ts';
import { evidenceInDispute } from './fixtures.ts';
import { RESOLVED, SELLER_ID, STD_CAPTURE, TEST_SECRET, analystFor, standardDispute, testAccounts } from './kit.ts';

const ORIGIN = 'https://rk.example.com';
const HOST = 'rk.example.com';
const CASE = standardCase.summary.id;
const BOUND = 'PP-R-REAL-1';
const DISC = 'PP-R-DSC-20001';
const DISC_CAPTURE = '5AB12345CD678901E';
const STL = 'PP-R-DSC-20002';
const STL_CAPTURE = '6AB12345CD678901E';
const KEY = 'k'.repeat(16) + '0123456789abcdef0123';
const IN_3_DAYS = () => new Date(Date.now() + 3 * 86_400_000).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A new "not received" dispute of the evaluation seller, on its own capture, waiting for the seller. */
function newDispute(id: string, capture: string, over: Partial<Dispute> = {}): Dispute {
  const d = standardDispute();
  return {
    ...d,
    dispute_id: id,
    seller_response_due_date: IN_3_DAYS(),
    disputed_transactions: [{ ...d.disputed_transactions![0]!, seller_transaction_id: capture }],
    ...over,
  };
}

const captureOf = (id: string, invoice: string): Capture => ({ id, status: 'COMPLETED', amount: { currency_code: 'USD', value: '7.00' }, invoice_id: invoice });

/** PayPal: disputes and captures by id (both mutable), evidence sends recorded, every call recorded. */
function fakePayPal() {
  const calls: string[] = [];
  const sends: unknown[] = [];
  const disputes: Record<string, Dispute> = {
    [BOUND]: { ...standardDispute(), dispute_id: BOUND },
    [DISC]: newDispute(DISC, DISC_CAPTURE),
    [STL]: newDispute(STL, STL_CAPTURE),
  };
  const captures: Record<string, Capture> = { [DISC_CAPTURE]: captureOf(DISC_CAPTURE, 'rk-std-t1'), [STL_CAPTURE]: captureOf(STL_CAPTURE, 'rk-stl-t2') };
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
    calls.push(`${init.method ?? 'GET'} ${u.pathname}`);
    if (u.pathname === '/v1/notifications/verify-webhook-signature') return new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 });
    if (u.pathname.endsWith('/provide-evidence')) {
      sends.push(init);
      return new Response(JSON.stringify({ links: [] }), { status: 200 });
    }
    const id = decodeURIComponent(u.pathname.split('/').pop()!);
    const found = u.pathname.startsWith('/v2/payments/captures/') ? captures[id] : disputes[id];
    return found ? new Response(JSON.stringify(found), { status: 200 }) : new Response('{"name":"RESOURCE_NOT_FOUND"}', { status: 404 });
  }) as typeof globalThis.fetch;
  const client = new PayPalClient({ clientId: 'cid', clientSecret: 'secret', env: 'sandbox', fetch });
  return { calls, sends, disputes, captures, client, reads: (id: string) => calls.filter((c) => c === `GET /v1/customer/disputes/${id}`).length };
}

/** A data dir for one test (removed after it). */
async function withDir(f: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'rk-discovered-'));
  try {
    await f(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const record = (caseId: string, captureId: string, template: DiscoveredCase['template'], orderRef: string): DiscoveredCase => ({
  caseId,
  merchantId: SELLER_ID,
  disputeId: caseId,
  captureId,
  template,
  orderRef,
  source: 'webhook',
  createdAt: new Date().toISOString(),
});

/** The hosted app over a data dir: the fixed standard case bound to BOUND, plus whatever the store already holds. */
function hosted(dir: string, o: { pp?: ReturnType<typeof fakePayPal>; seed?: DiscoveredCase[] } = {}) {
  const pp = o.pp ?? fakePayPal();
  const people = testAccounts();
  const lines: string[] = [];
  const store = new CaseStore({ file: join(dir, 'cases.json') });
  for (const c of o.seed ?? []) store.add(c);
  const bindings: Record<string, Binding> = { [CASE]: { dispute: BOUND, capture: STD_CAPTURE } };
  const reserve: Record<string, Binding[]> = {};
  const discovery = createDiscovery({ paypal: pp.client, store, anchor: () => SELLER_ID, isBound: (id) => isBoundDispute({ bindings, reserve }, id), log: (l) => lines.push(l) });
  const app = createHostedApp({
    paypal: pp.client,
    env: 'sandbox',
    bindings,
    reserve,
    caseStore: store,
    discovery,
    log: (l) => lines.push(l),
    counters: new DailyCounters({ file: null, limits: {} }),
    site: null,
    accounts: people.accounts,
    identity: null,
    sessionSecret: TEST_SECRET,
    origins: [ORIGIN],
    hosts: [HOST],
    https: true,
    webhook: { id: 'WEBHOOK0123456789', key: KEY },
    webhookReadWaitsMs: [0, 1, 1],
  });
  return { app, pp, people, lines, store, bindings };
}

let seq = 0;
/** The payload claims the dispute is RESOLVED: nothing in it is trusted, the dispute is read from PayPal. */
const eventOf = (type: string, disputeId: string): WebhookEvent =>
  ({ id: `WH-DISC${String(++seq).padStart(6, '0')}-ABCDEF`, event_type: type, create_time: '2026-11-06T10:00:00Z', resource_type: 'dispute', resource: { dispute_id: disputeId, status: 'RESOLVED', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' } }) as WebhookEvent;
const delivery = (type: string, disputeId: string) =>
  new Request(`${ORIGIN}/api/paypal/webhook/${KEY}`, {
    method: 'POST',
    headers: {
      host: HOST,
      'x-forwarded-for': '173.0.81.1',
      'content-type': 'application/json',
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42',
      'paypal-transmission-id': `tx-${seq}`,
      'paypal-transmission-sig': 'c2lnbmF0dXJl',
      'paypal-transmission-time': '2026-11-06T10:00:01Z',
    },
    body: JSON.stringify(eventOf(type, disputeId)),
  });
const get = (path: string, cookie?: string) => new Request(ORIGIN + path, { headers: { host: HOST, 'x-forwarded-for': '203.0.113.7', ...(cookie ? { cookie } : {}) } });
type Notice = { eventType: string; disputeId: string; caseId: string | null; orderRef?: string };
const notices = async (app: ReturnType<typeof hosted>['app'], cookie: string) => ((await (await app(get('/api/paypal/notices', cookie))).json()) as { notices: Notice[] }).notices;
const health = async (app: ReturnType<typeof hosted>['app'], cookie?: string) => (await (await app(get('/api/health', cookie))).json()) as { bound: string[] };
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200 && !(await check()); i++) await sleep(5);
}

test('webhook CREATED for an admissible unknown dispute: a case is made from the read, readable by the owner, the notice names the order; the same event again makes no second case', async () => {
  await withDir(async (dir) => {
    const { app, pp, people, store, bindings } = hosted(dir);
    assert.equal((await app(delivery('CUSTOMER.DISPUTE.CREATED', DISC))).status, 200);
    await until(async () => (await notices(app, people.ownerCookie)).length > 0);
    // Made from PayPal's read (WAITING_FOR_SELLER_RESPONSE), not the payload (RESOLVED); the capture read too.
    assert.equal(store.all().length, 1);
    assert.deepEqual({ ...store.get(DISC)!, createdAt: '' }, { ...record(DISC, DISC_CAPTURE, 'standard', 'rk-std-t1'), createdAt: '' });
    assert.ok(pp.calls.includes(`GET /v2/payments/captures/${DISC_CAPTURE}`));
    // One binding, never a reserve.
    assert.deepEqual(bindings[DISC], { dispute: DISC, capture: DISC_CAPTURE });
    const [n] = await notices(app, people.ownerCookie);
    assert.equal(n!.caseId, DISC);
    assert.equal(n!.orderRef, 'rk-std-t1');
    const r = await app(get(`/api/disputes/${DISC}`, people.ownerCookie));
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { origin: { disputeId: string } }).origin.disputeId, DISC);
    assert.ok((await health(app, people.ownerCookie)).bound.includes(DISC));

    assert.equal((await app(delivery('CUSTOMER.DISPUTE.CREATED', DISC))).status, 200);
    await until(async () => (await notices(app, people.ownerCookie)).length > 1);
    assert.equal(store.all().length, 1);
    const again = (await notices(app, people.ownerCookie))[0]!;
    assert.equal(again.caseId, DISC);
    assert.equal(again.orderRef, undefined);
  });
});

test('webhook data is never trusted: a dispute PayPal reads as another seller’s makes no case, whatever the event said', async () => {
  await withDir(async (dir) => {
    const pp = fakePayPal();
    pp.disputes[DISC] = newDispute(DISC, DISC_CAPTURE, { disputed_transactions: [{ ...newDispute(DISC, DISC_CAPTURE).disputed_transactions![0]!, seller: { merchant_id: 'SOMEONEELSE01' } }] });
    const { app, store, lines } = hosted(dir, { pp });
    await app(delivery('CUSTOMER.DISPUTE.CREATED', DISC));
    await until(() => lines.some((l) => l.includes(`dispute ${DISC} re-read`)));
    assert.equal(store.all().length, 0);
  });
});

test('webhook UPDATED: a dispute that arrived UNDER_REVIEW and now waits for the seller becomes a case', async () => {
  await withDir(async (dir) => {
    const pp = fakePayPal();
    pp.disputes[DISC] = newDispute(DISC, DISC_CAPTURE, { status: 'UNDER_REVIEW' });
    const { app, people, store } = hosted(dir, { pp });
    await app(delivery('CUSTOMER.DISPUTE.CREATED', DISC));
    await until(async () => (await notices(app, people.ownerCookie)).length > 0);
    assert.equal(store.all().length, 0);
    assert.equal((await notices(app, people.ownerCookie))[0]!.caseId, null);

    pp.disputes[DISC] = newDispute(DISC, DISC_CAPTURE);
    await app(delivery('CUSTOMER.DISPUTE.UPDATED', DISC));
    await until(async () => (await notices(app, people.ownerCookie)).length > 1);
    assert.equal(store.get(DISC)?.template, 'standard');
    const n = (await notices(app, people.ownerCookie))[0]!;
    assert.equal(n.eventType, 'CUSTOMER.DISPUTE.UPDATED');
    assert.equal(n.orderRef, 'rk-std-t1');
  });
});

test('concurrent webhook and scan create one case', async () => {
  await withDir(async (dir) => {
    const pp = fakePayPal();
    const store = new CaseStore({ file: join(dir, 'cases.json') });
    const bindings: Record<string, Binding> = { [CASE]: { dispute: BOUND, capture: STD_CAPTURE } };
    const discovery = createDiscovery({ paypal: pp.client, store, anchor: () => SELLER_ID, isBound: (id) => isBoundDispute({ bindings, reserve: {} }, id) });
    const api = createApi({ paypal: pp.client, env: 'sandbox', bindings, caseStore: store, discovery, webhookReadWaitsMs: [0] });
    const [, scan] = await Promise.all([api.paypalNotified(eventOf('CUSTOMER.DISPUTE.CREATED', DISC)), api.discover(await pp.client.disputes.get(DISC), 'scan')]);
    assert.equal(store.all().length, 1);
    assert.equal(Object.keys(bindings).filter((k) => bindings[k]!.dispute === DISC).length, 1);
    // Whichever came second was told why.
    const second = 'skipped' in scan ? scan.skipped : store.get(DISC)!.source === 'scan' ? 'scan won' : '?';
    assert.ok(['already bound', 'scan won'].includes(second), second);
  });
});

test('discovered case survives restart: a new app over the same data dir has it bound and visible', async () => {
  await withDir(async (dir) => {
    const first = hosted(dir);
    await first.app(delivery('CUSTOMER.DISPUTE.CREATED', DISC));
    await until(() => first.store.all().length > 0);
    const again = hosted(dir);
    assert.deepEqual(again.bindings[DISC], { dispute: DISC, capture: DISC_CAPTURE });
    assert.equal((await again.app(get(`/api/disputes/${DISC}`, again.people.ownerCookie))).status, 200);
    assert.ok((await health(again.app, again.people.ownerCookie)).bound.includes(DISC));
  });
});

test('visibility: owner, members and reviewers see a discovered standard case; a discovered settlement case is the owner’s only; another merchant and no session: 404', async () => {
  await withDir(async (dir) => {
    const { app, people } = hosted(dir, { seed: [record(DISC, DISC_CAPTURE, 'standard', 'rk-std-t1'), record(STL, STL_CAPTURE, 'settlement', 'rk-stl-t2')] });
    const owner = people.ownerCookie;
    const reviewer = people.member();
    const member = people.fullMember();
    for (const who of [owner, reviewer, member]) assert.equal((await app(get(`/api/disputes/${DISC}`, who))).status, 200);
    assert.equal((await app(get(`/api/disputes/${STL}`, owner))).status, 200);
    for (const who of [reviewer, member]) assert.equal((await app(get(`/api/disputes/${STL}`, who))).status, 404);
    for (const who of [people.outsider(), undefined]) {
      assert.equal((await app(get(`/api/disputes/${DISC}`, who))).status, 404);
      assert.equal((await app(get(`/api/disputes/${STL}`, who))).status, 404);
    }
    assert.deepEqual((await health(app, owner)).bound.sort(), [CASE, DISC, STL].sort());
    assert.deepEqual((await health(app, member)).bound.sort(), [CASE, DISC].sort());
    assert.deepEqual((await health(app, people.outsider())).bound, []);
    assert.deepEqual((await health(app)).bound, []);
    // The template itself (the fixed settlement case) is not what makes the discovered one visible.
    assert.notEqual(STL, SETTLEMENT_CASE_ID);
  });
});

test('readSellers does no disputes.get for discovered cases: their seller is the one stored', async () => {
  await withDir(async (dir) => {
    const { app, pp, people } = hosted(dir, { seed: [record(DISC, DISC_CAPTURE, 'standard', 'rk-std-t1')] });
    for (let i = 0; i < 3; i++) assert.ok((await health(app, people.ownerCookie)).bound.includes(DISC));
    assert.equal(pp.reads(DISC), 0);
    assert.ok(pp.reads(BOUND) >= 1);
  });
});

// ------------------------------------------------------------------------------------------- send time (local mode)

const BASE = 'http://127.0.0.1:8787';
const TOKEN = 'a'.repeat(64);
const post = (path: string, body: unknown) => new Request(BASE + path, { method: 'POST', headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const localGet = (path: string) => new Request(BASE + path, { headers: { [TOKEN_HEADER]: TOKEN } });

async function local(dir: string, o: { reserve?: Record<string, Binding[]>; rotateAfterMs?: number } = {}) {
  const pp = fakePayPal();
  const store = new CaseStore({ file: join(dir, 'cases.json') });
  store.add(record(DISC, DISC_CAPTURE, 'standard', 'rk-std-t1'));
  const input = caseInput(discoveredCaseFile('standard', DISC), { kind: 'live', snap: toSnapshot(pp.disputes[DISC]!, DISC, 'sandbox', new Date()), failed: null });
  const { analyst } = await analystFor([[CASE, input]]);
  const lines: string[] = [];
  const bindings: Record<string, Binding> = { [CASE]: { dispute: BOUND, capture: STD_CAPTURE } };
  const api = createApi({ paypal: pp.client, env: 'sandbox', bindings, ...(o.reserve ? { reserve: o.reserve } : {}), ...(o.rotateAfterMs !== undefined ? { rotateAfterMs: o.rotateAfterMs } : {}), caseStore: store, analyst, log: (l) => lines.push(l) });
  return { api, pp, bindings, lines, store };
}
const intentPath = `/api/disputes/${DISC}/intent`;

test('send-time check: a discovered standard case is composed, approved and sent against the template’s payment (7.00 USD) and its stored capture', async () => {
  await withDir(async (dir) => {
    const { api, pp } = await local(dir);
    const r = await api(post(intentPath, { evidenceType: 'PROOF_OF_FULFILLMENT', resolutions: RESOLVED }));
    assert.equal(r.status, 201, await r.clone().text());
    const i = (await r.json()) as { id: string; contentHash: string; disputeId: string };
    assert.equal(i.disputeId, DISC);
    assert.equal((await api(post(`${intentPath}/${i.id}/approve`, { contentHash: i.contentHash }))).status, 200);
    assert.equal((await api(post(`/api/disputes/${DISC}/evidence`, { intentId: i.id }))).status, 202);
    assert.equal(pp.sends.length, 1);
    assert.ok(pp.calls.includes(`POST /v1/customer/disputes/${DISC}/provide-evidence`));
  });
});

for (const [name, change] of [
  ['another capture', (d: Dispute): Dispute => ({ ...d, disputed_transactions: [{ ...d.disputed_transactions![0]!, seller_transaction_id: '9ZZ00000AA0000000' }] })],
  ['another amount', (d: Dispute): Dispute => ({ ...d, dispute_amount: { currency_code: 'USD', value: '6.00' } })],
] as const) {
  test(`send-time check: a discovered case whose dispute shows ${name} is BINDING_INVALID, as for a fixed case`, async () => {
    await withDir(async (dir) => {
      const { api, pp } = await local(dir);
      pp.disputes[DISC] = change(pp.disputes[DISC]!);
      const r = await api(post(intentPath, { evidenceType: 'PROOF_OF_FULFILLMENT', resolutions: RESOLVED }));
      assert.equal(r.status, 409);
      assert.equal(((await r.json()) as { error: string }).error, 'BINDING_INVALID');
      assert.equal(pp.sends.length, 0);
    });
  });
}

test('no rotation: a discovered case whose evidence PayPal recorded keeps its dispute and stays listed', async () => {
  await withDir(async (dir) => {
    // Even a reserve listed under its id (never made by the server) is not walked into.
    const { api, pp, bindings, lines } = await local(dir, { reserve: { [DISC]: [{ dispute: 'PP-R-DSC-29999', capture: '7AB12345CD678901E' }] }, rotateAfterMs: 0 });
    const used = evidenceInDispute();
    pp.disputes[DISC] = { ...used, dispute_id: DISC, dispute_amount: { currency_code: 'USD', value: '7.00' }, disputed_transactions: [{ ...used.disputed_transactions![0]!, seller_transaction_id: DISC_CAPTURE, gross_amount: { currency_code: 'USD', value: '7.00' }, seller: { merchant_id: SELLER_ID } }] };
    for (let k = 0; k < 2; k++) assert.equal((await api(localGet(`/api/disputes/${DISC}`))).status, 200);
    assert.deepEqual(bindings[DISC], { dispute: DISC, capture: DISC_CAPTURE });
    assert.ok(!lines.some((l) => l.startsWith(`reserve · case ${DISC}`)));
    const h = (await (await api(localGet('/api/health'))).json()) as { bound: string[] };
    assert.ok(h.bound.includes(DISC));
  });
});

// -------------------------------------------------------------------------------------------- bindings re-built

test('bindDiscovered: each stored case gets its one binding; a fixed binding or reserve holding the same dispute wins; never a reserve', () => {
  const fixed: Record<string, Binding> = { [CASE]: { dispute: BOUND, capture: STD_CAPTURE } };
  const reserve: Record<string, Binding[]> = { [CASE]: [{ dispute: 'PP-R-RES-1', capture: '8AB12345CD678901E' }] };
  const skipped = bindDiscovered({ bindings: fixed, reserve }, [
    record(DISC, DISC_CAPTURE, 'standard', 'rk-std-t1'),
    { ...record('PP-R-DUP-1', '9AB12345CD678901E', 'standard', 'rk-std-t3'), disputeId: BOUND },
    record('PP-R-RES-1', '8AB12345CD678901E', 'standard', 'rk-std-t4'),
  ]);
  assert.deepEqual(Object.keys(fixed).sort(), [CASE, DISC].sort());
  assert.deepEqual(fixed[DISC], { dispute: DISC, capture: DISC_CAPTURE });
  assert.deepEqual(fixed[CASE], { dispute: BOUND, capture: STD_CAPTURE });
  assert.deepEqual(Object.keys(reserve), [CASE]);
  assert.deepEqual(skipped.sort(), ['PP-R-DUP-1', 'PP-R-RES-1']);
});

test('regression: with fixed bindings only and an empty store, the API behaves as before (no discovery, no new binding)', async () => {
  await withDir(async (dir) => {
    const { app, people, store, bindings } = hosted(dir);
    assert.deepEqual(Object.keys(bindings), [CASE]);
    assert.deepEqual((await health(app, people.ownerCookie)).bound, [CASE]);
    assert.equal((await app(get(`/api/disputes/${DISC}`, people.ownerCookie))).status, 404);
    assert.equal(store.all().length, 0);
  });
});

// ------------------------------------------------------------------------- a fixed case's id is never a discovered one

test('a stored record under a fixed case’s id (discovery never makes one now) does not stop that fixed case’s reserve rotation', async () => {
  await withDir(async (dir) => {
    const pp = fakePayPal();
    const store = new CaseStore({ file: join(dir, 'cases.json') });
    store.add({ ...record(DISC, DISC_CAPTURE, 'standard', 'rk-std-t1'), caseId: CASE });
    const NEXT = 'PP-R-REAL-2';
    const usd = { currency_code: 'USD', value: '7.00' };
    const used = evidenceInDispute();
    pp.disputes[BOUND] = { ...used, dispute_id: BOUND, dispute_amount: usd, disputed_transactions: [{ ...used.disputed_transactions![0]!, seller_transaction_id: STD_CAPTURE, gross_amount: usd, seller: { merchant_id: SELLER_ID } }] };
    const bindings: Record<string, Binding> = { [CASE]: { dispute: BOUND, capture: STD_CAPTURE } };
    const lines: string[] = [];
    const api = createApi({ paypal: pp.client, env: 'sandbox', bindings, reserve: { [CASE]: [{ dispute: NEXT, capture: '3AB12345CD678901E' }] }, rotateAfterMs: 0, caseStore: store, log: (l) => lines.push(l) });
    assert.equal((await api(localGet(`/api/disputes/${CASE}`))).status, 200);
    assert.equal(bindings[CASE]!.dispute, NEXT, lines.join('\n'));
  });
});

// ------------------------------------------------------------------------------------------- notices (owner-only)

test('notices: a member or reviewer never receives the notice of a discovered settlement case; the owner does', async () => {
  await withDir(async (dir) => {
    const { app, people, store } = hosted(dir);
    assert.equal((await app(delivery('CUSTOMER.DISPUTE.CREATED', STL))).status, 200);
    await until(async () => (await notices(app, people.ownerCookie)).length > 0);
    assert.equal(store.get(STL)?.template, 'settlement');
    const own = await notices(app, people.ownerCookie);
    assert.deepEqual(own.map((n) => n.caseId), [STL]);
    for (const who of [people.fullMember(), people.member()]) assert.deepEqual(await notices(app, who), []);
    // Its UPDATED event (the case exists now): still the owner's only.
    await app(delivery('CUSTOMER.DISPUTE.UPDATED', STL));
    await until(async () => (await notices(app, people.ownerCookie)).length > 1);
    for (const who of [people.fullMember(), people.member()]) assert.deepEqual(await notices(app, who), []);
  });
});
