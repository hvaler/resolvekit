import type { PayPalClient } from './client.ts';
import type { Money } from './orders.ts';

// Shapes kept to the fields ResolveKit uses; PayPal returns more.
export interface DisputeLink { rel: string; href?: string; method?: string }
export interface Evidence {
  evidence_type: string;
  source?: string;
  date?: string;
  notes?: string;
  evidence_info?: { tracking_info?: TrackingInfo[]; refund_ids?: string[] };
  documents?: Array<{ name: string; url?: string }>;
  action_info?: { action?: string; response_option?: string; mandatory?: boolean };
  /** Seen in the sandbox reads (W-6, W-10): the stage the entry was made in. */
  dispute_life_cycle_stage?: string;
}
/** A message in the dispute thread. Seen in the sandbox reads: `posted_by` (BUYER, SELLER), `time_posted`, `content`. */
export interface ThreadMessage {
  posted_by?: string;
  time_posted?: string;
  content?: string;
  /** Documented for messages with an attachment; not seen in any read yet. */
  documents?: Array<{ name?: string; url?: string }>;
}
/** An event of the offer history (Disputes v1 schema `offer.history[]`); no offer has been made in the sandbox yet. */
export interface OfferHistoryEntry {
  offer_time?: string;
  actor?: string;
  event_type?: string;
  offer_type?: string;
  offer_amount?: Money;
}
export interface TrackingInfo { carrier_name: string; carrier_name_other?: string; tracking_number: string; tracking_url?: string }
export interface Dispute {
  dispute_id?: string;
  status?: string;
  reason?: string;
  dispute_life_cycle_stage?: string;
  evidences?: Evidence[];
  links?: DisputeLink[];
  create_time?: string;
  disputed_transactions?: Array<{
    seller_transaction_id?: string;
    create_time?: string;
    transaction_status?: string;
    gross_amount?: { currency_code: string; value: string };
    items?: Array<{ item_type?: string }>;
    /** The seller's PayPal account: its merchant id is the payer id that account approves with. */
    seller?: { merchant_id?: string; name?: string };
  }>;
  seller_response_due_date?: string;
  buyer_response_due_date?: string;
  dispute_amount?: { currency_code: string; value: string };
  update_time?: string;
  /** REQUIRED_ACTION, REQUIRED_OTHER_PARTY_ACTION, RESOLVED… (seen in the reads). */
  dispute_state?: string;
  /** The thread. Shown to the seller's workspace only: never persisted, never given to the analyst. */
  messages?: ThreadMessage[];
  offer?: { buyer_requested_amount?: Money; seller_offered_amount?: Money; offer_type?: string; history?: OfferHistoryEntry[] };
  allowed_response_options?: {
    accept_claim?: { accept_claim_types?: string[] };
    make_offer?: { offer_types?: string[] };
  };
  dispute_outcome?: { outcome_code?: string; outcome_reason?: string; amount_refunded?: Money };
  /** Seen after an accepted claim: the refund PayPal issued (id, amount, time). */
  refund_details?: { allowed_refund_amount?: Money; transactions?: Array<{ id?: string; gross_amount?: Money; create_time?: string }> };
  /** Documented proof list (Disputes v1); absent in every sandbox read so far. */
  adjudications?: unknown[];
}
export interface EvidenceFile { name: string; type: 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/gif'; data: Uint8Array }
export type EvidenceInput = Pick<Evidence, 'evidence_type' | 'evidence_info' | 'notes'>;

export const SELLER_ACTIONS: readonly string[] = ['provide_evidence', 'send_message', 'make_offer', 'accept_claim', 'escalate', 'appeal'];

/**
 * How a dispute action is sent. `format` is the contract's body format (apps/web/src/domain/actionContracts.ts, passed in
 * by the caller so this package does not import the web registry). `requestId` is the intent's PayPal-Request-Id;
 * PayPal documents no deduplication by it on these routes: read back before any retry.
 */
export interface ActionOpts { requestId: string; format: 'json' | 'multipart' }

const jsonPart = (v: unknown) => new Blob([JSON.stringify(v)], { type: 'application/json' });
const filePart = (f: EvidenceFile) => new Blob([f.data], { type: f.type });

/** The body in the contract's format: the JSON as is, or the same JSON as the multipart `input` part. */
function body(v: Record<string, unknown>, format: ActionOpts['format']): Record<string, unknown> | FormData {
  if (format === 'json') return v;
  const form = new FormData();
  form.append('input', jsonPart(v), 'input.json');
  return form;
}

// Evidence PayPal asks the seller for (source REQUESTED_FROM_SELLER).
export function requestedEvidence(d: Dispute): string[] {
  return (d.evidences ?? []).filter((e) => e.source === 'REQUESTED_FROM_SELLER').map((e) => e.evidence_type);
}

// Actions the seller can take right now. They change with the dispute state: a new dispute spends a few
// minutes UNDER_REVIEW with none, and provide_evidence disappears once evidence has been submitted.
export function sellerActions(d: Dispute): string[] {
  const rels = new Set((d.links ?? []).map((l) => l.rel));
  return SELLER_ACTIONS.filter((a) => rels.has(a));
}

// What PayPal asks for wins. For "not received" it requests PROOF_OF_FULFILLMENT even when the buyer declared a
// SERVICE, and rejects PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED with EVIDENCE_TYPE_IS_NOT_ALLOWED (sandbox,
// 2026-10-08). Digital delivery then goes as carrier OTHER.
export function chooseEvidenceType(requested: string[], itemType?: string): string {
  if (requested[0]) return requested[0];
  return itemType === 'SERVICE' || itemType === 'DIGITAL_DOWNLOAD' ? 'PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED' : 'PROOF_OF_FULFILLMENT';
}

export class DisputesApi {
  private readonly client: PayPalClient;

  constructor(client: PayPalClient) {
    this.client = client;
  }

  // The plain list omits disputed_transactions, so look disputes up by capture. A dispute the buyer just
  // opened can take ~5 minutes to show up here.
  async findByCapture(captureId: string): Promise<Dispute | null> {
    const r = await this.client.request<{ items?: Dispute[] }>('GET', `/v1/customer/disputes?disputed_transaction_id=${encodeURIComponent(captureId)}`);
    return r.items?.[0] ?? null;
  }

  get(disputeId: string): Promise<Dispute> {
    return this.client.request<Dispute>('GET', `/v1/customer/disputes/${encodeURIComponent(disputeId)}`);
  }

  // Irreversible: PayPal accepts one submission; afterwards provide_evidence is gone. Re-read with get().
  // `requestId` becomes the PayPal-Request-Id header. Deduplication by it is not verified for disputes: read back
  // before retrying (see safeRetry in the web app). Never retried here, not even on 429 (it may still be acted on).
  provideEvidence(disputeId: string, evidence: EvidenceInput, files: EvidenceFile[], opts: { requestId?: string } = {}): Promise<unknown> {
    const form = new FormData();
    form.append('input', new Blob([JSON.stringify({ evidences: [evidence] })], { type: 'application/json' }), 'input.json');
    for (const f of files) form.append('evidence-file', new Blob([f.data], { type: f.type }), f.name);
    return this.client.request('POST', `/v1/customer/disputes/${encodeURIComponent(disputeId)}/provide-evidence`, form, { requestId: opts.requestId, noRetry: true });
  }

  // Never retried here, not even on 429: PayPal documents no deduplication by PayPal-Request-Id on these routes, so
  // the caller reads the dispute back before deciding anything. No request id: refused before any request.
  private async post(disputeId: string, action: string, payload: unknown, opts: ActionOpts): Promise<unknown> {
    if (!opts.requestId) throw new Error(`A ${action} request needs the intent's request id`);
    return this.client.request('POST', `/v1/customer/disputes/${encodeURIComponent(disputeId)}/${action}`, payload, { requestId: opts.requestId, noRetry: true });
  }

  /**
   * JSON `{ message }` (the guide), or multipart: `input` with the same JSON plus the file in `message_document` (the
   * part the schema names). A file needs multipart and is refused in JSON before any request.
   */
  async sendMessage(disputeId: string, message: string, file: EvidenceFile | null, opts: ActionOpts): Promise<unknown> {
    if (!opts.requestId) throw new Error("A send-message request needs the intent's request id");
    if (file && opts.format !== 'multipart') throw new Error('A message with a file is sent as multipart');
    const payload = body({ message }, opts.format);
    if (file && payload instanceof FormData) payload.append('message_document', filePart(file), file.name);
    return this.post(disputeId, 'send-message', payload, opts);
  }

  /** Irreversible: PayPal refunds the buyer. `body` is the approved request (accept_claim_type, note, refund_amount…). */
  acceptClaim(disputeId: string, b: Record<string, unknown>, opts: ActionOpts): Promise<unknown> {
    return this.post(disputeId, 'accept-claim', body(b, opts.format), opts);
  }

  /** `body` is the approved request (offer_type, note, offer_amount…). */
  makeOffer(disputeId: string, b: Record<string, unknown>, opts: ActionOpts): Promise<unknown> {
    return this.post(disputeId, 'make-offer', body(b, opts.format), opts);
  }

  escalate(disputeId: string, note: string, opts: ActionOpts): Promise<unknown> {
    return this.post(disputeId, 'escalate', body({ note }, opts.format), opts);
  }

  /** Multipart only (the guide's example): `input` `{ evidences: [evidence] }` plus `evidence-file` parts, as provide-evidence. */
  async appeal(disputeId: string, evidence: EvidenceInput, files: EvidenceFile[], opts: ActionOpts): Promise<unknown> {
    if (!opts.requestId) throw new Error("An appeal request needs the intent's request id");
    if (opts.format !== 'multipart') throw new Error('An appeal is sent as multipart');
    const form = body({ evidences: [evidence] }, 'multipart') as FormData;
    for (const f of files) form.append('evidence-file', filePart(f), f.name);
    return this.post(disputeId, 'appeal', form, opts);
  }
}
