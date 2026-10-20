/**
 * IMP1 (final review): each action only from the dispute statuses its owner-approved sandbox writes were sent from.
 * accept_claim (W-9, W-10), escalate (W-5) and make_offer (W-4) from WAITING_FOR_SELLER_RESPONSE; send_message also from
 * WAITING_FOR_BUYER_RESPONSE (W-2, W-3). Checked on the recorded after-reads (packages/paypal/contracts/reads/) through the
 * real registry and rules, in availability, compose and the recompose at send. Nothing is sent anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Dispute } from '@resolvekit/paypal';
import { actionAvailability, composeAction, type ActionRequest } from '../../web/src/domain/actions.ts';
import { toSnapshot } from '../src/mapping.ts';
import { REAL, approve, compose, confirm, send, setupActions } from './actions-kit.ts';
import { SELLER_ID, STD_CAPTURE } from './kit.ts';

const read = (name: string): Dispute => JSON.parse(readFileSync(new URL(`../../../packages/paypal/contracts/reads/${name}.json`, import.meta.url), 'utf8')) as Dispute;
const snapOf = (name: string) => toSnapshot(read(name), 'CASE', 'sandbox', new Date());
const NOT_VERIFIED = 'not verified with PayPal from this dispute status';
const OWNER = { role: 'owner' as const, reviewer: false };
const accept: ActionRequest = { action: 'accept_claim', acceptType: 'REFUND', note: 'Refund accepted.', amount: null, attachments: [] };
const NOTE = 'The parcel was delivered; see the tracking.';
const escalate: ActionRequest = { action: 'escalate', note: NOTE, attachments: [] };
const message: ActionRequest = { action: 'send_message', text: 'Your parcel was delivered on 8 Oct.', attachments: [] };
const composeOn = (snap: ReturnType<typeof snapOf>, req: ActionRequest) => composeAction({ caseId: 'CASE', req, snap, disputeId: snap.id, seller: SELLER_ID, files: [] });

for (const name of ['W-9-30s', 'W-4-10m', 'W-1-10m']) {
  test(`${name} (WAITING_FOR_BUYER_RESPONSE, accept and escalate still linked): accept and escalate Not available; a message allowed`, () => {
    const snap = snapOf(name);
    assert.equal(snap.status, 'WAITING_FOR_BUYER_RESPONSE');
    // PayPal still links them: only the recorded status rule refuses them.
    assert.ok(snap.allowedActions.includes('accept_claim') && snap.allowedActions.includes('escalate') && snap.allowedActions.includes('send_message'));
    assert.deepEqual(snap.responseOptions?.acceptClaimTypes, ['REFUND']);
    for (const req of [accept, escalate]) {
      assert.deepEqual(composeOn(snap, req), { status: 409, error: 'VARIANT_NOT_AVAILABLE', detail: `Not available: ${NOT_VERIFIED}` }, req.action);
      const a = actionAvailability(snap, req.action, OWNER);
      assert.deepEqual([a.offered, a.sendable, a.why], [true, false, NOT_VERIFIED], req.action);
    }
    assert.equal((composeOn(snap, message) as { action?: string }).action, 'send_message');
    assert.deepEqual([actionAvailability(snap, 'send_message', { role: 'member', reviewer: true }).sendable], [true]);
  });
}

test('the before-reads of the recorded writes are composable (the status the writes were sent from)', () => {
  for (const [name, req] of [['W-10-pre', accept], ['W-5-pre', escalate], ['W-1-pre', message], ['W-2-pre', message]] as const) {
    const c = composeOn(snapOf(name), req) as { action?: string; error?: string };
    assert.equal(c.action, req.action, `${name}: ${c.error}`);
  }
});

/** A recorded read re-bound to the standard case's payment so the binding verifies. */
function rebound(d: Dispute): Dispute {
  const c = structuredClone(d);
  return { ...c, dispute_id: REAL, disputed_transactions: [{ ...c.disputed_transactions![0]!, seller_transaction_id: STD_CAPTURE, seller: { merchant_id: SELLER_ID } }] };
}

test('recompose at send: an escalation approved while waiting for the seller is refused once PayPal waits for the buyer; nothing is posted', async () => {
  const { app, pp, state, intents } = await setupActions({ registry: false });
  state.dispute = rebound(read('W-5-pre'));
  const i = await compose(app, { action: 'escalate', note: NOTE });
  const terms = (await approve(app, i)).body.confirmation;
  assert.equal((await confirm(app, i, terms)).status, 200);
  // The buyer's turn now (as after W-9, still linking escalate): the send composes again and refuses.
  state.dispute = { ...rebound(read('W-5-pre')), status: 'WAITING_FOR_BUYER_RESPONSE' };
  const r = await send(app, i);
  assert.deepEqual([r.status, r.body.error, r.body.detail], [409, 'VARIANT_NOT_AVAILABLE', `Not available: ${NOT_VERIFIED}`]);
  assert.equal(pp.posts.length, 0);
  assert.equal(intents.peek(i.id)?.status, 'invalidated');
  assert.equal(intents.isUncertain(REAL), null);
});
