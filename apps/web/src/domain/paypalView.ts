/**
 * What the case header and the inbox show for PayPal's own fields (amount, reason, item type, stage, status, due
 * date, disputed transaction, requested evidence, allowed actions).
 *
 * - A simulated case shows its demo data, updated by the simulator.
 * - A case bound to a real dispute shows PayPal's data only: from the latest PayPal read, or "—" with the reason
 *   (still reading, PayPal unreachable). It never falls back to the demo case's values for these fields. The demo
 *   case keeps only the merchant side: order, documents, timeline, the analyst's draft.
 *
 * Pure and React-free, so the rules are tested directly.
 */
import { bindingMismatch, moneyText } from './binding';
import { EVIDENCE_TYPE_LABEL } from './evidenceTypes';
import type { GatewayMode } from './httpGateway';
import { dueHours, formatDue, formatDueAt, type InboxDispute } from './inbox';
import { hasSellerEvidence } from './recorded';
import type { ActionCode, CaseFile, DisputeReason, DisputeSnapshot, DisputeStatus, DisputeSummary, Evidence, EvidenceType, TimelineItem } from './types';

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

/**
 * @param mode null while the server's PayPal connection is being checked.
 * @param snap the latest snapshot held for the case (from either gateway); only a PayPal-origin one counts when bound.
 * @param readError why the latest read of this case failed, if it did.
 */
export function payPalSource(mode: GatewayMode | null, snap: DisputeSnapshot | undefined, readError?: string | null): PayPalSource {
  if (!mode) return { kind: 'checking' };
  if (mode.kind === 'simulator') return { kind: 'simulated' };
  const real = snap?.origin?.kind === 'paypal' ? snap : null;
  if (real) return { kind: 'live', snap: real, failed: readError ?? null };
  return readError ? { kind: 'unavailable', error: readError } : { kind: 'loading' };
}

export const isBound = (s: PayPalSource) => s.kind === 'loading' || s.kind === 'live' || s.kind === 'unavailable';

// ---------------------------------------------------------------------------------------------
// Labels for PayPal codes

const REASONS: Readonly<Record<string, { long: string; short: string }>> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: { long: 'Buyer says the item was not received', short: 'Item not received' },
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: { long: 'Buyer says the item is not as described', short: 'Item not as described' },
  UNAUTHORISED: { long: 'Buyer doesn’t recognise the payment', short: 'Buyer doesn’t recognise the payment' },
  CREDIT_NOT_PROCESSED: { long: 'Buyer says a refund or credit was not processed', short: 'Credit not processed' },
  DUPLICATE_TRANSACTION: { long: 'Buyer says they were charged twice', short: 'Duplicate transaction' },
  INCORRECT_AMOUNT: { long: 'Buyer says the amount charged is wrong', short: 'Incorrect amount' },
  PAYMENT_BY_OTHER_MEANS: { long: 'Buyer says they paid by other means', short: 'Paid by other means' },
  CANCELED_RECURRING_BILLING: { long: 'Buyer says a cancelled subscription was charged', short: 'Cancelled recurring billing' },
  PROBLEM_WITH_REMITTANCE: { long: 'Problem with remittance', short: 'Problem with remittance' },
  OTHER: { long: 'Other reason (see PayPal)', short: 'Other reason' },
};

export function reasonText(code: string | null | undefined, form: 'long' | 'short' = 'long'): string {
  if (!code) return '—';
  return REASONS[code]?.[form] ?? code;
}

const ITEM_TYPES: Readonly<Record<string, string>> = {
  PRODUCT: 'Physical product',
  DIGITAL_DOWNLOAD: 'Digital download',
  SERVICE: 'Service',
  BOOKING: 'Booking',
};

/** The buyer-declared item type as a label; PayPal's code verbatim if unknown; null if PayPal reports none. */
export function itemTypeLabel(code: string | null | undefined): string | null {
  return code ? (ITEM_TYPES[code] ?? code) : null;
}

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

/** "18 Oct" (UTC). */
const dayMonth = (iso: string) => formatDueAt(iso).split(' · ')[0];

/**
 * Why there is no seller due date. After the seller's evidence is in, PayPal stops returning
 * `seller_response_due_date` (docs/sandbox-findings.md): the deadline leaves, it is not kept as a stale date.
 */
export function noSellerDeadline(s: DisputeSnapshot): { text: string; sub: string | null } {
  if (s.status === 'RESOLVED') return { text: 'No seller deadline', sub: 'Closed at PayPal' };
  if (s.status === 'UNDER_REVIEW') return { text: 'No seller deadline', sub: 'PayPal is reviewing' };
  if (s.status === 'WAITING_FOR_BUYER_RESPONSE' || hasSellerEvidence(s)) {
    return { text: 'No seller deadline', sub: s.buyerRespondBy ? `Buyer’s turn · buyer by ${dayMonth(s.buyerRespondBy)}` : 'Buyer’s turn' };
  }
  return { text: 'Not set by PayPal', sub: null };
}

// ---------------------------------------------------------------------------------------------
// Case header

export interface HeaderView {
  amount: string;
  currency: string;
  reasonText: string;
  reasonCode: string | null;
  /** Buyer-declared item type label; null when PayPal reports none (or it is not read yet). */
  itemType: string | null;
  stage: string | null;
  /** Shown when there is no stage. */
  stageEmpty: string;
  /** null when there is no PayPal status to show (still reading, unreachable). */
  status: DisputeStatus | null;
  statusEmpty: string;
  statusDetail: string;
  due: { at: string; left: string } | null;
  /** Shown when there is no due date: the reason, never a stale date. */
  dueEmpty: { text: string; sub: string | null };
  transactionId: string;
  transactionText: string;
  /** "PayPal PP-R-… · opened 8 Oct 2026 19:31 UTC" for bound cases. */
  disputeLine: string | null;
  /** Loading / unreachable notice. */
  notice: { tone: 'info' | 'bad'; text: string } | null;
  /** The bound dispute's amount differs from the demo case's order amount (for the demo operator). */
  mismatch: string | null;
}

export interface HeaderInput {
  summary: DisputeSummary;
  source: PayPalSource;
  /** Status and its detail line for a simulated case (fixture, updated by the simulator). */
  simulatedStatus: DisputeStatus;
  /** "WAITING_FOR_BUYER_RESPONSE · read 4s ago": the caller formats the read time. */
  statusDetail: string;
  now: Date;
}

function fromDemo(s: DisputeSummary, status: DisputeStatus, statusDetail: string): HeaderView {
  return {
    amount: s.amount,
    currency: s.currency,
    reasonText: s.reasonText,
    reasonCode: s.reason,
    itemType: s.buyerItemType,
    stage: s.stage,
    stageEmpty: 'Not set yet',
    status,
    statusEmpty: '',
    statusDetail,
    due: s.respondBy ? { at: s.respondBy, left: s.timeLeft ?? '' } : null,
    dueEmpty: { text: 'Set when it opens', sub: null },
    transactionId: s.transactionId,
    transactionText: s.captureText,
    disputeLine: null,
    notice: null,
    mismatch: null,
  };
}

function withoutPayPal(why: string, notice: HeaderView['notice']): HeaderView {
  return {
    amount: '—',
    currency: '',
    reasonText: '—',
    reasonCode: null,
    itemType: null,
    stage: null,
    stageEmpty: '—',
    status: null,
    statusEmpty: why,
    statusDetail: why,
    due: null,
    dueEmpty: { text: '—', sub: why },
    transactionId: '—',
    transactionText: why,
    disputeLine: null,
    notice,
    mismatch: null,
  };
}

export function caseHeaderView({ summary, source, simulatedStatus, statusDetail, now }: HeaderInput): HeaderView {
  switch (source.kind) {
    case 'simulated':
      return fromDemo(summary, simulatedStatus, statusDetail);
    case 'checking':
      return withoutPayPal('Checking the PayPal connection…', { tone: 'info', text: 'Checking whether this case runs on real PayPal…' });
    case 'loading':
      return withoutPayPal('Reading PayPal…', { tone: 'info', text: 'Reading this dispute from PayPal…' });
    case 'unavailable':
      return withoutPayPal('Couldn’t reach PayPal', {
        tone: 'bad',
        text: `Couldn’t reach PayPal · no saved PayPal data for this dispute yet (${source.error}). PayPal’s fields show — until a read succeeds.`,
      });
    case 'live': {
      const s = source.snap;
      const disputeId = s.origin?.kind === 'paypal' ? s.origin.disputeId : '';
      const h = dueHours(s.respondBy ?? null, now);
      const tx = s.transaction;
      const txWhen = utcDateTime(tx?.createdAt);
      const opened = utcDateTime(s.createdAt);
      const warning = bindingMismatch(s.amount, { value: summary.amount, currency: summary.currency }, disputeId || undefined);
      return {
        amount: s.amount ? moneyText(s.amount).split(' ')[0]! : '—',
        currency: s.amount?.currency ?? '',
        reasonText: s.reason ? reasonText(s.reason) : 'PayPal reports no reason',
        reasonCode: s.reason ?? null,
        itemType: itemTypeLabel(s.buyerItemType),
        stage: s.stage ?? null,
        stageEmpty: 'Not set by PayPal',
        status: s.status,
        statusEmpty: '',
        statusDetail: source.failed ? `${statusDetail} · saved` : statusDetail,
        due: s.respondBy && h != null ? { at: utcDate(s.respondBy) ?? s.respondBy, left: `${formatDue(h)} left` } : null,
        dueEmpty: noSellerDeadline(s),
        transactionId: tx?.id ?? '—',
        transactionText: tx
          ? [txWhen ? `Created ${txWhen}` : null, tx.amount ? moneyText(tx.amount) : null, 'from PayPal'].filter(Boolean).join(' · ')
          : 'PayPal reports no transaction',
        disputeLine: `PayPal ${disputeId}${opened ? ` · opened ${opened}` : ''}`,
        notice: source.failed ? { tone: 'bad', text: `Couldn’t reach PayPal · showing saved data, read ${s.readAt}` } : null,
        mismatch: warning ? `${warning}. The order, documents and draft below are the demo case’s, not this dispute’s.` : null,
      };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The case's PayPal-driven rules (actions, requested evidence), and the case as the draft and the approve flow see it

/** Actions PayPal allows now. A bound case allows nothing until PayPal has been read. */
export function caseAllowedActions(source: PayPalSource, simulated: DisputeSnapshot | undefined, demo: readonly ActionCode[]): readonly ActionCode[] {
  if (source.kind === 'simulated') return simulated?.allowedActions ?? demo;
  return source.kind === 'live' ? source.snap.allowedActions : [];
}

const isEvidenceType = (t: string): t is EvidenceType => t in EVIDENCE_TYPE_LABEL;
const KNOWN_REASONS: readonly string[] = ['MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', 'UNAUTHORISED'];

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

/** "6 Oct 14:03" (UTC), the timeline's format. */
function dayTime(iso: string | null | undefined): string | null {
  const d = parse(iso);
  return d ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : null;
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

// ---------------------------------------------------------------------------------------------
// Inbox

/**
 * A bound dispute's inbox row: PayPal's fields from PayPal, the merchant-side ones (readiness, case type, the
 * workspace's next step while PayPal waits for the seller) from the workspace.
 */
export function boundInboxRow(d: InboxDispute, source: Exclude<PayPalSource, { kind: 'simulated' }>): InboxDispute {
  if (source.kind !== 'live') {
    const unreachable = source.kind === 'unavailable';
    return {
      ...d,
      paypal: unreachable ? 'unavailable' : 'loading',
      reason: unreachable ? 'Couldn’t reach PayPal' : 'Reading PayPal…',
      item: '—',
      amount: null,
      currency: '',
      stage: null,
      status: 'OTHER',
      respondBy: null,
      dueNote: unreachable ? 'PayPal unreachable' : 'Reading PayPal',
      next: unreachable ? 'Sync again' : 'Reading PayPal…',
      nextKind: 'none',
      nextSub: unreachable ? source.error : null,
    };
  }
  const s = source.snap;
  const amount = s.amount ? Number(s.amount.value) : NaN;
  const base: InboxDispute = {
    ...d,
    paypal: source.failed ? 'saved' : 'live',
    reason: reasonText(s.reason, 'short'),
    item: itemTypeLabel(s.buyerItemType) ?? '—',
    amount: Number.isFinite(amount) ? amount : null,
    currency: s.amount?.currency ?? '',
    stage: s.stage ?? null,
    status: s.status,
    respondBy: s.respondBy ?? null,
    dueNote: s.respondBy ? null : (noSellerDeadline(s).sub ?? noSellerDeadline(s).text),
  };
  if (hasSellerEvidence(s)) {
    const reviewing = s.status === 'UNDER_REVIEW';
    return {
      ...base,
      next: s.status === 'RESOLVED' ? 'Nothing to do' : reviewing ? 'Nothing to do · PayPal is reviewing' : 'Nothing to do · buyer’s turn',
      nextKind: 'none',
      nextSub: 'Evidence recorded by PayPal',
    };
  }
  if (s.status === 'RESOLVED') return { ...base, next: 'Nothing to do', nextKind: 'none', nextSub: 'Resolved at PayPal' };
  if (s.status === 'UNDER_REVIEW' && !s.allowedActions.length) return { ...base, next: 'PayPal processing', nextKind: 'processing', nextSub: 'No seller actions yet' };
  return base;
}
