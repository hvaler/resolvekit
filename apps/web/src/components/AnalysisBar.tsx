import { cx } from './ui';

/** "Analysis" strip: the analyst's steps appear one by one (replayable), plus a standing note. */
export function AnalysisBar({ steps, run, note, onReplay }: { steps: string[]; run: number; note: string; onReplay?: () => void }) {
  const complete = run >= steps.length;
  return (
    <div className="flex flex-none items-center gap-4 border-b border-line bg-surface-2 px-[22px] py-2 text-[12.5px]">
      <span className="text-[10.5px] font-semibold uppercase tracking-[.08em] text-ink-3">Analysis</span>
      <ol aria-label="Analysis steps" className="m-0 flex flex-none list-none gap-4 whitespace-nowrap p-0">
        {steps.map((label, i) => {
          const done = run > i;
          const active = run === i;
          return (
            <li
              key={label}
              className={cx('flex items-center gap-1.5 transition-colors duration-base', done ? 'text-ink-2' : active ? 'text-ink' : 'text-ink-3')}
            >
              <span
                aria-hidden="true"
                className="box-border grid h-[15px] w-[15px] place-items-center rounded-full text-[9px] font-semibold text-surface transition-all duration-base"
                style={{
                  border: `1.5px solid ${done || active ? 'var(--acc)' : 'var(--line2)'}`,
                  background: done ? 'var(--acc)' : 'transparent',
                }}
              >
                {done ? '✓' : ''}
              </span>
              {label}
              <span className="sr-only">{done ? ' (done)' : active ? ' (in progress)' : ' (to do)'}</span>
            </li>
          );
        })}
      </ol>
      {/* The steps keep their width; the note takes what is left and truncates instead of overlapping them. */}
      <span className="min-w-0 flex-1 truncate pl-2 text-right text-[12px] text-ink-3" title={note}>
        {note}
      </span>
      {onReplay && (
        <button
          type="button"
          onClick={onReplay}
          disabled={!complete}
          className="flex-none whitespace-nowrap rounded-md border border-line-2 bg-surface px-2 py-[3px] text-[11.5px] text-ink-2 disabled:opacity-50"
        >
          Replay analysis
        </button>
      )}
    </div>
  );
}
