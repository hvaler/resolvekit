import { useId, useState } from 'react';
import { useHoverHighlight } from '../app/highlight';
import type { Contradiction, ContradictionResolution } from '../domain/types';
import { MiniButton } from './ui';

export interface ContradictionCardProps {
  contradiction: Contradiction;
  resolution: ContradictionResolution;
  /** False until the analysis has found it (the card fades in). */
  visible: boolean;
  onExplain: () => void;
  onResolve: (note: string) => void;
}

export function ContradictionCard({ contradiction: c, resolution, visible, onExplain, onResolve }: ContradictionCardProps) {
  const hover = useHoverHighlight();
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const noteId = useId();
  const open = resolution.status === 'open';
  const tone = open ? 'var(--warn)' : 'var(--ok)';

  const doneText =
    resolution.status === 'explained'
      ? `Explained in sentence ${resolution.sentenceNum} of the response.`
      : resolution.status === 'resolved'
        ? `Resolved by ${resolution.by}: "${resolution.note}"`
        : '';

  return (
    <div
      role="group"
      aria-label={`Contradiction: ${c.title}. ${open ? 'Needs review' : 'Resolved'}`}
      aria-hidden={!visible}
      className="relative mx-0 my-1.5 ml-2 flex flex-col gap-2 rounded-lg px-3 py-2.5 transition-[opacity,transform,background] duration-500"
      style={{
        background: open ? 'var(--warn-soft)' : 'var(--surface)',
        border: `1px solid ${open ? 'var(--warn-line)' : 'var(--ok-line)'}`,
        opacity: visible ? 1 : 0,
        transform: `translateY(${visible ? 0 : 6}px)`,
        visibility: visible ? 'visible' : 'hidden',
      }}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="h-2 w-2 rotate-45" style={{ background: tone }} />
        <span className="text-[10.5px] font-semibold uppercase tracking-[.07em]" style={{ color: tone }}>
          Contradiction
        </span>
        <span className="flex-1" />
        <span className="text-[11.5px] font-medium" style={{ color: tone }}>
          {open ? 'Needs review' : 'Resolved'}
        </span>
      </div>
      <div className="text-[13px] font-medium leading-[1.35]">{c.title}</div>
      <div className="grid grid-cols-2 gap-1.5">
        {[c.a, c.b].map((side) => (
          <button
            key={side.evidenceId}
            type="button"
            aria-label={`${side.label}: ${side.value}. Highlight in the source.`}
            {...hover({ ev: side.evidenceId, frags: [side.fragment] })}
            className="flex flex-col gap-0.5 rounded-md border border-line2 bg-surface px-2 py-1.5 text-left"
          >
            <span className="font-mono text-[10px] font-medium leading-[1.2] text-ink3">{side.label}</span>
            <span className="font-mono text-[12.5px] font-semibold leading-[1.3]">{side.value}</span>
          </button>
        ))}
      </div>
      <div className="text-[12px] leading-[1.4] text-ink2">{c.assessment}</div>
      {open && !noteOpen && (
        <div className="flex flex-wrap gap-1.5">
          <MiniButton onClick={onExplain} className="border-warn-line font-medium text-ink">
            Explain in response
          </MiniButton>
          <MiniButton onClick={() => setNoteOpen(true)}>Mark resolved…</MiniButton>
        </div>
      )}
      {open && noteOpen && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={noteId} className="text-[11.5px] text-ink2">
            Note (saved to the audit log)
          </label>
          <textarea
            id={noteId}
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="box-border block w-full resize-y rounded-[5px] border border-line2 bg-surface px-2 py-1.5 text-[12.5px]"
          />
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={!note.trim()}
              onClick={() => {
                if (note.trim()) {
                  onResolve(note.trim());
                  setNoteOpen(false);
                }
              }}
              className="rounded-[5px] border-0 bg-acc px-2.5 py-[5px] text-[12px] font-medium text-acc-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              Resolve with note
            </button>
            <MiniButton onClick={() => setNoteOpen(false)} className="text-ink">
              Cancel
            </MiniButton>
          </div>
        </div>
      )}
      {!open && (
        <div className="flex gap-1.5 text-[12px] text-ok">
          <span aria-hidden="true">✓</span>
          <span>{doneText}</span>
        </div>
      )}
    </div>
  );
}
