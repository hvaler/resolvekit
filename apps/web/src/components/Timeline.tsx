import type { ReactNode } from 'react';
import { useHighlight, useHoverHighlight } from '../app/highlight';
import type { Evidence, TimelineItem } from '../domain/types';
import { cx } from './ui';

export function Timeline({
  items,
  caption,
  evidence,
  renderContradiction,
}: {
  items: TimelineItem[];
  caption: string;
  evidence: Evidence[];
  renderContradiction?: (id: string) => ReactNode;
}) {
  const { hl } = useHighlight();
  const hover = useHoverHighlight();
  const short = (id: string) => evidence.find((e) => e.id === id)?.short ?? id;

  return (
    <section aria-label="Timeline" className="flex w-[292px] flex-none flex-col gap-2 overflow-auto border-r border-line px-3.5 pb-7 pt-4">
      <div className="flex items-baseline justify-between px-1">
        <h2 className="m-0 text-[14px] font-semibold">Timeline</h2>
        <span className="text-[12px] text-ink-3">{caption}</span>
      </div>
      <ol className="relative m-0 flex list-none flex-col gap-px p-0">
        <span aria-hidden="true" className="absolute bottom-3.5 left-[18px] top-3.5 w-px bg-line-2" />
        {items.map((t, i) => {
          if (t.kind === 'contradiction') {
            return <li key={`c-${t.contradictionId}`}>{renderContradiction?.(t.contradictionId)}</li>;
          }
          const lit =
            !!hl &&
            !!t.evidenceId &&
            hl.ev === t.evidenceId &&
            (!t.fragment || hl.frags.length === 0 || hl.frags.includes(t.fragment));
          const evLabel = t.evidenceId ? `${t.evidenceId} · ${short(t.evidenceId)}${t.fragment ? ` · #${t.fragment.slice(1)}` : ''}` : 'PayPal record';
          return (
            <li
              key={`${t.time}-${i}`}
              tabIndex={0}
              aria-label={`${t.time} UTC, ${t.title}, ${t.sub}${t.struck ? ' (not charged)' : ''}. Source: ${evLabel}`}
              {...hover(t.evidenceId ? { ev: t.evidenceId, frags: t.fragment ? [t.fragment] : [] } : null)}
              className="relative grid cursor-default grid-cols-[38px_minmax(0,1fr)] gap-1.5 rounded-lg py-[7px] pl-0 pr-1.5 transition-[background] duration-fast"
              style={{ background: lit ? 'var(--hl)' : 'transparent' }}
            >
              <span className="flex justify-center pt-px">
                <span className="w-[30px] rounded-sm border border-line-2 bg-surface py-1 text-center font-mono text-[8.5px] font-medium leading-none text-ink-2">
                  {t.tag}
                </span>
              </span>
              <span className="flex min-w-0 flex-col gap-px">
                <span className="font-mono text-mono-code text-ink-3">{t.time}</span>
                <span className="text-body font-medium leading-[1.3]">{t.title}</span>
                <span className={cx('text-[12px] text-ink-2', t.struck && 'line-through')}>
                  {t.sub}
                </span>
                <span className="font-mono text-mono-code font-medium leading-[1.5] text-acc">{evLabel}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
