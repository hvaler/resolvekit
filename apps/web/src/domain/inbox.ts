/**
 * Inbox rules, kept free of React and AG Grid so they can be tested: due dates, readiness, quick-filter
 * text, the saved-filter chips (as AG Grid filter models), the "Totals at risk" row and how a fresh read
 * from PayPal changes a row.
 */
import { STAGE_LABEL } from './status';
import { hasSellerEvidence } from './recorded';
import type { BuyerItemType, DisputeSnapshot, DisputeStatus } from './types';

export type NextKind = 'approve' | 'contra' | 'work' | 'processing' | 'none';
export type CaseType = 'Standard' | 'Agent purchase';

/** One dispute in the inbox, as the workspace knows it. PayPal codes are kept verbatim. */
export interface InboxDispute {
  id: string;
  /** Plain-language reason. */
  reason: string;
  item: BuyerItemType;
  amount: number;
  currency: string;
  /** PayPal stage code (INQUIRY, CHARGEBACK…); null until PayPal opens the dispute. */
  stage: string | null;
  status: DisputeStatus;
  caseType: CaseType;
  /** Evidence items present, out of {@link READINESS_OF}; null while nothing is scored yet. */
  ready: number | null;
  next: string;
  nextKind: NextKind;
  nextSub: string | null;
  /** Seller response due date (ISO 8601, UTC); null when there is nothing to answer. */
  respondBy: string | null;
  /** Shown instead of a due time when {@link respondBy} is null. */
  dueNote: string | null;
}

/** What the grid shows: the dispute plus the values its columns sort and filter on. */
export interface InboxGridRow extends InboxDispute {
  kind: 'dispute';
  /** Hours until the response is due (negative when overdue); null when there is no due date. */
  dueH: number | null;
  statusLabel: string;
  stageLabel: string | null;
}

export interface TotalsRow {
  kind: 'totals';
  id: '__totals';
  /** Open (not resolved) disputes that pass the filters. */
  n: number;
  /** Amount at risk in cents, open disputes only. */
  cents: number;
  /** Cents at risk per status label. */
  byStatus: Record<string, number>;
  /** Cents in resolved disputes that pass the filters (not counted). */
  resolvedCents: number;
}

export type GridRow = InboxGridRow | TotalsRow;

export const READINESS_OF = 5;
export const URGENT_HOURS = 48;

/** Short status labels used in the inbox badges. */
export const INBOX_STATUS_LABEL: Readonly<Record<DisputeStatus, string>> = {
  WAITING_FOR_SELLER_RESPONSE: 'Waiting for you',
  WAITING_FOR_BUYER_RESPONSE: 'Waiting for buyer',
  UNDER_REVIEW: 'Under review by PayPal',
  RESOLVED: 'Resolved',
  OPEN: 'Open',
  OTHER: 'Other',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const pad = (n: number) => String(n).padStart(2, '0');

export function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

export function centsToMoney(c: number): string {
  return (c / 100).toFixed(2);
}

/** Hours from `now` until `respondBy`, or null. */
export function dueHours(respondBy: string | null, now: Date): number | null {
  if (!respondBy) return null;
  const t = Date.parse(respondBy);
  return Number.isNaN(t) ? null : (t - now.getTime()) / 3_600_000;
}

/** "9 d 22 h", "6 h", "overdue 3 h". Rounded to the hour. */
export function formatDue(hours: number): string {
  const total = Math.round(Math.abs(hours));
  const d = Math.floor(total / 24);
  const h = total % 24;
  const text = d ? `${d} d ${h} h` : `${h} h`;
  return hours < 0 && total > 0 ? `overdue ${text}` : text;
}

/** "18 Oct · 17:00" (UTC). */
export function formatDueAt(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} · ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function isUrgent(dueH: number | null): boolean {
  return dueH != null && dueH < URGENT_HOURS;
}

/** Due sort: soonest first, disputes without a due date last in both directions. */
export function compareDue(a: number | null | undefined, b: number | null | undefined, descending = false): number {
  if (a == null && b == null) return 0;
  // AG Grid reverses the comparator's result for a descending sort, so "last" flips sign there.
  if (a == null) return descending ? -1 : 1;
  if (b == null) return descending ? 1 : -1;
  return a - b;
}

export type ReadinessTone = 'warn' | 'acc' | 'ok';

export function readiness(ready: number): { tone: ReadinessTone; label: string; aria: string } {
  const tone: ReadinessTone = ready <= 2 ? 'warn' : ready >= READINESS_OF ? 'ok' : 'acc';
  return { tone, label: `${ready} of ${READINESS_OF} present`, aria: `${ready} of ${READINESS_OF} evidence items present` };
}

export function toGridRow(d: InboxDispute, now: Date): InboxGridRow {
  return {
    ...d,
    kind: 'dispute',
    dueH: dueHours(d.respondBy, now),
    statusLabel: INBOX_STATUS_LABEL[d.status],
    stageLabel: d.stage ? (STAGE_LABEL[d.stage] ?? d.stage) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Quick filter: what the search box matches in each column (AG Grid getQuickFilterText).

export const quickFilterText = {
  due: (): string => '',
  dispute: (r: InboxGridRow): string => `${r.id} ${r.reason}`,
  amount: (r: InboxGridRow): string => money(r.amount),
  status: (r: InboxGridRow): string => `${r.statusLabel} ${r.status}`,
  ready: (): string => '',
  next: (r: InboxGridRow): string => `${r.next} ${r.nextSub ?? ''}`.trim(),
} as const;

// ---------------------------------------------------------------------------------------------
// Saved filter chips. Each writes a column filter; active chips are merged, so they combine with AND.

export type ChipKey = 'approval' | 'agent' | 'processing' | 'due48';

type TextModel = { filterType: 'text'; type: 'equals'; filter: string };
type NumberModel = { filterType: 'number'; type: 'lessThan'; filter: number };
export type FilterModel = Record<string, TextModel | NumberModel>;

export interface Chip {
  key: ChipKey;
  label: string;
  dashed?: boolean;
  model: FilterModel;
  /** Same rule as `model`, for counting without the grid. */
  matches: (r: InboxGridRow) => boolean;
}

export const CHIPS: readonly Chip[] = [
  {
    key: 'approval',
    label: 'Needs my approval',
    model: { next: { filterType: 'text', type: 'equals', filter: 'Approve response' } },
    matches: (r) => r.next.toLowerCase() === 'approve response',
  },
  {
    key: 'agent',
    label: 'Agent purchase',
    model: { caseType: { filterType: 'text', type: 'equals', filter: 'Agent purchase' } },
    matches: (r) => r.caseType === 'Agent purchase',
  },
  {
    key: 'processing',
    label: 'Processing by PayPal',
    dashed: true,
    model: { status: { filterType: 'text', type: 'equals', filter: INBOX_STATUS_LABEL.UNDER_REVIEW } },
    matches: (r) => r.statusLabel === INBOX_STATUS_LABEL.UNDER_REVIEW,
  },
  {
    key: 'due48',
    label: `Due in ${URGENT_HOURS} h`,
    model: { due: { filterType: 'number', type: 'lessThan', filter: URGENT_HOURS } },
    matches: (r) => r.dueH != null && r.dueH < URGENT_HOURS,
  },
];

/** The grid filter model for the active chips (AND-combined), or null to clear all filters. */
export function chipFilterModel(keys: readonly ChipKey[]): FilterModel | null {
  const model: FilterModel = {};
  for (const c of CHIPS) if (keys.includes(c.key)) Object.assign(model, c.model);
  return Object.keys(model).length ? model : null;
}

export function chipCounts(rows: readonly InboxGridRow[]): Record<ChipKey, number> {
  const out = { approval: 0, agent: 0, processing: 0, due48: 0 } as Record<ChipKey, number>;
  for (const c of CHIPS) out[c.key] = rows.filter(c.matches).length;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Totals at risk (pinned row), computed from the rows that pass the filters. Resolved disputes are excluded.

export function computeTotals(rows: Iterable<InboxGridRow>): TotalsRow {
  const t: TotalsRow = { kind: 'totals', id: '__totals', n: 0, cents: 0, byStatus: {}, resolvedCents: 0 };
  for (const r of rows) {
    const c = Math.round(r.amount * 100);
    if (r.status === 'RESOLVED') {
      t.resolvedCents += c;
      continue;
    }
    t.n++;
    t.cents += c;
    t.byStatus[r.statusLabel] = (t.byStatus[r.statusLabel] ?? 0) + c;
  }
  return t;
}

/** The statuses listed in the totals row, in this order. */
export const TOTALS_STATUSES: readonly DisputeStatus[] = ['WAITING_FOR_SELLER_RESPONSE', 'UNDER_REVIEW', 'WAITING_FOR_BUYER_RESPONSE'];

// ---------------------------------------------------------------------------------------------

/** "8 disputes · 5 waiting for you · 2 due within 48 h · 1 new, still processing at PayPal". */
export function inboxSummary(rows: readonly InboxGridRow[]): string {
  const waiting = rows.filter((r) => r.status === 'WAITING_FOR_SELLER_RESPONSE').length;
  const urgent = rows.filter((r) => r.status !== 'RESOLVED' && isUrgent(r.dueH)).length;
  const processing = rows.filter((r) => r.nextKind === 'processing').length;
  const parts = [`${rows.length} ${rows.length === 1 ? 'dispute' : 'disputes'}`, `${waiting} waiting for you`, `${urgent} due within ${URGENT_HOURS} h`];
  if (processing) parts.push(`${processing} new, still processing at PayPal`);
  return parts.join(' · ');
}

/**
 * Apply the latest read from PayPal to an inbox row. Evidence recorded → nothing to do until the buyer or
 * PayPal moves; a new dispute that PayPal has opened → it gets its stage and due date and the analyst starts.
 */
export function applySnapshot(d: InboxDispute, s: DisputeSnapshot | undefined): InboxDispute {
  if (!s) return d;
  if (hasSellerEvidence(s)) {
    const reviewing = s.status === 'UNDER_REVIEW';
    return {
      ...d,
      status: s.status,
      next: reviewing ? 'Nothing to do · PayPal is reviewing' : 'Nothing to do · buyer’s turn',
      nextKind: 'none',
      nextSub: 'Evidence recorded by PayPal',
      respondBy: null,
      dueNote: reviewing ? 'PayPal reviewing' : 'Buyer to respond',
    };
  }
  if (d.nextKind === 'processing' && s.status !== 'UNDER_REVIEW') {
    return {
      ...d,
      status: s.status,
      stage: s.stage ?? d.stage,
      respondBy: s.respondBy ?? d.respondBy,
      dueNote: s.respondBy ? null : d.dueNote,
      next: 'Wait for draft',
      nextKind: 'work',
      nextSub: `Opened by PayPal · ${s.allowedActions.length} actions allowed`,
    };
  }
  return s.status === d.status ? d : { ...d, status: s.status };
}

/** Shallow equality of grid rows, to send only changed rows to the grid. */
export function sameRow(a: InboxGridRow, b: InboxGridRow): boolean {
  return (Object.keys(a) as (keyof InboxGridRow)[]).every((k) => Object.is(a[k], b[k]));
}
