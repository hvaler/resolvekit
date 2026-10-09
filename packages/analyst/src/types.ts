/**
 * The analyst's input and output. Pure data: the web app, the server and the evals share these shapes.
 *
 * Input: the case's documents as the merchant sees them (one text line per row, with the fragment key the web app
 * highlights), PayPal's dispute data, and the merchant's own notes for the response.
 * Output: facts with verbatim quotes, timeline, contradictions, checklist, verified draft sentences, injection flags
 * and the recommendation, plus provenance (model, prompt version, time, token usage).
 */

export interface DocLine {
  text: string;
  /** Web fragment key this line belongs to (e.g. "E3.deliv"); absent for lines the web app cannot highlight. */
  fragment?: string;
}

export interface AnalysisDocument {
  /** Evidence id (E1…), or "D" for PayPal's dispute record. */
  id: string;
  title: string;
  /** Document type, e.g. "Carrier tracking". */
  type: string;
  /** Where it comes from, e.g. "Carrier (UPS)". */
  source: string;
  /** Short tag the timeline shows (ORD, PP, CAR, MSG, MCP). */
  tag: string;
  lines: DocLine[];
}

export interface EvidenceOption {
  type: string;
  satisfied: boolean;
}

export interface DisputeContext {
  id: string;
  /** PayPal reason code, verbatim. */
  reason: string;
  /** Item type the buyer declared, e.g. "Physical product", "Service". */
  buyerItemType: string;
  amount: string;
  currency: string;
  /** Actions PayPal allows the seller now (PayPal codes). */
  allowedActions: string[];
  /** Evidence type PayPal requests from the seller, or null. */
  requestedEvidence: string | null;
  /** Evidence types the case could send and whether the case file has what each needs (domain rules). */
  evidenceOptions: EvidenceOption[];
}

export interface MerchantNote {
  id: string;
  text: string;
}

export interface AnalysisInput {
  caseId: string;
  caseKind: 'standard' | 'agent';
  dispute: DisputeContext;
  /** Documents, including "D" (PayPal's dispute record) when known. */
  documents: AnalysisDocument[];
  /** Statements the merchant wants in the response. Each one is drafted and verified like any other sentence. */
  merchantNotes: MerchantNote[];
}

// ---------------------------------------------------------------------------------------------
// Output

export interface Quote {
  /** Document id. */
  doc: string;
  /** Verbatim text from the document. */
  quote: string;
}

export interface Fact extends Quote {
  id: string;
  /** What the quote says, in plain words. */
  statement: string;
  /** ISO 8601 UTC time the fact is about, when the quote states one. */
  at: string | null;
}

export interface TimelineEvent {
  at: string;
  title: string;
  sub: string;
  doc: string | null;
  quote: string | null;
  /** The event did not complete (a failed call, a cancelled shipment). */
  negated: boolean;
}

export interface ContradictionSide extends Quote {
  /** The conflicting value, verbatim from the quote (e.g. "Apt 4B"). */
  value: string;
}

export interface Contradiction {
  id: string;
  title: string;
  /** "address contradiction": used in "the address contradiction is open". */
  shortName: string;
  a: ContradictionSide;
  b: ContradictionSide;
  /** Neutral explanation; never a fraud accusation. */
  explanation: string;
  /** Sentence that relies on the conflicting facts, and a rewrite of it that states both. */
  sentenceId: string | null;
  rewrite: string | null;
}

export type ChecklistStatus = 'present' | 'missing' | 'contradicts';

export interface ChecklistItem {
  id: string;
  label: string;
  /** Without it the defence does not stand (e.g. tracking with delivery for "not received"). */
  critical: boolean;
  status: ChecklistStatus;
  evidence: Quote[];
  contradictionId: string | null;
}

export type Verdict = 'supported' | 'needs_review' | 'rejected';

export interface CitationCheck extends Quote {
  /** Deterministic check: the quote is an exact substring of the document (whitespace normalised). */
  valid: boolean;
}

export interface Sentence {
  id: string;
  text: string;
  /** Merchant note this sentence comes from, if any. */
  noteId: string | null;
  citations: CitationCheck[];
  verdict: Verdict;
  /** Why it needs review / why it was removed (null when supported). */
  reason: string | null;
  /** Who decided the verdict: the deterministic checks or the model's support check. */
  decidedBy: 'deterministic' | 'model';
  /** A rewrite that only states what the cited text shows (for needs-review sentences). */
  rewrite: string | null;
}

export interface InjectionFlag {
  doc: string;
  quote: string;
  /**
   * How it was found: the deterministic pattern scan, the extraction model, and/or the separate classifier call.
   * Any one flags the document; none can clear another's flag.
   */
  by: Array<'pattern' | 'model' | 'classifier'>;
}

export type RecommendedAction = 'provide_evidence' | 'send_message' | 'accept_claim' | 'make_offer';

export interface Recommendation {
  action: RecommendedAction;
  /** Deterministic rule that chose the action. */
  rule: string;
  /** The model's explanation of the rule's choice, from supported sentences only. */
  explanation: string;
}

export interface CallUsage {
  stage: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  ms: number;
}

export interface Usage {
  calls: CallUsage[];
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
}

export interface CaseAnalysis {
  caseId: string;
  /** sha256 of { input, promptVersion, model } (see cache.ts): the cache and golden key. */
  key: string;
  promptVersion: string;
  /** Model asked for (primary). */
  requestedModel: string;
  /** Provider/model that actually answered (the fallback when the primary failed). */
  provider: string;
  model: string;
  createdAt: string;
  facts: Fact[];
  /** Facts the model returned whose quote is not in the document: dropped, counted for the evals. */
  droppedFacts: number;
  timeline: TimelineEvent[];
  contradictions: Contradiction[];
  checklist: { title: string; items: ChecklistItem[] };
  sentences: Sentence[];
  injections: InjectionFlag[];
  recommendation: Recommendation | null;
  usage: Usage;
}

/** Pipeline stages, in order, for progress reporting. */
export const STAGES = ['read', 'extract', 'timeline', 'contradictions', 'draft', 'verify', 'ready'] as const;
export type Stage = (typeof STAGES)[number];

export interface Progress {
  stage: Stage;
  /** Human label of the completed stage, e.g. "Extracted 24 facts". */
  label: string;
}
