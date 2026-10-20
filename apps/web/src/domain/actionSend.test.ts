import { describe, expect, it } from 'vitest';
import w1 from '../../../../packages/paypal/contracts/send_message.json';
import w9 from '../../../../packages/paypal/contracts/accept_claim-partial_refund.json';
import w10 from '../../../../packages/paypal/contracts/accept_claim-refund.json';
import w5 from '../../../../packages/paypal/contracts/escalate.json';
import w4 from '../../../../packages/paypal/contracts/make_offer-refund.json';
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
/**
 * An approved intent built by hand for a state compose refuses (live and simulator agree, so composing it is refused
 * first): what the simulator does if one reached it anyway. The content is composed on the waiting-for-seller status the
 * contracts recorded, then pinned to the real status.
 */
function handBuilt(snap: DisputeSnapshot, req: Parameters<typeof composeAction>[0]['req']): SubmissionIntent {
  const c = composeAction({ caseId: 'CASE-1', req, snap: { ...snap, status: 'WAITING_FOR_SELLER_RESPONSE' }, disputeId: null, seller: null, files: [] }) as SubmissionIntent;
  expect(c).toHaveProperty('payload');
  return { ...c, pin: { ...c.pin!, status: snap.status }, id: 'int-h', contentHash: 'a'.repeat(64), requestId: 'rk-h', status: 'approved', createdAt: '', expiresAt: '', approvedBy: 'x', approvedAt: '', sentAt: null, reason: null };
}
const statusRefused = { status: 409, error: 'VARIANT_NOT_AVAILABLE', detail: 'Not available: not verified with PayPal from this dispute status' };

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
    const second = { action: 'send_message' as const, text: 'Second.', attachments: [] };
    expect(composeAction({ caseId: 'CASE-1', req: second, snap: { ...under, allowedActions: ['send_message'] }, disputeId: null, seller: null, files: [] })).toMatchObject(statusRefused);
    const early = handBuilt({ ...under, allowedActions: ['send_message'] }, second);
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
      entry: 'message',
      actionLagReads: 1,
      documents: 0,
      steps: [
        { at: '0s', afterMs: 0, status: 'UNDER_REVIEW', stage: 'INQUIRY', allowedActions: [], responseOptions: { acceptClaimTypes: [], offerTypes: [] }, entryVisible: false, outcome: null, refunded: false },
        { at: '30s', afterMs: 30_000, status: 'WAITING_FOR_BUYER_RESPONSE', stage: 'INQUIRY', allowedActions: ['send_message'], responseOptions: { acceptClaimTypes: [], offerTypes: [] }, entryVisible: true, outcome: null, refunded: false },
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
    // A replacement offer: never offered by PayPal on a sandbox dispute, so the registry says Not available and nothing is played.
    await expect(g.sendAction(fake({ action: 'make_offer', payload: { kind: 'make_offer', offerType: 'REPLACEMENT_WITHOUT_REFUND', note: 'A new one.', amount: null }, pin }), { requestId: 'rk-x' })).rejects.toThrow('NOT_AUTHORIZED: not available in the simulator');
    // An escalation is played only from the recorded state (W-5: waiting for the seller), not with these links.
    const { g: g4 } = sim({ status: 'WAITING_FOR_BUYER_RESPONSE', allowedActions: ['send_message', 'escalate'] });
    await expect(g4.sendAction(fake({ action: 'escalate', payload: { kind: 'escalate', note: 'Delivered.' }, pin }), { requestId: 'rk-x' })).rejects.toThrow('NOT_AUTHORIZED: not available in the simulator');
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

describe('the simulator plays the recorded accept transitions (W-10, W-9)', () => {
  /** The recorded starting state of both writes: waiting for the seller, 7.00 USD, accept PARTIAL_REFUND or REFUND. */
  const waitingSeller = (): Partial<DisputeSnapshot> => ({
    allowedActions: ['provide_evidence', 'send_message', 'make_offer', 'accept_claim', 'escalate'],
    amount: { value: w10.before.dispute_amount.value, currency: w10.before.dispute_amount.currency_code },
    allowedRefund: { value: w10.before.refund_details.allowed_refund_amount.value, currency: w10.before.refund_details.allowed_refund_amount.currency_code },
    reason: w10.before.reason,
    responseOptions: { acceptClaimTypes: [...w10.before.allowed_response_options.accept_claim.accept_claim_types], offerTypes: [...w10.before.allowed_response_options.make_offer.offer_types] },
  });
  const accept = (acceptType: string, note: string, amount: { value: string; currency: string } | null = null) => ({ action: 'accept_claim' as const, acceptType, note, amount, attachments: [] as [] });

  it('a full accept: the ACCEPT_CLAIM entry and the refund at once, then RESOLVED in the buyer’s favour (money moved, closed)', async () => {
    const { g, clock } = sim(waitingSeller());
    const intents = new LocalIntentClient();
    const before = await g.getDispute('CASE-1');
    const i = await intents.approve(await intents.createAction('CASE-1', accept('REFUND', w10.request.body.note), { snapshot: before }));
    const r = await sendActionWithReadBack({ intent: i, gateway: g, intents, mode: { kind: 'simulator' }, now: () => new Date(clock.t) });
    expect(r).toMatchObject({ kind: 'recorded', detail: 'Recorded by the simulator' });
    expect(r.snapshot).toMatchObject({ status: 'UNDER_REVIEW', allowedActions: [], refunds: [{ id: null, amount: { value: '7.00', currency: 'USD' } }] });
    expect(r.snapshot!.evidences.at(-1)).toMatchObject({ source: 'SUBMITTED_BY_SELLER', action: 'ACCEPT_CLAIM', responseOption: 'REFUND', notes: w10.request.body.note, stage: 'INQUIRY' });
    expect(r.snapshot!.outcome ?? null).toBeNull();
    // +2 min: RESOLVED, as recorded; the proof stays the entry, not the status.
    clock.t += 120_000;
    const closed = await g.getDispute('CASE-1');
    expect(closed).toMatchObject({ status: 'RESOLVED', allowedActions: [], outcome: { code: w10.after[2]!.dispute.dispute_outcome!.outcome_code, amountRefunded: { value: '7.00', currency: 'USD' } } });
    expect(proveSend(i, r.base!, closed, CONTRACTS['accept_claim:REFUND'], clock.t).state).toBe('recorded');
    // Nothing more can be done there: the next fresh read offers no action.
    expect(composeAction({ caseId: 'CASE-1', req: { action: 'send_message', text: TEXT, attachments: [] }, snap: closed, disputeId: null, seller: null, files: [] })).toMatchObject({ status: 409, error: 'ACTION_NOT_OFFERED' });
  });

  it('a partial accept: an offer waiting for the buyer; nothing closes and no refund is shown', async () => {
    const { g, clock } = sim(waitingSeller());
    const intents = new LocalIntentClient();
    const before = await g.getDispute('CASE-1');
    const i = await intents.approve(await intents.createAction('CASE-1', accept('PARTIAL_REFUND', w9.request.body.note, { value: '2.00', currency: 'USD' }), { snapshot: before }));
    const r = await sendActionWithReadBack({ intent: i, gateway: g, intents, mode: { kind: 'simulator' }, now: () => new Date(clock.t) });
    expect(r).toMatchObject({ kind: 'recorded' });
    expect(r.snapshot!.offerHistory).toEqual([{ time: new Date(T0).toISOString(), actor: 'SELLER', event: 'PROPOSED', type: 'REFUND', amount: { value: '2.00', currency: 'USD' } }]);
    expect(r.snapshot!.evidences.filter((e) => e.action === 'ACCEPT_CLAIM')).toEqual([]);
    // The note echoed as a seller message at the offer's time (W-9); the proof is still the offer entry.
    expect(r.snapshot!.messages!.filter((m) => m.postedBy === 'SELLER')).toEqual([{ postedBy: 'SELLER', time: new Date(T0).toISOString(), content: w9.request.body.note, files: [] }]);
    for (const step of [30_000, 90_000, 480_000]) {
      clock.t += step;
      const later = await g.getDispute('CASE-1');
      expect(later).toMatchObject({ status: 'WAITING_FOR_BUYER_RESPONSE', allowedActions: ['provide_evidence', 'send_message', 'accept_claim', 'escalate'], responseOptions: { acceptClaimTypes: ['REFUND'], offerTypes: [] } });
      expect(later.outcome ?? null).toBeNull();
      expect(later.refunds ?? []).toEqual([]);
    }
  });

  it('anything else is NOT_AUTHORIZED: another starting state, or a partial accept on the full accept’s state', async () => {
    // Waiting for the buyer (no accept was recorded from there).
    const { g } = sim({ ...waitingSeller(), status: 'WAITING_FOR_BUYER_RESPONSE', allowedActions: ['provide_evidence', 'send_message', 'accept_claim', 'escalate'], responseOptions: { acceptClaimTypes: ['REFUND'], offerTypes: [] } });
    const intents = new LocalIntentClient();
    const snap = await g.getDispute('CASE-1');
    // Compose refuses it first (no accept was recorded from WAITING_FOR_BUYER_RESPONSE), as on the server.
    await expect(intents.createAction('CASE-1', accept('REFUND', 'x'), { snapshot: snap })).rejects.toThrow('Not available: not verified with PayPal from this dispute status');
    const i = handBuilt(snap, accept('REFUND', 'x'));
    await expect(g.sendAction(i, { requestId: i.requestId })).rejects.toThrow('NOT_AUTHORIZED: not available in the simulator');
    expect(g.sentActions).toEqual([]);
  });
});

describe('the simulator plays the recorded offer (W-4)', () => {
  /** W-4's starting state: waiting for the seller, 7.00 USD (refundable 7.00), offer REFUND, no seller message. */
  const waitingSeller = (): Partial<DisputeSnapshot> => ({
    allowedActions: ['provide_evidence', 'send_message', 'make_offer', 'accept_claim', 'escalate'],
    amount: { value: w4.before.dispute_amount.value, currency: w4.before.dispute_amount.currency_code },
    allowedRefund: { value: w4.before.refund_details.allowed_refund_amount.value, currency: w4.before.refund_details.allowed_refund_amount.currency_code },
    reason: w4.before.reason,
    responseOptions: { acceptClaimTypes: [...w4.before.allowed_response_options.accept_claim.accept_claim_types], offerTypes: [...w4.before.allowed_response_options.make_offer.offer_types] },
  });
  const offer = (value = w4.request.body.offer_amount.value) => ({ action: 'make_offer' as const, offerType: 'REFUND', note: w4.request.body.note, amount: { value, currency: 'USD' }, attachments: [] as [] });

  it('an offer: the SELLER PROPOSED entry at once, the transient UNDER_REVIEW, then waiting for the buyer; never refunded or closed', async () => {
    const { g, clock } = sim(waitingSeller());
    const intents = new LocalIntentClient();
    const before = await g.getDispute('CASE-1');
    const i = await intents.approve(await intents.createAction('CASE-1', offer(), { snapshot: before }));
    const r = await sendActionWithReadBack({ intent: i, gateway: g, intents, mode: { kind: 'simulator' }, now: () => new Date(clock.t) });
    expect(r).toMatchObject({ kind: 'recorded', detail: 'Recorded by the simulator' });
    expect(r.snapshot).toMatchObject({ status: 'UNDER_REVIEW', allowedActions: [] });
    expect(r.snapshot!.offerHistory).toEqual([{ time: new Date(T0).toISOString(), actor: 'SELLER', event: 'PROPOSED', type: 'REFUND', amount: { value: '2.00', currency: 'USD' } }]);
    // The note echoed as a seller message at the offer's time, as PayPal shows it (W-4).
    expect(r.snapshot!.messages).toEqual([BUYER, { postedBy: 'SELLER', time: new Date(T0).toISOString(), content: w4.request.body.note, files: [] }]);
    for (const step of [30_000, 90_000, 480_000]) {
      clock.t += step;
      const later = await g.getDispute('CASE-1');
      expect(later).toMatchObject({ status: 'WAITING_FOR_BUYER_RESPONSE', allowedActions: ['provide_evidence', 'send_message', 'accept_claim', 'escalate'], responseOptions: { acceptClaimTypes: ['REFUND'], offerTypes: [] } });
      expect(later.outcome ?? null).toBeNull();
      expect(later.refunds ?? []).toEqual([]);
      expect(later.messages!.filter((m) => m.postedBy === 'SELLER')).toHaveLength(1);
      expect(proveSend(i, r.base!, later, CONTRACTS['make_offer:REFUND'], clock.t).state).toBe('recorded');
    }
    // A message with the note's exact text is not a repeat: as on the live server, a repeat is decided only from the
    // message sends recorded before, never from thread entries such as the offer's echoed note.
    const m = await intents.createAction('CASE-1', { action: 'send_message', text: w4.request.body.note, attachments: [] }, { snapshot: await g.getDispute('CASE-1') });
    expect(m.repeat).toBe(false);
    const approvedMessage = await intents.approve(m);
    expect(approvedMessage.confirmation).toBeNull();
    // Its proof is the new message: the echo is older than send_started, so it is not this send's.
    clock.t += 1_000;
    const sent = await sendActionWithReadBack({ intent: approvedMessage, gateway: g, intents, mode: { kind: 'simulator' }, now: () => new Date(clock.t) });
    expect(sent).toMatchObject({ kind: 'recorded' });
    const sellers = sent.snapshot!.messages!.filter((x) => x.postedBy === 'SELLER');
    expect(sellers.map((x) => [x.content, x.time])).toEqual([
      [w4.request.body.note, new Date(T0).toISOString()],
      [w4.request.body.note, new Date(clock.t).toISOString()],
    ]);
    const echoOnly = { ...sent.snapshot!, messages: sent.snapshot!.messages!.slice(0, -1) };
    expect(proveSend(approvedMessage, sent.base!, echoOnly, CONTRACTS.send_message, clock.t).state).toBe('pending');
    // Two message sends with the same text: the second needs REPEATS_MESSAGE (a recorded send of this browser).
    clock.t += 1_000;
    const again = await intents.createAction('CASE-1', { action: 'send_message', text: w4.request.body.note, attachments: [] }, { snapshot: await g.getDispute('CASE-1') });
    expect(again.repeat).toBe(true);
    expect((await intents.approve(again)).confirmation).toMatchObject({ action: 'send_message', consequence: 'REPEATS_MESSAGE' });
    // A second offer: PayPal no longer offers make_offer (the fresh read decides).
    const after = await g.getDispute('CASE-1');
    expect(composeAction({ caseId: 'CASE-1', req: offer('1.00'), snap: after, disputeId: null, seller: null, files: [] })).toMatchObject({ status: 409, error: 'ACTION_NOT_OFFERED' });
  });

  it('anything else is NOT_AUTHORIZED: another state, after a seller message, or with an offer pending', async () => {
    const intents = new LocalIntentClient();
    const tryOn = async (over: Partial<DisputeSnapshot>) => {
      const { g } = sim({ ...waitingSeller(), ...over });
      const snap = await g.getDispute('CASE-1');
      const i = handBuilt({ ...snap, offerHistory: [] }, offer());
      await expect(g.sendAction(i, { requestId: i.requestId })).rejects.toThrow(/^NOT_AUTHORIZED/);
      expect(g.sentActions).toEqual([]);
    };
    await tryOn({ status: 'WAITING_FOR_BUYER_RESPONSE' });
    // Composing it is refused first there, live and on the simulator alike (W-4 was sent from WAITING_FOR_SELLER_RESPONSE).
    expect(composeAction({ caseId: 'CASE-1', req: offer(), snap: { ...start(waitingSeller()), status: 'WAITING_FOR_BUYER_RESPONSE' }, disputeId: null, seller: null, files: [] })).toMatchObject(statusRefused);
    // Task 8's rule: after a seller message PayPal stops offering make_offer; W-4 had none before.
    await tryOn({ messages: [BUYER, { postedBy: 'SELLER', time: '2026-10-19T20:00:00.000Z', content: 'Shipped.', files: [] }] });
    await tryOn({ offerHistory: [{ time: '2026-10-19T20:00:00.000Z', actor: 'SELLER', event: 'PROPOSED', type: 'REFUND', amount: { value: '2.00', currency: 'USD' } }] });
    // The browser flow refuses the same before the simulator: composing with a pending offer is a duplicate.
    const pendingRead = { ...start(waitingSeller()), offerHistory: [{ time: '2026-10-19T20:00:00.000Z', actor: 'SELLER', event: 'PROPOSED', type: 'REFUND', amount: { value: '2.00', currency: 'USD' } }] };
    await expect(intents.createAction('CASE-1', offer(), { snapshot: pendingRead })).rejects.toThrow(/pending with the buyer/);
  });
});

describe('the simulator plays the recorded escalation (W-5) and the evidence after it (W-6)', () => {
  const waitingSeller = (): Partial<DisputeSnapshot> => ({
    allowedActions: ['provide_evidence', 'send_message', 'make_offer', 'accept_claim', 'escalate'],
    amount: { value: '7.00', currency: 'USD' },
    reason: w5.before.reason,
    respondBy: w5.before.seller_response_due_date,
  });
  const escalate = { action: 'escalate' as const, note: w5.request.body.note, attachments: [] as [] };
  const evidence = { disputeId: 'CASE-1', action: 'provide_evidence' as const, evidenceType: 'PROOF_OF_FULFILLMENT' as const, carrier: 'UPS', tracking: '1Z999AA10123456784', notes: 'Shipped with UPS.', files: [{ name: 'tracking.png', size: '1 KB' }] };

  it('escalate: the ESCALATE entry at once, UNDER_REVIEW with flickering links, the claim by +10 min; never closed', async () => {
    const { g, clock } = sim(waitingSeller());
    const intents = new LocalIntentClient();
    const before = await g.getDispute('CASE-1');
    const i = await intents.approve(await intents.createAction('CASE-1', escalate, { snapshot: before }));
    const r = await sendActionWithReadBack({ intent: i, gateway: g, intents, mode: { kind: 'simulator' }, now: () => new Date(clock.t) });
    expect(r).toMatchObject({ kind: 'recorded', detail: 'Recorded by the simulator' });
    expect(r.snapshot).toMatchObject({ status: 'UNDER_REVIEW', stage: 'INQUIRY', allowedActions: [], respondBy: null, requestedEvidence: [] });
    expect(r.snapshot!.evidences.at(-1)).toMatchObject({ source: 'SUBMITTED_BY_SELLER', action: 'ESCALATE', evidenceType: 'OTHER', notes: w5.request.body.note, stage: 'INQUIRY' });
    // +30 s: provide_evidence for a moment; evidence there was never recorded, so the simulator refuses it.
    clock.t += 30_000;
    expect(await g.getDispute('CASE-1')).toMatchObject({ status: 'UNDER_REVIEW', stage: 'INQUIRY', allowedActions: ['provide_evidence'] });
    await expect(g.provideEvidence(evidence, { requestId: 'rk-e1' })).rejects.toThrow('NOT_AUTHORIZED: not available in the simulator');
    clock.t += 90_000;
    expect(await g.getDispute('CASE-1')).toMatchObject({ status: 'UNDER_REVIEW', stage: 'INQUIRY', allowedActions: [] });
    // +10 min: the claim waits for the seller, with what PayPal requests and a new due date.
    clock.t += 480_000;
    const claim = await g.getDispute('CASE-1');
    expect(claim).toMatchObject({
      status: 'WAITING_FOR_SELLER_RESPONSE',
      stage: 'CHARGEBACK',
      allowedActions: ['provide_evidence', 'accept_claim'],
      responseOptions: { acceptClaimTypes: ['REFUND', 'PARTIAL_REFUND'], offerTypes: [] },
      requestedEvidence: ['PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND', 'OTHER'],
      respondBy: new Date(T0 + Date.parse(w5.after[3]!.dispute.seller_response_due_date!) - Date.parse(w5.sentStartedAt)).toISOString(),
    });
    expect(claim.outcome ?? null).toBeNull();
    expect(proveSend(i, r.base!, claim, CONTRACTS.escalate, clock.t).state).toBe('recorded');
    // W-6: evidence in the claim, once; the entry carries the claim stage; then PayPal reviews with no seller action.
    await g.provideEvidence(evidence, { requestId: 'rk-e2' });
    const after = await g.getDispute('CASE-1');
    expect(after).toMatchObject({ status: 'UNDER_REVIEW', stage: 'CHARGEBACK', allowedActions: [] });
    expect(after.evidences.at(-1)).toMatchObject({ source: 'SUBMITTED_BY_SELLER', action: 'PROVIDE_EVIDENCE', stage: 'CHARGEBACK', notes: 'Shipped with UPS.' });
    await expect(g.provideEvidence(evidence, { requestId: 'rk-e3' })).rejects.toThrow(/NOT_AUTHORIZED/);
    expect(g.sent.map((x) => x.requestId)).toEqual(['rk-e2']);
  });

  it('escalate from another state is NOT_AUTHORIZED in the simulator', async () => {
    const { g } = sim({ ...waitingSeller(), status: 'WAITING_FOR_BUYER_RESPONSE', allowedActions: ['provide_evidence', 'send_message', 'accept_claim', 'escalate'] });
    const intents = new LocalIntentClient();
    const snap = await g.getDispute('CASE-1');
    await expect(intents.createAction('CASE-1', escalate, { snapshot: snap })).rejects.toThrow('Not available: not verified with PayPal from this dispute status');
    const i = handBuilt(snap, escalate);
    await expect(g.sendAction(i, { requestId: i.requestId })).rejects.toThrow('NOT_AUTHORIZED: not available in the simulator');
    expect(g.sentActions).toEqual([]);
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
    const r = await sendActionWithReadBack({ intent: { ...i, action: 'make_offer', payload: { kind: 'make_offer', offerType: 'REPLACEMENT_WITHOUT_REFUND', note: 'x', amount: null } }, gateway: g, intents, mode: { kind: 'simulator' } });
    expect(r).toMatchObject({ kind: 'not_sent', detail: 'NOT_AUTHORIZED: not available in the simulator' });
    // A refund offer on a dispute outside W-4's recorded state (no reason, no refundable amount) is not played either.
    const offer = await sendActionWithReadBack({ intent: { ...i, action: 'make_offer', payload: { kind: 'make_offer', offerType: 'REFUND', note: 'x', amount: { value: '1.00', currency: 'USD' } } }, gateway: g, intents, mode: { kind: 'simulator' } });
    expect(offer).toMatchObject({ kind: 'not_sent', detail: 'NOT_AUTHORIZED: not available in the simulator' });
    expect(g.sentActions).toEqual([]);
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

describe('appeal and PROOF_OF_REFUND are not available in this delivery (Task 12, owner decision 20/10/2026)', () => {
  it('the simulator refuses an appeal, even when the dispute offers the appeal link, and plays nothing', async () => {
    const { g } = sim({ allowedActions: ['provide_evidence', 'send_message', 'appeal'] });
    const snap = await g.getDispute('CASE-1');
    const base = { ...(composeAction({ caseId: 'CASE-1', req: { action: 'send_message', text: 'x', attachments: [] }, snap: { ...snap, allowedActions: ['send_message'] }, disputeId: null, seller: null, files: [] }) as SubmissionIntent) };
    const pin = { disputeId: null, seller: null, stage: 'INQUIRY', status: 'WAITING_FOR_SELLER_RESPONSE', amount: null };
    const { payload: _p, ...rest } = base;
    const appeal: SubmissionIntent = { ...rest, action: 'appeal', pin, id: 'int-a', contentHash: 'a'.repeat(64), requestId: 'rk-a', status: 'approved', createdAt: '', expiresAt: '', approvedBy: 'x', approvedAt: '', sentAt: null, reason: null };
    await expect(g.sendAction(appeal, { requestId: 'rk-a' })).rejects.toThrow('NOT_AUTHORIZED: not available in the simulator');
    expect(g.sentActions).toEqual([]);
    expect((await g.getDispute('CASE-1')).allowedActions).toContain('appeal');
  });

  it('the simulator refuses PROOF_OF_REFUND evidence and records nothing; other evidence types still go', async () => {
    const sub = (evidenceType: 'PROOF_OF_REFUND' | 'PROOF_OF_FULFILLMENT') => ({ disputeId: 'CASE-1', action: 'provide_evidence' as const, evidenceType, carrier: 'UPS', tracking: '1Z', notes: 'Delivered.', files: [] });
    const { g } = sim({ requestedEvidence: ['PROOF_OF_REFUND'] });
    await expect(g.provideEvidence(sub('PROOF_OF_REFUND'), { requestId: 'rk-r' })).rejects.toThrow('NOT_AUTHORIZED: not available in the simulator');
    expect((await g.getDispute('CASE-1')).evidences).toEqual([]);
    await g.provideEvidence(sub('PROOF_OF_FULFILLMENT'), { requestId: 'rk-f' });
    expect((await g.getDispute('CASE-1')).evidences.map((e) => e.evidenceType)).toEqual(['PROOF_OF_FULFILLMENT']);
  });
});
