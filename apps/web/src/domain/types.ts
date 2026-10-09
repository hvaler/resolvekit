/**
 * Domain types for the ResolveKit web app. PayPal codes are kept verbatim (status, stage, reason,
 * evidence type, action) so the UI can always show the raw code next to its human label.
 */

export type DisputeStatus =
  | 'UNDER_REVIEW'
  | 'WAITING_FOR_SELLER_RESPONSE'
  | 'WAITING_FOR_BUYER_RESPONSE'
  | 'RESOLVED'
  | 'OPEN'
  | 'OTHER';

export type DisputeReason =
  | 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED'
  | 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED'
  | 'UNAUTHORISED'
  | 'INCORRECT_AMOUNT';

export type ActionCode = 'provide_evidence' | 'send_message' | 'make_offer' | 'accept_claim' | 'escalate';

export type EvidenceType =
  | 'PROOF_OF_FULFILLMENT'
  | 'PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED'
  | 'PROOF_OF_REFUND'
  /** Notes and documents (PayPal's reasons-and-evidence table: e.g. the listing and return policy for "not as described"). */
  | 'OTHER';

/** Item type as declared by the buyer in PayPal's dispute form (not the order's category). */
export type BuyerItemType = 'Physical product' | 'Digital download' | 'Service' | 'Booking';

export type CaseKind = 'standard' | 'agent';

// ---------------------------------------------------------------------------------------------
// Evidence

export interface EvidenceLine {
  text: string;
  /** Fragment key a sentence can cite, e.g. "E1.addr". Lines sharing a key are cited together. */
  fragment?: string;
}

export interface KeyValueRow {
  fragment: string;
  label: string;
  value: string;
}

export interface ReceiptCall {
  fragment: string;
  n: number;
  time: string;
  tool: string;
  /** Price as a decimal string in the receipt currency. */
  price: string;
  ok: boolean;
  hash: string;
}

export type EvidenceBody =
  | { kind: 'lines'; lines: EvidenceLine[] }
  | { kind: 'mandate'; headline: string; sessionId: string; rows: KeyValueRow[] }
  | { kind: 'receipt'; calls: ReceiptCall[]; currency: string; /** Budget the buyer approved, as a decimal string. */ cap?: string }
  | { kind: 'settlement'; headline: string; captured: string; released: string; cap: string; rows: KeyValueRow[] };

export interface EvidenceMeta {
  type: string;
  tag: string;
  source: string;
  received: string;
  hash: string;
}

export interface Evidence {
  id: string;
  /** Short name used on chips: "E3 · UPS tracking". */
  short: string;
  title: string;
  /** Structured provenance (standard case). */
  meta?: EvidenceMeta;
  /** One-line provenance (agent case), shown before "used in N claims". */
  caption?: string;
  /** Shown as an info note: the document contains instructions and is treated as content only. */
  warning?: string;
  /** Set when this document takes part in a contradiction. */
  contradictionId?: string;
  /**
   * The document is PayPal's record of the disputed payment (the capture). On a bound case its content comes from
   * the PayPal read (see domain/paypalView `withPayPal`); on a simulated case it is demo data and says so.
   */
  paypalRecord?: 'capture';
  /** Where an agent-case document comes from: the real MeterMCP session, or the demo case. Shown on the card. */
  sourceLabel?: { kind: 'metermcp' | 'demo'; text: string; /** Full text for the tooltip when `text` is shortened. */ title?: string };
  body: EvidenceBody;
}

export interface Citation {
  evidenceId: string;
  /** Cited fragment keys. Empty means the whole document (e.g. an attachment). */
  fragments: string[];
  /** The exact text quoted from the document (verified verbatim by the analyst's deterministic check). */
  quotes?: string[];
}

// ---------------------------------------------------------------------------------------------
// Draft

export type AnalystVerdict = 'supported' | 'needs_review' | 'rejected';

/** UI state of a sentence: the analyst verdict plus transient states. */
export type SentenceState = AnalystVerdict | 'checking' | 'pending';

export interface DraftSentence {
  id: string;
  text: string;
  verdict: AnalystVerdict;
  citations: Citation[];
  /** Why it needs review / why it was removed. */
  reason?: string;
  /** Drafted by the analyst, or one of the merchant's own notes (verified the same way). */
  origin?: 'analyst' | 'merchant_note';
  /** One-click rewrite proposed by the analyst. */
  suggestion?: { label: string; text: string };
}

export interface SentenceView {
  id: string;
  num: number;
  text: string;
  state: SentenceState;
  citations: Citation[];
  reason: string | null;
  note: string | null;
  edited: boolean;
  /** One of the merchant's own notes (verified like any sentence). */
  fromNote?: boolean;
}

export interface ContradictionSide {
  evidenceId: string;
  fragment: string;
  label: string;
  value: string;
}

export interface Contradiction {
  id: string;
  title: string;
  a: ContradictionSide;
  b: ContradictionSide;
  assessment: string;
  /** "Explain in response" rewrites this sentence with `explainText`. */
  explainSentenceId: string;
  explainText: string;
  /** Short name used in blockers: "the address contradiction". */
  blockerName: string;
}

export type ContradictionResolution =
  | { status: 'open' }
  | { status: 'explained'; sentenceNum: number }
  | { status: 'resolved'; note: string; by: string };

export interface ChecklistItem {
  label: string;
  refs: string;
  /** If set, the item reflects that contradiction (contradicts while open, resolved after). */
  contradictionId?: string;
  present: boolean;
}

export type ChecklistState = 'present' | 'missing' | 'contradicts' | 'resolved';

// ---------------------------------------------------------------------------------------------
// Timeline

export type TimelineItem =
  | {
      kind: 'event';
      time: string;
      title: string;
      sub: string;
      tag: string;
      evidenceId: string | null;
      fragment?: string;
      struck?: boolean;
    }
  | { kind: 'contradiction'; contradictionId: string };

// ---------------------------------------------------------------------------------------------
// Case

export interface DisputeSummary {
  id: string;
  amount: string;
  currency: string;
  reason: DisputeReason;
  /** Merchant-facing line: "Buyer says the item was not received". */
  reasonText: string;
  buyerItemType: BuyerItemType;
  stage: string | null;
  status: DisputeStatus;
  statusReadAgo: string;
  respondBy: string | null;
  timeLeft: string | null;
  transactionId: string;
  captureText: string;
  /** When PayPal opened the dispute (ISO 8601), when known. */
  openedAt?: string | null;
}

export interface EvidenceTypeCandidate {
  type: EvidenceType;
  label: string;
  /** What this type needs and whether the case file has it. */
  requirement: string;
  satisfied: boolean;
}

export interface Attachment {
  name: string;
  size: string;
  fromEvidenceId: string;
}

export interface Fulfillment {
  carrier: string;
  carrierLabel: string;
  tracking: string;
  /** Present for digital delivery: how the agent session maps to PayPal fields. */
  digital?: { sessionLabel: string; note: string };
}

export interface AuditEntry {
  time: string;
  who: string;
  what: string;
}

export interface CaseFile {
  kind: CaseKind;
  summary: DisputeSummary;
  merchant: { name: string; initials: string };
  evidence: Evidence[];
  evidenceSources: string;
  timeline: TimelineItem[];
  timelineCaption: string;
  sentences: DraftSentence[];
  contradictions: Contradiction[];
  checklist: { title: string; items: ChecklistItem[] } | null;
  analysis: {
    steps: string[];
    /** Step index (0-based) at which contradictions are shown. */
    contradictionStep: number;
    /** Step index at which rejected sentences are revealed as removed. */
    rejectionStep: number;
    note: string;
  };
  /** What PayPal asks the seller for; null when PayPal requests nothing (e.g. once the seller's evidence is in). */
  requestedEvidenceType: EvidenceType | null;
  requestedNote: string;
  evidenceTypes: EvidenceTypeCandidate[];
  fulfillment: Fulfillment;
  attachments: Attachment[];
  recommendation: { title: string; body: string } | null;
  allowedActions: ActionCode[];
  actionDetails: Partial<Record<ActionCode, { label: string; sub: string }>>;
  refundText: string;
  audit: AuditEntry[];
  /** Statements the merchant wants in the response. The analyst drafts and verifies them like its own sentences. */
  merchantNotes?: string[];
  /** A note shown above the evidence (e.g. the agent case's documents are demo data, and why). */
  notice?: { tone: 'info' | 'warn'; text: string } | null;
  /**
   * Where the simulated PayPal starts for this dispute when it is not at its first seller turn: evidence already on
   * the dispute (the buyer's entry, the seller's earlier submission), the buyer's due date and PayPal's outcome.
   * Absent: a fresh dispute waiting for the seller.
   */
  simulatedPayPal?: Pick<DisputeSnapshot, 'evidences' | 'buyerRespondBy' | 'outcome'>;
}

// ---------------------------------------------------------------------------------------------
// Agent purchase: the MeterMCP session behind a disputed capture (read by apps/server from MeterMCP)

export interface MeteredCall {
  n: number;
  /** ISO 8601 */
  time: string;
  tool: string;
  price: string;
  status: 'OK' | 'FAILED' | 'PENDING';
  requestHash: string;
}

export interface MeteredSession {
  sessionId: string;
  currency: string;
  receiptSha256: string;
  mandate: {
    cap: string;
    orderId: string | null;
    authorizationId: string | null;
    authorizationStatus: string | null;
    approvedAt: string | null;
    authorizedAt: string | null;
  };
  calls: MeteredCall[];
  totals: { calls: number; ok: number; failed: number; charged: string; cap: string };
  settlement: {
    status: 'open' | 'captured' | 'voided' | 'failed' | 'not_approved';
    captureId: string | null;
    captureStatus: string | null;
    captured: string | null;
    released: string | null;
    remainderReleased: boolean;
    settledAt: string | null;
  };
}

/** The agent case's session as found in MeterMCP by the disputed capture, or why there is none. */
export type AgentReceiptSource = { kind: 'metermcp'; session: MeteredSession } | { kind: 'none'; reason: string };

// ---------------------------------------------------------------------------------------------
// Sending

export interface SubmissionFile {
  name: string;
  size: string;
}

/** Exactly what goes to PayPal's provide-evidence endpoint. */
export interface EvidenceSubmission {
  disputeId: string;
  action: 'provide_evidence';
  evidenceType: EvidenceType;
  carrier: string;
  tracking: string;
  notes: string;
  files: SubmissionFile[];
}

/**
 * Who put an evidence entry on the dispute, as PayPal reports it. A real dispute always carries the buyer's
 * own entry (`CREATE`, SUBMITTED_BY_BUYER) and the evidence PayPal requests (REQUESTED_FROM_SELLER, no
 * documents); only SUBMITTED_BY_SELLER entries are the merchant's evidence.
 */
export type EvidenceSource = 'SUBMITTED_BY_SELLER' | 'SUBMITTED_BY_BUYER' | 'REQUESTED_FROM_SELLER' | (string & {});

/** Evidence as PayPal reports it when the dispute is read back. */
export interface RecordedEvidence {
  /** PayPal evidence type code, verbatim (also CREATE etc. for buyer entries). */
  evidenceType: EvidenceType | (string & {});
  source: EvidenceSource;
  /** `action_info.action` when PayPal reports it, e.g. PROVIDE_EVIDENCE. */
  action?: string | null;
  /** PayPal's date for the entry (ISO 8601), used to tell entries apart. */
  date?: string | null;
  carrier: string;
  tracking: string;
  notes: string;
  files: string[];
  storedAt: string;
}

/** Where a snapshot comes from: the real PayPal API (through the ResolveKit server) or the in-browser simulator. */
export type SnapshotOrigin = { kind: 'simulator' } | { kind: 'paypal'; env: 'sandbox' | 'live'; disputeId: string };

export interface DisputeSnapshot {
  id: string;
  status: DisputeStatus;
  allowedActions: ActionCode[];
  evidences: RecordedEvidence[];
  readAt: string;
  /** PayPal stage code, once PayPal has opened the dispute. */
  stage?: string | null;
  /** Seller response due date (ISO 8601, UTC), once PayPal has set one. */
  respondBy?: string | null;
  /** Read from PayPal or from the simulator. Absent means the simulator (or initial demo data). */
  origin?: SnapshotOrigin;
  /** PayPal reason code, verbatim. */
  reason?: string | null;
  /** Item type the buyer declared in PayPal's dispute form (PayPal code, e.g. PRODUCT, SERVICE). */
  buyerItemType?: string | null;
  /** Evidence types PayPal requests from the seller (source REQUESTED_FROM_SELLER). */
  requestedEvidence?: string[];
  /** Disputed amount as PayPal reports it. */
  amount?: { value: string; currency: string } | null;
  /** When PayPal created the dispute (ISO 8601). */
  createdAt?: string | null;
  /** Buyer response due date (ISO 8601), when PayPal is waiting for the buyer. */
  buyerRespondBy?: string | null;
  /** The disputed transaction as PayPal reports it: the seller-side id (the capture), its time, gross amount and status. */
  /** PayPal's `dispute_outcome` once the dispute is resolved (e.g. RESOLVED_SELLER_FAVOUR), with the time it closed. */
  outcome?: { code: string; closedAt: string | null } | null;
  /** Agent cases only: the MeterMCP session of the disputed capture (absent for other cases and the simulator). */
  agentReceipt?: AgentReceiptSource | null;
  transaction?: {
    id: string;
    createdAt: string | null;
    amount: { value: string; currency: string } | null;
    /** PayPal's `transaction_status`, verbatim (e.g. HELD while disputed); absent on older reads. */
    status?: string | null;
  } | null;
}
