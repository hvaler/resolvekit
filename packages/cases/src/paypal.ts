/**
 * A demo case with PayPal's own fields from PayPal: for a case bound to a real dispute, the summary (amount, reason,
 * status, stage, due date, disputed transaction), the evidence PayPal requests and the payment-capture document come
 * from the latest PayPal read; the merchant side (order, documents, notes) stays the demo case's. Before the first
 * read, or when PayPal is unreachable, those fields say so instead of showing demo values.
 *
 * Pure and React-free: the web app shows exactly this, and apps/server builds the analyst's input from it.
 */
import { moneyText } from '../../../apps/web/src/domain/binding.ts';
import { EVIDENCE_TYPE_LABEL } from '../../../apps/web/src/domain/evidenceTypes.ts';
import type { ActionCode, CaseFile, DisputeReason, DisputeSnapshot, Evidence, EvidenceType, TimelineItem } from '../../../apps/web/src/domain/types.ts';

/** Where a case's PayPal fields come from right now. */
export type PayPalSource =
  /** Not bound: demo data and the simulator. */
  | { kind: 'simulated' }
  /** The server has not said yet whether this case is bound. */
  | { kind: 'checking' }
  /** Bound; the first read from PayPal is in flight. */
  | { kind: 'loading' }
  /** Bound; PayPal's data. `failed` is set when the latest read failed and this is the saved (last good) read. */
  | { kind: 'live'; snap: DisputeSnapshot; failed: string | null }
  /** Bound; no PayPal read has succeeded and the last one failed. */
  | { kind: 'unavailable'; error: string };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const pad = (n: number) => String(n).padStart(2, '0');
const parse = (iso: string | null | undefined): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** "28 Oct 2026" (UTC). */
export function utcDate(iso: string | null | undefined): string | null {
  const d = parse(iso);
  return d ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : null;
}

/** "8 Oct 2026 19:30 UTC". */
export function utcDateTime(iso: string | null | undefined): string | null {
  const d = parse(iso);
  return d ? `${utcDate(iso)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC` : null;
}

/** "6 Oct 14:03" (UTC), the timeline's format. */
function dayTime(iso: string | null | undefined): string | null {
  const d = parse(iso);
  return d ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : null;
}

/** Actions PayPal allows now. A bound case allows nothing until PayPal has been read. */
export function caseAllowedActions(source: PayPalSource, simulated: DisputeSnapshot | undefined, demo: readonly ActionCode[]): readonly ActionCode[] {
  if (source.kind === 'simulated') return simulated?.allowedActions ?? demo;
  return source.kind === 'live' ? source.snap.allowedActions : [];
}

const isEvidenceType = (t: string): t is EvidenceType => t in EVIDENCE_TYPE_LABEL;
const KNOWN_REASONS: readonly string[] = ['MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', 'UNAUTHORISED', 'INCORRECT_AMOUNT'];

/** The evidence type PayPal requests now; null when it requests none (e.g. once the seller's evidence is in). */
export function caseRequestedEvidence(source: PayPalSource, demo: EvidenceType | null): EvidenceType | null {
  if (source.kind === 'simulated') return demo;
  if (source.kind !== 'live') return null;
  return (source.snap.requestedEvidence ?? []).find(isEvidenceType) ?? null;
}

/**
 * The case file with PayPal's fields from PayPal (bound case) for the draft rules and the approve flow. Only
 * PayPal-owned summary fields and the requested evidence change; the merchant-side case data stays.
 */
export function withPayPal(c: CaseFile, source: PayPalSource): CaseFile {
  if (source.kind === 'simulated') return c;
  const s = source.kind === 'live' ? source.snap : null;
  return {
    ...c,
    summary: {
      ...c.summary,
      amount: s?.amount ? moneyText(s.amount).split(' ')[0]! : '—',
      currency: s?.amount?.currency ?? '',
      reason: s?.reason && KNOWN_REASONS.includes(s.reason) ? (s.reason as DisputeReason) : c.summary.reason,
      status: s?.status ?? 'OTHER',
      stage: s?.stage ?? null,
      respondBy: s ? utcDate(s.respondBy) : null,
      timeLeft: null,
      transactionId: s?.transaction?.id ?? '—',
      openedAt: s?.createdAt ?? null,
    },
    requestedEvidenceType: caseRequestedEvidence(source, c.requestedEvidenceType),
    requestedNote: s ? 'Requested from seller · read from PayPal' : 'Not read from PayPal yet',
    evidence: c.evidence.map((e) => (e.paypalRecord === 'capture' ? captureEvidence(e, source) : e)),
    timeline: c.timeline.map((t) => captureTimelineItem(t, c.evidence, source)),
  };
}

/** Why a bound case has no PayPal data to show yet. */
function notReadYet(source: Exclude<PayPalSource, { kind: 'simulated' }>): string {
  if (source.kind === 'unavailable') return `Couldn’t reach PayPal (${source.error})`;
  if (source.kind === 'checking') return 'Checking the PayPal connection…';
  return 'Reading PayPal…';
}

/**
 * The payment-capture document of a bound case, built from PayPal's disputed transaction (capture id, gross amount,
 * status, create time) as last read; fragment keys stay so the draft's citations still point at it. Before the
 * first read, or when PayPal is unreachable, it says so instead of showing the demo capture.
 */
export function captureEvidence(e: Evidence, source: Exclude<PayPalSource, { kind: 'simulated' }>): Evidence {
  const frag = (k: string) => `${e.id}.${k}`;
  if (source.kind !== 'live') {
    const why = notReadYet(source);
    return {
      ...e,
      meta: { type: 'Disputed transaction', tag: 'PP', source: 'PayPal', received: '—', hash: '' },
      body: { kind: 'lines', lines: [{ text: `— ${why}`, fragment: frag('id') }] },
    };
  }
  const s = source.snap;
  const tx = s.transaction;
  const env = s.origin?.kind === 'paypal' ? s.origin.env : 'sandbox';
  const disputeId = s.origin?.kind === 'paypal' ? s.origin.disputeId : '';
  const meta = { type: 'Disputed transaction', tag: 'PP', source: `PayPal ${env}${disputeId ? ` · dispute ${disputeId}` : ''}`, received: `read ${s.readAt}`, hash: '' };
  if (!tx) return { ...e, meta, body: { kind: 'lines', lines: [{ text: 'PayPal reports no disputed transaction', fragment: frag('id') }] } };
  const created = utcDateTime(tx.createdAt);
  return {
    ...e,
    meta,
    body: {
      kind: 'lines',
      lines: [
        { text: `Capture ${tx.id}`, fragment: frag('id') },
        { text: [tx.amount ? moneyText(tx.amount) : 'PayPal reports no amount', tx.status ?? null].filter(Boolean).join(' · '), fragment: frag('amt') },
        { text: created ? `Transaction created ${created}` : 'PayPal reports no transaction time', fragment: frag('date') },
      ],
    },
  };
}

/** Timeline events that point at the capture document take its id and time from PayPal too. */
function captureTimelineItem(t: TimelineItem, evidence: readonly Evidence[], source: Exclude<PayPalSource, { kind: 'simulated' }>): TimelineItem {
  if (t.kind !== 'event' || !evidence.some((e) => e.id === t.evidenceId && e.paypalRecord === 'capture')) return t;
  if (source.kind !== 'live') return { ...t, time: '—', sub: notReadYet(source) };
  const tx = source.snap.transaction;
  return { ...t, time: dayTime(tx?.createdAt) ?? '—', sub: tx ? `${tx.id} · from PayPal` : 'PayPal reports no transaction' };
}
