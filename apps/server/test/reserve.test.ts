import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DailyCounters } from '@resolvekit/hosting';
import { standardCase } from '@resolvekit/cases';
import { PayPalClient, type Dispute } from '@resolvekit/paypal';
import { parseBindingPools } from '../src/bindings.ts';
import { createHostedApp } from '../src/hosted.ts';
import { UploadError } from '../src/uploads/image.ts';
import { UploadStore } from '../src/uploads/store.ts';
import { ReserveMemory, keepHeldActive } from '../src/reserve.ts';
import { IntentStore } from '../src/intents.ts';
import { CASE as ACTION_CASE, REAL, TOKEN, answer, approve, compose, confirm, readBack, recordedDispute, send, setupActions } from './actions-kit.ts';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STD_CAPTURE, TEST_SECRET, standardDispute, testAccounts } from './kit.ts';

const ORIGIN = 'https://rk.example.com';
const HOST = 'rk.example.com';
const CASE = standardCase.summary.id;
const OPS = 'o'.repeat(20) + '0123456789abcdef';
const CAP = (n: number) => `${STD_CAPTURE.slice(0, -2)}${String(n).padStart(2, '0')}`;
const A = { dispute: 'PP-R-POOL-1', capture: CAP(1) };
const B = { dispute: 'PP-R-POOL-2', capture: CAP(2) };
const C = { dispute: 'PP-R-POOL-3', capture: CAP(3) };
const NOW = new Date('2026-12-03T10:00:00Z');
const MIN = 60_000;

// ------------------------------------------------------------------------------------------------ parsing

test('a case can be bound to a list: the first is active, the rest is the reserve, in order', () => {
  const p = parseBindingPools({ [CASE]: [A, B, C], _note: 'comments are skipped' });
  assert.deepEqual(p.bindings, { [CASE]: A });
  assert.deepEqual(p.reserve, { [CASE]: [B, C] });
});

test('single bindings still read as before, with an empty reserve', () => {
  const p = parseBindingPools({ [CASE]: A, other: 'PP-R-OLD-1' });
  assert.deepEqual(p.bindings, { [CASE]: A, other: { dispute: 'PP-R-OLD-1', capture: null } });
  assert.deepEqual(p.reserve, { [CASE]: [], other: [] });
});

test('an empty list, a bad entry or the same dispute twice stops the start', () => {
  assert.throws(() => parseBindingPools({ [CASE]: [] }), /at least one/);
  assert.throws(() => parseBindingPools({ [CASE]: [A, { dispute: 'nope' }] }), new RegExp(CASE));
  assert.throws(() => parseBindingPools({ [CASE]: [A, { ...A, capture: CAP(9) }] }), /twice/);
});

// ------------------------------------------------------------------------------------------------ rotation

/** A dispute of the pool: waiting for the seller, or with the seller's evidence recorded at `evidenceAt`, or resolved. */
function poolDispute(b: { dispute: string; capture: string }, state: { evidenceAt?: string; resolved?: boolean } = {}): Dispute {
  const d = standardDispute();
  const tx = { ...d.disputed_transactions![0]!, seller_transaction_id: b.capture };
  const base: Dispute = { ...d, dispute_id: b.dispute, disputed_transactions: [tx] };
  if (state.resolved) return { ...base, status: 'RESOLVED', links: [{ rel: 'self' }] };
  if (!state.evidenceAt) return base;
  return {
    ...base,
    status: 'UNDER_REVIEW',
    evidences: [d.evidences![0]!, { evidence_type: 'PROOF_OF_FULFILLMENT', source: 'SUBMITTED_BY_SELLER', date: state.evidenceAt, action_info: { action: 'PROVIDE_EVIDENCE' } }],
    links: [{ rel: 'self' }],
  };
}

function setup(raw: unknown, disputes: Record<string, Dispute>, now = () => NOW, delayMs = 0, reserveMemory?: ReserveMemory, intents?: IntentStore) {
  const p = parseBindingPools(raw);
  // What main.ts does at start: skip the disputes remembered as used (never one held by an action).
  const skipped = reserveMemory?.apply(p, intents ? (d) => intents.held(d) : undefined) ?? [];
  const reads: string[] = [];
  const lines: string[] = [];
  const fetch = (async (url: string | URL) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
    const id = decodeURIComponent(u.pathname.split('/').pop()!);
    reads.push(id);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const d = disputes[id];
    return d ? new Response(JSON.stringify(d), { status: 200 }) : new Response('{"name":"RESOURCE_NOT_FOUND"}', { status: 404 });
  }) as typeof globalThis.fetch;
  const people = testAccounts(now);
  const store = new UploadStore({ dir: null, now });
  const app = createHostedApp({
    paypal: new PayPalClient({ clientId: 'cid', clientSecret: 'secret', env: 'sandbox', fetch }),
    env: 'sandbox',
    bindings: p.bindings,
    reserve: p.reserve,
    log: (l) => lines.push(l),
    counters: new DailyCounters({ file: null, limits: { 'live-analysis': 5, upload: 40 } }),
    site: null,
    accounts: people.accounts,
    identity: null,
    sessionSecret: TEST_SECRET,
    origins: [ORIGIN],
    hosts: [HOST],
    https: true,
    webhook: { id: 'WEBHOOK0123456789', key: 'k'.repeat(40) },
    opsToken: OPS,
    uploads: store,
    now,
    ...(reserveMemory ? { reserveMemory } : {}),
    ...(intents ? { intents } : {}),
  });
  return { app, reads, lines, people, store, pools: p, skipped };
}

type Status = { ok: boolean; problems: string[]; bindings: Record<string, { dispute: string; status: string; used: boolean; reserve: number; held: { intentId: string; since: string } | null }> };
const status = async (app: ReturnType<typeof setup>['app']) =>
  (await (await app(new Request(`${ORIGIN}/api/ops/status`, { headers: { host: HOST, 'x-forwarded-for': '203.0.113.9', authorization: `Bearer ${OPS}` } }))).json()) as Status;

test('an unused active dispute stays; the check says how many are in reserve', async () => {
  const { app } = setup({ [CASE]: [A, B] }, { [A.dispute]: poolDispute(A), [B.dispute]: poolDispute(B) });
  const s = await status(app);
  assert.deepEqual(s.bindings[CASE], { ...s.bindings[CASE], dispute: A.dispute, status: 'verified', used: false, reserve: 1 });
  assert.equal(s.ok, true, s.problems.join(' | '));
});

test('a dispute whose seller evidence is older than 15 min is used: the case moves to the next one in reserve', async () => {
  const old = new Date(NOW.getTime() - 16 * MIN).toISOString();
  const { app, lines } = setup({ [CASE]: [A, B, C] }, { [A.dispute]: poolDispute(A, { evidenceAt: old }), [B.dispute]: poolDispute(B), [C.dispute]: poolDispute(C) });
  await status(app);
  const s = await status(app);
  assert.equal(s.bindings[CASE]!.dispute, B.dispute);
  assert.equal(s.bindings[CASE]!.status, 'verified');
  assert.equal(s.bindings[CASE]!.reserve, 1);
  assert.ok(lines.some((l) => l.includes(`reserve · case ${CASE}`) && l.includes(A.dispute) && l.includes(B.dispute)), lines.join('\n'));
});

test('evidence sent minutes ago keeps the dispute, so whoever sent it sees PayPal’s read-back', async () => {
  const recent = new Date(NOW.getTime() - 5 * MIN).toISOString();
  let t = NOW;
  const { app } = setup({ [CASE]: [A, B] }, { [A.dispute]: poolDispute(A, { evidenceAt: recent }), [B.dispute]: poolDispute(B) }, () => t);
  await status(app);
  assert.equal((await status(app)).bindings[CASE]!.dispute, A.dispute);
  t = new Date(NOW.getTime() + 11 * MIN);
  await status(app);
  assert.equal((await status(app)).bindings[CASE]!.dispute, B.dispute);
});

test('a resolved dispute (closed, or expired by PayPal) is used at once', async () => {
  const { app } = setup({ [CASE]: [A, B] }, { [A.dispute]: poolDispute(A, { resolved: true }), [B.dispute]: poolDispute(B) });
  await status(app);
  assert.equal((await status(app)).bindings[CASE]!.dispute, B.dispute);
});

test('several used ones in a row are skipped, one per read', async () => {
  const old = new Date(NOW.getTime() - 60 * MIN).toISOString();
  const { app } = setup({ [CASE]: [A, B, C] }, { [A.dispute]: poolDispute(A, { resolved: true }), [B.dispute]: poolDispute(B, { evidenceAt: old }), [C.dispute]: poolDispute(C) });
  await status(app);
  await status(app);
  const s = await status(app);
  assert.equal(s.bindings[CASE]!.dispute, C.dispute);
  assert.equal(s.bindings[CASE]!.reserve, 0);
});

test('used and nothing in reserve: the case keeps it, and the check says the reserve is empty', async () => {
  const old = new Date(NOW.getTime() - 60 * MIN).toISOString();
  const { app } = setup({ [CASE]: [A] }, { [A.dispute]: poolDispute(A, { evidenceAt: old }) });
  await status(app);
  const s = await status(app);
  assert.equal(s.bindings[CASE]!.dispute, A.dispute);
  assert.equal(s.bindings[CASE]!.used, true);
  assert.equal(s.ok, false);
  assert.ok(s.problems.some((p) => p.includes(CASE) && /reserve/.test(p)), s.problems.join(' | '));
});

test('two reads at once of a used dispute move the case one step, not two (no reserve dispute is skipped)', async () => {
  const old = new Date(NOW.getTime() - 60 * MIN).toISOString();
  const { app } = setup({ [CASE]: [A, B, C] }, { [A.dispute]: poolDispute(A, { evidenceAt: old }), [B.dispute]: poolDispute(B), [C.dispute]: poolDispute(C) }, () => NOW, 20);
  await Promise.all([status(app), status(app), status(app)]);
  const s = await status(app);
  assert.equal(s.bindings[CASE]!.dispute, B.dispute);
  assert.equal(s.bindings[CASE]!.reserve, 1);
});

test('seller evidence without a usable date: the 15 min run from when the server first saw it used', async () => {
  let t = NOW;
  const used = poolDispute(A, { evidenceAt: 'not a date' });
  const { app } = setup({ [CASE]: [A, B] }, { [A.dispute]: used, [B.dispute]: poolDispute(B) }, () => t);
  await status(app);
  assert.equal((await status(app)).bindings[CASE]!.dispute, A.dispute);
  t = new Date(NOW.getTime() + 16 * MIN);
  await status(app);
  assert.equal((await status(app)).bindings[CASE]!.dispute, B.dispute);
});

test('an evidence date in the future counts as now (it cannot hold the case longer than 15 min)', async () => {
  let t = NOW;
  const { app } = setup({ [CASE]: [A, B] }, { [A.dispute]: poolDispute(A, { evidenceAt: new Date(NOW.getTime() + 600 * MIN).toISOString() }), [B.dispute]: poolDispute(B) }, () => t);
  await status(app);
  t = new Date(NOW.getTime() + 16 * MIN);
  await status(app);
  assert.equal((await status(app)).bindings[CASE]!.dispute, B.dispute);
});

test('a judge who only opens the case moves it on too (no operator check needed)', async () => {
  const old = new Date(NOW.getTime() - 60 * MIN).toISOString();
  const { app, people } = setup({ [CASE]: [A, B] }, { [A.dispute]: poolDispute(A, { evidenceAt: old }), [B.dispute]: poolDispute(B) });
  const judge = people.member('Judge 2');
  const view = () => app(new Request(`${ORIGIN}/api/disputes/${CASE}`, { headers: { host: HOST, 'x-forwarded-for': '203.0.113.7', cookie: judge } }));
  assert.equal((await view()).status, 200);
  const next = (await (await view()).json()) as { origin?: { disputeId?: string } };
  assert.equal(next.origin?.disputeId, B.dispute);
});

// ------------------------------------------------------------------------------------------------ uploads

const UP = `/api/cases/${CASE}/uploads`;
type UpView = { id: string; status: string; sha256: string | null };
const api = async (app: ReturnType<typeof setup>['app'], path: string, cookie: string, body?: unknown) => {
  const r = await app(new Request(`${ORIGIN}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { host: HOST, 'x-forwarded-for': '203.0.113.7', cookie, ...(body === undefined ? {} : { origin: ORIGIN, 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: r.status, body: (await r.json()) as { upload?: UpView; uploads?: UpView[]; error?: string } };
};
const pasted = async (app: ReturnType<typeof setup>['app'], cookie: string) => {
  const r = await api(app, UP, cookie, { text: ['From: buyer', 'The parcel arrived, thanks.'].join('\n'), name: 'email.txt' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.upload!;
};

test('when the case moves to the next dispute its uploads are archived and the next judge starts clean', async () => {
  let t = NOW;
  const old = new Date(NOW.getTime() - 60 * MIN).toISOString();
  const disputes: Record<string, Dispute> = { [A.dispute]: poolDispute(A), [B.dispute]: poolDispute(B) };
  const { app, people, store, lines } = setup({ [CASE]: [A, B] }, disputes, () => t);
  const judge = people.member('Judge 1');
  const up = await pasted(app, judge);
  const red = await api(app, `${UP}/${up.id}/redact`, judge, { removals: [] });
  assert.equal(red.status, 200, JSON.stringify(red.body));
  const conf = await api(app, `${UP}/${up.id}/confirm`, judge, { sha256: red.body.upload!.sha256, lines: (red.body as { readLines?: string[] }).readLines });
  assert.equal(conf.status, 200, JSON.stringify(conf.body));
  const pending = await pasted(app, judge);
  assert.equal((await api(app, UP, judge)).body.uploads!.length, 2);

  // The seller's evidence goes in on A; once it is used, the next read moves the case to B.
  disputes[A.dispute] = poolDispute(A, { evidenceAt: old });
  await status(app);
  const s = await status(app);
  assert.equal(s.bindings[CASE]!.dispute, B.dispute);

  assert.equal(store.get(up.id)!.status, 'archived');
  assert.equal(store.get(pending.id)!.status, 'archived');
  assert.deepEqual((await api(app, UP, people.member('Judge 2'))).body.uploads, []);
  assert.ok(lines.some((l) => l.includes(`reserve · case ${CASE}: 2 upload(s) archived`)), lines.join(' | '));
  assert.ok(!lines.some((l) => l.includes('parcel arrived')));
});

test('a storage error while archiving never breaks the request that moved the case; the log carries counts only', async () => {
  const old = new Date(NOW.getTime() - 60 * MIN).toISOString();
  const disputes: Record<string, Dispute> = { [A.dispute]: poolDispute(A), [B.dispute]: poolDispute(B) };
  const { app, people, store, lines } = setup({ [CASE]: [A, B] }, disputes);
  const judge = people.member('Judge 1');
  const broken = await pasted(app, judge);
  const fine = await pasted(app, judge);
  const update = store.update.bind(store);
  store.update = (id, patch, files) => {
    if (id === broken.id && patch.status === 'archived') throw new UploadError('STORAGE', 'Upload storage failed: record.json');
    return update(id, patch, files);
  };
  disputes[A.dispute] = poolDispute(A, { evidenceAt: old });
  const view = () => app(new Request(`${ORIGIN}/api/disputes/${CASE}`, { headers: { host: HOST, 'x-forwarded-for': '203.0.113.7', cookie: judge } }));
  assert.equal((await view()).status, 200);
  const next = await view();
  assert.equal(next.status, 200);
  assert.equal(((await next.json()) as { origin?: { disputeId?: string } }).origin?.disputeId, B.dispute);
  assert.equal(store.get(fine.id)!.status, 'archived');
  assert.equal(store.get(broken.id)!.status, 'pending');
  assert.ok(lines.some((l) => l.includes(`reserve · case ${CASE}: 1 upload(s) archived, 1 could not be archived`)), lines.join(' | '));
  assert.ok(!lines.some((l) => l.includes('parcel arrived') || l.includes('email.txt')));
});

test('an upload pending before a rotation cannot be confirmed afterwards (409 UPLOAD_ARCHIVED)', async () => {
  const old = new Date(NOW.getTime() - 60 * MIN).toISOString();
  const disputes: Record<string, Dispute> = { [A.dispute]: poolDispute(A), [B.dispute]: poolDispute(B) };
  const { app, people } = setup({ [CASE]: [A, B] }, disputes);
  const judge = people.member('Judge 1');
  const up = await pasted(app, judge);
  const red = await api(app, `${UP}/${up.id}/redact`, judge, { removals: [] });
  assert.equal(red.status, 200, JSON.stringify(red.body));
  const lines = (red.body as { readLines?: string[] }).readLines;

  disputes[A.dispute] = poolDispute(A, { evidenceAt: old });
  await status(app);
  assert.equal((await status(app)).bindings[CASE]!.dispute, B.dispute);

  const conf = await api(app, `${UP}/${up.id}/confirm`, judge, { sha256: red.body.upload!.sha256, lines });
  assert.equal(conf.status, 409);
  assert.equal(conf.body.error, 'UPLOAD_ARCHIVED');
  const again = await api(app, `${UP}/${up.id}/redact`, judge, { removals: [] });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'UPLOAD_ARCHIVED');
});

// ------------------------------------------------------------------------------------------------ position across restarts

test('restart: the reserve position is on the data dir, so a new process starts past the disputes already used', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-reserve-'));
  try {
    const file = join(dir, 'reserve-position.json');
    const old = new Date(NOW.getTime() - 60 * MIN).toISOString();
    const disputes = { [A.dispute]: poolDispute(A, { resolved: true }), [B.dispute]: poolDispute(B, { evidenceAt: old }), [C.dispute]: poolDispute(C) };
    const first = setup({ [CASE]: [A, B, C] }, disputes, () => NOW, 0, new ReserveMemory({ file }));
    await status(first.app);
    await status(first.app);
    assert.equal((await status(first.app)).bindings[CASE]!.dispute, C.dispute);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { v: 1, used: { [CASE]: [A.dispute, B.dispute] } });
    // The same BINDINGS_JSON after a restart: C is active at once, A and B are never read again.
    const lines: string[] = [];
    const second = setup({ [CASE]: [A, B, C] }, disputes, () => NOW, 0, new ReserveMemory({ file, log: (l) => lines.push(l) }));
    assert.deepEqual(second.skipped, [{ caseId: CASE, skipped: [A.dispute, B.dispute], active: C.dispute }]);
    const s = await status(second.app);
    assert.equal(s.bindings[CASE]!.dispute, C.dispute);
    assert.equal(s.bindings[CASE]!.reserve, 0);
    assert.ok(!second.reads.includes(A.dispute) && !second.reads.includes(B.dispute), second.reads.join(','));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a position that no longer matches the bindings is ignored safely: other disputes, other cases, never the last one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-reserve-'));
  try {
    const file = join(dir, 'reserve-position.json');
    writeFileSync(file, JSON.stringify({ v: 1, used: { [CASE]: ['PP-R-GONE-9', B.dispute, C.dispute], 'other-case': [A.dispute] } }));
    const m = new ReserveMemory({ file });
    // A is first and not used: nothing moves (B is used but behind an unused one).
    let p = parseBindingPools({ [CASE]: [A, B, C] });
    assert.deepEqual(m.apply(p), []);
    assert.deepEqual(p.bindings[CASE], A);
    // Trimmed to [B, C]: B is skipped; C, the last configured, stays active even though it is remembered as used.
    p = parseBindingPools({ [CASE]: [B, C] });
    assert.deepEqual(m.apply(p), [{ caseId: CASE, skipped: [B.dispute], active: C.dispute }]);
    assert.deepEqual(p.bindings[CASE], C);
    assert.deepEqual(p.reserve[CASE], []);
    // A single binding (no reserve) is never moved.
    p = parseBindingPools({ [CASE]: C });
    assert.deepEqual(m.apply(p), []);
    assert.deepEqual(p.bindings[CASE], C);
    assert.equal(m.storageProblem(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable reserve-position.json is preserved and reported; every case walks its list as before', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-reserve-'));
  try {
    const file = join(dir, 'reserve-position.json');
    writeFileSync(file, '{"v":1,"used":');
    const lines: string[] = [];
    const m = new ReserveMemory({ file, now: () => NOW, log: (l) => lines.push(l) });
    assert.match(m.storageProblem()!, /could not be read; preserved as/);
    assert.ok(readdirSync(dir).some((f) => f.startsWith('reserve-position.json.corrupt-')));
    assert.ok(lines.some((l) => /ERROR reserve/.test(l)));
    const p = parseBindingPools({ [CASE]: [A, B] });
    assert.deepEqual(m.apply(p), []);
    m.markUsed(CASE, A.dispute);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { v: 1, used: { [CASE]: [A.dispute] } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------------ rotation guard

/** A store whose send log (on disk) has an action send_started on `dispute` and nothing after it: held at start. */
function heldStore(dir: string, dispute: string, intentId = `int-${'1'.repeat(32)}`): IntentStore {
  const files = { file: join(dir, 'intents.json'), eventsFile: join(dir, 'audit-events.jsonl') };
  const first = new IntentStore({ ...files, now: () => NOW });
  const w = first.recordChecked({ caseId: CASE, kind: 'send_started', actor: 'Northwind Goods (owner)', disputeId: dispute, intentId, contentHash: 'c'.repeat(64), requestId: 'rk-held-1', action: 'accept_claim', scope: 'action', stage: 'INQUIRY' });
  assert.equal(w.durable, true);
  first.flush();
  return new IntentStore({ ...files, now: () => NOW });
}

test('rotateIfUsed holds a dispute that is in flight, uncertain or awaiting read-back; read-back reads the pinned dispute', async () => {
  const NEXT = 'PP-R-POOL-NEXT';
  const disputes: Record<string, Dispute> = { [REAL]: recordedDispute(), [NEXT]: { ...recordedDispute(), dispute_id: NEXT } };
  const { app, pp, intents, state } = await setupActions({ dispute: (id) => disputes[id] ?? disputes[REAL]!, reserve: { [ACTION_CASE]: [{ dispute: NEXT, capture: STD_CAPTURE }] }, postDelayMs: 40 });
  const view = async () => {
    const r = await app(new Request(`http://127.0.0.1:8787/api/disputes/${ACTION_CASE}`, { headers: { 'x-resolvekit-token': TOKEN } }));
    const b = await answer(r);
    assert.equal(b.status, 200, JSON.stringify(b.body));
    return b.body as { origin?: { disputeId?: string } };
  };
  const i = await compose(app, { action: 'accept_claim', acceptType: 'REFUND' });
  const a = await approve(app, i);
  assert.equal((await confirm(app, i, a.body.confirmation)).status, 200);
  // In flight: the POST has not answered and PayPal already shows the dispute resolved. A read does not move the case.
  const sending = send(app, i);
  while (pp.posts.length === 0) await new Promise((r) => setTimeout(r, 1));
  assert.ok(intents.held(REAL));
  disputes[REAL] = { ...recordedDispute(), status: 'RESOLVED' };
  await view();
  assert.equal((await view()).origin?.disputeId, REAL);
  const s = await sending;
  assert.equal(s.status, 202, JSON.stringify(s.body));
  // Accepted, not proven (awaiting read-back): uncertain, still held. Reads keep the case on its dispute.
  assert.ok(intents.isUncertain(REAL));
  state.t += 20 * MIN;
  await view();
  assert.equal((await view()).origin?.disputeId, REAL);
  // Read back as recorded: the dispute is free, so the next read moves the case on.
  assert.equal(intents.recordReadBack(i.id, { state: 'recorded', detail: 'Recorded by PayPal' }), true);
  assert.equal(intents.held(REAL), false);
  assert.equal((await view()).origin?.disputeId, REAL);
  assert.equal((await view()).origin?.disputeId, NEXT);
  // Reading this intent back again reads the dispute pinned in it, not the case's new one.
  const before = pp.reads.length;
  const rb = await readBack(app, i);
  assert.equal(rb.status, 200, JSON.stringify(rb.body));
  assert.deepEqual(pp.reads.slice(before).filter((p) => p.includes('/disputes/')), [`/v1/customer/disputes/${REAL}`]);
});

test('ReserveMemory.apply on start honours held', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-reserve-'));
  try {
    const file = join(dir, 'reserve-position.json');
    writeFileSync(file, JSON.stringify({ v: 1, used: { [CASE]: [A.dispute] } }));
    const intents = heldStore(dir, A.dispute);
    assert.ok(intents.held(A.dispute));
    // A is resolved at PayPal (the accept went through) but its send was never proven: the case stays on A.
    const disputes = { [A.dispute]: poolDispute(A, { resolved: true }), [B.dispute]: poolDispute(B) };
    const { app, skipped } = setup({ [CASE]: [A, B] }, disputes, () => NOW, 0, new ReserveMemory({ file }), intents);
    assert.deepEqual(skipped, []);
    await status(app);
    assert.equal((await status(app)).bindings[CASE]!.dispute, A.dispute);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a bindings reload that replaces bindings wholesale keeps a held dispute active', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-reserve-'));
  try {
    const m = new ReserveMemory({ file: join(dir, 'reserve-position.json') });
    m.markUsed(CASE, A.dispute);
    const intents = heldStore(dir, A.dispute);
    // What main.ts does on a changed bindings file: a new object, applied with the guard.
    const next = parseBindingPools({ [CASE]: [A, B, C] });
    assert.deepEqual(m.apply(next, (d) => intents.held(d)), []);
    assert.deepEqual(next.bindings[CASE], A);
    assert.deepEqual(next.reserve[CASE], [B, C]);
    // Held further down the list: it stops there, never shifting past it.
    m.markUsed(CASE, B.dispute);
    const later = parseBindingPools({ [CASE]: [B, A, C] });
    assert.deepEqual(m.apply(later, (d) => intents.held(d)), [{ caseId: CASE, skipped: [B.dispute], active: A.dispute }]);
    // Nothing held: lote2's behaviour (A used → B).
    const free = parseBindingPools({ [CASE]: [A, B, C] });
    assert.deepEqual(m.apply(free, () => false), [{ caseId: CASE, skipped: [A.dispute, B.dispute], active: C.dispute }]);
    const plain = parseBindingPools({ [CASE]: [A, C] });
    assert.deepEqual(m.apply(plain), [{ caseId: CASE, skipped: [A.dispute], active: C.dispute }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ops report names a held dispute', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-reserve-'));
  try {
    const intentId = `int-${'2'.repeat(32)}`;
    const intents = heldStore(dir, A.dispute, intentId);
    const { app } = setup({ [CASE]: [A, B] }, { [A.dispute]: poolDispute(A), [B.dispute]: poolDispute(B) }, () => NOW, 0, undefined, intents);
    const s = await status(app);
    assert.equal(s.bindings[CASE]!.held?.intentId, intentId);
    assert.equal(typeof s.bindings[CASE]!.held?.since, 'string');
    const free = setup({ [CASE]: [A, B] }, { [A.dispute]: poolDispute(A), [B.dispute]: poolDispute(B) });
    assert.equal((await status(free.app)).bindings[CASE]!.held, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a bindings reload that reorders the list keeps a held active dispute active', () => {
  const D = { dispute: 'PP-R-POOL-4', capture: CAP(4) };
  const held = (d: string) => d === A.dispute;
  const current = parseBindingPools({ [CASE]: [A, B] });
  // The new file lists D first and A second: A is held, so it stays active and D waits behind it.
  const next = parseBindingPools({ [CASE]: [D, A] });
  assert.deepEqual(keepHeldActive(current, next, held), [{ caseId: CASE, active: A.dispute }]);
  assert.deepEqual(next.bindings[CASE], A);
  assert.deepEqual(next.reserve[CASE], [D]);
  // Nothing held, or the held dispute no longer listed: the new file wins as before.
  const free = parseBindingPools({ [CASE]: [D, A] });
  assert.deepEqual(keepHeldActive(current, free, () => false), []);
  assert.deepEqual(free.bindings[CASE], D);
  const gone = parseBindingPools({ [CASE]: [D, B] });
  assert.deepEqual(keepHeldActive(current, gone, held), []);
  assert.deepEqual(gone.bindings[CASE], D);
  // Already first: nothing to report.
  const same = parseBindingPools({ [CASE]: [A, D] });
  assert.deepEqual(keepHeldActive(current, same, held), []);
});
