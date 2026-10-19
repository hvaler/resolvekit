/**
 * The agent-purchase case's mandate, per-call receipt, settlement and receipt PDF.
 *
 * - Bound to a real dispute and MeterMCP has the session of its disputed capture: those four documents (and the
 *   timeline, the digital-delivery reference and the attachment) are built from the real MeterMCP receipt, labelled
 *   "From MeterMCP · session …". Nothing the synthetic case asserts stays: its merchant notes, buyer quote, amounts
 *   and recommendation are replaced by the receipt's and PayPal's values or by neutral text. When the server has the
 *   ResolveKit run that opened the session, its record is document E5 (goal, each step's reason, the outcome).
 * - Otherwise they are the demo case's, labelled "Demo data"; a bound case says why there is no real session.
 *
 * Pure and React-free.
 */
import { withPayPal, type PayPalSource } from './paypal.ts';
import { outcomeText, type RunState, type StopReason } from '../../../apps/web/src/domain/agentRun.ts';
import type { AgentReceiptSource, AgentRunSummary, CaseFile, Evidence, MeteredSession, TimelineItem } from '../../../apps/web/src/domain/types.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const pad = (n: number) => String(n).padStart(2, '0');
const date = (iso: string | null | undefined): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};
const clock = (iso: string | null | undefined) => {
  const d = date(iso);
  return d ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` : '—';
};
const dayText = (iso: string | null | undefined) => {
  const d = date(iso);
  return d ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : '—';
};
const stamp = (iso: string | null | undefined) => (date(iso) ? `${dayText(iso)} ${clock(iso).slice(0, 5)} UTC` : '—');
const shortHash = (h: string) => (h.length > 8 ? `${h.slice(0, 4)}…${h.slice(-4)}` : h);
export const shortSession = (id: string) => (id.length > 20 ? `${id.slice(0, 16)}…` : id);
const oneLine = (t: string) => t.replace(/\s+/g, ' ').trim();
const ITEM_TYPES: Readonly<Record<string, string>> = { PRODUCT: 'Physical product', DIGITAL_DOWNLOAD: 'Digital download', SERVICE: 'Service', BOOKING: 'Booking' };

/** The four documents of the agent case that MeterMCP provides. */
export const AGENT_DOCS = ['E1', 'E2', 'E3', 'E4'] as const;


const demoLabel = { kind: 'demo', text: 'Demo data' } as const;

/** The agent-session source of a case right now, or null when the case is simulated / not read yet. */
export function agentReceiptOf(source: PayPalSource): AgentReceiptSource | null {
  return source.kind === 'live' ? (source.snap.agentReceipt ?? null) : null;
}

export function withMeterMcp(c: CaseFile, source: PayPalSource): CaseFile {
  if (c.kind !== 'agent') return c;
  const found = agentReceiptOf(source);
  if (found?.kind !== 'metermcp') return asDemo(c, source, found);
  return fromSession(c, found.session, source, found.run);
}

function asDemo(c: CaseFile, source: PayPalSource, found: AgentReceiptSource | null): CaseFile {
  const evidence = c.evidence.map((e) =>
    (AGENT_DOCS as readonly string[]).includes(e.id) ? { ...e, sourceLabel: demoLabel, caption: e.id === 'E3' ? 'Demo settlement' : e.caption } : e,
  );
  if (source.kind === 'simulated') return { ...c, evidence };
  const why = found?.kind === 'none' ? found.reason : source.kind === 'live' ? 'the server did not report a MeterMCP session' : 'PayPal has not been read yet';
  return {
    ...c,
    evidence,
    notice: { tone: 'warn', text: `No MeterMCP session for this dispute (${why}). The mandate, receipt and settlement below are the demo case’s, not this payment’s.` },
  };
}

function fromSession(demo: CaseFile, s: MeteredSession, source: PayPalSource, run: AgentRunSummary | undefined): CaseFile {
  // PayPal's fields first (idempotent after caseView's own withPayPal): called on its own, the live path must not keep
  // the fixture's amount, transaction or dates either.
  const c = withPayPal(demo, source);
  const cur = s.currency;
  const label = { kind: 'metermcp', text: `From MeterMCP · session ${shortSession(s.sessionId)}`, title: `From MeterMCP · session ${s.sessionId}` } as const;
  const st = s.settlement;
  const captured = st.captured ?? '0.00';
  const released = st.released ?? '—';
  const settledText =
    st.status === 'captured'
      ? `Captured ${captured} of ${s.mandate.cap} ${cur}`
      : st.status === 'capture_pending'
        ? `Capture of ${s.totals.charged} ${cur} PENDING at PayPal · not a final charge yet`
        : st.status === 'capture_declined'
          ? `Capture of ${s.totals.charged} ${cur} declined by PayPal · not charged`
          : st.status === 'voided'
            ? `Nothing charged · ${s.mandate.cap} ${cur} authorization voided`
            : `Not settled yet (${st.status})`;

  const docs: Record<string, Evidence['body']> = {
    E1: {
      kind: 'mandate',
      headline: `Buyer approved a budget of ${s.mandate.cap} ${cur} for agent session`,
      sessionId: s.sessionId,
      rows: [
        { fragment: 'm1', label: 'Session', value: s.sessionId },
        { fragment: 'm2', label: 'Approved', value: `${stamp(s.mandate.approvedAt)} by the buyer in PayPal` },
        { fragment: 'm3', label: 'PayPal order', value: s.mandate.orderId ?? '—' },
        { fragment: 'm4', label: 'Authorization', value: [s.mandate.authorizationId ?? '—', s.mandate.authorizationStatus].filter(Boolean).join(' · ') },
        { fragment: 'm5', label: 'Hard cap', value: `${s.mandate.cap} ${cur} · MeterMCP tools only` },
      ],
    },
    E2: {
      kind: 'receipt',
      currency: cur,
      cap: s.mandate.cap,
      calls: s.calls.map((x) => ({ fragment: `r${x.n}`, n: x.n, time: clock(x.time), tool: x.tool, price: x.price, ok: x.status === 'OK', hash: shortHash(x.requestHash) })),
    },
    E3: {
      kind: 'settlement',
      headline: st.status === 'captured' ? `${settledText} · remainder released` : settledText,
      captured,
      released: st.remainderReleased ? released : '0.00',
      cap: s.mandate.cap,
      rows: [
        { fragment: 's1', label: 'Capture', value: st.captureId ? `${st.captureId} · ${stamp(st.settledAt)}` : '—' },
        st.status === 'captured'
          ? { fragment: 's2', label: 'Captured', value: `${captured} ${cur} (${s.totals.ok} OK call${s.totals.ok === 1 ? '' : 's'})` }
          : { fragment: 's2', label: 'Captured', value: st.status === 'capture_pending' ? `Not final: PayPal reports the capture ${st.captureStatus ?? 'PENDING'}` : `Nothing (${st.status})` },
        { fragment: 's3', label: 'Released', value: st.remainderReleased ? `${released} ${cur} authorization remainder` : 'Not yet' },
      ],
    },
    E4: {
      kind: 'lines',
      lines: [
        { text: `Session ${s.sessionId} · ${s.totals.calls} calls · ${s.totals.ok} charged`, fragment: 'p1' },
        { text: `Total charged ${s.totals.charged} ${cur} of ${s.mandate.cap} ${cur} budget`, fragment: 'p2' },
        { text: 'Each call listed with time, tool, price, status and request hash', fragment: 'p3' },
      ],
    },
  };
  const captions: Record<string, string> = {
    E2: `MeterMCP receipt · sha256 ${shortHash(s.receiptSha256)}`,
    E3: st.captureId ? `PayPal capture · recorded by MeterMCP` : 'MeterMCP',
    E4: 'MeterMCP · PDF of the session receipt',
  };
  const evidence = c.evidence.map((e) => (docs[e.id] ? { ...e, body: docs[e.id]!, caption: captions[e.id] ?? e.caption, sourceLabel: label } : e));
  if (run) evidence.push(runEvidence(run));

  const opened = source.kind === 'live' ? source.snap.createdAt : null;
  const timeline: TimelineItem[] = [
    { kind: 'event', time: clock(s.mandate.approvedAt), title: 'Budget approved', sub: `${s.mandate.cap} ${cur} cap · in PayPal`, tag: 'PP', evidenceId: 'E1' },
    ...s.calls.map(
      (x): TimelineItem => ({
        kind: 'event',
        time: clock(x.time),
        title: x.tool,
        sub: `${x.price} ${cur} · ${x.status === 'OK' ? 'OK' : x.status === 'FAILED' ? 'failed, not charged' : 'in flight'}`,
        tag: 'MCP',
        evidenceId: 'E2',
        fragment: `r${x.n}`,
        struck: x.status !== 'OK',
      }),
    ),
    ...(st.settledAt
      ? [{ kind: 'event', time: clock(st.settledAt), title: 'Settled', sub: st.status === 'captured' ? `Captured ${captured} · ${released} released` : st.status === 'voided' ? 'Authorization voided' : `Not settled (${st.status})`, tag: 'PP', evidenceId: 'E3' } as TimelineItem]
      : []),
    ...(opened ? [{ kind: 'event', time: clock(opened), title: 'Dispute opened', sub: `${dayText(opened)} · read from PayPal`, tag: 'PP', evidenceId: null } as TimelineItem] : []),
  ];

  const fileName = `session-receipt-${s.sessionId}.pdf`;
  // The disputed amount as PayPal reports it (withPayPal above), else what the receipt says was captured.
  const amount = c.summary.amount && c.summary.amount !== '—' && c.summary.currency ? `${c.summary.amount} ${c.summary.currency}` : `${captured} ${cur}`;
  const delivered = s.totals.ok > 0;
  const reasonCode = source.kind === 'live' ? source.snap.reason : null;
  const itemCode = source.kind === 'live' ? source.snap.buyerItemType : null;

  return {
    ...c,
    summary: {
      ...c.summary,
      // PayPal's reason code, not the synthetic buyer quote: ResolveKit does not read the buyer's own words.
      reasonText: reasonCode ? `PayPal reason ${reasonCode} (the buyer’s own words are not read here)` : 'PayPal reports no reason',
      buyerItemType: itemCode ? (ITEM_TYPES[itemCode] ?? itemCode) : 'Not reported by PayPal',
      captureText: settledText,
    },
    // The synthetic notes («All four tool calls completed successfully…») never apply to a real payment.
    merchantNotes: [],
    evidence,
    timeline,
    timelineCaption: `${dayText(s.mandate.approvedAt)} · UTC`,
    fulfillment: { ...c.fulfillment, carrier: 'OTHER', tracking: s.sessionId },
    evidenceTypes: c.evidenceTypes.map((t) =>
      t.type === 'PROOF_OF_FULFILLMENT'
        ? { ...t, requirement: `Sent as digital delivery: carrier Other, reference ${s.sessionId}`, satisfied: delivered }
        : t.type === 'PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED'
          ? { ...t, requirement: `Session receipt with every call (${s.totals.calls} call${s.totals.calls === 1 ? '' : 's'}, ${s.totals.ok} OK)`, satisfied: delivered }
          : t,
    ),
    attachments: [{ name: fileName, size: 'PDF built from the receipt', fromEvidenceId: 'E4' }],
    actionDetails: {
      ...c.actionDetails,
      // The recommendation is the analyst's, from these documents: no action is marked recommended in advance.
      ...(c.actionDetails.provide_evidence ? { provide_evidence: { ...c.actionDetails.provide_evidence, sub: 'Send documents' } } : {}),
      ...(c.actionDetails.accept_claim ? { accept_claim: { ...c.actionDetails.accept_claim, sub: `Refund ${amount}` } } : {}),
    },
    refundText: amount,
    // The analyst reads these very documents, so the draft is written for this session: no demo-draft notice.
    notice: null,
  };
}

const RUN_CAVEAT_SHORT = 'Agent’s own account of its steps · not proof of delivery';
const RUN_CAVEAT = 'The buying agent’s own account of its run, recorded by ResolveKit: its stated reasons and result summaries, not verification and not proof of delivery (the receipt and settlement are MeterMCP’s and PayPal’s records).';

const RUN_STATES: readonly string[] = ['running', 'awaiting_approval', 'done', 'cannot_do', 'out_of_budget', 'stopped', 'model_unavailable', 'not_approved', 'interrupted'];

/** How the run ended, in the /agent page's words: never «done» unless the model finished with done. */
function runOutcome(r: AgentRunSummary): string {
  // The summary does not carry the run's action limit, so the number is left out.
  if (r.outcome === 'stopped' && r.stopReason === 'max_actions') return 'Stopped: action limit reached';
  if (!RUN_STATES.includes(r.outcome)) return `Unknown state (${r.outcome})`;
  // A stop reason this version does not know still says the run stopped, and why.
  return outcomeText({ state: r.outcome as RunState, stopReason: r.stopReason as StopReason | null }) ?? `Stopped (${r.stopReason})`;
}

/**
 * E5: the ResolveKit run record of this session. The goal, the reasons and the summaries are what the model and
 * MeterMCP wrote: the analyst reads them as content like every document, never as instructions.
 */
function runEvidence(r: AgentRunSummary): Evidence {
  const step = (x: AgentRunSummary['steps'][number]) => {
    const said = x.state === 'uncertain' ? `result unknown: ${oneLine(x.summary)}` : x.state === 'pending' ? 'in progress' : oneLine(x.summary);
    return `${x.n} · ${x.tool ?? 'no tool'} · ${oneLine(x.reason)} · ${said}`;
  };
  return {
    id: 'E5',
    short: 'Run record',
    title: 'Agent run record',
    caption: RUN_CAVEAT_SHORT,
    sourceLabel: { kind: 'resolvekit', text: `From ResolveKit · run ${shortSession(r.runId)}`, title: `From ResolveKit · run ${r.runId}` },
    body: {
      kind: 'lines',
      lines: [
        // The caption is not in the analyst's input: the caveat is a line of the document itself.
        { text: RUN_CAVEAT },
        { text: `Goal: ${oneLine(r.goal)}`, fragment: 'g1' },
        ...r.steps.map((x) => ({ text: step(x), fragment: `t${x.n}` })),
        { text: `Outcome: ${runOutcome(r)}`, fragment: 'o1' },
      ],
    },
  };
}
