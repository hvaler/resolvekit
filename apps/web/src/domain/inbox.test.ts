import { describe, expect, it } from 'vitest';
import { DEMO_NOW, caseFiles, inbox, processingOpening } from '../fixtures';
import {
  CHIPS,
  applySnapshot,
  chipCounts,
  chipFilterModel,
  compareDue,
  computeTotals,
  formatDue,
  formatDueAt,
  inboxSummary,
  quickFilterText,
  readiness,
  toGridRow,
  type InboxGridRow,
} from './inbox';
import type { DisputeSnapshot } from './types';

const rows = inbox.map((d) => toGridRow(d, DEMO_NOW));
const row = (id: string) => rows.find((r) => r.id === id)!;

describe('due dates', () => {
  it('formats hours left as days and hours, rounded to the hour', () => {
    expect(formatDue(238)).toBe('9 d 22 h');
    expect(formatDue(30)).toBe('1 d 6 h');
    expect(formatDue(6.4)).toBe('6 h');
    expect(formatDue(47.6)).toBe('2 d 0 h');
    expect(formatDue(-3)).toBe('overdue 3 h');
  });

  it('shows the due instant in UTC', () => {
    expect(formatDueAt('2026-10-10T01:00:00Z')).toBe('10 Oct · 01:00');
  });

  it('agrees with the time left shown in the case files', () => {
    for (const c of Object.values(caseFiles)) {
      const r = row(c.summary.id);
      expect(`${formatDue(r.dueH!)} left`).toBe(c.summary.timeLeft);
    }
  });

  it('sorts soonest first and puts disputes without a due date last in both directions', () => {
    const values = [120, null, 30, 238, null];
    expect([...values].sort((a, b) => compareDue(a, b))).toEqual([30, 120, 238, null, null]);
    // AG Grid negates the comparator for a descending sort.
    expect([...values].sort((a, b) => -compareDue(a, b, true))).toEqual([238, 120, 30, null, null]);
  });
});

describe('readiness', () => {
  it('is "n of 5 present": warn at 2 or below, ok at 5, accent in between', () => {
    expect(readiness(2)).toMatchObject({ tone: 'warn', label: '2 of 5 present' });
    expect(readiness(4).tone).toBe('acc');
    expect(readiness(5)).toMatchObject({ tone: 'ok', aria: '5 of 5 evidence items present' });
  });
});

describe('quick filter text', () => {
  it('matches ID and reason, amount with 2 decimals, status label and code, next step and its detail', () => {
    const r = row('PP-R-BLW-10187733');
    expect(quickFilterText.dispute(r)).toBe('PP-R-BLW-10187733 Item not as described');
    expect(quickFilterText.amount(r)).toBe('24.50');
    expect(quickFilterText.status(r)).toBe('Waiting for you WAITING_FOR_SELLER_RESPONSE');
    expect(quickFilterText.next(r)).toBe('Add photos of the item Buyer says the colour differs');
  });

  it('does not search the due and readiness columns', () => {
    expect(quickFilterText.due()).toBe('');
    expect(quickFilterText.ready()).toBe('');
  });
});

describe('saved filter chips', () => {
  it('write column filters and combine with AND', () => {
    expect(chipFilterModel([])).toBeNull();
    expect(chipFilterModel(['agent', 'due48'])).toEqual({
      caseType: { filterType: 'text', type: 'equals', filter: 'Agent purchase' },
      due: { filterType: 'number', type: 'lessThan', filter: 48 },
    });
  });

  it('count the disputes each chip matches', () => {
    expect(chipCounts(rows)).toEqual({ approval: 2, agent: 2, processing: 1, due48: 2 });
    const both = rows.filter((r) => CHIPS.filter((c) => c.key === 'agent' || c.key === 'due48').every((c) => c.matches(r)));
    expect(both.map((r) => r.id)).toEqual(['PP-R-KDA-10192258']);
  });

  it('use filter values that the grid columns actually hold', () => {
    const value: Record<string, (r: InboxGridRow) => unknown> = { next: (r) => r.next, caseType: (r) => r.caseType, status: (r) => r.statusLabel, due: (r) => r.dueH };
    for (const c of CHIPS) {
      for (const [col, m] of Object.entries(c.model)) {
        const matching = rows.filter((r) => (m.filterType === 'text' ? value[col]!(r) === m.filter : (value[col]!(r) as number | null) != null && (value[col]!(r) as number) < m.filter));
        expect(matching.map((r) => r.id), c.key).toEqual(rows.filter(c.matches).map((r) => r.id));
      }
    }
  });
});

describe('totals at risk', () => {
  it('adds up open disputes in cents, by status, and leaves resolved ones out', () => {
    const t = computeTotals(rows);
    expect(t.n).toBe(7);
    expect(t.cents).toBe(700 + 137 + 1900 + 2450 + 4900 + 320 + 8600);
    expect(t.resolvedCents).toBe(1200);
    expect(t.byStatus).toEqual({ 'Waiting for you': 700 + 137 + 2450 + 320 + 8600, 'Under review by PayPal': 1900, 'Waiting for buyer': 4900 });
  });

  it('follows the filtered rows only', () => {
    const t = computeTotals(rows.filter((r) => r.caseType === 'Agent purchase'));
    expect(t).toMatchObject({ n: 2, cents: 457, resolvedCents: 0 });
  });
});

describe('inbox summary', () => {
  it('counts what needs attention', () => {
    expect(inboxSummary(rows)).toBe('8 disputes · 5 waiting for you · 2 due within 48 h · 1 new, still processing at PayPal');
  });
});

describe('applying a fresh read from PayPal', () => {
  const tvh = inbox.find((d) => d.id === 'PP-R-TVH-10190665')!;
  const nkq = inbox.find((d) => d.nextKind === 'processing')!;
  const snap = (o: Partial<DisputeSnapshot>): DisputeSnapshot => ({ id: 'x', status: 'WAITING_FOR_SELLER_RESPONSE', allowedActions: [], evidences: [], readAt: '', ...o });

  it('leaves the row alone when nothing changed', () => {
    expect(applySnapshot(tvh, snap({ id: tvh.id }))).toBe(tvh);
    expect(applySnapshot(tvh, undefined)).toBe(tvh);
  });

  it('after evidence is recorded: nothing to do, no due date', () => {
    const recorded = { evidenceType: 'PROOF_OF_FULFILLMENT' as const, source: 'SUBMITTED_BY_SELLER', carrier: 'UPS', tracking: '1Z', notes: '', files: [], storedAt: '' };
    const r = applySnapshot(tvh, snap({ id: tvh.id, status: 'WAITING_FOR_BUYER_RESPONSE', evidences: [recorded], origin: { kind: 'paypal', env: 'sandbox', disputeId: 'PP-R-REAL' } }));
    expect(r).toMatchObject({ status: 'WAITING_FOR_BUYER_RESPONSE', nextKind: 'none', nextSub: 'Evidence recorded by PayPal', respondBy: null });
    expect(applySnapshot(tvh, snap({ id: tvh.id, status: 'WAITING_FOR_BUYER_RESPONSE', evidences: [recorded] })).nextSub).toBe('Evidence recorded by the simulator');
    expect(toGridRow(r, DEMO_NOW).dueH).toBeNull();
  });

  it('when PayPal opens a new dispute: stage, due date and actions arrive and the row is no longer processing', () => {
    const r = applySnapshot(nkq, snap({ id: nkq.id, status: processingOpening.status, stage: processingOpening.stage, respondBy: processingOpening.respondBy, allowedActions: [...processingOpening.allowedActions] }));
    const g = toGridRow(r, DEMO_NOW);
    expect(g).toMatchObject({ statusLabel: 'Waiting for you', stageLabel: 'Inquiry', nextKind: 'work', dueH: 240 });
    expect(g.nextSub).toBe('Opened by PayPal · 5 actions allowed');
  });

  it('shows PayPal’s CHARGEBACK stage as "Claim"', () => {
    expect(row('PP-R-BLW-10187733').stageLabel).toBe('Claim');
  });
});
