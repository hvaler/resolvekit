/**
 * A message with one confirmed upload (send_message:file, W-3, Tested locally): the composer offers the case's
 * confirmed uploads only, one at most; the review and the confirmation show the file; the request carries its upload
 * id; the simulator plays it only from WAITING_FOR_BUYER_RESPONSE (W-3's starting state) and says why elsewhere. The
 * text-only message is unchanged.
 */
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { actionAvailability, composeAction } from '../domain/actions';
import { SimulatedDisputeGateway } from '../domain/gateway';
import { HttpDisputeGateway } from '../domain/httpGateway';
import type { SubmissionIntent } from '../domain/intent';
import { HttpIntentClient, IntentError, LocalIntentClient } from '../domain/intentClient';
import { onSimulator, onSimulatorFile } from '../domain/simulatedActions';
import type { DisputeSnapshot } from '../domain/types';
import { simulatedUploadFile, type UploadRecordView } from '../domain/uploads';
import { ActionComposer, messageRequest } from './ActionComposer';
import { ActionFlowController, ActionFlowView, type ActionFlowState } from './ActionFlow';

const TEXT = 'The tracking is attached.';
const upl = (n: number) => `upl-${String(n).padStart(24, '0')}`;
const doc = (id: string) => ({ id, title: id, type: 'Merchant upload · pasted text', source: 'Merchant upload', tag: 'UPL', lines: [] });
const confirmed = (n: number, name: string, over: Partial<UploadRecordView> = {}): UploadRecordView => ({
  id: upl(n),
  kind: 'text',
  name,
  uploadedBy: { id: 'p1', label: 'Ana (member)', name: 'Ana Lopez' },
  status: 'confirmed',
  createdAt: '2026-10-20T08:00:00.000Z',
  expiresAt: '2026-11-20T08:00:00.000Z',
  evidenceId: `E${n}`,
  sha256: 'a'.repeat(64),
  size: 2048,
  mime: 'application/pdf',
  confirmedAt: '2026-10-20T08:05:00.000Z',
  document: doc(`E${n}`),
  ...over,
});
const E7 = confirmed(7, 'tracking.txt');
const E8 = confirmed(8, 'buyer email.txt');
const PENDING: UploadRecordView = { ...confirmed(9, 'draft-not-confirmed.txt'), status: 'reviewing', evidenceId: null, document: null };
const UPLOADS = [E8, PENDING, E7];

const waitingSeller: DisputeSnapshot = { id: 'CASE-1', status: 'WAITING_FOR_SELLER_RESPONSE', stage: 'INQUIRY', allowedActions: ['provide_evidence', 'send_message'], evidences: [], readAt: '', messages: [] };
const waitingBuyer: DisputeSnapshot = { ...waitingSeller, status: 'WAITING_FOR_BUYER_RESPONSE', allowedActions: ['provide_evidence', 'send_message', 'accept_claim', 'escalate'] };
const member = { role: 'member' as const, reviewer: false };
const noop = () => {};
const paypal = { kind: 'paypal' as const, env: 'sandbox' as const };
const composer = (o: { uploads?: readonly UploadRecordView[] | null; attachment?: string | null; snap?: DisputeSnapshot; text?: string; simulator?: boolean } = {}) => {
  const snap = o.snap ?? waitingSeller;
  const offered = actionAvailability(snap, 'send_message', member);
  const a = o.simulator ? onSimulatorFile(onSimulator(offered, snap), snap) : offered;
  return renderToString(
    <ActionComposer action="send_message" text={o.text ?? TEXT} onText={noop} availability={a} locked={null} onReview={noop} uploads={o.uploads} attachment={o.attachment ?? null} onAttachment={noop} />,
  );
};
const radios = (html: string) => html.match(/<input[^>]*type="radio"[^>]*name="message-file"[^>]*>/g) ?? [];

/** A message intent with one upload, as the server composes it (named by evidence id and kind). */
const withFile = {
  ...(composeAction({ caseId: 'CASE-1', req: { action: 'send_message', text: TEXT, attachments: [E8.id] }, snap: waitingSeller, disputeId: 'PP-R-1', seller: 'S', files: [{ name: 'E8-pasted.pdf', size: '2 KB', sha256: 'a'.repeat(64), source: 'upload' }] }) as object),
  id: 'int-1',
  contentHash: 'c'.repeat(64),
  requestId: 'rk-int-1',
  status: 'approved',
} as SubmissionIntent;
const flowView = (state: ActionFlowState) =>
  renderToString(<ActionFlowView state={state} mode={paypal} caseId="CASE-1" busy={false} onApprove={noop} onConfirm={noop} onCheckAgain={noop} onSendAnyway={noop} onEdit={noop} onClose={noop} uploads={UPLOADS} />);

describe('the composer: one confirmed upload of the case, at most', () => {
  it('offers the confirmed uploads only, by evidence number and title, with the variant label as the registry gives it', () => {
    const html = composer({ uploads: UPLOADS });
    expect(html).toContain('Message with a file · Tested locally');
    expect(html).toContain('E7');
    expect(html).toContain('tracking.txt');
    expect(html).toContain('E8');
    expect(html).toContain('buyer email.txt');
    // Not confirmed: never offered.
    expect(html).not.toContain('draft-not-confirmed.txt');
    // E7 before E8 (evidence order), and «No file» first: one radio group, so at most one file.
    expect(html.indexOf('tracking.txt')).toBeLessThan(html.indexOf('buyer email.txt'));
    expect(radios(html)).toHaveLength(3);
    expect(radios(html).filter((r) => r.includes('checked'))).toHaveLength(1);
    expect(radios(html).find((r) => r.includes('checked'))).toContain('value=""');
  });

  it('the chosen upload is the only one ticked', () => {
    const html = composer({ uploads: UPLOADS, attachment: E8.id });
    const ticked = radios(html).filter((r) => r.includes('checked'));
    expect(ticked).toHaveLength(1);
    expect(ticked[0]).toContain(`value="${E8.id}"`);
  });

  it('no confirmed upload: says so (no upload UI here); no server: «Not available» with the reason', () => {
    const none = composer({ uploads: [PENDING] });
    expect(none).toContain('Message with a file · Tested locally');
    expect(none).toContain('No confirmed upload of this case to attach');
    expect(radios(none)).toHaveLength(0);
    const demo = composer({ uploads: null });
    expect(demo).toContain('Message with a file · Not available: attaching a file needs the ResolveKit server');
    expect(radios(demo)).toHaveLength(0);
  });

  it('the request carries the chosen upload id, only while it is a confirmed upload of the case; text only: none', () => {
    expect(messageRequest(TEXT, E8.id, UPLOADS)).toEqual({ action: 'send_message', text: TEXT, attachments: [E8.id] });
    expect(messageRequest(TEXT, null, UPLOADS)).toEqual({ action: 'send_message', text: TEXT, attachments: [] });
    // Deleted, or no longer confirmed, since it was chosen: not sent.
    expect(messageRequest(TEXT, PENDING.id, UPLOADS)).toEqual({ action: 'send_message', text: TEXT, attachments: [] });
    expect(messageRequest(TEXT, upl(42), UPLOADS)).toEqual({ action: 'send_message', text: TEXT, attachments: [] });
  });

  it('the text-only message is unchanged: same counter, label and review button', () => {
    const html = composer({ uploads: UPLOADS });
    expect(html).toContain(`${TEXT.length} / 2,000`);
    expect(html).toContain('Message · Verified in sandbox');
    expect(html).toContain('Review the message');
  });
});

describe('the review and the confirmation show the file', () => {
  it('review: the message, then the file as PayPal receives it and which upload it is', () => {
    const html = flowView({ step: 'review', intent: withFile, repeat: false });
    expect(html).toContain(TEXT);
    expect(html).toContain('E8-pasted.pdf');
    expect(html).toContain('buyer email.txt');
    expect(html).toContain('2 KB');
  });

  it('confirmation (a repeat): the file too; a text-only message shows none', () => {
    const terms = { intentId: 'int-1', contentHash: 'c'.repeat(64), action: 'send_message' as const, amount: null, currency: null, consequence: 'REPEATS_MESSAGE' };
    expect(flowView({ step: 'confirm', intent: withFile, terms })).toContain('E8-pasted.pdf');
    const plain = { ...withFile, files: [] } as SubmissionIntent;
    expect(flowView({ step: 'review', intent: plain, repeat: false })).not.toContain('Attached file');
  });

  it('recorded: says the read-back matched the text, not the file', () => {
    const html = flowView({ step: 'result', intent: withFile, result: { kind: 'recorded', detail: 'Recorded by PayPal', snapshot: waitingBuyer, base: null } });
    expect(html).toContain('Recorded by PayPal');
    expect(html).toContain('the file itself is not checked');
  });
});

describe('the request on its way', () => {
  it('real PayPal: the compose request carries the attachment id (the server composes and checks the file)', async () => {
    const calls: string[] = [];
    const fetch = (async (url: string | URL, init: RequestInit = {}) => {
      calls.push(`${init.method ?? 'GET'} ${String(url)}${init.body ? ` ${String(init.body)}` : ''}`);
      return new Response(JSON.stringify({ ...withFile, status: 'proposed', repeat: false }), { status: 201, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    const f = new ActionFlowController({ caseId: 'CASE-1', request: messageRequest(TEXT, E8.id, UPLOADS), onState: noop, audit: noop, applySnapshot: noop, source: new HttpIntentClient({ fetch }), gateway: new HttpDisputeGateway({ fetch }), mode: paypal });
    await f.start();
    expect(calls[0]).toBe(`POST /api/disputes/CASE-1/intent ${JSON.stringify({ action: 'send_message', text: TEXT, attachments: [E8.id] })}`);
    expect(f.state).toMatchObject({ step: 'review' });
  });

  it('the simulator plays it from WAITING_FOR_BUYER_RESPONSE (W-3): recorded, with the one document', async () => {
    const T0 = Date.UTC(2026, 9, 20, 8, 0, 0);
    const gateway = new SimulatedDisputeGateway([waitingBuyer], { outcome: () => 'waiting_for_buyer', now: () => new Date(T0) });
    const f = new ActionFlowController({
      caseId: 'CASE-1',
      request: messageRequest(TEXT, E8.id, UPLOADS),
      files: [simulatedUploadFile(E8)],
      onState: noop,
      audit: noop,
      applySnapshot: noop,
      source: new LocalIntentClient(),
      gateway,
      mode: { kind: 'simulator' },
      now: () => new Date(T0),
    });
    await f.start();
    expect(f.state).toMatchObject({ step: 'review', intent: { files: [{ name: 'E8-pasted.pdf', size: '2 KB', source: 'upload' }] } });
    await f.approve();
    expect(f.state).toMatchObject({ step: 'result', result: { kind: 'recorded' } });
    const after = await gateway.getDispute('CASE-1');
    expect(after.messages?.at(-1)).toMatchObject({ postedBy: 'SELLER', content: TEXT });
    expect(gateway.sentActions).toHaveLength(1);
  });

  it('the simulator elsewhere: «Not available» with its reason in the composer; the file is not composed', async () => {
    const html = composer({ uploads: UPLOADS, snap: waitingSeller, simulator: true });
    expect(html).toContain('Message with a file · Not available: the simulator plays this only from a state PayPal’s sandbox recorded it from');
    expect(radios(html)).toHaveLength(0);
    // The text-only message is still offered there (W-1).
    expect(html).toContain('Review the message');
    // And a file without its upload's details is never composed in the browser.
    await expect(new LocalIntentClient().createAction('CASE-1', messageRequest(TEXT, E8.id, UPLOADS), { snapshot: waitingBuyer })).rejects.toBeInstanceOf(IntentError);
  });
});
