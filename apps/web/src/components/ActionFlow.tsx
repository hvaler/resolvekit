import { useEffect, useRef, useState } from 'react';
import { useServices } from '../app/services';
import { checkAgain, sendActionWithReadBack, type ActionPhase, type ActionResult } from '../domain/actionSend';
import { actionTitle, consequenceText, type ActionRequest, type ConfirmationTerms } from '../domain/actions';
import { formatMoney } from '../domain/amounts';
import { outcomeText } from '../domain/inbox';
import { ESCALATION_REVIEW } from '../domain/paypalView';
import type { DisputeGateway } from '../domain/gateway';
import type { GatewayMode } from '../domain/httpGateway';
import type { SubmissionIntent } from '../domain/intent';
import { IntentError, LocalIntentClient, type IntentSource } from '../domain/intentClient';
import type { DisputeMessage, DisputeSnapshot } from '../domain/types';
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

type Accept = { kind: 'accept_claim'; acceptType: string; note: string; amount: { value: string; currency: string } | null };
const acceptOf = (i: SubmissionIntent): Accept | null => (i.payload?.kind === 'accept_claim' ? i.payload : null);
const isPartial = (i: SubmissionIntent) => acceptOf(i)?.acceptType === 'PARTIAL_REFUND';
const isEscalate = (i: SubmissionIntent | null) => i?.payload?.kind === 'escalate';
type Offer = { kind: 'make_offer'; offerType: string; note: string; amount: { value: string; currency: string } | null };
const offerOf = (i: SubmissionIntent | null): Offer | null => (i?.payload?.kind === 'make_offer' ? i.payload : null);
/** PayPal records it as an offer the buyer must accept (W-4; a partial accept too, W-9): never refunded or closed. */
const isOfferToBuyer = (i: SubmissionIntent) => isPartial(i) || !!offerOf(i);
/** What is being sent, in the words of the review and of the pending note. */
const nounOf = (i: SubmissionIntent | null) =>
  i?.payload?.kind === 'accept_claim' ? (isPartial(i) ? 'the partial refund offer' : 'the accept') : isEscalate(i) ? 'the escalation' : offerOf(i) ? 'the offer' : 'the message';

/**
 * The result's title. Recorded: what the proof shows, by action — a full accept is the accepted claim; a partial accept
 * is an offer waiting for the buyer (PayPal records it as an offer, W-9), and so is an offer (W-4): never «refunded» or
 * «closed».
 */
function resultTitle(r: ActionResult, mode: GatewayMode, intent: SubmissionIntent | null = null): string {
  const by = mode.kind === 'paypal' ? 'PayPal' : 'the simulator';
  if (r.kind === 'recorded') {
    const base = `Recorded by ${by}`;
    if (intent && acceptOf(intent)) return `${base}: ${isPartial(intent) ? 'offer waiting for the buyer' : 'claim accepted'}`;
    if (offerOf(intent)) return `${base}: offer waiting for the buyer`;
    if (isEscalate(intent)) return `${base}: inquiry escalated`;
    return base;
  }
  if (r.kind === 'pending') return 'Outcome pending confirmation';
  if (r.kind === 'absent') return `Not recorded by ${by}`;
  return 'Not sent';
}

function title(s: ActionFlowState, mode: GatewayMode): string {
  switch (s.step) {
    case 'composing':
      return 'Composing exactly what will be sent';
    case 'refused':
      return 'Nothing can be sent yet';
    case 'review':
      return acceptOf(s.intent) ? 'Review the accept' : isEscalate(s.intent) ? 'Review the escalation' : offerOf(s.intent) ? 'Review the offer' : 'Review the message';
    case 'confirm':
      return 'Confirm before sending';
    case 'sending':
      return `Sending to ${where(mode)}`;
    case 'needs_review':
      return 'The buyer wrote since you approved this';
    case 'result':
      return resultTitle(s.result, mode, s.intent);
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
  /** What the flow sends, in a few words (the header), before an intent exists. */
  label?: string;
}

/** The message as it will be sent, quoted exactly; for an accept, its type, amount and note. */
function Quoted({ intent }: { intent: SubmissionIntent }) {
  const a = acceptOf(intent);
  if (a) return <AcceptTerms intent={intent} accept={a} />;
  const o = offerOf(intent);
  if (o) {
    const disputed = intent.pin?.amount ?? null;
    return (
      <div data-testid="approved-offer" className="flex flex-col gap-1.5 rounded-xl border border-line bg-surface-2 px-4 py-3 text-body">
        <strong className="font-semibold">{`Refund offered to the buyer: ${o.amount ? formatMoney(o.amount) : '—'}${disputed ? ` of ${formatMoney(disputed)}` : ''}`}</strong>
        <blockquote className="m-0 whitespace-pre-wrap text-body-lg leading-normal [overflow-wrap:anywhere]">{o.note}</blockquote>
      </div>
    );
  }
  if (intent.payload?.kind === 'escalate') {
    return (
      <div data-testid="approved-escalation" className="flex flex-col gap-1.5 rounded-xl border border-line bg-surface-2 px-4 py-3 text-body">
        <strong className="font-semibold">Escalate the inquiry to a claim</strong>
        <blockquote className="m-0 whitespace-pre-wrap text-body-lg leading-normal [overflow-wrap:anywhere]">{intent.payload.note}</blockquote>
      </div>
    );
  }
  const text = intent.payload?.kind === 'send_message' ? intent.payload.text : '';
  return (
    <blockquote data-testid="approved-message" className="m-0 whitespace-pre-wrap rounded-xl border border-line bg-surface-2 px-4 py-3 text-body-lg leading-normal [overflow-wrap:anywhere]">
      {text}
    </blockquote>
  );
}

/** An accept as it will be sent: full refund of the disputed amount, or a partial refund offered; the note, exactly. */
function AcceptTerms({ intent, accept }: { intent: SubmissionIntent; accept: Accept }) {
  const disputed = intent.pin?.amount ?? null;
  return (
    <div data-testid="approved-accept" className="flex flex-col gap-1.5 rounded-xl border border-line bg-surface-2 px-4 py-3 text-body">
      <strong className="font-semibold">
        {accept.acceptType === 'PARTIAL_REFUND'
          ? `Partial refund offered: ${accept.amount ? formatMoney(accept.amount) : '—'}${disputed ? ` of ${formatMoney(disputed)}` : ''}`
          : `Full refund: ${disputed ? formatMoney(disputed) : 'the disputed amount'}`}
      </strong>
      {accept.note ? (
        <blockquote className="m-0 whitespace-pre-wrap text-body-lg leading-normal [overflow-wrap:anywhere]">{accept.note}</blockquote>
      ) : (
        <span className="text-ink-3">No note.</span>
      )}
    </div>
  );
}

/** What PayPal (or the simulator) shows after a recorded full accept: the refund and the outcome, as read. */
function AcceptAftermath({ result }: { result: ActionResult }) {
  const s = result.snapshot;
  if (!s) return null;
  const refunds = (s.refunds ?? []).filter((r) => r.amount);
  if (!refunds.length && !s.outcome) return null;
  return (
    <ul className="m-0 list-none p-0 text-body">
      {refunds.map((r, i) => (
        <li key={r.id ?? i}>{`Refund of ${formatMoney(r.amount!)} shown on the dispute${r.id ? ` (${r.id})` : ''}.`}</li>
      ))}
      {s.outcome && (
        <li>
          {outcomeText(s.outcome.code)} <span className="font-mono text-caption text-ink-3">({s.outcome.code})</span>
        </li>
      )}
    </ul>
  );
}

/**
 * Where a recorded escalation stands, from the read: PayPal reviewing (W-5: UNDER_REVIEW for minutes, links flickering;
 * never closed) or the claim open, with what PayPal offers there.
 */
function escalationText(r: ActionResult): string {
  const s = r.snapshot;
  if (s?.stage && s.stage !== 'INQUIRY') return `The dispute is a claim now (${s.stage}): what you can do next is what PayPal offers on it.`;
  return `${ESCALATION_REVIEW}. Nothing is closed; what you can do next is what PayPal offers on the claim.`;
}

/** The flow's screens, from its state alone (no effects): what each step shows and offers. */
export function ActionFlowView({ state, mode, caseId, busy, error, onApprove, onConfirm, onCheckAgain, onSendAnyway, onEdit, onClose, label }: ActionFlowViewProps) {
  const idx = stepIndex(state);
  const closable = state.step !== 'sending';
  const intent = 'intent' in state ? state.intent : null;
  const what = intent ? actionTitle(intent) : (label ?? 'Send message');
  const isMessage = !intent || intent.payload?.kind === 'send_message';
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--scrim)] px-6 pt-[34px] max-md:px-0 max-md:pt-0">
      <div role="dialog" aria-modal="true" aria-labelledby="action-title" className="flex w-[min(720px,100%)] flex-col overflow-hidden rounded-3xl bg-surface shadow-modal max-md:h-[100dvh] max-md:rounded-none">
        <div className="flex flex-none flex-wrap items-center gap-x-5 gap-y-2 border-b border-line px-[26px] py-4 max-md:px-4">
          <div className="flex flex-col gap-0.5">
            <h2 id="action-title" className="m-0 text-[18px] font-semibold">
              {title(state, mode)}
            </h2>
            <span className="font-mono text-caption leading-[1.3] text-ink-3">
              {caseId} · {what} · {where(mode)}
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
                {state.terms.amount && state.terms.currency && (
                  <span data-testid="confirm-amount">
                    Amount: {state.terms.amount} {state.terms.currency}
                  </span>
                )}
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
              <p className="m-0 text-body text-ink-2">Read the new message first: {isMessage ? 'your message' : nounOf(intent)} may answer an outdated one. Nothing was sent.</p>
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
              <strong className="text-[15px] font-semibold">{resultTitle(state.result, mode, state.intent)}</strong>
              <span className="text-body leading-normal">
                {state.result.kind === 'pending'
                  ? `${state.result.detail}. Nothing more is sent on this dispute until a read-back proves ${nounOf(state.intent)} recorded or absent; it is never sent again blindly.`
                  : state.result.kind === 'recorded' && isOfferToBuyer(state.intent)
                    ? `${mode.kind === 'paypal' ? 'PayPal' : 'The simulator'} shows your offer to the buyer. Unless the buyer accepts it, no money moves and the dispute stays open.`
                    : state.result.kind === 'recorded' && isEscalate(state.intent)
                      ? escalationText(state.result)
                      : state.result.detail}
              </span>
              {state.result.kind === 'recorded' && acceptOf(state.intent) && !isPartial(state.intent) && <AcceptAftermath result={state.result} />}
            </div>
          )}
          {error && (
            <p role="alert" className="m-0 text-body text-bad">
              {error}
            </p>
          )}
        </div>

        <div className="flex flex-none flex-wrap items-center gap-2 border-t border-line px-[26px] py-3.5 max-md:px-4">
          {(state.step === 'review' || state.step === 'confirm' || state.step === 'refused') && <Button onClick={onEdit}>{isMessage ? '← Edit the message' : '← Edit'}</Button>}
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
              <Button onClick={onEdit}>{isMessage ? 'Edit the message' : 'Edit'}</Button>
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

export interface ActionFlowDeps {
  caseId: string;
  request: ActionRequest;
  source: IntentSource;
  gateway: DisputeGateway;
  mode: GatewayMode;
  /** Every state the flow moves to (the view renders it). */
  onState: (s: ActionFlowState) => void;
  audit: (who: string, what: string) => void;
  applySnapshot: (s: DisputeSnapshot) => void;
  /** PayPal (or the simulator) proved the action recorded. */
  onRecorded?: () => void;
  /** Whether the flow is still on screen (answers after it closed are dropped). */
  live?: () => boolean;
  /** The clock the simulator runs on (tests); the real clock otherwise. */
  now?: () => Date;
}

/**
 * The flow's steps, without React: compose against a fresh read → approve the exact hash → confirm the server's terms
 * (when it issues them) → send once → read back; NEEDS_REVIEW → acknowledge the shown keys → send; «Check again» only
 * reads back. ActionFlow renders it; tests drive it directly.
 */
export class ActionFlowController {
  state: ActionFlowState = { step: 'composing' };
  constructor(private readonly d: ActionFlowDeps) {}

  get mode(): GatewayMode {
    return this.d.mode;
  }

  private put(s: ActionFlowState): void {
    if (this.d.live && !this.d.live()) return;
    this.state = s;
    this.d.onState(s);
  }

  async start(): Promise<void> {
    const { caseId, request, source, gateway, mode } = this.d;
    try {
      // A fresh read decides what is possible ([A1]); the server reads PayPal itself.
      const snapshot = mode.kind === 'paypal' ? null : await gateway.getDispute(caseId);
      const i = await source.createAction(caseId, request, { snapshot });
      if ((i.disputeId != null) !== (mode.kind === 'paypal')) {
        this.put({ step: 'refused', detail: 'The PayPal connection changed while you were writing. Close this and open the case again.' });
        return;
      }
      this.put({ step: 'review', intent: i, repeat: !!i.repeat });
    } catch (e) {
      this.put({ step: 'refused', detail: e instanceof IntentError ? `${e.message}${e.code ? ` (${e.code})` : ''}` : errorText(e) });
    }
  }

  private finish(intent: SubmissionIntent, r: ActionResult): void {
    if (r.snapshot) this.d.applySnapshot(r.snapshot);
    // Refusals that ask the person for a step are not an outcome: no re-read entry, the flow asks.
    if (r.kind === 'not_sent' && r.refusal?.code === 'CONFIRMATION_REQUIRED' && r.refusal.terms) return this.put({ step: 'confirm', intent, terms: r.refusal.terms });
    if (r.kind === 'not_sent' && r.refusal?.code === 'NEEDS_REVIEW' && r.refusal.messages) return this.put({ step: 'needs_review', intent, messages: r.refusal.messages, messageKeys: r.refusal.messageKeys ?? [] });
    const outcome = r.kind === 'recorded' ? 'recorded' : r.kind === 'pending' ? 'outcome pending confirmation' : r.kind === 'absent' ? 'not recorded' : `not sent (${r.detail})`;
    this.d.audit(this.d.mode.kind === 'paypal' ? 'PayPal re-read' : 'Simulator re-read', `${actionTitle(intent)} · ${outcome}`);
    if (r.kind === 'recorded') this.d.onRecorded?.();
    this.put({ step: 'result', intent, result: r });
  }

  private async send(intent: SubmissionIntent): Promise<void> {
    const { gateway, source, mode } = this.d;
    this.put({ step: 'sending', intent, phase: null });
    this.d.audit('ResolveKit', `Sending ${intent.action ?? 'provide_evidence'}${mode.kind === 'paypal' ? ` to PayPal ${mode.env}` : ' to the simulator'} · request ${intent.requestId}`);
    const r = await sendActionWithReadBack({ intent, gateway, intents: source, mode, ...(this.d.now ? { now: this.d.now } : {}), onPhase: (p) => this.put({ step: 'sending', intent, phase: p }) });
    this.finish(intent, r);
  }

  async approve(): Promise<void> {
    const s = this.state;
    if (s.step !== 'review') return;
    const { confirmation, ...intent } = await this.d.source.approve(s.intent);
    if (confirmation) this.put({ step: 'confirm', intent, terms: confirmation });
    else await this.send(intent);
  }

  async confirm(): Promise<void> {
    const s = this.state;
    if (s.step !== 'confirm') return;
    const confirmed = await this.d.source.confirm(s.intent, s.terms);
    await this.send({ ...s.intent, ...confirmed });
  }

  async sendAnyway(): Promise<void> {
    const s = this.state;
    if (s.step !== 'needs_review') return;
    const ok = await this.d.source.acknowledge(s.intent, s.messageKeys);
    await this.send({ ...s.intent, ...ok });
  }

  async checkAgain(): Promise<void> {
    const s = this.state;
    if (s.step !== 'result') return;
    const r = await checkAgain({ intent: s.intent, gateway: this.d.gateway, intents: this.d.source, mode: this.d.mode, base: s.result.base, ...(this.d.now ? { now: this.d.now } : {}) });
    this.finish(s.intent, r);
  }
}

/**
 * Send an action (a message, an accept) through the same chain as every action, composed against a fresh read (the
 * server for real PayPal, this browser for the simulator). Real PayPal and the simulator are fixed when the flow opens.
 */
export function ActionFlow({ caseId, request, onClose, onEdit, onRecorded }: { caseId: string; request: ActionRequest; onClose: () => void; onEdit: () => void; onRecorded?: () => void }) {
  const { intents, gatewayFor, modeOf, applySnapshot, addAudit } = useServices();
  const [state, setState] = useState<ActionFlowState>({ step: 'composing' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const [flow] = useState(() => {
    const mode = modeOf(caseId);
    // The server composes and sends only for real PayPal; simulated actions are played in this browser.
    const source: IntentSource = mode.kind === 'paypal' ? intents : browserIntents;
    return new ActionFlowController({
      caseId,
      request,
      source,
      gateway: gatewayFor(caseId),
      mode,
      onState: setState,
      audit: (who, what) => addAudit(caseId, who, what),
      applySnapshot,
      ...(onRecorded ? { onRecorded } : {}),
      live: () => mounted.current,
    });
  });
  useEffect(() => {
    mounted.current = true;
    void flow.start();
    return () => {
      mounted.current = false;
    };
    // Composed once when the flow opens; editing closes it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const step = (f: () => Promise<void>) => () =>
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        await f();
      } catch (e) {
        if (mounted.current) setError(errorText(e));
      } finally {
        if (mounted.current) setBusy(false);
      }
    })();

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
      mode={flow.mode}
      caseId={caseId}
      busy={busy}
      error={error}
      onApprove={step(() => flow.approve())}
      onConfirm={step(() => flow.confirm())}
      onCheckAgain={step(() => flow.checkAgain())}
      onSendAnyway={step(() => flow.sendAnyway())}
      onEdit={onEdit}
      onClose={onClose}
      label={actionTitle(request)}
    />
  );
}
