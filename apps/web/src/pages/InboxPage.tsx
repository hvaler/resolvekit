import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePolling, useServices } from '../app/services';
import { AppBar } from '../components/AppBar';
import { InboxGrid } from '../components/inbox/InboxGrid';
import { cx } from '../components/ui';
import { CHIPS, applySnapshot, chipCounts, inboxSummary, toGridRow, type ChipKey, type InboxGridRow } from '../domain/inbox';
import { DEMO_NOW, inbox } from '../fixtures';

/** Inbox rows: the synthetic disputes with the latest PayPal read applied (status, evidence recorded, opened). */
function useRows(): InboxGridRow[] {
  const { snapshots } = useServices();
  return useMemo(() => inbox.map((d) => toGridRow(applySnapshot(d, snapshots[d.id]), DEMO_NOW)), [snapshots]);
}

export function InboxPage() {
  const rows = useRows();
  const navigate = useNavigate();
  const { snapshots, sync, refreshAll } = useServices();
  const tracked = useMemo(() => inbox.map((r) => r.id).filter((id) => snapshots[id]), [snapshots]);
  usePolling(tracked);
  const lastChecked = Math.max(...Object.values(snapshots).map((s) => s.checkedAt));

  const [q, setQ] = useState('');
  const [chips, setChips] = useState<ChipKey[]>([]);
  const [resetToken, setResetToken] = useState(0);
  const [shown, setShown] = useState(rows.length);
  const counts = chipCounts(rows);
  const hasFilters = !!q.trim() || chips.length > 0;
  const clearAll = useCallback(() => {
    setQ('');
    setChips([]);
  }, []);
  const toggle = (k: ChipKey) => setChips((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));
  const onOpen = useCallback((r: InboxGridRow) => navigate(`/cases/${r.id}`), [navigate]);

  return (
    <div className="flex min-h-screen min-w-[1180px] flex-col">
      <AppBar checkedAt={Number.isFinite(lastChecked) ? lastChecked : null} onSync={() => void refreshAll(tracked)} syncNow />
      <main className="flex flex-col gap-3.5 px-7 pb-[26px] pt-[22px]">
        <div className="flex items-end justify-between gap-5">
          <div className="flex flex-col gap-[3px]">
            <h1 className="m-0 text-title-lg">Disputes</h1>
            <span className="text-[13.5px] text-ink-2">{inboxSummary(rows)}</span>
          </div>
          <span className="text-[12.5px] text-ink-3">Sorted by due date. New disputes can take a few minutes to appear and to open.</span>
        </div>

        <div role="group" aria-label="Saved filters and search" className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-ink-3">Saved filters</span>
          {CHIPS.map((c) => {
            const on = chips.includes(c.key);
            return (
              <button
                key={c.key}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(c.key)}
                className={cx(
                  'flex h-[30px] items-center gap-[7px] rounded-pill border px-3 text-body font-medium transition-colors duration-instant',
                  on ? 'border-ink bg-ink text-surface' : cx('bg-surface text-ink', c.dashed ? 'border-dashed border-info-line' : 'border-line-2'),
                )}
              >
                {c.label}
                <span className="font-mono text-[11px] font-medium leading-none opacity-75">
                  {counts[c.key]}
                  <span className="sr-only"> disputes</span>
                </span>
              </button>
            );
          })}
          {hasFilters && (
            <button type="button" onClick={clearAll} className="h-[30px] border-0 bg-transparent px-1.5 text-[12.5px] text-acc underline">
              Clear all
            </button>
          )}
          <span className="flex-1" />
          <span aria-live="polite" className="font-mono text-[12px] font-medium leading-none text-ink-2">
            Showing {shown} of {rows.length}
          </span>
          <label className="box-border flex h-8 w-[300px] items-center gap-2 rounded-[7px] border border-line-2 bg-surface px-2.5 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-acc">
            <span aria-hidden="true" className="box-border h-[11px] w-[11px] flex-none rounded-full border-[1.5px] border-ink-3" />
            <input
              type="search"
              aria-label="Search disputes"
              placeholder="Search ID, reason, status, next step"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="min-w-0 flex-1 border-0 bg-transparent text-body text-ink outline-none placeholder:text-ink-3 focus-visible:outline-none"
            />
          </label>
          <button
            type="button"
            onClick={() => setResetToken(Date.now())}
            className="h-8 rounded-[7px] border border-line-2 bg-surface px-[11px] text-[12.5px] text-ink-2"
          >
            Reset columns
          </button>
        </div>

        <div role="region" aria-label="Disputes grid">
          <InboxGrid
            rows={rows}
            loading={!sync.loaded}
            quickFilter={q}
            chips={chips}
            resetToken={resetToken}
            onOpen={onOpen}
            onDisplayed={setShown}
            onClear={clearAll}
          />
        </div>

        <div className="flex flex-wrap gap-[18px] text-[12px] text-ink-3">
          <span>
            <kbd className="font-mono text-ink-2">↑ ↓ ← →</kbd> move
          </span>
          <span>
            <kbd className="font-mono text-ink-2">Enter</kbd> or double-click opens the case
          </span>
          <span>
            <kbd className="font-mono text-ink-2">Shift</kbd>-click a header to add a sort
          </span>
          <span>Column order, widths and sort are saved on this device</span>
          <span className="flex-1" />
          <span>Readiness shows how complete the evidence is. It does not predict PayPal’s decision.</span>
        </div>
      </main>
    </div>
  );
}
