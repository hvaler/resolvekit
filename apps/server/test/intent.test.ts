/**
 * H1: what reaches PayPal is decided on the server. Only an intent composed here from the analysis (supported
 * sentences; edits only with the server's own re-check) and approved by the merchant is sent; anything a client puts
 * in the body is not. Every test runs on a fake PayPal: nothing is sent anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PayPalClient, type Dispute } from '@resolvekit/paypal';
import { caseInput, standardCase } from '@resolvekit/cases';
import { createApp, DEFAULT_ORIGINS, TOKEN_HEADER, LOCAL_OPERATOR } from '../src/app.ts';
import { IntentStore } from '../src/intents.ts';
import { RecheckVerdicts } from '../src/verdicts.ts';
import { toSnapshot } from '../src/mapping.ts';
import { RESOLVED, STD_CAPTURE, analystFor, goldenNotes, standardDispute } from './kit.ts';
import type { Binding } from '../src/bindings.ts';

const CASE = standardCase.summary.id;
const REAL = 'PP-R-REAL-1';
const TOKEN = 'a'.repeat(64);
const BASE = 'http://127.0.0.1:8787';
const NOW = new Date(Date.UTC(2026, 9, 9, 8, 0, 0));

/** PayPal by path: dispute reads answer `dispute()` (changeable), sends are recorded and succeed unless told. */
function routedPayPal(o: { dispute?: () => Dispute; sendStatus?: () => number; sendDelayMs?: number } = {}) {
  const sends: Array<{ init: RequestInit }> = [];
  const reads: string[] = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
    if (u.pathname.endsWith('/provide-evidence')) {
      sends.push({ init });
      if (o.sendDelayMs) await new Promise((r) => setTimeout(r, o.sendDelayMs));
      const status = o.sendStatus?.() ?? 200;
      return new Response(JSON.stringify(status === 200 ? { links: [] } : { name: 'INTERNAL_SERVER_ERROR' }), { status, headers: { 'paypal-debug-id': 'dbg1' } });
    }
    reads.push(u.pathname);
    return new Response(JSON.stringify((o.dispute ?? standardDispute)()), { status: 200 });
  }) as typeof globalThis.fetch;
  return { sends, reads, client: new PayPalClient({ clientId: 'cid', clientSecret: 'secret', env: 'sandbox', fetch }) };
}

const boundInput = (d: Dispute = standardDispute()) => caseInput(standardCase, { kind: 'live', snap: toSnapshot(d, CASE, 'sandbox', NOW), failed: null });

async function setup(o: Parameters<typeof routedPayPal>[0] & { analysedAs?: () => Dispute; bound?: boolean; binding?: string | Binding; recheck?: Record<string, unknown>; intents?: IntentStore; verdicts?: RecheckVerdicts; stage?: string } = {}) {
  // A dispute in a given stage (PayPal's dispute_life_cycle_stage), read and analysed as such.
  const staged = o.stage ? (): Dispute => ({ ...standardDispute(), dispute_life_cycle_stage: o.stage }) : null;
  const pp = routedPayPal(staged ? { ...o, dispute: staged } : o);
  const { analyst, model } = await analystFor([[CASE, boundInput(staged ? staged() : o.analysedAs?.())], [CASE, caseInput(standardCase, { kind: 'simulated' })]], o.recheck);
  const lines: string[] = [];
  const app = createApp({
    paypal: pp.client,
    env: 'sandbox',
    bindings: o.bound === false ? {} : { [CASE]: o.binding ?? { dispute: REAL, capture: STD_CAPTURE } },
    now: () => NOW,
    log: (l) => lines.push(l),
    port: 8787,
    token: TOKEN,
    allowedOrigins: DEFAULT_ORIGINS,
    analyst,
    ...(o.intents ? { intents: o.intents } : {}),
    ...(o.verdicts ? { verdicts: o.verdicts } : {}),
  });
  return { app, pp, lines, model };
}

const post = (path: string, body: unknown) =>
  new Request(BASE + path, { method: 'POST', headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json', origin: 'http://127.0.0.1:4173' }, body: JSON.stringify(body) });
const get = (path: string) => new Request(BASE + path, { headers: { [TOKEN_HEADER]: TOKEN } });

const intentPath = `/api/disputes/${CASE}/intent`;
const evidencePath = `/api/disputes/${CASE}/evidence`;
const request = (over: Record<string, unknown> = {}) => ({ evidenceType: 'PROOF_OF_FULFILLMENT', edits: {}, resolutions: RESOLVED, ...over });

type App = Awaited<ReturnType<typeof setup>>['app'];
type Intent = { id: string; contentHash: string; notes: string; files: Array<{ name: string }>; carrier: string; tracking: string; requestId: string; status: string; reason?: string | null; disputeId: string | null; approvedBy: string | null; sentences: Array<{ id: string; text: string; edited: boolean }> };

async function propose(app: App, over: Record<string, unknown> = {}): Promise<Intent> {
  const r = await app(post(intentPath, request(over)));
  const b = await r.json();
  assert.equal(r.status, 201, JSON.stringify(b));
  return b as Intent;
}
async function approve(app: App, i: Intent, hash = i.contentHash) {
  return app(post(`${intentPath}/${i.id}/approve`, { contentHash: hash }));
}

test('H1: arbitrary notes in the evidence request are refused (4xx) and PayPal’s provide-evidence is never called', async () => {
  const { app, pp } = await setup();
  const legacy = {
    disputeId: CASE,
    action: 'provide_evidence',
    evidenceType: 'PROOF_OF_FULFILLMENT',
    carrier: 'UPS',
    tracking: '1Z999AA10123456784',
    notes: 'The buyer confirmed receipt by phone.',
    files: [{ name: 'ups-tracking-1Z999AA10123456784.pdf', size: '112 KB' }],
    requestId: 'rk-req-abc123',
  };
  const r = await app(post(evidencePath, legacy));
  assert.equal(r.status, 400);
  assert.match((await r.json()).detail, /never taken from the request/);
  // Even with a real approved intent id, extra notes in the body are refused, not merged.
  const i = await propose(app);
  assert.equal((await approve(app, i)).status, 200);
  const sneaky = await app(post(evidencePath, { intentId: i.id, notes: 'The buyer confirmed receipt by phone.' }));
  assert.equal(sneaky.status, 400);
  // Notes in the intent request are refused too: the server composes them.
  const r2 = await app(post(intentPath, { ...request(), notes: 'Anything I like.' }));
  assert.equal(r2.status, 400);
  assert.equal(pp.sends.length, 0);
});

test('H1: the intent is composed on the server from the supported sentences; the removed one is not in it', async () => {
  const { app } = await setup();
  const i = await propose(app);
  assert.equal(i.notes, goldenNotes(CASE));
  assert.ok(!i.notes.includes('confirmed receipt by phone'));
  assert.deepEqual(i.sentences.map((s) => s.id), ['S1', 'S2', 'S3', 'S4', 'S5']);
  assert.equal(i.disputeId, REAL);
  assert.equal(i.status, 'proposed');
  assert.deepEqual([i.carrier, i.tracking], ['UPS', '1Z999AA10123456784']);
  assert.deepEqual(i.files.map((f) => f.name), standardCase.attachments.map((a) => a.name));
  assert.match(i.contentHash, /^[0-9a-f]{64}$/);
});

test('H1: an open contradiction, an unknown evidence type or an unverified edit is refused before any intent exists', async () => {
  const { app } = await setup();
  const open = await app(post(intentPath, request({ resolutions: {} })));
  assert.equal(open.status, 422);
  assert.equal((await open.json()).error, 'DRAFT_BLOCKED');
  const type = await app(post(intentPath, request({ evidenceType: 'PROOF_OF_REFUND_X' })));
  assert.equal(type.status, 422);
  const unverified = await app(post(intentPath, request({ edits: { S2: 'The buyer confirmed receipt by phone.' } })));
  assert.equal(unverified.status, 422);
  assert.equal((await unverified.json()).error, 'EDIT_NOT_VERIFIED');
  const removed = await app(post(intentPath, request({ edits: { S6: 'The customer confirmed receipt by phone.' } })));
  assert.equal(removed.status, 422);
  assert.equal((await removed.json()).error, 'SENTENCE_REMOVED');
});

test('H1: an approved intent sends exactly its notes, tracking and files, with the intent’s PayPal-Request-Id', async () => {
  const { app, pp, lines } = await setup();
  const i = await propose(app);
  const a = await approve(app, i);
  assert.equal(a.status, 200);
  const approved = (await a.json()) as Intent;
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approvedBy, LOCAL_OPERATOR);
  const r = await app(post(evidencePath, { intentId: i.id }));
  assert.equal(r.status, 202);
  assert.equal(((await r.json()) as { intent: Intent }).intent.status, 'sent');
  assert.equal(pp.sends.length, 1);
  const send = pp.sends[0]!;
  assert.equal(new Headers(send.init.headers).get('paypal-request-id'), i.requestId);
  const form = send.init.body as FormData;
  const input = JSON.parse(await (form.get('input') as Blob).text());
  assert.deepEqual(input.evidences[0], {
    evidence_type: 'PROOF_OF_FULFILLMENT',
    evidence_info: { tracking_info: [{ carrier_name: 'UPS', tracking_number: '1Z999AA10123456784' }] },
    notes: i.notes,
  });
  assert.deepEqual((form.getAll('evidence-file') as File[]).map((f) => f.name), i.files.map((f) => f.name));
  assert.ok(lines.some((l) => l.includes(`intent ${i.id}`)));
});

test('H1: an intent that was not approved, or approved with another content hash, is never sent', async () => {
  const { app, pp } = await setup();
  const i = await propose(app);
  const r = await app(post(evidencePath, { intentId: i.id }));
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, 'INTENT_PROPOSED');
  const wrong = await approve(app, i, 'f'.repeat(64));
  assert.equal(wrong.status, 409);
  assert.equal((await wrong.json()).error, 'CONTENT_HASH_MISMATCH');
  assert.equal((await app(post(evidencePath, { intentId: 'int-' + '0'.repeat(24) }))).status, 404);
  assert.equal(pp.sends.length, 0);
});

test('H1: editing a sentence after approval invalidates the intent; a re-checked edit goes into the next intent', async () => {
  const { app, pp } = await setup();
  const i = await propose(app);
  assert.equal((await approve(app, i)).status, 200);
  // The merchant edits sentence 2: the server re-checks it (fake model: supported) and drops the approval.
  const edited = 'We shipped order #10482 (1 × Linen tote, natural · 7.00 USD) with UPS.';
  const v = await app(post(`/api/cases/${CASE}/analysis/verify`, { text: edited }));
  assert.equal(v.status, 200);
  const stale = await app(post(evidencePath, { intentId: i.id }));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, 'INTENT_INVALIDATED');
  // The edit is now verified on this server: the new intent carries it, approved and sent as is.
  const next = await propose(app, { edits: { S2: edited } });
  assert.ok(next.notes.includes(edited));
  assert.deepEqual(next.sentences.find((s) => s.id === 'S2'), { id: 'S2', text: edited, edited: true });
  assert.equal((await approve(app, next)).status, 200);
  assert.equal((await app(post(evidencePath, { intentId: next.id }))).status, 202);
  assert.equal(pp.sends.length, 1);
  const notes = JSON.parse(await ((pp.sends[0]!.init.body as FormData).get('input') as Blob).text()).evidences[0].notes;
  assert.equal(notes, next.notes);
});

test('a re-checked edit survives a restart: the verdict is on the data dir (by text hash), so the edit can still be sent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-verdicts-'));
  try {
    const file = join(dir, 'recheck-verdicts.json');
    const edited = 'We shipped order #10482 (1 × Linen tote, natural · 7.00 USD) with UPS.';
    const before = await setup({ verdicts: new RecheckVerdicts({ file }) });
    assert.equal((await before.app(post(`/api/cases/${CASE}/analysis/verify`, { text: edited }))).status, 200);
    const onDisk = readFileSync(file, 'utf8');
    assert.equal(onDisk.includes(edited), false, 'the edited text itself is not stored');
    // A new process: the verdict is read back and the edit composes, without a new re-check.
    const after = await setup({ verdicts: new RecheckVerdicts({ file }) });
    const i = await propose(after.app, { edits: { S2: edited } });
    assert.ok(i.notes.includes(edited));
    assert.deepEqual(i.sentences.find((s) => s.id === 'S2'), { id: 'S2', text: edited, edited: true });
    // Without the file (verdicts in memory only, as before) the same edit is not composed.
    const fresh = await setup();
    const r = await fresh.app(post(intentPath, request({ edits: { S2: edited } })));
    const b = (await r.json()) as Intent;
    assert.ok(r.status !== 201 || !b.notes.includes(edited), JSON.stringify(b));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('H1: an edit the verifier does not support is not sent', async () => {
  const { app } = await setup({ recheck: { facts: [], verdict: 'rejected', reason: 'no document says so', rewrite: '' } });
  const text = 'The buyer confirmed receipt by phone and thanked us.';
  assert.equal((await app(post(`/api/cases/${CASE}/analysis/verify`, { text }))).status, 200);
  const i = await propose(app, { edits: { S2: text } });
  assert.ok(!i.notes.includes(text));
  assert.ok(!i.sentences.some((s) => s.id === 'S2'));
});

test('H1: a newer intent for the case replaces the approved one', async () => {
  const { app, pp } = await setup();
  const first = await propose(app);
  assert.equal((await approve(app, first)).status, 200);
  await propose(app);
  const r = await app(post(evidencePath, { intentId: first.id }));
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, 'INTENT_INVALIDATED');
  assert.equal(pp.sends.length, 0);
});

test('H1: two concurrent confirmations of the same intent produce exactly one send', async () => {
  const { app, pp } = await setup({ sendDelayMs: 20 });
  const i = await propose(app);
  assert.equal((await approve(app, i)).status, 200);
  const all = await Promise.all(Array.from({ length: 5 }, () => app(post(evidencePath, { intentId: i.id }))));
  const statuses = all.map((r) => r.status).sort();
  assert.deepEqual(statuses, [202, 409, 409, 409, 409]);
  assert.equal(pp.sends.length, 1);
  // Once sent, it stays sent: a later confirmation is refused too.
  const again = await app(post(evidencePath, { intentId: i.id }));
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error, 'INTENT_SENT');
  assert.equal(pp.sends.length, 1);
});

test('H1: documents that changed after approval (fresh PayPal read) refuse the send', async () => {
  let dispute = standardDispute();
  const { app, pp } = await setup({ dispute: () => dispute });
  const i = await propose(app);
  assert.equal((await approve(app, i)).status, 200);
  // PayPal now reports the disputed transaction differently: the capture document the analysis read is not this one.
  dispute = standardDispute({ disputed_transactions: [{ ...standardDispute().disputed_transactions![0]!, transaction_status: 'REVERSED' }] });
  const r = await app(post(evidencePath, { intentId: i.id }));
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, 'DOCUMENTS_CHANGED');
  assert.equal(pp.sends.length, 0);
});

test('H1: PayPal no longer offering provide_evidence at send time refuses the send', async () => {
  let dispute = standardDispute();
  const { app, pp } = await setup({ dispute: () => dispute });
  const i = await propose(app);
  assert.equal((await approve(app, i)).status, 200);
  dispute = standardDispute({ status: 'UNDER_REVIEW', links: [{ rel: 'self' }, { rel: 'send_message' }] });
  const r = await app(post(evidencePath, { intentId: i.id }));
  assert.ok(r.status === 409 || r.status === 422, String(r.status));
  assert.equal(pp.sends.length, 0);
});

test('H1: a failed send can be retried with the same intent and the same PayPal-Request-Id', async () => {
  let status = 500;
  const { app, pp } = await setup({ sendStatus: () => status });
  const i = await propose(app);
  assert.equal((await approve(app, i)).status, 200);
  assert.equal((await app(post(evidencePath, { intentId: i.id }))).status, 502);
  // The audit keeps PayPal's debug_id, so the failed request can be traced with PayPal.
  const failed = (await (await app(get(`${intentPath}/${i.id}`))).json()) as Intent;
  assert.match(failed.reason ?? '', /PayPal 500 INTERNAL_SERVER_ERROR · debug_id dbg1/);
  status = 200;
  assert.equal((await app(post(evidencePath, { intentId: i.id }))).status, 202);
  assert.deepEqual(pp.sends.map((s) => new Headers(s.init.headers).get('paypal-request-id')), [i.requestId, i.requestId]);
});

test('H1: a simulated (unbound) case gets an intent and an approval, but the server never sends it', async () => {
  const { app, pp } = await setup({ bound: false });
  const i = await propose(app);
  assert.equal(i.disputeId, null);
  assert.equal((await approve(app, i)).status, 200);
  const r = await app(post(evidencePath, { intentId: i.id }));
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, 'NOT_BOUND');
  assert.equal(pp.sends.length, 0);
});

test('M3: approvals and sends are persisted on the data dir and listed by the audit route (actor, hash, intent, request id, result)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-intents-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = { file: join(dir, 'intents.json'), eventsFile: join(dir, 'audit-events.jsonl') };
  const { app } = await setup({ intents: new IntentStore({ ...files, now: () => NOW }) });
  const i = await propose(app);
  assert.equal((await approve(app, i)).status, 200);
  assert.equal((await app(post(evidencePath, { intentId: i.id }))).status, 202);
  // A new process reads the same files back.
  const reloaded = new IntentStore(files);
  const events = reloaded.events(CASE);
  assert.deepEqual(events.map((e) => e.kind), ['intent_created', 'intent_approved', 'send_started', 'sent']);
  const approved = events.find((e) => e.kind === 'intent_approved')!;
  assert.deepEqual([approved.actor, approved.contentHash, approved.intentId, approved.disputeId, approved.requestId], [LOCAL_OPERATOR, i.contentHash, i.id, REAL, i.requestId]);
  assert.match(events.find((e) => e.kind === 'sent')!.detail!, /accepted by PayPal/);
  assert.equal(reloaded.peek(i.id)!.status, 'sent');
  // The audit route answers the same events.
  const r = await app(get(`/api/disputes/${CASE}/audit`));
  assert.deepEqual(((await r.json()) as { events: Array<{ kind: string }> }).events.map((e) => e.kind), events.map((e) => e.kind));
});

/**
 * A data dir whose disk can fail on demand: `break()` moves the directory aside (keeping what was written) and puts a
 * plain file in its place, so every later write fails; `restore()` moves it back.
 */
function fragileDir(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'rk-fragile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'data');
  const kept = join(root, 'kept');
  mkdirSync(dir);
  const at = (d: string) => ({ file: join(d, 'intents.json'), eventsFile: join(d, 'audit-events.jsonl') });
  return {
    files: at(dir),
    kept: at(kept),
    break: () => {
      renameSync(dir, kept);
      writeFileSync(dir, 'not a directory');
    },
    restore: () => {
      rmSync(dir, { force: true });
      renameSync(kept, dir);
    },
  };
}

test('M3: when the approval cannot be written durably, nothing goes to PayPal (503) and the intent stays approved', async (t) => {
  const disk = fragileDir(t);
  const { app, pp } = await setup({ intents: new IntentStore({ ...disk.files, now: () => NOW }) });
  const i = await propose(app);
  assert.equal((await approve(app, i)).status, 200);
  disk.break();
  const r = await app(post(evidencePath, { intentId: i.id }));
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'AUDIT_UNAVAILABLE');
  assert.equal(pp.sends.length, 0);
  assert.equal(((await (await app(get(`${intentPath}/${i.id}`))).json()) as Intent).status, 'approved');
  // Once the disk is back, the same approved intent sends.
  disk.restore();
  assert.equal((await app(post(evidencePath, { intentId: i.id }))).status, 202);
  assert.equal(pp.sends.length, 1);
});

test('M3: when the send log cannot be written, the send is refused before PayPal is called', async (t) => {
  const disk = fragileDir(t);
  const root = mkdtempSync(join(tmpdir(), 'rk-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // State on a good disk; audit events and the send log beside them on the failing one.
  const { app, pp, lines } = await setup({ intents: new IntentStore({ file: join(root, 'intents.json'), eventsFile: disk.files.eventsFile, now: () => NOW }) });
  const i = await propose(app);
  assert.equal((await approve(app, i)).status, 200);
  disk.break();
  const r = await app(post(evidencePath, { intentId: i.id }));
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'AUDIT_UNAVAILABLE');
  assert.equal(pp.sends.length, 0);
  assert.ok(lines.some((l) => l.startsWith('AUDIT UNAVAILABLE')));
  assert.equal(((await (await app(get(`${intentPath}/${i.id}`))).json()) as Intent).status, 'approved');
});

test('M3: a write that fails after PayPal accepted is reported, and a restart finds an unfinished send, not an unsent approval', async (t) => {
  const disk = fragileDir(t);
  const { app, pp, lines } = await setup({ sendDelayMs: 100, intents: new IntentStore({ ...disk.files, now: () => NOW }) });
  const i = await propose(app);
  assert.equal((await approve(app, i)).status, 200);
  const pending = app(post(evidencePath, { intentId: i.id }));
  while (pp.sends.length === 0) await new Promise((r) => setTimeout(r, 5));
  disk.break();
  assert.equal((await pending).status, 202);
  assert.ok(lines.some((l) => l.startsWith(`AUDIT NOT DURABLE: outcome of intent ${i.id}`)));
  // What reached the disk before PayPal was called: the "sending" state and send_started.
  const reloaded = new IntentStore(disk.kept);
  assert.deepEqual(reloaded.events(CASE).map((e) => e.kind), ['intent_created', 'intent_approved', 'send_started']);
  const after = reloaded.peek(i.id)!;
  assert.equal(after.status, 'failed');
  assert.match(after.reason!, /restarted during the send/);
});

test('ordering: a creation that fails (PayPal unreadable, blocked draft) retires nothing: the approved intent still sends', async () => {
  let down = false;
  const { app, pp } = await setup({ dispute: () => (down ? (() => { throw new Error('offline'); })() : standardDispute()) });
  const i = await propose(app);
  assert.equal((await approve(app, i)).status, 200);
  down = true;
  const failed = await app(post(intentPath, request()));
  assert.equal(failed.status, 409);
  assert.equal((await failed.json()).error, 'BINDING_UNAVAILABLE');
  down = false;
  const blocked = await app(post(intentPath, request({ resolutions: {} })));
  assert.equal(blocked.status, 422);
  // Neither refusal replaced the approved intent.
  assert.equal(((await (await app(get(`${intentPath}/${i.id}`))).json()) as Intent).status, 'approved');
  assert.equal((await app(post(evidencePath, { intentId: i.id }))).status, 202);
  assert.equal(pp.sends.length, 1);
});

test('[A1] evidence memory by stage: the send log records the stage read at send time; a second evidence in that stage is refused after the fresh read', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-intent-stage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = { file: join(dir, 'intents.json'), eventsFile: join(dir, 'audit-events.jsonl') };
  const { app, pp } = await setup({ stage: 'INQUIRY', intents: new IntentStore({ ...files, now: () => NOW }) });
  const i = await propose(app);
  assert.equal((await approve(app, i)).status, 200);
  assert.equal((await app(post(evidencePath, { intentId: i.id }))).status, 202);
  const sends = readFileSync(join(dir, 'audit-events-sends.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(sends.map((e) => [e.kind, e.action, e.scope, e.stage]), [['send_started', 'provide_evidence', 'evidence', 'INQUIRY'], ['sent', 'provide_evidence', 'evidence', 'INQUIRY']]);
  // PayPal's read does not show the evidence yet: this server's memory for the stage refuses a second one.
  const j = await propose(app);
  assert.equal((await approve(app, j)).status, 200);
  const r = await app(post(evidencePath, { intentId: j.id }));
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as { error: string }).error, 'SELLER_EVIDENCE_EXISTS');
  assert.equal(pp.sends.length, 1);
  // From the send log alone: the memory is per stage.
  rmSync(files.file);
  const seeded = new IntentStore(files);
  assert.equal(seeded.evidenceSentIn(REAL, 'INQUIRY'), true);
  assert.equal(seeded.evidenceSentIn(REAL, 'CHARGEBACK'), false);
});

test('Task 12: PROOF_OF_REFUND evidence and an appeal are refused at compose and at send with the registry reason; PayPal is never called', async () => {
  const intents = new IntentStore();
  const { app, pp } = await setup({ intents });
  const REFUND = 'Not available: Not verified with PayPal: pending sandbox test (W-11)';
  const APPEAL = 'Not available: Not verified with PayPal: the sandbox could not produce an appealable dispute';
  // Compose: PROOF_OF_REFUND evidence (also with refund ids) and an appeal body.
  for (const [body, detail] of [
    [request({ evidenceType: 'PROOF_OF_REFUND' }), REFUND],
    [request({ evidenceType: 'PROOF_OF_REFUND', refundIds: ['9ZX12345AB678901C'] }), REFUND],
    [request({ action: 'appeal' }), APPEAL],
  ] as const) {
    const r = await app(post(intentPath, body));
    const b = await r.json();
    assert.deepEqual([r.status, b.error, b.detail], [409, 'VARIANT_NOT_AVAILABLE', detail], JSON.stringify(body));
  }
  // The other evidence types compose and send as before.
  const i = await propose(app);
  assert.equal((await approve(app, i)).status, 200);
  // Send: an approved intent whose type is PROOF_OF_REFUND (as one stored before this delivery would be) is composed
  // again on the send-time read and refused; nothing reaches PayPal.
  const stored = intents.peek(i.id)!;
  (stored.request as { evidenceType: string }).evidenceType = 'PROOF_OF_REFUND';
  (stored as { evidenceType: string }).evidenceType = 'PROOF_OF_REFUND';
  const s = await app(post(evidencePath, { intentId: i.id }));
  const sb = await s.json();
  assert.deepEqual([s.status, sb.error, sb.detail], [409, 'VARIANT_NOT_AVAILABLE', REFUND], JSON.stringify(sb));
  assert.equal(pp.sends.length, 0);
  assert.ok(!pp.reads.some((p) => p.endsWith('/appeal')));
});

test('Task 12: when PayPal requests PROOF_OF_REFUND among other types, the other types compose and send as before', async () => {
  const asking = (types: string[]) => (): Dispute => ({
    ...standardDispute(),
    evidences: types.map((t) => ({ evidence_type: t, source: 'REQUESTED_FROM_SELLER', date: '2026-10-08T10:00:00.000Z' })) as unknown as Dispute['evidences'],
  });
  // As the claim requested after W-5: PROOF_OF_FULFILLMENT, PROOF_OF_REFUND, OTHER.
  const several = asking(['PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND', 'OTHER']);
  const { app, pp } = await setup({ dispute: several, analysedAs: several });
  const i = await propose(app);
  assert.equal((await approve(app, i)).status, 200);
  const s = await app(post(evidencePath, { intentId: i.id }));
  assert.equal(s.status, 202, JSON.stringify(await s.clone().json()));
  assert.equal(pp.sends.length, 1);
  // Unchanged rule (validate.ts, before this feature): PayPal requesting PROOF_OF_REFUND only refuses another type.
  const only = asking(['PROOF_OF_REFUND']);
  const o = await setup({ dispute: only, analysedAs: only });
  const r = await o.app(post(intentPath, request()));
  assert.deepEqual([r.status, (await r.json()).error], [422, 'EVIDENCE_TYPE_NOT_REQUESTED']);
  const refund = await o.app(post(intentPath, request({ evidenceType: 'PROOF_OF_REFUND' })));
  assert.deepEqual([refund.status, (await refund.json()).error], [409, 'VARIANT_NOT_AVAILABLE']);
  assert.equal(o.pp.sends.length, 0);
});
