import { useId, useState } from 'react';
import { useHighlight, useHoverHighlight } from '../app/highlight';
import type { Citation, Evidence, SentenceState, SentenceView } from '../domain/types';
import { cx } from './ui';

export const SENTENCE_TONE: Record<SentenceState, { label: string; short: string; icon: string; fg: string; soft: string; /** Left-rule shadow token class. */ rule: string }> = {
  supported: { label: 'Supported', short: 'Supported', icon: '✓', fg: 'var(--ok)', soft: 'var(--ok-soft)', rule: 'shadow-rule-ok' },
  needs_review: { label: 'Needs review', short: 'Needs review', icon: '!', fg: 'var(--warn)', soft: 'var(--warn-soft)', rule: 'shadow-rule-warn' },
  rejected: { label: 'Removed: no supporting evidence', short: 'Removed', icon: '×', fg: 'var(--bad)', soft: 'var(--bad-soft)', rule: 'shadow-rule-bad' },
  checking: { label: 'Re-checking support…', short: 'Re-checking', icon: '…', fg: 'var(--info)', soft: 'var(--info-soft)', rule: 'shadow-rule-info' },
  pending: { label: 'Checking support…', short: 'Checking', icon: '…', fg: 'var(--info)', soft: 'var(--info-soft)', rule: 'shadow-rule-info' },
};

export function citationLabel(c: Citation, evidence: readonly Evidence[]): string {
  const e = evidence.find((x) => x.id === c.evidenceId);
  const base = `${c.evidenceId} · ${e?.short ?? '?'}`;
  if (e?.body.kind === 'receipt' && c.fragments.length) return `${base} · ${c.fragments.map((f) => `#${f.slice(1)}`).join(' ')}`;
  return base;
}

/** Pill linking a claim to its source. Hover or focus lights the cited fragments in the document. */
export function CitationChip({ sentenceId, citation, evidence }: { sentenceId: string; citation: Citation; evidence: readonly Evidence[] }) {
  const { hl } = useHighlight();
  const hover = useHoverHighlight();
  const active = !!hl && hl.sid === sentenceId && hl.ev === citation.evidenceId;
  const title = evidence.find((x) => x.id === citation.evidenceId)?.title ?? citation.evidenceId;
  return (
    <button
      type="button"
      aria-label={`Source ${citation.evidenceId}, ${title}. Focus to highlight the cited text.`}
      aria-pressed={active}
      {...hover({ ev: citation.evidenceId, frags: citation.fragments, sid: sentenceId })}
      className="inline-flex items-center gap-[5px] rounded-full px-2 py-[3px] font-mono text-caption font-medium leading-[1.2] transition-all duration-instant"
      style={{
        border: `1px solid ${active ? 'var(--acc)' : 'var(--acc-line)'}`,
        background: active ? 'var(--acc)' : 'var(--acc-soft)',
        color: active ? 'var(--acc-ink)' : 'var(--acc)',
      }}
    >
      <span aria-hidden="true" className="h-[5px] w-[5px] rounded-full bg-current" />
      {citationLabel(citation, evidence)}
    </button>
  );
}

export interface SentenceRowProps {
  view: SentenceView;
  evidence: readonly Evidence[];
  editing: boolean;
  onEdit: () => void;
  onSave: (text: string) => void;
  onCancel: () => void;
  suggestion?: { label: string; text: string };
  onApplySuggestion?: () => void;
}

export function SentenceRow({ view: s, evidence, editing, onEdit, onSave, onCancel, suggestion, onApplySuggestion }: SentenceRowProps) {
  const { hl } = useHighlight();
  const [draft, setDraft] = useState(s.text);
  const [hidden, setHidden] = useState(false);
  const editId = useId();
  const T = SENTENCE_TONE[s.state];
  const rejected = s.state === 'rejected';
  const hot = !!hl && (hl.sid ? hl.sid === s.id : s.citations.some((c) => c.evidenceId === hl.ev));
  const canEdit = !editing && (s.state === 'supported' || s.state === 'needs_review');
  const showChips = !editing && s.state !== 'pending' && s.citations.length > 0;
  const showReason = !editing && (rejected || s.state === 'needs_review') && !!s.reason;
  const showNote = !editing && !!s.note && s.state !== 'checking';

  return (
    <li
      aria-label={`Sentence ${s.num}: ${T.label}`}
      className={cx('grid grid-cols-[18px_minmax(0,1fr)] gap-2 rounded-lg py-[9px] pl-3 pr-2 transition-[background,box-shadow] duration-base', T.rule, hot && 'bg-hl')}
    >
      <span className="font-mono text-[11px] font-medium leading-5 text-ink-3">{s.num}</span>
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-h-5 items-center gap-1.5">
          <span aria-hidden="true" className="grid h-3.5 w-3.5 place-items-center rounded-full text-[9px] font-bold text-surface" style={{ background: T.fg }}>
            {T.icon}
          </span>
          <span className="text-[11.5px] font-semibold" style={{ color: T.fg }}>
            {T.label}
          </span>
          {s.fromNote && (
            <span className="rounded-sm border border-line-2 px-[6px] py-px text-[10.5px] text-ink-3" title="One of your notes for the response, checked against the evidence like every sentence">
              From your notes
            </span>
          )}
          <span className="flex-1" />
          {suggestion && s.state === 'needs_review' && !editing && (
            <button type="button" onClick={onApplySuggestion} className="rounded-sm border border-warn-line bg-surface px-2 py-0.5 text-[11.5px]">
              {suggestion.label}
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              aria-label={`Edit sentence ${s.num}`}
              onClick={() => {
                setDraft(s.text);
                onEdit();
              }}
              className="rounded-sm border border-line-2 bg-surface px-2 py-0.5 text-[11.5px] text-ink-2"
            >
              Edit
            </button>
          )}
          {rejected && !hidden && (
            <button type="button" onClick={() => setHidden(true)} className="border-0 bg-transparent p-0 text-[11.5px] text-ink-3 underline">
              Hide
            </button>
          )}
        </div>

        {!editing && !(rejected && hidden) && (
          <p className="text-pretty m-0 text-body-lg">
            <span className={cx('rk-strike', rejected ? 'text-ink-3' : 'text-ink')} data-struck={rejected}>
              {s.text}
            </span>
            {rejected && <span className="sr-only"> (removed, will not be sent)</span>}
          </p>
        )}
        {rejected && hidden && (
          <button type="button" onClick={() => setHidden(false)} className="self-start border-0 bg-transparent p-0 text-[12.5px] text-ink-2 underline">
            Show removed sentence
          </button>
        )}

        {editing && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={editId} className="sr-only">
              Edit sentence {s.num}
            </label>
            <textarea
              id={editId}
              rows={3}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="box-border w-full resize-y rounded-lg border border-acc bg-surface px-2.5 py-2 text-body-lg leading-normal"
            />
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={!draft.trim()}
                onClick={() => onSave(draft.trim())}
                className="rounded-md border-0 bg-acc px-2.5 py-[5px] text-[12px] font-medium text-acc-ink disabled:opacity-50"
              >
                Save and re-check
              </button>
              <button type="button" onClick={onCancel} className="rounded-md border border-line-2 bg-surface px-2.5 py-[5px] text-[12px]">
                Cancel
              </button>
              <span className="text-[11.5px] text-ink-3">Edits are checked against the case file again</span>
            </div>
          </div>
        )}

        {showChips && (
          <div className={cx('flex flex-wrap gap-1.5')}>
            {s.citations.map((c) => (
              <CitationChip key={c.evidenceId} sentenceId={s.id} citation={c} evidence={evidence} />
            ))}
          </div>
        )}
        {showReason && (
          <div className="text-label leading-[1.45]" style={{ color: T.fg }}>
            {s.reason}
          </div>
        )}
        {showNote && <div className="text-[11.5px] text-ink-3">{s.note}</div>}
      </div>
    </li>
  );
}
