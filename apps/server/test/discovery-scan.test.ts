/**
 * The owner's scan (docs/09-DISENO-DESCUBRIMIENTO.md, decision 11): POST /api/discovery/scan lists the disputes that
 * require action, reads each in full and admits it. Owner only, one call per minute per workspace. Fake PayPal only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DailyCounters } from '@resolvekit/hosting';
import { standardCase } from '@resolvekit/cases';
import { PayPalClient, type Capture, type Dispute } from '@resolvekit/paypal';
import { createApi } from '../src/app.ts';
import { isBoundDispute, type Binding } from '../src/bindings.ts';
import { CaseStore } from '../src/caseStore.ts';
import { createDiscovery } from '../src/discovery.ts';
import { createHostedApp } from '../src/hosted.ts';
import { SELLER_ID, STD_CAPTURE, TEST_SECRET, standardDispute, testAccounts } from './kit.ts';

const ORIGIN = 'https://rk.example.com';
const HOST = 'rk.example.com';
const CASE = standardCase.summary.id;
const BOUND = 'PP-R-REAL-1';
const NEW = 'PP-R-SCAN-1';
const NEW_CAPTURE = '5AB12345CD678901E';
const FOREIGN = 'PP-R-SCAN-2';
const UNREADABLE = 'PP-R-SCAN-3';
const IN_3_DAYS = () => new Date(Date.now() + 3 * 86_400_000).toISOString();

function newDispute(id: string, capture: string, merchant = SELLER_ID): Dispute {
  const d = standardDispute();
  return {
    ...d,
    dispute_id: id,
    seller_response_due_date: IN_3_DAYS(),
    disputed_transactions: [{ ...d.disputed_transactions![0]!, seller_transaction_id: capture, seller: { merchant_id: merchant } }],
  };
}

function fakePayPal(o: { listFails?: boolean; listed?: string[] } = {}) {
  const disputes: Record<string, Dispute> = {
    [BOUND]: { ...standardDispute(), dispute_id: BOUND },
    [NEW]: newDispute(NEW, NEW_CAPTURE),
    [FOREIGN]: newDispute(FOREIGN, '6AB12345CD678901E', 'SOMEONEELSE01'),
  };
  const captures: Record<string, Capture> = { [NEW_CAPTURE]: { id: NEW_CAPTURE, status: 'COMPLETED', amount: { currency_code: 'USD', value: '7.00' }, invoice_id: 'rk-std-t1' } };
  const listed = o.listed ?? [BOUND, NEW, FOREIGN];
  const fetch = (async (url: string | URL) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
    if (u.pathname === '/v1/customer/disputes') {
      if (o.listFails) return new Response('{"name":"INTERNAL_SERVER_ERROR"}', { status: 500 });
      return new Response(JSON.stringify({ items: listed.map((id) => ({ dispute_id: id, status: 'WAITING_FOR_SELLER_RESPONSE' })) }), { status: 200 });
    }
    const id = decodeURIComponent(u.pathname.split('/').pop()!);
    const found = u.pathname.startsWith('/v2/payments/captures/') ? captures[id] : disputes[id];
    return found ? new Response(JSON.stringify(found), { status: 200 }) : new Response('{"name":"RESOURCE_NOT_FOUND"}', { status: 404 });
  }) as typeof globalThis.fetch;
  return new PayPalClient({ clientId: 'cid', clientSecret: 'secret', env: 'sandbox', fetch, sleep: async () => {} });
}

async function withApp(o: Parameters<typeof fakePayPal>[0], f: (x: { app: ReturnType<typeof createHostedApp>; people: ReturnType<typeof testAccounts>; store: CaseStore }) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'rk-scan-'));
  try {
    const paypal = fakePayPal(o);
    const people = testAccounts();
    const store = new CaseStore({ file: join(dir, 'cases.json') });
    const bindings: Record<string, Binding> = { [CASE]: { dispute: BOUND, capture: STD_CAPTURE } };
    const reserve: Record<string, Binding[]> = {};
    const discovery = createDiscovery({ paypal, store, anchor: () => SELLER_ID, isBound: (id) => isBoundDispute({ bindings, reserve }, id), log: () => {} });
    const app = createHostedApp({
      paypal,
      env: 'sandbox',
      bindings,
      reserve,
      caseStore: store,
      discovery,
      log: () => {},
      counters: new DailyCounters({ file: null, limits: {} }),
      site: null,
      accounts: people.accounts,
      identity: null,
      sessionSecret: TEST_SECRET,
      origins: [ORIGIN],
      hosts: [HOST],
      https: true,
    });
    await f({ app, people, store });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const scan = (cookie?: string) =>
  new Request(`${ORIGIN}/api/discovery/scan`, {
    method: 'POST',
    headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', ...(cookie ? { cookie } : {}) },
    body: '{}',
  });

type ScanBody = { created: { caseId: string; orderRef: string }[]; skipped: { disputeId: string; why: string }[] };

test('owner scan: the admissible dispute becomes a case; the foreign one and the already bound one are skipped with a reason', async () => {
  await withApp({}, async ({ app, people, store }) => {
    const r = await app(scan(people.ownerCookie));
    assert.equal(r.status, 200);
    const b = (await r.json()) as ScanBody;
    assert.deepEqual(b.created, [{ caseId: NEW, orderRef: 'rk-std-t1' }]);
    assert.deepEqual(b.skipped.map((s) => s.disputeId).sort(), [BOUND, FOREIGN].sort());
    assert.ok(b.skipped.every((s) => s.why.length > 0));
    assert.equal(store.all().length, 1);
  });
});

test('a dispute that cannot be read is skipped and the scan goes on', async () => {
  await withApp({ listed: [UNREADABLE, NEW] }, async ({ app, people }) => {
    const b = (await (await app(scan(people.ownerCookie))).json()) as ScanBody;
    assert.deepEqual(b.created.map((c) => c.caseId), [NEW]);
    assert.deepEqual(b.skipped, [{ disputeId: UNREADABLE, why: 'dispute could not be read' }]);
  });
});

test('a member is refused (403 OWNER_ONLY) and a signed-out caller gets 401; neither uses the owner’s minute', async () => {
  await withApp({}, async ({ app, people, store }) => {
    assert.equal((await app(scan())).status, 401);
    for (const cookie of [people.member(), people.fullMember()]) {
      const r = await app(scan(cookie));
      assert.equal(r.status, 403);
      assert.equal(((await r.json()) as { error: string }).error, 'OWNER_ONLY');
    }
    assert.equal(store.all().length, 0);
    assert.equal((await app(scan(people.ownerCookie))).status, 200);
  });
});

test('a second scan within 60 s is 429 with Retry-After', async () => {
  await withApp({}, async ({ app, people }) => {
    assert.equal((await app(scan(people.ownerCookie))).status, 200);
    const r = await app(scan(people.ownerCookie));
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
  });
});

test('listing fails: 503 PAYPAL_UNAVAILABLE and nothing is created', async () => {
  await withApp({ listFails: true }, async ({ app, people, store }) => {
    const r = await app(scan(people.ownerCookie));
    assert.equal(r.status, 503);
    assert.equal(((await r.json()) as { error: string }).error, 'PAYPAL_UNAVAILABLE');
    assert.equal(store.all().length, 0);
  });
});

test('only POST is allowed', async () => {
  await withApp({}, async ({ app, people }) => {
    const r = await app(new Request(`${ORIGIN}/api/discovery/scan`, { headers: { host: HOST, cookie: people.ownerCookie, 'x-forwarded-for': '203.0.113.7' } }));
    assert.equal(r.status, 405);
  });
});

test('local mode: the operator acts as the owner, with the same one-per-minute limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-scan-'));
  try {
    const paypal = fakePayPal();
    const store = new CaseStore({ file: join(dir, 'cases.json') });
    const bindings: Record<string, Binding> = { [CASE]: { dispute: BOUND, capture: STD_CAPTURE } };
    const discovery = createDiscovery({ paypal, store, anchor: () => SELLER_ID, isBound: (id) => isBoundDispute({ bindings, reserve: {} }, id), log: () => {} });
    const api = createApi({ paypal, env: 'sandbox', bindings, caseStore: store, discovery });
    const post = () => api(new Request('http://localhost:8787/api/discovery/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    const r = await post();
    assert.equal(r.status, 200);
    assert.deepEqual(((await r.json()) as ScanBody).created, [{ caseId: NEW, orderRef: 'rk-std-t1' }]);
    assert.equal((await post()).status, 429);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
