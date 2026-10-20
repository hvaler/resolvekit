/**
 * B0 (Task 7): the generic action route. compose → approve → (confirm) → send once, with the intent's PayPal-Request-Id,
 * after a fresh read and the re-checks; then read back with a proof attributable to this send ([A1], [A3]–[A5]). Every
 * test runs on a fake PayPal built from a recorded sandbox read: nothing is sent anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { durableTestHooks } from '@resolvekit/hosting';
import { PayPalClient, PayPalError } from '@resolvekit/paypal';
import { callPayPal, capOf, isAmbiguous } from '../src/actions/calls.ts';
import { IntentStore } from '../src/intents.ts';
import {
  ABSENT_AFTER_MS,
  CASE,
  REAL,
  T0,
  TEST_CONTRACTS,
  acknowledge,
  answer,
  approve,
  compose,
  confirm,
  evidencePath,
  intentPath,
  postRaw,
  readBack,
  send,
  sendPath,
  setupActions,
  timeout,
  withMessage,
} from './actions-kit.ts';
import { RESOLVED } from './kit.ts';

const TEXT = 'Your order shipped on 7 Oct; tracking 1Z999AA10123456784.';

test('happy path: compose → approve → send once with the intent’s Request-Id → pending until an attributable entry → recorded', async () => {
  const { app, pp, state, intents } = await setupActions();
  const i = await compose(app);
  assert.equal(i.status, 'proposed');
  assert.equal(i.disputeId, REAL);
  const a = await approve(app, i);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  // A first-time message needs no second confirmation.
  assert.equal(a.body.confirmation, null);
  state.t += 1_000;
  const s = await send(app, i);
  assert.equal(s.status, 202, JSON.stringify(s.body));
  assert.equal(s.body.sent, true);
  assert.equal(pp.posts.length, 1);
  assert.equal(pp.posts[0]!.path, `/v1/customer/disputes/${REAL}/send-message`);
  assert.equal(pp.posts[0]!.requestId, i.requestId);
  assert.deepEqual(JSON.parse(pp.posts[0]!.body), { message: TEXT });
  // Accepted is not recorded: held until PayPal shows an entry attributable to this send.
  assert.ok(intents.isUncertain(REAL));
  const r1 = await readBack(app, i);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal((r1.body.readBack as { state: string }).state, 'pending');
  assert.ok(Array.isArray((r1.body.snapshot as { messages: unknown[] }).messages));
  assert.ok(intents.isUncertain(REAL));
  // PayPal shows the seller's message, posted after send_started, with the approved text.
  state.dispute = withMessage(state.dispute, 'SELLER', state.t + 2_000, TEXT);
  state.t += 5_000;
  const r2 = await readBack(app, i);
  assert.equal((r2.body.readBack as { state: string }).state, 'recorded');
  assert.equal(intents.isUncertain(REAL), null);
  assert.equal(intents.peek(i.id)!.readBack, 'recorded');
  assert.equal(pp.posts.length, 1);
  // The send log keeps only the text's hash.
  const logged = intents.events(CASE).filter((e) => e.kind === 'send_started');
  assert.equal(logged.length, 1);
  assert.ok(logged[0]!.textSha256 && !JSON.stringify(intents.events(CASE)).includes(TEXT));
});

test('a bare state change after the send is not proof', async () => {
  const { app, state, intents } = await setupActions();
  const i = await compose(app);
  await approve(app, i);
  assert.equal((await send(app, i)).status, 202);
  // The buyer (or PayPal) changes the status; no seller entry appears.
  state.dispute = { ...state.dispute, status: 'WAITING_FOR_BUYER_RESPONSE', update_time: new Date(T0 + 9_000).toISOString() };
  // Within the contract's absence delay: neither proof nor proven absence.
  state.t += 5_000;
  const r = await readBack(app, i);
  assert.equal((r.body.readBack as { state: string }).state, 'pending');
  assert.ok(intents.isUncertain(REAL));
  // Nothing else is written on the dispute until it is reconciled.
  const j = await compose(app, { action: 'send_message', text: 'Another message.' });
  await approve(app, j);
  const s = await send(app, j);
  assert.equal(s.status, 409);
  assert.equal(s.body.error, 'DISPUTE_UNCERTAIN');
});

test('ambiguous error → uncertain; known 4xx → failed, not uncertain', async () => {
  {
    const { app, pp, intents } = await setupActions({ actionReply: () => timeout() });
    const i = await compose(app);
    await approve(app, i);
    const s = await send(app, i);
    assert.equal(s.status, 202, JSON.stringify(s.body));
    assert.equal(s.body.sent, 'unknown');
    assert.match(String(s.body.detail), /Outcome pending confirmation/);
    assert.equal(pp.posts.length, 1);
    assert.equal(intents.isUncertain(REAL)?.intentId, i.id);
  }
  {
    const { app, pp, intents } = await setupActions({ actionReply: () => ({ status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'X' }] } }) });
    const i = await compose(app);
    await approve(app, i);
    const s = await send(app, i);
    assert.equal(s.status, 422, JSON.stringify(s.body));
    assert.equal(s.body.paypalIssue, 'X');
    assert.equal(pp.posts.length, 1);
    assert.equal(intents.isUncertain(REAL), null);
    assert.equal(intents.peek(i.id)!.status, 'failed');
    // Nothing was done at PayPal: no read-back to do.
    assert.equal((await readBack(app, i)).body.error, 'INTENT_NOT_SENT');
  }
});

test('isAmbiguous: only a 4xx with a PayPal issue code proves a refusal; capOf names the cap', () => {
  assert.equal(isAmbiguous(new PayPalError(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'NOTE_REQUIRED' }] }, null)), false);
  assert.equal(isAmbiguous(new PayPalError(400, { name: 'INVALID_REQUEST', details: [{ issue: 'INVALID_PARAMETER' }] }, null)), false);
  assert.equal(isAmbiguous(new PayPalError(422, { name: 'UNPROCESSABLE_ENTITY' }, null)), true);
  assert.equal(isAmbiguous(new PayPalError(429, { name: 'RATE_LIMIT_REACHED' }, null)), true);
  assert.equal(isAmbiguous(new PayPalError(400, { name: 'NON_JSON_RESPONSE', details: [{ issue: 'X' }] }, null)), true);
  assert.equal(isAmbiguous(new PayPalError(200, { name: 'NON_JSON_RESPONSE' }, null)), true);
  assert.equal(isAmbiguous(new PayPalError(500, { name: 'INTERNAL_SERVER_ERROR', details: [{ issue: 'X' }] }, null)), true);
  assert.equal(isAmbiguous(new PayPalError(503, {}, null)), true);
  assert.equal(isAmbiguous(timeout()), true);
  assert.equal(isAmbiguous(new TypeError('fetch failed')), true);
  assert.deepEqual(
    (['provide_evidence', 'send_message', 'accept_claim', 'make_offer', 'escalate', 'appeal'] as const).map(capOf),
    ['evidence', 'message', 'settle', 'settle', 'settle', 'settle'],
  );
});

test('callPayPal: one POST by action in the contract’s format, with the intent’s request id (escalate, accept)', async () => {
  const { pp } = await setupActions();
  const blank = { caseId: CASE, disputeId: REAL, documentsHash: '', analysisKey: '', evidenceType: 'OTHER' as const, carrier: '', tracking: '', notes: '', files: [], sentences: [], resolutionNotes: [] };
  await callPayPal(pp.client, REAL, { ...blank, action: 'escalate', payload: { kind: 'escalate', note: 'Shipped with tracking.' } }, [], 'rk-int-1', TEST_CONTRACTS);
  await callPayPal(pp.client, REAL, { ...blank, action: 'accept_claim', payload: { kind: 'accept_claim', acceptType: 'REFUND', note: '', amount: null } }, [], 'rk-int-2', TEST_CONTRACTS);
  assert.deepEqual(
    pp.posts.map((p) => [p.path.split('/').pop(), p.requestId, JSON.parse(p.body)]),
    [
      ['escalate', 'rk-int-1', { note: 'Shipped with tracking.' }],
      ['accept-claim', 'rk-int-2', { accept_claim_type: 'REFUND' }],
    ],
  );
  // A variant without a recorded contract never reaches PayPal.
  await assert.rejects(callPayPal(pp.client, REAL, { ...blank, action: 'escalate', payload: { kind: 'escalate', note: 'x' } }, [], 'rk-int-3'), /Not available: Contract recorded; flow not built yet/);
  assert.equal(pp.posts.length, 2);
});

test('retry reconciles: recorded → no POST; pending → refused; absent (after absentAfterMs, still offered) → POST with the same Request-Id', async () => {
  // Recorded: PayPal shows the message after all.
  {
    let fail = true;
    const { app, pp, state, intents } = await setupActions({ actionReply: () => (fail ? timeout() : { status: 200, body: {} }) });
    const i = await compose(app);
    await approve(app, i);
    assert.equal((await send(app, i)).body.sent, 'unknown');
    fail = false;
    state.dispute = withMessage(state.dispute, 'SELLER', state.t + 1_000, TEXT);
    state.t += 2_000;
    const s = await send(app, i);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.reconciled, true);
    assert.equal(pp.posts.length, 1);
    assert.equal(intents.isUncertain(REAL), null);
  }
  // Pending: no proof either way, too early to call it absent.
  {
    let fail = true;
    const { app, pp, state, intents } = await setupActions({ actionReply: () => (fail ? timeout() : { status: 200, body: {} }) });
    const i = await compose(app);
    await approve(app, i);
    await send(app, i);
    fail = false;
    state.t += 2_000;
    const s = await send(app, i);
    assert.equal(s.status, 409, JSON.stringify(s.body));
    assert.equal(s.body.error, 'DISPUTE_UNCERTAIN');
    assert.equal(pp.posts.length, 1);
    assert.equal(intents.isUncertain(REAL)?.intentId, i.id);
  }
  // Absent: past the contract's delay, no seller entry, PayPal still offers the action → the same request again.
  {
    let fail = true;
    const { app, pp, state, intents } = await setupActions({ actionReply: () => (fail ? timeout() : { status: 200, body: {} }) });
    const i = await compose(app);
    await approve(app, i);
    await send(app, i);
    fail = false;
    state.t += ABSENT_AFTER_MS + 1_000;
    const s = await send(app, i);
    assert.equal(s.status, 202, JSON.stringify(s.body));
    assert.equal(s.body.sent, true);
    assert.equal(pp.posts.length, 2);
    assert.equal(pp.posts[0]!.requestId, pp.posts[1]!.requestId);
    assert.equal(pp.posts[1]!.requestId, i.requestId);
    // Held again until its own read-back.
    assert.equal(intents.isUncertain(REAL)?.intentId, i.id);
  }
});

test('re-check matrix', async () => {
  const { app, pp, state, intents } = await setupActions();
  const base = state.dispute;
  const attempt = async (change: () => void) => {
    state.dispute = base;
    const i = await compose(app);
    assert.equal((await approve(app, i)).status, 200);
    change();
    const s = await send(app, i);
    state.dispute = base;
    return { s, i: intents.peek(i.id)! };
  };
  // PayPal no longer offers the action.
  const gone = await attempt(() => (state.dispute = { ...base, links: base.links!.filter((l) => l.rel !== 'send_message') }));
  assert.equal(gone.s.status, 409);
  assert.equal(gone.s.body.error, 'ACTION_NOT_OFFERED');
  assert.equal(gone.i.status, 'invalidated');
  // Another stage than the contract recorded.
  const stage = await attempt(() => (state.dispute = { ...base, dispute_life_cycle_stage: 'CHARGEBACK' }));
  assert.equal(stage.s.body.error, 'ACTION_STAGE');
  assert.equal(stage.i.status, 'invalidated');
  // Another status: the pinned dispute changed.
  const status = await attempt(() => (state.dispute = { ...base, status: 'WAITING_FOR_BUYER_RESPONSE' }));
  assert.equal(status.s.body.error, 'INTENT_STALE');
  assert.equal(status.i.status, 'invalidated');
  // Another amount: not this case's payment any more.
  const amount = await attempt(() => (state.dispute = { ...base, dispute_amount: { currency_code: 'USD', value: '8.00' } }));
  assert.equal(amount.s.body.error, 'BINDING_INVALID');
  assert.equal(amount.i.status, 'invalidated');
  assert.equal(pp.posts.length, 0);
  assert.equal(intents.isUncertain(REAL), null);
});

test('re-check: an unreadable dispute refuses the send and keeps the approval', async () => {
  let unreadable = false;
  const { app, pp } = await setupActions({ readReply: () => (unreadable ? { status: 503, body: { name: 'SERVICE_UNAVAILABLE' } } : null) });
  const i = await compose(app);
  await approve(app, i);
  unreadable = true;
  const s = await send(app, i);
  assert.equal(s.status, 409);
  assert.equal(s.body.error, 'BINDING_UNAVAILABLE');
  unreadable = false;
  const again = await send(app, i);
  assert.equal(again.status, 202, JSON.stringify(again.body));
  assert.equal(pp.posts.length, 1);
});

test('NEEDS_REVIEW: a new buyer message after approval holds a message; acknowledge re-arms it; the merchant’s own message never holds it', async () => {
  const { app, pp, state } = await setupActions();
  const i = await compose(app);
  await approve(app, i);
  state.dispute = withMessage(state.dispute, 'BUYER', state.t + 1_000, 'Where is my parcel?');
  state.t += 2_000;
  const s = await send(app, i);
  assert.equal(s.status, 409);
  assert.equal(s.body.error, 'NEEDS_REVIEW');
  const messages = s.body.messages as Array<{ postedBy: string; content: string }>;
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.content, 'Where is my parcel?');
  assert.equal(pp.posts.length, 0);
  // Another buyer message arrives after NEEDS_REVIEW showed the first: acknowledging only what was shown is not enough.
  const shown = s.body.messageKeys as string[];
  assert.equal(shown.length, 1);
  state.dispute = withMessage(state.dispute, 'BUYER', state.t + 1_000, 'Hello? Anyone?');
  state.t += 2_000;
  const again = await acknowledge(app, i, shown);
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.error, 'NEEDS_REVIEW');
  assert.deepEqual((again.body.messages as Array<{ content: string }>).map((m) => m.content), ['Hello? Anyone?']);
  // The person read it too and sends the same content: one step, against a new read.
  const ack = await acknowledge(app, i, [...shown, ...(again.body.messageKeys as string[])]);
  assert.equal(ack.status, 200, JSON.stringify(ack.body));
  // The merchant's own message (sent elsewhere) is not a reason to hold it.
  state.dispute = withMessage(state.dispute, 'SELLER', state.t + 1_000, 'Sent from PayPal.');
  state.t += 2_000;
  const ok = await send(app, i);
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
  assert.equal(pp.posts.length, 1);
});

test('irrelevant changes never invalidate', async () => {
  const { app, pp, state } = await setupActions();
  const i = await compose(app);
  await approve(app, i);
  // Another read time, the links in another order, another update_time: none is in the hash or the rules.
  state.t += 60_000;
  state.dispute = { ...state.dispute, links: [...state.dispute.links!].reverse(), update_time: new Date(T0 + 30_000).toISOString() };
  const s = await send(app, i);
  assert.equal(s.status, 202, JSON.stringify(s.body));
  assert.equal(pp.posts.length, 1);
});

test('persistence failure before the POST: nothing is sent', async () => {
  for (const match of [/intents\.json$/, /sends\.jsonl$/]) {
    const dir = mkdtempSync(join(tmpdir(), 'rk-actions-'));
    try {
      const intents = new IntentStore({ file: join(dir, 'intents.json'), eventsFile: join(dir, 'audit-events.jsonl'), now: () => new Date(T0) });
      const { app, pp } = await setupActions({ intents });
      const i = await compose(app);
      await approve(app, i);
      intents.flush();
      durableTestHooks.failAt = 'write';
      durableTestHooks.match = match;
      const s = await send(app, i);
      durableTestHooks.failAt = null;
      durableTestHooks.match = null;
      assert.equal(s.status, 503, `${match}: ${JSON.stringify(s.body)}`);
      assert.equal(s.body.error, 'AUDIT_UNAVAILABLE');
      assert.equal(pp.posts.length, 0);
      assert.equal(intents.isUncertain(REAL), null);
      // Nothing is lost: the same intent goes once the disk is back.
      assert.equal((await send(app, i)).status, 202);
      assert.equal(pp.posts.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('duplicate submission', async () => {
  const { app, pp } = await setupActions({ postDelayMs: 20 });
  const i = await compose(app);
  await approve(app, i);
  // A read-back while the POST has not answered is refused: nothing is read back before PayPal answers.
  const during = (async () => {
    while (pp.posts.length === 0) await new Promise((r) => setTimeout(r, 1));
    return readBack(app, i);
  })();
  const all = await Promise.all([send(app, i), send(app, i)]);
  assert.deepEqual(all.map((r) => r.status).sort(), [202, 409]);
  assert.equal(all.find((r) => r.status === 409)!.body.error, 'INTENT_SENDING');
  assert.equal(pp.posts.length, 1);
  const rb = await during;
  assert.equal(rb.status, 409);
  assert.equal(rb.body.error, 'INTENT_SENDING');
});

test('the uncertain lock: only the action route’s reconcile lets the holding intent through', async () => {
  const { app, intents } = await setupActions({ actionReply: () => timeout() });
  const i = await compose(app);
  await approve(app, i);
  await send(app, i);
  const plain = intents.beginSend(i.id, CASE, intents.peek(i.id)!.createdBy);
  assert.equal(plain.ok, false);
  assert.equal(!plain.ok && plain.error, 'DISPUTE_UNCERTAIN');
  const reconcile = intents.beginSend(i.id, CASE, intents.peek(i.id)!.createdBy, { reconcile: true });
  assert.equal(reconcile.ok, true);
  intents.revert(i.id, reconcile.ok ? reconcile.previous : 'failed');
  assert.equal(intents.isUncertain(REAL)?.intentId, i.id);
});

test('cross-route replay refused', async () => {
  const { app, pp, intents } = await setupActions();
  // A message sent through the evidence route.
  const m = await compose(app);
  await approve(app, m);
  const viaEvidence = await answer(await app(postRaw(evidencePath, { intentId: m.id })));
  assert.equal(viaEvidence.status, 409);
  assert.equal(viaEvidence.body.error, 'WRONG_SEND_ROUTE');
  assert.equal(intents.peek(m.id)!.status, 'approved');
  // Evidence sent through the action route.
  const e = await answer(await app(postRaw(intentPath, { evidenceType: 'PROOF_OF_FULFILLMENT', resolutions: RESOLVED })));
  assert.equal(e.status, 201, JSON.stringify(e.body));
  const ev = e.body as { id: string; contentHash: string };
  assert.equal((await answer(await app(postRaw(`${intentPath}/${ev.id}/approve`, { contentHash: ev.contentHash })))).status, 200);
  const viaSend = await answer(await app(postRaw(sendPath, { intentId: ev.id })));
  assert.equal(viaSend.status, 409);
  assert.equal(viaSend.body.error, 'WRONG_SEND_ROUTE');
  assert.equal(intents.peek(ev.id)!.status, 'approved');
  assert.equal(pp.posts.length, 0);
});

test('second confirmation: bound to the intent; any other terms refused; send needs it', async () => {
  const { app, pp } = await setupActions();
  const i = await compose(app, { action: 'escalate', note: 'The parcel was delivered; see tracking.' });
  const a = await approve(app, i);
  const terms = a.body.confirmation as Record<string, unknown>;
  assert.deepEqual(terms, { intentId: i.id, contentHash: i.contentHash, action: 'escalate', amount: null, currency: null, consequence: 'MOVES_TO_CLAIM' });
  const early = await send(app, i);
  assert.equal(early.status, 409);
  assert.equal(early.body.error, 'CONFIRMATION_REQUIRED');
  for (const wrong of [{ ...terms, consequence: 'REFUNDS_BUYER' }, { ...terms, contentHash: 'f'.repeat(64) }, { ...terms, extra: 1 }, { ...terms, amount: '7.00', currency: 'USD' }]) {
    const c = await confirm(app, i, wrong);
    assert.equal(c.status, 409);
    assert.equal(c.body.error, 'CONFIRMATION_MISMATCH');
    assert.equal(c.body.detail, 'These terms are not the ones of this intent; compose it again');
  }
  assert.equal((await confirm(app, i, terms)).status, 200);
  const s = await send(app, i);
  assert.equal(s.status, 202, JSON.stringify(s.body));
  assert.equal(pp.posts.length, 1);
  assert.match(pp.posts[0]!.path, /\/escalate$/);
});

test('server: send_message through the real registry entry, body format from the contract; the other actions still refused', async () => {
  const { app, pp, state, intents } = await setupActions({ registry: false });
  // The recorded W-1 request, byte for byte: JSON { message }, stored by PayPal with no normalisation.
  const recorded = JSON.parse(readFileSync(new URL('../../../packages/paypal/contracts/send_message.json', import.meta.url), 'utf8')) as { request: { body: { message: string }; contentType: string } };
  const text = recorded.request.body.message;
  const i = await compose(app, { action: 'send_message', text });
  assert.equal(i.repeat, false);
  assert.equal((await approve(app, i)).body.confirmation, null);
  state.t += 1_000;
  const s = await send(app, i);
  assert.equal(s.status, 202, JSON.stringify(s.body));
  assert.equal(pp.posts.length, 1);
  assert.equal(pp.posts[0]!.path, `/v1/customer/disputes/${REAL}/send-message`);
  assert.equal(pp.posts[0]!.requestId, i.requestId);
  assert.equal(recorded.request.contentType, 'application/json');
  assert.equal(pp.posts[0]!.body, JSON.stringify(recorded.request.body));
  // The production proof: the seller entry PayPal shows, timed after send_started, byte-identical.
  state.dispute = withMessage(state.dispute, 'SELLER', state.t + 3_000, text);
  state.t += 5_000;
  assert.equal(((await readBack(app, i)).body.readBack as { state: string }).state, 'recorded');
  assert.equal(intents.isUncertain(REAL), null);
  // At a stage the contract never recorded: refused before anything is created.
  state.dispute = { ...state.dispute, dispute_life_cycle_stage: 'CHARGEBACK' };
  const staged = await answer(await app(postRaw(intentPath, { action: 'send_message', text: 'Another message.' })));
  assert.equal(staged.status, 409, JSON.stringify(staged.body));
  assert.equal(staged.body.error, 'ACTION_STAGE');
  state.dispute = { ...state.dispute, dispute_life_cycle_stage: 'INQUIRY' };
  // The actions whose flows are not built yet are still refused.
  for (const body of [
    { action: 'escalate', note: 'Delivered.' },
    { action: 'accept_claim', acceptType: 'REFUND' },
  ]) {
    const r = await answer(await app(postRaw(intentPath, body)));
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, 'VARIANT_NOT_AVAILABLE');
  }
  assert.equal(pp.posts.length, 1);
});

test('callPayPal: a message with a file goes multipart, as recorded (W-3): input (JSON message) + message_document', async () => {
  const recorded = JSON.parse(readFileSync(new URL('../../../packages/paypal/contracts/send_message-file.json', import.meta.url), 'utf8')) as {
    request: { parts: Array<{ name: string; type: string; body?: { message: string } }> };
  };
  const forms: FormData[] = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    if (new URL(String(url)).pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
    if (init.body instanceof FormData) forms.push(init.body);
    return new Response(JSON.stringify({ links: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  const client = new PayPalClient({ clientId: 'cid', clientSecret: 'secret', env: 'sandbox', fetch, sleep: async () => {} });
  const message = recorded.request.parts.find((p) => p.name === 'input')!.body!.message;
  const blank = { caseId: CASE, disputeId: REAL, documentsHash: '', analysisKey: '', evidenceType: 'OTHER' as const, carrier: '', tracking: '', notes: '', sentences: [], resolutionNotes: [] };
  const file = { name: 'tracking.png', type: 'image/png' as const, data: new Uint8Array([137, 80, 78, 71]) };
  // The production registry: send_message:file is the multipart variant.
  await callPayPal(client, REAL, { ...blank, files: [{ name: 'tracking.png', size: '1 KB' }], action: 'send_message', payload: { kind: 'send_message', text: message } }, [file], 'rk-int-9');
  assert.equal(forms.length, 1);
  assert.deepEqual([...forms[0]!.keys()], recorded.request.parts.map((p) => p.name));
  const input = forms[0]!.get('input') as Blob;
  assert.equal(input.type, 'application/json');
  assert.deepEqual(JSON.parse(await input.text()), recorded.request.parts[0]!.body);
  assert.equal((forms[0]!.get('message_document') as File).name, 'tracking.png');
});

// ------------------------------------------------------------------------------------------------ review fixes (Task 7)

test('a repeated message needs REPEATS_MESSAGE: unconfirmed → 409 CONFIRMATION_REQUIRED, confirmed → 202', async () => {
  const { app, pp, state, intents } = await setupActions();
  const first = await compose(app);
  await approve(app, first);
  assert.equal((await send(app, first)).status, 202);
  state.dispute = withMessage(state.dispute, 'SELLER', state.t + 1_000, TEXT);
  state.t += 2_000;
  assert.equal(((await readBack(app, first)).body.readBack as { state: string }).state, 'recorded');
  assert.equal(intents.isUncertain(REAL), null);
  // The same text again, on purpose: a repeat.
  const again = await compose(app);
  assert.equal(again.repeat, true);
  const a = await approve(app, again);
  const terms = a.body.confirmation as { consequence: string };
  assert.equal(terms.consequence, 'REPEATS_MESSAGE');
  const unconfirmed = await send(app, again);
  assert.equal(unconfirmed.status, 409, JSON.stringify(unconfirmed.body));
  assert.equal(unconfirmed.body.error, 'CONFIRMATION_REQUIRED');
  assert.equal((unconfirmed.body.terms as { consequence: string }).consequence, 'REPEATS_MESSAGE');
  assert.equal(pp.posts.length, 1);
  assert.equal((await confirm(app, again, terms)).status, 200);
  const s = await send(app, again);
  assert.equal(s.status, 202, JSON.stringify(s.body));
  assert.equal(pp.posts.length, 2);
});

test('DUPLICATE_ACTION stays for the other actions: the same accept PayPal already recorded is refused', async () => {
  const { app, pp, state, intents } = await setupActions();
  const sendAccept = async () => {
    const i = await compose(app, { action: 'accept_claim', acceptType: 'REFUND' });
    const a = await approve(app, i);
    assert.equal((await confirm(app, i, a.body.confirmation)).status, 200);
    return { i, s: await send(app, i) };
  };
  const one = await sendAccept();
  assert.equal(one.s.status, 202, JSON.stringify(one.s.body));
  // A read-back proved it recorded. Set through the store: the snapshot does not map the accept proof's
  // `action_info.response_option` yet (Task 9), so no route read-back can prove an accept today.
  state.t += 2_000;
  assert.equal(intents.recordReadBack(one.i.id, { state: 'recorded', detail: 'Recorded by PayPal' }), true);
  assert.equal(intents.isUncertain(REAL), null);
  const two = await sendAccept();
  assert.equal(two.s.status, 409, JSON.stringify(two.s.body));
  assert.equal(two.s.body.error, 'DUPLICATE_ACTION');
  assert.equal(pp.posts.length, 1);
});

test('a 429 is ambiguous even with an issue code: the dispute is held, not freed', async () => {
  assert.equal(isAmbiguous(new PayPalError(429, { name: 'RATE_LIMIT_REACHED', details: [{ issue: 'X' }] }, null)), true);
  assert.equal(isAmbiguous(new PayPalError(408, { name: 'REQUEST_TIMEOUT', details: [{ issue: 'X' }] }, null)), true);
  const { app, intents } = await setupActions({ actionReply: () => ({ status: 429, body: { name: 'RATE_LIMIT_REACHED', details: [{ issue: 'X' }] } }) });
  const i = await compose(app);
  await approve(app, i);
  const s = await send(app, i);
  assert.equal(s.status, 202, JSON.stringify(s.body));
  assert.equal(s.body.sent, 'unknown');
  assert.equal(intents.isUncertain(REAL)?.intentId, i.id);
});

test('restart: before send_started no POST was made (failed, retryable, not held); after it, held', async () => {
  for (const started of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), 'rk-actions-'));
    try {
      const files = { file: join(dir, 'intents.json'), eventsFile: join(dir, 'audit-events.jsonl') };
      const intents = new IntentStore({ ...files, now: () => new Date(T0) });
      const { app } = await setupActions({ intents });
      const i = await compose(app);
      await approve(app, i);
      const owner = intents.peek(i.id)!.createdBy;
      // The send claims the intent (sending, on disk)…
      assert.equal(intents.beginSend(i.id, CASE, owner).ok, true);
      // …and the process dies before the read-back base (or right after send_started).
      if (started) intents.recordChecked({ caseId: CASE, kind: 'send_started', actor: owner, disputeId: REAL, intentId: i.id, contentHash: i.contentHash, requestId: i.requestId, stage: 'INQUIRY' });
      const after = new IntentStore({ ...files, now: () => new Date(T0 + 1_000) });
      assert.equal(after.peek(i.id)!.status, 'failed');
      if (started) {
        assert.equal(after.isUncertain(REAL)?.intentId, i.id);
      } else {
        assert.equal(after.isUncertain(REAL), null);
        assert.equal(after.beginSend(i.id, CASE, owner).ok, true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a read-back base that cannot be written alone: 503, no POST, no send_started', async () => {
  class NoBase extends IntentStore {
    override setReadBackBase(): boolean {
      return false;
    }
  }
  const intents = new NoBase({ now: () => new Date(T0) });
  const { app, pp } = await setupActions({ intents });
  const i = await compose(app);
  await approve(app, i);
  const s = await send(app, i);
  assert.equal(s.status, 503, JSON.stringify(s.body));
  assert.equal(s.body.error, 'AUDIT_UNAVAILABLE');
  assert.equal(pp.posts.length, 0);
  assert.equal(intents.events(CASE).filter((e) => e.kind === 'send_started').length, 0);
  assert.equal(intents.isUncertain(REAL), null);
  assert.equal(intents.peek(i.id)!.status, 'approved');
});

// ------------------------------------------------------------------------------------------------ review fixes, round 2

/** An approved message intent claimed for sending on a store with files, then "the process dies". */
async function interrupted(dir: string, before?: (intents: IntentStore, i: { id: string; contentHash: string; requestId: string }, owner: string) => void) {
  const files = { file: join(dir, 'intents.json'), eventsFile: join(dir, 'audit-events.jsonl') };
  const intents = new IntentStore({ ...files, now: () => new Date(T0) });
  const { app } = await setupActions({ intents });
  const i = await compose(app);
  await approve(app, i);
  const owner = intents.peek(i.id)!.createdBy;
  before?.(intents, i, owner);
  assert.equal(intents.beginSend(i.id, CASE, owner).ok, true);
  return { files, i, owner, intents };
}
const startedLine = (intents: IntentStore, i: { id: string; contentHash: string; requestId: string }, owner: string) =>
  intents.recordChecked({ caseId: CASE, kind: 'send_started', actor: owner, disputeId: REAL, intentId: i.id, contentHash: i.contentHash, requestId: i.requestId, stage: 'INQUIRY' });

test('restart: an unreadable send log keeps an interrupted action held and is reported; a missing one frees it', async () => {
  for (const kind of ['unreadable', 'missing'] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'rk-actions-'));
    try {
      const { files, i } = await interrupted(dir);
      const sends = join(dir, 'audit-events-sends.jsonl');
      if (kind === 'unreadable') {
        // The log exists (another dispute's send) but cannot be read at start.
        writeFileSync(sends, JSON.stringify({ at: new Date(T0).toISOString(), caseId: CASE, kind: 'sent', actor: 'x', disputeId: 'PP-R-OTHER' }) + '\n');
        durableTestHooks.readError = { match: /sends\.jsonl$/, code: 'EIO' };
      } else rmSync(sends, { force: true });
      const after = new IntentStore({ ...files, now: () => new Date(T0 + 1_000) });
      durableTestHooks.readError = null;
      assert.equal(after.peek(i.id)!.status, 'failed');
      if (kind === 'unreadable') {
        assert.equal(after.isUncertain(REAL)?.intentId, i.id);
        assert.match(after.storageProblem() ?? '', /audit-events-sends\.jsonl could not be read \(EIO\)/);
      } else {
        assert.equal(after.isUncertain(REAL), null);
        assert.equal(after.storageProblem(), null);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('restart: an earlier attempt read back absent, then a crash before the new send_started → not held; after it → held', async () => {
  for (const started of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), 'rk-actions-'));
    try {
      const { files, i, owner, intents } = await interrupted(dir, (s, x, who) => {
        // The earlier attempt: started, then proven absent by a read-back.
        assert.equal(s.beginSend(x.id, CASE, who).ok, true);
        startedLine(s, x, who);
        s.failed(x.id, who, 'PayPal timed out', 'ambiguous');
        assert.equal(s.recordReadBack(x.id, { state: 'absent', detail: 'no trace' }), true);
      });
      if (started) startedLine(intents, i, owner);
      const after = new IntentStore({ ...files, now: () => new Date(T0 + 1_000) });
      assert.equal(after.peek(i.id)!.status, 'failed');
      assert.equal(after.isUncertain(REAL)?.intentId ?? null, started ? i.id : null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('acknowledge: repeated shown keys count once', async () => {
  const { app, state } = await setupActions();
  const i = await compose(app);
  await approve(app, i);
  const at = state.t + 1_000;
  state.dispute = withMessage(state.dispute, 'BUYER', at, 'Where is it??');
  state.t += 2_000;
  const s = await send(app, i);
  const shown = s.body.messageKeys as string[];
  // A second message with the same key (same time, same length) arrives: it was never shown.
  state.dispute = withMessage(state.dispute, 'BUYER', at, 'Any news?????');
  const r = await acknowledge(app, i, [shown[0]!, shown[0]!]);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error, 'NEEDS_REVIEW');
});

// ------------------------------------------------------------------------------------------------ review fixes (Task 8)

test('a recorded seller message keeps the analysis pinned: same input, same key, no new analysis', async () => {
  const { app, state, intents } = await setupActions();
  const analysis = async () => answer(await app(postRaw(`/api/cases/${CASE}/analysis`, {})));
  const before = await analysis();
  assert.equal(before.status, 200, JSON.stringify(before.body).slice(0, 200));
  const i = await compose(app);
  await approve(app, i);
  state.t += 1_000;
  assert.equal((await send(app, i)).status, 202);
  // PayPal shows the seller's message and its links move on (W-1: make_offer gone, waiting for the buyer).
  state.dispute = {
    ...withMessage(state.dispute, 'SELLER', state.t + 2_000, TEXT),
    status: 'WAITING_FOR_BUYER_RESPONSE',
    links: (state.dispute.links ?? []).filter((l) => l.rel !== 'make_offer'),
  };
  state.t += 5_000;
  assert.equal(((await readBack(app, i)).body.readBack as { state: string }).state, 'recorded');
  assert.ok(intents.hasRecordedAction(REAL));
  // A later load, after the read cache expired: the pinned input of the same documents, the same stored analysis
  // (200 from the store; a new analysis would be a 202 live run).
  state.t += 120_000;
  const after = await analysis();
  assert.equal(after.status, 200, JSON.stringify(after.body).slice(0, 200));
  assert.equal(after.body.key, before.body.key);
  assert.deepEqual(after.body.input, before.body.input);
});
