/**
 * PayPal dispute → the web app's DisputeSnapshot. Pure: no I/O, no clock (the read time is passed in). Codes stay
 * verbatim; personal data PayPal returns (buyer and seller emails, names, addresses) is not copied. The thread
 * (`messages`) is copied for the seller's workspace only: it is shown there, never persisted and never given to the
 * analyst (packages/cases builds the analyst's input without it) [A5]. Proof lists the snapshot does not map are
 * reduced to the contract's proof fields (`proofEntries`): never a raw PayPal object.
 */
import { requestedEvidence, sellerActions, type Dispute, type Evidence, type PayPalEnv } from '@resolvekit/paypal';
import type { ActionCode, DisputeMessage, DisputeSnapshot, DisputeStatus, OfferEvent, RecordedEvidence } from '../../web/src/domain/types.ts';
import { CONTRACTS, type ProofFields } from '../../web/src/domain/actionContracts.ts';
import { utcStamp } from '../../web/src/domain/time.ts';

const STATUSES: readonly DisputeStatus[] = ['OPEN', 'WAITING_FOR_BUYER_RESPONSE', 'WAITING_FOR_SELLER_RESPONSE', 'UNDER_REVIEW', 'RESOLVED', 'OTHER'];

export function mapStatus(s: string | undefined): DisputeStatus {
  return STATUSES.includes(s as DisputeStatus) ? (s as DisputeStatus) : 'OTHER';
}

export function mapEvidence(e: Evidence): RecordedEvidence {
  const t = e.evidence_info?.tracking_info?.[0];
  const date = e.date ?? null;
  return {
    evidenceType: e.evidence_type,
    source: e.source ?? 'UNKNOWN',
    action: e.action_info?.action ?? null,
    date,
    carrier: t?.carrier_name ?? '',
    tracking: t?.tracking_number ?? '',
    notes: e.notes ?? '',
    files: (e.documents ?? []).map((d) => d.name),
    storedAt: date && !Number.isNaN(Date.parse(date)) ? utcStamp(new Date(date)) : '',
  };
}

function money(m: { value: string; currency_code: string } | undefined): { value: string; currency: string } | null {
  return m ? { value: m.value, currency: m.currency_code } : null;
}

function mapMessage(m: NonNullable<Dispute['messages']>[number]): DisputeMessage {
  return {
    postedBy: m.posted_by ?? 'UNKNOWN',
    time: m.time_posted ?? null,
    content: m.content ?? '',
    files: (m.documents ?? []).flatMap((x) => (typeof x.name === 'string' ? [x.name] : [])),
  };
}

function mapOfferEvent(o: NonNullable<NonNullable<Dispute['offer']>['history']>[number]): OfferEvent {
  return { time: o.offer_time ?? null, actor: o.actor ?? 'UNKNOWN', event: o.event_type ?? 'UNKNOWN', type: o.offer_type ?? null, amount: money(o.offer_amount) };
}

/** Proof lists the snapshot maps itself; any other list a contract names goes to `proofEntries`. */
const MAPPED_LISTS = new Set(['messages', 'offerHistory', 'evidences']);

type ProofContracts = Readonly<Record<string, { proof: ProofFields | null }>>;

/** The value at a dotted path, kept only when it is a string: never an object, so nothing else of the entry is copied. */
function field(entry: unknown, path: string): string | null {
  let v: unknown = entry;
  for (const k of path.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
  return typeof v === 'string' ? v : null;
}

/**
 * The entries of each unmapped proof list the contracts name, reduced to that contract's proof fields (actor, time and
 * match fields, by dotted path) as strings or null. Undefined when no contract names such a list.
 */
export function proofEntriesOf(d: Dispute, contracts: ProofContracts = CONTRACTS): Array<Record<string, string | null>> | undefined {
  const proofs = Object.values(contracts).flatMap((c) => (c.proof?.list && !MAPPED_LISTS.has(c.proof.list) ? [c.proof] : []));
  if (proofs.length === 0) return undefined;
  return proofs.flatMap((p) => {
    const list = (d as Record<string, unknown>)[p.list!];
    if (!Array.isArray(list)) return [];
    const paths = [...new Set([p.actorField, p.timeField, ...p.matchFields].filter((x): x is string => !!x))];
    return list.map((e) => Object.fromEntries(paths.map((k) => [k, field(e, k)])));
  });
}

/**
 * @param caseId the web case the dispute is bound to: the snapshot keeps that id so the app updates the right case.
 */
export function toSnapshot(d: Dispute, caseId: string, env: PayPalEnv, readAt: Date): DisputeSnapshot {
  const tx = d.disputed_transactions?.[0];
  const entries = proofEntriesOf(d);
  return {
    id: caseId,
    status: mapStatus(d.status),
    stage: d.dispute_life_cycle_stage ?? null,
    reason: d.reason ?? null,
    buyerItemType: tx?.items?.[0]?.item_type ?? null,
    allowedActions: sellerActions(d) as ActionCode[],
    requestedEvidence: requestedEvidence(d),
    evidences: (d.evidences ?? []).map(mapEvidence),
    // PayPal stops returning the seller due date once seller evidence is in: absent stays null, never a stale date.
    respondBy: d.seller_response_due_date ?? null,
    buyerRespondBy: d.buyer_response_due_date ?? null,
    amount: money(d.dispute_amount),
    createdAt: d.create_time ?? null,
    transaction: tx?.seller_transaction_id
      ? { id: tx.seller_transaction_id, createdAt: tx.create_time ?? null, amount: money(tx.gross_amount), status: tx.transaction_status ?? null }
      : null,
    messages: (d.messages ?? []).map(mapMessage),
    offerHistory: (d.offer?.history ?? []).map(mapOfferEvent),
    responseOptions: {
      acceptClaimTypes: [...(d.allowed_response_options?.accept_claim?.accept_claim_types ?? [])],
      offerTypes: [...(d.allowed_response_options?.make_offer?.offer_types ?? [])],
    },
    // PayPal gives no closing time; a resolved dispute's last update is when it closed.
    outcome: d.dispute_outcome?.outcome_code ? { code: d.dispute_outcome.outcome_code, closedAt: d.status === 'RESOLVED' ? (d.update_time ?? null) : null } : null,
    ...(entries ? { proofEntries: entries } : {}),
    readAt: utcStamp(readAt),
    origin: { kind: 'paypal', env, disputeId: d.dispute_id ?? '' },
  };
}
