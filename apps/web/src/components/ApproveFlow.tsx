import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useServices } from '../app/services';
import { allowedActionsAfter } from '../domain/allowedActions';
import { compareSentRecorded } from '../domain/compare';
import { formatCount, notesCountLabel } from '../domain/draft';
import { EVIDENCE_TYPE_LABEL } from '../domain/evidenceTypes';
import { safeRetry, submitWithReadBack, type SendPhase, type SendResult } from '../domain/gateway';
import { quoteFor } from '../domain/quotes';
import { STATUS_DISPLAY, statusExplanation } from '../domain/status';
import { totalSize } from '../domain/submission';
import { utcClock, utcStamp } from '../domain/time';
import type { ActionCode, CaseFile, EvidenceSubmission, SentenceView } from '../domain/types';
import { MERCHANT } from './AppBar';
import { Button, EvidenceTag, Spinner, cx } from './ui';

type Flow = 'review' | 'confirm' | 'sending' | 'error' | 'recorded';

const STEPS = ['Review', 'Confirm', 'Send', 'Recorded by PayPal'] as const;
const FLOW_STEP: Record<Flow, number> = { review: 0, confirm: 1, sending: 2, error: 2, recorded: 3 };
const TITLE: Record<Flow, string> = {
  review: 'Review what will be sent',
  confirm: 'Confirm and submit',
  sending: 'Submitting to PayPal',
  error: 'Submission not confirmed',
  recorded: 'Recorded by PayPal',
};

function newRequestId(): string {
  const hex = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
  return `rk-req-${hex}`;
}

function Stepper({ flow }: { flow: Flow }) {
  const idx = FLOW_STEP[flow];
  return (
    <ol aria-label="Steps" className="m-0 flex list-none items-center gap-2 p-0">
      {STEPS.map((label, i) => {
        const done = i < idx;
        const cur = i === idx;
        return (
          <li
            key={label}
            aria-current={cur ? 'step' : undefined}
            className="flex items-center gap-[7px] text-[12.5px]"
            style={{ color: cur ? 'var(--ink)' : done ? 'var(--ink2)' : 'var(--ink3)' }}
          >
            <span
              aria-hidden="true"
              className="box-border grid h-5 w-5 place-items-center rounded-full text-[10.5px] font-semibold"
              style={{
                border: `1.5px solid ${i <= idx ? 'var(--acc)' : 'var(--line2)'}`,
                background: done ? 'var(--acc)' : cur ? 'var(--acc-soft)' : 'transparent',
                color: done ? 'var(--acc-ink)' : cur ? 'var(--acc)' : 'var(--ink3)',
              }}
            >
              {done ? '✓' : i + 1}
            </span>
            {label}
            {done && <span className="sr-only"> (done)</span>}
            {i < STEPS.length - 1 && <span aria-hidden="true" className="h-px w-[18px] bg-line2" />}
          </li>
        );
      })}
    </ol>
  );
}

function Dl({ children, labelWidth = 118, className }: { children: ReactNode; labelWidth?: number; className?: string }) {
  return (
    <dl className={cx('m-0 grid border-t border-line', className)} style={{ gridTemplateColumns: `${labelWidth}px minmax(0,1fr)` }}>
      {children}
    </dl>
  );
}
function Row({ k, children, ddClass }: { k: string; children: ReactNode; ddClass?: string }) {
  return (
    <>
      <dt className="border-b border-line py-[9px] text-[12.5px] text-ink3">{k}</dt>
      <dd className={cx('m-0 border-b border-line py-[9px]', ddClass)}>{children}</dd>
    </>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return <div className="flex flex-none items-center gap-3 border-t border-line px-[26px] py-3.5">{children}</div>;
}

export interface ApproveFlowProps {
  c: CaseFile;
  views: SentenceView[];
  submission: EvidenceSubmission;
  /** Actions PayPal allowed before sending. */
  actionsBefore: readonly ActionCode[];
  onClose: () => void;
}

/**
 * Approve and send: claim ↔ proof ledger review → irreversible confirmation → sending → PayPal re-read.
 * "Recorded" is only ever shown from the dispute as read back from PayPal.
 */
export function ApproveFlow({ c, views, submission, actionsBefore, onClose }: ApproveFlowProps) {
  const { gateway, applySnapshot, addAudit, audit } = useServices();
  const [flow, setFlow] = useState<Flow>('review');
  const [checked, setChecked] = useState(false);
  const [phase, setPhase] = useState<SendPhase | null>(null);
  const [reached, setReached] = useState<SendPhase[]>([]);
  const [retrying, setRetrying] = useState(false);
  const [approvedAt, setApprovedAt] = useState<Date | null>(null);
  const [result, setResult] = useState<SendResult | null>(null);
  const requestId = useMemo(newRequestId, []);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(true);
  /** After any attempt, every later submission reads the dispute back first (safe retry). */
  const attempted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    headingRef.current?.focus();
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => headingRef.current?.focus(), [flow]);

  const closable = flow !== 'sending';
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && closable) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closable, onClose]);

  const supported = views.filter((v) => v.state === 'supported');
  const removed = views.filter((v) => v.state === 'rejected');
  const id = c.summary.id;
  const digital = !!c.fulfillment.digital;

  const run = async (retry: boolean) => {
    attempted.current = true;
    setFlow('sending');
    setReached([]);
    setPhase(null);
    setRetrying(retry);
    const onPhase = (p: SendPhase) => {
      if (!mounted.current) return;
      setPhase(p);
      setReached((r) => (r.includes(p) ? r : [...r, p]));
      if (p === 'sending') addAudit(id, 'ResolveKit', `Sent provide_evidence · request ${requestId}`);
    };
    const opts = { requestId, onPhase, confirmDelayMs: 900 };
    let r: SendResult;
    try {
      r = retry ? await safeRetry(gateway, submission, opts) : await submitWithReadBack(gateway, submission, opts);
    } catch (e) {
      // The read-back itself failed: we cannot say what PayPal holds, so treat it as unconfirmed.
      const snap = await gateway.getDispute(id).catch(() => null);
      if (!snap) {
        if (mounted.current) setFlow('error');
        return;
      }
      r = { kind: 'not_recorded', snapshot: snap, error: e instanceof Error ? e.message : String(e) };
    }
    applySnapshot(r.snapshot);
    addAudit(
      id,
      'PayPal re-read',
      r.kind === 'recorded' ? `Status ${r.snapshot.status} · evidence stored` : `Status ${r.snapshot.status} · no evidence recorded`,
    );
    if (!mounted.current) return;
    setResult(r);
    setFlow(r.kind === 'recorded' ? 'recorded' : 'error');
  };

  const submit = () => {
    if (!checked) return;
    const now = new Date();
    setApprovedAt(now);
    addAudit(id, MERCHANT.name, 'Approved submission (confirmation checkbox)');
    void run(attempted.current);
  };

  const fileList = submission.files;
  const carrierText = c.fulfillment.carrier === c.fulfillment.carrierLabel ? c.fulfillment.carrier : `${c.fulfillment.carrierLabel}`;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--scrim)] px-6 pt-[34px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="approve-title"
        className="flex h-[min(830px,calc(100vh-68px))] w-[min(1200px,100%)] flex-col overflow-hidden rounded-xl bg-surface shadow-[0_24px_64px_rgba(0,0,0,.28)]"
      >
        <div className="flex flex-none items-center gap-5 border-b border-line px-[26px] py-4">
          <div className="flex flex-col gap-0.5">
            <h2 id="approve-title" ref={headingRef} tabIndex={-1} className="m-0 text-[18px] font-semibold tracking-[-0.01em] outline-none">
              {TITLE[flow]}
            </h2>
            <span className="font-mono text-[11.5px] leading-[1.3] text-ink3">
              {id} · {c.summary.amount} {c.summary.currency}
            </span>
          </div>
          <span className="flex-1" />
          <Stepper flow={flow} />
          {closable && (
            <button type="button" aria-label="Close" onClick={onClose} className="ml-2 h-7 w-7 rounded-md border border-line2 bg-surface text-ink2">
              ×
            </button>
          )}
        </div>

        {flow === 'review' && (
          <>
            <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
              <div className="flex flex-col gap-3.5 overflow-auto border-r border-line px-[26px] pb-6 pt-5">
                <div className="flex items-baseline justify-between">
                  <h3 className="m-0 text-[14px] font-semibold">What your response claims · {supported.length} sentences, each with its proof</h3>
                  <span className="text-[12px] text-ink3">Quoted from the source</span>
                </div>
                <div role="table" aria-label="Claims to be sent" className="overflow-hidden rounded-[9px] border border-line">
                  <div role="row" className="sr-only">
                    <span role="columnheader">Number</span>
                    <span role="columnheader">Claim</span>
                    <span role="columnheader">Proof</span>
                  </div>
                  {supported.map((s, i) => (
                    <div
                      key={s.id}
                      role="row"
                      className="grid grid-cols-[28px_minmax(0,1fr)_minmax(0,1fr)] gap-3.5 border-b border-line px-3.5 py-[11px] shadow-[inset_3px_0_0_var(--ok-line)] last:border-b-0"
                    >
                      <span role="cell" className="font-mono text-[12px] font-medium leading-[22px] text-ink3">
                        {i + 1}
                      </span>
                      <p role="cell" className="text-pretty m-0 text-[14px] leading-normal">
                        {s.text}
                      </p>
                      <div role="cell" className="flex min-w-0 flex-col gap-[5px]">
                        {s.citations.map((ct) => (
                          <div key={ct.evidenceId} className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-2">
                            <EvidenceTag id={ct.evidenceId} size="sm" />
                            <span className="font-mono text-[12px] leading-normal">{quoteFor(c.evidence, ct)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                {removed.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <h3 className="m-0 text-[13px] font-semibold text-bad">Not sent · removed by the analyst</h3>
                    {removed.map((r) => (
                      <div key={r.id} className="flex flex-col gap-1 rounded-lg border border-dashed border-bad-line bg-bad-soft px-3.5 py-2.5">
                        <del className="text-[13.5px] text-ink2 decoration-bad">{r.text}</del>
                        <span className="text-[12.5px] text-bad">{r.reason}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-3.5 overflow-auto bg-surface2 px-[26px] pb-6 pt-5">
                <h3 className="m-0 text-[14px] font-semibold">Exactly what goes to PayPal</h3>
                <Dl>
                  <Row k="Action" ddClass="text-[13.5px] font-medium">
                    Provide evidence <span className="font-mono text-[10.5px] font-normal leading-none text-ink3">provide_evidence</span>
                  </Row>
                  <Row k="Evidence type" ddClass="flex flex-col gap-0.5">
                    <span className="text-[13.5px] font-medium">
                      {EVIDENCE_TYPE_LABEL[submission.evidenceType]}{' '}
                      <span className="font-mono text-[10.5px] font-normal leading-none text-ink3">{submission.evidenceType}</span>
                    </span>
                    {submission.evidenceType === c.requestedEvidenceType ? (
                      <span className="text-[12px] text-ok">✓ Matches what PayPal is asking for</span>
                    ) : (
                      <span className="text-[12px] text-warn">! PayPal is asking for {EVIDENCE_TYPE_LABEL[c.requestedEvidenceType]}</span>
                    )}
                  </Row>
                  <Row k="Carrier" ddClass="font-mono text-[13px] font-medium leading-[1.4]">
                    {carrierText}
                    {carrierText !== submission.carrier && <span className="ml-1.5 text-[10.5px] font-normal text-ink3">{submission.carrier}</span>}
                  </Row>
                  <Row k={digital ? 'Reference' : 'Tracking'} ddClass="font-mono text-[13px] font-medium leading-[1.4]">
                    {submission.tracking}
                  </Row>
                  <Row k="Files" ddClass="flex flex-col gap-1 font-mono text-[12px] leading-[1.4]">
                    {fileList.map((f) => (
                      <span key={f.name}>
                        {f.name} · {f.size}
                      </span>
                    ))}
                  </Row>
                </Dl>
                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between text-[12.5px]">
                    <span className="font-semibold">Notes text, as PayPal will receive it</span>
                    <span className="font-mono text-[12px] font-medium leading-none text-ink2">{notesCountLabel(submission.notes)}</span>
                  </div>
                  <div className="max-h-[230px] overflow-auto rounded-lg border border-line bg-surface px-3.5 py-3 text-[13px] leading-[1.6] text-ink">
                    {submission.notes}
                  </div>
                </div>
              </div>
            </div>
            <Footer>
              <Button onClick={onClose}>← Back to edit</Button>
              <span className="flex-1" />
              <span className="text-[12.5px] text-ink2">Nothing has been sent. Next you confirm.</span>
              <Button variant="primary" onClick={() => setFlow('confirm')}>
                Continue to confirm →
              </Button>
            </Footer>
          </>
        )}

        {flow === 'confirm' && (
          <>
            <div className="flex flex-1 justify-center overflow-auto px-[26px] py-[34px]">
              <div className="flex w-[640px] flex-col gap-5">
                <div role="alert" className="grid grid-cols-[28px_minmax(0,1fr)] gap-3 rounded-[10px] border border-bad-line bg-bad-soft px-[18px] py-4">
                  <span aria-hidden="true" className="grid h-6 w-6 place-items-center rounded-full bg-bad text-[13px] font-bold text-white">
                    !
                  </span>
                  <div className="flex flex-col gap-1">
                    <strong className="text-[15px] font-semibold">This can&apos;t be undone</strong>
                    <span className="text-[14px] leading-normal">
                      Once evidence is submitted, PayPal does not allow submitting evidence again for this dispute. &quot;Provide evidence&quot; will no longer
                      be available.
                    </span>
                  </div>
                </div>
                <Dl labelWidth={150} className="text-[13.5px]">
                  <Row k="Action" ddClass="font-medium">
                    Provide evidence · {EVIDENCE_TYPE_LABEL[submission.evidenceType]}
                  </Row>
                  <Row k={digital ? 'Reference' : 'Tracking'} ddClass="font-mono text-[13px]">
                    {carrierText} · {submission.tracking}
                  </Row>
                  <Row k="Notes">
                    {supported.length} supported sentences · {formatCount(submission.notes.length)} characters
                  </Row>
                  <Row k="Files">
                    {fileList.length} PDF{fileList.length === 1 ? '' : 's'} · {totalSize(fileList)}
                  </Row>
                  <Row k="Not sent" ddClass="text-ink2">
                    {removed.length ? `${removed.length} removed sentence${removed.length > 1 ? 's' : ''} (no supporting evidence)` : 'Nothing removed'}
                  </Row>
                </Dl>
                <label className="grid cursor-pointer grid-cols-[22px_minmax(0,1fr)] items-start gap-2.5 rounded-[10px] border-[1.5px] border-line2 bg-surface2 px-4 py-3.5">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => setChecked(e.target.checked)}
                    className="m-0 mt-0.5 h-[18px] w-[18px] accent-[var(--acc)]"
                  />
                  <span className="text-[14px] leading-normal">
                    I&apos;m <strong>{MERCHANT.name}</strong> and I approve submitting this evidence to PayPal for dispute{' '}
                    <span className="font-mono text-[13px]">{id}</span>.
                  </span>
                </label>
              </div>
            </div>
            <Footer>
              <Button onClick={() => setFlow('review')}>← Back to review</Button>
              <span className="flex-1" />
              <button
                type="button"
                onClick={submit}
                disabled={!checked}
                className="h-[42px] rounded-lg border-0 px-5 text-[14px] font-semibold transition-[background] duration-200"
                style={{
                  background: checked ? 'var(--bad)' : 'var(--line)',
                  color: checked ? '#fff' : 'var(--ink3)',
                  cursor: checked ? 'pointer' : 'not-allowed',
                }}
              >
                Submit evidence to PayPal
              </button>
            </Footer>
          </>
        )}

        {flow === 'sending' && (
          <div className="flex flex-1 items-center justify-center">
            <div className="flex w-[520px] flex-col gap-[18px]">
              <SendProgress approvedAt={approvedAt} phase={phase} reached={reached} retrying={retrying} />
              <span className="pl-8 text-[13px] text-ink2">We only show &quot;Recorded&quot; after reading the dispute back from PayPal.</span>
            </div>
          </div>
        )}

        {flow === 'error' && (
          <div className="flex flex-1 items-center justify-center">
            <div className="flex w-[580px] flex-col gap-4">
              <div role="alert" className="grid grid-cols-[28px_minmax(0,1fr)] gap-3 rounded-[10px] border border-warn-line bg-warn-soft px-[18px] py-4">
                <span aria-hidden="true" className="grid h-6 w-6 place-items-center rounded-full bg-warn text-[13px] font-bold text-surface">
                  !
                </span>
                <div className="flex flex-col gap-[5px]">
                  <strong className="text-[15px] font-semibold">PayPal didn&apos;t confirm the submission</strong>
                  <span className="text-[14px] leading-normal">
                    {result?.kind === 'not_recorded' && /timed out/i.test(result.error) ? 'The request timed out. ' : ''}
                    We read the dispute back from PayPal: <strong>no evidence is recorded</strong>
                    {result ? ` and the status is still ${result.snapshot.status}.` : '.'}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Button variant="primary" className="h-[42px] px-5 text-[14px]" onClick={() => void run(true)}>
                  Retry safely
                </Button>
                <Button className="h-[42px]" onClick={() => setFlow('review')}>
                  Back to review
                </Button>
              </div>
              <span className="text-[12.5px] text-ink2">We read the dispute back before any retry. Evidence is only re-sent if PayPal shows none recorded.</span>
            </div>
          </div>
        )}

        {flow === 'recorded' && result?.kind === 'recorded' && (
          <Recorded result={result} submission={submission} approvedAt={approvedAt} actionsBefore={actionsBefore} audit={[...c.audit, ...(audit[id] ?? [])]} onClose={onClose} />
        )}
      </div>
    </div>
  );
}

function SendProgress({ approvedAt, phase, reached, retrying }: { approvedAt: Date | null; phase: SendPhase | null; reached: SendPhase[]; retrying: boolean }) {
  const items: [string, SendPhase | 'approved'][] = [
    [`Approved by ${MERCHANT.name}${approvedAt ? ` · ${utcClock(approvedAt)} UTC` : ''}`, 'approved'],
    ...(retrying ? ([['Reading the dispute back before retrying', 'checking']] as [string, SendPhase][]) : []),
    ['Sending evidence to PayPal', 'sending'],
    ['Sent. Waiting for PayPal to confirm', 'awaiting'],
    ['Re-reading the dispute from PayPal', 'rereading'],
  ];
  return (
    <ol aria-live="polite" className="m-0 flex list-none flex-col gap-3.5 p-0">
      {items.map(([label, k]) => {
        const act = k === phase;
        const done = k === 'approved' || (reached.includes(k as SendPhase) && !act);
        return (
          <li key={k} className="flex items-center gap-3 text-[15px]" style={{ color: act ? 'var(--ink)' : done ? 'var(--ink2)' : 'var(--ink3)' }}>
            {done && (
              <span aria-hidden="true" className="grid h-5 w-5 place-items-center rounded-full bg-acc text-[11px] font-bold text-acc-ink">
                ✓
              </span>
            )}
            {act && <Spinner />}
            {!done && !act && <span aria-hidden="true" className="box-border h-5 w-5 rounded-full border-[1.5px] border-line2" />}
            {label}
            <span className="sr-only">{done ? ' (done)' : act ? ' (in progress)' : ''}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Recorded({
  result,
  submission,
  approvedAt,
  actionsBefore,
  audit,
  onClose,
}: {
  result: Extract<SendResult, { kind: 'recorded' }>;
  submission: EvidenceSubmission;
  approvedAt: Date | null;
  actionsBefore: readonly ActionCode[];
  audit: { time: string; who: string; what: string }[];
  onClose: () => void;
}) {
  const snap = result.snapshot;
  const cmp = compareSentRecorded(submission, result.recorded, approvedAt ? utcStamp(approvedAt) : '—');
  const allowed = allowedActionsAfter(actionsBefore, snap);
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-[26px] pb-6 pt-5">
        <div role="status" className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 rounded-[10px] border border-ok-line bg-ok-soft px-[18px] py-3.5">
          <span aria-hidden="true" className="grid h-7 w-7 place-items-center rounded-full bg-ok font-bold text-surface">
            ✓
          </span>
          <div className="flex flex-col gap-0.5">
            <strong className="text-[15px] font-semibold">Recorded by PayPal</strong>
            <span className="text-[13px] text-ink2">
              Read back from PayPal at {snap.readAt}. This is what PayPal stored, not what we expect it stored.
            </span>
          </div>
          <div className="flex flex-col items-end gap-0.5 border-l border-ok-line pl-[18px]">
            <span className="text-[11.5px] text-ink3">PayPal status now</span>
            <span className="text-[16px] font-semibold">{STATUS_DISPLAY[snap.status].label}</span>
            <span className="font-mono text-[10.5px] leading-[1.2] text-ink2">{snap.status}</span>
          </div>
        </div>
        <span className="-mt-1.5 text-[13px] text-ink2">{statusExplanation(snap.status)}</span>
        <div className="grid grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] gap-5">
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <h3 className="m-0 text-[14px] font-semibold">Sent vs. recorded by PayPal</h3>
              <span className="text-[12px]" style={{ color: cmp.allMatch ? 'var(--ok)' : 'var(--bad)' }}>
                {cmp.allMatch ? '✓' : '!'} {cmp.matched} of {cmp.total} fields match
              </span>
            </div>
            <div role="table" aria-label="Sent versus recorded" className="overflow-hidden rounded-[9px] border border-line">
              <div role="row" className="grid grid-cols-[120px_minmax(0,1fr)_minmax(0,1fr)_76px] gap-3 border-b border-line bg-surface2 px-3.5 py-2 text-[11.5px] font-medium text-ink3">
                <span role="columnheader">Field</span>
                <span role="columnheader">Sent</span>
                <span role="columnheader">Recorded by PayPal</span>
                <span role="columnheader">Match</span>
              </div>
              {cmp.rows.map((m) => (
                <div key={m.field} role="row" className="grid grid-cols-[120px_minmax(0,1fr)_minmax(0,1fr)_76px] items-start gap-3 border-b border-line px-3.5 py-[9px] last:border-b-0">
                  <span role="cell" className="text-[12.5px] text-ink2">
                    {m.field}
                  </span>
                  <span role="cell" className="whitespace-pre-line [overflow-wrap:anywhere] font-mono text-[12px] leading-normal">
                    {m.sent}
                  </span>
                  <span role="cell" className="whitespace-pre-line [overflow-wrap:anywhere] font-mono text-[12px] font-medium leading-normal">
                    {m.recorded}
                  </span>
                  <span role="cell" className="text-[12px] font-medium" style={{ color: m.match ? 'var(--ok)' : 'var(--bad)' }}>
                    {m.match ? '✓ Match' : '× Differs'}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <h3 className="m-0 text-[14px] font-semibold">Actions PayPal allows now</h3>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {allowed.map((a) => (
                  <li key={a.code} className="grid grid-cols-[16px_minmax(0,1fr)] gap-2 text-[13px]">
                    <span aria-hidden="true" className="font-bold" style={{ color: a.allowed ? 'var(--ok)' : 'var(--ink3)' }}>
                      {a.allowed ? '✓' : '×'}
                    </span>
                    <span className="flex flex-col gap-px">
                      <span style={{ color: a.allowed ? 'var(--ok)' : 'var(--ink3)', textDecoration: a.allowed ? 'none' : 'line-through' }}>
                        {a.label} <span className="font-mono text-[10.5px] leading-none">{a.code}</span>
                        <span className="sr-only">{a.allowed ? ' (allowed)' : ' (not allowed)'}</span>
                      </span>
                      {a.why && <span className="text-[12px] text-ink2">{a.why}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="m-0 text-[14px] font-semibold">Audit log</h3>
              <ol className="m-0 flex list-none flex-col gap-1.5 border-l border-line2 py-0 pl-3 pr-0">
                {audit.map((l, i) => (
                  <li key={i} className="grid grid-cols-[40px_minmax(0,1fr)] gap-2 text-[12.5px] leading-[1.4]">
                    <span className="font-mono text-[11px] leading-[1.6] text-ink3">{l.time}</span>
                    <span>
                      <strong className="font-semibold">{l.who}</strong> · <span className="text-ink2">{l.what}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      </div>
      <Footer>
        <span className="text-[12.5px] text-ink2">
          {result.resent ? 'PayPal showed nothing recorded, so the evidence was sent once more. ' : ''}The case header now shows the status read back from PayPal.
        </span>
        <span className="flex-1" />
        <Button variant="primary" onClick={onClose}>
          Back to case
        </Button>
      </Footer>
    </>
  );
}
