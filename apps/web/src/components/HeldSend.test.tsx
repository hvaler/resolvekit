import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HttpIntentClient, LocalIntentClient, type DisputeHoldView } from '../domain/intentClient';
import type { DisputeSnapshot } from '../domain/types';
import { HeldSendNotice, checkHeldSend } from './HeldSend';

const HOLDER = `int-${'a'.repeat(32)}`;
const hold: DisputeHoldView = { disputeId: 'PP-R-1', intentId: HOLDER, caseId: 'CASE-1', since: '2026-10-20T05:07:17.000Z', state: 'uncertain', action: 'send_message', intentKnown: true, own: false };
const snap: DisputeSnapshot = { id: 'CASE-1', status: 'WAITING_FOR_BUYER_RESPONSE', stage: 'INQUIRY', allowedActions: ['send_message'], evidences: [], readAt: '' };

function server(replies: Array<[number, unknown]>) {
  const calls: string[] = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push(`${init.method ?? 'GET'} ${String(url)}${init.body ? ` ${String(init.body)}` : ''}`);
    const [status, body] = replies.shift() ?? [500, {}];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { calls, intents: new HttpIntentClient({ fetch }) };
}

describe('a held send after a reload (IMP2)', () => {
  it('tab reload with a pending hold → the hold route names it → check again on the holder → recorded releases it', async () => {
    const { calls, intents } = server([
      [200, { hold }],
      [200, { readBack: { state: 'pending', detail: 'Outcome pending confirmation', at: 'a' }, snapshot: snap, hold }],
      [200, { readBack: { state: 'recorded', detail: 'Recorded by PayPal', at: 'b' }, snapshot: snap, hold: null }],
    ]);
    // The reloaded page has no memory of the send: it asks the server.
    const found = await intents.hold('CASE-1');
    expect(found).toEqual(hold);
    expect(calls[0]).toBe('GET /api/disputes/CASE-1/hold');
    const html = renderToString(<HeldSendNotice hold={found} message={null} busy={false} onCheck={() => {}} />);
    expect(html).toContain('Outcome pending confirmation');
    expect(html).toContain('An earlier send by someone in your workspace (send message)');
    expect(html).toContain('Check again');
    expect(html).not.toContain('Nothing was sent');
    // Check again: a read-back of THAT send (a POST that only reads PayPal). Still pending: still held.
    const one = await checkHeldSend(intents, found!);
    expect(calls[1]).toBe(`POST /api/disputes/CASE-1/intent/${HOLDER}/readback {}`);
    expect(one.hold).toEqual(hold);
    // Recorded: the dispute is free.
    const two = await checkHeldSend(intents, found!);
    expect(two).toMatchObject({ hold: null, snapshot: snap });
    expect(two.message).toMatch(/^Recorded by PayPal/);
    expect(renderToString(<HeldSendNotice hold={two.hold} message={two.message} busy={false} onCheck={() => {}} />)).toContain('the dispute is free again');
    expect(calls).toHaveLength(3);
  });

  it('proven absent releases it too (nothing resent); a failed read keeps it held', async () => {
    const { intents } = server([
      [502, { error: 'PAYPAL_UNREACHABLE' }],
      [200, { readBack: { state: 'absent', detail: 'PayPal shows no trace of this send and still offers the action', at: 'c' }, snapshot: snap, hold: null }],
    ]);
    const failed = await checkHeldSend(intents, hold);
    expect(failed.hold).toEqual(hold);
    expect(failed.message).toMatch(/^Outcome pending confirmation/);
    const absent = await checkHeldSend(intents, hold);
    expect(absent.hold).toBeNull();
    expect(absent.message).toContain('Nothing was resent');
  });

  it('a hold whose intent is gone says the operator resolves it; a send in flight offers no check; no server: no hold', async () => {
    const gone = renderToString(<HeldSendNotice hold={{ ...hold, intentKnown: false, own: true }} message={null} busy={false} onCheck={() => {}} />);
    expect(gone).toContain('Your earlier send');
    expect(gone).toContain('operations runbook');
    const flying = renderToString(<HeldSendNotice hold={{ ...hold, state: 'in_flight' }} message={null} busy={false} onCheck={() => {}} />);
    expect(flying).toContain('being sent to PayPal right now');
    expect(flying).not.toContain('Check again');
    expect(await new LocalIntentClient().hold()).toBeNull();
    expect(renderToString(<HeldSendNotice hold={null} message={null} busy={false} onCheck={() => {}} />)).toBe('');
  });
});
