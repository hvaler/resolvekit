/**
 * The evidence flow on a held dispute: the server refuses the evidence send with 409 DISPUTE_UNCERTAIN naming the
 * holder; the flow shows the held-send notice inline with «Check again» on THAT send (a read-back, never a send), and
 * offers «Send it now» once the holder settles. The evidence send then goes through its full server checks again,
 * against a fresh read: what the holder recorded is never taken as ours.
 */
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { heldRefreshKey, sendAfterHold, submitWithReadBack, type SendResult } from '../domain/gateway';
import { HttpDisputeGateway } from '../domain/httpGateway';
import { HttpIntentClient, type DisputeHoldView } from '../domain/intentClient';
import type { DisputeSnapshot, EvidenceSubmission, RecordedEvidence } from '../domain/types';
import { HeldEvidence, checkHeldSend, lookupHold } from './HeldSend';

const HOLDER = `int-${'h'.repeat(32)}`;
const hold: DisputeHoldView = { disputeId: 'PP-R-1', intentId: HOLDER, caseId: 'CASE-1', since: '2026-10-20T05:07:17.000Z', state: 'uncertain', action: 'provide_evidence', intentKnown: true, own: false };
const submission: EvidenceSubmission = {
  disputeId: 'CASE-1',
  action: 'provide_evidence',
  evidenceType: 'PROOF_OF_FULFILLMENT',
  carrier: 'UPS',
  tracking: '1Z999AA10123456784',
  notes: 'Delivered on 8 Oct 2026.',
  files: [{ name: 'E1-order.pdf', size: '12 KB', source: 'demo' }],
  intentId: 'int-mine',
};
const before: DisputeSnapshot = { id: 'CASE-1', status: 'WAITING_FOR_SELLER_RESPONSE', stage: 'INQUIRY', allowedActions: ['provide_evidence', 'send_message'], evidences: [], readAt: 'a' };
const entry = (over: Partial<RecordedEvidence> = {}): RecordedEvidence => ({
  evidenceType: submission.evidenceType,
  source: 'SUBMITTED_BY_SELLER',
  action: 'PROVIDE_EVIDENCE',
  stage: 'INQUIRY',
  date: '2026-10-20T05:07:30.000Z',
  carrier: submission.carrier,
  tracking: submission.tracking,
  notes: submission.notes,
  files: submission.files.map((f) => f.name),
  storedAt: '20 Oct 05:07',
  ...over,
});
const withEvidence = (e: RecordedEvidence): DisputeSnapshot => ({ ...before, status: 'UNDER_REVIEW', allowedActions: [], evidences: [e], readAt: 'b' });
const uncertain = [409, { error: 'DISPUTE_UNCERTAIN', detail: 'The last send to this dispute is not confirmed by PayPal yet; check it again before anything else is sent', holder: { intentId: HOLDER, caseId: 'CASE-1' } }] as [number, unknown];

function server(replies: Array<[number, unknown]>) {
  const calls: string[] = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push(`${init.method ?? 'GET'} ${String(url)}${init.body ? ` ${String(init.body)}` : ''}`);
    const [status, body] = replies.shift() ?? [500, {}];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { calls, gateway: new HttpDisputeGateway({ fetch }), intents: new HttpIntentClient({ fetch }) };
}
const noop = () => {};
const held = (o: { hold: DisputeHoldView | null; known: boolean; message?: string | null; error?: string | null; earlier?: boolean }) =>
  renderToString(<HeldEvidence holderId={HOLDER} hold={o.hold} known={o.known} message={o.message ?? null} error={o.error ?? null} busy={false} onCheck={noop} onSendNow={noop} onRetry={noop} earlierAttempt={o.earlier ?? false} />);

describe('the evidence send on a held dispute', () => {
  it('409 DISPUTE_UNCERTAIN: held, naming the holder; evidence PayPal shows meanwhile is never taken as ours', async () => {
    // The holder (a colleague's evidence send) shows up on the read after the refusal: identical content, still not ours.
    const { calls, gateway } = server([uncertain, [200, withEvidence(entry())]]);
    const r = await submitWithReadBack(gateway, submission, { requestId: 'rk-int-mine', baseline: before });
    expect(r).toMatchObject({ kind: 'not_recorded', held: { id: HOLDER, caseId: 'CASE-1' } });
    expect(calls.map((c) => c.split(' ').slice(0, 2).join(' '))).toEqual(['POST /api/disputes/CASE-1/evidence', 'GET /api/disputes/CASE-1']);
  });

  it('the notice: inline, about the earlier send, with «Check again» on it; no «Send it now» while it holds', () => {
    const html = held({ hold, known: true });
    expect(html).toContain('Your evidence was not sent');
    expect(html).toContain('Outcome pending confirmation');
    expect(html).toContain('Check again');
    expect(html).toContain(HOLDER.slice(0, 12));
    expect(html).not.toContain('Send it now');
    // Before the server said what holds it: no «Send it now» either.
    expect(held({ hold: null, known: false })).not.toContain('Send it now');
  });

  it('holder recorded → «Send it now» → the evidence is still refused when PayPal now has seller evidence', async () => {
    const theirs = withEvidence(entry({ notes: 'A colleague’s evidence.' }));
    const { calls, gateway, intents } = server([
      // Check again: a read-back of THAT send only.
      [200, { readBack: { state: 'recorded', detail: 'Recorded by PayPal', at: 'b' }, snapshot: theirs, hold: null }],
      // Send it now: a fresh read first, then the full send, which the server refuses; then the read-back.
      [200, theirs],
      [409, { error: 'SELLER_EVIDENCE_EXISTS', detail: 'PayPal already has seller evidence for this dispute; nothing more can be sent' }],
      [200, theirs],
    ]);
    const check = await checkHeldSend(intents, hold);
    expect(calls[0]).toBe(`POST /api/disputes/CASE-1/intent/${HOLDER}/readback {}`);
    expect(check.hold).toBeNull();
    const html = held({ hold: check.hold, known: true, message: check.message });
    expect(html).toContain('Recorded by PayPal: the earlier send is proven');
    expect(html).toContain('Send it now');
    const r = await sendAfterHold(gateway, submission, { requestId: 'rk-int-mine' });
    expect(calls.slice(1).map((c) => c.split(' ').slice(0, 2).join(' '))).toEqual(['GET /api/disputes/CASE-1', 'POST /api/disputes/CASE-1/evidence', 'GET /api/disputes/CASE-1']);
    // The colleague's evidence was there before this send: never «recorded» or a mismatch of ours.
    expect(r.kind).toBe('not_recorded');
    expect(r.kind === 'not_recorded' && r.error).toContain('PayPal already has seller evidence');
  });

  it('holder absent (or no longer held) → «Send it now» → sent with every check → recorded from the read-back', async () => {
    const { gateway, intents } = server([
      [200, { readBack: { state: 'absent', detail: 'PayPal shows no trace of this send and still offers the action', at: 'c' }, snapshot: before, hold: null }],
      [200, before],
      [202, { sent: true }],
      [200, withEvidence(entry())],
    ]);
    const check = await checkHeldSend(intents, hold);
    expect(check.hold).toBeNull();
    expect(held({ hold: check.hold, known: true, message: check.message })).toContain('Send it now');
    const r = await sendAfterHold(gateway, submission, { requestId: 'rk-int-mine' });
    expect(r.kind).toBe('recorded');
    // Nothing holds it any more when the page asks: «Send it now» at once.
    expect(held({ hold: null, known: true })).toContain('Send it now');
  });

  it('still pending: still held, no «Send it now»', async () => {
    const { intents } = server([[200, { readBack: { state: 'pending', detail: 'Outcome pending confirmation', at: 'a' }, snapshot: before, hold }]]);
    const check = await checkHeldSend(intents, hold);
    expect(check.hold).toEqual(hold);
    expect(held({ hold: check.hold, known: true, message: check.message })).not.toContain('Send it now');
  });
});

describe('the hold lookup fails', () => {
  it('says so plainly with «Try again», which repeats the lookup only (never a send); then the hold is known', async () => {
    const { calls, intents } = server([
      [502, { error: 'PAYPAL_UNREACHABLE', detail: 'The ResolveKit server could not answer' }],
      [200, { hold }],
    ]);
    const first = await lookupHold(intents, 'CASE-1');
    expect(first.known).toBe(false);
    expect(first.error).toBeTruthy();
    const html = held({ hold: null, known: false, error: first.error });
    expect(html).toContain('What holds this dispute could not be read');
    expect(html).toContain(first.error!);
    expect(html).toContain('Try again');
    expect(html).not.toContain('Asking the ResolveKit server');
    expect(html).not.toContain('Send it now');
    // «Try again»: the same lookup, a GET; nothing is sent or read back.
    const again = await lookupHold(intents, 'CASE-1');
    expect(again).toEqual({ known: true, hold, error: null });
    expect(calls).toEqual(['GET /api/disputes/CASE-1/hold', 'GET /api/disputes/CASE-1/hold']);
    expect(held({ hold: again.hold, known: true })).toContain('Check again');
  });
});

describe('a retry that is held back (an earlier attempt may have reached PayPal)', () => {
  it('409 DISPUTE_UNCERTAIN on a retry: the original baseline decides; a matching entry is recorded as ours', async () => {
    const { gateway } = server([uncertain, [200, withEvidence(entry())]]);
    const r = await submitWithReadBack(gateway, submission, { requestId: 'rk-int-mine', baseline: before, mayHaveReached: true });
    expect(r.kind).toBe('recorded');
  });

  it('a retry held back with nothing new: still held, and the copy says this attempt was held back', async () => {
    const { gateway } = server([uncertain, [200, before]]);
    const r = await submitWithReadBack(gateway, submission, { requestId: 'rk-int-mine', baseline: before, mayHaveReached: true });
    expect(r).toMatchObject({ kind: 'not_recorded', held: { id: HOLDER } });
    const html = held({ hold, known: true, earlier: true });
    expect(html).toContain('This attempt was held back');
    expect(html).not.toContain('none of it reached PayPal');
    // A first attempt keeps its words.
    expect(held({ hold, known: true })).toContain('none of it reached PayPal');
  });

  it('the hold lookup runs again on every held result, the same holder included', () => {
    const heldResult = { kind: 'not_recorded', snapshot: before, error: 'x', baseline: before, held: { id: HOLDER, caseId: 'CASE-1' } } as SendResult;
    const other = { kind: 'not_recorded', snapshot: before, error: 'x', baseline: before } as SendResult;
    expect(heldRefreshKey(0, heldResult)).toBe(1);
    expect(heldRefreshKey(1, heldResult)).toBe(2);
    expect(heldRefreshKey(2, other)).toBe(2);
    expect(heldRefreshKey(2, null)).toBe(2);
  });
});
