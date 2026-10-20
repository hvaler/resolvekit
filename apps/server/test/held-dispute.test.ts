/**
 * IMP2 (final review): a held dispute is always releasable without sending. A 409 DISPUTE_UNCERTAIN names the holding
 * send (intent and case); GET …/hold finds it after a reload; POST …/readback reads it back (never a POST to PayPal) for
 * anyone of the seller's workspace; a hold whose intent is gone (intents.json lost, hold from the send log) is shown and
 * stays held, with the reason (the operator's route: hosted.test.ts). Fakes from the recorded read; nothing is sent anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntentStore } from '../src/intents.ts';
import { CASE, REAL, T0, TOKEN, answer, approve, compose, intentPath, postRaw, readBack, send, setupActions, timeout, withMessage } from './actions-kit.ts';
import { TOKEN_HEADER } from '../src/app.ts';

const BASE = 'http://127.0.0.1:8787';
const holdOf = async (app: Awaited<ReturnType<typeof setupActions>>['app']) =>
  answer(await app(new Request(`${BASE}/api/disputes/${CASE}/hold`, { headers: { [TOKEN_HEADER]: TOKEN } })));
const TEXT = 'Your order shipped on 7 Oct; tracking 1Z999AA10123456784.';

test('DISPUTE_UNCERTAIN carries the holder; the hold route finds it after a reload; check again on the holder releases it', async () => {
  let reply: (() => Error | { status: number; body: unknown }) | null = () => timeout();
  const { app, pp, state, intents } = await setupActions({ actionReply: () => reply?.() ?? { status: 200, body: { links: [] } } });
  const a = await compose(app);
  await approve(app, a);
  assert.equal((await send(app, a)).body.sent, 'unknown');
  reply = null;
  // Another intent is refused, naming the send that holds the dispute (never «nothing was sent» about it).
  const b = await compose(app, { action: 'send_message', text: 'Another message.' });
  await approve(app, b);
  const refused = await send(app, b);
  assert.deepEqual([refused.status, refused.body.error], [409, 'DISPUTE_UNCERTAIN']);
  assert.deepEqual(refused.body.holder, { intentId: a.id, caseId: CASE });
  // A reloaded page: the hold route names it (no PayPal read), with its action.
  const reads = pp.reads.length;
  const h = await holdOf(app);
  assert.equal(h.status, 200);
  assert.deepEqual(h.body.hold, { disputeId: REAL, intentId: a.id, caseId: CASE, since: new Date(T0).toISOString(), state: 'uncertain', action: 'send_message', intentKnown: true, own: true });
  assert.equal(pp.reads.length, reads);
  // The read-back is a POST now; GET is refused.
  const get = await app(new Request(`${BASE}${intentPath}/${a.id}/readback`, { headers: { [TOKEN_HEADER]: TOKEN } }));
  assert.equal(get.status, 405);
  // Check again on THAT intent: PayPal shows the message → recorded, the dispute is free, nothing was posted again.
  state.dispute = withMessage(state.dispute, 'SELLER', T0 + 1_000, TEXT);
  const rb = await readBack(app, a);
  assert.equal((rb.body.readBack as { state: string }).state, 'recorded', JSON.stringify(rb.body));
  assert.equal(rb.body.hold, null);
  assert.equal((await holdOf(app)).body.hold, null);
  assert.equal(intents.isUncertain(REAL), null);
  assert.equal(pp.posts.length, 1);
  // The refused intent goes on now (it was never sent).
  assert.equal((await send(app, b)).status, 202);
});

test('check again on the holder: proven absent releases the dispute too (the holder may then be sent again)', async () => {
  const { app, state, intents } = await setupActions({ actionReply: () => timeout() });
  const a = await compose(app);
  await approve(app, a);
  await send(app, a);
  // Past the contract's absence delay, PayPal shows no seller entry and still offers the action.
  state.t += 61_000;
  const rb = await readBack(app, a);
  assert.equal((rb.body.readBack as { state: string }).state, 'absent', JSON.stringify(rb.body));
  assert.equal(intents.isUncertain(REAL), null);
  assert.equal((await holdOf(app)).body.hold, null);
});

test('a read-back of an intent that holds nothing and is not the person’s: unknown (no PayPal read)', async () => {
  const { app, pp } = await setupActions();
  const r = await answer(await app(postRaw(`${intentPath}/int-${'e'.repeat(32)}/readback`, {})));
  assert.deepEqual([r.status, r.body.error], [404, 'UNKNOWN_INTENT']);
  assert.equal(pp.reads.length, 0);
});

test('intents.json lost: the hold from the send log is shown, read back as pending with the reason, and stays held', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-held-'));
  try {
    const intentId = `int-${'f'.repeat(32)}`;
    const at = new Date(T0).toISOString();
    const e = { at, caseId: CASE, actor: 'local', disputeId: REAL, intentId, contentHash: 'c'.repeat(64), requestId: `rk-${intentId}`, action: 'send_message', scope: 'action', stage: 'INQUIRY' };
    writeFileSync(join(dir, 'audit-events-sends.jsonl'), [{ ...e, kind: 'send_started' }, { ...e, kind: 'sent' }].map((x) => JSON.stringify(x)).join('\n') + '\n');
    const now = { t: T0 + 120_000 };
    const intents = new IntentStore({ file: join(dir, 'intents.json'), eventsFile: join(dir, 'audit-events.jsonl'), now: () => new Date(now.t) });
    assert.equal(intents.held(REAL), true);
    const { app, pp } = await setupActions({ intents });
    const h = await holdOf(app);
    assert.deepEqual(h.body.hold, { disputeId: REAL, intentId, caseId: CASE, since: at, state: 'uncertain', action: 'send_message', intentKnown: false, own: false });
    const rb = await answer(await app(postRaw(`${intentPath}/${intentId}/readback`, {})));
    assert.equal(rb.status, 200, JSON.stringify(rb.body));
    assert.equal((rb.body.readBack as { state: string }).state, 'pending');
    assert.match(String((rb.body.readBack as { detail: string }).detail), /no longer has the approved content/);
    assert.equal(rb.body.intent, null);
    assert.equal(intents.held(REAL), true);
    assert.equal(pp.posts.length, 0);
    assert.equal(pp.posts.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
