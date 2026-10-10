/**
 * Regressions for the adversarial review of the intent flow (fake PayPal only; nothing is sent anywhere):
 * 1. two intents for the same dispute never both send; 2. one session cannot fill the store or evict others' audit;
 * 4. a failed intent cannot be resent forever; 5. an edit during a send voids the approval if the send fails;
 * 6. someone else's analysis re-run does not change (or stale) my approved intent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DailyCounters } from '@resolvekit/hosting';
import { PayPalClient } from '@resolvekit/paypal';
import { caseInput, standardCase } from '@resolvekit/cases';
import { analysisKey } from '@resolvekit/analyst/node';
import { createHostedApp } from '../src/hosted.ts';
import { IntentStore, MAX_OPEN, type StoredIntent } from '../src/intents.ts';
import { toSnapshot } from '../src/mapping.ts';
import { MODEL, RESOLVED, STD_CAPTURE, TEST_SECRET, analystFor, standardDispute, testAccounts } from './kit.ts';

const ORIGIN = 'https://rk.example.com';
const HOST = 'rk.example.com';
const REAL = 'PP-R-REAL-1';
const CASE = standardCase.summary.id;
const base = `/api/disputes/${CASE}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** PayPal by path. `neverShows`: PayPal accepts sends but its read never shows the evidence (a lagging read). */
function routedPayPal(o: { readDelay?: number; sendStatus?: number; neverShows?: boolean; failReads?: { on: boolean } } = {}) {
  let sent = false;
  const sends: string[] = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
    if (u.pathname.endsWith('/provide-evidence')) {
      sends.push(new Headers(init.headers).get('paypal-request-id') ?? '');
      if (o.sendStatus) return new Response(JSON.stringify({ name: 'UNPROCESSABLE_ENTITY' }), { status: o.sendStatus });
      sent = !o.neverShows;
      return new Response(JSON.stringify({ links: [] }), { status: 200 });
    }
    if (o.failReads?.on) {
      await sleep(60);
      return new Response('{}', { status: 500 });
    }
    if (o.readDelay) await sleep(o.readDelay);
    const d = sent
      ? standardDispute({ status: 'WAITING_FOR_BUYER_RESPONSE', evidences: [{ evidence_type: 'PROOF_OF_FULFILLMENT', source: 'SUBMITTED_BY_SELLER', date: '2026-10-09T09:00:00Z', action_info: { action: 'PROVIDE_EVIDENCE' } }], links: [{ rel: 'self' }] })
      : standardDispute();
    return new Response(JSON.stringify(d), { status: 200 });
  }) as typeof globalThis.fetch;
  return { sends, client: new PayPalClient({ clientId: 'cid', clientSecret: 'secret', env: 'sandbox', fetch }) };
}

async function setup(ppo: Parameters<typeof routedPayPal>[0] = {}, extra: { now?: () => Date; intents?: IntentStore } = {}) {
  const pp = routedPayPal(ppo);
  const input = caseInput(standardCase, { kind: 'live', snap: toSnapshot(standardDispute(), CASE, 'sandbox', new Date()), failed: null });
  const { analyst, store } = await analystFor([[CASE, input]]);
  const people = testAccounts(extra.now);
  const app = createHostedApp({
    paypal: pp.client,
    env: 'sandbox',
    bindings: { [CASE]: { dispute: REAL, capture: STD_CAPTURE } },
    analyst,
    site: null,
    counters: new DailyCounters({ file: null, limits: { 'live-analysis': 5, recheck: 50, evidence: 50 } }),
    accounts: people.accounts,
    identity: null,
    sessionSecret: TEST_SECRET,
    origins: [ORIGIN],
    hosts: [HOST],
    https: true,
    ...extra,
  });
  teams.set(app, people);
  return { app, pp, store, input, people };
}
const teams = new WeakMap<object, ReturnType<typeof testAccounts>>();
type App = Awaited<ReturnType<typeof setup>>['app'];
const req = (path: string, i: { body?: unknown; cookie?: string; ip?: string } = {}) => {
  const method = i.body !== undefined ? 'POST' : 'GET';
  const headers: Record<string, string> = { host: HOST, 'x-forwarded-for': i.ip ?? '203.0.113.7', ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/json' } : {}), ...(i.cookie ? { cookie: i.cookie } : {}) };
  return new Request(ORIGIN + path, { method, headers, ...(i.body !== undefined ? { body: JSON.stringify(i.body) } : {}) });
};
/** A new person of the seller's workspace (signed in). */
async function unlock(app: App, _ip: string): Promise<string> {
  return teams.get(app)!.member();
}
type Intent = { id: string; contentHash: string; status: string; notes: string };
async function composeApproved(app: App, cookie: string, ip: string): Promise<Intent> {
  const r = await app(req(`${base}/intent`, { body: { evidenceType: 'PROOF_OF_FULFILLMENT', resolutions: RESOLVED }, cookie, ip }));
  const i = (await r.json()) as Intent;
  assert.equal(r.status, 201, JSON.stringify(i));
  assert.equal((await app(req(`${base}/intent/${i.id}/approve`, { body: { contentHash: i.contentHash }, cookie, ip }))).status, 200);
  return i;
}
const send = (app: App, i: Intent, cookie: string, ip: string) => app(req(`${base}/evidence`, { body: { intentId: i.id }, cookie, ip }));
const status = async (app: App, i: Intent, cookie: string, ip: string) => ((await (await app(req(`${base}/intent/${i.id}`, { cookie, ip }))).json()) as Intent).status;

// ------------------------------------------------------------------------------------------------ 1

test('review 1: two sessions’ intents for the same dispute, confirmed at the same time, send once', async () => {
  const { app, pp } = await setup({ readDelay: 50 });
  const a = await unlock(app, '198.51.100.1');
  const b = await unlock(app, '198.51.100.2');
  const ia = await composeApproved(app, a, '198.51.100.1');
  const ib = await composeApproved(app, b, '198.51.100.2');
  const [ra, rb] = await Promise.all([send(app, ia, a, '198.51.100.1'), send(app, ib, b, '198.51.100.2')]);
  assert.deepEqual([ra.status, rb.status].sort(), [202, 409]);
  assert.equal(pp.sends.length, 1);
});

test('review 1: once PayPal accepted one intent for a dispute, another is refused even while PayPal’s read lags (persisted)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-review1-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'intents.json');
  const { app, pp } = await setup({ neverShows: true }, { intents: new IntentStore({ file }) });
  const a = await unlock(app, '198.51.100.1');
  const b = await unlock(app, '198.51.100.2');
  const ia = await composeApproved(app, a, '198.51.100.1');
  const ib = await composeApproved(app, b, '198.51.100.2');
  assert.equal((await send(app, ia, a, '198.51.100.1')).status, 202);
  const r = await send(app, ib, b, '198.51.100.2');
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as { error: string }).error, 'SELLER_EVIDENCE_EXISTS');
  assert.equal(pp.sends.length, 1);
  // The fact survives a restart.
  assert.equal(new IntentStore({ file }).sentFor(REAL)?.intentId, ia.id);
});

// ------------------------------------------------------------------------------------------------ 2

test('review 2: one person rotating addresses cannot fill the store, evict a judge’s trail, or block a new judge', async () => {
  const { app, people } = await setup({ neverShows: true });
  const judge = await unlock(app, '198.51.100.1');
  const i = await composeApproved(app, judge, '198.51.100.1');
  assert.equal((await send(app, i, judge, '198.51.100.1')).status, 202);
  const trail = async () => ((await (await app(req(`${base}/audit`, { cookie: judge, ip: '198.51.100.1' }))).json()) as { events: Array<{ kind: string }> }).events.map((e) => e.kind);
  const before = await trail();
  assert.deepEqual(before, ['intent_created', 'intent_approved', 'send_started', 'sent']);
  // Another PayPal account's workspace: its intents run on the simulator, but they go into the same store.
  const attacker = people.outsider();
  const codes: Record<number, number> = {};
  for (let n = 0; n < 2100; n++) {
    const ip = `10.0.${(Math.floor(n / 20) >> 8) & 255}.${Math.floor(n / 20) & 255}`;
    const r = await app(req(`${base}/intent`, { body: { evidenceType: 'PROOF_OF_FULFILLMENT', resolutions: RESOLVED }, cookie: attacker, ip }));
    codes[r.status] = (codes[r.status] ?? 0) + 1;
  }
  // The session is held to its own creation rate whatever its addresses.
  assert.ok((codes[201] ?? 0) <= 30, JSON.stringify(codes));
  assert.deepEqual(await trail(), before);
  const judge2 = await unlock(app, '198.51.100.9');
  const r = await app(req(`${base}/intent`, { body: { evidenceType: 'PROOF_OF_FULFILLMENT', resolutions: RESOLVED }, cookie: judge2, ip: '198.51.100.9' }));
  assert.equal(r.status, 201);
});

const draft = (owner: string, ip = `ip-${owner}`): Omit<StoredIntent, 'id' | 'status' | 'createdAt' | 'expiresAt' | 'approvedBy' | 'approvedAt' | 'sentAt' | 'reason' | 'requestId'> => ({
  caseId: CASE, disputeId: REAL, documentsHash: 'd', analysisKey: 'k', evidenceType: 'OTHER', carrier: '', tracking: '', notes: 'n', files: [], sentences: [], resolutionNotes: [],
  contentHash: 'h', request: { evidenceType: 'OTHER', edits: {}, resolutions: {} }, rechecks: {}, createdBy: owner, createdFrom: ip,
});

test('review 2: replaced intents leave the store at once; at the global cap the retry time is when one really frees up', () => {
  let now = Date.parse('2026-10-09T08:00:00Z');
  const s = new IntentStore({ now: () => new Date(now) });
  for (let k = 0; k < 25; k++) s.create(draft('one'));
  assert.equal(s.size(), 1);
  for (let k = 1; k < MAX_OPEN; k++) s.create(draft(`s${k}`));
  now += 10 * 60_000; // 10 minutes later: the oldest intent expires in 20 minutes
  const r = s.create(draft('late'));
  assert.ok('ok' in r && r.status === 429);
  if ('ok' in r) assert.ok(r.retryAfterSec! > 1150 && r.retryAfterSec! <= 1200, String(r.retryAfterSec));
});

test('review 2: ordinary events are kept per session; a flood of one session’s events does not evict another’s, sends are never evicted', () => {
  const s = new IntentStore();
  s.record({ caseId: CASE, kind: 'intent_approved', actor: 'judge' });
  s.record({ caseId: CASE, kind: 'sent', actor: 'judge', requestId: 'rk-1' });
  for (let k = 0; k < 20_000; k++) s.record({ caseId: CASE, kind: 'edit_rechecked', actor: 'attacker' });
  assert.deepEqual(s.events(CASE, 'judge').map((e) => e.kind), ['intent_approved', 'sent']);
  assert.ok(s.events(CASE, 'attacker').length <= 200);
});

test('review 8: the owner’s trail shows ResolveKit’s invalidation of their intent', () => {
  const s = new IntentStore();
  const i = s.create(draft('me')) as StoredIntent;
  s.invalidate(i.id, 'the bindings changed');
  const e = s.events(CASE, 'me').find((x) => x.kind === 'intent_invalidated')!;
  assert.deepEqual([e.actor, e.detail], ['ResolveKit', 'the bindings changed']);
});

// ------------------------------------------------------------------------------------------------ 4

test('review 4: a failed intent can be retried only within its window, then it expires and stops counting', async () => {
  let t0 = Date.parse('2026-10-09T10:00:00Z');
  const now = () => new Date(t0);
  const { app, pp } = await setup({ sendStatus: 503 }, { now });
  const s = await unlock(app, '198.51.100.1');
  const i = await composeApproved(app, s, '198.51.100.1');
  assert.equal((await send(app, i, s, '198.51.100.1')).status, 502);
  assert.equal(await status(app, i, s, '198.51.100.1'), 'failed');
  t0 += 31 * 60_000;
  assert.equal(await status(app, i, s, '198.51.100.1'), 'expired');
  const r = await send(app, i, s, '198.51.100.1');
  assert.equal(r.status, 409);
  assert.equal(pp.sends.length, 1);
});

// ------------------------------------------------------------------------------------------------ 5

test('review 5: an edit while the intent is being sent voids the approval when that send does not go through', async () => {
  const failReads = { on: false };
  const { app, pp } = await setup({ failReads });
  const s = await unlock(app, '198.51.100.1');
  const i = await composeApproved(app, s, '198.51.100.1');
  failReads.on = true;
  const sending = send(app, i, s, '198.51.100.1');
  await sleep(10);
  const v = await app(req(`/api/cases/${CASE}/analysis/verify`, { body: { text: 'We shipped order #10482 with UPS.' }, cookie: s, ip: '198.51.100.1' }));
  assert.equal(v.status, 200);
  const r = await sending;
  assert.equal(r.status, 409);
  failReads.on = false;
  assert.equal(await status(app, i, s, '198.51.100.1'), 'invalidated');
  assert.equal((await send(app, i, s, '198.51.100.1')).status, 409);
  assert.equal(pp.sends.length, 0);
});

// ------------------------------------------------------------------------------------------------ 6

test('review 6: another session’s re-run of the analysis does not change or stale my approved intent', async () => {
  const { app, pp, store, input } = await setup();
  const s = await unlock(app, '198.51.100.1');
  const i = await composeApproved(app, s, '198.51.100.1');
  // What a refresh=1 by someone else does: a new analysis of the same documents, stored under the same key.
  const key = await analysisKey(input, MODEL);
  const cur = store.get(key)!.analysis;
  store.cached.set(key, { ...cur, sentences: cur.sentences.map((x) => (x.id === 'S2' ? { ...x, text: 'A different sentence from a newer run.' } : x)) });
  // Someone composing now gets the newer analysis…
  const other = await unlock(app, '198.51.100.2');
  const j = await app(req(`${base}/intent`, { body: { evidenceType: 'PROOF_OF_FULFILLMENT', resolutions: RESOLVED }, cookie: other, ip: '198.51.100.2' }));
  assert.equal(j.status, 201);
  assert.ok(((await j.json()) as Intent).notes.includes('A different sentence from a newer run.'));
  // …while my approved intent still sends exactly what I approved.
  const r = await send(app, i, s, '198.51.100.1');
  assert.equal(r.status, 202, await r.clone().text());
  assert.equal(pp.sends.length, 1);
  assert.equal(((await r.json()) as { intent: Intent }).intent.notes, i.notes);
  assert.ok(!i.notes.includes('A different sentence'));
});
