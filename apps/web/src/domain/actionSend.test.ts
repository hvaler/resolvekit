import { describe, expect, it } from 'vitest';
import w1 from '../../../../packages/paypal/contracts/send_message.json';
import { checkAgain, sendActionWithReadBack } from './actionSend';
import { proveSend, readBackBase } from './actionReadback';
import { CONTRACTS } from './actionContracts';
import { composeAction } from './actions';
import { SimulatedDisputeGateway } from './gateway';
import { HttpDisputeGateway } from './httpGateway';
import { HttpIntentClient, LocalIntentClient } from './intentClient';
import type { SubmissionIntent } from './intent';
import type { SimTransition } from './simulatedActions';
import type { DisputeSnapshot } from './types';

const T0 = Date.UTC(2026, 9, 20, 5, 7, 17);
const BUYER = { postedBy: 'BUYER', time: '2026-10-19T19:39:03.168Z', content: 'Where is my parcel?', files: [] };
const start = (over: Partial<DisputeSnapshot> = {}): DisputeSnapshot => ({
  id: 'CASE-1',
  status: 'WAITING_FOR_SELLER_RESPONSE',
  stage: 'INQUIRY',
  allowedActions: ['provide_evidence', 'send_message', 'make_offer', 'accept_claim'],
  evidences: [],
  readAt: '',
  messages: [BUYER],
  ...over,
});
const TEXT = w1.request.body.message;

function sim(over: Partial<DisputeSnapshot> = {}, transitions?: Record<string, SimTransition[]>) {
  const clock = { t: T0 };
  const g = new SimulatedDisputeGateway([start(over)], { outcome: () => 'waiting_for_buyer', now: () => new Date(clock.t), ...(transitions ? { transitions } : {}) });
  return { g, clock };
}
async function localIntent(snap: DisputeSnapshot, req: Parameters<LocalIntentClient['createAction']>[1] = { action: 'send_message', text: TEXT, attachments: [] }) {
  const l = new LocalIntentClient();
  const i = await l.createAction('CASE-1', req, { snapshot: snap });
  return { l, i: await l.approve(i) };
}

describe('the simulator only plays recorded transitions', () => {
  it('a first message: the recorded entry, the transient UNDER_REVIEW, then the recorded links (no make_offer)', async () => {
    const { g, clock } = sim();
    const before = await g.getDispute('CASE-1');
    const { i } = await localIntent(before);
    expect(await g.sendAction(i, { requestId: i.requestId })).toEqual({ sent: true });
    const first = await g.getDispute('CASE-1');
    // +0 s: the entry is there, exactly as sent; PayPal shows UNDER_REVIEW with only the self link.
    expect(first.messages).toEqual([BUYER, { postedBy: 'SELLER', time: new Date(T0).toISOString(), content: TEXT, files: [] }]);
    expect(first).toMatchObject({ status: 'UNDER_REVIEW', stage: 'INQUIRY', allowedActions: [], responseOptions: { acceptClaimTypes: [], offerTypes: [] } });
    // +30 s and on: the contract's last read.
    clock.t += 30_000;
    const last = w1.after[w1.after.length - 1]!.dispute;
    const later = await g.getDispute('CASE-1');
    expect(later.status).toBe(last.status);
    expect(later.stage).toBe(last.dispute_life_cycle_stage);
    expect(later.allowedActions).toEqual(['provide_evidence', 'send_message', 'accept_claim', 'escalate']);
    expect(last.links.map((l) => l.rel).sort()).toEqual(['self', ...later.allowedActions].sort());
    expect(later.responseOptions).toEqual({ acceptClaimTypes: last.allowed_response_options!.accept_claim.accept_claim_types, offerTypes: [] });
    expect(later.messages!.filter((m) => m.postedBy === 'SELLER')).toHaveLength(1);
    // A second message (W-2): nothing else changes; a second identical entry (no dedupe).
    const { i: again } = await localIntent(later);
    await g.sendAction(again, { requestId: again.requestId });
    const twice = await g.getDispute('CASE-1');
    expect(twice.status).toBe('WAITING_FOR_BUYER_RESPONSE');
    expect(twice.messages!.filter((m) => m.postedBy === 'SELLER' && m.content === TEXT)).toHaveLength(2);
  });

  it('a write refused during the transient UNDER_REVIEW leaves the recorded reads playing; evidence accepted later ends them', async () => {
    const { g, clock } = sim();
    const { i } = await localIntent(await g.getDispute('CASE-1'));
    await g.sendAction(i, { requestId: i.requestId });
    const under = await g.getDispute('CASE-1');
    expect(under.status).toBe('UNDER_REVIEW');
    // PayPal gives no links then: another message is refused, and the dispute still moves on as recorded.
    const { i: early } = await localIntent({ ...under, allowedActions: ['send_message'] }, { action: 'send_message', text: 'Second.', attachments: [] });
    await expect(g.sendAction(early, { requestId: early.requestId })).rejects.toThrow('NOT_AUTHORIZED: send_message is not allowed for this dispute');
    clock.t += 30_000;
    expect((await g.getDispute('CASE-1')).status).toBe('WAITING_FOR_BUYER_RESPONSE');
    // Evidence then: the simulator's evidence rules apply, and the message's later recorded reads (2 min, 10 min) do not
    // overwrite them.
    await g.provideEvidence({ disputeId: 'CASE-1', action: 'provide_evidence', evidenceType: 'PROOF_OF_FULFILLMENT', carrier: 'UPS', tracking: '1Z', notes: 'n', files: [] }, { requestId: 'rk-e' });
    clock.t += 600_000;
    const after = await g.getDispute('CASE-1');
    expect(after.allowedActions).not.toContain('provide_evidence');
    // After a seller message PayPal no longer offers make_offer, and accept is REFUND only (W-1).
    expect(after.allowedActions).toEqual(['send_message', 'accept_claim']);
    expect(after.responseOptions).toEqual({ acceptClaimTypes: ['REFUND'], offerTypes: [] });
  });

  it('with lag recorded, the first read does not show the entry: Outcome pending confirmation, then recorded', async () => {
    const lagged: SimTransition = {
      variant: 'send_message',
      recorded: 'test-only (a contract with lag)',
      from: { stage: 'INQUIRY', status: 'WAITING_FOR_SELLER_RESPONSE', allowedActions: ['provide_evidence', 'send_message', 'make_offer', 'accept_claim'] },
      actionLagReads: 1,
      documents: 0,
      steps: [
        { at: '0s', afterMs: 0, status: 'UNDER_REVIEW', stage: 'INQUIRY', allowedActions: [], responseOptions: { acceptClaimTypes: [], offerTypes: [] }, entryVisible: false },
        { at: '30s', afterMs: 30_000, status: 'WAITING_FOR_BUYER_RESPONSE', stage: 'INQUIRY', allowedActions: ['send_message'], responseOptions: { acceptClaimTypes: [], offerTypes: [] }, entryVisible: true },
      ],
    };
    const { g, clock } = sim({}, { send_message: [lagged] });
    const intents = new LocalIntentClient();
    const before = await g.getDispute('CASE-1');
    const i = await intents.approve(await intents.createAction('CASE-1', { action: 'send_message', text: TEXT, attachments: [] }, { snapshot: before }));
    const opts = { intent: i, gateway: g, intents, mode: { kind: 'simulator' as const }, now: () => new Date(clock.t) };
    const r = await sendActionWithReadBack(opts);
    expect(r).toMatchObject({ kind: 'pending', detail: 'Outcome pending confirmation' });
    expect(r.snapshot?.status).toBe('UNDER_REVIEW');
    clock.t += 30_000;
    const again = await checkAgain({ ...opts, base: r.base });
    expect(again).toMatchObject({ kind: 'recorded', detail: 'Recorded by the simulator' });
  });

  it('a variant or a starting state without a recorded contract → NOT_AUTHORIZED', async () => {
    const { g } = sim({ allowedActions: ['send_message', 'escalate'] });
    const snap = await g.getDispute('CASE-1');
    const pin = { disputeId: null, seller: null, stage: 'INQUIRY', status: 'WAITING_FOR_SELLER_RESPONSE', amount: null };
    const base = { ...(composeAction({ caseId: 'CASE-1', req: { action: 'send_message', text: 'x', attachments: [] }, snap, disputeId: null, seller: null, files: [] }) as SubmissionIntent) };
    const fake = (over: Partial<SubmissionIntent>): SubmissionIntent => ({ ...base, id: 'int-x', contentHash: 'a'.repeat(64), requestId: 'rk-x', status: 'approved', createdAt: '', expiresAt: '', approvedBy: 'x', approvedAt: '', sentAt: null, reason: null, ...over });
    await expect(g.sendAction(fake({ action: 'escalate', payload: { kind: 'escalate', note: 'Delivered.' }, pin }), { requestId: 'rk-x' })).rejects.toThrow('NOT_AUTHORIZED: not available in the simulator');
    // A message with a file was recorded only while PayPal waited for the buyer (W-3), not from this state.
    await expect(g.sendAction(fake({ files: [{ name: 'tracking.png', size: '2 KB' }] }), { requestId: 'rk-x' })).rejects.toThrow('NOT_AUTHORIZED: not available in the simulator');
    // A link PayPal does not give.
    const { g: g2 } = sim({ allowedActions: ['provide_evidence'] });
    await expect(g2.sendAction(fake({}), { requestId: 'rk-x' })).rejects.toThrow(/^NOT_AUTHORIZED/);
    // The same stage and status, but links the recorded state did not have (here appeal): not that state.
    const { g: g3 } = sim({ allowedActions: ['provide_evidence', 'send_message', 'appeal'] });
    await expect(g3.sendAction(fake({}), { requestId: 'rk-x' })).rejects.toThrow('NOT_AUTHORIZED: not available in the simulator');
    expect(g.sentActions).toEqual([]);
    expect(g3.sentActions).toEqual([]);
  });
});

describe('sendActionWithReadBack', () => {
  it('the simulator: read before, send, read back with the same matcher → «Recorded by the simulator»', async () => {
    const { g, clock } = sim();
    const intents = new LocalIntentClient();
    const before = await g.getDispute('CASE-1');
    const i = await intents.approve(await intents.createAction('CASE-1', { action: 'send_message', text: TEXT, attachments: [] }, { snapshot: before }));
    const phases: string[] = [];
    const r = await sendActionWithReadBack({ intent: i, gateway: g, intents, mode: { kind: 'simulator' }, now: () => new Date(clock.t), onPhase: (p) => phases.push(p) });
    expect(r).toMatchObject({ kind: 'recorded', detail: 'Recorded by the simulator' });
    expect(phases).toEqual(['reading', 'sending', 'rereading']);
    expect(r.snapshot!.messages!.at(-1)!.content).toBe(TEXT);
    // The same proof the server uses.
    expect(proveSend(i, r.base!, r.snapshot!, CONTRACTS.send_message, clock.t).state).toBe('recorded');
    expect(readBackBase(before, CONTRACTS.send_message.proof!, new Date(T0).toISOString()).entryKeys).toEqual([]);
  });

  it('the simulator refuses an unrecorded variant: Not sent', async () => {
    const { g } = sim();
    const intents = new LocalIntentClient();
    const before = await g.getDispute('CASE-1');
    const i = await intents.approve(await intents.createAction('CASE-1', { action: 'send_message', text: TEXT, attachments: [] }, { snapshot: before }));
    const r = await sendActionWithReadBack({ intent: { ...i, action: 'escalate', payload: { kind: 'escalate', note: 'x' } }, gateway: g, intents, mode: { kind: 'simulator' } });
    expect(r).toMatchObject({ kind: 'not_sent', detail: 'NOT_AUTHORIZED: not available in the simulator' });
  });

  it('real PayPal: the server sends and reads back; pending until the server proves it, then «Check again»', async () => {
    const calls: string[] = [];
    const replies: Array<[number, unknown]> = [];
    const fetch = (async (url: string | URL, init: RequestInit = {}) => {
      calls.push(`${init.method ?? 'GET'} ${String(url)}${init.body ? ` ${String(init.body)}` : ''}`);
      const [status, body] = replies.shift() ?? [500, {}];
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    const gateway = new HttpDisputeGateway({ fetch });
    const intents = new HttpIntentClient({ fetch });
    const snap = start({ origin: { kind: 'paypal', env: 'sandbox', disputeId: 'PP-R-1' } });
    const i = { ...(composeAction({ caseId: 'CASE-1', req: { action: 'send_message', text: TEXT, attachments: [] }, snap, disputeId: 'PP-R-1', seller: 'S', files: [] }) as object), id: 'int-1', contentHash: 'b'.repeat(64), requestId: 'rk-int-1', status: 'approved' } as SubmissionIntent;
    const mode = { kind: 'paypal' as const, env: 'sandbox' as const };
    replies.push([202, { sent: true, intent: i }], [200, { readBack: { state: 'pending', detail: 'Outcome pending confirmation', at: 'x' }, snapshot: snap }]);
    const r = await sendActionWithReadBack({ intent: i, gateway, intents, mode });
    expect(r).toMatchObject({ kind: 'pending', detail: 'Outcome pending confirmation' });
    expect(calls[0]).toBe(`POST /api/disputes/CASE-1/send {"intentId":"int-1"}`);
    expect(calls[1]).toBe('GET /api/disputes/CASE-1/intent/int-1/readback');
    replies.push([200, { readBack: { state: 'recorded', detail: 'Recorded by PayPal', at: 'y' }, snapshot: snap }]);
    expect(await checkAgain({ intent: i, gateway, intents, mode, base: r.base })).toMatchObject({ kind: 'recorded', detail: 'Recorded by PayPal' });
    // Refusals before PayPal: not sent, with what the person needs to go on.
    const terms = { intentId: 'int-1', contentHash: 'b'.repeat(64), action: 'send_message', amount: null, currency: null, consequence: 'REPEATS_MESSAGE' };
    replies.push([409, { error: 'CONFIRMATION_REQUIRED', detail: 'Confirm the consequence of this action first', terms }]);
    expect(await sendActionWithReadBack({ intent: i, gateway, intents, mode })).toMatchObject({ kind: 'not_sent', refusal: { code: 'CONFIRMATION_REQUIRED', terms } });
    const fresh = { postedBy: 'BUYER', time: '2026-10-20T06:00:00.000Z', content: 'Any news?', files: [] };
    replies.push([409, { error: 'NEEDS_REVIEW', detail: 'The buyer wrote since you approved this', messages: [fresh], messageKeys: ['BUYER|2026-10-20T06:00:00.000Z|9'] }]);
    expect(await sendActionWithReadBack({ intent: i, gateway, intents, mode })).toMatchObject({ kind: 'not_sent', refusal: { code: 'NEEDS_REVIEW', messages: [fresh], messageKeys: ['BUYER|2026-10-20T06:00:00.000Z|9'] } });
    // An uncertain dispute is never «not sent»: pending, nothing resent.
    replies.push([409, { error: 'DISPUTE_UNCERTAIN', detail: 'Outcome pending confirmation: PayPal does not show this send yet' }]);
    expect(await sendActionWithReadBack({ intent: i, gateway, intents, mode })).toMatchObject({ kind: 'pending' });
    // A send the server reconciled as recorded.
    replies.push([200, { reconciled: true, intent: i, readBack: { state: 'recorded', detail: 'Recorded by PayPal', at: 'z' } }], [200, { readBack: { state: 'recorded', detail: 'Recorded by PayPal', at: 'z' }, snapshot: snap }]);
    expect(await sendActionWithReadBack({ intent: i, gateway, intents, mode })).toMatchObject({ kind: 'recorded' });
    // A 5xx, or a 4xx with no code ResolveKit gives before PayPal, proves nothing: read back, never «Not sent».
    for (const [status, body] of [
      [500, { error: 'INTERNAL' }],
      [502, {}],
      [409, { error: 'INTENT_SENDING' }],
      [400, {}],
    ] as Array<[number, unknown]>) {
      const before = calls.length;
      replies.push([status, body], [200, { readBack: { state: 'pending', detail: 'Outcome pending confirmation', at: 'p' }, snapshot: snap }]);
      expect(await sendActionWithReadBack({ intent: i, gateway, intents, mode }), String(status)).toMatchObject({ kind: 'pending' });
      expect(calls[before + 1]).toBe('GET /api/disputes/CASE-1/intent/int-1/readback');
    }
    // Definite refusals before PayPal (a cap, a stale intent, PayPal's own refusal with its issue): not sent.
    for (const [status, error] of [
      [429, 'DAILY_CAP'],
      [409, 'INTENT_STALE'],
      [403, 'OWNER_ONLY'],
      [422, 'PAYPAL_REFUSED'],
    ] as Array<[number, string]>) {
      replies.push([status, { error, detail: 'refused', ...(error === 'PAYPAL_REFUSED' ? { paypalIssue: 'X' } : {}) }]);
      expect(await sendActionWithReadBack({ intent: i, gateway, intents, mode }), error).toMatchObject({ kind: 'not_sent', refusal: { code: error } });
    }
  });
});
