import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CaseHeader } from '../components/CaseHeader';
import { DEMO_NOW, inbox, standardCase } from '../fixtures';
import { bindingMismatch } from './binding';
import { computeTotals, toGridRow } from './inbox';
import {
  boundInboxRow,
  caseAllowedActions,
  caseHeaderView,
  caseRequestedEvidence,
  payPalSource,
  withPayPal,
  type PayPalSource,
} from './paypalView';
import type { DisputeSnapshot } from './types';

const NOW = new Date('2026-10-09T08:00:00Z');
const sandbox = { kind: 'paypal', env: 'sandbox' } as const;

/** The bound sandbox dispute while PayPal waits for the seller (mapped by apps/server). */
function waiting(): DisputeSnapshot {
  return {
    id: 'PP-R-TVH-10190665',
    status: 'WAITING_FOR_SELLER_RESPONSE',
    stage: 'INQUIRY',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    buyerItemType: 'SERVICE',
    allowedActions: ['provide_evidence', 'send_message', 'accept_claim', 'escalate'],
    requestedEvidence: ['PROOF_OF_FULFILLMENT'],
    evidences: [
      { evidenceType: 'CREATE', source: 'SUBMITTED_BY_BUYER', carrier: '', tracking: '', notes: '', files: [], storedAt: '' },
      { evidenceType: 'PROOF_OF_FULFILLMENT', source: 'REQUESTED_FROM_SELLER', carrier: '', tracking: '', notes: '', files: [], storedAt: '' },
    ],
    respondBy: '2026-10-28T19:31:23.864Z',
    buyerRespondBy: null,
    amount: { value: '1.37', currency: 'USD' },
    createdAt: '2026-10-08T19:31:23.864Z',
    transaction: { id: '4FT237453Y5353014', createdAt: '2026-10-08T19:30:33.000Z', amount: { value: '1.37', currency: 'USD' }, status: 'HELD' },
    readAt: '9 Oct 2026 08:00:00 UTC',
    origin: { kind: 'paypal', env: 'sandbox', disputeId: 'PP-R-VIJ-10190671' },
  };
}

/** The same dispute after the seller's evidence is in: PayPal no longer returns a seller due date. */
function evidenceIn(): DisputeSnapshot {
  const s = waiting();
  return {
    ...s,
    status: 'WAITING_FOR_BUYER_RESPONSE',
    allowedActions: ['send_message', 'accept_claim', 'escalate'],
    requestedEvidence: [],
    evidences: [
      s.evidences[0]!,
      { evidenceType: 'PROOF_OF_FULFILLMENT', source: 'SUBMITTED_BY_SELLER', action: 'PROVIDE_EVIDENCE', carrier: 'UPS', tracking: '1Z', notes: 'x', files: [], storedAt: '' },
    ],
    respondBy: null,
    buyerRespondBy: '2026-10-19T04:37:54.000Z',
  };
}

const live = (snap: DisputeSnapshot, failed: string | null = null): PayPalSource => ({ kind: 'live', snap, failed });
const header = (source: PayPalSource) =>
  caseHeaderView({ summary: standardCase.summary, source, simulatedStatus: standardCase.summary.status, statusDetail: 'STATUS · read 3s ago', now: NOW });

/** Every value of the demo case's summary that is PayPal's to say. None may appear for a bound case. */
const DEMO_PAYPAL_VALUES = ['7.00', '18 Oct 2026', '9 d 22 h left', '2CY26152YH817252P', 'Captured 6 Oct 2026', 'Physical product'];

describe('where PayPal fields come from', () => {
  it('a case is checking until the server answers, simulated when not bound, and only a PayPal-origin snapshot counts when bound', () => {
    const sim: DisputeSnapshot = { ...waiting(), origin: { kind: 'simulator' } };
    expect(payPalSource(null, waiting()).kind).toBe('checking');
    expect(payPalSource({ kind: 'simulator' }, waiting()).kind).toBe('simulated');
    expect(payPalSource(sandbox, sim).kind).toBe('loading');
    expect(payPalSource(sandbox, undefined, 'PayPal unreachable')).toEqual({ kind: 'unavailable', error: 'PayPal unreachable' });
    expect(payPalSource(sandbox, waiting())).toMatchObject({ kind: 'live', failed: null });
    expect(payPalSource(sandbox, waiting(), 'timeout')).toMatchObject({ kind: 'live', failed: 'timeout' });
  });
});

describe('case header', () => {
  it('a simulated case shows its demo data', () => {
    const v = header({ kind: 'simulated' });
    expect(v).toMatchObject({ amount: '7.00', currency: 'USD', transactionId: '2CY26152YH817252P', due: { at: '18 Oct 2026', left: '9 d 22 h left' } });
    expect(v.mismatch).toBeNull();
  });

  it('a bound case shows PayPal’s amount, reason, item type, stage, status, due date, transaction and dispute', () => {
    const v = header(live(waiting()));
    expect(v).toMatchObject({
      amount: '1.37',
      currency: 'USD',
      reasonText: 'Buyer says the item was not received',
      reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      itemType: 'Service',
      stage: 'INQUIRY',
      status: 'WAITING_FOR_SELLER_RESPONSE',
      due: { at: '28 Oct 2026', left: '19 d 12 h left' },
      transactionId: '4FT237453Y5353014',
      transactionText: 'Created 8 Oct 2026 19:30 UTC · 1.37 USD · from PayPal',
      disputeLine: 'PayPal PP-R-VIJ-10190671 · opened 8 Oct 2026 19:31 UTC',
      notice: null,
    });
    for (const demo of DEMO_PAYPAL_VALUES) expect(JSON.stringify({ ...v, mismatch: null })).not.toContain(demo);
  });

  it('once the evidence is in and PayPal drops the seller due date, says so instead of showing a stale date', () => {
    const v = header(live(evidenceIn()));
    expect(v.due).toBeNull();
    expect(v.dueEmpty).toEqual({ text: 'No seller deadline', sub: 'Buyer’s turn · buyer by 19 Oct' });
    expect(v.status).toBe('WAITING_FOR_BUYER_RESPONSE');
    expect(JSON.stringify(v)).not.toContain('18 Oct 2026');
  });

  it('while reading PayPal and when PayPal is unreachable, shows "—" with the reason, never the demo values', () => {
    for (const source of [{ kind: 'loading' }, { kind: 'checking' }, { kind: 'unavailable', error: 'The ResolveKit server could not be reached' }] as PayPalSource[]) {
      const v = header(source);
      expect(v).toMatchObject({ amount: '—', status: null, due: null, transactionId: '—', reasonCode: null, itemType: null });
      expect(v.notice).not.toBeNull();
      for (const demo of DEMO_PAYPAL_VALUES) expect(JSON.stringify(v)).not.toContain(demo);
    }
    expect(header({ kind: 'unavailable', error: 'boom' }).notice).toMatchObject({ tone: 'bad', text: expect.stringContaining('Couldn’t reach PayPal') });
    expect(header({ kind: 'loading' }).notice).toMatchObject({ tone: 'info', text: 'Reading this dispute from PayPal…' });
  });

  it('a failed re-read keeps PayPal’s saved data and says so', () => {
    const v = header(live(waiting(), 'timeout'));
    expect(v.amount).toBe('1.37');
    expect(v.statusDetail).toBe('STATUS · read 3s ago · saved');
    expect(v.notice).toEqual({ tone: 'bad', text: 'Couldn’t reach PayPal · showing saved data, read 9 Oct 2026 08:00:00 UTC' });
  });

  it('warns the demo operator when the bound dispute’s amount is not the demo case’s order amount', () => {
    expect(header(live(waiting())).mismatch).toBe(
      'Bound PayPal dispute PP-R-VIJ-10190671 is 1.37 USD; this demo case’s order is 7.00 USD. The order, documents and draft below are the demo case’s, not this dispute’s.',
    );
    expect(header(live({ ...waiting(), amount: { value: '7.0', currency: 'USD' } })).mismatch).toBeNull();
    expect(bindingMismatch({ value: '7.00', currency: 'EUR' }, { value: '7.00', currency: 'USD' })).toBe('Bound PayPal dispute is 7.00 EUR; this demo case’s order is 7.00 USD');
    expect(bindingMismatch(null, { value: '7.00', currency: 'USD' })).toBeNull();
  });

  it('renders PayPal’s values, the mismatch warning and no demo PayPal values for a bound case', () => {
    const html = renderToString(createElement(CaseHeader, { view: header(live(evidenceIn())) }));
    expect(html).toContain('1.37');
    expect(html).toContain('Waiting for buyer');
    expect(html).toContain('No seller deadline');
    expect(html).toContain('Buyer’s turn · buyer by 19 Oct');
    expect(html).toContain('Demo binding mismatch.');
    expect(html).toContain('4FT237453Y5353014');
    expect(html).not.toContain('2CY26152YH817252P');
    expect(html).not.toContain('18 Oct 2026');
    const loading = renderToString(createElement(CaseHeader, { view: header({ kind: 'loading' }) }));
    expect(loading).toContain('Reading this dispute from PayPal…');
    expect(loading).not.toContain('7.00');
  });
});

describe('case rules from PayPal', () => {
  it('allowed actions and requested evidence come from PayPal for a bound case, nothing before the first read', () => {
    expect(caseAllowedActions({ kind: 'loading' }, undefined, standardCase.allowedActions)).toEqual([]);
    expect(caseAllowedActions({ kind: 'unavailable', error: 'x' }, undefined, standardCase.allowedActions)).toEqual([]);
    expect(caseAllowedActions(live(evidenceIn()), undefined, standardCase.allowedActions)).toEqual(['send_message', 'accept_claim', 'escalate']);
    expect(caseAllowedActions({ kind: 'simulated' }, undefined, standardCase.allowedActions)).toEqual(standardCase.allowedActions);
    expect(caseRequestedEvidence(live(waiting()), 'PROOF_OF_REFUND')).toBe('PROOF_OF_FULFILLMENT');
    expect(caseRequestedEvidence(live(evidenceIn()), 'PROOF_OF_FULFILLMENT')).toBeNull();
    expect(caseRequestedEvidence({ kind: 'loading' }, 'PROOF_OF_FULFILLMENT')).toBeNull();
  });

  it('the case seen by the draft and the approve flow carries PayPal’s amount and keeps the merchant-side data', () => {
    const c = withPayPal(standardCase, live(waiting()));
    expect(c.summary).toMatchObject({ id: 'PP-R-TVH-10190665', amount: '1.37', currency: 'USD', transactionId: '4FT237453Y5353014' });
    expect(c.evidence.filter((e) => !e.paypalRecord)).toEqual(standardCase.evidence.filter((e) => !e.paypalRecord));
    expect(c.sentences).toBe(standardCase.sentences);
    expect(withPayPal(standardCase, { kind: 'simulated' })).toBe(standardCase);
    expect(withPayPal(standardCase, { kind: 'loading' }).summary.amount).toBe('—');
  });
});

describe('the payment-capture document', () => {
  const capture = (c: ReturnType<typeof withPayPal>) => c.evidence.find((e) => e.paypalRecord === 'capture')!;
  const text = (c: ReturnType<typeof withPayPal>) => {
    const e = capture(c);
    return [e.meta?.source, e.meta?.received, ...(e.body.kind === 'lines' ? e.body.lines.map((l) => l.text) : [])].join(' | ');
  };

  it('on a bound case is PayPal’s disputed transaction: capture id, gross amount, status and time, with the citable fragments kept', () => {
    const c = withPayPal(standardCase, live(waiting()));
    const e = capture(c);
    expect(e.id).toBe('E2');
    expect(e.body).toEqual({
      kind: 'lines',
      lines: [
        { text: 'Capture 4FT237453Y5353014', fragment: 'E2.id' },
        { text: '1.37 USD · HELD', fragment: 'E2.amt' },
        { text: 'Transaction created 8 Oct 2026 19:30 UTC', fragment: 'E2.date' },
      ],
    });
    expect(e.meta).toMatchObject({ source: 'PayPal sandbox · dispute PP-R-VIJ-10190671', received: 'read 9 Oct 2026 08:00:00 UTC', hash: '' });
    for (const v of ['7.00', '2CY26152YH817252P', '14:03', '41d0']) expect(text(c)).not.toContain(v);
    const ev = c.timeline.find((t) => t.kind === 'event' && t.evidenceId === 'E2');
    expect(ev).toMatchObject({ time: '8 Oct 19:30', sub: '4FT237453Y5353014 · from PayPal' });
  });

  it('without a status from PayPal shows amount only; without a transaction says so', () => {
    const noStatus = waiting();
    noStatus.transaction = { ...noStatus.transaction!, status: undefined };
    expect(text(withPayPal(standardCase, live(noStatus)))).toContain('| 1.37 USD |');
    const none = { ...waiting(), transaction: null };
    expect(text(withPayPal(standardCase, live(none)))).toContain('PayPal reports no disputed transaction');
  });

  it('before the first read and when PayPal is unreachable shows no demo values, only the reason', () => {
    for (const src of [{ kind: 'loading' }, { kind: 'unavailable', error: 'down' }] as const) {
      const t = text(withPayPal(standardCase, src));
      for (const v of ['7.00', '2CY26152YH817252P', '41d0']) expect(t).not.toContain(v);
      expect(t).toContain(src.kind === 'loading' ? 'Reading PayPal' : 'Couldn’t reach PayPal (down)');
    }
  });

  it('on a simulated case keeps the demo capture and never calls it plain "PayPal"', () => {
    const e = capture(withPayPal(standardCase, { kind: 'simulated' }));
    expect(e.meta?.source).toBe('Simulated PayPal · demo data');
    expect(e.body.kind === 'lines' && e.body.lines[0]!.text).toBe('Capture 2CY26152YH817252P');
  });
});

describe('inbox row of a bound dispute', () => {
  const demo = inbox.find((d) => d.id === 'PP-R-TVH-10190665')!;

  it('takes status, stage, amount, item type, reason and due date from PayPal and keeps the workspace’s next step while PayPal waits for the seller', () => {
    const r = toGridRow(boundInboxRow(demo, live(waiting()) as Extract<PayPalSource, { kind: 'live' }>), NOW);
    expect(r).toMatchObject({
      amount: 1.37,
      currency: 'USD',
      item: 'Service',
      reason: 'Item not received',
      stage: 'INQUIRY',
      status: 'WAITING_FOR_SELLER_RESPONSE',
      respondBy: '2026-10-28T19:31:23.864Z',
      next: demo.next,
      ready: demo.ready,
      paypal: 'live',
    });
    expect(Math.round(r.dueH!)).toBe(468);
  });

  it('after the evidence is in: no due date, the buyer’s turn, evidence recorded by PayPal', () => {
    const r = toGridRow(boundInboxRow(demo, live(evidenceIn()) as Extract<PayPalSource, { kind: 'live' }>), NOW);
    expect(r).toMatchObject({ status: 'WAITING_FOR_BUYER_RESPONSE', respondBy: null, dueH: null, dueNote: 'Buyer’s turn · buyer by 19 Oct', next: 'Nothing to do · buyer’s turn', nextSub: 'Evidence recorded by PayPal' });
  });

  it('before the first read and when unreachable: no demo amount, status or due date', () => {
    for (const src of [{ kind: 'loading' }, { kind: 'unavailable', error: 'down' }] as const) {
      const r = toGridRow(boundInboxRow(demo, src), NOW);
      expect(r).toMatchObject({ amount: null, stage: null, respondBy: null, dueH: null, item: '—' });
      expect(r.statusLabel).toBe(src.kind === 'loading' ? 'Reading PayPal…' : 'PayPal unreachable');
    }
  });

  it('Totals at risk count the PayPal amount for bound rows and leave unread amounts out', () => {
    const others = inbox.filter((d) => d.id !== demo.id).map((d) => toGridRow(d, DEMO_NOW));
    const base = computeTotals(others);
    const withLive = computeTotals([...others, toGridRow(boundInboxRow(demo, live(waiting()) as Extract<PayPalSource, { kind: 'live' }>), NOW)]);
    expect(withLive.cents - base.cents).toBe(137);
    const withUnread = computeTotals([...others, toGridRow(boundInboxRow(demo, { kind: 'loading' }), NOW)]);
    expect(withUnread.cents).toBe(base.cents);
    expect(withUnread.unread).toBe(1);
    expect(withUnread.n).toBe(base.n + 1);
  });
});
