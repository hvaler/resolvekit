import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { actionAvailability, composeAction } from '../domain/actions';
import type { SubmissionIntent } from '../domain/intent';
import type { DisputeSnapshot } from '../domain/types';
import { ActionComposer } from './ActionComposer';
import { ActionFlowController, ActionFlowView, type ActionFlowDeps, type ActionFlowState } from './ActionFlow';
import { SimulatedDisputeGateway } from '../domain/gateway';
import { HttpDisputeGateway } from '../domain/httpGateway';
import { HttpIntentClient, LocalIntentClient } from '../domain/intentClient';
import { MessageThread } from './MessageThread';

const snap: DisputeSnapshot = {
  id: 'CASE-1',
  status: 'WAITING_FOR_SELLER_RESPONSE',
  stage: 'INQUIRY',
  allowedActions: ['provide_evidence', 'send_message'],
  evidences: [],
  readAt: '',
  messages: [{ postedBy: 'BUYER', time: '2026-10-19T19:39:03.168Z', content: 'Where is my parcel?', files: [] }],
};
const TEXT = 'The parcel left on 7 October with UPS.';
const intent = {
  ...(composeAction({ caseId: 'CASE-1', req: { action: 'send_message', text: TEXT, attachments: [] }, snap, disputeId: 'PP-R-1', seller: 'S', files: [] }) as object),
  id: 'int-1',
  contentHash: 'c'.repeat(64),
  requestId: 'rk-int-1',
  status: 'approved',
} as SubmissionIntent;
const paypal = { kind: 'paypal' as const, env: 'sandbox' as const };
const noop = () => {};
const view = (state: ActionFlowState, mode: typeof paypal | { kind: 'simulator' } = paypal) =>
  renderToString(<ActionFlowView state={state} mode={mode} caseId="CASE-1" busy={false} onApprove={noop} onConfirm={noop} onCheckAgain={noop} onSendAnyway={noop} onEdit={noop} onClose={noop} />);

describe('ActionFlow', () => {
  it('review shows exactly the message and what the buyer sees', () => {
    const html = view({ step: 'review', intent, repeat: false });
    expect(html).toContain(TEXT);
    expect(html).toContain('The buyer sees this message in PayPal.');
    expect(html).toContain('Review');
    expect(html).not.toContain('Recorded by PayPal');
  });

  it('a repeat asks for the second confirmation, naming it', () => {
    const terms = { intentId: 'int-1', contentHash: 'c'.repeat(64), action: 'send_message' as const, amount: null, currency: null, consequence: 'REPEATS_MESSAGE' };
    const html = view({ step: 'confirm', intent, terms });
    expect(html).toContain('REPEATS_MESSAGE');
    expect(html).toContain('PayPal already shows this exact message');
  });

  it('pending shows "Outcome pending confirmation" and "Check again", never "Recorded by PayPal"', () => {
    const html = view({ step: 'result', intent, result: { kind: 'pending', detail: 'Outcome pending confirmation', snapshot: null, base: null } });
    expect(html).toContain('Outcome pending confirmation');
    expect(html).toContain('Check again');
    expect(html).not.toContain('Recorded by PayPal');
    expect(html).not.toContain('Recorded by the simulator');
  });

  it('recorded says who recorded it; not sent says so', () => {
    expect(view({ step: 'result', intent, result: { kind: 'recorded', detail: 'Recorded by PayPal', snapshot: snap, base: null } })).toContain('Recorded by PayPal');
    const sim = view({ step: 'result', intent, result: { kind: 'recorded', detail: 'Recorded by the simulator', snapshot: snap, base: null } }, { kind: 'simulator' });
    expect(sim).toContain('Recorded by the simulator');
    expect(sim).not.toContain('Recorded by PayPal');
    const no = view({ step: 'result', intent, result: { kind: 'not_sent', detail: 'NOT_AUTHORIZED: not available in the simulator', snapshot: null, base: null } }, { kind: 'simulator' });
    expect(no).toContain('Not sent');
    expect(no).toContain('NOT_AUTHORIZED: not available in the simulator');
    expect(no).not.toContain('Check again');
  });

  it('NEEDS_REVIEW shows the new buyer message and both choices', () => {
    const fresh = { postedBy: 'BUYER', time: '2026-10-20T06:00:00.000Z', content: 'Any news about the parcel?', files: [] };
    const html = view({ step: 'needs_review', intent, messages: [fresh], messageKeys: ['BUYER|2026-10-20T06:00:00.000Z|26'] });
    expect(html).toContain('Any news about the parcel?');
    expect(html).toContain('Send it anyway');
    expect(html).toContain('Edit the message');
    expect(html).toContain('20 Oct 2026 06:00:00 UTC');
  });
});

describe('ActionComposer and MessageThread', () => {
  it('the composer counts n / 2,000 and gives the availability with the registry status', () => {
    const a = actionAvailability(snap, 'send_message', { role: 'member', reviewer: true });
    const html = renderToString(<ActionComposer action="send_message" text={TEXT} onText={noop} availability={a} locked={null} onReview={noop} />);
    expect(html).toContain(`${TEXT.length} / 2,000`);
    expect(html).toContain('Tested locally');
    expect(html).toContain('Review the message');
    // Attaching is not wired in the composer yet: the file variant is not offered there.
    expect(html).not.toContain('Message with a file');
    // A variant without a contract gives its reason as the registry labels it.
    const off = actionAvailability({ ...snap, allowedActions: ['make_offer'], responseOptions: { acceptClaimTypes: [], offerTypes: ['REPLACEMENT_WITHOUT_REFUND'] } }, 'make_offer', { role: 'owner', reviewer: false });
    const offer = renderToString(<ActionComposer action="make_offer" text="" onText={noop} availability={off} locked={null} onReview={noop} />);
    expect(offer).toContain('Not available: Not verified with PayPal: never offered on a sandbox dispute');
    expect(offer).not.toContain('Review the message');
  });

  it('the thread: Buyer / You, the UTC time and the text; or none yet', () => {
    const html = renderToString(<MessageThread messages={[...snap.messages!, { postedBy: 'SELLER', time: '2026-10-20T05:07:20.780Z', content: TEXT, files: [] }]} />);
    expect(html).toContain('Messages');
    expect(html).toContain('Buyer');
    expect(html).toContain('You');
    expect(html).toContain('19 Oct 2026 19:39:03 UTC');
    expect(html).toContain('Where is my parcel?');
    expect(html).toContain(TEXT);
    expect(renderToString(<MessageThread messages={[]} />)).toContain('No messages on this dispute yet.');
  });
});

describe('ActionFlowController (the container’s steps)', () => {
  const T0 = Date.UTC(2026, 9, 20, 5, 7, 17);
  const start = (): DisputeSnapshot => ({ ...snap, allowedActions: ['provide_evidence', 'send_message', 'make_offer', 'accept_claim'] });
  const deps = (o: Partial<ActionFlowDeps> & Pick<ActionFlowDeps, 'source' | 'gateway' | 'mode'>) => {
    const audits: string[] = [];
    const states: string[] = [];
    let recorded = 0;
    const d: ActionFlowDeps = {
      caseId: 'CASE-1',
      request: { action: 'send_message', text: TEXT, attachments: [] },
      onState: (s) => states.push(s.step),
      audit: (who, what) => audits.push(`${who}: ${what}`),
      applySnapshot: () => {},
      onRecorded: () => (recorded += 1),
      ...o,
    };
    return { d, audits, states, recorded: () => recorded };
  };

  it('simulator: send, then the same text again → confirm REPEATS_MESSAGE → send → recorded', async () => {
    const clock = { t: T0 };
    const gateway = new SimulatedDisputeGateway([start()], { outcome: () => 'waiting_for_buyer', now: () => new Date(clock.t) });
    const source = new LocalIntentClient();
    const one = deps({ source, gateway, mode: { kind: 'simulator' }, now: () => new Date(clock.t) });
    const f1 = new ActionFlowController(one.d);
    await f1.start();
    expect(f1.state).toMatchObject({ step: 'review', repeat: false });
    await f1.approve();
    expect(f1.state).toMatchObject({ step: 'result', result: { kind: 'recorded', detail: 'Recorded by the simulator' } });
    expect(one.recorded()).toBe(1);
    expect(one.audits).toEqual(['ResolveKit: Sending send_message to the simulator · request ' + (f1.state as { intent: SubmissionIntent }).intent.requestId, 'Simulator re-read: Send message · recorded']);
    // +30 s: PayPal waits for the buyer again (W-1); the same text is a repeat.
    clock.t += 30_000;
    const two = deps({ source, gateway, mode: { kind: 'simulator' }, now: () => new Date(clock.t) });
    const f2 = new ActionFlowController(two.d);
    await f2.start();
    expect(f2.state).toMatchObject({ step: 'review', repeat: true });
    await f2.approve();
    expect(f2.state).toMatchObject({ step: 'confirm', terms: { consequence: 'REPEATS_MESSAGE' } });
    expect(two.audits).toEqual([]);
    await f2.confirm();
    expect(f2.state).toMatchObject({ step: 'result', result: { kind: 'recorded' } });
    expect(gateway.sentActions).toHaveLength(2);
  });

  it('real PayPal: NEEDS_REVIEW → acknowledge the shown keys → send → pending → check again → recorded', async () => {
    const calls: string[] = [];
    const replies: Array<[number, unknown]> = [];
    const fetch = (async (url: string | URL, init: RequestInit = {}) => {
      calls.push(`${init.method ?? 'GET'} ${String(url)}${init.body ? ` ${String(init.body)}` : ''}`);
      const [status, body] = replies.shift() ?? [500, {}];
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    const fresh = { postedBy: 'BUYER', time: '2026-10-20T06:00:00.000Z', content: 'Any news?', files: [] };
    const keys = ['BUYER|2026-10-20T06:00:00.000Z|9'];
    const live = { ...snap, origin: { kind: 'paypal' as const, env: 'sandbox' as const, disputeId: 'PP-R-1' } };
    replies.push(
      [201, { ...intent, status: 'proposed', repeat: false }],
      [200, { ...intent, confirmation: null }],
      [409, { error: 'NEEDS_REVIEW', detail: 'The buyer wrote since you approved this', messages: [fresh], messageKeys: keys }],
      [200, { ...intent, snapshot: live }],
      [202, { sent: true, intent }],
      [200, { readBack: { state: 'pending', detail: 'Outcome pending confirmation', at: 'a' }, snapshot: live }],
      [200, { readBack: { state: 'recorded', detail: 'Recorded by PayPal', at: 'b' }, snapshot: live }],
    );
    const t = deps({ source: new HttpIntentClient({ fetch }), gateway: new HttpDisputeGateway({ fetch }), mode: paypal });
    const f = new ActionFlowController(t.d);
    await f.start();
    await f.approve();
    expect(f.state).toMatchObject({ step: 'needs_review', messages: [fresh], messageKeys: keys });
    // A refusal that asks the person for a step is no outcome: no re-read entry.
    expect(t.audits.filter((a) => a.includes('re-read'))).toEqual([]);
    await f.sendAnyway();
    expect(calls[3]).toBe(`POST /api/disputes/CASE-1/intent/int-1/acknowledge ${JSON.stringify({ contentHash: intent.contentHash, shownMessageKeys: keys })}`);
    expect(calls[4]).toBe('POST /api/disputes/CASE-1/send {"intentId":"int-1"}');
    expect(f.state).toMatchObject({ step: 'result', result: { kind: 'pending' } });
    expect(t.recorded()).toBe(0);
    await f.checkAgain();
    expect(f.state).toMatchObject({ step: 'result', result: { kind: 'recorded', detail: 'Recorded by PayPal' } });
    expect(t.recorded()).toBe(1);
    expect(t.audits.at(-1)).toBe('PayPal re-read: Send message · recorded');
    expect(t.audits.filter((a) => a.startsWith('ResolveKit: Sending send_message to PayPal sandbox'))).toHaveLength(2);
  });
});

describe('accept_claim: full and partial are never presented alike (Task 9)', () => {
  const waiting: DisputeSnapshot = {
    ...snap,
    allowedActions: ['provide_evidence', 'send_message', 'make_offer', 'accept_claim', 'escalate'],
    amount: { value: '7.00', currency: 'USD' },
    allowedRefund: { value: '7.00', currency: 'USD' },
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    responseOptions: { acceptClaimTypes: ['PARTIAL_REFUND', 'REFUND'], offerTypes: ['REFUND'] },
  };
  const acceptIntent = (acceptType: string, amount: { value: string; currency: string } | null, note = 'Refund accepted.') =>
    ({
      ...(composeAction({ caseId: 'CASE-1', req: { action: 'accept_claim', acceptType, note, amount, attachments: [] }, snap: waiting, disputeId: 'PP-R-1', seller: 'S', files: [] }) as object),
      id: 'int-9',
      contentHash: 'd'.repeat(64),
      requestId: 'rk-int-9',
      status: 'approved',
    }) as SubmissionIntent;
  const full = acceptIntent('REFUND', null);
  const partial = acceptIntent('PARTIAL_REFUND', { value: '2.00', currency: 'USD' }, 'Partial refund offered.');
  const termsOf = (i: SubmissionIntent, amount: string, consequence: string) => ({ intentId: i.id, contentHash: i.contentHash, action: 'accept_claim' as const, amount, currency: 'USD', consequence });

  it('the confirmation names the amount, the currency and the consequence code of each', () => {
    const f = view({ step: 'confirm', intent: full, terms: termsOf(full, '7.00', 'REFUNDS_BUYER') });
    expect(f).toContain('PayPal refunds 7.00 USD to the buyer and closes the dispute in the buyer’s favour. This cannot be undone.');
    expect(f).toContain('REFUNDS_BUYER');
    expect(f).toContain('7.00 USD');
    const p = view({ step: 'confirm', intent: partial, terms: termsOf(partial, '2.00', 'OFFERS_PARTIAL_REFUND') });
    expect(p).toContain('OFFERS_PARTIAL_REFUND');
    expect(p).toContain('2.00 USD');
    expect(p).toContain('The buyer has to agree to it');
    expect(p).not.toMatch(/PayPal refunds|closes the dispute|cannot be undone/);
  });

  it('recorded: a full accept says the claim was accepted; a partial one is an offer waiting for the buyer, never refunded or closed', () => {
    const closed = { ...waiting, status: 'RESOLVED' as const, allowedActions: [], outcome: { code: 'RESOLVED_BUYER_FAVOUR', closedAt: null }, refunds: [{ id: null, amount: { value: '7.00', currency: 'USD' }, time: null }] };
    const f = view({ step: 'result', intent: full, result: { kind: 'recorded', detail: 'Recorded by the simulator', snapshot: closed, base: null } }, { kind: 'simulator' });
    expect(f).toContain('Recorded by the simulator: claim accepted');
    expect(f).toContain('Refund of 7.00 USD');
    expect(f).toContain('Resolved in the buyer’s favour');
    const p = view({ step: 'result', intent: partial, result: { kind: 'recorded', detail: 'Recorded by PayPal', snapshot: { ...waiting, status: 'WAITING_FOR_BUYER_RESPONSE' }, base: null } });
    expect(p).toContain('Recorded by PayPal: offer waiting for the buyer');
    expect(p).not.toMatch(/[Rr]efunded|[Cc]losed|claim accepted/);
    expect(p).toContain('PayPal shows your offer to the buyer');
    // On the simulator the body names the simulator, never PayPal.
    const ps = view({ step: 'result', intent: partial, result: { kind: 'recorded', detail: 'Recorded by the simulator', snapshot: { ...waiting, status: 'WAITING_FOR_BUYER_RESPONSE' }, base: null } }, { kind: 'simulator' });
    expect(ps).toContain('The simulator shows your offer to the buyer');
    expect(ps).not.toContain('PayPal shows');
    // Pending stays pending, whatever the action.
    const pending = view({ step: 'result', intent: full, result: { kind: 'pending', detail: 'Outcome pending confirmation', snapshot: closed, base: null } });
    expect(pending).toContain('Outcome pending confirmation');
    expect(pending).not.toContain('claim accepted');
  });

  it('the composer: the owner picks a variant and reviews; a reviewer or member sees the preview only', () => {
    const owner = renderToString(
      <ActionComposer action="accept_claim" text="" onText={noop} availability={actionAvailability(waiting, 'accept_claim', { role: 'owner', reviewer: false })} locked={null} onReview={noop} onRequest={noop} disputeAmount={waiting.amount!} />,
    );
    expect(owner).toContain('Full refund');
    expect(owner).toContain('Partial refund');
    expect(owner).toContain('Tested locally');
    expect(owner).toContain('PayPal refunds 7.00 USD to the buyer');
    expect(owner).toContain('Review the accept');
    // The note is required: no «(optional)», and nothing to review while it is empty.
    expect(owner).toContain('Note to PayPal');
    expect(owner).not.toContain('(optional)');
    expect(owner).toMatch(/<button[^>]*disabled[^>]*>Review the accept/);
    for (const who of [{ role: 'member' as const, reviewer: true }, { role: 'member' as const, reviewer: false }]) {
      const html = renderToString(
        <ActionComposer action="accept_claim" text="" onText={noop} availability={actionAvailability(waiting, 'accept_claim', who)} locked={null} onReview={noop} onRequest={noop} disputeAmount={waiting.amount!} />,
      );
      expect(html).toContain('Only the workspace owner can send this action');
      expect(html).toContain('PayPal refunds 7.00 USD to the buyer');
      expect(html).not.toContain('Review the accept');
    }
  });

  it('controller, simulator: the owner confirms the bound terms; a full accept records, a partial one is an offer', async () => {
    const T0 = Date.UTC(2026, 9, 20, 10, 23, 26);
    for (const [req, consequence, title] of [
      [{ action: 'accept_claim', acceptType: 'REFUND', note: 'Refund accepted.', amount: null, attachments: [] }, 'REFUNDS_BUYER', 'claim accepted'],
      [{ action: 'accept_claim', acceptType: 'PARTIAL_REFUND', note: 'Partial.', amount: { value: '2.00', currency: 'USD' }, attachments: [] }, 'OFFERS_PARTIAL_REFUND', 'offer waiting for the buyer'],
    ] as const) {
      const clock = { t: T0 };
      const gateway = new SimulatedDisputeGateway([waiting], { outcome: () => 'waiting_for_buyer', now: () => new Date(clock.t) });
      const audits: string[] = [];
      const f = new ActionFlowController({
        caseId: 'CASE-1',
        request: req as unknown as ActionFlowDeps['request'],
        source: new LocalIntentClient(),
        gateway,
        mode: { kind: 'simulator' },
        onState: () => {},
        audit: (who, what) => audits.push(`${who}: ${what}`),
        applySnapshot: () => {},
        now: () => new Date(clock.t),
      });
      await f.start();
      await f.approve();
      expect(f.state).toMatchObject({ step: 'confirm', terms: { action: 'accept_claim', currency: 'USD', consequence } });
      expect(gateway.sentActions).toEqual([]);
      await f.confirm();
      expect(f.state).toMatchObject({ step: 'result', result: { kind: 'recorded' } });
      const html = view(f.state, { kind: 'simulator' });
      expect(html).toContain(title);
      expect(audits[0]).toMatch(/^ResolveKit: Sending accept_claim to the simulator/);
    }
  });
});
