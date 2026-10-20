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
import { EvidenceTypeSelector } from './EvidenceTypeSelector';
import { evidenceTypeOptions } from '../domain/evidenceTypes';
import { SIM_TRANSITIONS } from '../domain/simulatedActions';
import appSource from '../App.tsx?raw';
import type { AnalysisInput } from '@resolvekit/analyst';
import { HighlightProvider } from '../app/highlight';
import type { AnalysisHandle } from '../app/useAnalysis';
import { useCaseDraft } from '../app/useCaseDraft';
import { goldenAnalyses } from '../fixtures/golden';
import { standardCase } from '../fixtures';
import type { CaseFile } from '../domain/types';
import { ResponseComposer } from './ResponseComposer';

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
    expect(p).toContain('PayPal shows your partial refund offer to the buyer');
    // On the simulator the body names the simulator, never PayPal.
    const ps = view({ step: 'result', intent: partial, result: { kind: 'recorded', detail: 'Recorded by the simulator', snapshot: { ...waiting, status: 'WAITING_FOR_BUYER_RESPONSE' }, base: null } }, { kind: 'simulator' });
    expect(ps).toContain('The simulator shows your partial refund offer to the buyer');
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

describe('escalate: owner only, a note, MOVES_TO_CLAIM, never shown as closed (Task 10)', () => {
  const waiting: DisputeSnapshot = {
    ...snap,
    allowedActions: ['provide_evidence', 'send_message', 'make_offer', 'accept_claim', 'escalate'],
    amount: { value: '7.00', currency: 'USD' },
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    responseOptions: { acceptClaimTypes: ['PARTIAL_REFUND', 'REFUND'], offerTypes: ['REFUND'] },
  };
  const NOTE = 'The parcel was shipped with tracking; we ask PayPal to review.';
  const esc = {
    ...(composeAction({ caseId: 'CASE-1', req: { action: 'escalate', note: NOTE, attachments: [] }, snap: waiting, disputeId: 'PP-R-1', seller: 'S', files: [] }) as object),
    id: 'int-10',
    contentHash: 'e'.repeat(64),
    requestId: 'rk-int-10',
    status: 'approved',
  } as SubmissionIntent;
  const CONSEQUENCE = 'The inquiry becomes a claim decided by PayPal. Inquiry actions end; what you can do next is what PayPal offers on the claim.';

  it('review and confirmation: the note exactly, the consequence and MOVES_TO_CLAIM with no amount', () => {
    const r = view({ step: 'review', intent: esc, repeat: false });
    expect(r).toContain('Review the escalation');
    expect(r).toContain(NOTE);
    expect(r).toContain(CONSEQUENCE);
    const c = view({ step: 'confirm', intent: esc, terms: { intentId: esc.id, contentHash: esc.contentHash, action: 'escalate', amount: null, currency: null, consequence: 'MOVES_TO_CLAIM' } });
    expect(c).toContain('MOVES_TO_CLAIM');
    expect(c).toContain(CONSEQUENCE);
    expect(c).not.toContain('confirm-amount');
  });

  it('recorded while PayPal reviews: said honestly, never closed; the claim once PayPal opens it; pending stays pending', () => {
    const reviewing = { ...waiting, status: 'UNDER_REVIEW' as const, allowedActions: [] };
    const r = view({ step: 'result', intent: esc, result: { kind: 'recorded', detail: 'Recorded by PayPal', snapshot: reviewing, base: null } });
    expect(r).toContain('Recorded by PayPal: inquiry escalated');
    expect(r).toContain('PayPal is reviewing; the claim stage can take a few minutes');
    expect(r).not.toMatch(/dispute (is )?closed|was closed|[Rr]esolved/);
    const claim = { ...waiting, stage: 'CHARGEBACK', allowedActions: ['provide_evidence', 'accept_claim'] as DisputeSnapshot['allowedActions'] };
    expect(view({ step: 'result', intent: esc, result: { kind: 'recorded', detail: 'Recorded by PayPal', snapshot: claim, base: null } })).toContain('The dispute is a claim now (CHARGEBACK)');
    const p = view({ step: 'result', intent: esc, result: { kind: 'pending', detail: 'Outcome pending confirmation', snapshot: claim, base: null } });
    expect(p).toContain('Outcome pending confirmation');
    expect(p).toContain('the escalation recorded or absent');
    expect(p).not.toContain('inquiry escalated');
  });

  it('the composer: the owner writes the note and reviews; a reviewer or member sees the preview only', () => {
    const owner = renderToString(<ActionComposer action="escalate" text="" onText={noop} availability={actionAvailability(waiting, 'escalate', { role: 'owner', reviewer: false })} locked={null} onReview={noop} onRequest={noop} />);
    expect(owner.replace(/<!-- -->/g, '')).toContain('Escalate to a claim · Tested locally');
    expect(owner).toContain('Note to PayPal');
    expect(owner).toContain(CONSEQUENCE);
    expect(owner).toMatch(/<button[^>]*disabled[^>]*>Review the escalation/);
    for (const who of [{ role: 'member' as const, reviewer: true }, { role: 'member' as const, reviewer: false }]) {
      const html = renderToString(<ActionComposer action="escalate" text="" onText={noop} availability={actionAvailability(waiting, 'escalate', who)} locked={null} onReview={noop} onRequest={noop} />);
      expect(html).toContain('Only the workspace owner can send this action');
      expect(html).toContain(CONSEQUENCE);
      expect(html).not.toContain('Review the escalation');
    }
    // Another reason: not verified with PayPal, nothing to write.
    const nad = renderToString(<ActionComposer action="escalate" text="" onText={noop} availability={actionAvailability({ ...waiting, reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' }, 'escalate', { role: 'owner', reviewer: false })} locked={null} onReview={noop} onRequest={noop} />);
    expect(nad.replace(/<!-- -->/g, '')).toContain('Not available: not verified with PayPal for this dispute reason');
    expect(nad).not.toContain('Note to PayPal');
  });

  it('controller, simulator: the owner confirms MOVES_TO_CLAIM; recorded while PayPal reviews', async () => {
    const T0 = Date.UTC(2026, 9, 20, 6, 17, 37);
    const clock = { t: T0 };
    const gateway = new SimulatedDisputeGateway([waiting], { outcome: () => 'waiting_for_buyer', now: () => new Date(clock.t) });
    const f = new ActionFlowController({
      caseId: 'CASE-1',
      request: { action: 'escalate', note: NOTE, attachments: [] },
      source: new LocalIntentClient(),
      gateway,
      mode: { kind: 'simulator' },
      onState: () => {},
      audit: () => {},
      applySnapshot: () => {},
      now: () => new Date(clock.t),
    });
    await f.start();
    await f.approve();
    expect(f.state).toMatchObject({ step: 'confirm', terms: { action: 'escalate', amount: null, currency: null, consequence: 'MOVES_TO_CLAIM' } });
    expect(gateway.sentActions).toEqual([]);
    await f.confirm();
    expect(f.state).toMatchObject({ step: 'result', result: { kind: 'recorded', snapshot: { status: 'UNDER_REVIEW', stage: 'INQUIRY' } } });
    expect(view(f.state, { kind: 'simulator' })).toContain('PayPal is reviewing; the claim stage can take a few minutes');
  });
});

describe('make_offer: owner only, an amount and a note, OFFERS_SETTLEMENT, an offer waiting for the buyer (Task 11)', () => {
  const waiting: DisputeSnapshot = {
    ...snap,
    allowedActions: ['provide_evidence', 'send_message', 'make_offer', 'accept_claim', 'escalate'],
    amount: { value: '7.00', currency: 'USD' },
    allowedRefund: { value: '7.00', currency: 'USD' },
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    offerHistory: [],
    responseOptions: { acceptClaimTypes: ['PARTIAL_REFUND', 'REFUND'], offerTypes: ['REFUND'] },
  };
  const NOTE = 'We offer a partial refund of 2.00 USD.';
  const req = { action: 'make_offer' as const, offerType: 'REFUND', note: NOTE, amount: { value: '2.00', currency: 'USD' }, attachments: [] as [] };
  const mo = {
    ...(composeAction({ caseId: 'CASE-1', req, snap: waiting, disputeId: 'PP-R-1', seller: 'S', files: [] }) as object),
    id: 'int-11',
    contentHash: 'f'.repeat(64),
    requestId: 'rk-int-11',
    status: 'approved',
  } as SubmissionIntent;
  const CONSEQUENCE = 'The buyer is offered 2.00 USD; no money moves unless the buyer accepts.';

  it('review and confirmation: the amount of the dispute amount, the note exactly, OFFERS_SETTLEMENT with the amount', () => {
    const r = view({ step: 'review', intent: mo, repeat: false });
    expect(r).toContain('Review the offer');
    expect(r).toContain('Refund offered to the buyer: 2.00 USD of 7.00 USD');
    expect(r).toContain(NOTE);
    expect(r).toContain(CONSEQUENCE);
    const c = view({ step: 'confirm', intent: mo, terms: { intentId: mo.id, contentHash: mo.contentHash, action: 'make_offer', amount: '2.00', currency: 'USD', consequence: 'OFFERS_SETTLEMENT' } });
    expect(c).toContain('OFFERS_SETTLEMENT');
    expect(c).toContain(CONSEQUENCE);
    expect(c.replace(/<!-- -->/g, '')).toContain('Amount: 2.00 USD');
    // Never worded as a full accept.
    for (const html of [r, c]) expect(html).not.toMatch(/PayPal refunds|closes the dispute|cannot be undone|Full refund/);
  });

  it('recorded: an offer waiting for the buyer, never refunded or closed; pending stays pending', () => {
    const waitingBuyer = { ...waiting, status: 'WAITING_FOR_BUYER_RESPONSE' as const, allowedActions: ['provide_evidence', 'send_message', 'accept_claim', 'escalate'] as DisputeSnapshot['allowedActions'] };
    const r = view({ step: 'result', intent: mo, result: { kind: 'recorded', detail: 'Recorded by PayPal', snapshot: waitingBuyer, base: null } });
    expect(r).toContain('Recorded by PayPal: offer waiting for the buyer');
    expect(r).toContain('PayPal shows your refund offer to the buyer. Unless the buyer accepts it, no money moves and the dispute stays open.');
    expect(r).not.toContain('partial refund offer');
    expect(r).not.toMatch(/claim accepted|[Rr]efunded|dispute (is )?closed|[Rr]esolved/);
    const p = view({ step: 'result', intent: mo, result: { kind: 'pending', detail: 'Outcome pending confirmation', snapshot: waitingBuyer, base: null } });
    expect(p).toContain('Outcome pending confirmation');
    expect(p).toContain('the offer recorded or absent');
    expect(p).not.toContain('offer waiting for the buyer');
  });

  it('the composer: the owner sets the amount and note and reviews; a reviewer or member sees the preview only', () => {
    const owner = renderToString(<ActionComposer action="make_offer" text="" onText={noop} availability={actionAvailability(waiting, 'make_offer', { role: 'owner', reviewer: false })} locked={null} onReview={noop} onRequest={noop} disputeAmount={waiting.amount!} />);
    const flat = owner.replace(/<!-- -->/g, '');
    expect(flat).toContain('Refund offer · Tested locally');
    expect(flat).toContain('Amount offered (USD, below 7.00)');
    expect(owner).toContain('Note to PayPal');
    expect(flat).toContain('The buyer is offered the amount you set; no money moves unless the buyer accepts.');
    expect(owner).toMatch(/<button[^>]*disabled[^>]*>Review the offer/);
    for (const who of [{ role: 'member' as const, reviewer: true }, { role: 'member' as const, reviewer: false }]) {
      const html = renderToString(<ActionComposer action="make_offer" text="" onText={noop} availability={actionAvailability(waiting, 'make_offer', who)} locked={null} onReview={noop} onRequest={noop} disputeAmount={waiting.amount!} />);
      expect(html).toContain('Only the workspace owner can send this action');
      expect(html).not.toContain('Review the offer');
    }
    // A pending offer: the duplicate guard's reason, nothing to write.
    const pending = { ...waiting, offerHistory: [{ time: '2026-10-20T05:57:05.614Z', actor: 'SELLER', event: 'PROPOSED', type: 'REFUND', amount: { value: '2.00', currency: 'USD' } }] };
    const dup = renderToString(<ActionComposer action="make_offer" text="" onText={noop} availability={actionAvailability(pending, 'make_offer', { role: 'owner', reviewer: false })} locked={null} onReview={noop} onRequest={noop} disputeAmount={waiting.amount!} />);
    expect(dup.replace(/<!-- -->/g, '')).toContain('Not available: An offer of yours is pending with the buyer');
    expect(dup).not.toContain('Amount offered');
    // PayPal would refund less than the dispute amount: the label gives that cap.
    const capped = renderToString(<ActionComposer action="make_offer" text="" onText={noop} availability={actionAvailability({ ...waiting, allowedRefund: { value: '5.00', currency: 'USD' } }, 'make_offer', { role: 'owner', reviewer: false })} locked={null} onReview={noop} onRequest={noop} disputeAmount={waiting.amount!} refundable={{ value: '5.00', currency: 'USD' }} />);
    expect(capped.replace(/<!-- -->/g, '')).toContain('Amount offered (USD, at most 5.00, what PayPal would refund)');
    const equal = renderToString(<ActionComposer action="make_offer" text="" onText={noop} availability={actionAvailability(waiting, 'make_offer', { role: 'owner', reviewer: false })} locked={null} onReview={noop} onRequest={noop} disputeAmount={waiting.amount!} refundable={waiting.allowedRefund!} />);
    expect(equal.replace(/<!-- -->/g, '')).toContain('Amount offered (USD, below 7.00)');
  });

  it('controller, simulator: the owner confirms OFFERS_SETTLEMENT with the amount; recorded as an offer waiting for the buyer', async () => {
    const T0 = Date.UTC(2026, 9, 20, 5, 57, 2);
    const clock = { t: T0 };
    const gateway = new SimulatedDisputeGateway([waiting], { outcome: () => 'waiting_for_buyer', now: () => new Date(clock.t) });
    const audits: string[] = [];
    const f = new ActionFlowController({
      caseId: 'CASE-1',
      request: { ...req, amount: { value: '2', currency: 'USD' } },
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
    expect(f.state).toMatchObject({ step: 'confirm', terms: { action: 'make_offer', amount: '2.00', currency: 'USD', consequence: 'OFFERS_SETTLEMENT' } });
    expect(gateway.sentActions).toEqual([]);
    await f.confirm();
    expect(f.state).toMatchObject({ step: 'result', result: { kind: 'recorded', snapshot: { status: 'UNDER_REVIEW' } } });
    const html = view(f.state, { kind: 'simulator' });
    expect(html).toContain('Recorded by the simulator: offer waiting for the buyer');
    expect(html).toContain('The simulator shows your refund offer to the buyer.');
    expect(audits.at(-1)).toBe('Simulator re-read: Make offer · refund offer · recorded');
  });
});

describe('appeal and PROOF_OF_REFUND: a non-sendable preview (Task 12, owner decision 20/10/2026)', () => {
  const APPEAL_REASON = 'Not verified with PayPal: the sandbox could not produce an appealable dispute';
  const REFUND_REASON = 'Not verified with PayPal: pending sandbox test (W-11)';

  it('PayPal offers the appeal link: the owner and anyone else see «Not available: <reason>» and no review or send button', () => {
    const offered: DisputeSnapshot = { ...snap, status: 'RESOLVED', allowedActions: ['appeal'] };
    for (const who of [{ role: 'owner' as const, reviewer: false }, { role: 'member' as const, reviewer: true }, { role: 'member' as const, reviewer: false }]) {
      const a = actionAvailability(offered, 'appeal', who);
      expect(a).toMatchObject({ offered: true, sendable: false, variants: [{ variant: 'appeal', type: null, available: false, why: APPEAL_REASON }] });
      const html = renderToString(<ActionComposer action="appeal" text="" onText={noop} availability={a} locked={null} onReview={noop} onRequest={noop} />);
      expect(html).toContain(`Not available: ${APPEAL_REASON}`);
      expect(html).not.toMatch(/Review|Send|<textarea/);
      expect(html).not.toMatch(/<button/);
    }
  });

  it('the evidence selector shows PROOF_OF_REFUND disabled with its reason when PayPal requests it', () => {
    const o = evidenceTypeOptions('MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'PROOF_OF_REFUND', [
      { type: 'PROOF_OF_FULFILLMENT', label: 'Proof of fulfillment', requirement: 'Carrier and tracking.', satisfied: true },
      { type: 'PROOF_OF_REFUND', label: 'Proof of refund', requirement: 'Refund id found.', satisfied: true },
    ]);
    const html = renderToString(<EvidenceTypeSelector options={o} selected="PROOF_OF_FULFILLMENT" onSelect={noop} requested="PROOF_OF_REFUND" requestedNote="" />);
    const at = html.indexOf('PROOF_OF_REFUND</span></span>');
    const refund = html.slice(html.lastIndexOf('<button', at), html.indexOf('</button>', at));
    expect(refund).toContain('aria-disabled="true"');
    expect(refund).toContain('aria-checked="false"');
    expect(refund).toContain(`Not available: ${REFUND_REASON}`);
    const fulfil = html.slice(html.indexOf('<button'), html.indexOf('</button>'));
    expect(fulfil).toContain('aria-checked="true"');
    expect(fulfil).toContain('aria-disabled="false"');
  });

  it('the Dev control plays no appeal and the simulator has no appeal or PROOF_OF_REFUND transition', () => {
    expect(appSource).not.toMatch(/appeal|adjudicat|rules for the buyer/i);
    expect(Object.keys(SIM_TRANSITIONS)).not.toContain('appeal');
    expect(Object.keys(SIM_TRANSITIONS)).not.toContain('evidence:PROOF_OF_REFUND');
  });
});

describe('PayPal asks only for PROOF_OF_REFUND (Task 12 review)', () => {
  const ONLY = 'PayPal asks only for Proof of refund, which is not available in this delivery: Not verified with PayPal: pending sandbox test (W-11)';
  // A draft that is ready to review: supported sentences only, nothing to resolve.
  const ready: CaseFile = { ...standardCase, contradictions: [], checklist: null, sentences: standardCase.sentences.filter((s) => s.verdict === 'supported') };
  const analysis: AnalysisHandle = {
    state: { kind: 'ready', analysis: goldenAnalyses[standardCase.summary.id]!, origin: 'live', input: { documents: [] } as unknown as AnalysisInput },
    live: null,
    rerunBlocked: null,
    rerunError: null,
    rerun: noop,
    recheck: async () => {
      throw new Error('not used');
    },
  };
  function Harness({ requested }: { requested: string[] }) {
    const d = useCaseDraft(ready, { allowedActions: ['provide_evidence'], submitted: false, requestedEvidence: requested, onAudit: noop, actor: 'x', scope: 'test', analysis });
    return <ResponseComposer c={{ ...ready, requestedEvidenceType: requested.includes('PROOF_OF_FULFILLMENT') ? 'PROOF_OF_FULFILLMENT' : 'PROOF_OF_REFUND' }} d={d} allowedActions={['provide_evidence']} checkedAt={null} submitted={false} onReview={noop} />;
  }
  const html = (requested: string[]) => renderToString(<HighlightProvider><Harness requested={requested} /></HighlightProvider>);
  const types = (h: string) => h.slice(h.indexOf('aria-label="Evidence type to send"'), h.indexOf('</section>', h.indexOf('aria-label="Evidence type to send"')));
  const footerButton = (h: string) => h.slice(h.lastIndexOf('<button'), h.lastIndexOf('</button>'));

  it('the composer says why, preselects no type and keeps Review disabled', () => {
    const h = html(['PROOF_OF_REFUND']);
    expect(h).toContain(ONLY);
    expect(h).toContain(`To continue: ${ONLY}.`);
    expect(types(h)).not.toContain('aria-checked="true"');
    expect(footerButton(h)).toContain('disabled=""');
    expect(footerButton(h)).not.toContain('Review what will be sent');
  });

  it('PROOF_OF_REFUND among other requested types (W-5 claim): the first requested available type is preselected, the note points to the others, Review enabled', () => {
    const h = html(['PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND', 'OTHER']);
    expect(h).not.toContain('PayPal asks only for');
    expect(h).toContain('Proof of refund is not available in this delivery (Not verified with PayPal: pending sandbox test (W-11)). PayPal also asks for Proof of fulfillment or Other: notes and documents: send one of those instead.');
    expect(types(h).slice(0, types(h).indexOf('PROOF_OF_FULFILLMENT</span>'))).toContain('aria-checked="true"');
    expect(types(h)).toContain('aria-checked="true"');
    expect(footerButton(h)).toContain('Review what will be sent');
    expect(footerButton(h)).not.toContain('disabled');
  });
});

describe('a dispute held by another send (IMP2): check again reads THAT send; never «Nothing was sent»', () => {
  const HOLDER = `int-${'h'.repeat(32)}`;
  const fakeFetch = () => {
    const calls: string[] = [];
    const replies: Array<[number, unknown]> = [];
    const fetch = (async (url: string | URL, init: RequestInit = {}) => {
      calls.push(`${init.method ?? 'GET'} ${String(url)}${init.body ? ` ${String(init.body)}` : ''}`);
      const [status, body] = replies.shift() ?? [500, {}];
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    return { calls, replies, fetch };
  };

  const deps = (o: Pick<ActionFlowDeps, 'source' | 'gateway' | 'mode'>) => ({
    d: { caseId: 'CASE-1', request: { action: 'send_message' as const, text: TEXT, attachments: [] }, onState: noop, audit: noop, applySnapshot: noop, ...o } satisfies ActionFlowDeps,
  });

  it('refused DISPUTE_UNCERTAIN → pending about the holder → check again on the holder → settled → send it now', async () => {
    const { calls, replies, fetch } = fakeFetch();
    const live = { ...snap, origin: { kind: 'paypal' as const, env: 'sandbox' as const, disputeId: 'PP-R-1' } };
    replies.push(
      [201, { ...intent, status: 'proposed', repeat: false }],
      [200, { ...intent, confirmation: null }],
      [409, { error: 'DISPUTE_UNCERTAIN', detail: 'The last send to this dispute is not confirmed by PayPal yet', holder: { intentId: HOLDER, caseId: 'CASE-1' } }],
      // Check again: still pending, then recorded.
      [200, { readBack: { state: 'pending', detail: 'Outcome pending confirmation', at: 'a' }, snapshot: live, hold: { intentId: HOLDER } }],
      [200, { readBack: { state: 'recorded', detail: 'Recorded by PayPal', at: 'b' }, snapshot: live, hold: null }],
      // Send it now: sent and read back.
      [202, { sent: true, intent }],
      [200, { readBack: { state: 'recorded', detail: 'Recorded by PayPal', at: 'c' }, snapshot: live }],
    );
    const t = deps({ source: new HttpIntentClient({ fetch }), gateway: new HttpDisputeGateway({ fetch }), mode: paypal });
    const f = new ActionFlowController(t.d);
    await f.start();
    await f.approve();
    expect(f.state).toMatchObject({ step: 'result', result: { kind: 'pending', holder: { id: HOLDER, caseId: 'CASE-1' } } });
    // The view: about the earlier send, never «Nothing was sent to PayPal».
    const pendingHtml = view(f.state);
    expect(pendingHtml).toContain('An earlier send on this dispute');
    expect(pendingHtml).toContain('Check again');
    expect(pendingHtml).not.toContain('Nothing was sent to PayPal');
    await f.checkAgain();
    expect(calls[3]).toBe(`POST /api/disputes/CASE-1/intent/${HOLDER}/readback {}`);
    expect(f.state).toMatchObject({ step: 'result', result: { kind: 'pending', holder: { id: HOLDER } } });
    await f.checkAgain();
    expect(calls[4]).toBe(`POST /api/disputes/CASE-1/intent/${HOLDER}/readback {}`);
    expect(f.state).toMatchObject({ step: 'result', result: { kind: 'not_sent', refusal: { code: 'HOLDER_SETTLED' } } });
    const settled = renderToString(
      <ActionFlowView state={f.state} mode={paypal} caseId="CASE-1" busy={false} onApprove={noop} onConfirm={noop} onCheckAgain={noop} onSendAnyway={noop} onSendNow={noop} onEdit={noop} onClose={noop} />,
    );
    expect(settled).toContain('The earlier send on this dispute is settled (PayPal recorded it)');
    expect(settled).toContain('Send it now');
    expect(settled).not.toContain('Nothing was sent to PayPal');
    // The person's own intent was never read back as «not sent»: no call to its read-back before it was sent.
    expect(calls.filter((c) => c.includes(`/intent/${intent.id}/readback`))).toEqual([]);
    await f.sendNow();
    expect(calls[5]).toBe('POST /api/disputes/CASE-1/send {"intentId":"int-1"}');
    expect(f.state).toMatchObject({ step: 'result', result: { kind: 'recorded' } });
  });
});
