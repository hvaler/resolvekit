/**
 * Task 9: accept_claim through the real registry and rules, on fakes built from the owner-approved sandbox writes
 * W-10 (accept REFUND: PayPal refunds and closes) and W-9 (accept PARTIAL_REFUND: PayPal records an offer the buyer
 * must agree to). packages/paypal/contracts/accept_claim-*.json. Nothing is sent anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Dispute } from '@resolvekit/paypal';
import { CONTRACTS } from '../../web/src/domain/actionContracts.ts';
import { proveSend, readBackBase } from '../../web/src/domain/actionReadback.ts';
import { composeAction, confirmationTerms } from '../../web/src/domain/actions.ts';
import type { SubmissionIntent } from '../../web/src/domain/intent.ts';
import { toSnapshot } from '../src/mapping.ts';
import { CASE, REAL, answer, approve, compose, confirm, intentPath, postRaw, readBack, send, setupActions } from './actions-kit.ts';
import { SELLER_ID, STD_CAPTURE } from './kit.ts';

interface Recorded {
  request: { body: Record<string, unknown>; contentType: string; route: string };
  sentStartedAt: string;
  before: Dispute;
  after: Array<{ at: string; dispute: Dispute }>;
}
const load = (f: string): Recorded => JSON.parse(readFileSync(new URL(`../../../packages/paypal/contracts/${f}`, import.meta.url), 'utf8')) as Recorded;
const W10 = load('accept_claim-refund.json');
const W9 = load('accept_claim-partial_refund.json');

/** A recorded read re-bound to the standard case's payment (dispute id, capture, the test seller) so the binding verifies. */
function rebound(d: Dispute): Dispute {
  const c = structuredClone(d);
  return { ...c, dispute_id: REAL, disputed_transactions: [{ ...c.disputed_transactions![0]!, seller_transaction_id: STD_CAPTURE, seller: { merchant_id: SELLER_ID } }] };
}
const after = (r: Recorded, at: string) => rebound(r.after.find((a) => a.at === at)!.dispute);
/** The read without the attributable ACCEPT_CLAIM entry: what a bare state change looks like. */
const withoutAccept = (d: Dispute): Dispute => ({ ...d, evidences: (d.evidences ?? []).filter((e) => e.action_info?.action !== 'ACCEPT_CLAIM') });

test('accept REFUND: owner, terms bound (amount + currency + REFUNDS_BUYER), the recorded body, RESOLVED alone pending, the attributable entry records', async () => {
  const { app, pp, state, intents } = await setupActions({ registry: false });
  state.dispute = rebound(W10.before);
  state.t = Date.parse(W10.sentStartedAt) - 60_000;
  // No amount for not-received: an amount is refused before anything is created.
  const withAmount = await answer(await app(postRaw(intentPath, { action: 'accept_claim', acceptType: 'REFUND', note: 'x', amount: { value: '7.00', currency: 'USD' } })));
  assert.deepEqual([withAmount.status, withAmount.body.error], [422, 'AMOUNT_NOT_ALLOWED']);
  const i = await compose(app, { action: 'accept_claim', acceptType: 'REFUND', note: W10.request.body.note });
  const a = await approve(app, i);
  const terms = a.body.confirmation as Record<string, unknown>;
  assert.deepEqual(terms, { intentId: i.id, contentHash: i.contentHash, action: 'accept_claim', amount: '7.00', currency: 'USD', consequence: 'REFUNDS_BUYER' });
  for (const wrong of [{ ...terms, currency: 'EUR' }, { ...terms, amount: '2.00' }, { ...terms, consequence: 'OFFERS_PARTIAL_REFUND' }]) {
    const c = await confirm(app, i, wrong);
    assert.deepEqual([c.status, c.body.error], [409, 'CONFIRMATION_MISMATCH']);
  }
  const early = await send(app, i);
  assert.deepEqual([early.status, early.body.error], [409, 'CONFIRMATION_REQUIRED']);
  assert.equal((await confirm(app, i, terms)).status, 200);
  state.t = Date.parse(W10.sentStartedAt);
  const s = await send(app, i);
  assert.equal(s.status, 202, JSON.stringify(s.body));
  // One POST, byte for byte the recorded W-10 request (JSON, note then accept_claim_type, no amount).
  assert.equal(pp.posts.length, 1);
  assert.equal(pp.posts[0]!.path, W10.request.route.replace('PP-R-PAU-10193600', REAL));
  assert.equal(W10.request.contentType, 'application/json');
  assert.equal(pp.posts[0]!.body, JSON.stringify(W10.request.body));
  assert.equal(pp.posts[0]!.requestId, i.requestId);
  // RESOLVED in the buyer's favour with the refund, but no attributable entry: pending, the dispute stays held.
  state.dispute = withoutAccept(after(W10, '2m'));
  state.t += 120_000;
  const bare = await readBack(app, i);
  assert.equal((bare.body.readBack as { state: string }).state, 'pending', JSON.stringify(bare.body));
  assert.equal(intents.isUncertain(REAL)?.intentId, i.id);
  // The recorded +0 s read: the ACCEPT_CLAIM entry (response_option REFUND, the note) timed after send_started.
  state.dispute = after(W10, '0s');
  const rb = await readBack(app, i);
  assert.equal((rb.body.readBack as { state: string }).state, 'recorded', JSON.stringify(rb.body));
  assert.equal(intents.isUncertain(REAL), null);
  const snap = rb.body.snapshot as { refunds: unknown[] };
  assert.deepEqual(snap.refunds, [{ id: '91V163783G183442G', amount: { value: '7.00', currency: 'USD' }, time: '2026-10-20T10:23:31.000Z' }]);
});

test('accept is bound to the refundable amount, the recorded reason and a note (review fixes)', async () => {
  const { app, pp, state } = await setupActions({ registry: false });
  state.t = Date.parse(W10.sentStartedAt) - 60_000;
  const post = async (body: Record<string, unknown>) => answer(await app(postRaw(intentPath, body)));
  // PayPal would refund 5.00 of the 7.00 disputed: a full accept is not what W-10 recorded.
  const five = { currency_code: 'USD', value: '5.00' };
  state.dispute = { ...rebound(W10.before), refund_details: { allowed_refund_amount: five } };
  const full = await post({ action: 'accept_claim', acceptType: 'REFUND', note: 'Refund accepted.' });
  assert.deepEqual([full.status, full.body.error, full.body.detail], [409, 'VARIANT_NOT_AVAILABLE', "Not available: PayPal's refundable amount differs from the dispute amount"]);
  const atFive = await post({ action: 'accept_claim', acceptType: 'PARTIAL_REFUND', note: 'Partial.', amount: { value: '5.00', currency: 'USD' } });
  assert.deepEqual([atFive.status, atFive.body.error], [422, 'AMOUNT_ABOVE_REFUNDABLE']);
  assert.equal((await post({ action: 'accept_claim', acceptType: 'PARTIAL_REFUND', note: 'Partial.', amount: { value: '4.99', currency: 'USD' } })).status, 201);
  // No refundable amount at all: refused.
  state.dispute = { ...rebound(W10.before), refund_details: {} };
  assert.equal((await post({ action: 'accept_claim', acceptType: 'REFUND', note: 'Refund accepted.' })).body.error, 'VARIANT_NOT_AVAILABLE');
  // The not-as-described sandbox dispute F (reads/W-12-pre.json): no accept was recorded for that reason.
  const f = JSON.parse(readFileSync(new URL('../../../packages/paypal/contracts/reads/W-12-pre.json', import.meta.url), 'utf8')) as Dispute;
  state.dispute = rebound(f);
  for (const body of [
    { action: 'accept_claim', acceptType: 'REFUND', note: 'Refund accepted.' },
    { action: 'accept_claim', acceptType: 'PARTIAL_REFUND', note: 'Partial.', amount: { value: '2.00', currency: 'USD' } },
  ]) {
    const r = await post(body);
    assert.deepEqual([r.status, r.body.error, r.body.detail], [409, 'VARIANT_NOT_AVAILABLE', 'Not available: not verified with PayPal for this dispute reason']);
  }
  // A note is required (never recorded without one), and is trimmed into the approved content.
  state.dispute = rebound(W10.before);
  for (const note of [undefined, '   ']) {
    const r = await post({ action: 'accept_claim', acceptType: 'REFUND', ...(note === undefined ? {} : { note }) });
    assert.deepEqual([r.status, r.body.error], [422, 'TEXT_REQUIRED']);
  }
  const trimmed = await post({ action: 'accept_claim', acceptType: 'REFUND', note: `  ${W10.request.body.note as string}  ` });
  assert.equal((trimmed.body.payload as { note: string }).note, W10.request.body.note);
  assert.equal(pp.posts.length, 0);
});

test('a refundable amount that changes after approval refuses the send on composing again (no POST)', async () => {
  const { app, pp, state } = await setupActions({ registry: false });
  state.dispute = rebound(W10.before);
  state.t = Date.parse(W10.sentStartedAt) - 60_000;
  const i = await compose(app, { action: 'accept_claim', acceptType: 'REFUND', note: 'Refund accepted.' });
  const terms = (await approve(app, i)).body.confirmation;
  assert.equal((await confirm(app, i, terms)).status, 200);
  state.dispute = { ...rebound(W10.before), refund_details: { allowed_refund_amount: { currency_code: 'USD', value: '5.00' } } };
  const s = await send(app, i);
  assert.deepEqual([s.status, s.body.error], [409, 'VARIANT_NOT_AVAILABLE'], JSON.stringify(s.body));
  assert.equal(pp.posts.length, 0);
});

test('after accept, the next fresh read decides: no links → a message or another accept is refused ACTION_NOT_OFFERED (no local lock)', async () => {
  const { app, pp, state } = await setupActions({ registry: false });
  state.t = Date.parse(W10.sentStartedAt) + 120_000;
  state.dispute = after(W10, '2m');
  for (const body of [
    { action: 'send_message', text: 'Thanks for your patience.' },
    { action: 'accept_claim', acceptType: 'REFUND' },
  ]) {
    const r = await answer(await app(postRaw(intentPath, body)));
    assert.deepEqual([r.status, r.body.error], [409, 'ACTION_NOT_OFFERED'], JSON.stringify(r.body));
  }
  // The +30 s read offered provide_evidence again (a flicker): availability follows the read, nothing else.
  state.dispute = after(W10, '30s');
  const flicker = await answer(await app(postRaw(intentPath, { action: 'accept_claim', acceptType: 'REFUND' })));
  assert.deepEqual([flicker.status, flicker.body.error], [409, 'ACTION_NOT_OFFERED']);
  assert.equal(pp.posts.length, 0);
});

test('accept PARTIAL_REFUND: its own terms (2.00 USD, OFFERS_PARTIAL_REFUND), the recorded body, proven by the SELLER PROPOSED offer', async () => {
  const { app, pp, state, intents } = await setupActions({ registry: false });
  state.dispute = rebound(W9.before);
  state.t = Date.parse(W9.sentStartedAt) - 60_000;
  const noAmount = await answer(await app(postRaw(intentPath, { action: 'accept_claim', acceptType: 'PARTIAL_REFUND', note: 'x' })));
  assert.deepEqual([noAmount.status, noAmount.body.error], [422, 'AMOUNT_REQUIRED']);
  const full = await answer(await app(postRaw(intentPath, { action: 'accept_claim', acceptType: 'PARTIAL_REFUND', note: 'x', amount: { value: '7.00', currency: 'USD' } })));
  assert.deepEqual([full.status, full.body.error], [422, 'AMOUNT_ABOVE_DISPUTE']);
  const i = await compose(app, { action: 'accept_claim', acceptType: 'PARTIAL_REFUND', note: W9.request.body.note, amount: { value: '2', currency: 'USD' } });
  const terms = (await approve(app, i)).body.confirmation as Record<string, unknown>;
  assert.deepEqual(terms, { intentId: i.id, contentHash: i.contentHash, action: 'accept_claim', amount: '2.00', currency: 'USD', consequence: 'OFFERS_PARTIAL_REFUND' });
  const asRefund = await confirm(app, i, { ...terms, consequence: 'REFUNDS_BUYER' });
  assert.deepEqual([asRefund.status, asRefund.body.error], [409, 'CONFIRMATION_MISMATCH']);
  assert.equal((await confirm(app, i, terms)).status, 200);
  state.t = Date.parse(W9.sentStartedAt);
  assert.equal((await send(app, i)).status, 202);
  assert.equal(pp.posts.length, 1);
  assert.equal(pp.posts[0]!.body, JSON.stringify(W9.request.body));
  state.dispute = after(W9, '0s');
  state.t += 5_000;
  const rb = await readBack(app, i);
  assert.equal((rb.body.readBack as { state: string }).state, 'recorded', JSON.stringify(rb.body));
  assert.equal(intents.isUncertain(REAL), null);
  // Afterwards PayPal waits for the buyer and allows a full accept only (W-9 +30 s): a second partial is refused.
  state.dispute = after(W9, '30s');
  const again = await answer(await app(postRaw(intentPath, { action: 'accept_claim', acceptType: 'PARTIAL_REFUND', note: 'x', amount: { value: '1.00', currency: 'USD' } })));
  assert.deepEqual([again.status, again.body.error], [409, 'VARIANT_NOT_AVAILABLE']);
});

test('the proofs on the recorded reads, read for read (mapping + matcher, production registry)', () => {
  const at = (r: Recorded, a: string) => toSnapshot(r.after.find((x) => x.at === a)!.dispute, CASE, 'sandbox', new Date());
  const intentOf = (r: Recorded, req: Parameters<typeof composeAction>[0]['req']): SubmissionIntent => {
    const c = composeAction({ caseId: CASE, req, snap: toSnapshot(r.before, CASE, 'sandbox', new Date()), disputeId: r.before.dispute_id!, seller: SELLER_ID, files: [] });
    assert.ok(!('error' in c), JSON.stringify(c));
    return { ...(c as object), id: 'int-1', contentHash: 'c'.repeat(64), requestId: 'rk-1', status: 'sent' } as SubmissionIntent;
  };
  // W-10: recorded at every read after the POST (the entry stays), each by the ACCEPT_CLAIM entry.
  const full = intentOf(W10, { action: 'accept_claim', acceptType: 'REFUND', note: W10.request.body.note as string, amount: null, attachments: [] });
  const c10 = CONTRACTS['accept_claim:REFUND'];
  const b10 = readBackBase(toSnapshot(W10.before, CASE, 'sandbox', new Date()), c10.proof!, W10.sentStartedAt);
  for (const a of ['0s', '30s', '2m', '10m']) assert.equal(proveSend(full, b10, at(W10, a), c10, Date.parse(W10.sentStartedAt) + 1_000).state, 'recorded', a);
  const resolved = toSnapshot(withoutAccept(W10.after.find((x) => x.at === '2m')!.dispute), CASE, 'sandbox', new Date());
  assert.equal(resolved.status, 'RESOLVED');
  assert.deepEqual(resolved.outcome, { code: 'RESOLVED_BUYER_FAVOUR', closedAt: resolved.outcome!.closedAt, amountRefunded: { value: '7.00', currency: 'USD' } });
  assert.equal(proveSend(full, b10, resolved, c10, Date.parse(W10.sentStartedAt) + 600_000).state, 'pending');
  // The entry's stage is mapped (Task 10 needs it).
  assert.deepEqual(at(W10, '0s').evidences.filter((e) => e.action === 'ACCEPT_CLAIM').map((e) => [e.responseOption, e.stage]), [['REFUND', 'INQUIRY']]);
  // W-9: recorded by the offer entry; a full accept of the same note is not proven by it.
  const partial = intentOf(W9, { action: 'accept_claim', acceptType: 'PARTIAL_REFUND', note: W9.request.body.note as string, amount: { value: '2.00', currency: 'USD' }, attachments: [] });
  const c9 = CONTRACTS['accept_claim:PARTIAL_REFUND'];
  const b9 = readBackBase(toSnapshot(W9.before, CASE, 'sandbox', new Date()), c9.proof!, W9.sentStartedAt);
  for (const a of ['0s', '30s', '2m', '10m']) assert.equal(proveSend(partial, b9, at(W9, a), c9, Date.parse(W9.sentStartedAt) + 1_000).state, 'recorded', a);
  const asFull = { ...partial, payload: { kind: 'accept_claim' as const, acceptType: 'REFUND', note: W9.request.body.note as string, amount: null } };
  const b9full = readBackBase(toSnapshot(W9.before, CASE, 'sandbox', new Date()), c10.proof!, W9.sentStartedAt);
  assert.notEqual(proveSend(asFull, b9full, at(W9, '10m'), c10, Date.parse(W9.sentStartedAt) + 600_000).state, 'recorded');
  assert.equal(confirmationTerms(partial, false)!.consequence, 'OFFERS_PARTIAL_REFUND');
});
