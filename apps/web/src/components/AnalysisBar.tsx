import { analysisByline } from '@resolvekit/analyst';
import type { AnalysisState } from '../app/useAnalysis';
import type { LiveState } from '../domain/analysisClient';
import { cx } from './ui';

export interface AnalysisLabel {
  text: string;
  /** Longer provenance, shown on hover. */
  title: string;
  live: boolean;
}

/** Who made the analysis on screen, when, and whether it is cached or was just run live. Always says which. */
export function analysisLabel(s: AnalysisState): AnalysisLabel {
  switch (s.kind) {
    case 'ready': {
      const a = s.analysis;
      const live = s.origin === 'live';
      const fallback = !a.model.startsWith(a.requestedModel) ? ` (fallback for ${a.requestedModel})` : '';
      const where =
        s.origin === 'live'
          ? 'run live just now on the ResolveKit server'
          : s.origin === 'cache'
            ? 'a live run cached on this server'
            : s.origin === 'golden'
              ? 'golden analysis committed with the code, served by the server'
              : 'golden analysis committed with the code (no server connected)';
      const tokens = a.usage.inputTokens + a.usage.outputTokens + a.usage.thinkingTokens;
      return {
        text: `${analysisByline(a)}${fallback} · ${live ? 'live' : 'cached'}`,
        title: `Real model output: ${where}. Prompt ${a.promptVersion}. ${a.usage.calls.length} model calls, ${tokens.toLocaleString('en-US')} tokens. Every quote is checked verbatim against the documents.`,
        live,
      };
    }
    case 'running':
      return { text: 'Live analysis running…', title: 'The model is analysing these documents on the ResolveKit server', live: true };
    case 'loading':
      return { text: 'Loading analysis…', title: 'Asking the ResolveKit server for the analysis of these documents', live: false };
    case 'waiting':
      return { text: 'Waiting for PayPal’s data', title: 'The analysis starts once the documents are final', live: false };
    case 'unavailable':
      return { text: 'No analysis', title: s.reason, live: false };
  }
}

export interface AnalysisBarProps {
  steps: string[];
  run: number;
  note: string;
  label: AnalysisLabel;
  /** Shown in place of the note: no analysis, or a refused re-run. */
  problem?: string | null;
  /** Re-play the steps of the analysis on screen (no model call). */
  onReplay?: (() => void) | undefined;
  /** Run the analysis again with the model (rate-limited on the server). */
  onRerun?: (() => void) | undefined;
  rerunBlocked?: string | null;
  live?: LiveState | null;
}

/** "Analysis" strip: the analyst's steps (live progress or replay), who made it, and the replay / re-run controls. */
export function AnalysisBar({ steps, run, note, label, problem, onReplay, onRerun, rerunBlocked, live }: AnalysisBarProps) {
  const complete = run >= steps.length;
  const budget = live?.configured ? ` · ${live.remaining}/${live.limit} live runs left this hour` : '';
  return (
    <div className="flex flex-none flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line bg-surface-2 px-[22px] py-2 text-[12.5px]">
      <span className="text-[10.5px] font-semibold uppercase tracking-[.08em] text-ink-3">Analysis</span>
      <ol aria-label="Analysis steps" className="m-0 flex flex-none list-none gap-4 whitespace-nowrap p-0">
        {steps.map((stepLabel, i) => {
          const done = run > i;
          const active = run === i;
          return (
            <li
              key={i}
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
              {stepLabel}
              <span className="sr-only">{done ? ' (done)' : active ? ' (in progress)' : ' (to do)'}</span>
            </li>
          );
        })}
      </ol>
      {/* The steps keep their width; the note takes what is left and truncates instead of overlapping them. */}
      <span className={cx('min-w-[160px] flex-1 truncate pl-2 text-right text-[12px]', problem ? 'text-warn' : 'text-ink-3')} title={problem ?? note} role={problem ? 'status' : undefined}>
        {problem ?? note}
      </span>
      {/* Provenance and controls stay together; on a narrow window they wrap to a second line instead of clipping. */}
      <span className="ml-auto flex flex-none items-center gap-2">
      <span
        className={cx('flex-none whitespace-nowrap rounded-sm px-[7px] py-0.5 font-mono text-[11px]', label.live ? 'bg-acc-soft text-acc' : 'border border-line-2 bg-surface text-ink-2')}
        title={label.title}
        data-testid="analysis-label"
      >
        {label.text}
      </span>
      {onReplay && (
        <button
          type="button"
          onClick={onReplay}
          disabled={!complete}
          title="Play the steps of this analysis again (no new model call)"
          className="flex-none whitespace-nowrap rounded-md border border-line-2 bg-surface px-2 py-[3px] text-[11.5px] text-ink-2 disabled:opacity-50"
        >
          Replay analysis
        </button>
      )}
      {onRerun && (
        <button
          type="button"
          onClick={onRerun}
          disabled={!!rerunBlocked}
          title={rerunBlocked ?? `Run the analysis again with the model on the ResolveKit server${budget}`}
          className="flex-none whitespace-nowrap rounded-md border border-acc-line bg-surface px-2 py-[3px] text-[11.5px] font-medium text-acc disabled:cursor-not-allowed disabled:opacity-50"
        >
          Re-run with AI
        </button>
      )}
      {onRerun && rerunBlocked?.startsWith('Demo code required') && (
        <span data-testid="rerun-locked" title={rerunBlocked} className="flex-none whitespace-nowrap rounded-sm border border-dashed border-line-2 px-[7px] py-0.5 text-[11px] text-ink-3">
          Demo code required
        </span>
      )}
      </span>
    </div>
  );
}
