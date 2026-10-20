import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { actionAvailability, composeAction } from '../domain/actions';
import type { SubmissionIntent } from '../domain/intent';
import type { DisputeSnapshot } from '../domain/types';
import { ActionComposer } from './ActionComposer';
import { ActionFlowView, type ActionFlowState } from './ActionFlow';
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
