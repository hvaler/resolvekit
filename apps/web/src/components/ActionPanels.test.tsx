/**
 * Regression (hosted, real PayPal sandbox, 31/10/2026): after a recorded offer the dispute's documents change (its
 * status), so a new analysis loads and the draft resets its selection to Provide evidence while the flow's result is
 * still open. The flow was drawn only while its request matched the selection, so it vanished with its request still
 * set; the composer then never opened again (no Close could clear the invisible request) until a reload.
 * The flow is drawn for as long as its request exists; closing it always clears it; a card then opens its dialog.
 */
import { describe, expect, it } from 'vitest';
import { actionPanels, afterFlowClosed, type OtherAction } from '../domain/actionDrafts';
import { composeAction, type ActionRequest } from '../domain/actions';
import { HttpDisputeGateway } from '../domain/httpGateway';
import type { SubmissionIntent } from '../domain/intent';
import { HttpIntentClient } from '../domain/intentClient';
import type { DisputeSnapshot } from '../domain/types';
import { ActionFlowController } from './ActionFlow';

const TEXT = 'We sent a partial refund offer.';
const before: DisputeSnapshot = {
  id: 'PP-R-STL-10190667',
  status: 'WAITING_FOR_SELLER_RESPONSE',
  stage: 'INQUIRY',
  allowedActions: ['provide_evidence', 'send_message', 'make_offer', 'accept_claim', 'escalate'],
  evidences: [],
  readAt: '',
  messages: [],
  origin: { kind: 'paypal', env: 'sandbox', disputeId: 'PP-R-1' },
};
const after: DisputeSnapshot = { ...before, status: 'WAITING_FOR_BUYER_RESPONSE', allowedActions: ['send_message', 'accept_claim', 'escalate'], messages: [{ postedBy: 'SELLER', time: '2026-10-31T10:00:00.000Z', content: TEXT, files: [] }] };
const request: ActionRequest = { action: 'send_message', text: TEXT, attachments: [] };
const intent = {
  ...(composeAction({ caseId: 'PP-R-STL-10190667', req: request, snap: before, disputeId: 'PP-R-1', seller: 'S', files: [] }) as object),
  id: 'int-1',
  contentHash: 'c'.repeat(64),
  requestId: 'rk-int-1',
  status: 'approved',
} as SubmissionIntent;

/** The server's intents and dispute routes, faked: compose, approve, send, read back «recorded». */
async function recordedOnLivePayPal(): Promise<{ recorded: number }> {
  const replies: Array<[number, unknown]> = [
    [201, { ...intent, status: 'proposed', repeat: false }],
    [200, { ...intent, confirmation: null }],
    [202, { sent: true, intent }],
    [200, { readBack: { state: 'recorded', detail: 'Recorded by PayPal', at: 'a' }, snapshot: after }],
  ];
  const fetch = (async () => {
    const [status, body] = replies.shift() ?? [500, {}];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  let recorded = 0;
  const f = new ActionFlowController({
    caseId: 'PP-R-STL-10190667',
    request,
    source: new HttpIntentClient({ fetch }),
    gateway: new HttpDisputeGateway({ fetch }),
    mode: { kind: 'paypal', env: 'sandbox' },
    onState: () => {},
    audit: () => {},
    applySnapshot: () => {},
    onRecorded: () => void (recorded += 1),
  });
  await f.start();
  await f.approve();
  expect(f.state).toMatchObject({ step: 'result', result: { kind: 'recorded' } });
  return { recorded };
}

describe('after a send on real PayPal, the action dialogs never lock up', () => {
  it('the selection resets while the result is open: the flow stays on screen until closed; then a card opens its dialog', async () => {
    const { recorded } = await recordedOnLivePayPal();
    expect(recorded).toBe(1);
    // The new analysis resets the draft's selection to Provide evidence while the result is still open.
    let s: { composerOpen: boolean; otherAction: OtherAction | null; request: ActionRequest | null } = { composerOpen: true, otherAction: null, request };
    expect(actionPanels(s)).toEqual({ flow: true, composer: false });
    // Close: the request always goes; after a recorded send the composer closes too.
    s = { ...s, request: null, composerOpen: !afterFlowClosed(recorded > 0).closeComposer };
    expect(actionPanels(s)).toEqual({ flow: false, composer: false });
    // The next card opens its dialog.
    s = { ...s, composerOpen: true, otherAction: 'send_message' };
    expect(actionPanels(s)).toEqual({ flow: false, composer: true });
  });

  it('a request is never invisible: whatever the selection, either its flow is on screen or there is none', () => {
    for (const otherAction of [null, 'send_message', 'make_offer', 'escalate'] as const) {
      for (const composerOpen of [true, false]) {
        const p = actionPanels({ composerOpen, otherAction, request: { action: 'make_offer' } });
        expect(p).toEqual({ flow: true, composer: false });
      }
    }
  });
});
