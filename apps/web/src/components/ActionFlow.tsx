import { useEffect, useRef, useState } from 'react';
import { useServices } from '../app/services';
import { checkAgain, sendActionWithReadBack, type ActionPhase, type ActionResult } from '../domain/actionSend';
import { consequenceText, type ActionRequest, type ConfirmationTerms } from '../domain/actions';
import type { GatewayMode } from '../domain/httpGateway';
import type { SubmissionIntent } from '../domain/intent';
import { IntentError, LocalIntentClient, type IntentSource } from '../domain/intentClient';
import type { DisputeMessage } from '../domain/types';
import { MessageThread } from './MessageThread';
import { Button, Spinner } from './ui';

/** Where the flow is: compose on the server (or in this browser for the simulator) → review → confirm → send → result. */
export type ActionFlowState =
  | { step: 'composing' }
  | { step: 'refused'; detail: string }
  | { step: 'review'; intent: SubmissionIntent; repeat: boolean }
  | { step: 'confirm'; intent: SubmissionIntent; terms: ConfirmationTerms }
  | { step: 'sending'; intent: SubmissionIntent; phase: ActionPhase | null }
  | { step: 'needs_review'; intent: SubmissionIntent; messages: DisputeMessage[]; messageKeys: string[] }
  | { step: 'result'; intent: SubmissionIntent; result: ActionResult };

const STEPS = ['Review', 'Confirm', 'Send', 'Result'] as const;
const stepIndex = (s: ActionFlowState): number =>
  s.step === 'confirm' ? 1 : s.step === 'sending' || s.step === 'needs_review' ? 2 : s.step === 'result' ? 3 : 0;

/** The words of each second-confirmation code, for the person confirming it. */
const CONSEQUENCE_TEXT: Readonly<Record<string, string>> = {
  REPEATS_MESSAGE: 'PayPal already shows this exact message on this dispute. Sending it again posts it a second time: PayPal does not merge repeats.',
};

const where = (mode: GatewayMode) => (mode.kind === 'paypal' ? `PayPal ${mode.env}` : 'the simulator');

function resultTitle(r: ActionResult, mode: GatewayMode): string {
  if (r.kind === 'recorded') return mode.kind === 'paypal' ? 'Recorded by PayPal' : 'Recorded by the simulator';
  if (r.kind === 'pending') return 'Outcome pending confirmation';
  if (r.kind === 'absent') return mode.kind === 'paypal' ? 'Not recorded by PayPal' : 'Not recorded by the simulator';
  return 'Not sent';
}

function title(s: ActionFlowState, mode: GatewayMode): string {
  switch (s.step) {
    case 'composing':
      return 'Review the message';
    case 'refused':
      return 'Nothing can be sent yet';
    case 'review':
      return 'Review the message';
    case 'confirm':
      return 'Confirm before sending';
    case 'sending':
      return `Sending to ${where(mode)}`;
    case 'needs_review':
      return 'The buyer wrote since you approved this';
    case 'result':
      return resultTitle(s.result, mode);
  }
}

export interface ActionFlowViewProps {
  state: ActionFlowState;
  mode: GatewayMode;
  caseId: string;
  /** A request is in flight (approve, confirm, check again): the buttons wait. */
  busy: boolean;
  error?: string | null;
  onApprove: () => void;
  onConfirm: () => void;
  onCheckAgain: () => void;
  onSendAnyway: () => void;
  onEdit: () => void;
  onClose: () => void;
}

/** The message as it will be sent, quoted exactly. */
function Quoted({ intent }: { intent: SubmissionIntent }) {
  const text = intent.payload?.kind === 'send_message' ? intent.payload.text : '';
  return (
    <blockquote data-testid="approved-message" className="m-0 whitespace-pre-wrap rounded-xl border border-line bg-surface-2 px-4 py-3 text-body-lg leading-normal [overflow-wrap:anywhere]">
      {text}
    </blockquote>
  );
}

/** The flow's screens, from its state alone (no effects): what each step shows and offers. */
export function ActionFlowView({ state, mode, caseId, busy, error, onApprove, onConfirm, onCheckAgain, onSendAnyway, onEdit, onClose }: ActionFlowViewProps) {
  const idx = stepIndex(state);
  const closable = state.step !== 'sending';
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--scrim)] px-6 pt-[34px] max-md:px-0 max-md:pt-0">
      <div role="dialog" aria-modal="true" aria-labelledby="action-title" className="flex w-[min(720px,100%)] flex-col overflow-hidden rounded-3xl bg-surface shadow-modal max-md:h-[100dvh] max-md:rounded-none">
        <div className="flex flex-none flex-wrap items-center gap-x-5 gap-y-2 border-b border-line px-[26px] py-4 max-md:px-4">
          <div className="flex flex-col gap-0.5">
            <h2 id="action-title" className="m-0 text-[18px] font-semibold">
              {title(state, mode)}
            </h2>
            <span className="font-mono text-caption leading-[1.3] text-ink-3">
              {caseId} · Send message · {where(mode)}
            </span>
          </div>
          <span className="flex-1" />
          <ol aria-label="Steps" className="m-0 flex list-none items-center gap-2 p-0 text-[12.5px]">
            {STEPS.map((label, i) => (
              <li key={label} aria-current={i === idx ? 'step' : undefined} style={{ color: i === idx ? 'var(--ink)' : i < idx ? 'var(--ink2)' : 'var(--ink3)' }}>
                {i + 1}. {label}
              </li>
            ))}
          </ol>
          {closable && (
            <button type="button" aria-label="Close" onClick={onClose} className="h-7 w-7 rounded-lg border border-line-2 bg-surface text-ink-2">
              ×
            </button>
          )}
        </div>

        <div className="flex flex-col gap-3 overflow-auto px-[26px] py-5 max-md:px-4">
          {state.step === 'composing' && (
            <p role="status" className="m-0 flex items-center gap-2.5 text-body text-ink-2">
              <Spinner /> Reading the dispute and composing exactly what will be sent…
            </p>
          )}
          {state.step === 'refused' && (
            <div role="alert" className="flex flex-col gap-1 rounded-2xl border border-bad-line bg-bad-soft px-[18px] py-4 text-body-lg">
              {state.detail}
            </div>
          )}
          {state.step === 'review' && (
            <>
              <Quoted intent={state.intent} />
              <p className="m-0 text-body text-ink-2">{consequenceText(state.intent)}</p>
              {state.repeat && <p className="m-0 text-body text-warn">PayPal already shows this exact message on this dispute: you will be asked to confirm sending it again.</p>}
              <p className="m-0 font-mono text-caption text-ink-3">Content sha256 {state.intent.contentHash.slice(0, 12)}… · request {state.intent.requestId}</p>
            </>
          )}
          {state.step === 'confirm' && (
            <>
              <Quoted intent={state.intent} />
              <div role="note" className="flex flex-col gap-1 rounded-2xl border border-warn-line bg-warn-soft px-[18px] py-3 text-body">
                <strong className="font-semibold">{CONSEQUENCE_TEXT[state.terms.consequence] ?? consequenceText(state.intent)}</strong>
                <span className="font-mono text-caption text-ink-3">
                  {state.terms.consequence} · intent {state.terms.intentId.slice(0, 12)}… · sha256 {state.terms.contentHash.slice(0, 12)}…
                </span>
              </div>
            </>
          )}
          {state.step === 'sending' && (
            <p role="status" className="m-0 flex items-center gap-2.5 text-body text-ink-2">
              <Spinner />
              {state.phase === 'rereading' ? `Reading the dispute back from ${where(mode)}…` : state.phase === 'reading' ? 'Reading the dispute before sending…' : `Sending to ${where(mode)}…`}
            </p>
          )}
          {state.step === 'needs_review' && (
            <>
              <p className="m-0 text-body text-ink-2">Read the new message first: your message may answer an outdated one. Nothing was sent.</p>
              <MessageThread messages={state.messages} title="New from the buyer" />
              <Quoted intent={state.intent} />
            </>
          )}
          {state.step === 'result' && (
            <div
              role="status"
              className={
                state.result.kind === 'recorded'
                  ? 'flex flex-col gap-1 rounded-2xl border border-ok-line bg-ok-soft px-[18px] py-4'
                  : state.result.kind === 'pending'
                    ? 'flex flex-col gap-1 rounded-2xl border border-warn-line bg-warn-soft px-[18px] py-4'
                    : 'flex flex-col gap-1 rounded-2xl border border-bad-line bg-bad-soft px-[18px] py-4'
              }
            >
              <strong className="text-[15px] font-semibold">{resultTitle(state.result, mode)}</strong>
              <span className="text-body leading-normal">
                {state.result.kind === 'pending'
                  ? `${state.result.detail}. Nothing more is sent on this dispute until a read-back proves the message recorded or absent; it is never sent again blindly.`
                  : state.result.detail}
              </span>
            </div>
          )}
          {error && (
            <p role="alert" className="m-0 text-body text-bad">
              {error}
            </p>
          )}
        </div>

        <div className="flex flex-none flex-wrap items-center gap-2 border-t border-line px-[26px] py-3.5 max-md:px-4">
          {(state.step === 'review' || state.step === 'confirm' || state.step === 'refused') && <Button onClick={onEdit}>← Edit the message</Button>}
          <span className="flex-1" />
          {state.step === 'review' && (
            <Button variant="primary" disabled={busy} onClick={onApprove}>
              Approve and send
            </Button>
          )}
          {state.step === 'confirm' && (
            <Button variant="primary" disabled={busy} onClick={onConfirm}>
              Confirm and send
            </Button>
          )}
          {state.step === 'needs_review' && (
            <>
              <Button onClick={onEdit}>Edit the message</Button>
              <Button variant="primary" disabled={busy} onClick={onSendAnyway}>
                Send it anyway
              </Button>
            </>
          )}
          {state.step === 'result' && state.result.kind === 'pending' && (
            <Button variant="primary" disabled={busy} onClick={onCheckAgain}>
              Check again
            </Button>
          )}
          {state.step === 'result' && <Button onClick={onClose}>Close</Button>}
        </div>
      </div>
    </div>
  );
}

const browserIntents = new LocalIntentClient();
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Send a message through the same chain as every action: composed against a fresh read (the server for real PayPal,
 * this browser for the simulator), approved by its exact hash, confirmed when the server issues terms, sent once, then
 * read back. Real PayPal and the simulator are fixed when the flow opens.
 */
export function ActionFlow({ caseId, request, onClose, onEdit }: { caseId: string; request: ActionRequest; onClose: () => void; onEdit: () => void }) {
  const { intents, gatewayFor, modeOf, applySnapshot, addAudit } = useServices();
  const [{ gateway, mode, source }] = useState(() => {
    const m = modeOf(caseId);
    // The server composes and sends only for real PayPal; simulated actions are played in this browser.
    const s: IntentSource = m.kind === 'paypal' ? intents : browserIntents;
    return { gateway: gatewayFor(caseId), mode: m, source: s };
  });
  const [state, setState] = useState<ActionFlowState>({ step: 'composing' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const safe = (f: () => void) => mounted.current && f();

  useEffect(() => {
    void (async () => {
      try {
        // A fresh read decides what is possible ([A1]); the server reads PayPal itself.
        const snapshot = mode.kind === 'paypal' ? null : await gateway.getDispute(caseId);
        const i = await source.createAction(caseId, request, { snapshot });
        if ((i.disputeId != null) !== (mode.kind === 'paypal')) {
          safe(() => setState({ step: 'refused', detail: 'The PayPal connection changed while you were writing. Close this and open the case again.' }));
          return;
        }
        safe(() => setState({ step: 'review', intent: i, repeat: !!i.repeat }));
      } catch (e) {
        safe(() => setState({ step: 'refused', detail: e instanceof IntentError ? `${e.message}${e.code ? ` (${e.code})` : ''}` : errorText(e) }));
      }
    })();
    // Composed once when the flow opens; editing closes it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = (intent: SubmissionIntent, r: ActionResult) => {
    if (r.snapshot) applySnapshot(r.snapshot);
    addAudit(caseId, mode.kind === 'paypal' ? 'PayPal re-read' : 'Simulator re-read', `Send message · ${r.kind === 'recorded' ? 'recorded' : r.kind === 'pending' ? 'outcome pending confirmation' : r.kind === 'absent' ? 'not recorded' : 'not sent'}`);
    if (r.kind === 'not_sent' && r.refusal?.code === 'CONFIRMATION_REQUIRED' && r.refusal.terms) return setState({ step: 'confirm', intent, terms: r.refusal.terms });
    if (r.kind === 'not_sent' && r.refusal?.code === 'NEEDS_REVIEW' && r.refusal.messages) return setState({ step: 'needs_review', intent, messages: r.refusal.messages, messageKeys: r.refusal.messageKeys ?? [] });
    setState({ step: 'result', intent, result: r });
  };

  const send = async (intent: SubmissionIntent) => {
    setState({ step: 'sending', intent, phase: null });
    addAudit(caseId, 'ResolveKit', `Sent send_message${mode.kind === 'paypal' ? ` to PayPal ${mode.env}` : ' to the simulator'} · request ${intent.requestId}`);
    const r = await sendActionWithReadBack({ intent, gateway, intents: source, mode, onPhase: (p) => safe(() => setState({ step: 'sending', intent, phase: p })) });
    safe(() => finish(intent, r));
  };

  const step = async (f: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      safe(() => setError(errorText(e)));
    } finally {
      safe(() => setBusy(false));
    }
  };

  const onApprove = () =>
    void step(async () => {
      if (state.step !== 'review') return;
      const approved = await source.approve(state.intent);
      const { confirmation, ...intent } = approved;
      if (confirmation) safe(() => setState({ step: 'confirm', intent, terms: confirmation }));
      else await send(intent);
    });
  const onConfirm = () =>
    void step(async () => {
      if (state.step !== 'confirm') return;
      const confirmed = await source.confirm(state.intent, state.terms);
      await send({ ...state.intent, ...confirmed });
    });
  const onSendAnyway = () =>
    void step(async () => {
      if (state.step !== 'needs_review') return;
      const ok = await source.acknowledge(state.intent, state.messageKeys);
      await send({ ...state.intent, ...ok });
    });
  const onCheckAgain = () =>
    void step(async () => {
      if (state.step !== 'result') return;
      const { intent, result } = state;
      const r = await checkAgain({ intent, gateway, intents: source, mode, base: result.base });
      safe(() => finish(intent, r));
    });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && state.step !== 'sending') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.step, onClose]);

  return (
    <ActionFlowView
      state={state}
      mode={mode}
      caseId={caseId}
      busy={busy}
      error={error}
      onApprove={onApprove}
      onConfirm={onConfirm}
      onCheckAgain={onCheckAgain}
      onSendAnyway={onSendAnyway}
      onEdit={onEdit}
      onClose={onClose}
    />
  );
}
