import type { ICellRendererParams } from 'ag-grid-community';
import type { ReactNode } from 'react';
import {
  INBOX_STATUS_LABEL,
  TOTALS_STATUSES,
  centsToMoney,
  formatDue,
  formatDueAt,
  isUrgent,
  money,
  readiness,
  type GridRow,
  type InboxGridRow,
  type ReadinessTone,
  type TotalsRow,
} from '../../domain/inbox';
import type { DisputeStatus } from '../../domain/types';
import { cx } from '../ui';

/**
 * AG Grid cell renderers for the inbox (see the design's rk-grid.js). Every renderer also draws the pinned
 * "Totals at risk" row when `node.rowPinned` is set. Colours come only from tokens and are never the only
 * signal: each state also has text.
 */
type P = ICellRendererParams<GridRow>;

function Stack({ children, align = 'start' }: { children: ReactNode; align?: 'start' | 'end' | 'stretch' }) {
  return (
    <div
      className={cx(
        'flex h-full min-w-0 flex-col justify-center gap-[3px] leading-[1.25]',
        align === 'end' ? 'items-end' : align === 'stretch' ? 'items-stretch' : 'items-start',
      )}
    >
      {children}
    </div>
  );
}

/** Second line of a cell. Truncated to the column; the full text stays available as a tooltip. */
function Sub({ children, className, mono = false }: { children: ReactNode; className?: string; mono?: boolean }) {
  return (
    <span
      title={typeof children === 'string' ? children : undefined}
      className={cx('max-w-full truncate', mono ? 'font-mono text-mono-code' : 'text-caption', className ?? 'text-ink-3')}
    >
      {children}
    </span>
  );
}

function Dot({ className, pulse = false }: { className: string; pulse?: boolean }) {
  return <span aria-hidden="true" className={cx('h-1.5 w-1.5 flex-none rounded-full', className, pulse && 'animate-pulse')} />;
}

const STATUS_TONE: Readonly<Record<DisputeStatus, { badge: string; dot: string; pulse?: boolean }>> = {
  WAITING_FOR_SELLER_RESPONSE: { badge: 'border-warn-line bg-warn-soft text-warn', dot: 'bg-warn' },
  WAITING_FOR_BUYER_RESPONSE: { badge: 'border-info-line bg-info-soft text-info', dot: 'bg-info' },
  UNDER_REVIEW: { badge: 'border-dashed border-info-line text-info', dot: 'bg-info', pulse: true },
  RESOLVED: { badge: 'border-line-2 text-ink-3', dot: 'bg-ink-3' },
};

const isPinned = (p: P) => !!p.node.rowPinned;
const dispute = (p: P): InboxGridRow | null => (p.data && p.data.kind === 'dispute' ? p.data : null);
const totals = (p: P): TotalsRow | null => (p.data && p.data.kind === 'totals' ? p.data : null);
const processing = (r: InboxGridRow) => r.nextKind === 'processing';

export function DueCell(p: P) {
  const t = totals(p);
  if (isPinned(p)) {
    return t ? (
      <Stack>
        <span className="text-body font-semibold">Totals at risk</span>
        <Sub>Open disputes in view</Sub>
      </Stack>
    ) : null;
  }
  const r = dispute(p);
  if (!r) return null;
  if (r.dueH == null || !r.respondBy) {
    return (
      <Stack>
        <span className="font-mono text-label text-ink-3">
          —<span className="sr-only">No due date.</span>
        </span>
        {r.dueNote && <Sub>{r.dueNote}</Sub>}
      </Stack>
    );
  }
  const urgent = isUrgent(r.dueH);
  return (
    <Stack>
      {urgent ? (
        <span className="rounded-sm bg-bad-soft px-1.5 py-px font-mono text-mono-id font-semibold text-bad">
          {formatDue(r.dueH)}
          <span className="sr-only"> left, due within 48 hours</span>
        </span>
      ) : (
        <span className="font-mono text-mono-id">
          {formatDue(r.dueH)}
          <span className="sr-only"> left</span>
        </span>
      )}
      <Sub className={urgent ? 'text-bad' : 'text-ink-3'}>{formatDueAt(r.respondBy)} UTC</Sub>
    </Stack>
  );
}

export function DisputeCell(p: P) {
  const t = totals(p);
  if (isPinned(p)) {
    return t ? (
      <Stack>
        <span className="text-body font-semibold">{t.n} open</span>
        <Sub>{t.resolvedCents ? `Resolved ${centsToMoney(t.resolvedCents)} USD not counted` : 'Resolved disputes not counted'}</Sub>
      </Stack>
    ) : null;
  }
  const r = dispute(p);
  if (!r) return null;
  return (
    <Stack>
      <span className={cx('font-mono text-mono-id', processing(r) ? 'text-ink-2' : 'text-ink')}>{r.id}</span>
      <Sub className="text-ink-2">{r.reason}</Sub>
    </Stack>
  );
}

export function ItemCell(p: P) {
  const r = dispute(p);
  return r ? <span className="text-label text-ink-2">{r.item}</span> : null;
}

function Money({ value, currency, size }: { value: string; currency: string; size: 'row' | 'total' }) {
  return (
    <span className={cx('font-mono', size === 'total' ? 'text-[14px] font-semibold' : 'text-body font-medium')}>
      {value} <span className="text-[11.5px] font-normal text-ink-3">{currency}</span>
    </span>
  );
}

export function AmountCell(p: P) {
  const t = totals(p);
  if (isPinned(p)) {
    return t ? (
      <Stack align="end">
        <Money value={centsToMoney(t.cents)} currency="USD" size="total" />
        <Sub>at risk</Sub>
      </Stack>
    ) : null;
  }
  const r = dispute(p);
  if (!r) return null;
  return (
    <span className={processing(r) ? 'text-ink-2' : 'text-ink'}>
      <Money value={money(r.amount)} currency={r.currency} size="row" />
    </span>
  );
}

export function StageCell(p: P) {
  const r = dispute(p);
  if (!r) return null;
  // "Not set yet" may wrap onto two lines in the narrow column.
  return (
    <Stack>
      {r.stageLabel ? <span className="text-label">{r.stageLabel}</span> : <span className="whitespace-normal text-label text-ink-3">Not set yet</span>}
    </Stack>
  );
}

export function StatusBadge({ status }: { status: DisputeStatus }) {
  const tone = STATUS_TONE[status];
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border px-2 py-px text-[12px] font-medium leading-[19px]', tone.badge)}>
      <Dot className={tone.dot} pulse={tone.pulse} />
      {INBOX_STATUS_LABEL[status]}
    </span>
  );
}

export function StatusCell(p: P) {
  const t = totals(p);
  if (isPinned(p)) {
    if (!t) return null;
    return (
      <Stack align="stretch">
        {TOTALS_STATUSES.map((s) => {
          const label = INBOX_STATUS_LABEL[s];
          const v = t.byStatus[label] ?? 0;
          return (
            <span key={s} className={cx('flex items-center justify-between gap-2.5 text-caption', v ? 'text-ink-2' : 'text-ink-3')}>
              <span className="flex items-center gap-1.5">
                <Dot className={STATUS_TONE[s].dot} />
                {label}
              </span>
              <span className={cx('font-mono font-medium', v ? 'text-ink' : 'text-ink-3')}>{centsToMoney(v)}</span>
            </span>
          );
        })}
      </Stack>
    );
  }
  const r = dispute(p);
  if (!r) return null;
  return (
    <Stack>
      <StatusBadge status={r.status} />
      <Sub mono>{r.status}</Sub>
    </Stack>
  );
}

export function CaseTypeCell(p: P) {
  const r = dispute(p);
  if (!r) return null;
  return r.caseType === 'Agent purchase' ? (
    <span className="whitespace-nowrap rounded-sm bg-acc-soft px-[7px] py-0.5 text-[12px] font-medium text-acc">Agent purchase</span>
  ) : (
    <span className="text-label text-ink-2">Standard</span>
  );
}

const SEGMENT: Readonly<Record<ReadinessTone, string>> = { warn: 'bg-warn', acc: 'bg-acc', ok: 'bg-ok' };

export function ReadinessCell(p: P) {
  const r = dispute(p);
  if (!r) return null;
  if (r.ready == null) {
    return (
      <Stack>
        <span className="flex items-center gap-1.5 text-[12px] text-ink-3">
          <span aria-hidden="true" className="box-border h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-line-2 border-t-info" />
          Analyst reading…
        </span>
        <Sub>Not scored yet</Sub>
      </Stack>
    );
  }
  const k = readiness(r.ready);
  return (
    <Stack>
      <span role="img" aria-label={k.aria} className="flex gap-0.5">
        {Array.from({ length: 5 }, (_, i) => (
          <span key={i} className={cx('h-1.5 w-3.5 rounded-[2px]', i < r.ready! ? SEGMENT[k.tone] : 'bg-line')} />
        ))}
      </span>
      <Sub className="text-ink-2">{k.label}</Sub>
    </Stack>
  );
}

export function NextStepCell(p: P) {
  const r = dispute(p);
  if (!r) return null;
  let main: ReactNode;
  switch (r.nextKind) {
    case 'approve':
      main = <span className="max-w-full truncate text-body font-semibold text-acc">{r.next} →</span>;
      break;
    case 'contra':
      main = (
        <span className="flex max-w-full items-center gap-[7px] text-body font-medium text-warn">
          <span aria-hidden="true" className="h-[7px] w-[7px] flex-none rotate-45 bg-warn" />
          <span className="sr-only">Contradiction: </span>
          <span className="truncate">{r.next}</span>
        </span>
      );
      break;
    case 'work':
      main = <span className="max-w-full truncate text-body font-medium">{r.next}</span>;
      break;
    case 'processing':
      main = (
        <span className="flex max-w-full items-center gap-[7px] text-label text-ink-2" title={r.next}>
          <Dot className="bg-info" pulse />
          <span className="truncate">{r.next}</span>
        </span>
      );
      break;
    default:
      main = <span className="max-w-full truncate text-body text-ink-3">{r.next}</span>;
  }
  return (
    <Stack>
      {main}
      {r.nextSub && <Sub>{r.nextSub}</Sub>}
    </Stack>
  );
}
