/**
 * Task 11: make_offer through the real registry and rules, on fakes built from the owner-approved sandbox write W-4
 * (a REFUND offer of 2.00 of 7.00 USD on the not-received inquiry E: PayPal records the seller's PROPOSED offer and waits
 * for the buyer; no money moves, nothing closes). packages/paypal/contracts/make_offer-refund.json and reads/W-4-*.json.
 * Nothing is sent anywhere, and no real dispute is touched (every read is re-bound to the test case's payment).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Dispute } from '@resolvekit/paypal';
import { CONTRACTS } from '../../web/src/domain/actionContracts.ts';
import { proveSend, readBackBase } from '../../web/src/domain/actionReadback.ts';
import { composeAction, confirmationTerms, consequenceText } from '../../web/src/domain/actions.ts';
import type { SubmissionIntent } from '../../web/src/domain/intent.ts';
import { sendProblem } from '../src/actions/calls.ts';
import { toSnapshot } from '../src/mapping.ts';
import { CASE, REAL, answer, approve, compose, confirm, intentPath, postRaw, readBack, send, setupActions, withMessage } from './actions-kit.ts';
import { SELLER_ID, STD_CAPTURE } from './kit.ts';

interface Recorded {
  request: { body: { note: string; offer_amount: { currency_code: string; value: string }; offer_type: string }; contentType: string; route: string };
  sentStartedAt: string;
  before: Dispute;
  after: Array<{ at: string; dispute: Dispute }>;
}
const W4 = JSON.parse(readFileSync(new URL('../../../packages/paypal/contracts/make_offer-refund.json', import.meta.url), 'utf8')) as Recorded;
const NOTE = W4.request.body.note;
const OFFER = { action: 'make_offer', offerType: 'REFUND', note: NOTE, amount: { value: '2', currency: 'USD' } };

/** A recorded read re-bound to the standard case's payment (dispute id, capture, the test seller) so the binding verifies. */
function rebound(d: Dispute): Dispute {
  const c = structuredClone(d);
  return { ...c, dispute_id: REAL, disputed_transactions: [{ ...c.disputed_transactions![0]!, seller_transaction_id: STD_CAPTURE, seller: { merchant_id: SELLER_ID } }] };
}
const after = (at: string) => rebound(W4.after.find((a) => a.at === at)!.dispute);
/** The read without the seller's offer: what a bare state change looks like. */
const withoutOffer = (d: Dispute): Dispute => ({ ...d, offer: { buyer_requested_amount: d.offer!.buyer_requested_amount! } });
/** W-4's starting read with a seller offer pending, and make_offer still linked (never recorded; the guard's case). */
const pendingOffer = (): Dispute => {
  const d = rebound(W4.before);
  return { ...d, offer: structuredClone(W4.after.find((a) => a.at === '30s')!.dispute.offer!) };
};

test('server: owner offer, terms bound (2.00 USD, OFFERS_SETTLEMENT), body from the recorded request, proof by offer history', async () => {
  const { app, pp, state, intents } = await setupActions({ registry: false });
  state.dispute = rebound(W4.before);
  state.t = Date.parse(W4.sentStartedAt) - 60_000;
  const post = async (body: Record<string, unknown>) => answer(await app(postRaw(intentPath, body)));
  // An amount is required, below the dispute amount (a full-amount offer was not recorded), at most 2 decimals.
  assert.deepEqual([(await post({ ...OFFER, amount: null })).body.error], ['AMOUNT_REQUIRED']);
  for (const value of ['7', '7.00']) {
    const full = await post({ ...OFFER, amount: { value, currency: 'USD' } });
    assert.deepEqual([full.status, full.body.error], [409, 'VARIANT_NOT_AVAILABLE'], value);
    assert.match(String(full.body.detail), /full dispute amount was not verified with PayPal/);
  }
  assert.deepEqual([(await post({ ...OFFER, amount: { value: '2.001', currency: 'USD' } })).body.error], ['INVALID_AMOUNT']);
  assert.deepEqual([(await post({ ...OFFER, note: '  ' })).body.error], ['TEXT_REQUIRED']);
  const i = await compose(app, { ...OFFER, note: `  ${NOTE}  ` });
  assert.deepEqual(i.payload, { kind: 'make_offer', offerType: 'REFUND', note: NOTE, amount: { value: '2.00', currency: 'USD' } });
  const terms = (await approve(app, i)).body.confirmation as Record<string, unknown>;
  assert.deepEqual(terms, { intentId: i.id, contentHash: i.contentHash, action: 'make_offer', amount: '2.00', currency: 'USD', consequence: 'OFFERS_SETTLEMENT' });
  for (const wrong of [{ ...terms, consequence: 'REFUNDS_BUYER' }, { ...terms, consequence: 'OFFERS_PARTIAL_REFUND' }, { ...terms, amount: '7.00' }, { ...terms, currency: 'EUR' }]) {
    const c = await confirm(app, i, wrong);
    assert.deepEqual([c.status, c.body.error], [409, 'CONFIRMATION_MISMATCH']);
  }
  const early = await send(app, i);
  assert.deepEqual([early.status, early.body.error], [409, 'CONFIRMATION_REQUIRED']);
  assert.equal((await confirm(app, i, terms)).status, 200);
  state.t = Date.parse(W4.sentStartedAt);
  const s = await send(app, i);
  assert.equal(s.status, 202, JSON.stringify(s.body));
  // One POST, byte for byte the recorded W-4 request (JSON: note, offer_amount, offer_type).
  assert.equal(pp.posts.length, 1);
  assert.equal(pp.posts[0]!.path, W4.request.route.replace('PP-R-OZY-10193601', REAL));
  assert.equal(W4.request.contentType, 'application/json');
  assert.equal(pp.posts[0]!.body, JSON.stringify(W4.request.body));
  assert.equal(pp.posts[0]!.requestId, i.requestId);
  // Waiting for the buyer, but without the seller's offer entry: pending, the dispute stays held.
  state.dispute = withoutOffer(after('2m'));
  state.t += 120_000;
  const bare = await readBack(app, i);
  assert.equal((bare.body.readBack as { state: string }).state, 'pending', JSON.stringify(bare.body));
  assert.equal(intents.isUncertain(REAL)?.intentId, i.id);
  // The recorded +0 s read: the SELLER PROPOSED offer (REFUND, 2.00 USD) timed after send_started.
  state.dispute = after('0s');
  const rb = await readBack(app, i);
  assert.equal((rb.body.readBack as { state: string }).state, 'recorded', JSON.stringify(rb.body));
  assert.equal(intents.isUncertain(REAL), null);
  // No money moved: no refund in the read.
  assert.deepEqual((rb.body.snapshot as { refunds?: unknown[] }).refunds ?? [], []);
});

test('an offer while one is pending is refused DUPLICATE_ACTION, at compose and at send (no POST); after an offer PayPal stops offering it', async () => {
  const { app, pp, state } = await setupActions({ registry: false });
  state.t = Date.parse(W4.sentStartedAt) - 60_000;
  state.dispute = pendingOffer();
  const dup = await answer(await app(postRaw(intentPath, OFFER)));
  assert.deepEqual([dup.status, dup.body.error, dup.body.detail], [409, 'DUPLICATE_ACTION', 'An offer of yours is pending with the buyer']);
  // Composed before the offer, sent after PayPal shows one pending: refused, nothing sent.
  state.dispute = rebound(W4.before);
  const i = await compose(app, OFFER);
  const terms = (await approve(app, i)).body.confirmation;
  assert.equal((await confirm(app, i, terms)).status, 200);
  state.dispute = pendingOffer();
  const s = await send(app, i);
  assert.deepEqual([s.status, s.body.error], [409, 'DUPLICATE_ACTION'], JSON.stringify(s.body));
  // The recorded reads after the offer: make_offer is not offered (the fresh read decides).
  for (const at of ['0s', '30s', '2m', '10m']) {
    state.dispute = after(at);
    const r = await answer(await app(postRaw(intentPath, { ...OFFER, amount: { value: '1.00', currency: 'USD' } })));
    assert.deepEqual([r.status, r.body.error], [409, 'ACTION_NOT_OFFERED'], at);
  }
  assert.equal(pp.posts.length, 0);
});

test('make_offer only where it was recorded: the not-received reason, the inquiry, within the refundable amount', async () => {
  const { app, pp, state } = await setupActions({ registry: false });
  state.t = Date.parse(W4.sentStartedAt) - 60_000;
  const post = async (body: Record<string, unknown> = OFFER) => answer(await app(postRaw(intentPath, body)));
  // The not-as-described sandbox dispute F (reads/W-12-pre.json): no offer was recorded for that reason.
  const f = JSON.parse(readFileSync(new URL('../../../packages/paypal/contracts/reads/W-12-pre.json', import.meta.url), 'utf8')) as Dispute;
  state.dispute = rebound(f);
  const reason = await post();
  assert.deepEqual([reason.status, reason.body.error, reason.body.detail], [409, 'VARIANT_NOT_AVAILABLE', 'Not available: not verified with PayPal for this dispute reason']);
  // Another stage, even if the link were there.
  state.dispute = { ...rebound(W4.before), dispute_life_cycle_stage: 'CHARGEBACK' };
  assert.deepEqual([(await post()).body.error], ['ACTION_STAGE']);
  // PayPal would refund 5.00: an offer above it is refused, at it is fine; no refundable amount: not available.
  state.dispute = { ...rebound(W4.before), refund_details: { allowed_refund_amount: { currency_code: 'USD', value: '5.00' } } };
  assert.deepEqual([(await post({ ...OFFER, amount: { value: '5.01', currency: 'USD' } })).body.error], ['AMOUNT_ABOVE_REFUNDABLE']);
  assert.equal((await post({ ...OFFER, amount: { value: '5.00', currency: 'USD' } })).status, 201);
  state.dispute = { ...rebound(W4.before), refund_details: {} };
  assert.deepEqual([(await post()).body.error], ['VARIANT_NOT_AVAILABLE']);
  // The types PayPal never offered in the sandbox, or that need a return address, stay not available.
  state.dispute = { ...rebound(W4.before), allowed_response_options: { make_offer: { offer_types: ['REPLACEMENT_WITHOUT_REFUND', 'REFUND_WITH_RETURN'] } } };
  const repl = await post({ action: 'make_offer', offerType: 'REPLACEMENT_WITHOUT_REFUND', note: 'A new one.' });
  assert.deepEqual([repl.status, repl.body.detail], [409, 'Not available: Not verified with PayPal: never offered on a sandbox dispute']);
  const ret = await post({ ...OFFER, offerType: 'REFUND_WITH_RETURN' });
  assert.deepEqual([ret.status, ret.body.detail], [409, 'Not available: Not in this delivery (owner decision)']);
  assert.equal(pp.posts.length, 0);
});

test('a new buyer message after approval holds the offer (NEEDS_REVIEW, no POST)', async () => {
  const { app, pp, state } = await setupActions({ registry: false });
  state.dispute = rebound(W4.before);
  state.t = Date.parse(W4.sentStartedAt) - 60_000;
  const i = await compose(app, OFFER);
  const terms = (await approve(app, i)).body.confirmation;
  assert.equal((await confirm(app, i, terms)).status, 200);
  state.dispute = withMessage(state.dispute, 'BUYER', state.t + 1_000, 'I want the full amount.');
  state.t += 5_000;
  const s = await send(app, i);
  assert.deepEqual([s.status, s.body.error], [409, 'NEEDS_REVIEW'], JSON.stringify(s.body));
  assert.equal(pp.posts.length, 0);
});

test('the offer proof on the recorded reads, read for read (mapping + matcher, production registry)', () => {
  const at = (a: string, d?: Dispute) => toSnapshot(d ?? W4.after.find((x) => x.at === a)!.dispute, CASE, 'sandbox', new Date());
  const before = toSnapshot(W4.before, CASE, 'sandbox', new Date());
  const c = composeAction({ caseId: CASE, req: { action: 'make_offer', offerType: 'REFUND', note: NOTE, amount: { value: '2.00', currency: 'USD' }, attachments: [] }, snap: before, disputeId: W4.before.dispute_id!, seller: SELLER_ID, files: [] });
  assert.ok(!('error' in c), JSON.stringify(c));
  const intent = { ...(c as object), id: 'int-1', contentHash: 'c'.repeat(64), requestId: 'rk-1', status: 'sent' } as SubmissionIntent;
  const contract = CONTRACTS['make_offer:REFUND'];
  assert.equal(contract.status, 'tested_locally');
  assert.equal(contract.reason, null);
  const base = readBackBase(before, contract.proof!, W4.sentStartedAt);
  for (const a of ['0s', '30s', '2m', '10m']) assert.equal(proveSend(intent, base, at(a), contract, Date.parse(W4.sentStartedAt) + 1_000).state, 'recorded', a);
  // The mapped entry, as PayPal gave it; the read shows no refund and no outcome.
  assert.deepEqual(at('0s').offerHistory, [{ time: '2026-10-20T05:57:05.614Z', actor: 'SELLER', event: 'PROPOSED', type: 'REFUND', amount: { value: '2.00', currency: 'USD' } }]);
  for (const a of ['0s', '30s', '2m', '10m']) {
    assert.notEqual(at(a).status, 'RESOLVED', a);
    assert.equal(at(a).outcome ?? null, null, a);
    assert.deepEqual(at(a).refunds ?? [], [], a);
  }
  // Waiting for the buyer without the entry, long after: pending (never absent: PayPal no longer offers make_offer).
  const bare = at('10m', withoutOffer(W4.after.find((x) => x.at === '10m')!.dispute));
  assert.equal(proveSend(intent, base, bare, contract, Date.parse(W4.sentStartedAt) + 600_000).state, 'pending');
  // An offer of another amount is not this send.
  const other = structuredClone(W4.after.find((x) => x.at === '0s')!.dispute);
  other.offer!.history![0]!.offer_amount = { currency_code: 'USD', value: '3.00' };
  assert.equal(proveSend(intent, base, at('0s', other), contract, Date.parse(W4.sentStartedAt) + 1_000).state, 'pending');
  assert.equal(confirmationTerms(intent, false)!.consequence, 'OFFERS_SETTLEMENT');
  assert.equal(consequenceText(intent), 'The buyer is offered 2.00 USD; no money moves unless the buyer accepts.');
  // Never sent without its note or its amount (refused before send_started).
  assert.equal(sendProblem({ ...intent, payload: { kind: 'make_offer', offerType: 'REFUND', note: '', amount: { value: '2.00', currency: 'USD' } } }, []), 'An offer is sent only with its note');
  assert.equal(sendProblem({ ...intent, payload: { kind: 'make_offer', offerType: 'REFUND', note: NOTE, amount: null } }, []), 'An offer is sent only with its amount');
  assert.equal(sendProblem(intent, []), null);
});
