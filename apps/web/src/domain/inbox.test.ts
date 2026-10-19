import { describe, expect, it } from 'vitest';
import { DEMO_NOW, caseFiles, inbox, initialSnapshots, ownerInbox, processingOpening } from '../fixtures';
import { goldenAnalyses } from '../fixtures/golden';
import {
  NO_BOUND_CASES,
  emptyInboxNote,
  inboxView,
  evaluationRows,
  CHIPS,
  clockNote,
  applySnapshot,
  chipCounts,
  chipFilterModel,
  compareDue,
  computeTotals,
  formatDue,
  formatDueAt,
  inboxSummary,
  money,
  quickFilterText,
  READINESS_OF,
  readiness,
  toGridRow,
  type InboxGridRow,
} from './inbox';
import type { DisputeSnapshot } from './types';

const rows = inbox.map((d) => toGridRow(d, DEMO_NOW));
// Any row with a case file, the owner-only settlement case included (it is not in the demo inbox).
const row = (id: string) => [...rows, ...ownerInbox.map((d) => toGridRow(d, DEMO_NOW))].find((r) => r.id === id)!;

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

  it('agrees with the time left shown in the case files (none once the seller’s evidence is in or the case is closed)', () => {
    for (const c of Object.values(caseFiles)) {
      const r = row(c.summary.id);
      if (c.summary.respondBy == null) {
        expect(r.dueH, c.summary.id).toBeNull();
        expect(c.summary.timeLeft).toBeNull();
      } else expect(`${formatDue(r.dueH!)} left`, c.summary.id).toBe(c.summary.timeLeft);
    }
  });

  it('sorts soonest first and puts disputes without a due date last in both directions', () => {
    const values = [120, null, 30, 238, null];
    expect([...values].sort((a, b) => compareDue(a, b))).toEqual([30, 120, 238, null, null]);
    // AG Grid negates the comparator for a descending sort.
    expect([...values].sort((a, b) => -compareDue(a, b, true))).toEqual([238, 120, 30, null, null]);
  });
});

describe('the owner-only settlement case', () => {
  it('is not in the demo inbox; listed only when the server lists it as bound; agrees with its case file', () => {
    const [stl] = ownerInbox;
    const c = caseFiles[stl!.id]!;
    expect(c.audience).toBe('owner');
    expect(inbox.some((d) => d.id === stl!.id)).toBe(false);
    expect(evaluationRows([...inbox, ...ownerInbox], ['PP-R-TVH-10190665']).map((d) => d.id)).toEqual(['PP-R-TVH-10190665']);
    expect(evaluationRows([...inbox, ...ownerInbox], ['PP-R-TVH-10190665', stl!.id]).map((d) => d.id)).toEqual(['PP-R-TVH-10190665', stl!.id]);
    expect([money(stl!.amount!), stl!.currency, stl!.stage, stl!.status, stl!.item, stl!.nextSub]).toEqual([c.summary.amount, c.summary.currency, c.summary.stage, c.summary.status, c.summary.buyerItemType, c.summary.title]);
    expect(stl!.respondBy).toBe(inbox.find((d) => d.id === 'PP-R-TVH-10190665')!.respondBy);
  });
});

describe('every inbox row and its case file', () => {
  it('has a case file, except the dispute PayPal is still processing', () => {
    for (const d of inbox) expect(!!caseFiles[d.id] || d.nextKind === 'processing', d.id).toBe(true);
  });

  it('agree on amount, stage and status; readiness is the committed analysis’s checklist', () => {
    for (const d of inbox) {
      const c = caseFiles[d.id];
      if (!c) continue;
      expect([money(d.amount!), d.currency, d.stage, d.status, d.item], d.id).toEqual([c.summary.amount, c.summary.currency, c.summary.stage, c.summary.status, c.summary.buyerItemType]);
      expect(d.caseType, d.id).toBe(c.kind === 'agent' ? 'Agent purchase' : 'Standard');
      const g = goldenAnalyses[d.id]!;
      expect(g.checklist.items).toHaveLength(READINESS_OF);
      expect(d.ready, d.id).toBe(g.checklist.items.filter((i) => i.status === 'present').length);
    }
  });

  it('read as the simulator’s first snapshot makes them (recorded and closed rows)', () => {
    for (const d of inbox) {
      const s = initialSnapshots.find((x) => x.id === d.id);
      if (caseFiles[d.id]) expect(applySnapshot(d, s), d.id).toEqual(d);
    }
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
    expect(quickFilterText.next(r)).toBe('Review: records back the buyer Pick list shows the navy SKU');
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

  it('a closed dispute: nothing to do, PayPal’s outcome and the day it closed', () => {
    const r = applySnapshot(tvh, snap({ id: tvh.id, status: 'RESOLVED', outcome: { code: 'RESOLVED_SELLER_FAVOUR', closedAt: '2026-10-02T16:00:00Z' } }));
    expect(r).toMatchObject({ status: 'RESOLVED', next: 'Nothing to do', nextKind: 'none', nextSub: 'Resolved in your favour · 2 Oct', respondBy: null, dueNote: 'Closed 2 Oct' });
    expect(applySnapshot(tvh, snap({ id: tvh.id, status: 'RESOLVED' })).nextSub).toBe('Resolved at PayPal');
  });

  it('shows PayPal’s CHARGEBACK stage as "Claim"', () => {
    expect(row('PP-R-BLW-10187733').stageLabel).toBe('Claim');
  });
});

describe('the demo clock note', () => {
  it('says which rows run on the demo clock and which on PayPal’s, only when there are simulated rows', () => {
    expect(clockNote({ simulated: 7, bound: 1 })).toBe('Simulated disputes run on a demo clock (8 Oct 2026 19:00 UTC); the 1 on real PayPal uses PayPal’s dates.');
    expect(clockNote({ simulated: 8, bound: 0 })).toBe('Simulated disputes run on a demo clock (8 Oct 2026 19:00 UTC), so their due times read the same any day.');
    expect(clockNote({ simulated: 0, bound: 2 })).toBeNull();
  });
});

describe('the evaluation inbox', () => {
  it('keeps bound cases only, in the inbox order', () => {
    const ids = inbox.map((d) => d.id);
    const bound = [ids[3]!, ids[1]!, 'not-in-the-inbox'];
    expect(evaluationRows(inbox, bound).map((d) => d.id)).toEqual([ids[1], ids[3]]);
  });
  it('no bound case: no rows, and the empty inbox says so', () => {
    expect(evaluationRows(inbox, [])).toEqual([]);
    expect(NO_BOUND_CASES).toBe('No sandbox disputes are bound right now.');
    expect(emptyInboxNote('evaluation', 0)).toBe(NO_BOUND_CASES);
    expect(emptyInboxNote('evaluation', 1)).toBeNull();
    expect(emptyInboxNote('demo', 0)).toBeNull();
    expect(emptyInboxNote('local', 0)).toBeNull();
  });
  it('with no bound case there is no grid at all, only the note', () => {
    expect(inboxView('evaluation', 0)).toBe('empty');
    expect(inboxView('evaluation', 2)).toBe('grid');
    expect(inboxView('demo', 0)).toBe('grid');
    expect(inboxView('local', 0)).toBe('grid');
  });
});
