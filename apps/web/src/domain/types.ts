/**
 * Domain types for the ResolveKit web app. PayPal codes are kept verbatim (status, stage, reason,
 * evidence type, action) so the UI can always show the raw code next to its human label.
 */

export type DisputeStatus =
  | 'UNDER_REVIEW'
  | 'WAITING_FOR_SELLER_RESPONSE'
  | 'WAITING_FOR_BUYER_RESPONSE'
  | 'RESOLVED';

export type DisputeReason =
  | 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED'
  | 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED'
  | 'UNAUTHORISED';

export type ActionCode = 'provide_evidence' | 'send_message' | 'make_offer' | 'accept_claim' | 'escalate';

export type EvidenceType =
  | 'PROOF_OF_FULFILLMENT'
  | 'PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED'
  | 'PROOF_OF_REFUND';

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
  | { kind: 'receipt'; calls: ReceiptCall[]; currency: string }
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
  body: EvidenceBody;
}

export interface Citation {
  evidenceId: string;
  /** Cited fragment keys. Empty means the whole document (e.g. an attachment). */
  fragments: string[];
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
  /**
   * Simulated re-check for edits of a needs-review sentence: if the new text matches `supportedIf`
   * (case-insensitive regular expression) the sentence becomes supported.
   */
  recheck?: { supportedIf: string; supportedNote: string };
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
  requestedEvidenceType: EvidenceType;
  requestedNote: string;
  evidenceTypes: EvidenceTypeCandidate[];
  fulfillment: Fulfillment;
  attachments: Attachment[];
  recommendation: { title: string; body: string } | null;
  allowedActions: ActionCode[];
  actionDetails: Partial<Record<ActionCode, { label: string; sub: string }>>;
  refundText: string;
  audit: AuditEntry[];
}

// ---------------------------------------------------------------------------------------------
// Inbox

export type InboxState = 'processing' | 'drafting' | 'ready' | 'sent' | 'closed';

export interface InboxRow {
  id: string;
  reasonText: string;
  item: BuyerItemType;
  customer: string;
  amount: string;
  stage: string | null;
  status: DisputeStatus;
  respondBy: string;
  left: string;
  urgent?: boolean;
  state: InboxState;
  note: string;
  ready: number | null;
  agent?: boolean;
}

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

/** Evidence as PayPal reports it when the dispute is read back. */
export interface RecordedEvidence {
  evidenceType: EvidenceType;
  carrier: string;
  tracking: string;
  notes: string;
  files: string[];
  storedAt: string;
}

export interface DisputeSnapshot {
  id: string;
  status: DisputeStatus;
  allowedActions: ActionCode[];
  evidences: RecordedEvidence[];
  readAt: string;
}
