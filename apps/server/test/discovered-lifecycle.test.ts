/**
 * Discovered cases over time (docs/09-DISENO-DESCUBRIMIENTO.md, decisions 9, 10, 14, 15 and the lifecycle decision A):
 * /api/health lists them under `cases` to whoever sees them, with whether they ended (closed, seller evidence recorded,
 * chargeback, past due); closed or past due for more than 7 days they leave the inbox. Their analyses are warmed in a
 * lane of their own: one at a time, a start every 10 min at most, outside the people's hourly limit. Fake PayPal, fake
 * model, fake clock and timers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DailyCounters } from '@resolvekit/hosting';
import { MemoryAnalysisStore, RateLimiter } from '@resolvekit/analyst/node';
import { standardCase } from '@resolvekit/cases';
import { PayPalClient, type Capture, type Dispute } from '@resolvekit/paypal';
import { fakeModel, standardScript } from '../../../packages/analyst/test/fake.ts';
import { AnalystService } from '../src/analysis.ts';
import { createApi, TOKEN_HEADER } from '../src/app.ts';
import { isBoundDispute, type Binding } from '../src/bindings.ts';
import { CaseStore, type DiscoveredCase } from '../src/caseStore.ts';
import { createDiscovery } from '../src/discovery.ts';
import { createHostedApp } from '../src/hosted.ts';
import { evaluate, type OpsBody } from '../scripts/demo-check-lib.ts';
import { evidenceInDispute } from './fixtures.ts';
import { SELLER_ID, STD_CAPTURE, TEST_SECRET, standardDispute, testAccounts } from './kit.ts';

const ORIGIN = 'https://rk.example.com';
const HOST = 'rk.example.com';
const CASE = standardCase.summary.id;
const BOUND = 'PP-R-REAL-1';
const A = 'PP-R-DSC-30001';
const B = 'PP-R-DSC-30002';
const C = 'PP-R-DSC-30003';
const D = 'PP-R-DSC-30004';
const CAPTURES: Record<string, string> = { [A]: '5AB12345CD678901E', [B]: '6AB12345CD678901E', [C]: '7AB12345CD678901E', [D]: '8AB12345CD678901E' };
const OPS = 'o'.repeat(20) + '0123456789abcdef';
const DAY = 86_400_000;
const MIN = 60_000;
const T0 = Date.parse('2026-11-07T10:00:00.000Z');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, what = 'condition') {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await sleep(5);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** A fake clock and the timers scheduled on it (fired by the test, in order). */
function fakeTime() {
  let t = T0;
  const timers: Array<{ at: number; run: () => void }> = [];
  return {
    now: () => new Date(t),
    set: (ms: number) => void (t = ms),
    get: () => t,
    timers,
    later: (run: () => void, ms: number) => void timers.push({ at: t + ms, run }),
    /** Move the clock to the first timer's time and run it. */
    fire() {
      const next = timers.shift();
      assert.ok(next, 'a timer is scheduled');
      t = Math.max(t, next.at);
      next.run();
    },
  };
}

/** A new "not received" dispute of the evaluation seller on its own capture, due 3 days after `at`. */
function newDispute(id: string, at: number, over: Partial<Dispute> = {}): Dispute {
  const d = standardDispute();
  return {
    ...d,
    dispute_id: id,
    seller_response_due_date: new Date(at + 3 * DAY).toISOString(),
    disputed_transactions: [{ ...d.disputed_transactions![0]!, seller_transaction_id: CAPTURES[id] ?? STD_CAPTURE }],
    ...over,
  };
}
const captureOf = (id: string, invoice: string): Capture => ({ id, status: 'COMPLETED', amount: { currency_code: 'USD', value: '7.00' }, invoice_id: invoice });

function fakePayPal() {
  const disputes: Record<string, Dispute> = { [BOUND]: { ...standardDispute(), dispute_id: BOUND } };
  const captures: Record<string, Capture> = {};
  const calls: string[] = [];
  const fetch = (async (url: string | URL) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
    calls.push(u.pathname);
    if (u.pathname === '/v1/customer/disputes') return new Response(JSON.stringify({ items: Object.keys(disputes).map((dispute_id) => ({ dispute_id })) }), { status: 200 });
    const id = decodeURIComponent(u.pathname.split('/').pop()!);
    const found = u.pathname.startsWith('/v2/payments/captures/') ? captures[id] : disputes[id];
    return found ? new Response(JSON.stringify(found), { status: 200 }) : new Response('{"name":"RESOURCE_NOT_FOUND"}', { status: 404 });
  }) as typeof globalThis.fetch;
  return { disputes, captures, reads: (id: string) => calls.filter((c) => c === `/v1/customer/disputes/${id}`).length, client: new PayPalClient({ clientId: 'cid', clientSecret: 'secret', env: 'sandbox', fetch }) };
}

const record = (caseId: string, template: DiscoveredCase['template'], orderRef: string, createdAt: number): DiscoveredCase => ({
  caseId,
  merchantId: SELLER_ID,
  disputeId: caseId,
  captureId: CAPTURES[caseId]!,
  template,
  orderRef,
  source: 'scan',
  createdAt: new Date(createdAt).toISOString(),
});

async function withDir(f: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'rk-lifecycle-'));
  try {
    await f(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The hosted app on a fake clock: the fixed standard case bound to BOUND, the store seeded with `seed` (their disputes
 * waiting for the seller), an analyst on a fake model whose runs are recorded with the clock's time (`failFirst`: its
 * first run fails; `failCase`: every run of that case fails; `hangCase`: every run of that case never answers, and the
 * lane waits `waitMs` real ms for a run).
 */
function hosted(dir: string, o: { seed?: DiscoveredCase[]; failFirst?: boolean; failCase?: string; hangCase?: string; waitMs?: number; cap?: number; lastReadyFile?: string } = {}) {
  const time = fakeTime();
  const pp = fakePayPal();
  for (const c of o.seed ?? []) pp.disputes[c.caseId] = newDispute(c.caseId, T0);
  const people = testAccounts(time.now);
  const lines: string[] = [];
  const store = new CaseStore({ file: join(dir, 'cases.json') });
  for (const c of o.seed ?? []) store.add(c);
  const bindings: Record<string, Binding> = { [CASE]: { dispute: BOUND, capture: STD_CAPTURE } };
  const reserve: Record<string, Binding[]> = {};
  const fm = fakeModel(standardScript);
  let failed = !o.failFirst;
  const starts: Array<{ caseId: string; at: number }> = [];
  const analyst = new AnalystService({
    model: {
      ...fm.model,
      generate: async (r) => {
        const running = starts.at(-1)?.caseId;
        if (running === o.failCase) throw new Error('model down');
        if (running === o.hangCase) return new Promise<never>(() => {});
        if (!failed) {
          failed = true;
          throw new Error('model down');
        }
        return fm.model.generate(r);
      },
    },
    primaryModel: 'gemini-3.8-flash',
    store: new MemoryAnalysisStore(),
    liveLimit: new RateLimiter({ limit: 6, windowMs: 3_600_000 }),
    ...(o.lastReadyFile ? { lastReadyFile: o.lastReadyFile } : {}),
    log: (l) => {
      const m = /^analysis started · case (\S+)/.exec(l);
      if (m) starts.push({ caseId: m[1]!, at: time.get() });
    },
  });
  const discovery = createDiscovery({ paypal: pp.client, store, anchor: () => SELLER_ID, isBound: (id) => isBoundDispute({ bindings, reserve }, id) });
  const counters = new DailyCounters({ file: null, limits: { 'live-analysis': o.cap ?? 60, recheck: 60 }, now: time.now });
  const app = createHostedApp({
    paypal: pp.client,
    env: 'sandbox',
    bindings,
    reserve,
    caseStore: store,
    discovery,
    analyst,
    log: (l) => lines.push(l),
    counters,
    site: null,
    accounts: people.accounts,
    identity: null,
    sessionSecret: TEST_SECRET,
    origins: [ORIGIN],
    hosts: [HOST],
    https: true,
    opsToken: OPS,
    now: time.now,
    warmLane: { later: time.later, ...(o.waitMs ? { waitMs: o.waitMs } : {}) },
  });
  return { app, pp, people, lines, store, bindings, time, analyst, starts, counters };
}
type Hosted = ReturnType<typeof hosted>;

const get = (path: string, cookie?: string, headers: Record<string, string> = {}) =>
  new Request(ORIGIN + path, { headers: { host: HOST, 'x-forwarded-for': '203.0.113.7', ...(cookie ? { cookie } : {}), ...headers } });
type Health = { bound: string[]; cases: Record<string, { template: string; orderRef: string; source: string; createdAt: string; ended: boolean }> };
const health = async (h: Hosted, cookie?: string) => (await (await h.app(get('/api/health', cookie))).json()) as Health;
/** The owner's cookie, signed on the clock as it is now. */
const owner = (h: Hosted) => h.people.cookieOf(h.people.owner);
/** The owner opens the case: a fresh read of its dispute. */
const open = async (h: Hosted, caseId: string) => assert.equal((await h.app(get(`/api/disputes/${caseId}`, owner(h)))).status, 200);

// ------------------------------------------------------------------------------------------------ /api/health cases

test('health: `cases` lists each discovered case the viewer may see (template, order, source, creation, ended); fixed cases are only in `bound`', async () => {
  await withDir(async (dir) => {
    const h = hosted(dir, { seed: [record(A, 'standard', 'rk-std-a', T0 - 2 * DAY), record(B, 'settlement', 'rk-stl-b', T0 - DAY)] });
    const own = await health(h, owner(h));
    assert.deepEqual(own.bound.sort(), [CASE, A, B].sort());
    assert.deepEqual(own.cases, {
      [A]: { template: 'standard', orderRef: 'rk-std-a', source: 'scan', createdAt: new Date(T0 - 2 * DAY).toISOString(), ended: false },
      [B]: { template: 'settlement', orderRef: 'rk-stl-b', source: 'scan', createdAt: new Date(T0 - DAY).toISOString(), ended: false },
    });
    // A member: the settlement case is the owner's only. Another merchant, or nobody signed in: nothing.
    const member = await health(h, h.people.fullMember());
    assert.deepEqual(member.bound.sort(), [CASE, A].sort());
    assert.deepEqual(Object.keys(member.cases), [A]);
    for (const who of [h.people.outsider(), undefined]) {
      const x = await health(h, who);
      assert.deepEqual(x.bound, []);
      assert.deepEqual(x.cases, {});
    }
  });
});

const ENDS: Array<[string, (d: Dispute) => Dispute]> = [
  ['RESOLVED', (d) => ({ ...d, status: 'RESOLVED', update_time: new Date(T0 - DAY).toISOString(), dispute_outcome: { outcome_code: 'RESOLVED_BUYER_FAVOUR' } })],
  ['stage CHARGEBACK', (d) => ({ ...d, dispute_life_cycle_stage: 'CHARGEBACK' })],
  ['seller evidence recorded', (d) => ({ ...evidenceInDispute(), dispute_id: d.dispute_id, dispute_amount: d.dispute_amount, disputed_transactions: d.disputed_transactions })],
  ['a past due date', (d) => ({ ...d, seller_response_due_date: new Date(T0 - 2 * DAY).toISOString() })],
];
for (const [name, end] of ENDS) {
  test(`lifecycle: a read showing ${name} marks the case ended (stored, so it stays ended after a restart); it stays listed`, async () => {
    await withDir(async (dir) => {
      const h = hosted(dir, { seed: [record(A, 'standard', 'rk-std-a', T0 - 3 * DAY)] });
      await open(h, A);
      assert.equal((await health(h, owner(h))).cases[A]!.ended, false);
      h.pp.disputes[A] = end(h.pp.disputes[A]!);
      await open(h, A);
      const x = await health(h, owner(h));
      assert.ok(x.bound.includes(A));
      assert.equal(x.cases[A]!.ended, true);
      assert.ok(h.store.get(A)!.endedAt);
      // A new process over the same data dir, before any read: still ended.
      const again = hosted(dir);
      assert.equal((await health(again, owner(again))).cases[A]!.ended, true);
    });
  });
}

test('lifecycle: when it ended — RESOLVED at PayPal’s update time, past due at the due date', async () => {
  await withDir(async (dir) => {
    const h = hosted(dir, { seed: [record(A, 'standard', 'rk-std-a', T0 - 9 * DAY), record(B, 'standard', 'rk-std-b', T0 - 9 * DAY)] });
    h.pp.disputes[A] = ENDS[0]![1](h.pp.disputes[A]!);
    h.pp.disputes[B] = ENDS[3]![1](h.pp.disputes[B]!);
    await open(h, A);
    await open(h, B);
    assert.equal(h.store.get(A)!.endedAt, new Date(T0 - DAY).toISOString());
    assert.equal(h.store.get(B)!.endedAt, new Date(T0 - 2 * DAY).toISOString());
  });
});

test('lifecycle: a due date that lapses with no new read ends the case (the last read is judged again as time passes)', async () => {
  await withDir(async (dir) => {
    const h = hosted(dir, { seed: [record(A, 'standard', 'rk-std-a', T0 - DAY)] });
    await open(h, A);
    assert.equal((await health(h, owner(h))).cases[A]!.ended, false);
    h.time.set(T0 + 4 * DAY);
    assert.equal((await health(h, owner(h))).cases[A]!.ended, true);
    assert.equal(h.store.get(A)!.endedAt, new Date(T0 + 3 * DAY).toISOString());
  });
});

test('lifecycle: closed or past due for more than 7 days → out of `cases` and `bound` (still stored and addressable); evidence recorded or chargeback stay listed', async () => {
  await withDir(async (dir) => {
    const h = hosted(dir, {
      seed: [record(A, 'standard', 'rk-std-a', T0 - 9 * DAY), record(B, 'standard', 'rk-std-b', T0 - 9 * DAY), record(C, 'standard', 'rk-std-c', T0 - 9 * DAY), record(D, 'standard', 'rk-std-d', T0 - 9 * DAY)],
    });
    h.pp.disputes[A] = ENDS[0]![1](h.pp.disputes[A]!); // resolved T0 - 1 day
    h.pp.disputes[B] = ENDS[3]![1](h.pp.disputes[B]!); // due T0 - 2 days
    h.pp.disputes[C] = ENDS[2]![1](h.pp.disputes[C]!); // evidence recorded (seen at T0)
    h.pp.disputes[D] = ENDS[1]![1](h.pp.disputes[D]!); // chargeback (seen at T0)
    for (const id of [A, B, C, D]) await open(h, id);
    // 6 days after the close, 7 after the due date: all listed.
    h.time.set(T0 + 5 * DAY);
    assert.deepEqual(Object.keys((await health(h, owner(h))).cases).sort(), [A, B, C, D].sort());
    // More than 7 days after the due date (B), not yet after the close (A).
    h.time.set(T0 + 5 * DAY + MIN);
    let x = await health(h, owner(h));
    assert.deepEqual(Object.keys(x.cases).sort(), [A, C, D].sort());
    assert.ok(!x.bound.includes(B));
    // Then A too; the evidence-recorded and chargeback cases stay, 30 days on.
    h.time.set(T0 + 30 * DAY);
    x = await health(h, owner(h));
    assert.deepEqual(Object.keys(x.cases).sort(), [C, D].sort());
    assert.deepEqual(x.bound.sort(), [CASE, C, D].sort());
    assert.equal(h.store.all().length, 4);
    assert.equal((await h.app(get(`/api/disputes/${A}`, owner(h)))).status, 200);
  });
});

test('lifecycle: an evidence-recorded case that PayPal later closes is hidden 7 days after the close', async () => {
  await withDir(async (dir) => {
    const h = hosted(dir, { seed: [record(A, 'standard', 'rk-std-a', T0 - DAY)] });
    h.pp.disputes[A] = ENDS[2]![1](h.pp.disputes[A]!);
    await open(h, A);
    assert.equal(h.store.get(A)!.endedBy, 'evidence');
    h.time.set(T0 + 20 * DAY);
    h.pp.disputes[A] = { ...h.pp.disputes[A]!, status: 'RESOLVED', update_time: new Date(T0 + 19 * DAY).toISOString() };
    await open(h, A);
    assert.deepEqual(Object.keys((await health(h, owner(h))).cases), [A]);
    h.time.set(T0 + 26 * DAY + MIN);
    assert.deepEqual((await health(h, owner(h))).cases, {});
  });
});

// ------------------------------------------------------------------------------------------------ operator's check

test('ops: a discovered case whose evidence PayPal recorded is `used` (no rotation), and it is not reported as a reserve to refill', async () => {
  await withDir(async (dir) => {
    const h = hosted(dir, { seed: [record(A, 'standard', 'rk-std-a', T0 - DAY)] });
    h.pp.disputes[A] = ENDS[2]![1](h.pp.disputes[A]!);
    const r = await h.app(get('/api/ops/status', undefined, { authorization: `Bearer ${OPS}` }));
    const s = (await r.json()) as OpsBody;
    assert.equal(s.bindings[A]!.used, true);
    assert.equal(s.bindings[A]!.discovered, true);
    assert.deepEqual(h.bindings[A], { dispute: A, capture: CAPTURES[A] });
    assert.ok(!s.problems.some((p) => p.includes(A) && p.includes('reserve')), s.problems.join(' | '));
    // demo:check: no "left in reserve" warning for it either.
    const lines = evaluate({ app: { healthz: 200, landing: { status: 200, html: 'ResolveKit' } }, meter: { healthz: 200 }, ops: { status: 200, body: s } }).lines;
    assert.ok(!lines.some((l) => l.what.includes(A) && /left in reserve/.test(l.detail)), JSON.stringify(lines));
    assert.ok(!lines.some((l) => l.what === `reserve · case ${A}`), JSON.stringify(lines));
  });
});

// ------------------------------------------------------------------------------------------------ local mode

test('local mode: a discovered case left unbound (a fixed binding holds its dispute) is not addressable', async () => {
  await withDir(async (dir) => {
    const pp = fakePayPal();
    const store = new CaseStore({ file: join(dir, 'cases.json') });
    // Its dispute is the fixed case's: the fixed binding wins and the discovered id stays unbound.
    store.add({ ...record(A, 'standard', 'rk-std-a', T0), disputeId: BOUND });
    const bindings: Record<string, Binding> = { [CASE]: { dispute: BOUND, capture: STD_CAPTURE } };
    const api = createApi({ paypal: pp.client, env: 'sandbox', bindings, caseStore: store });
    assert.equal(bindings[A], undefined);
    const TOKEN = 'a'.repeat(64);
    const local = (path: string, body?: unknown) =>
      api(new Request(`http://127.0.0.1:8787${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    assert.equal(((await (await local(`/api/disputes/${A}`)).json()) as { error: string }).error, 'UNKNOWN_CASE');
    assert.equal(((await (await local(`/api/disputes/${A}/hold`)).json()) as { error: string }).error, 'UNKNOWN_CASE');
    assert.equal((await local(`/api/cases/${A}/analysis`, {})).status, 404);
    const h = (await (await local('/api/health')).json()) as Health;
    assert.ok(!h.bound.includes(A));
    assert.deepEqual(h.cases, {});
    // The fixed case is unaffected.
    assert.equal((await local(`/api/disputes/${CASE}`)).status, 200);
  });
});

// ------------------------------------------------------------------------------------------------ warm-up lane

test('warm-up lane: 3 new cases (settlement included) are analysed at t, t+10 min and t+20 min, one at a time, outside the people’s hourly limit', async () => {
  await withDir(async (dir) => {
    const h = hosted(dir, { seed: [record(A, 'standard', 'rk-std-a', T0 - 3 * MIN), record(B, 'settlement', 'rk-stl-b', T0 - 2 * MIN), record(C, 'standard', 'rk-std-c', T0 - MIN)] });
    const hourly = h.analyst.liveState().remaining;
    h.app.warmDiscovered();
    await until(() => h.time.timers.length === 1, 'the first run and the next slot');
    assert.deepEqual(h.starts, [{ caseId: A, at: T0 }]);
    assert.equal(h.time.timers[0]!.at, T0 + 10 * MIN);
    // Asked again while waiting for the slot: nothing starts early.
    h.app.warmDiscovered();
    await sleep(20);
    assert.equal(h.starts.length, 1);
    h.time.fire();
    await until(() => h.time.timers.length === 1, 'the second run');
    h.time.fire();
    await until(() => h.starts.length === 3 && h.time.timers.length === 1, 'the third run');
    assert.deepEqual(h.starts, [
      { caseId: A, at: T0 },
      { caseId: B, at: T0 + 10 * MIN },
      { caseId: C, at: T0 + 20 * MIN },
    ]);
    // Nothing of the people's hourly live analyses was taken; the daily cap counts them as system runs.
    assert.equal(h.analyst.liveState().remaining, hourly);
    assert.equal(h.counters.state().caps['live-analysis']!.used, 3);
    // Every case has its analysis now: the next pass starts nothing and the lane stops.
    h.time.fire();
    await sleep(50);
    assert.equal(h.starts.length, 3);
    assert.equal(h.time.timers.length, 0);
    // Warmed again (a restart, a new case): the stored analyses are skipped.
    h.app.warmDiscovered();
    await sleep(50);
    assert.equal(h.starts.length, 3);
  });
});

test('warm-up lane: a run that fails is tried again in the next slot', async () => {
  await withDir(async (dir) => {
    const h = hosted(dir, { seed: [record(A, 'standard', 'rk-std-a', T0 - 2 * MIN), record(C, 'standard', 'rk-std-c', T0 - MIN)], failFirst: true });
    h.app.warmDiscovered();
    await until(() => h.time.timers.length === 1, 'the failed run');
    assert.ok(h.lines.some((l) => l.startsWith(`warm-up lane · case ${A} · failed`)), h.lines.join('\n'));
    h.time.fire();
    await until(() => h.time.timers.length === 1, 'the retry');
    h.time.fire();
    await until(() => h.starts.length === 3, 'the next case');
    assert.deepEqual(h.starts, [
      { caseId: A, at: T0 },
      { caseId: A, at: T0 + 10 * MIN },
      { caseId: C, at: T0 + 20 * MIN },
    ]);
  });
});

test('warm-up lane: a case made by discovery is warmed at once (after the previous start’s 10 min)', async () => {
  await withDir(async (dir) => {
    const h = hosted(dir);
    h.pp.disputes[A] = newDispute(A, T0);
    h.pp.captures[CAPTURES[A]!] = captureOf(CAPTURES[A]!, 'rk-std-a');
    const scan = await h.app(new Request(`${ORIGIN}/api/discovery/scan`, { method: 'POST', headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', cookie: owner(h) }, body: '{}' }));
    assert.equal(scan.status, 200, await scan.clone().text());
    assert.deepEqual(((await scan.json()) as { created: Array<{ caseId: string }> }).created.map((c) => c.caseId), [A]);
    await until(() => h.starts.length === 1, 'the warm-up of the new case');
    assert.deepEqual(h.starts, [{ caseId: A, at: T0 }]);
    // The fixed warm-up does not analyse discovered cases (they are this lane's).
    const fixed = await h.app.warmUp();
    assert.ok(!fixed.some((w) => w.caseId === A));
  });
});

test('warm-up lane: a case that always fails is given up after 3 attempts, and the newer cases are warmed after it; the daily cap spent is bounded', async () => {
  await withDir(async (dir) => {
    const h = hosted(dir, { seed: [record(A, 'standard', 'rk-std-a', T0 - 2 * MIN), record(B, 'standard', 'rk-std-b', T0 - MIN)], failCase: A });
    h.app.warmDiscovered();
    for (let k = 1; k <= 3; k++) {
      await until(() => h.starts.length === k && h.time.timers.length === 1, `attempt ${k}`);
      h.time.fire();
    }
    await until(() => h.starts.length === 4 && h.time.timers.length === 1, 'the newer case');
    assert.deepEqual(h.starts, [
      { caseId: A, at: T0 },
      { caseId: A, at: T0 + 10 * MIN },
      { caseId: A, at: T0 + 20 * MIN },
      { caseId: B, at: T0 + 30 * MIN },
    ]);
    assert.equal(h.lines.filter((l) => l.startsWith(`warm-up lane · case ${A}`) && l.includes('given up after 3 attempts')).length, 1);
    // Nothing left to try: the lane stops; warmed again, the given-up case is not tried (nor read) again.
    h.time.fire();
    await sleep(50);
    assert.equal(h.time.timers.length, 0);
    const reads = h.pp.reads(A);
    h.app.warmDiscovered();
    await sleep(50);
    assert.equal(h.starts.length, 4);
    assert.equal(h.pp.reads(A), reads);
    assert.equal(h.counters.state().caps['live-analysis']!.used, 4);
  });
});

test('warm-up lane: an ended case (closed, not yet hidden) is not analysed ahead; the open one is', async () => {
  await withDir(async (dir) => {
    const h = hosted(dir, { seed: [record(A, 'standard', 'rk-std-a', T0 - 2 * MIN), record(B, 'standard', 'rk-std-b', T0 - MIN)] });
    // Closed at PayPal, never opened here: the lane's own read finds it ended.
    h.pp.disputes[A] = { ...h.pp.disputes[A]!, status: 'RESOLVED', update_time: new Date(T0).toISOString() };
    h.app.warmDiscovered();
    await until(() => h.starts.length === 1, 'the open case');
    assert.deepEqual(h.starts, [{ caseId: B, at: T0 }]);
    assert.equal(h.store.get(A)!.endedBy, 'resolved');
    h.time.fire();
    await sleep(50);
    assert.deepEqual(h.starts.map((x) => x.caseId), [B]);
  });
});

test('warm-up lane: a run with no result in time is a failed attempt; the lane is free for the next slot', async () => {
  await withDir(async (dir) => {
    const h = hosted(dir, { seed: [record(A, 'standard', 'rk-std-a', T0 - MIN)], hangCase: A, waitMs: 30 });
    h.app.warmDiscovered();
    await until(() => h.time.timers.length === 1, 'the wait to time out');
    assert.ok(h.lines.some((l) => l.startsWith(`warm-up lane · case ${A} · failed · no result within`) && l.includes('tried again in the next slot')), h.lines.join(' | '));
    assert.equal(h.time.timers[0]!.at, T0 + 10 * MIN);
  });
});

test('warm-up lane: a case found analysed is not read from PayPal again by later passes', async () => {
  await withDir(async (dir) => {
    const h = hosted(dir, { seed: [record(A, 'standard', 'rk-std-a', T0 - MIN)] });
    h.app.warmDiscovered();
    await until(() => h.time.timers.length === 1, 'the run');
    h.time.fire();
    await sleep(50);
    const reads = h.pp.reads(A);
    // Past the read cache's minute: only the lane's own memory spares the read.
    h.time.set(h.time.get() + 2 * MIN);
    h.app.warmDiscovered();
    await sleep(50);
    assert.equal(h.pp.reads(A), reads);
    assert.equal(h.starts.length, 1);
  });
});

test('warm-up lane: a refusal because the shared daily cap is used up is not one of the 3 attempts; the case starts once the cap resets next day', async () => {
  await withDir(async (dir) => {
    const h = hosted(dir, { seed: [record(A, 'standard', 'rk-std-a', T0 - MIN)], cap: 1 });
    // Today's one live analysis is spent already (a visitor's run).
    assert.ok(h.counters.reserve('live-analysis').ok);
    h.app.warmDiscovered();
    for (let k = 1; k <= 5; k++) {
      await until(() => h.time.timers.length === 1, `refused pass ${k}`);
      h.time.fire();
    }
    await until(() => h.time.timers.length === 1, 'the next slot');
    assert.equal(h.starts.length, 0);
    assert.ok(h.lines.some((l) => l.startsWith(`warm-up lane · case ${A} · refused · DAILY_CAP`) && l.includes('not counted as an attempt')), h.lines.join(' | '));
    assert.ok(!h.lines.some((l) => l.includes('given up')), h.lines.join(' | '));
    // The next day the cap resets: the case is analysed in the next slot.
    h.time.set(T0 + DAY);
    h.time.fire();
    await until(() => h.starts.length === 1, 'the run after the reset');
    assert.deepEqual(h.starts.map((x) => x.caseId), [A]);
  });
});

test('warm-up lane: other refusals still count (CAPS_UNAVAILABLE is given up after 3)', async () => {
  await withDir(async (dir) => {
    const h = hosted(dir, { seed: [record(A, 'standard', 'rk-std-a', T0 - MIN)] });
    const reserve = h.counters.reserve.bind(h.counters);
    h.counters.reserve = ((name: string) => (name === 'live-analysis' ? { ok: false, reason: 'storage' } : reserve(name))) as typeof h.counters.reserve;
    h.app.warmDiscovered();
    for (let k = 1; k <= 3; k++) {
      await until(() => h.time.timers.length === 1, `refused pass ${k}`);
      h.time.fire();
    }
    await sleep(50);
    assert.equal(h.lines.filter((l) => l.startsWith(`warm-up lane · case ${A} · refused · CAPS_UNAVAILABLE`) && l.includes('given up after 3 attempts')).length, 1, h.lines.join(' | '));
    assert.deepEqual(h.starts, []);
  });
});

test('warm-up: a stored record under a fixed case’s id does not keep that fixed case out of the fixed warm-up', async () => {
  await withDir(async (dir) => {
    // Written before the app starts, as an older process might have left it (discovery never makes one now).
    new CaseStore({ file: join(dir, 'cases.json') }).add({ ...record(A, 'standard', 'rk-std-a', T0 - DAY), caseId: CASE });
    const h = hosted(dir);
    const out = await h.app.warmUp();
    assert.ok(out.some((w) => w.caseId === CASE), JSON.stringify(out));
  });
});

// ------------------------------------------------------------------------------------------------ ended: analysis kept

const postAs = (h: Hosted, path: string, body: unknown = {}) =>
  h.app(new Request(ORIGIN + path, { method: 'POST', headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', cookie: owner(h) }, body: JSON.stringify(body) }));
type AnalysisBody = { status?: string; key?: string; error?: string; detail?: string; analysis?: { key: string }; input?: { caseId: string } };
const analyse = async (h: Hosted, caseId: string, refresh = false) => {
  const r = await postAs(h, `/api/cases/${caseId}/analysis${refresh ? '?refresh=1' : ''}`);
  return { status: r.status, body: (await r.json()) as AnalysisBody };
};
/** The owner opens the case and waits for its live analysis to be ready; its key. */
async function analysedOnce(h: Hosted, caseId: string): Promise<string> {
  let a = await analyse(h, caseId);
  for (let i = 0; i < 400 && a.body.status !== 'ready'; i++) {
    await sleep(5);
    a = await analyse(h, caseId);
  }
  assert.equal(a.body.status, 'ready', JSON.stringify(a.body));
  return a.body.analysis!.key;
}
/** PayPal's dispute changes; the read cache's minute passes and the owner opens the case again (a fresh read). */
async function payPalMoves(h: Hosted, caseId: string, change: (d: Dispute) => Dispute) {
  h.pp.disputes[caseId] = change(h.pp.disputes[caseId]!);
  h.time.set(h.time.get() + 2 * MIN);
  await open(h, caseId);
}

test('ended discovered case: its analysis is kept and no live run starts (with or without refresh), even after later PayPal status changes; the caps are not spent', async () => {
  await withDir(async (dir) => {
    const h = hosted(dir, { seed: [record(A, 'standard', 'rk-std-a', T0 - DAY)] });
    await open(h, A);
    const key = await analysedOnce(h, A);
    assert.equal(h.starts.length, 1);
    const used = h.counters.state().caps['live-analysis']!.used;
    const hourly = h.analyst.liveState().remaining;
    // PayPal records the seller's evidence: the case ends. Then PayPal moves it on twice (each changes the read).
    await payPalMoves(h, A, (d) => ({ ...evidenceInDispute(), dispute_id: d.dispute_id, dispute_amount: d.dispute_amount, disputed_transactions: d.disputed_transactions }));
    assert.equal(h.store.get(A)!.endedBy, 'evidence');
    for (const status of [null, 'UNDER_REVIEW', 'WAITING_FOR_BUYER_RESPONSE'] as const) {
      if (status) await payPalMoves(h, A, (d) => ({ ...d, status, update_time: new Date(h.time.get()).toISOString() }));
      for (const refresh of [false, true]) {
        const a = await analyse(h, A, refresh);
        assert.equal(a.status, 200, `${status} refresh=${refresh}: ${JSON.stringify(a.body)}`);
        assert.equal(a.body.status, 'ready');
        assert.equal(a.body.analysis!.key, key, `${status} refresh=${refresh}: the earlier analysis`);
        assert.equal(a.body.input!.caseId, A);
      }
    }
    await sleep(20);
    assert.equal(h.starts.length, 1, 'no new live run');
    assert.equal(h.counters.state().caps['live-analysis']!.used, used);
    assert.equal(h.analyst.liveState().remaining, hourly);
  });
});

test('ended discovered case with no stored analysis: 409 CASE_ENDED, nothing runs; re-checking a sentence on an ended case is 409 CASE_ENDED', async () => {
  await withDir(async (dir) => {
    const h = hosted(dir, { seed: [record(A, 'standard', 'rk-std-a', T0 - DAY), record(B, 'standard', 'rk-std-b', T0 - DAY)] });
    h.pp.disputes[A] = { ...h.pp.disputes[A]!, status: 'RESOLVED', update_time: new Date(T0).toISOString(), dispute_outcome: { outcome_code: 'RESOLVED_BUYER_FAVOUR' } };
    await open(h, A);
    for (const refresh of [false, true]) {
      const a = await analyse(h, A, refresh);
      assert.equal(a.status, 409, JSON.stringify(a.body));
      assert.equal(a.body.error, 'CASE_ENDED');
      assert.match(a.body.detail!, /^This case has ended \(resolved\); it is read-only/);
    }
    // B was analysed while open, then ended: its re-check is refused before anything else.
    await open(h, B);
    await analysedOnce(h, B);
    await payPalMoves(h, B, (d) => ({ ...d, seller_response_due_date: new Date(h.time.get() - DAY).toISOString() }));
    const v = await postAs(h, `/api/cases/${B}/analysis/verify`, { text: 'Delivered on 9 October.' });
    const vb = (await v.json()) as AnalysisBody;
    assert.equal(v.status, 409, JSON.stringify(vb));
    assert.equal(vb.error, 'CASE_ENDED');
    await sleep(20);
    assert.deepEqual(h.starts.map((s) => s.caseId), [B]);
  });
});

test('open discovered case and fixed case: a refresh still runs the analysis live, as before (a fixed case past due is not ended)', async () => {
  await withDir(async (dir) => {
    const h = hosted(dir, { seed: [record(A, 'standard', 'rk-std-a', T0 - DAY)] });
    await open(h, A);
    await analysedOnce(h, A);
    assert.equal((await analyse(h, A, true)).status, 202);
    await until(() => h.starts.length === 2, 'the open case’s refresh');
    h.pp.disputes[BOUND] = { ...h.pp.disputes[BOUND]!, seller_response_due_date: new Date(T0 - DAY).toISOString() };
    await open(h, CASE);
    const f = await analyse(h, CASE);
    assert.equal(f.status, 202, JSON.stringify(f.body));
    await until(() => h.starts.length === 3, 'the fixed case’s run');
    assert.equal(h.starts[2]!.caseId, CASE);
  });
});

test('verify on a case that the request’s own fresh read finds ended: 409 CASE_ENDED, no re-check spent', async () => {
  await withDir(async (dir) => {
    const h = hosted(dir, { seed: [record(A, 'standard', 'rk-std-a', T0 - DAY)] });
    await open(h, A);
    await analysedOnce(h, A);
    // PayPal closes it; this server's last read still says open (no one opened the case since).
    h.pp.disputes[A] = { ...h.pp.disputes[A]!, status: 'RESOLVED', update_time: new Date(h.time.get()).toISOString(), dispute_outcome: { outcome_code: 'RESOLVED_BUYER_FAVOUR' } };
    h.time.set(h.time.get() + 2 * MIN);
    assert.equal(h.store.get(A)!.endedAt, undefined);
    const before = h.counters.state().caps['recheck']!.used;
    const v = await postAs(h, `/api/cases/${A}/analysis/verify`, { text: 'Delivered on 9 October.' });
    const vb = (await v.json()) as AnalysisBody;
    assert.equal(v.status, 409, JSON.stringify(vb));
    assert.equal(vb.error, 'CASE_ENDED');
    assert.equal(h.counters.state().caps['recheck']!.used, before);
  });
});

test('analysis-last.json records only discovered cases: a fixed case’s ready analysis is never written to it', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'analysis-last.json');
    const h = hosted(dir, { seed: [record(A, 'standard', 'rk-std-a', T0 - DAY)], lastReadyFile: file });
    await open(h, CASE);
    await analysedOnce(h, CASE);
    assert.ok(!existsSync(file) || !Object.hasOwn(JSON.parse(readFileSync(file, 'utf8')), CASE), 'no fixed case in the file');
    await open(h, A);
    await analysedOnce(h, A);
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(saved), [A]);
  });
});
