import type { PayPalClient } from './client.ts';

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
  }>;
  seller_response_due_date?: string;
  buyer_response_due_date?: string;
  dispute_amount?: { currency_code: string; value: string };
}
export interface EvidenceFile { name: string; type: 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/gif'; data: Uint8Array }
export type EvidenceInput = Pick<Evidence, 'evidence_type' | 'evidence_info' | 'notes'>;

const SELLER_ACTIONS = ['provide_evidence', 'send_message', 'make_offer', 'accept_claim', 'escalate'];

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
  // before retrying (see safeRetry in the web app).
  provideEvidence(disputeId: string, evidence: EvidenceInput, files: EvidenceFile[], opts: { requestId?: string } = {}): Promise<unknown> {
    const form = new FormData();
    form.append('input', new Blob([JSON.stringify({ evidences: [evidence] })], { type: 'application/json' }), 'input.json');
    for (const f of files) form.append('evidence-file', new Blob([f.data], { type: f.type }), f.name);
    return this.client.request('POST', `/v1/customer/disputes/${encodeURIComponent(disputeId)}/provide-evidence`, form, opts);
  }

  sendMessage(disputeId: string, message: string): Promise<unknown> {
    return this.client.request('POST', `/v1/customer/disputes/${encodeURIComponent(disputeId)}/send-message`, { message });
  }

  acceptClaim(disputeId: string, note: string): Promise<unknown> {
    return this.client.request('POST', `/v1/customer/disputes/${encodeURIComponent(disputeId)}/accept-claim`, { note });
  }
}
