/**
 * Task 10: escalate through the real registry and rules, on fakes built from the owner-approved sandbox write W-5
 * (escalate on the not-received inquiry B: PayPal records an ESCALATE entry by the seller with the note; the stage moves
 * to CHARGEBACK minutes later). packages/paypal/contracts/escalate.json and reads/W-5-*.json. Nothing is sent anywhere.
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
  request: { body: { note: string }; contentType: string; route: string };
  sentStartedAt: string;
  before: Dispute;
  after: Array<{ at: string; dispute: Dispute }>;
}
const load = (f: string): Recorded => JSON.parse(readFileSync(new URL(`../../../packages/paypal/contracts/${f}`, import.meta.url), 'utf8')) as Recorded;
const W5 = load('escalate.json');
const NOTE = W5.request.body.note;

/** A recorded read re-bound to the standard case's payment (dispute id, capture, the test seller) so the binding verifies. */
function rebound(d: Dispute): Dispute {
  const c = structuredClone(d);
  return { ...c, dispute_id: REAL, disputed_transactions: [{ ...c.disputed_transactions![0]!, seller_transaction_id: STD_CAPTURE, seller: { merchant_id: SELLER_ID } }] };
}
const after = (at: string) => rebound(W5.after.find((a) => a.at === at)!.dispute);
/** The read without the attributable ESCALATE entry: a bare stage change (the buyer or PayPal can escalate too). */
const withoutEscalate = (d: Dispute): Dispute => ({ ...d, evidences: (d.evidences ?? []).filter((e) => e.action_info?.action !== 'ESCALATE') });

test('escalate: owner, terms bound (no amount, MOVES_TO_CLAIM), the recorded body; a stage change alone is pending, the ESCALATE entry records', async () => {
  const { app, pp, state, intents } = await setupActions({ registry: false });
  state.dispute = rebound(W5.before);
  state.t = Date.parse(W5.sentStartedAt) - 60_000;
  // A note is required (PayPal: 1–2,000 characters; recorded with one); no amount is taken.
  for (const note of [undefined, '   ']) {
    const r = await answer(await app(postRaw(intentPath, { action: 'escalate', ...(note === undefined ? {} : { note }) })));
    assert.deepEqual([r.status, r.body.error], note === undefined ? [400, 'INVALID_ACTION_REQUEST'] : [422, 'TEXT_REQUIRED']);
  }
  const long = await answer(await app(postRaw(intentPath, { action: 'escalate', note: 'x'.repeat(2001) })));
  assert.deepEqual([long.status, long.body.error], [422, 'TEXT_TOO_LONG']);
  const withAmount = await answer(await app(postRaw(intentPath, { action: 'escalate', note: NOTE, amount: { value: '7.00', currency: 'USD' } })));
  assert.equal(withAmount.status, 400);
  const i = await compose(app, { action: 'escalate', note: `  ${NOTE}  ` });
  assert.equal((i.payload as { note: string }).note, NOTE);
  const terms = (await approve(app, i)).body.confirmation as Record<string, unknown>;
  assert.deepEqual(terms, { intentId: i.id, contentHash: i.contentHash, action: 'escalate', amount: null, currency: null, consequence: 'MOVES_TO_CLAIM' });
  for (const wrong of [{ ...terms, consequence: 'REFUNDS_BUYER' }, { ...terms, amount: '7.00', currency: 'USD' }]) {
    const c = await confirm(app, i, wrong);
    assert.deepEqual([c.status, c.body.error], [409, 'CONFIRMATION_MISMATCH']);
  }
  const early = await send(app, i);
  assert.deepEqual([early.status, early.body.error], [409, 'CONFIRMATION_REQUIRED']);
  assert.equal((await confirm(app, i, terms)).status, 200);
  state.t = Date.parse(W5.sentStartedAt);
  const s = await send(app, i);
  assert.equal(s.status, 202, JSON.stringify(s.body));
  // One POST, byte for byte the recorded W-5 request (JSON { note }).
  assert.equal(pp.posts.length, 1);
  assert.equal(pp.posts[0]!.path, W5.request.route.replace('PP-R-NDZ-10193597', REAL));
  assert.equal(W5.request.contentType, 'application/json');
  assert.equal(pp.posts[0]!.body, JSON.stringify(W5.request.body));
  assert.equal(pp.posts[0]!.requestId, i.requestId);
  // The claim stage without the attributable entry: pending, the dispute stays held.
  state.dispute = withoutEscalate(after('10m'));
  state.t += 600_000;
  const bare = await readBack(app, i);
  assert.equal((bare.body.readBack as { state: string }).state, 'pending', JSON.stringify(bare.body));
  assert.equal(intents.isUncertain(REAL)?.intentId, i.id);
  // The recorded +0 s read: the ESCALATE entry by the seller with the note, timed after send_started.
  state.dispute = after('0s');
  const rb = await readBack(app, i);
  assert.equal((rb.body.readBack as { state: string }).state, 'recorded', JSON.stringify(rb.body));
  assert.equal(intents.isUncertain(REAL), null);
});

test('escalate only where it was recorded: the not-received reason, the inquiry stage, a link PayPal gives now', async () => {
  const { app, pp, state } = await setupActions({ registry: false });
  state.t = Date.parse(W5.sentStartedAt) - 60_000;
  const post = async () => answer(await app(postRaw(intentPath, { action: 'escalate', note: NOTE })));
  // Another reason: never escalated in the sandbox.
  state.dispute = { ...rebound(W5.before), reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' };
  const reason = await post();
  assert.deepEqual([reason.status, reason.body.error, reason.body.detail], [409, 'VARIANT_NOT_AVAILABLE', 'Not available: not verified with PayPal for this dispute reason']);
  // The claim stage, even if a link were there.
  const claim = after('10m');
  state.dispute = { ...claim, links: [...(claim.links ?? []), { rel: 'escalate', method: 'POST', href: '' }] };
  const staged = await post();
  assert.deepEqual([staged.status, staged.body.error], [409, 'ACTION_STAGE']);
  // After the escalation PayPal gives no escalate link: the fresh read decides.
  for (const at of ['0s', '30s', '2m', '10m']) {
    state.dispute = after(at);
    const r = await post();
    assert.deepEqual([r.status, r.body.error], [409, 'ACTION_NOT_OFFERED'], at);
  }
  assert.equal(pp.posts.length, 0);
});

test('a new buyer message does not hold escalate (shown, not blocking): send 202', async () => {
  const { app, pp, state } = await setupActions({ registry: false });
  state.dispute = rebound(W5.before);
  state.t = Date.parse(W5.sentStartedAt) - 60_000;
  const i = await compose(app, { action: 'escalate', note: NOTE });
  const terms = (await approve(app, i)).body.confirmation;
  assert.equal((await confirm(app, i, terms)).status, 200);
  state.dispute = withMessage(state.dispute, 'BUYER', state.t + 1_000, 'Still nothing arrived.');
  state.t += 5_000;
  const s = await send(app, i);
  assert.equal(s.status, 202, JSON.stringify(s.body));
  assert.equal(pp.posts.length, 1);
});

test('after escalate there is no closure lock: under review with flickering links, then the claim, each read decides', async () => {
  const { app, pp, state } = await setupActions({ registry: false });
  state.t = Date.parse(W5.sentStartedAt) + 30_000;
  // +30 s: UNDER_REVIEW in the inquiry, provide_evidence offered for a moment; nothing else.
  state.dispute = after('30s');
  const msg = await answer(await app(postRaw(intentPath, { action: 'send_message', text: 'Any news?' })));
  assert.deepEqual([msg.status, msg.body.error], [409, 'ACTION_NOT_OFFERED']);
  // +10 min: the claim waits for the seller; accept is offered by PayPal, but no accept was recorded in this stage.
  state.dispute = after('10m');
  state.t = Date.parse(W5.sentStartedAt) + 600_000;
  const accept = await answer(await app(postRaw(intentPath, { action: 'accept_claim', acceptType: 'REFUND', note: 'Refund.' })));
  assert.deepEqual([accept.status, accept.body.error], [409, 'ACTION_STAGE']);
  assert.equal(pp.posts.length, 0);
});

test('the escalate proof on the recorded reads, read for read (mapping + matcher, production registry)', () => {
  const at = (a: string, d?: Dispute) => toSnapshot(d ?? W5.after.find((x) => x.at === a)!.dispute, CASE, 'sandbox', new Date());
  const before = toSnapshot(W5.before, CASE, 'sandbox', new Date());
  const c = composeAction({ caseId: CASE, req: { action: 'escalate', note: NOTE, attachments: [] }, snap: before, disputeId: W5.before.dispute_id!, seller: SELLER_ID, files: [] });
  assert.ok(!('error' in c), JSON.stringify(c));
  const intent = { ...(c as object), id: 'int-1', contentHash: 'c'.repeat(64), requestId: 'rk-1', status: 'sent' } as SubmissionIntent;
  const contract = CONTRACTS.escalate;
  assert.equal(contract.status, 'tested_locally');
  const base = readBackBase(before, contract.proof!, W5.sentStartedAt);
  for (const a of ['0s', '30s', '2m', '10m']) assert.equal(proveSend(intent, base, at(a), contract, Date.parse(W5.sentStartedAt) + 1_000).state, 'recorded', a);
  // The entry is the seller's, ESCALATE, in the inquiry stage (mapped from dispute_life_cycle_stage).
  assert.deepEqual(at('0s').evidences.filter((e) => e.action === 'ESCALATE').map((e) => [e.source, e.stage, e.notes]), [['SUBMITTED_BY_SELLER', 'INQUIRY', NOTE]]);
  // The claim stage alone, after the absence delay, with no escalate link: pending (another actor can escalate).
  const claimOnly = at('10m', withoutEscalate(W5.after.find((x) => x.at === '10m')!.dispute));
  assert.equal(claimOnly.stage, 'CHARGEBACK');
  assert.equal(proveSend(intent, base, claimOnly, contract, Date.parse(W5.sentStartedAt) + 600_000).state, 'pending');
  // An ESCALATE entry with another note is not this send.
  const other = structuredClone(W5.after.find((x) => x.at === '0s')!.dispute);
  for (const e of other.evidences ?? []) if (e.action_info?.action === 'ESCALATE') e.notes = 'Another escalation.';
  assert.equal(proveSend(intent, base, at('0s', other), contract, Date.parse(W5.sentStartedAt) + 1_000).state, 'pending');
  assert.equal(confirmationTerms(intent, false)!.consequence, 'MOVES_TO_CLAIM');
  // Never sent without its note (refused before send_started).
  assert.equal(sendProblem({ ...intent, payload: { kind: 'escalate', note: '' } }, []), 'An escalation is sent only with its note');
  assert.equal(sendProblem(intent, []), null);
  assert.equal(consequenceText(intent), 'The inquiry becomes a claim decided by PayPal. Inquiry actions end; what you can do next is what PayPal offers on the claim.');
});
