/**
 * [A1] Locks on the store: in flight, uncertain, duplicates, evidence by stage, all seeded from the send log. No
 * PayPal here: the store is driven the way the send routes drive it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntentStore, type StoredIntent } from '../src/intents.ts';
import { CONSEQUENCE, duplicateKey, type ActionPayload } from '../../web/src/domain/actions.ts';

const CASE = 'case-locks';
const D = 'PP-R-1';
const NOW = new Date(Date.UTC(2026, 9, 19, 9, 0, 0));
const TEXT = 'Hello, the parcel left on Monday — tracking 1Z999 (secret words)';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
type Draft = Parameters<IntentStore['create']>[0];

const pin = (stage = 'INQUIRY') => ({ disputeId: D, seller: 'S1', stage, status: 'WAITING_FOR_SELLER_RESPONSE', amount: { value: '10.00', currency: 'USD' } });
const blank = { documentsHash: '', analysisKey: '', evidenceType: 'OTHER', carrier: '', tracking: '', notes: '', files: [], sentences: [], resolutionNotes: [] };

function actionDraft(owner: string, payload: ActionPayload, o: { stage?: string; dispute?: string; caseId?: string } = {}): Draft {
  const request =
    payload.kind === 'send_message'
      ? { action: 'send_message', text: payload.text, attachments: [] }
      : payload.kind === 'escalate'
        ? { action: 'escalate', note: payload.note, attachments: [] }
        : payload.kind === 'accept_claim'
          ? { action: 'accept_claim', acceptType: payload.acceptType, note: payload.note, amount: payload.amount, attachments: [] }
          : { action: 'make_offer', offerType: payload.offerType, note: payload.note, amount: payload.amount, attachments: [] };
  return {
    caseId: o.caseId ?? CASE,
    disputeId: o.dispute ?? D,
    ...blank,
    action: payload.kind,
    payload,
    pin: { ...pin(o.stage), disputeId: o.dispute ?? D },
    contentHash: sha(JSON.stringify(payload) + (o.stage ?? '')),
    request,
    rechecks: {},
    createdBy: owner,
    createdFrom: `ip-${owner}`,
  } as unknown as Draft;
}

function evidenceDraft(owner: string, dispute = D): Draft {
  return {
    caseId: CASE, disputeId: dispute, ...blank, notes: 'n', contentHash: 'h-ev',
    request: { evidenceType: 'OTHER', edits: {}, resolutions: {}, confirmedCorrections: [], attachments: [] }, rechecks: {}, createdBy: owner, createdFrom: `ip-${owner}`,
  } as unknown as Draft;
}

const message = (text = TEXT): ActionPayload => ({ kind: 'send_message', text });
const offer: ActionPayload = { kind: 'make_offer', offerType: 'REFUND', note: 'half back', amount: { value: '5.00', currency: 'USD' } };
const escalate: ActionPayload = { kind: 'escalate', note: 'please review' };
const accept: ActionPayload = { kind: 'accept_claim', acceptType: 'REFUND', note: '', amount: null };

/** Create and approve, as the routes do. */
function approved(s: IntentStore, d: Draft): StoredIntent {
  const i = s.create(d);
  assert.ok(!('ok' in i), JSON.stringify(i));
  const t = s.approve(i.id, i.caseId, i.contentHash, i.createdBy);
  assert.equal(t.ok, true);
  return i;
}

/** beginSend plus the durable send_started line, as the routes do before calling PayPal. */
function start(s: IntentStore, i: StoredIntent, stage?: string | null) {
  const t = s.beginSend(i.id, i.caseId, i.createdBy);
  assert.equal(t.ok, true, JSON.stringify(t));
  const r = s.recordChecked({ caseId: i.caseId, kind: 'send_started', actor: i.createdBy, disputeId: i.disputeId, intentId: i.id, contentHash: i.contentHash, requestId: i.requestId, ...(stage !== undefined ? { stage } : {}) });
  assert.equal(r.durable, true);
}

const refusal = (s: IntentStore, i: StoredIntent) => {
  const t = s.beginSend(i.id, i.caseId, i.createdBy);
  return t.ok ? 'ok' : t.error;
};

test('consequence codes and the duplicate key', () => {
  assert.deepEqual(CONSEQUENCE, { send_message: 'BUYER_SEES_MESSAGE', accept_claim: 'REFUNDS_BUYER', escalate: 'MOVES_TO_CLAIM', make_offer: 'OFFERS_SETTLEMENT', appeal: 'APPEALS_DECISION' });
  const d = actionDraft('a', message('hi')) as unknown as Parameters<typeof duplicateKey>[0];
  assert.equal(duplicateKey(d), 'send_message|INQUIRY|{"kind":"send_message","text":"hi"}');
  assert.equal(duplicateKey(evidenceDraft('a') as unknown as Parameters<typeof duplicateKey>[0]), null);
  assert.equal(duplicateKey({ ...(evidenceDraft('a') as object), action: 'appeal' } as unknown as Parameters<typeof duplicateKey>[0]), null);
});

test('lock matrix', () => {
  const s = new IntentStore({ now: () => NOW });
  // In flight: one send at a time per dispute, across all actions.
  const a = approved(s, actionDraft('o1', message()));
  const b = approved(s, actionDraft('o2', message('another one')));
  start(s, a);
  assert.equal(refusal(s, b), 'DISPUTE_BUSY');
  const ev = approved(s, evidenceDraft('o3'));
  assert.equal(refusal(s, ev), 'DISPUTE_BUSY');
  assert.equal(s.held(D), true);

  // Uncertain: blocks every write until a read-back proves the outcome.
  assert.equal(s.markUncertain(a.id, 'PayPal timed out'), true);
  assert.deepEqual(s.isUncertain(D), { intentId: a.id, since: NOW.toISOString() });
  const o = approved(s, actionDraft('o4', offer));
  const t = s.beginSend(o.id, o.caseId, 'o4');
  assert.equal(t.ok, false);
  assert.equal((t as { error: string }).error, 'DISPUTE_UNCERTAIN');
  assert.equal((t as { status: number }).status, 409);
  assert.equal((t as { detail: string }).detail, 'The last send to this dispute is not confirmed by PayPal yet; check it again before anything else is sent');
  assert.equal(refusal(s, ev), 'DISPUTE_UNCERTAIN');
  // Not resent blindly: the uncertain intent itself is refused too.
  assert.notEqual(refusal(s, s.peek(a.id)!), 'ok');
  // Uncertain never becomes closed: pending three times, still uncertain, no closed or sent memory.
  for (let n = 0; n < 3; n++) assert.equal(s.recordReadBack(a.id, { state: 'pending', detail: 'no attributable entry' }), true);
  assert.equal(refusal(s, o), 'DISPUTE_UNCERTAIN');
  assert.ok(s.isUncertain(D));
  assert.equal(s.held(D), true);
  assert.equal(s.sentFor(D), null);
  assert.equal(s.peek(a.id)!.status === 'sent', false);
  // Recorded: the message is sent, the dispute free again.
  assert.equal(s.recordReadBack(a.id, { state: 'recorded', detail: 'seller message found' }), true);
  assert.equal(s.isUncertain(D), null);
  assert.equal(s.held(D), false);
  assert.equal(s.peek(a.id)!.status, 'sent');
  assert.equal(s.peek(a.id)!.readBack, 'recorded');
  start(s, o);
  s.markUncertain(o.id, 'ambiguous 500');
  // Absent: failed, retryable with the same request id; the dispute is free.
  assert.equal(s.recordReadBack(o.id, { state: 'absent', detail: 'no new offer' }), true);
  assert.equal(s.isUncertain(D), null);
  assert.equal(s.peek(o.id)!.status, 'failed');
  const retry = s.beginSend(o.id, o.caseId, 'o4');
  assert.equal(retry.ok, true);
  assert.equal((retry as { intent: StoredIntent }).intent.requestId, o.requestId);
  s.failed(o.id, 'o4', 'PayPal refused: 422 INVALID_REQUEST', 'refused');
  assert.equal(s.held(D), false);

  // Escalate recorded: no closure lock in the store (PayPal's read decides).
  const e = approved(s, actionDraft('o5', escalate));
  start(s, e);
  assert.equal(s.sent(e.id, 'o5', 'accepted by PayPal'), true);
  // Accepted is not recorded: awaiting read-back holds the dispute.
  assert.equal(s.held(D), true);
  assert.equal(refusal(s, b), 'DISPUTE_UNCERTAIN');
  s.recordReadBack(e.id, { state: 'recorded', detail: 'escalation by seller' });
  assert.equal(s.held(D), false);
  assert.equal(refusal(s, b), 'ok');
  s.failed(b.id, 'o2', 'PayPal refused: 422', 'refused');
  // Accept recorded: the store still allows the next send (the fresh read refuses it).
  const c = approved(s, actionDraft('o6', accept));
  start(s, c);
  s.markUncertain(c.id, 'timeout');
  s.recordReadBack(c.id, { state: 'recorded', detail: 'acceptance by seller' });
  assert.equal(refusal(s, b), 'ok');
  assert.equal(s.sentFor(D), null);
});

test('evidence after escalation: memory keyed by (dispute, stage); legacy entries block the whole dispute', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-locks-'));
  try {
    const file = join(dir, 'intents.json');
    const s = new IntentStore({ file, eventsFile: join(dir, 'audit-events.jsonl'), now: () => NOW });
    const ev = approved(s, evidenceDraft('o1'));
    start(s, ev, 'INQUIRY');
    assert.equal(s.sent(ev.id, 'o1', 'accepted by PayPal', 'INQUIRY'), true);
    assert.equal(s.evidenceSentIn(D, 'INQUIRY'), true);
    assert.equal(s.evidenceSentIn(D, 'CHARGEBACK'), false);
    assert.equal(s.sentFor(D, 'INQUIRY')?.intentId, ev.id);
    assert.equal(s.sentFor(D)?.intentId, ev.id);
    // beginSend keeps the legacy whole-dispute check only; the per-stage one is the route's, after the fresh read.
    const ev2 = approved(s, evidenceDraft('o2'));
    assert.equal(refusal(s, ev2), 'ok');
    s.failed(ev2.id, 'o2', 'x');
    // A restart keeps it, from intents.json and from the send log alone.
    assert.equal(new IntentStore({ file, eventsFile: join(dir, 'audit-events.jsonl') }).evidenceSentIn(D, 'INQUIRY'), true);
    unlinkSync(file);
    const fromLog = new IntentStore({ file, eventsFile: join(dir, 'audit-events.jsonl') });
    assert.equal(fromLog.evidenceSentIn(D, 'INQUIRY'), true);
    assert.equal(fromLog.evidenceSentIn(D, 'CHARGEBACK'), false);
    // Evidence sent with no known stage blocks the whole dispute.
    const s2 = new IntentStore({ now: () => NOW });
    const ev3 = approved(s2, evidenceDraft('o1', 'PP-R-2'));
    start(s2, ev3);
    s2.sent(ev3.id, 'o1', 'accepted');
    assert.equal(s2.evidenceSentIn('PP-R-2', 'CHARGEBACK'), true);
    assert.equal(refusal(s2, approved(s2, evidenceDraft('o2', 'PP-R-2'))), 'SELLER_EVIDENCE_EXISTS');
    // A legacy intents.json entry (no stage) blocks the whole dispute.
    const legacy = join(dir, 'legacy.json');
    writeFileSync(legacy, JSON.stringify({ intents: [], sentDisputes: { 'PP-R-1': { intentId: `int-${'b'.repeat(32)}`, at: NOW.toISOString() } } }));
    const l = new IntentStore({ file: legacy, now: () => NOW });
    assert.equal(l.evidenceSentIn('PP-R-1', 'CHARGEBACK'), true);
    assert.equal(l.evidenceSentIn('PP-R-1', null), true);
    assert.equal(refusal(l, approved(l, evidenceDraft('o1'))), 'SELLER_EVIDENCE_EXISTS');
    // Actions are not blocked by the evidence memory (PayPal's read decides).
    assert.equal(refusal(l, approved(l, actionDraft('o2', message()))), 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('duplicate guard: the same recorded message on the same dispute and stage', () => {
  const s = new IntentStore({ now: () => NOW });
  const a = approved(s, actionDraft('o1', message()));
  const key = duplicateKey(a)!;
  assert.equal(s.recordedDuplicate(D, key), false);
  start(s, a);
  s.sent(a.id, 'o1', 'accepted');
  assert.equal(s.recordedDuplicate(D, key), false, 'accepted is not recorded');
  s.recordReadBack(a.id, { state: 'recorded', detail: 'found' });
  assert.equal(s.recordedDuplicate(D, key), true);
  assert.equal(s.recordedDuplicate('PP-R-OTHER', key), false);
  assert.equal(s.recordedDuplicate(D, duplicateKey(actionDraft('o1', message(), { stage: 'CHARGEBACK' }) as unknown as StoredIntent)!), false);
  assert.equal(s.recordedDuplicate(D, duplicateKey(actionDraft('o1', message('other text')) as unknown as StoredIntent)!), false);
});

test('send log seeds uncertain without intents.json', () => {
  for (const loss of ['deleted', 'corrupt'] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'rk-locks-'));
    try {
      const file = join(dir, 'intents.json');
      const eventsFile = join(dir, 'audit-events.jsonl');
      const s = new IntentStore({ file, eventsFile, now: () => NOW });
      const a = approved(s, actionDraft('o1', message()));
      start(s, a);
      // A legacy sent without action (main's format) for another dispute.
      appendFileSync(join(dir, 'audit-events-sends.jsonl'), JSON.stringify({ at: NOW.toISOString(), caseId: CASE, kind: 'sent', actor: 'local', disputeId: 'PP-R-OLD', intentId: `int-${'c'.repeat(32)}` }) + '\n');
      // The process dies: no outcome. intents.json is lost.
      if (loss === 'deleted') unlinkSync(file);
      else writeFileSync(file, '{broken');
      const r = new IntentStore({ file, eventsFile, now: () => NOW });
      assert.deepEqual(r.isUncertain(D), { intentId: a.id, since: NOW.toISOString() }, loss);
      assert.equal(r.held(D), true);
      const o = approved(r, actionDraft('o2', offer));
      assert.equal(refusal(r, o), 'DISPUTE_UNCERTAIN');
      assert.equal(r.evidenceSentIn('PP-R-OLD', 'CHARGEBACK'), true);
      assert.equal(r.sentFor('PP-R-OLD')?.intentId, `int-${'c'.repeat(32)}`);
      // A read-back that proves it absent clears it, durably (seen by the next start).
      assert.equal(r.recordReadBack(a.id, { state: 'absent', detail: 'no new message' }), true);
      assert.equal(r.isUncertain(D), null);
      assert.equal(new IntentStore({ file, eventsFile, now: () => NOW }).isUncertain(D), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('restart: an action loaded as sending is failed and uncertain; evidence only failed (as today)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-locks-'));
  try {
    const file = join(dir, 'intents.json');
    const s = new IntentStore({ file, now: () => NOW });
    const a = approved(s, actionDraft('o1', message()));
    assert.equal(s.beginSend(a.id, CASE, 'o1').ok, true);
    const e = approved(s, evidenceDraft('o2', 'PP-R-EV'));
    assert.equal(s.beginSend(e.id, CASE, 'o2').ok, true);
    const r = new IntentStore({ file, now: () => NOW });
    assert.equal(r.peek(a.id)!.status, 'failed');
    assert.equal(r.isUncertain(D)?.intentId, a.id);
    assert.equal(r.peek(e.id)!.status, 'failed');
    assert.equal(r.isUncertain('PP-R-EV'), null);
    assert.equal(r.beginSend(e.id, CASE, 'o2').ok, true);
    // Recorded keys and uncertain survive in intents.json without a send log.
    r.failed(e.id, 'o2', 'x');
    r.recordReadBack(a.id, { state: 'recorded', detail: 'found' });
    assert.equal(new IntentStore({ file, now: () => NOW }).recordedDuplicate(D, duplicateKey(a)!), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('message text never reaches the audit or send log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-locks-'));
  try {
    const eventsFile = join(dir, 'audit-events.jsonl');
    const s = new IntentStore({ file: join(dir, 'intents.json'), eventsFile, now: () => NOW });
    const a = approved(s, actionDraft('o1', message()));
    start(s, a);
    s.markUncertain(a.id, 'timeout');
    s.recordReadBack(a.id, { state: 'pending', detail: 'not yet' });
    s.recordReadBack(a.id, { state: 'recorded', detail: 'found' });
    const b = approved(s, actionDraft('o1', message(TEXT + ' again')));
    start(s, b);
    s.failed(b.id, 'o1', 'PayPal refused: 422', 'refused');
    const all = s.events(CASE);
    const logs = readFileSync(eventsFile, 'utf8') + readFileSync(join(dir, 'audit-events-sends.jsonl'), 'utf8');
    for (const blob of [JSON.stringify(all), logs]) {
      assert.ok(!blob.includes('secret words'), 'message text in a log');
      assert.ok(!blob.includes('1Z999'));
    }
    const sends = all.filter((e) => ['send_started', 'sent', 'send_failed', 'send_uncertain', 'read_back'].includes(e.kind));
    assert.deepEqual([...new Set(sends.map((e) => e.kind))].sort(), ['read_back', 'send_failed', 'send_started', 'send_uncertain']);
    for (const e of sends) {
      assert.equal(e.action, 'send_message');
      assert.equal(e.scope, 'action');
      assert.equal(e.stage, 'INQUIRY');
      assert.match(e.textSha256!, /^[0-9a-f]{64}$/);
    }
    assert.equal(sends.find((e) => e.intentId === a.id)!.textSha256, sha(TEXT));
    assert.deepEqual(sends.filter((e) => e.kind === 'read_back').map((e) => e.detail), ['pending', 'recorded']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------------ review fixes

test('fix 1: a refused action send frees the dispute, also on reseed; an ambiguous or unflagged one keeps the hold', () => {
  for (const proof of ['refused', 'ambiguous', undefined] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'rk-locks-'));
    try {
      const file = join(dir, 'intents.json');
      const eventsFile = join(dir, 'audit-events.jsonl');
      const s = new IntentStore({ file, eventsFile, now: () => NOW });
      const a = approved(s, actionDraft('o1', message()));
      start(s, a);
      s.failed(a.id, 'o1', 'PayPal refused: 422 INVALID_REQUEST', proof);
      assert.equal(s.held(D), proof !== 'refused', `memory, ${proof}`);
      if (proof === 'refused') {
        const ev = s.events(CASE).find((e) => e.kind === 'send_failed')!;
        assert.equal(ev.outcome, 'refused');
      }
      unlinkSync(file);
      assert.equal(new IntentStore({ file, eventsFile, now: () => NOW }).held(D), proof !== 'refused', `reseed, ${proof}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // A legacy send_failed (no outcome) after an action send_started keeps the hold on reseed.
  const dir = mkdtempSync(join(tmpdir(), 'rk-locks-'));
  try {
    const at = NOW.toISOString();
    const base = { at, caseId: CASE, actor: 'local', disputeId: D, intentId: `int-${'d'.repeat(32)}`, action: 'send_message', scope: 'action' };
    writeFileSync(join(dir, 'audit-events-sends.jsonl'), [{ ...base, kind: 'send_started' }, { ...base, kind: 'send_failed' }].map((e) => JSON.stringify(e)).join('\n') + '\n');
    assert.equal(new IntentStore({ eventsFile: join(dir, 'audit-events.jsonl'), now: () => NOW }).held(D), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Evidence is unchanged: a failed evidence send never holds.
  const s = new IntentStore({ now: () => NOW });
  const ev = approved(s, evidenceDraft('o1'));
  start(s, ev);
  s.failed(ev.id, 'o1', 'x', 'ambiguous');
  assert.equal(s.held(D), false);
  assert.equal(s.peek(ev.id)!.status, 'failed');
});

test('fix 2: a read-back during the in-flight POST is refused and changes nothing', () => {
  const s = new IntentStore({ now: () => NOW });
  const a = approved(s, actionDraft('o1', message()));
  const b = approved(s, actionDraft('o2', offer));
  start(s, a);
  assert.equal(s.recordReadBack(a.id, { state: 'absent', detail: 'nothing yet' }), false);
  assert.equal(s.recordReadBack(a.id, { state: 'recorded', detail: 'x' }), false);
  assert.equal(s.recordReadBack(a.id, { state: 'pending', detail: 'x' }), false);
  assert.equal(s.peek(a.id)!.status, 'sending');
  assert.equal(refusal(s, b), 'DISPUTE_BUSY');
  assert.equal(s.events(CASE).some((e) => e.kind === 'read_back'), false);
});

test('fix 3: a recorded or absent read-back whose log line is not durable changes nothing', async () => {
  const { durableTestHooks } = await import('@resolvekit/hosting');
  for (const state of ['recorded', 'absent'] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'rk-locks-'));
    try {
      const file = join(dir, 'intents.json');
      const eventsFile = join(dir, 'audit-events.jsonl');
      const s = new IntentStore({ file, eventsFile, now: () => NOW });
      const a = approved(s, actionDraft('o1', message()));
      start(s, a);
      s.markUncertain(a.id, 'timeout');
      const before = readFileSync(file, 'utf8');
      durableTestHooks.failAt = 'write';
      durableTestHooks.match = /sends\.jsonl$/;
      assert.equal(s.recordReadBack(a.id, { state, detail: 'proof' }), false);
      assert.ok(s.isUncertain(D), state);
      assert.equal(s.peek(a.id)!.status, 'failed');
      assert.equal(s.peek(a.id)!.readBack, 'pending');
      assert.equal(s.recordedDuplicate(D, duplicateKey(a)!), false);
      assert.equal(readFileSync(file, 'utf8'), before);
      // Once the log can be written, it goes through.
      assert.equal(s.recordReadBack(a.id, { state, detail: 'proof' }), true);
      assert.equal(s.isUncertain(D), null);
    } finally {
      durableTestHooks.failAt = null;
      durableTestHooks.match = null;
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('fix 4: the duplicate guard is rebuilt from the send log alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-locks-'));
  try {
    const file = join(dir, 'intents.json');
    const eventsFile = join(dir, 'audit-events.jsonl');
    const s = new IntentStore({ file, eventsFile, now: () => NOW });
    const a = approved(s, actionDraft('o1', message()));
    start(s, a);
    s.sent(a.id, 'o1', 'accepted');
    s.recordReadBack(a.id, { state: 'recorded', detail: 'found' });
    unlinkSync(file);
    const r = new IntentStore({ file, eventsFile, now: () => NOW });
    assert.equal(r.recordedDuplicate(D, duplicateKey(a)!), true);
    assert.equal(r.held(D), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fix 8: markUncertain is for actions only', () => {
  const s = new IntentStore({ now: () => NOW });
  const ev = approved(s, evidenceDraft('o1'));
  start(s, ev);
  assert.equal(s.markUncertain(ev.id, 'timeout'), false);
  assert.equal(s.isUncertain(D), null);
  assert.equal(s.peek(ev.id)!.status, 'sending');
});
