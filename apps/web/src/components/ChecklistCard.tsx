import { checklistSummary } from '../domain/draft';
import type { ChecklistItem, ChecklistState } from '../domain/types';

const LOOK: Record<ChecklistState, { icon: string; label: string; fg: string; bg: string }> = {
  present: { icon: '✓', label: 'Present', fg: 'var(--ok)', bg: 'var(--ok-soft)' },
  resolved: { icon: '✓', label: 'Resolved', fg: 'var(--ok)', bg: 'var(--ok-soft)' },
  contradicts: { icon: '!', label: 'Contradicts', fg: 'var(--warn)', bg: 'var(--warn-soft)' },
  missing: { icon: '×', label: 'Missing', fg: 'var(--bad)', bg: 'var(--bad-soft)' },
};

/** What the dispute reason needs, and whether the case file has it. */
export function ChecklistCard({ title, items, states }: { title: string; items: ChecklistItem[]; states: ChecklistState[] }) {
  return (
    <section aria-label={title} className="flex flex-col gap-[7px] rounded-[10px] border border-line bg-surface px-3.5 py-3">
      <div className="flex items-baseline justify-between">
        <h3 className="m-0 text-[12.5px] font-semibold">{title}</h3>
        <span className="text-[12px] text-ink2">{checklistSummary(states)}</span>
      </div>
      <ul className="m-0 flex list-none flex-col gap-[5px] p-0">
        {items.map((k, i) => {
          const l = LOOK[states[i] ?? 'missing'];
          return (
            <li key={k.label} className="grid grid-cols-[16px_minmax(0,1fr)_auto_100px] items-center gap-2 text-[13px]">
              <span aria-hidden="true" className="grid h-[15px] w-[15px] place-items-center rounded-full text-[9px] font-bold text-surface" style={{ background: l.fg }}>
                {l.icon}
              </span>
              <span>{k.label}</span>
              <span className="font-mono text-[11px] leading-none text-ink3">{k.refs}</span>
              <span className="justify-self-start rounded px-[7px] py-0.5 text-[11.5px] font-medium" style={{ background: l.bg, color: l.fg }}>
                {l.label}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
