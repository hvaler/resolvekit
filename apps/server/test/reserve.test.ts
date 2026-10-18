import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DailyCounters } from '@resolvekit/hosting';
import { standardCase } from '@resolvekit/cases';
import { PayPalClient, type Dispute } from '@resolvekit/paypal';
import { parseBindingPools } from '../src/bindings.ts';
import { createHostedApp } from '../src/hosted.ts';
import { UploadError } from '../src/uploads/image.ts';
import { UploadStore } from '../src/uploads/store.ts';
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

function setup(raw: unknown, disputes: Record<string, Dispute>, now = () => NOW, delayMs = 0) {
  const p = parseBindingPools(raw);
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
  });
  return { app, reads, lines, people, store };
}

type Status = { ok: boolean; problems: string[]; bindings: Record<string, { dispute: string; status: string; used: boolean; reserve: number }> };
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
