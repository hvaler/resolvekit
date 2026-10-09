import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HighlightProvider } from '../app/highlight';
import { EvidenceCard } from '../components/EvidenceCard';
import { agentCase, standardCase } from '../fixtures';
import { withMeterMcp } from './agentSession';
import type { PayPalSource } from './paypalView';
import { buildSubmission } from './submission';
import type { DisputeSnapshot, MeteredSession, SentenceView } from './types';

const SID = 'mm-sess-0123456789abcdef0123456789abcdef';

function session(over: Partial<MeteredSession> = {}): MeteredSession {
  const call = (n: number, tool: string, price: string, status: 'OK' | 'FAILED', time: string) => ({ n, time, tool, price, status, requestHash: `${n}`.repeat(64) });
  return {
    sessionId: SID,
    currency: 'USD',
    receiptSha256: 'ab'.repeat(32),
    mandate: { cap: '5.00', orderId: 'ORDER1', authorizationId: 'AUTH1', authorizationStatus: 'CAPTURED', approvedAt: '2026-10-10T11:02:03.000Z', authorizedAt: '2026-10-10T11:02:03Z' },
    calls: [
      call(1, 'quote_lookup', '0.05', 'OK', '2026-10-10T11:03:00.000Z'),
      call(2, 'deep_report', '0.40', 'FAILED', '2026-10-10T11:04:05.000Z'),
      call(3, 'deep_report', '0.40', 'OK', '2026-10-10T11:04:30.000Z'),
      call(4, 'bulk_export', '0.92', 'OK', '2026-10-10T11:05:00.000Z'),
    ],
    totals: { calls: 4, ok: 3, failed: 1, charged: '1.37', cap: '5.00' },
    settlement: { status: 'captured', captureId: 'CAPREAL1', captureStatus: 'COMPLETED', captured: '1.37', released: '3.63', remainderReleased: true, settledAt: '2026-10-10T11:06:00.000Z' },
    ...over,
  };
}

function snap(agentReceipt: DisputeSnapshot['agentReceipt']): DisputeSnapshot {
  return {
    id: agentCase.summary.id,
    status: 'WAITING_FOR_SELLER_RESPONSE',
    allowedActions: ['provide_evidence'],
    evidences: [],
    readAt: '10 Oct 2026 12:00:00 UTC',
    createdAt: '2026-10-10T11:20:00.000Z',
    origin: { kind: 'paypal', env: 'sandbox', disputeId: 'PP-R-REAL-9' },
    agentReceipt,
  };
}
const live = (s: DisputeSnapshot): PayPalSource => ({ kind: 'live', snap: s, failed: null });
const docs = (c: ReturnType<typeof withMeterMcp>) => c.evidence.filter((e) => ['E1', 'E2', 'E3', 'E4'].includes(e.id));
const allText = (c: ReturnType<typeof withMeterMcp>) => JSON.stringify([c.evidence, c.timeline, c.sentences, c.fulfillment, c.attachments]);

describe('agent case documents from MeterMCP', () => {
  it('a bound case with a session shows the real mandate, calls and settlement, labelled from MeterMCP', () => {
    const c = withMeterMcp(agentCase, live(snap({ kind: 'metermcp', session: session() })));
    for (const e of docs(c)) expect(e.sourceLabel).toEqual({ kind: 'metermcp', text: 'From MeterMCP · session mm-sess-01234567…', title: `From MeterMCP · session ${SID}` });
    const [e1, e2, e3] = docs(c);
    expect(e1!.body).toMatchObject({ kind: 'mandate', sessionId: SID });
    expect(e1!.body.kind === 'mandate' && e1!.body.rows.map((r) => r.value)).toEqual([
      SID,
      '10 Oct 2026 11:02 UTC by the buyer in PayPal',
      'ORDER1',
      'AUTH1 · CAPTURED',
      '5.00 USD · MeterMCP tools only',
    ]);
    expect(e2!.body.kind === 'receipt' && e2!.body.calls.map((x) => [x.fragment, x.time, x.tool, x.price, x.ok, x.hash])).toEqual([
      ['r1', '11:03:00', 'quote_lookup', '0.05', true, '1111…1111'],
      ['r2', '11:04:05', 'deep_report', '0.40', false, '2222…2222'],
      ['r3', '11:04:30', 'deep_report', '0.40', true, '3333…3333'],
      ['r4', '11:05:00', 'bulk_export', '0.92', true, '4444…4444'],
    ]);
    expect(e3!.body).toMatchObject({ kind: 'settlement', captured: '1.37', released: '3.63', cap: '5.00', headline: 'Captured 1.37 of 5.00 USD · remainder released' });
    expect(e3!.caption).toBe('PayPal capture · recorded by MeterMCP');
    // Nothing of the demo session remains anywhere.
    for (const v of ['mm-sess-20261008-01', '5UX02876PL4419203', '0VF52814937998046', '7HF40211KM3390816', '09:15:40', '8 October 2026']) expect(allText(c)).not.toContain(v);
    expect(c.timeline.map((t) => (t.kind === 'event' ? `${t.time} ${t.title}` : ''))).toEqual([
      '11:02:03 Budget approved',
      '11:03:00 quote_lookup',
      '11:04:05 deep_report',
      '11:04:30 deep_report',
      '11:05:00 bulk_export',
      '11:06:00 Settled',
      '11:20:00 Dispute opened',
    ]);
    expect(c.notice).toBeNull();
  });

  it('the evidence sent is digital delivery referenced by the real session, with the real receipt PDF', () => {
    const c = withMeterMcp(agentCase, live(snap({ kind: 'metermcp', session: session() })));
    const views: SentenceView[] = [{ id: 'G1', num: 1, text: 'x', state: 'supported', citations: [], reason: null, note: null, edited: false }];
    const sub = buildSubmission(c, views, 'PROOF_OF_FULFILLMENT');
    expect(sub).toMatchObject({ carrier: 'OTHER', tracking: SID, files: [{ name: `session-receipt-${SID}.pdf` }] });
  });

  it('a session with other numbers needs no warning: the analyst reads these very documents', () => {
    const s = session({ totals: { calls: 2, ok: 2, failed: 0, charged: '0.45', cap: '5.00' } });
    const c = withMeterMcp(agentCase, live(snap({ kind: 'metermcp', session: s })));
    expect(c.notice).toBeNull();
    expect(c.sentences).toEqual([]);
  });

  it('without a session the documents are the demo’s, labelled Demo data, and a bound case says why', () => {
    const bound = withMeterMcp(agentCase, live(snap({ kind: 'none', reason: 'MeterMCP has no session for capture CAP9' })));
    for (const e of docs(bound)) expect(e.sourceLabel).toEqual({ kind: 'demo', text: 'Demo data' });
    expect(bound.notice?.text).toContain('MeterMCP has no session for capture CAP9');
    expect(docs(bound).find((e) => e.id === 'E3')!.caption).toBe('Demo settlement');
    expect(bound.fulfillment.tracking).toBe('mm-sess-20261008-01');

    const sim = withMeterMcp(agentCase, { kind: 'simulated' });
    for (const e of docs(sim)) expect(e.sourceLabel?.text).toBe('Demo data');
    expect(sim.notice).toBeUndefined();
    expect(withMeterMcp(agentCase, { kind: 'loading' }).notice?.text).toContain('PayPal has not been read yet');
    // Other cases are untouched.
    expect(withMeterMcp(standardCase, live(snap({ kind: 'metermcp', session: session() })))).toBe(standardCase);
  });

  it('the evidence card shows the source label', () => {
    const real = withMeterMcp(agentCase, live(snap({ kind: 'metermcp', session: session() })));
    const demo = withMeterMcp(agentCase, { kind: 'simulated' });
    const card = (c: typeof real) => renderToString(createElement(HighlightProvider, null, createElement(EvidenceCard, { evidence: c.evidence[0]!, used: 1, contradictionOpen: false })));
    expect(card(real)).toContain('From MeterMCP · session mm-sess-01234567…');
    expect(card(demo)).toContain('Demo data');
    expect(card(demo)).not.toContain('From MeterMCP');
  });
});
