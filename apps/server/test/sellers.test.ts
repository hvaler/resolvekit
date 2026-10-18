/**
 * Workspace connection state (sellers.ts, hosted.ts): which workspace is the evaluation seller, and why a sandbox
 * that cannot be read right now never demotes it. Fake PayPal only: nothing is sent anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DailyCounters } from '@resolvekit/hosting';
import { PayPalClient, type Dispute } from '@resolvekit/paypal';
import { standardCase } from '@resolvekit/cases';
import { AccountStore, SESSION_COOKIE } from '../src/accounts.ts';
import { createHostedApp } from '../src/hosted.ts';
import { SellerMemory } from '../src/sellers.ts';
import { SELLER_ID, STD_CAPTURE, TEST_SECRET, analystFor, standardDispute } from './kit.ts';

const ORIGIN = 'https://rk.example.com';
const HOST = 'rk.example.com';
const CASE = standardCase.summary.id;
const TOKEN = 'BA-9BU79859F44918800';

test('a file that exists but is not a list of seller entries stops the start; a failed write is logged, not thrown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-sellers-'));
  try {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    assert.throws(() => new SellerMemory({ file: bad }));
    writeFileSync(bad, JSON.stringify({ entries: [{ caseId: 1 }] }));
    assert.throws(() => new SellerMemory({ file: bad }));
    const asDir = join(dir, 'isdir');
    mkdirSync(asDir);
    assert.throws(() => new SellerMemory({ file: asDir })); // EISDIR is not "missing"
    // The parent of the file is a regular file: the write fails, the value stays in memory.
    const lines: string[] = [];
    const blocked = new SellerMemory({ file: join(bad, 'x', 'sellers.json'), log: (l) => lines.push(l) });
    blocked.confirm([{ caseId: 'C1', dispute: 'D1', merchant: 'M1' }]);
    assert.equal(blocked.remembered().length, 1);
    assert.equal(lines.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('remembers confirmed sellers across instances (file)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-sellers-'));
  try {
    const file = join(dir, 'sub', 'sellers.json');
    assert.deepEqual([...new SellerMemory({ file }).remembered()], []);
    new SellerMemory({ file }).confirm([{ caseId: 'C1', dispute: 'D1', merchant: 'M1' }]);
    assert.deepEqual([...new SellerMemory({ file }).remembered()], [{ caseId: 'C1', dispute: 'D1', merchant: 'M1' }]);
    // The next confirmation prunes what is no longer bound or bound to another dispute.
    const again = new SellerMemory({ file });
    again.confirm([{ caseId: 'C2', dispute: 'D2', merchant: 'M2' }]);
    assert.deepEqual([...new SellerMemory({ file }).remembered()], [{ caseId: 'C2', dispute: 'D2', merchant: 'M2' }]);
    const mem = new SellerMemory({ file: null });
    mem.confirm([{ caseId: 'C3', dispute: 'D3', merchant: 'M3' }]);
    assert.equal(mem.remembered().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The seller's app: every dispute read names SELLER_ID as the seller, unless `down` is set (then it fails). */
function sellerPayPal() {
  const state = { down: false };
  const fetch = (async (url: string | URL) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
    if (state.down) return new Response(JSON.stringify({ name: 'INTERNAL_SERVICE_ERROR' }), { status: 500, headers: { 'content-type': 'application/json' } });
    const d: Dispute = standardDispute();
    d.disputed_transactions![0]!.seller = { merchant_id: SELLER_ID, name: 'Northwind Goods Ltd' };
    return new Response(JSON.stringify(d), { status: 200 });
  }) as typeof globalThis.fetch;
  return { state, client: new PayPalClient({ clientId: 'seller', clientSecret: 's', env: 'sandbox', fetch }) };
}

/** The platform's app: `approve(payerId)` makes the agreement token APPROVED by that account. */
function platformPayPal() {
  const state = { status: 'PENDING', payerId: null as string | null, returnUrl: '' };
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
    if (u.pathname === '/v1/billing-agreements/agreement-tokens' && init.method === 'POST') {
      state.returnUrl = (JSON.parse(String(init.body)) as { plan: { merchant_preferences: { return_url: string } } }).plan.merchant_preferences.return_url;
      return new Response(JSON.stringify({ token_id: TOKEN, links: [{ rel: 'approval_url', href: `https://www.sandbox.paypal.com/agreements/approve?ba_token=${TOKEN}` }] }), { status: 201 });
    }
    if (u.pathname === `/v1/billing-agreements/agreement-tokens/${TOKEN}`) {
      return new Response(JSON.stringify({ token_id: TOKEN, token_status: state.status, ...(state.payerId ? { payer_info: { payer_id: state.payerId, email: 'boss@example.com', first_name: 'Northwind', last_name: 'Goods' } } : {}) }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof globalThis.fetch;
  return {
    state,
    approve: (payerId: string) => Object.assign(state, { status: 'APPROVED', payerId }),
    client: new PayPalClient({ clientId: 'platform', clientSecret: 'p', env: 'sandbox', fetch }),
  };
}

async function setup(o: { memory?: SellerMemory } = {}) {
  const bindings = { [CASE]: { dispute: 'PP-R-REAL-1', capture: STD_CAPTURE } };
  const pp = sellerPayPal();
  const platform = platformPayPal();
  const { analyst } = await analystFor([]);
  const app = createHostedApp({
    log: () => {},
    paypal: pp.client,
    env: 'sandbox',
    bindings,
    analyst,
    site: null,
    counters: new DailyCounters({ file: null, limits: { 'live-analysis': 5, recheck: 50, evidence: 5 } }),
    accounts: new AccountStore(),
    identity: platform.client,
    sessionSecret: TEST_SECRET,
    origins: [ORIGIN],
    hosts: [HOST],
    https: true,
    ...(o.memory ? { sellerMemory: o.memory } : {}),
  });
  return { app, pp, platform, bindings };
}
type S = Awaited<ReturnType<typeof setup>>;

const req = (path: string, i: { body?: unknown; cookie?: string } = {}) => {
  const method = i.body !== undefined ? 'POST' : 'GET';
  const headers: Record<string, string> = { host: HOST, 'x-forwarded-for': '203.0.113.7', ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/json' } : {}), ...(i.cookie ? { cookie: i.cookie } : {}) };
  return new Request(ORIGIN + path, { method, headers, ...(i.body !== undefined ? { body: JSON.stringify(i.body) } : {}) });
};
const pair = (r: Response, name: string) => (r.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? '').split(';')[0]!;
type Me = { workspace?: { connection: string; connected: boolean } };
const me = async (s: S, cookie: string) => ((await (await s.app(req('/api/auth/me', { cookie }))).json()) as Me).workspace!;

/** The whole PayPal sign-in of `payerId`; returns the session cookie. */
async function paypalSignIn(s: S, payerId: string): Promise<string> {
  const start = await s.app(req('/api/auth/paypal/start', { body: {} }));
  const pending = pair(start, 'rk_pp');
  s.platform.approve(payerId);
  const path = new URL(s.platform.state.returnUrl).pathname;
  const back = await s.app(req(`${path}?token=${TOKEN}&ba_token=${TOKEN}`, { cookie: pending }));
  assert.equal(back.status, 303);
  return pair(back, SESSION_COOKIE);
}

test('an unreadable sandbox keeps Test Store in evaluation', async () => {
  const s = await setup();
  const cookie = await paypalSignIn(s, SELLER_ID);
  assert.equal((await me(s, cookie)).connection, 'evaluation');
  // PayPal stops answering and the bindings are read again (a changed bindings file): the seller was confirmed before.
  s.pp.state.down = true;
  s.app.bindingsChanged();
  const w = await me(s, cookie);
  assert.deepEqual([w.connection, w.connected], ['evaluation', true]);
});

test('a seller remembered from an earlier run stays in evaluation while the sandbox cannot be read', async () => {
  const memory = new SellerMemory({ file: null });
  memory.confirm([{ caseId: CASE, dispute: 'PP-R-REAL-1', merchant: SELLER_ID }]);
  const s = await setup({ memory });
  s.pp.state.down = true;
  const cookie = await paypalSignIn(s, SELLER_ID);
  assert.equal((await me(s, cookie)).connection, 'evaluation');
});

test('never confirmed and unreadable → checking, never not_connected', async () => {
  const s = await setup();
  s.pp.state.down = true;
  const cookie = await paypalSignIn(s, 'SOMEONEELSE01');
  const w = await me(s, cookie);
  assert.deepEqual([w.connection, w.connected], ['checking', false]);
});

test('another PayPal account is not_connected when the read is complete', async () => {
  const s = await setup();
  const cookie = await paypalSignIn(s, 'SOMEONEELSE01');
  const w = await me(s, cookie);
  assert.deepEqual([w.connection, w.connected], ['not_connected', false]);
});

test('a reviewer invited to the seller workspace gets evaluation', async () => {
  const s = await setup();
  const owner = await paypalSignIn(s, SELLER_ID);
  const inv = await s.app(req('/api/workspace/invites', { body: { label: 'Judges', reviewer: true, maxUses: 5, ttlDays: 30 }, cookie: owner }));
  assert.equal(inv.status, 201);
  const token = ((await inv.json()) as { url: string }).url.split('#')[1]!;
  const join = await s.app(req('/api/auth/invite/join', { body: { token, name: 'Dana Ruiz' } }));
  assert.equal(join.status, 200);
  const w = await me(s, pair(join, SESSION_COOKIE));
  assert.deepEqual([w.connection, w.connected], ['evaluation', true]);
});

test('a seller remembered for another dispute of the case is not kept when the binding changed and cannot be read', async () => {
  const s = await setup();
  const cookie = await paypalSignIn(s, SELLER_ID);
  assert.equal((await me(s, cookie)).connection, 'evaluation');
  // BINDINGS now point to another dispute, which PayPal cannot be asked about: the old seller is not trusted for it.
  s.bindings[CASE] = { dispute: 'PP-R-OTHER-9', capture: STD_CAPTURE };
  s.pp.state.down = true;
  await s.app.bindingsChanged();
  const w = await me(s, cookie);
  assert.deepEqual([w.connection, w.connected], ['checking', false]);
});

test('a complete read ignores remembered sellers that are no longer bound', async () => {
  const memory = new SellerMemory({ file: null });
  memory.confirm([
    { caseId: 'GONE-CASE', dispute: 'PP-R-REAL-1', merchant: 'OLDSELLER01' },
    { caseId: CASE, dispute: 'PP-R-OLD-0', merchant: 'OLDSELLER02' },
  ]);
  for (const id of ['OLDSELLER01', 'OLDSELLER02']) {
    const s = await setup({ memory });
    const w = await me(s, await paypalSignIn(s, id));
    assert.deepEqual([w.connection, w.connected], ['not_connected', false]);
  }
});

// Final review I1: with no case bound at all, the last confirmed seller's workspace stays evaluation (empty inbox).
test('no case bound at all: the last confirmed seller is evaluation with bound []; another account is not_connected', async () => {
  const s = await setup();
  const seller = await paypalSignIn(s, SELLER_ID);
  assert.equal((await me(s, seller)).connection, 'evaluation');
  delete s.bindings[CASE];
  await s.app.bindingsChanged();
  const w = await me(s, seller);
  assert.deepEqual([w.connection, w.connected], ['evaluation', true]);
  const health = (await (await s.app(req('/api/health', { cookie: seller }))).json()) as { bound: string[] };
  assert.deepEqual(health.bound, []);
  // A label, never access: the formerly bound case is unknown to the seller now.
  assert.equal((await s.app(req(`/api/disputes/${CASE}`, { cookie: seller }))).status, 404);
  // Another account, on a fresh app that shares the memory (one sign-in per app: the agreement token is single-use).
  const memory = new SellerMemory({ file: null });
  memory.confirm([{ caseId: CASE, dispute: 'PP-R-REAL-1', merchant: SELLER_ID }]);
  const t = await setup({ memory });
  delete t.bindings[CASE];
  await t.app.bindingsChanged();
  const other = await me(t, await paypalSignIn(t, 'SOMEONEELSE01'));
  assert.deepEqual([other.connection, other.connected], ['not_connected', false]);
});

test('no case bound and no seller ever confirmed → not_connected (nothing to check)', async () => {
  const s = await setup();
  delete s.bindings[CASE];
  await s.app.bindingsChanged();
  const w = await me(s, await paypalSignIn(s, SELLER_ID));
  assert.deepEqual([w.connection, w.connected], ['not_connected', false]);
});

test('the last confirmed sellers are kept apart from the per-binding entries and persisted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-sellers-'));
  try {
    const file = join(dir, 'sellers.json');
    assert.deepEqual([...new SellerMemory({ file }).lastSellers()], []);
    new SellerMemory({ file }).confirm([{ caseId: 'C1', dispute: 'D1', merchant: 'M1' }, { caseId: 'C2', dispute: 'D2', merchant: 'M1' }]);
    assert.deepEqual([...new SellerMemory({ file }).lastSellers()], ['M1']);
    // A file from before this change (entries only) still knows its sellers.
    writeFileSync(file, JSON.stringify({ entries: [{ caseId: 'C1', dispute: 'D1', merchant: 'M9' }] }));
    assert.deepEqual([...new SellerMemory({ file }).lastSellers()], ['M9']);
    writeFileSync(file, JSON.stringify({ entries: [], last: [1] }));
    assert.throws(() => new SellerMemory({ file }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
