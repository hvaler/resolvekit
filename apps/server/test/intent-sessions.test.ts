/**
 * Submission intents on a shared hosted demo: each intent belongs to the demo session that composed it. Another
 * session can neither see, approve, send nor cancel it, and its own actions never invalidate it. Caps, TTL and
 * bounded files keep the store from growing without limit. Fake PayPal only: nothing is sent anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DailyCounters } from '@resolvekit/hosting';
import { PayPalClient, type Dispute } from '@resolvekit/paypal';
import { caseInput, standardCase } from '@resolvekit/cases';
import { createHostedApp } from '../src/hosted.ts';
import { INTENT_ID, IntentStore, MAX_EVENTS_FILE_BYTES, MAX_OPEN, MAX_OPEN_PER_OWNER_CASE, type StoredIntent } from '../src/intents.ts';
import { toSnapshot } from '../src/mapping.ts';
import { RESOLVED, analystFor, standardDispute } from './kit.ts';

const ORIGIN = 'https://rk.example.com';
const HOST = 'rk.example.com';
const CASE = standardCase.summary.id;
const REAL = 'PP-R-REAL-1';
const CODE = 'judges-code-2026';

/** PayPal by path; once a send went through, the dispute shows the seller's evidence (as PayPal does). */
function routedPayPal() {
  let sent = false;
  const sends: string[] = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
    if (u.pathname.endsWith('/provide-evidence')) {
      sends.push(new Headers(init.headers).get('paypal-request-id') ?? '');
      sent = true;
      return new Response(JSON.stringify({ links: [] }), { status: 200 });
    }
    const d: Dispute = sent
      ? standardDispute({
          status: 'WAITING_FOR_BUYER_RESPONSE',
          evidences: [{ evidence_type: 'PROOF_OF_FULFILLMENT', source: 'SUBMITTED_BY_SELLER', date: '2026-10-09T09:00:00Z', action_info: { action: 'PROVIDE_EVIDENCE' } }],
          links: [{ rel: 'self' }, { rel: 'provide_evidence' }],
        })
      : standardDispute();
    return new Response(JSON.stringify(d), { status: 200 });
  }) as typeof globalThis.fetch;
  return { sends, client: new PayPalClient({ clientId: 'cid', clientSecret: 'secret', env: 'sandbox', fetch }) };
}

async function setup() {
  const pp = routedPayPal();
  const input = caseInput(standardCase, { kind: 'live', snap: toSnapshot(standardDispute(), CASE, 'sandbox', new Date()), failed: null });
  const { analyst } = await analystFor([[CASE, input]]);
  const app = createHostedApp({
    paypal: pp.client,
    env: 'sandbox',
    bindings: { [CASE]: REAL },
    analyst,
    site: null,
    counters: new DailyCounters({ file: null, limits: { 'live-analysis': 5, recheck: 50, evidence: 5 } }),
    demoCode: CODE,
    sessionSecret: 'x'.repeat(48),
    origins: [ORIGIN],
    hosts: [HOST],
    https: true,
  });
  return { app, pp };
}

type Init = { body?: unknown; cookie?: string | null; ip?: string };
const req = (path: string, i: Init = {}) => {
  const method = i.body !== undefined ? 'POST' : 'GET';
  const headers: Record<string, string> = { host: HOST, 'x-forwarded-for': i.ip ?? '203.0.113.7', ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/json' } : {}), ...(i.cookie ? { cookie: i.cookie } : {}) };
  return new Request(ORIGIN + path, { method, headers, ...(i.body !== undefined ? { body: JSON.stringify(i.body) } : {}) });
};
type App = Awaited<ReturnType<typeof setup>>['app'];
async function unlock(app: App, ip: string): Promise<string> {
  const r = await app(req('/api/demo/unlock', { body: { code: CODE }, ip }));
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie')!.split(';')[0]!;
}
const base = `/api/disputes/${CASE}`;
type Intent = { id: string; contentHash: string; status: string };
async function compose(app: App, cookie: string): Promise<Intent> {
  const r = await app(req(`${base}/intent`, { body: { evidenceType: 'PROOF_OF_FULFILLMENT', resolutions: RESOLVED }, cookie }));
  const b = await r.json();
  assert.equal(r.status, 201, JSON.stringify(b));
  return b as Intent;
}
const approve = (app: App, i: Intent, cookie: string | null) => app(req(`${base}/intent/${i.id}/approve`, { body: { contentHash: i.contentHash }, cookie }));
const send = (app: App, i: Intent, cookie: string | null) => app(req(`${base}/evidence`, { body: { intentId: i.id }, cookie }));

test('hosted: without the demo unlock, intents cannot be composed, read, approved, cancelled or sent, nor the audit read', async () => {
  const { app, pp } = await setup();
  const a = await unlock(app, '198.51.100.1');
  const i = await compose(app, a);
  for (const r of [
    await app(req(`${base}/intent`, { body: { evidenceType: 'PROOF_OF_FULFILLMENT', resolutions: RESOLVED } })),
    await app(req(`${base}/intent/${i.id}`)),
    await approve(app, i, null),
    await app(req(`${base}/intent/${i.id}/cancel`, { body: {} })),
    await send(app, i, null),
    await app(req(`${base}/audit`)),
  ]) {
    assert.equal(r.status, 403);
    assert.equal(((await r.json()) as { error: string }).error, 'DEMO_CODE_REQUIRED');
  }
  assert.equal(pp.sends.length, 0);
});

test('hosted: another session cannot read, approve, cancel or send my intent (404, as if it did not exist)', async () => {
  const { app, pp } = await setup();
  const mine = await unlock(app, '198.51.100.1');
  const theirs = await unlock(app, '198.51.100.2');
  const i = await compose(app, mine);
  assert.match(i.id, INTENT_ID);
  assert.equal((await app(req(`${base}/intent/${i.id}`, { cookie: theirs }))).status, 404);
  assert.equal((await approve(app, i, theirs)).status, 404);
  assert.equal((await app(req(`${base}/intent/${i.id}/cancel`, { body: {}, cookie: theirs }))).status, 404);
  assert.equal((await approve(app, i, mine)).status, 200);
  assert.equal((await send(app, i, theirs)).status, 404);
  assert.equal(pp.sends.length, 0);
  // Still mine, still approved, and it sends.
  const r = await app(req(`${base}/intent/${i.id}`, { cookie: mine }));
  assert.equal(((await r.json()) as Intent).status, 'approved');
  assert.equal((await send(app, i, mine)).status, 202);
  assert.equal(pp.sends.length, 1);
  // Each session sees its own audit trail only.
  const theirEvents = ((await (await app(req(`${base}/audit`, { cookie: theirs }))).json()) as { events: unknown[] }).events;
  assert.equal(theirEvents.length, 0);
});

test('hosted: another session’s new intent or sentence edit does not invalidate mine', async () => {
  const { app, pp } = await setup();
  const mine = await unlock(app, '198.51.100.1');
  const theirs = await unlock(app, '198.51.100.2');
  const i = await compose(app, mine);
  assert.equal((await approve(app, i, mine)).status, 200);
  await compose(app, theirs);
  assert.equal((await app(req(`/api/cases/${CASE}/analysis/verify`, { body: { text: 'We shipped order #10482 with UPS.' }, cookie: theirs }))).status, 200);
  assert.equal(((await (await app(req(`${base}/intent/${i.id}`, { cookie: mine }))).json()) as Intent).status, 'approved');
  assert.equal((await send(app, i, mine)).status, 202);
  assert.equal(pp.sends.length, 1);
});

test('hosted: my own edit or newer intent invalidates my approval; I can cancel my own intent', async () => {
  const { app, pp } = await setup();
  const mine = await unlock(app, '198.51.100.1');
  const i = await compose(app, mine);
  assert.equal((await approve(app, i, mine)).status, 200);
  assert.equal((await app(req(`/api/cases/${CASE}/analysis/verify`, { body: { text: 'We shipped order #10482 with UPS.' }, cookie: mine }))).status, 200);
  assert.equal((await send(app, i, mine)).status, 409);
  const j = await compose(app, mine);
  const c = await app(req(`${base}/intent/${j.id}/cancel`, { body: {}, cookie: mine }));
  assert.equal(c.status, 200);
  assert.equal((await approve(app, j, mine)).status, 409);
  assert.equal(pp.sends.length, 0);
});

test('hosted: once one session’s evidence is in, another session’s approved intent fails cleanly: PayPal already has seller evidence', async () => {
  const { app, pp } = await setup();
  const a = await unlock(app, '198.51.100.1');
  const b = await unlock(app, '198.51.100.2');
  const ia = await compose(app, a);
  const ib = await compose(app, b);
  assert.equal((await approve(app, ia, a)).status, 200);
  assert.equal((await approve(app, ib, b)).status, 200);
  assert.equal((await send(app, ia, a)).status, 202);
  const r = await send(app, ib, b);
  assert.equal(r.status, 409);
  const body = (await r.json()) as { error: string; detail: string };
  assert.equal(body.error, 'SELLER_EVIDENCE_EXISTS');
  assert.match(body.detail, /already has seller evidence/);
  assert.equal(pp.sends.length, 1);
});

// ------------------------------------------------------------------------------------------------ the store

const draft = (owner: string, caseId = CASE): Omit<StoredIntent, 'id' | 'status' | 'createdAt' | 'expiresAt' | 'approvedBy' | 'approvedAt' | 'sentAt' | 'reason' | 'requestId'> => ({
  caseId, disputeId: REAL, documentsHash: 'd', analysisKey: 'k', evidenceType: 'OTHER', carrier: '', tracking: '', notes: 'n', files: [], sentences: [], resolutionNotes: [],
  contentHash: 'h', request: { evidenceType: 'OTHER', edits: {}, resolutions: {} }, rechecks: {}, createdBy: owner,
});
const created = (x: ReturnType<IntentStore['create']>): StoredIntent => {
  if ('ok' in x) throw new Error(x.error);
  return x;
};

test('store: ids carry 128 random bits; intents expire after 30 minutes and then cannot be approved', () => {
  let now = new Date('2026-10-09T08:00:00Z');
  const s = new IntentStore({ now: () => now });
  const ids = new Set(Array.from({ length: 50 }, (_, k) => created(s.create(draft(`o${k}`))).id));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, INTENT_ID);
  const i = created(s.create(draft('me')));
  now = new Date('2026-10-09T08:31:00Z');
  assert.equal(s.get(i.id, 'me')!.status, 'expired');
  const t = s.approve(i.id, CASE, 'h', 'me');
  assert.ok(!t.ok && t.error === 'INTENT_EXPIRED');
});

test('store: open intents are capped per session and case, and in all (expired ones make room first)', () => {
  let now = new Date('2026-10-09T08:00:00Z');
  const s = new IntentStore({ now: () => now });
  // A session's newer intent for a case replaces its older one, so it never holds more than one open per case.
  const mine = Array.from({ length: MAX_OPEN_PER_OWNER_CASE + 3 }, () => created(s.create(draft('me'))));
  assert.deepEqual(mine.map((i) => s.get(i.id, 'me')!.status).filter((st) => st === 'proposed'), ['proposed']);
  // Globally: MAX_OPEN open intents, then refused…
  for (let k = 0; k < MAX_OPEN - 1; k++) created(s.create(draft(`s${k}`, `CASE-${k % 7}`)));
  const refused = s.create(draft('late'));
  assert.ok('ok' in refused && refused.status === 429);
  // …until they expire.
  now = new Date('2026-10-09T08:31:00Z');
  created(s.create(draft('late')));
  assert.ok(s.size() <= 500);
});

test('store: a send cut short by a restart reloads as failed, retryable by its owner only', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-intents-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'intents.json');
  const s = new IntentStore({ file });
  const i = created(s.create(draft('me')));
  assert.ok(s.approve(i.id, CASE, 'h', 'me').ok);
  assert.ok(s.beginSend(i.id, CASE, 'me').ok);
  const after = new IntentStore({ file });
  assert.equal(after.get(i.id, 'me')!.status, 'failed');
  assert.ok(!after.beginSend(i.id, CASE, 'someone else').ok);
  assert.ok(after.beginSend(i.id, CASE, 'me').ok);
});

test('store: the audit file stays bounded (compacted to the latest events)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-events-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const eventsFile = join(dir, 'audit-events.jsonl');
  const s = new IntentStore({ eventsFile });
  const detail = 'x'.repeat(900);
  for (let k = 0; k < 6000; k++) s.record({ caseId: CASE, kind: 'edit_rechecked', actor: `a${k}`, detail });
  assert.ok(s.eventsFileBytes() <= MAX_EVENTS_FILE_BYTES, String(s.eventsFileBytes()));
  assert.equal(new IntentStore({ eventsFile }).events(CASE).at(-1)!.actor, 'a5999');
});
