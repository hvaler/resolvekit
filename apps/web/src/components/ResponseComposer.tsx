import { useState, type ReactNode } from 'react';
import { useHighlight } from '../app/highlight';
import { useSecondsSince } from '../app/services';
import type { CaseDraft } from '../app/useCaseDraft';
import { NOTES_LIMIT, blockerSentence, draftSummary, notesCountLabel } from '../domain/draft';
import { ACTION_LABEL } from '../domain/status';
import type { ActionCode, CaseFile, DisputeSnapshot } from '../domain/types';
import { evidenceDomId } from './EvidenceCard';
import { EvidenceTypeSelector } from './EvidenceTypeSelector';
import { RecordedEvidence } from './RecordedEvidence';
import { SentenceRow } from './SentenceRow';
import { PrimaryAction, cx } from './ui';

function Attachments({ c }: { c: CaseFile }) {
  const { setHl } = useHighlight();
  const preview = (id: string) => {
    setHl({ ev: id, frags: [] });
    document.getElementById(evidenceDomId(id))?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  return (
    <section aria-label="Attachments" className="flex flex-col gap-[7px]">
      <div className="flex items-baseline justify-between">
        <h3 className="m-0 text-[12.5px] font-semibold">Attachments to send</h3>
        <span className="text-[11.5px] text-ink-3">PDF, JPG, PNG or GIF</span>
      </div>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {c.attachments.map((a) => (
          <li key={a.name} className="grid grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[7px] border border-line px-2.5 py-[7px]">
            <span aria-hidden="true" className="rk-hatch h-[38px] rounded-xs border border-line-2" />
            <span className="flex min-w-0 flex-col gap-px">
              <span className="truncate font-mono text-mono-frag font-medium leading-[1.3]">{a.name}</span>
              <span className="text-[11.5px] text-ink-3">
                From {a.fromEvidenceId} · {a.size}
              </span>
            </span>
            <button
              type="button"
              aria-label={`Show ${a.fromEvidenceId}, the source of ${a.name}`}
              onClick={() => preview(a.fromEvidenceId)}
              onBlur={() => setHl(null)}
              className="rounded-sm border border-line-2 bg-surface px-2 py-[3px] text-[11.5px] text-ink-2"
            >
              Preview
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ActionChoice({
  c,
  d,
  allowed,
  checkedAt,
  sent,
}: {
  c: CaseFile;
  d: CaseDraft;
  allowed: readonly ActionCode[];
  checkedAt: number | null;
  sent: boolean;
}) {
  const secs = useSecondsSince(checkedAt);
  return (
    <section aria-label="Action" className="flex flex-col gap-2">
      <h3 className="m-0 text-[12.5px] font-semibold">What to do</h3>
      {c.recommendation && !sent && (
        <div className="rounded-xl bg-acc-soft px-3 py-2.5 text-label leading-normal text-ink">
          <strong className="font-semibold">{c.recommendation.title}</strong> {c.recommendation.body}
        </div>
      )}
      <div role="radiogroup" aria-label="Action" className="grid grid-cols-2 gap-1.5">
        {allowed.map((code) => {
          const sel = d.action === code;
          const det = c.actionDetails[code];
          return (
            <button
              key={code}
              type="button"
              role="radio"
              aria-checked={sel}
              onClick={() => d.setAction(code)}
              className="flex flex-col gap-0.5 rounded-[7px] px-2.5 py-2 text-left"
              style={{
                border: `1px solid ${sel ? 'var(--acc)' : 'var(--line2)'}`,
                background: sel ? 'var(--acc-soft)' : 'var(--surface)',
              }}
            >
              <span className="text-body font-medium">{det?.label ?? ACTION_LABEL[code]}</span>
              <span className="text-[11.5px] text-ink-3">{det?.sub ?? ''}</span>
              <span className="font-mono text-[10px] leading-[1.4] text-ok">✓ allowed · {code}</span>
            </button>
          );
        })}
      </div>
      <span className="text-[11.5px] text-ink-3">
        {allowed.length
          ? `PayPal allows these ${allowed.length} actions for this dispute right now (read ${secs ?? '?'}s ago). The options change as the dispute moves on.`
          : 'PayPal allows no actions for this dispute right now.'}
      </span>
    </section>
  );
}

function DigitalDelivery({ c }: { c: CaseFile }) {
  const f = c.fulfillment;
  const att = c.attachments[0];
  if (!f.digital) return null;
  const Row = ({ from, label, children, last = false }: { from: string; label: string; children: ReactNode; last?: boolean }) => (
    <div className={`grid grid-cols-[minmax(0,1fr)_18px_minmax(0,1.15fr)] items-center gap-2 px-3 py-2 text-[12.5px] ${last ? '' : 'border-b border-line'}`}>
      <span className="text-ink-2">{from}</span>
      <span aria-hidden="true" className="text-ink-3">
        →
      </span>
      <span>
        <span className="text-[11.5px] text-ink-3">{label}</span>
        <br />
        {children}
      </span>
    </div>
  );
  return (
    <section aria-label="Digital delivery mapping" className="flex flex-col gap-2">
      <h3 className="m-0 text-[12.5px] font-semibold">How this goes to PayPal as digital delivery</h3>
      <div className="overflow-hidden rounded-xl border border-line">
        <Row from={f.digital.sessionLabel} label="Carrier">
          <strong className="font-medium">{f.carrierLabel}</strong> <span className="font-mono text-[10px] leading-none text-ink-3">{f.carrier}</span>
        </Row>
        <Row from="Session ID" label="Tracking / reference">
          <span className="font-mono text-mono-frag font-medium leading-[1.3]">{f.tracking}</span>
        </Row>
        {att && (
          <Row from={`Session receipt (${att.fromEvidenceId})`} label="Attachment" last>
            <span className="[overflow-wrap:anywhere] font-mono text-caption font-medium leading-[1.3]">
              {att.name} · {att.size}
            </span>
          </Row>
        )}
      </div>
      <span className="text-caption leading-[1.45] text-ink-3">{f.digital.note}</span>
    </section>
  );
}

export interface ResponseComposerProps {
  c: CaseFile;
  d: CaseDraft;
  allowedActions: readonly ActionCode[];
  checkedAt: number | null;
  submitted: boolean;
  /** The dispute is on real PayPal (not the simulator): only then does the copy say "recorded by PayPal". */
  realPayPal?: boolean;
  /** The latest read of the dispute: once the seller's evidence is in, what PayPal stored is shown back. */
  snapshot?: DisputeSnapshot;
  onReview: () => void;
}

/** Right zone: the draft with its sentence states, evidence type, attachments, action, and the way forward. */
export function ResponseComposer({ c, d, allowedActions, checkedAt, submitted, realPayPal = false, snapshot, onReview }: ResponseComposerProps) {
  const [collapsed, setCollapsed] = useState(false);
  const busy = d.blockers.some((b) => b.kind === 'analysis' || b.kind === 'checking');
  const actionable = d.actionable;
  const notesLen = d.notes.length;

  let blockText: string;
  let blockColor = 'var(--ink2)';
  let btnLabel: string;
  if (submitted && snapshot?.status === 'RESOLVED') {
    blockText = 'This dispute is closed. The case file is kept read-only.';
    btnLabel = realPayPal ? 'Closed by PayPal' : 'Closed by the simulator';
  } else if (submitted) {
    blockText = 'Evidence was submitted. PayPal no longer offers "Provide evidence" for this dispute.';
    btnLabel = realPayPal ? 'Evidence recorded by PayPal' : 'Evidence recorded by the simulator';
  } else if (actionable.length && !busy) {
    blockText = blockerSentence(actionable);
    blockColor = 'var(--warn)';
    btnLabel = `Resolve ${actionable.length} item${actionable.length > 1 ? 's' : ''} to continue`;
  } else if (busy) {
    blockText = d.analysisComplete ? 'Re-checking against the case file…' : 'Analysis in progress…';
    btnLabel = 'Preparing draft…';
  } else {
    blockText = 'All claims are supported or removed. You review everything before it is sent.';
    btnLabel = 'Review what will be sent →';
  }

  if (collapsed) {
    return (
      <aside
        aria-label="Response draft"
        className="flex w-[52px] flex-none flex-col border-l border-line bg-surface transition-[width] duration-fast max-md:w-full max-md:border-l-0 max-md:border-t"
      >
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label="Expand response draft"
          className="flex flex-1 flex-col items-center gap-3 border-0 bg-transparent pt-4 text-ink-2 max-md:flex-row max-md:py-3 max-md:pl-4"
        >
          <span aria-hidden="true">‹</span>
          <span className="text-body font-medium [writing-mode:vertical-rl] max-md:[writing-mode:horizontal-tb]">
            Response draft · {submitted ? 'sent' : actionable.length ? `${actionable.length} to resolve` : busy ? 'checking' : 'ready'}
          </span>
        </button>
      </aside>
    );
  }

  const isAgent = c.kind === 'agent';
  const alsoAllowed = allowedActions.filter((a) => a !== 'provide_evidence');

  return (
    <aside
      aria-label="Response draft"
      className="flex min-h-0 w-[480px] flex-none flex-col border-l border-line bg-surface transition-[width] duration-fast max-md:w-full max-md:border-l-0 max-md:border-t"
    >
      <div className="flex flex-none flex-col gap-[3px] border-b border-line px-[22px] pb-3 pt-3.5 max-md:px-4">
        <div className="flex items-center gap-2 max-md:flex-wrap">
          <h2 className="m-0 text-[15px] font-semibold">Response draft</h2>
          <span className="text-[12px] text-ink-3">{submitted ? 'Sent · read-only' : 'Drafted by the analyst · you approve'}</span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            aria-label="Collapse response draft"
            className="h-[26px] w-[26px] rounded-md border border-line-2 bg-surface text-ink-2"
          >
            ›
          </button>
        </div>
        <span className="text-[12.5px] text-ink-2" aria-live="polite">
          {draftSummary(d.counts)}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-[22px] overflow-auto pb-[22px] pl-[18px] pr-[22px] pt-2.5 max-md:overflow-visible max-md:px-3">
        {submitted && snapshot && <RecordedEvidence snapshot={snapshot} realPayPal={realPayPal} />}
        <ol aria-label="Draft sentences" className="m-0 flex list-none flex-col gap-1 p-0">
          {d.views.map((v) => {
            const base = c.sentences.find((s) => s.id === v.id);
            const sug = base?.suggestion;
            return (
              <SentenceRow
                key={v.id}
                view={v}
                evidence={c.evidence}
                editing={d.editing === v.id}
                onEdit={() => d.setEditing(v.id)}
                onCancel={() => d.setEditing(null)}
                onSave={(t) => d.saveEdit(v.id, t)}
                {...(sug
                  ? {
                      suggestion: sug,
                      onApplySuggestion: () => d.saveEdit(v.id, sug.text, `Applied the analyst's rephrasing of sentence ${v.num}`),
                    }
                  : {})}
                readOnly={submitted}
              />
            );
          })}
        </ol>

        {!submitted && (
          <EvidenceTypeSelector
            options={d.options}
            selected={d.evidenceType}
            onSelect={d.selectEvidenceType}
            requested={c.requestedEvidenceType}
            requestedNote={c.requestedNote}
          />
        )}

        {isAgent ? (
          <>
            {c.fulfillment.digital ? <DigitalDelivery c={c} /> : !submitted && <Attachments c={c} />}
            <section aria-label="Action" className="flex flex-col gap-1.5">
              <div className="flex justify-between text-[12.5px]">
                <span className="font-semibold">
                  Action · Provide evidence{' '}
                  {allowedActions.includes('provide_evidence') ? (
                    <span className="font-mono text-[10px] font-normal leading-none text-ok">✓ allowed</span>
                  ) : (
                    <span className="font-mono text-[10px] font-normal leading-none text-ink-3">× not allowed now</span>
                  )}
                </span>
                <span className="font-mono text-[12px] text-ink-2">{notesCountLabel(d.notes)}</span>
              </div>
              {alsoAllowed.length > 0 && (
                <span className="text-[11.5px] text-ink-3">
                  Also allowed now:{' '}
                  {alsoAllowed.map((a) => (a === 'accept_claim' ? `accept claim (refund ${c.refundText})` : ACTION_LABEL[a].toLowerCase())).join(', ')}.
                </span>
              )}
            </section>
          </>
        ) : (
          <>
            {!submitted && <Attachments c={c} />}
            <ActionChoice c={c} d={d} allowed={allowedActions} checkedAt={checkedAt} sent={submitted} />
            {!submitted && (
              <section aria-label="Notes length" className="flex flex-col gap-1.5">
                <div className="flex justify-between text-[12.5px]">
                  <span className="font-semibold">Notes sent to PayPal</span>
                  <span className={cx('font-mono text-[12px]', notesLen > NOTES_LIMIT ? 'text-bad' : 'text-ink-2')}>{notesCountLabel(d.notes)}</span>
                </div>
                <div
                  role="meter"
                  aria-label="Notes length"
                  aria-valuemin={0}
                  aria-valuemax={NOTES_LIMIT}
                  aria-valuenow={notesLen}
                  className="h-1 overflow-hidden rounded-[2px] bg-line"
                >
                  <span
                    className="block h-full transition-[width] duration-[400ms]"
                    style={{
                      width: `${Math.min(100, (notesLen / NOTES_LIMIT) * 100)}%`,
                      background: notesLen > NOTES_LIMIT ? 'var(--bad)' : 'var(--acc)',
                    }}
                  />
                </div>
                <span className="text-[11.5px] text-ink-3">Supported sentences only. Removed sentences are never sent.</span>
              </section>
            )}
          </>
        )}
      </div>

      <div className="flex flex-none flex-col gap-2 border-t border-line bg-surface px-[22px] pb-3.5 pt-3 max-md:sticky max-md:bottom-0 max-md:px-4">
        <span className="text-[12px]" style={{ color: blockColor }} aria-live="polite">
          {blockText}
        </span>
        <PrimaryAction enabled={d.ready && !submitted} onClick={onReview}>
          {btnLabel}
        </PrimaryAction>
      </div>
    </aside>
  );
}
