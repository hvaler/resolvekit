import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { usePolling, useServices } from '../app/services';
import { AppBar } from '../components/AppBar';
import { InboxGrid } from '../components/inbox/InboxGrid';
import { PayPalNotices } from '../components/PayPalNotices';
import { cx } from '../components/ui';
import { casesBase, environmentOf } from '../domain/environment';
import { CHIPS, applySnapshot, chipCounts, clockNote, emptyInboxNote, evaluationRows, inboxView, inboxSummary, toGridRow, type ChipKey, type InboxDispute, type InboxGridRow } from '../domain/inbox';
import { boundInboxRow, payPalSource } from '../domain/paypalView';
import { DEMO_NOW, inbox } from '../fixtures';

/**
 * Inbox rows. A dispute bound to real PayPal takes every PayPal field from PayPal (or "—" while reading / when
 * unreachable) and its due time from the real clock; the synthetic ones take the simulator's read on the demo clock.
 */
function useRows(disputes: InboxDispute[]): { rows: InboxGridRow[]; clock: { simulated: number; bound: number } } {
  const { snapshots, modeOf, modeKnown, readErrors } = useServices();
  return useMemo(() => {
    const clock = { simulated: 0, bound: 0 };
    const rows = disputes.map((d) => {
      const src = payPalSource(modeKnown ? modeOf(d.id) : null, snapshots[d.id], readErrors[d.id]);
      if (src.kind === 'simulated' || src.kind === 'checking') {
        clock.simulated++;
        return toGridRow(applySnapshot(d, snapshots[d.id]), DEMO_NOW);
      }
      clock.bound++;
      return toGridRow(boundInboxRow(d, src), new Date());
    });
    return { rows, clock };
  }, [disputes, snapshots, modeOf, modeKnown, readErrors]);
}

export function InboxPage() {
  const { snapshots, sync, refreshAll, modeKnown, area, demo, health } = useServices();
  const env = environmentOf(area, demo);
  // The demo shows every fictional case; the evaluation workspace only the cases bound to real sandbox disputes.
  const bound = health?.bound;
  const disputes = useMemo(() => (env.kind === 'evaluation' ? evaluationRows(inbox, bound ?? []) : inbox), [env.kind, bound]);
  const { rows, clock } = useRows(disputes);
  const envKey = env.kind === 'evaluation' ? 'evaluation' : env.kind === 'demo' ? 'demo' : 'local';
  const emptyNote = modeKnown ? emptyInboxNote(envKey, rows.length) : null;
  const showGrid = !modeKnown || inboxView(envKey, rows.length) === 'grid';
  const note = clockNote(clock);
  const navigate = useNavigate();
  // Rows are hidden until it is known which disputes are real PayPal ones, so no demo value stands in for PayPal's.
  const loading = !sync.loaded || !modeKnown;
  const tracked = useMemo(() => disputes.map((r) => r.id).filter((id) => snapshots[id]), [disputes, snapshots]);
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
  const onOpen = useCallback((r: InboxGridRow) => navigate(`${casesBase(area)}/${r.id}`), [navigate, area]);

  return (
    <div className="flex min-h-screen min-w-[1180px] flex-col max-md:min-w-0">
      <AppBar checkedAt={Number.isFinite(lastChecked) ? lastChecked : null} onSync={() => void refreshAll(tracked)} syncNow />
      <main className="flex flex-col gap-3.5 px-7 pb-[26px] pt-[22px] max-md:px-4">
        <div className="flex items-end justify-between gap-5 max-md:flex-col max-md:items-start max-md:gap-1.5">
          <div className="flex flex-col gap-[3px]">
            <h1 className="m-0 text-title-lg">Disputes</h1>
            <span className="text-[13.5px] text-ink-2">{modeKnown ? inboxSummary(rows) : 'Loading disputes…'}</span>
          </div>
          <div className="flex flex-col items-end gap-[3px] text-right max-md:items-start max-md:text-left">
            <span className="text-[12.5px] text-ink-3">Sorted by due date. New disputes can take a few minutes to appear and to open.</span>
            {modeKnown && note && <span className="text-[12px] text-info">{note}</span>}
          </div>
        </div>

        <PayPalNotices />

        {env.kind === 'evaluation' && (
          <Link to="/demo" className="self-start text-[12.5px] text-acc">
            Explore demo · {inbox.length - rows.length} more fictional cases
          </Link>
        )}

        {showGrid && (
          <>
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
            <label className="box-border flex h-8 w-[300px] max-md:w-full items-center gap-2 rounded-[7px] border border-line-2 bg-surface px-2.5 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-acc">
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
          </>
        )}

        {emptyNote && (
          <p role="status" className="m-0 rounded-lg border border-line bg-surface px-4 py-3 text-[13.5px] text-ink-2">
            {emptyNote}
          </p>
        )}

        {showGrid && (
          <>
          <div role="region" aria-label="Disputes grid" className="max-md:min-w-0">
            <InboxGrid
              rows={rows}
              loading={loading}
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
          </>
        )}
      </main>
    </div>
  );
}
