/**
 * The submission intent: exactly what will go to PayPal for one dispute, composed from the case's analysis by the
 * ResolveKit server (apps/server), approved by the merchant, and the only thing the server's evidence route sends.
 *
 * The composition is pure and shared: the server builds the intent from its own documents, its own analysis and the
 * sentence edits it re-verified itself; the web app shows the server's intent in the review step and sends its id.
 * (Without a server, e.g. in tests, the web app composes the same thing locally for the simulator.)
 */
import { canonicalJson, sha256Hex } from '@resolvekit/analyst';
import { deriveSentences, draftBlockers, notesText, type Recheck } from './draft.ts';
import { evidenceTypeOptions } from './evidenceTypes.ts';
import type { ActionCode, CaseFile, ContradictionResolution, EvidenceSubmission, EvidenceType, SentenceView, SubmissionFile } from './types';

/** What the merchant asks for: the evidence type, their edited sentences and how each contradiction was resolved. */
export interface IntentRequest {
  evidenceType: EvidenceType;
  /** Edited text by sentence id. Each edit must have been re-verified by the server's analyst. */
  edits: Record<string, string>;
  /** Contradiction id → resolution (explained in a sentence, or resolved with a note). */
  resolutions: Record<string, ContradictionResolution>;
}

/** A sentence that goes into the notes, in order. */
export interface IntentSentence {
  id: string;
  text: string;
  edited: boolean;
}

/** The exact content PayPal receives, bound to the case, the dispute and the documents it was composed from. */
export interface IntentContent {
  caseId: string;
  /** The bound PayPal dispute id; null for a simulated case (the in-browser simulator records it). */
  disputeId: string | null;
  /** sha256 of the documents the analysis read (allowed actions blanked). */
  documentsHash: string;
  /** The analysis the sentences come from. */
  analysisKey: string;
  evidenceType: EvidenceType;
  carrier: string;
  tracking: string;
  notes: string;
  files: SubmissionFile[];
  sentences: IntentSentence[];
  /** Contradictions resolved with a note (not sent to PayPal; part of what the merchant approves). */
  resolutionNotes: { contradictionId: string; note: string }[];
}

export type IntentStatus =
  /** Composed; waiting for the merchant's approval. */
  | 'proposed'
  /** Approved by the merchant; can be sent. */
  | 'approved'
  /** The send is in progress (one at a time). */
  | 'sending'
  /** PayPal accepted the send (whether it is recorded is read back). */
  | 'sent'
  /** The send failed; the same intent (same PayPal-Request-Id) may be retried. */
  | 'failed'
  /** A newer intent, an edit, changed documents or bindings replaced it: it can never be sent. */
  | 'invalidated'
  /** Not approved or sent in time. */
  | 'expired';

export interface SubmissionIntent extends IntentContent {
  id: string;
  /** sha256 of the canonical JSON of the content: what the merchant approves. */
  contentHash: string;
  /** PayPal-Request-Id of every send of this intent (idempotent). */
  requestId: string;
  status: IntentStatus;
  createdAt: string;
  expiresAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  /** Why it was invalidated, or why the last send failed. */
  reason: string | null;
}

/** The fields of an intent that are hashed: everything that decides what PayPal receives and where. */
export function intentContent(i: IntentContent): IntentContent {
  return {
    caseId: i.caseId,
    disputeId: i.disputeId,
    documentsHash: i.documentsHash,
    analysisKey: i.analysisKey,
    evidenceType: i.evidenceType,
    carrier: i.carrier,
    tracking: i.tracking,
    notes: i.notes,
    files: i.files.map((f) => ({ name: f.name, size: f.size })),
    sentences: i.sentences.map((s) => ({ id: s.id, text: s.text, edited: s.edited })),
    resolutionNotes: i.resolutionNotes.map((r) => ({ contradictionId: r.contradictionId, note: r.note })),
  };
}

export function contentHash(i: IntentContent): Promise<string> {
  return sha256Hex(canonicalJson(intentContent(i)));
}

/** The intent as the submission the gateways take. */
export function intentSubmission(i: SubmissionIntent): EvidenceSubmission {
  return {
    disputeId: i.caseId,
    action: 'provide_evidence',
    evidenceType: i.evidenceType,
    carrier: i.carrier,
    tracking: i.tracking,
    notes: i.notes,
    files: i.files.map((f) => ({ ...f })),
    intentId: i.id,
  };
}

export interface ComposeProblem {
  status: number;
  error: string;
  detail: string;
  blockers?: string[];
}

export interface Composed {
  submission: EvidenceSubmission;
  sentences: IntentSentence[];
  views: SentenceView[];
  resolutionNotes: { contradictionId: string; note: string }[];
}

const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f‪-‮⁦-⁩]/;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Parse a request body into an {@link IntentRequest}; shape only. */
export function parseIntentRequest(body: unknown): IntentRequest | ComposeProblem {
  const bad = (detail: string): ComposeProblem => ({ status: 400, error: 'INVALID_INTENT_REQUEST', detail });
  if (!isRecord(body)) return bad('Body must be a JSON object');
  const extra = Object.keys(body).filter((k) => !['evidenceType', 'edits', 'resolutions'].includes(k));
  if (extra.length) return bad(`Unexpected field(s) ${extra.join(', ')}: notes, files and tracking are composed on the server`);
  if (typeof body.evidenceType !== 'string' || !/^[A-Z_]{1,60}$/.test(body.evidenceType)) return bad('evidenceType must be a PayPal evidence type');
  const edits: Record<string, string> = {};
  if (body.edits !== undefined) {
    if (!isRecord(body.edits)) return bad('edits must be an object { sentenceId: text }');
    const entries = Object.entries(body.edits);
    if (entries.length > 50) return bad('Too many edits');
    for (const [id, text] of entries) {
      if (!/^[\w.-]{1,40}$/.test(id)) return bad('edits: invalid sentence id');
      if (typeof text !== 'string' || !text.trim() || text.trim().length > 600) return bad('edits: each text must be 1-600 characters');
      if (CONTROL.test(text)) return bad('edits: text must not contain control or bidi characters');
      edits[id] = text.trim();
    }
  }
  const resolutions: Record<string, ContradictionResolution> = {};
  if (body.resolutions !== undefined) {
    if (!isRecord(body.resolutions)) return bad('resolutions must be an object');
    const entries = Object.entries(body.resolutions);
    if (entries.length > 50) return bad('Too many resolutions');
    for (const [id, r] of entries) {
      if (!/^[\w.-]{1,40}$/.test(id) || !isRecord(r)) return bad('resolutions: invalid entry');
      if (r.status === 'open') continue;
      if (r.status === 'explained') {
        resolutions[id] = { status: 'explained', sentenceNum: typeof r.sentenceNum === 'number' ? r.sentenceNum : 0 };
      } else if (r.status === 'resolved') {
        const note = typeof r.note === 'string' ? r.note.trim() : '';
        if (!note || note.length > 500 || CONTROL.test(note)) return bad('resolutions: a note must be 1-500 characters without control characters');
        resolutions[id] = { status: 'resolved', note, by: 'merchant' };
      } else return bad('resolutions: status must be open, explained or resolved');
    }
  }
  return { evidenceType: body.evidenceType as EvidenceType, edits, resolutions };
}

export const isComposeProblem = (x: unknown): x is ComposeProblem => isRecord(x) && typeof x.error === 'string' && typeof x.status === 'number';

export interface ComposeInput {
  /** The case with its analysis applied (withAnalysis), PayPal's and MeterMCP's data included. */
  c: CaseFile;
  req: IntentRequest;
  /** The verifier's verdict on an edited text (re-checked on the server for this analysis), or null if never verified. */
  verified: (text: string) => Recheck | null;
  /** Actions PayPal allows now. */
  allowedActions: readonly ActionCode[];
  /** PayPal already shows the seller's evidence. */
  submitted: boolean;
}

/**
 * Compose the submission from the analysis: supported sentences only (an edit counts only with a verdict from the
 * verifier), every contradiction resolved, the evidence type allowed and satisfied, within PayPal's limits. The same
 * rules as the web app's draft blockers, enforced where the send happens.
 */
export function composeSubmission(x: ComposeInput): Composed | ComposeProblem {
  const { c, req } = x;
  const rechecks: Record<string, Recheck> = {};
  for (const [id, text] of Object.entries(req.edits)) {
    const s = c.sentences.find((y) => y.id === id);
    if (!s) return { status: 422, error: 'UNKNOWN_SENTENCE', detail: `Sentence ${id} is not in this analysis` };
    if (s.verdict === 'rejected') return { status: 422, error: 'SENTENCE_REMOVED', detail: `Sentence ${id} was removed by the analyst and cannot be edited back in` };
    if (text === s.text) continue;
    const r = x.verified(text);
    if (!r) return { status: 422, error: 'EDIT_NOT_VERIFIED', detail: `The edit of sentence ${c.sentences.indexOf(s) + 1} was not re-checked by the analyst on this server; edit it again to re-check it` };
    rechecks[id] = r;
  }
  const edits = Object.fromEntries(Object.entries(req.edits).filter(([id]) => rechecks[id]));
  const resolutions: Record<string, ContradictionResolution> = {};
  const resolutionNotes: { contradictionId: string; note: string }[] = [];
  for (const k of c.contradictions) {
    const r = req.resolutions[k.id];
    if (r?.status === 'resolved') {
      resolutions[k.id] = r;
      resolutionNotes.push({ contradictionId: k.id, note: r.note });
    } else if (r?.status === 'explained' && k.explainSentenceId && edits[k.explainSentenceId] !== undefined) {
      resolutions[k.id] = { status: 'explained', sentenceNum: c.sentences.findIndex((s) => s.id === k.explainSentenceId) + 1 };
    }
  }
  // The same sentence rules as the draft, with the resolutions as validated here (a contested sentence is released
  // only by a contradiction resolved with a note).
  const views = deriveSentences(c.sentences, { edits, rechecks, checking: null, analysisStep: c.analysis.steps.length, rejectionStep: c.analysis.rejectionStep, contradictions: c.contradictions, resolutions });

  const options = evidenceTypeOptions(c.summary.reason, c.requestedEvidenceType, c.evidenceTypes);
  const selected = options.find((o) => o.type === req.evidenceType);
  if (!selected) return { status: 422, error: 'EVIDENCE_TYPE_NOT_OFFERED', detail: `${req.evidenceType} is not an evidence type for this case` };
  const blockers = draftBlockers({
    sentences: views,
    contradictions: c.contradictions,
    resolutions,
    analysisComplete: true,
    action: 'provide_evidence',
    allowedActions: x.allowedActions,
    evidenceType: { allowed: selected.allowed, satisfied: selected.satisfied, label: selected.label },
    submitted: x.submitted,
  });
  if (blockers.length) {
    return { status: 422, error: 'DRAFT_BLOCKED', detail: `Not ready to send: ${blockers.map((b) => b.text).join('; ')}`, blockers: blockers.map((b) => b.text) };
  }
  const supported = views.filter((v) => v.state === 'supported');
  const notes = notesText(views);
  if (!notes.trim()) return { status: 422, error: 'NOTES_REQUIRED', detail: 'No supported sentence to send' };
  return {
    submission: {
      disputeId: c.summary.id,
      action: 'provide_evidence',
      evidenceType: req.evidenceType,
      carrier: c.fulfillment.carrier,
      tracking: c.fulfillment.tracking,
      notes,
      files: c.attachments.map((a) => ({ name: a.name, size: a.size })),
    },
    sentences: supported.map((v) => ({ id: v.id, text: v.text.trim(), edited: v.edited })),
    views,
    resolutionNotes,
  };
}
