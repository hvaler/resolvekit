/**
 * The agent-purchase case's mandate, per-call receipt, settlement and receipt PDF.
 *
 * - Bound to a real dispute and MeterMCP has the session of its disputed capture: those four documents (and the
 *   timeline, the digital-delivery reference and the attachment) are built from the real MeterMCP receipt, labelled
 *   "From MeterMCP · session …".
 * - Otherwise they are the demo case's, labelled "Demo data"; a bound case says why there is no real session.
 *
 * Pure and React-free.
 */
import type { PayPalSource } from './paypal.ts';
import type { AgentReceiptSource, CaseFile, Evidence, MeteredSession, TimelineItem } from '../../../apps/web/src/domain/types.ts';

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
  return fromSession(c, found.session, source);
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

function fromSession(c: CaseFile, s: MeteredSession, source: PayPalSource): CaseFile {
  const cur = s.currency;
  const label = { kind: 'metermcp', text: `From MeterMCP · session ${shortSession(s.sessionId)}`, title: `From MeterMCP · session ${s.sessionId}` } as const;
  const st = s.settlement;
  const captured = st.captured ?? '0.00';
  const released = st.released ?? '—';

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
      headline:
        st.status === 'captured'
          ? `Captured ${captured} of ${s.mandate.cap} ${cur} · remainder released`
          : st.status === 'capture_pending'
            ? `Capture of ${s.totals.charged} ${cur} PENDING at PayPal · not a final charge yet`
            : st.status === 'capture_declined'
              ? `Capture of ${s.totals.charged} ${cur} declined by PayPal · not charged`
              : st.status === 'voided'
            ? `Nothing charged · ${s.mandate.cap} ${cur} authorization voided`
            : `Not settled yet (${st.status})`,
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

  return {
    ...c,
    evidence,
    timeline,
    timelineCaption: `${dayText(s.mandate.approvedAt)} · UTC`,
    fulfillment: { ...c.fulfillment, carrier: 'OTHER', tracking: s.sessionId },
    evidenceTypes: c.evidenceTypes.map((t) =>
      t.type === 'PROOF_OF_FULFILLMENT' ? { ...t, requirement: `Sent as digital delivery: carrier Other, reference ${s.sessionId}` } : t,
    ),
    attachments: [{ name: fileName, size: 'PDF built from the receipt', fromEvidenceId: 'E4' }],
    // The analyst reads these very documents, so the draft is written for this session: no demo-draft notice.
    notice: null,
  };
}
