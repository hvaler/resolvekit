import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useServices } from '../app/services';
import { allowedActionsAfter } from '../domain/allowedActions';
import { compareSentRecorded } from '../domain/compare';
import { lockedReason } from '../domain/demoClient';
import { formatCount, notesCountLabel } from '../domain/draft';
import { EVIDENCE_TYPE_LABEL } from '../domain/evidenceTypes';
import { intentSubmission, type IntentRequest, type SubmissionIntent } from '../domain/intent';
import { IntentError, LocalIntentClient, type IntentSource } from '../domain/intentClient';
import { safeRetry, submitWithReadBack, type SendPhase, type SendResult } from '../domain/gateway';
import type { GatewayMode } from '../domain/httpGateway';
import { quoteFor } from '../domain/quotes';
import { STATUS_DISPLAY, statusExplanation } from '../domain/status';
import { totalSize } from '../domain/submission';
import { utcClock, utcStamp } from '../domain/time';
import type { ActionCode, CaseFile, DisputeSnapshot, EvidenceSubmission, SentenceView } from '../domain/types';
import { MERCHANT } from './AppBar';
import { DemoUnlockForm } from './DemoUnlock';
import { Button, EvidenceTag, Spinner, cx } from './ui';

type Flow = 'review' | 'confirm' | 'sending' | 'error' | 'recorded';

const FLOW_STEP: Record<Flow, number> = { review: 0, confirm: 1, sending: 2, error: 2, recorded: 3 };

/** Who records the evidence: real PayPal, or the in-browser simulator. Every "recorded" message says which. */
export function recordedBy(mode: GatewayMode): string {
  return mode.kind === 'paypal' ? 'Recorded by PayPal' : 'Recorded by the PayPal simulator';
}
const steps = (mode: GatewayMode) => ['Review', 'Confirm', 'Send', recordedBy(mode)];
const title = (flow: Flow, mode: GatewayMode): string =>
  ({
    review: 'Review what will be sent',
    confirm: 'Confirm and submit',
    sending: mode.kind === 'paypal' ? `Submitting to PayPal ${mode.env}` : 'Submitting to the PayPal simulator',
    error: 'Submission not confirmed',
    recorded: recordedBy(mode),
  })[flow];

function Stepper({ flow, mode }: { flow: Flow; mode: GatewayMode }) {
  const idx = FLOW_STEP[flow];
  const STEPS = steps(mode);
  return (
    <ol aria-label="Steps" className="m-0 flex list-none items-center gap-2 p-0 max-md:flex-wrap">
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
            {i < STEPS.length - 1 && <span aria-hidden="true" className="h-px w-[18px] bg-line-2" />}
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
      <dt className="border-b border-line py-[9px] text-[12.5px] text-ink-3">{k}</dt>
      <dd className={cx('m-0 border-b border-line py-[9px]', ddClass)}>{children}</dd>
    </>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return <div className="flex flex-none items-center gap-3 border-t border-line px-[26px] py-3.5 max-md:flex-wrap max-md:px-4">{children}</div>;
}

export interface ApproveFlowProps {
  c: CaseFile;
  views: SentenceView[];
  /** What this browser shows; the server composes the intent itself (this is used as is only without a server). */
  submission: EvidenceSubmission;
  /** The merchant's choices: evidence type, edited sentences, contradiction resolutions. */
  request: IntentRequest;
  /** Actions PayPal allowed before sending. */
  actionsBefore: readonly ActionCode[];
  onClose: () => void;
}

type IntentState = { kind: 'loading' } | { kind: 'ready'; intent: SubmissionIntent; source: IntentSource } | { kind: 'error'; code: string; message: string; reasons: string[] };

/** A hosted visitor without the demo code still runs the simulator: its intent is composed in this browser. */
const browserIntents = new LocalIntentClient();

/**
 * Approve and send. The review shows the server's submission intent: what PayPal will receive, composed on the server
 * from its own documents and analysis. Confirming approves that exact content (its hash) on the server, which then
 * sends that intent and nothing else. "Recorded" is only ever shown from the dispute as read back.
 */
export function ApproveFlow(props: ApproveFlowProps) {
  const { intents, modeOf, demo } = useServices();
  const { c, onClose } = props;
  const id = c.summary.id;
  const [mode] = useState(() => modeOf(id));
  const [ix, setIx] = useState<IntentState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // Unlocking the demo while the review waits for the code composes it again.
  const unlocked = !!demo?.unlocked;
  useEffect(() => {
    if (unlocked && ix.kind === 'error' && ix.code === 'DEMO_CODE_REQUIRED') setAttempt((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked]);
  useEffect(() => {
    let live = true;
    setIx({ kind: 'loading' });
    // Real PayPal: always the server. The simulator: the server too, except for a hosted visitor without the code.
    const source = mode.kind === 'simulator' && demo != null && !demo.unlocked ? browserIntents : intents;
    source.create(id, props.request, { submission: props.submission, views: props.views }).then(
      (intent) => {
        if (!live) return;
        // The server decides real PayPal vs simulator the same way the app does; if they disagree, nothing is sent.
        if ((intent.disputeId != null) !== (mode.kind === 'paypal')) {
          setIx({ kind: 'error', code: 'MODE_CHANGED', message: 'The PayPal connection changed while you were reviewing. Close this and open the case again.', reasons: [] });
        } else setIx({ kind: 'ready', intent, source });
      },
      (e: unknown) => {
        if (!live) return;
        setIx({ kind: 'error', code: e instanceof IntentError ? e.code : 'ERROR', message: e instanceof Error ? e.message : String(e), reasons: e instanceof IntentError ? e.reasons : [] });
      },
    );
    return () => {
      live = false;
    };
    // Composed when the flow opens (edits close it first), and again after unlocking.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);
  if (ix.kind === 'ready') return <ApproveIntent {...props} intent={ix.intent} source={ix.source} />;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--scrim)] px-6 pt-[34px] max-md:px-0 max-md:pt-0">
      <div role="dialog" aria-modal="true" aria-labelledby="approve-title" className="flex w-[min(720px,100%)] flex-col overflow-hidden rounded-3xl bg-surface shadow-modal max-md:h-[100dvh] max-md:rounded-none">
        <div className="flex flex-none items-center gap-5 border-b border-line px-[26px] py-4 max-md:px-4">
          <h2 id="approve-title" className="m-0 text-[18px] font-semibold">
            Review what will be sent
          </h2>
          <span className="flex-1" />
          <button type="button" aria-label="Close" onClick={onClose} className="h-7 w-7 rounded-lg border border-line-2 bg-surface text-ink-2">
            ×
          </button>
        </div>
        <div className="flex flex-col gap-3 px-[26px] py-6 max-md:px-4">
          {ix.kind === 'loading' ? (
            <p role="status" className="m-0 flex items-center gap-2.5 text-body text-ink-2">
              <Spinner /> The ResolveKit server is composing exactly what will be sent, from its own copy of the documents and the analysis…
            </p>
          ) : (
            <div role="alert" data-testid="intent-refused" className="flex flex-col gap-2 rounded-2xl border border-bad-line bg-bad-soft px-[18px] py-4">
              <strong className="text-[15px] font-semibold">{ix.code === 'DEMO_CODE_REQUIRED' ? 'Demo code required' : 'Nothing can be sent yet'}</strong>
              <span className="text-body-lg leading-normal">{ix.message}</span>
              {ix.reasons.length > 0 && (
                <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-body text-ink-2">
                  {ix.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
              {ix.code === 'DEMO_CODE_REQUIRED' && <DemoUnlockForm compact />}
            </div>
          )}
        </div>
        <Footer>
          <Button onClick={onClose}>← Back to edit</Button>
          <span className="flex-1" />
          {ix.kind === 'error' && ix.code !== 'DEMO_CODE_REQUIRED' && <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>}
        </Footer>
      </div>
    </div>
  );
}

/** The flow over a composed intent: review → confirm (approve on the server) → send → read back. */
function ApproveIntent({ c, views, intent: composed, source, actionsBefore, onClose }: ApproveFlowProps & { intent: SubmissionIntent; source: IntentSource }) {
  const { gatewayFor, modeOf, applySnapshot, addAudit, audit, demo } = useServices();
  const id = c.summary.id;
  // Decided once when the flow opens: a submission never switches between the simulator and real PayPal mid-way.
  const [{ gateway, mode }] = useState(() => ({ gateway: gatewayFor(id), mode: modeOf(id) }));
  const [intent, setIntent] = useState<SubmissionIntent>(composed);
  // Exactly the intent's content; the real gateway sends only its id.
  const submission = useMemo(() => intentSubmission(composed), [composed]);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [flow, setFlow] = useState<Flow>('review');
  const [checked, setChecked] = useState(false);
  // Hosted demo: real PayPal sends need the demo code (the simulator never does).
  const locked = mode.kind === 'paypal' ? lockedReason(demo, 'evidence') : null;
  const canSubmit = checked && !locked && !approving;
  const [phase, setPhase] = useState<SendPhase | null>(null);
  const [reached, setReached] = useState<SendPhase[]>([]);
  const [retrying, setRetrying] = useState(false);
  const [approvedAt, setApprovedAt] = useState<Date | null>(null);
  const [result, setResult] = useState<SendResult | null>(null);
  // One PayPal-Request-Id per intent, chosen by the server: a retry of the same intent is the same request.
  const requestId = composed.requestId;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(true);
  /** After any attempt, every later submission reads the dispute back first (safe retry). */
  const attempted = useRef(false);
  /** The dispute as read before the first attempt: evidence already on it is never reported as recorded. */
  const baseline = useRef<DisputeSnapshot | null>(null);

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

  // The sentences the server put in the notes, with the proof this screen shows for each.
  const supported = composed.sentences.map((x) => ({ id: x.id, text: x.text, citations: views.find((v) => v.id === x.id)?.citations ?? [] }));
  const removed = views.filter((v) => v.state === 'rejected');
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
      if (p === 'sending') addAudit(id, 'ResolveKit', `Sent provide_evidence${mode.kind === 'paypal' ? ` to PayPal ${mode.env}` : ' to the simulator'} · request ${requestId}`);
    };
    let r: SendResult;
    let base: DisputeSnapshot;
    try {
      // Read the dispute before the first send. If PayPal cannot be read, nothing is sent.
      base = baseline.current ??= await gateway.getDispute(id);
    } catch {
      if (mounted.current) setFlow('error');
      return;
    }
    const opts = { requestId, onPhase, confirmDelayMs: 900, baseline: base, rereads: 3, rereadDelayMs: 2000 };
    try {
      r = retry ? await safeRetry(gateway, submission, opts) : await submitWithReadBack(gateway, submission, opts);
    } catch (e) {
      // The read-back itself failed: we cannot say what PayPal holds, so treat it as unconfirmed.
      const snap = await gateway.getDispute(id).catch(() => null);
      if (!snap) {
        if (mounted.current) setFlow('error');
        return;
      }
      r = { kind: 'not_recorded', snapshot: snap, error: e instanceof Error ? e.message : String(e), baseline: base };
    }
    applySnapshot(r.snapshot);
    addAudit(
      id,
      mode.kind === 'paypal' ? 'PayPal re-read' : 'Simulator re-read',
      r.kind === 'recorded'
        ? `Status ${r.snapshot.status} · evidence stored`
        : r.kind === 'mismatch'
          ? `Status ${r.snapshot.status} · new seller evidence that does not match what was sent (${r.differs.join(', ')})`
          : `Status ${r.snapshot.status} · no evidence recorded`,
    );
    if (!mounted.current) return;
    setResult(r);
    setFlow(r.kind === 'recorded' ? 'recorded' : 'error');
  };

  const submit = async () => {
    if (!canSubmit) return;
    setApproveError(null);
    // Approve exactly this content (its hash) where it is kept; the server records who approved it and when.
    if (intent.status === 'proposed') {
      setApproving(true);
      try {
        const approved = await source.approve(intent);
        if (!mounted.current) return;
        setIntent(approved);
        setApprovedAt(approved.approvedAt ? new Date(approved.approvedAt) : new Date());
        addAudit(id, MERCHANT.name, `Approved intent ${approved.id} · content sha256 ${approved.contentHash.slice(0, 12)}…`);
      } catch (e) {
        if (mounted.current) setApproveError(e instanceof Error ? e.message : String(e));
        return;
      } finally {
        if (mounted.current) setApproving(false);
      }
    }
    void run(attempted.current);
  };

  const fileList = submission.files;
  // Notes-and-documents evidence (OTHER) carries no carrier or tracking.
  const tracked = !!(submission.carrier || submission.tracking);
  const carrierText = c.fulfillment.carrier === c.fulfillment.carrierLabel ? c.fulfillment.carrier : `${c.fulfillment.carrierLabel}`;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--scrim)] px-6 pt-[34px] max-md:px-0 max-md:pt-0">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="approve-title"
        className="flex h-[min(830px,calc(100vh-68px))] w-[min(1200px,100%)] flex-col overflow-hidden rounded-3xl bg-surface shadow-modal max-md:h-[100dvh] max-md:rounded-none"
      >
        <div className="flex flex-none items-center gap-5 border-b border-line px-[26px] py-4 max-md:relative max-md:flex-wrap max-md:gap-x-3 max-md:gap-y-2 max-md:py-3 max-md:pl-4 max-md:pr-14">
          <div className="flex flex-col gap-0.5">
            <h2 id="approve-title" ref={headingRef} tabIndex={-1} className="m-0 text-[18px] font-semibold tracking-[-0.01em] outline-none">
              {title(flow, mode)}
            </h2>
            <span className="font-mono text-caption leading-[1.3] text-ink-3">
              {id} · {c.summary.amount} {c.summary.currency}
            </span>
          </div>
          <span className="flex-1" />
          <Stepper flow={flow} mode={mode} />
          {closable && (
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="ml-2 h-7 w-7 rounded-lg border border-line-2 bg-surface text-ink-2 max-md:absolute max-md:right-4 max-md:top-3 max-md:ml-0"
            >
              ×
            </button>
          )}
        </div>

        {flow === 'review' && (
          <>
            <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] max-md:block max-md:overflow-auto">
              <div className="flex flex-col gap-3.5 overflow-auto border-r border-line px-[26px] pb-6 pt-5 max-md:overflow-visible max-md:border-r-0 max-md:px-4">
                <div className="flex items-baseline justify-between max-md:flex-col max-md:gap-0.5">
                  <h3 className="m-0 text-[14px] font-semibold">What your response claims · {supported.length} sentences, each with its proof</h3>
                  <span className="text-[12px] text-ink-3">Quoted from the source</span>
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
                      className="grid grid-cols-[28px_minmax(0,1fr)_minmax(0,1fr)] gap-3.5 border-b border-line px-3.5 py-[11px] shadow-rule-ok last:border-b-0 max-md:grid-cols-[20px_minmax(0,1fr)] max-md:gap-x-2.5 max-md:gap-y-2 max-md:px-3"
                    >
                      <span role="cell" className="font-mono text-[12px] font-medium leading-[22px] text-ink-3">
                        {i + 1}
                      </span>
                      <p role="cell" className="text-pretty m-0 text-body-lg leading-normal">
                        {s.text}
                      </p>
                      <div role="cell" className="flex min-w-0 flex-col gap-[5px] max-md:col-start-2">
                        {s.citations.map((ct) => (
                          <div key={ct.evidenceId} className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-2">
                            <EvidenceTag id={ct.evidenceId} size="sm" />
                            <span className="font-mono text-mono-frag">{quoteFor(c.evidence, ct)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                {removed.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <h3 className="m-0 text-body font-semibold text-bad">Not sent · removed by the analyst</h3>
                    {removed.map((r) => (
                      <div key={r.id} className="flex flex-col gap-1 rounded-xl border border-dashed border-bad-line bg-bad-soft px-3.5 py-2.5">
                        <del className="text-[13.5px] text-ink-2 decoration-bad">{r.text}</del>
                        <span className="text-[12.5px] text-bad">{r.reason}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-3.5 overflow-auto bg-surface-2 px-[26px] pb-6 pt-5 max-md:overflow-visible max-md:px-4">
                <h3 className="m-0 text-[14px] font-semibold">Exactly what goes to PayPal</h3>
                <p data-testid="intent-provenance" className="m-0 font-mono text-mono-frag leading-[1.5] text-ink-2">
                  {source.kind === 'server' ? 'Composed by the ResolveKit server' : 'Composed in this browser (simulator only)'} · intent {composed.id} · content sha256{' '}
                  {composed.contentHash.slice(0, 12)}…
                </p>
                <Dl>
                  <Row k="Action" ddClass="text-[13.5px] font-medium">
                    Provide evidence <span className="font-mono text-mono-code font-normal leading-none text-ink-3">provide_evidence</span>
                  </Row>
                  <Row k="Evidence type" ddClass="flex flex-col gap-0.5">
                    <span className="text-[13.5px] font-medium">
                      {EVIDENCE_TYPE_LABEL[submission.evidenceType]}{' '}
                      <span className="font-mono text-mono-code font-normal leading-none text-ink-3">{submission.evidenceType}</span>
                    </span>
                    {submission.evidenceType === c.requestedEvidenceType ? (
                      <span className="text-[12px] text-ok">✓ Matches what PayPal is asking for</span>
                    ) : c.requestedEvidenceType ? (
                      <span className="text-[12px] text-warn">! PayPal is asking for {EVIDENCE_TYPE_LABEL[c.requestedEvidenceType]}</span>
                    ) : (
                      <span className="text-[12px] text-warn">! PayPal is not requesting evidence now</span>
                    )}
                  </Row>
                  {tracked && (
                    <>
                      <Row k="Carrier" ddClass="font-mono text-body font-medium leading-[1.4]">
                        {carrierText}
                        {carrierText !== submission.carrier && <span className="ml-1.5 text-[10.5px] font-normal text-ink-3">{submission.carrier}</span>}
                      </Row>
                      <Row k={digital ? 'Reference' : 'Tracking'} ddClass="font-mono text-body font-medium leading-[1.4]">
                        {submission.tracking}
                      </Row>
                    </>
                  )}
                  <Row k="Files" ddClass="flex flex-col gap-1 font-mono text-mono-frag leading-[1.4]">
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
                    <span className="font-mono text-mono-frag font-medium leading-none text-ink-2">{notesCountLabel(submission.notes)}</span>
                  </div>
                  <div className="max-h-[230px] overflow-auto rounded-xl border border-line bg-surface px-3.5 py-3 text-body leading-[1.6] text-ink">
                    {submission.notes}
                  </div>
                </div>
              </div>
            </div>
            <Footer>
              <Button onClick={onClose}>← Back to edit</Button>
              <span className="flex-1" />
              <span className="text-[12.5px] text-ink-2 max-md:order-first max-md:basis-full">Nothing has been sent. Next you confirm.</span>
              <Button variant="primary" onClick={() => setFlow('confirm')}>
                Continue to confirm →
              </Button>
            </Footer>
          </>
        )}

        {flow === 'confirm' && (
          <>
            <div className="flex flex-1 justify-center overflow-auto px-[26px] py-[34px] max-md:px-4 max-md:py-5">
              <div className="flex w-[640px] flex-col gap-5 max-md:w-full">
                <div role="alert" className="grid grid-cols-[28px_minmax(0,1fr)] gap-3 rounded-2xl border border-bad-line bg-bad-soft px-[18px] py-4">
                  <span aria-hidden="true" className="grid h-6 w-6 place-items-center rounded-full bg-bad text-body font-bold text-white">
                    !
                  </span>
                  <div className="flex flex-col gap-1">
                    <strong className="text-[15px] font-semibold">This can&apos;t be undone</strong>
                    <span className="text-body-lg leading-normal">
                      Once evidence is submitted, PayPal does not allow submitting evidence again for this dispute. &quot;Provide evidence&quot; will no longer
                      be available.
                    </span>
                  </div>
                </div>
                <Dl labelWidth={150} className="text-[13.5px] max-md:![grid-template-columns:96px_minmax(0,1fr)]">
                  <Row k="Action" ddClass="font-medium">
                    Provide evidence · {EVIDENCE_TYPE_LABEL[submission.evidenceType]}
                  </Row>
                  {tracked && (
                    <Row k={digital ? 'Reference' : 'Tracking'} ddClass="font-mono text-body">
                      {carrierText} · {submission.tracking}
                    </Row>
                  )}
                  <Row k="Notes">
                    {supported.length} supported sentences · {formatCount(submission.notes.length)} characters
                  </Row>
                  <Row k="Files">
                    {fileList.length} PDF{fileList.length === 1 ? '' : 's'} · {totalSize(fileList)}
                  </Row>
                  <Row k="Not sent" ddClass="text-ink-2">
                    {removed.length ? `${removed.length} removed sentence${removed.length > 1 ? 's' : ''} (no supporting evidence)` : 'Nothing removed'}
                  </Row>
                </Dl>
                {approveError && (
                  <div role="alert" className="rounded-2xl border border-bad-line bg-bad-soft px-4 py-3 text-body">
                    The approval was not recorded, so nothing was sent: {approveError}
                  </div>
                )}
                <label className="grid cursor-pointer grid-cols-[22px_minmax(0,1fr)] items-start gap-2.5 rounded-2xl border-[1.5px] border-line-2 bg-surface-2 px-4 py-3.5">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => setChecked(e.target.checked)}
                    className="m-0 mt-0.5 h-[18px] w-[18px] accent-[var(--acc)]"
                  />
                  <span className="text-body-lg leading-normal">
                    I&apos;m <strong>{MERCHANT.name}</strong> and I approve submitting this evidence to PayPal for dispute{' '}
                    <span className="font-mono text-body">{id}</span>.
                  </span>
                </label>
                {locked && (
                  <div role="note" data-testid="send-locked" className="flex flex-col gap-2.5 rounded-2xl border border-line-2 bg-surface-2 px-4 py-3.5">
                    <strong className="text-[13.5px] font-semibold">Demo code required</strong>
                    <span className="text-body leading-normal text-ink-2">{locked}</span>
                    <DemoUnlockForm compact />
                  </div>
                )}
              </div>
            </div>
            <Footer>
              <Button onClick={() => setFlow('review')}>← Back to review</Button>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!canSubmit}
                title={locked ? `Demo code required: ${locked}` : undefined}
                className="h-[42px] rounded-xl border-0 px-5 text-[14px] font-semibold transition-[background] duration-fast"
                style={{
                  background: canSubmit ? 'var(--bad)' : 'var(--line)',
                  color: canSubmit ? '#fff' : 'var(--ink3)',
                  cursor: canSubmit ? 'pointer' : 'not-allowed',
                }}
              >
                Submit evidence to PayPal
              </button>
            </Footer>
          </>
        )}

        {flow === 'sending' && (
          <div className="flex flex-1 items-center justify-center max-md:px-4">
            <div className="flex w-[520px] flex-col gap-[18px] max-md:w-full">
              <SendProgress approvedAt={approvedAt} phase={phase} reached={reached} retrying={retrying} />
              <span className="pl-8 text-body text-ink-2">
                {mode.kind === 'paypal'
                  ? `Live PayPal ${mode.env}: we only show "Recorded" after reading the dispute back from PayPal.`
                  : 'Simulated PayPal: we only show "Recorded" after reading the dispute back from the simulator.'}
              </span>
            </div>
          </div>
        )}

        {flow === 'error' && result?.kind === 'mismatch' && (
          <div className="flex flex-1 items-center justify-center max-md:px-4">
            <div className="flex w-[580px] flex-col gap-4 max-md:w-full">
              <div role="alert" data-testid="readback-mismatch" className="grid grid-cols-[28px_minmax(0,1fr)] gap-3 rounded-2xl border border-bad-line bg-bad-soft px-[18px] py-4">
                <span aria-hidden="true" className="grid h-6 w-6 place-items-center rounded-full bg-bad text-body font-bold text-white">
                  !
                </span>
                <div className="flex flex-col gap-[5px]">
                  <strong className="text-[15px] font-semibold">New seller evidence that doesn&apos;t match what we sent</strong>
                  <span className="text-body-lg leading-normal">
                    {mode.kind === 'paypal' ? 'PayPal' : 'The simulator'} shows new seller evidence on this dispute, but its {result.differs.join(', ')}{' '}
                    {result.differs.length === 1 ? 'differs' : 'differ'} from this submission. It is not reported as ours, and nothing will be sent again
                    automatically: review the dispute in PayPal before doing anything else.
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Button className="h-[42px]" onClick={onClose}>
                  Back to case
                </Button>
              </div>
            </div>
          </div>
        )}

        {flow === 'error' && result?.kind !== 'mismatch' && (
          <div className="flex flex-1 items-center justify-center max-md:px-4">
            <div className="flex w-[580px] flex-col gap-4 max-md:w-full">
              <div role="alert" className="grid grid-cols-[28px_minmax(0,1fr)] gap-3 rounded-2xl border border-warn-line bg-warn-soft px-[18px] py-4">
                <span aria-hidden="true" className="grid h-6 w-6 place-items-center rounded-full bg-warn text-body font-bold text-surface">
                  !
                </span>
                <div className="flex flex-col gap-[5px]">
                  <strong className="text-[15px] font-semibold">PayPal didn&apos;t confirm the submission</strong>
                  <span className="text-body-lg leading-normal">
                    {result?.kind === 'not_recorded' && /timed out/i.test(result.error) ? 'The request timed out. ' : ''}
                    We read the dispute back from {mode.kind === 'paypal' ? 'PayPal' : 'the simulator'}: <strong>no new evidence from you is recorded</strong>
                    {result ? ` and the status is ${result.snapshot.status}.` : '.'}
                  </span>
                  {result?.kind === 'not_recorded' && !/timed out|no evidence recorded/i.test(result.error) && (
                    <span className="font-mono text-mono-frag text-ink-2">
                      {mode.kind === 'paypal' ? 'PayPal' : 'Simulator'} answered: {result.error}
                    </span>
                  )}
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
              <span className="text-[12.5px] text-ink-2">We read the dispute back before any retry. Evidence is only re-sent if PayPal shows none recorded.</span>
            </div>
          </div>
        )}

        {flow === 'recorded' && result?.kind === 'recorded' && (
          <Recorded mode={mode} result={result} submission={submission} approvedAt={approvedAt} actionsBefore={actionsBefore} audit={[...c.audit, ...(audit[id] ?? [])]} onClose={onClose} />
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
          <li key={k} className={cx('flex items-center gap-3 text-[15px]', act ? 'text-ink' : done ? 'text-ink-2' : 'text-ink-3')}>
            {done && (
              <span aria-hidden="true" className="grid h-5 w-5 place-items-center rounded-full bg-acc text-[11px] font-bold text-acc-ink">
                ✓
              </span>
            )}
            {act && <Spinner />}
            {!done && !act && <span aria-hidden="true" className="box-border h-5 w-5 rounded-full border-[1.5px] border-line-2" />}
            {label}
            <span className="sr-only">{done ? ' (done)' : act ? ' (in progress)' : ''}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Recorded({
  mode,
  result,
  submission,
  approvedAt,
  actionsBefore,
  audit,
  onClose,
}: {
  mode: GatewayMode;
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
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-[26px] pb-6 pt-5 max-md:px-4">
        <div
          role="status"
          className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 rounded-2xl border border-ok-line bg-ok-soft px-[18px] py-3.5 max-md:grid-cols-[auto_minmax(0,1fr)] max-md:gap-3 max-md:px-3.5"
        >
          <span aria-hidden="true" className="grid h-7 w-7 place-items-center rounded-full bg-ok font-bold text-surface">
            ✓
          </span>
          <div className="flex flex-col gap-0.5">
            <strong className="text-[15px] font-semibold">{recordedBy(mode)}</strong>
            <span className="text-body text-ink-2">
              {mode.kind === 'paypal' && snap.origin?.kind === 'paypal'
                ? `Read back from PayPal ${snap.origin.env} (dispute ${snap.origin.disputeId}) at ${snap.readAt}. This is what PayPal stored, not what we expect it stored.`
                : `Read back from the PayPal simulator at ${snap.readAt}. No real PayPal dispute is involved.`}
            </span>
          </div>
          <div className="flex flex-col items-end gap-0.5 border-l border-ok-line pl-[18px] max-md:col-span-2 max-md:items-start max-md:border-l-0 max-md:border-t max-md:pl-0 max-md:pt-2">
            <span className="text-[11.5px] text-ink-3">{mode.kind === 'paypal' ? 'PayPal status now' : 'Simulated status now'}</span>
            <span className="text-[16px] font-semibold">{STATUS_DISPLAY[snap.status].label}</span>
            <span className="font-mono text-mono-code leading-[1.2] text-ink-2">{snap.status}</span>
          </div>
        </div>
        <span className="-mt-1.5 text-body text-ink-2">{statusExplanation(snap.status)}</span>
        <div className="grid grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] gap-5 max-md:grid-cols-1">
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <h3 className="m-0 text-[14px] font-semibold">Sent vs. {mode.kind === 'paypal' ? 'recorded by PayPal' : 'recorded by the simulator'}</h3>
              <span className={cx('text-[12px]', cmp.allMatch ? 'text-ok' : 'text-bad')}>
                {cmp.allMatch ? '✓' : '!'} {cmp.matched} of {cmp.total} fields match
              </span>
            </div>
            <div role="table" aria-label="Sent versus recorded" className="overflow-hidden rounded-[9px] border border-line max-md:overflow-x-auto">
              <div role="row" className="grid grid-cols-[120px_minmax(0,1fr)_minmax(0,1fr)_76px] gap-3 border-b max-md:grid-cols-[72px_minmax(0,1fr)_minmax(0,1fr)_56px] max-md:gap-2 max-md:px-2.5 border-line bg-surface-2 px-3.5 py-2 text-[11.5px] font-medium text-ink-3">
                <span role="columnheader">Field</span>
                <span role="columnheader">Sent</span>
                <span role="columnheader">{mode.kind === 'paypal' ? 'Recorded by PayPal' : 'Recorded (simulator)'}</span>
                <span role="columnheader">Match</span>
              </div>
              {cmp.rows.map((m) => (
                <div key={m.field} role="row" className="grid grid-cols-[120px_minmax(0,1fr)_minmax(0,1fr)_76px] items-start gap-3 border-b max-md:grid-cols-[72px_minmax(0,1fr)_minmax(0,1fr)_56px] max-md:gap-2 max-md:px-2.5 border-line px-3.5 py-[9px] last:border-b-0">
                  <span role="cell" className="text-[12.5px] text-ink-2">
                    {m.field}
                  </span>
                  <span role="cell" className="whitespace-pre-line [overflow-wrap:anywhere] font-mono text-mono-frag">
                    {m.sent}
                  </span>
                  <span role="cell" className="whitespace-pre-line [overflow-wrap:anywhere] font-mono text-mono-frag font-medium">
                    {m.recorded}
                  </span>
                  <span role="cell" className={cx('text-[12px] font-medium', m.match ? 'text-ok' : 'text-bad')}>
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
                  <li key={a.code} className="grid grid-cols-[16px_minmax(0,1fr)] gap-2 text-body">
                    <span aria-hidden="true" className={cx('font-bold', a.allowed ? 'text-ok' : 'text-ink-3')}>
                      {a.allowed ? '✓' : '×'}
                    </span>
                    <span className="flex flex-col gap-px">
                      <span className={a.allowed ? 'text-ok' : 'text-ink-3 line-through'}>
                        {a.label} <span className="font-mono text-mono-code leading-none">{a.code}</span>
                        <span className="sr-only">{a.allowed ? ' (allowed)' : ' (not allowed)'}</span>
                      </span>
                      {a.why && <span className="text-[12px] text-ink-2">{a.why}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="m-0 text-[14px] font-semibold">Audit log</h3>
              <ol className="m-0 flex list-none flex-col gap-1.5 border-l border-line-2 py-0 pl-3 pr-0">
                {audit.map((l, i) => (
                  <li key={i} className="grid grid-cols-[40px_minmax(0,1fr)] gap-2 text-label">
                    <span className="font-mono text-[11px] leading-[1.6] text-ink-3">{l.time}</span>
                    <span>
                      <strong className="font-semibold">{l.who}</strong> · <span className="text-ink-2">{l.what}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      </div>
      <Footer>
        <span className="text-[12.5px] text-ink-2">
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
