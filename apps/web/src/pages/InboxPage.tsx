import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePolling, useServices } from '../app/services';
import { AppBar } from '../components/AppBar';
import { StateBadge } from '../components/StatusBadge';
import { cx } from '../components/ui';
import { STATUS_DISPLAY } from '../domain/status';
import type { InboxRow } from '../domain/types';
import { inbox } from '../fixtures';

type Filter = 'all' | 'approval' | 'agent' | 'processing';

const COLS = 'grid grid-cols-[minmax(0,1.9fr)_140px_90px_96px_minmax(0,1.3fr)_120px_118px_104px_190px] gap-3.5 px-[18px]';

/** Latest PayPal state from the session overrides the fixture row (e.g. after evidence was sent). */
function useRows(): InboxRow[] {
  const { snapshots } = useServices();
  return useMemo(
    () =>
      inbox.map((r) => {
        const s = snapshots[r.id];
        if (!s) return r;
        const sent = s.evidences.length > 0;
        return {
          ...r,
          status: s.status,
          ...(sent ? { state: 'sent' as const, note: 'Evidence recorded by PayPal', respondBy: '—', left: s.status === 'UNDER_REVIEW' ? 'PayPal reviewing' : 'Buyer to respond', urgent: false } : {}),
        };
      }),
    [snapshots],
  );
}

export function InboxPage() {
  const rows = useRows();
  const { snapshots } = useServices();
  usePolling(inbox.map((r) => r.id).filter((id) => snapshots[id]));
  const [filter, setFilter] = useState<Filter>('all');
  const lastChecked = Math.max(...Object.values(snapshots).map((s) => s.checkedAt));

  const count = {
    all: rows.length,
    approval: rows.filter((r) => r.state === 'ready').length,
    agent: rows.filter((r) => r.agent).length,
    processing: rows.filter((r) => r.state === 'processing').length,
  };
  const drafting = rows.filter((r) => r.state === 'drafting').length;
  const shown = rows.filter((r) =>
    filter === 'all' ? true : filter === 'approval' ? r.state === 'ready' : filter === 'agent' ? !!r.agent : r.state === 'processing',
  );

  const chips: { k: Filter; label: string; dashed?: boolean }[] = [
    { k: 'all', label: `All · ${count.all}` },
    { k: 'approval', label: `Needs my approval · ${count.approval}` },
    { k: 'agent', label: `Agent purchase · ${count.agent}` },
    { k: 'processing', label: `Processing by PayPal · ${count.processing}`, dashed: true },
  ];

  return (
    <div className="flex min-h-screen min-w-[1180px] flex-col">
      <AppBar checkedAt={Number.isFinite(lastChecked) ? lastChecked : null} />
      <main className="flex flex-col gap-4 px-7 pb-7 pt-6">
        <div className="flex items-end justify-between gap-5">
          <div className="flex flex-col gap-[3px]">
            <h1 className="m-0 text-[22px] font-semibold tracking-[-0.01em]">Disputes</h1>
            <span className="text-[13.5px] text-ink-2">
              {count.approval} need your approval · {drafting} being drafted · {count.processing} new, still processing at PayPal
            </span>
          </div>
          <span className="text-[12.5px] text-ink-3">Sorted by response due date. New disputes can take a few minutes to appear and to open.</span>
        </div>

        <div role="radiogroup" aria-label="Filter disputes" className="flex flex-wrap items-center gap-2">
          {chips.map((ch) => {
            const on = filter === ch.k;
            return (
              <button
                key={ch.k}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setFilter(ch.k)}
                className={cx(
                  'rounded-lg px-[11px] py-1.5 text-body',
                  on ? 'border border-ink bg-ink font-medium text-surface' : cx('border bg-surface', ch.dashed ? 'border-dashed border-info-line' : 'border-line-2'),
                )}
              >
                {ch.label}
              </button>
            );
          })}
        </div>

        <div role="table" aria-label="Disputes" className="overflow-hidden rounded-2xl border border-line bg-surface">
          <div role="row" className={`${COLS} border-b border-line bg-surface-2 py-2.5 text-[11.5px] font-medium text-ink-3`}>
            <span role="columnheader">Dispute · reason · item type</span>
            <span role="columnheader">Customer</span>
            <span role="columnheader" className="text-right">
              Amount
            </span>
            <span role="columnheader">Stage</span>
            <span role="columnheader">PayPal status</span>
            <span role="columnheader" aria-sort="ascending" className="text-ink">
              Respond by ↑
            </span>
            <span role="columnheader">Type</span>
            <span role="columnheader">Evidence</span>
            <span role="columnheader">State</span>
          </div>
          {shown.map((r) => (
            <Link
              key={r.id}
              to={`/cases/${r.id}`}
              role="row"
              aria-label={`${r.id}, ${r.reasonText}, ${r.amount} USD, ${STATUS_DISPLAY[r.status].label}`}
              className={`${COLS} items-center border-b border-line py-3 text-ink no-underline last:border-b-0 hover:bg-surface-2 hover:text-ink`}
              style={{ opacity: r.state === 'closed' ? 0.72 : 1 }}
            >
              <span role="cell" className="flex min-w-0 flex-col gap-[3px]">
                <span className="font-mono text-mono-id leading-[1.2]">{r.id}</span>
                <span className="text-[12.5px] text-ink-2">
                  {r.reasonText} · {r.item}
                </span>
              </span>
              <span role="cell" className="font-mono text-mono-frag leading-[1.2] text-ink-2">
                {r.customer}
              </span>
              <span role="cell" className="text-right font-mono text-body font-medium leading-[1.2]">
                {r.amount} <span className="font-normal text-ink-3">USD</span>
              </span>
              <span role="cell" className="font-mono text-[11px] font-medium leading-none text-ink-2">
                {r.stage ?? '—'}
              </span>
              <span role="cell" className="flex min-w-0 flex-col gap-[3px]">
                <span className="text-body">{STATUS_DISPLAY[r.status].label}</span>
                <span className="truncate font-mono text-mono-code leading-[1.2] text-ink-3" title={r.status}>
                  {r.status}
                </span>
              </span>
              <span role="cell" className="flex flex-col gap-[3px]">
                <span className="text-body">{r.respondBy}</span>
                <span className="font-mono text-caption font-medium leading-none" style={{ color: r.urgent ? 'var(--bad)' : 'var(--ink2)' }}>
                  {r.left}
                  {r.urgent && <span className="sr-only"> (urgent)</span>}
                </span>
              </span>
              <span role="cell">
                <span
                  className="inline-block rounded-sm border border-line-2 px-[7px] py-[3px] text-[11.5px] font-medium"
                  style={{ background: r.agent ? 'var(--acc-soft)' : 'transparent', color: r.agent ? 'var(--acc)' : 'var(--ink2)' }}
                >
                  {r.agent ? 'Agent purchase' : 'Standard'}
                </span>
              </span>
              <span role="cell" className="flex items-center gap-[7px]">
                <span aria-hidden="true" className="h-[5px] w-12 overflow-hidden rounded-xs bg-line">
                  <span className="block h-full" style={{ width: `${r.ready ?? 0}%`, background: (r.ready ?? 0) >= 90 ? 'var(--ok)' : 'var(--warn)' }} />
                </span>
                <span className="font-mono text-caption font-medium leading-none text-ink-2">{r.ready == null ? '—' : `${r.ready}%`}</span>
              </span>
              <span role="cell" className="flex flex-col items-start gap-1">
                <StateBadge state={r.state} />
                <span className="text-[11.5px] text-ink-3">{r.note}</span>
              </span>
            </Link>
          ))}
          {shown.length === 0 && <p className="m-0 px-[18px] py-6 text-body text-ink-2">No disputes match this filter.</p>}
        </div>
      </main>
    </div>
  );
}
