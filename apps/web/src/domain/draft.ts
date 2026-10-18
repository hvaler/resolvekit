import { contestedBy, type AnalysisDocument } from '@resolvekit/analyst';
import type {
  ActionCode,
  Citation,
  ChecklistItem,
  ChecklistState,
  Contradiction,
  ContradictionResolution,
  DraftSentence,
  SentenceState,
  SentenceView,
} from './types';

/** PayPal limits the provide-evidence `notes` field to 2,000 characters. */
export const NOTES_LIMIT = 2000;

/** Result of re-verifying an edited sentence (the analyst's live check, or why it could not run). */
export interface Recheck {
  state: 'supported' | 'needs_review' | 'rejected';
  reason: string | null;
  note: string;
  /** Citations the verifier chose for the new text; absent keeps the original ones. */
  citations?: Citation[];
}

/**
 * A line of an uploaded file whose text is the merchant's, not the recognition's: corrected by hand (their reading of
 * the file) or, on a PDF, transcribed by hand (a line the recognition did not read). A sentence resting on it is sent
 * only with the merchant's confirmation, whichever it is.
 */
export interface Correction {
  kind: 'corrected' | 'transcribed';
  /** 1-based line number in the upload; on a PDF, in its page. */
  line: number;
  /** On a PDF: the page of the original document the line is on. */
  page?: number;
  /** Its fragment key (`E7.l3`, `E7.p8.l3`): what a confirmation names, with the sentence (`S1@E7.l3`). */
  fragment: string;
  evidenceId: string;
  /** The corrected or transcribed text. */
  text: string;
  /** Who corrected or transcribed it. */
  by: string;
}

/** A PDF fragment's page of the original document and line in that page (`E7.p8.l3` → 8, 3); null for any other key. */
export function pageOf(fragment: string): { page: number; line: number } | null {
  const m = /^E\d+\.p(\d+)\.l(\d+)$/.exec(fragment);
  return m ? { page: Number(m[1]), line: Number(m[2]) } : null;
}

function linesOf(docs: readonly AnalysisDocument[], kind: Correction['kind']): Map<string, Correction> {
  const out = new Map<string, Correction>();
  for (const d of docs) {
    d.lines.forEach((l, i) => {
      const by = l[kind];
      if (!by || !l.fragment) return;
      const p = pageOf(l.fragment);
      out.set(l.fragment, { kind, line: p ? p.line : i + 1, ...(p ? { page: p.page } : {}), fragment: l.fragment, evidenceId: d.id, text: l.text, by });
    });
  }
  return out;
}

/**
 * The corrected lines of these analyst documents, by fragment key (`E7.l3`). The server builds it from the input it
 * analysed, the web app from the uploads' documents: both from the same upload records, so they agree.
 */
export const correctionsOf = (docs: readonly AnalysisDocument[]): Map<string, Correction> => linesOf(docs, 'corrected');

/** The lines transcribed by hand (on PDF uploads), by fragment key (`E7.p8.l3`), as {@link correctionsOf}. */
export const transcriptionsOf = (docs: readonly AnalysisDocument[]): Map<string, Correction> => linesOf(docs, 'transcribed');

/**
 * Every line a sentence needs the merchant's confirmation for, corrected or transcribed, by fragment key: the one
 * list both the server's composition and the browser's draft take as `corrections`.
 */
export const linesToConfirmOf = (docs: readonly AnalysisDocument[]): Map<string, Correction> => new Map([...correctionsOf(docs), ...transcriptionsOf(docs)]);

/** How a reason or note names the line: `line 3 of E7`, or on a PDF `line 3 of page 8 of E7`. */
export const lineRef = (k: Correction) => `line ${k.line} of ${k.page ? `page ${k.page} of ` : ''}${k.evidenceId}`;

/** A confirmation that sentence `sentenceId` reads the corrected or transcribed line `fragment` correctly: `S1@E7.l2`. */
export const correctionPair = (sentenceId: string, fragment: string) => `${sentenceId}@${fragment}`;

/** The corrected lines a sentence's citations cover, in citation order. */
function correctionsCited(citations: readonly Citation[], corrections: ReadonlyMap<string, Correction> | undefined): Correction[] {
  if (!corrections?.size) return [];
  const out: Correction[] = [];
  for (const c of citations) {
    for (const f of c.fragments) {
      const k = corrections.get(f);
      if (k && !out.includes(k)) out.push(k);
    }
  }
  return out;
}

export interface DraftContext {
  /** Merchant edits by sentence id (already trimmed, non-empty). */
  edits: Readonly<Record<string, string>>;
  /** Verifier results for the current edits, by sentence id. An edit without one is still being checked. */
  rechecks?: Readonly<Record<string, Recheck>>;
  /** Sentence currently being re-checked after an edit. */
  checking: string | null;
  /** Analysis replay progress: number of completed steps. */
  analysisStep: number;
  /** Step index at which rejected sentences are revealed. Before that they read "Checking support…". */
  rejectionStep: number;
  /**
   * The case's contradictions and how the merchant settled them: a sentence held back only because it cites one
   * side of a contradiction the merchant resolved (with a note) is released. Absent: nothing is released.
   */
  contradictions?: readonly Contradiction[];
  resolutions?: Readonly<Record<string, ContradictionResolution>>;
  /** Corrected and transcribed lines of the case's uploads, by fragment key ({@link linesToConfirmOf}). Absent: none. */
  corrections?: ReadonlyMap<string, Correction>;
  /**
   * The merchant's confirmations that a sentence reads a corrected line correctly, as `sentenceId@fragment` pairs
   * ({@link correctionPair}). A supported sentence citing corrected lines goes to review until every one of them has
   * its pair here: the correction may flip what the file says.
   */
  confirmedCorrections?: ReadonlySet<string>;
}

/** The contradiction a contested review reason names, if the merchant resolved it with a note. */
function resolvedContest(reason: string | null, ctx: DraftContext): { k: Contradiction; by: string; note: string } | null {
  const side = contestedBy(reason);
  if (!side || !ctx.contradictions) return null;
  const is = (x: Contradiction['a'], doc: string, value: string) => x.evidenceId === doc && x.value === value;
  const k = ctx.contradictions.find(
    (c) => (is(c.a, side.doc, side.value) && is(c.b, side.otherDoc, side.otherValue)) || (is(c.b, side.doc, side.value) && is(c.a, side.otherDoc, side.otherValue)),
  );
  const r = k ? ctx.resolutions?.[k.id] : undefined;
  return k && r?.status === 'resolved' ? { k, by: r.by, note: r.note } : null;
}

/** Derive what each sentence shows: verdict, edits, re-check in progress, analysis still running. */
export function deriveSentences(base: readonly DraftSentence[], ctx: DraftContext): SentenceView[] {
  return base.map((s, i) => {
    const edit = ctx.edits[s.id];
    let state: SentenceState = s.verdict;
    let text = s.text;
    let reason: string | null = s.reason ?? null;
    let note: string | null = null;
    let citations: Citation[] = s.citations;

    // Rejected sentences cannot be edited; an edit only applies to supported / needs-review ones. An edit is never
    // trusted before the verifier has checked it.
    if (edit !== undefined && s.verdict !== 'rejected') {
      const r = ctx.rechecks?.[s.id];
      text = edit;
      if (r) {
        state = r.state;
        reason = r.reason;
        note = r.note;
        if (r.citations) citations = r.citations;
      } else {
        state = 'checking';
      }
    }
    if (ctx.checking === s.id) state = 'checking';
    if (s.verdict === 'rejected' && ctx.analysisStep < ctx.rejectionStep + 1) state = 'pending';
    if (state === 'needs_review') {
      const settled = resolvedContest(reason, ctx);
      if (settled) {
        state = 'supported';
        reason = null;
        note = `Released: ${settled.k.blockerName.replace(/^the /, '')} resolved by ${settled.by} ("${settled.note}")`;
      }
    }
    let awaits: string[] = [];
    const relied = state === 'supported' ? correctionsCited(citations, ctx.corrections) : [];
    const unconfirmed = relied.filter((k) => !ctx.confirmedCorrections?.has(correctionPair(s.id, k.fragment)));
    if (relied.length && !unconfirmed.length) {
      note = [note, ...relied.map((k) => `Relies on ${lineRef(k)} as ${k.kind === 'transcribed' ? 'transcribed manually' : 'corrected'} by ${k.by}`)].filter(Boolean).join(' · ');
    } else if (unconfirmed.length) {
      const k = unconfirmed[0]!;
      state = 'needs_review';
      awaits = unconfirmed.map((x) => x.fragment);
      reason =
        k.kind === 'transcribed'
          ? `Why: it depends on ${lineRef(k)}, transcribed manually by ${k.by} ("${k.text}"). Confirm it is what the file shows.`
          : `Why: it depends on your correction of ${lineRef(k)} ("${k.text}"). Confirm it reads the file correctly.`;
    }

    return { id: s.id, num: i + 1, text, state, citations, reason, note, edited: edit !== undefined, ...(s.origin === 'merchant_note' ? { fromNote: true } : {}), ...(awaits.length ? { awaitsCorrections: awaits } : {}) };
  });
}

export interface DraftCounts {
  total: number;
  supported: number;
  needsReview: number;
  removed: number;
}

export function draftCounts(views: readonly SentenceView[]): DraftCounts {
  const n = (st: SentenceState) => views.filter((v) => v.state === st).length;
  return { total: views.length, supported: n('supported'), needsReview: n('needs_review'), removed: n('rejected') };
}

export function draftSummary(c: DraftCounts): string {
  return `${c.total} sentences · ${c.supported} supported · ${c.needsReview} needs review · ${c.removed} removed`;
}

/**
 * The notes text sent to PayPal: supported sentences only, in draft order, separated by a space.
 * Needs-review, removed, pending and re-checking sentences are never included.
 */
export function notesText(views: readonly SentenceView[]): string {
  return views
    .filter((v) => v.state === 'supported')
    .map((v) => v.text.trim())
    .join(' ');
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function notesCountLabel(notes: string): string {
  return `${formatCount(notes.length)} / ${formatCount(NOTES_LIMIT)}`;
}

/** Number of evidence citations per document, counting only sentences that will be sent or still need review. */
export function citationUse(views: readonly SentenceView[]): Record<string, number> {
  const used: Record<string, number> = {};
  for (const v of views) {
    if (v.state === 'rejected' || v.state === 'pending') continue;
    for (const c of v.citations) used[c.evidenceId] = (used[c.evidenceId] ?? 0) + 1;
  }
  return used;
}

export type BlockerKind = 'analysis' | 'checking' | 'needs_review' | 'contradiction' | 'notes_limit' | 'evidence_type' | 'action' | 'submitted';

export interface Blocker {
  kind: BlockerKind;
  text: string;
}

export interface BlockerInput {
  sentences: readonly SentenceView[];
  contradictions: readonly Contradiction[];
  resolutions: Readonly<Record<string, ContradictionResolution>>;
  analysisComplete: boolean;
  /** Why the analysis is not complete, when it is not simply still running. */
  analysisText?: string;
  action: ActionCode;
  allowedActions: readonly ActionCode[];
  evidenceType: { allowed: boolean; satisfied: boolean; label: string } | null;
  submitted: boolean;
}

/**
 * Everything that keeps "Review what will be sent" disabled. An empty list means the draft is ready
 * for the merchant's review (nothing is sent from the case file itself).
 */
export function draftBlockers(input: BlockerInput): Blocker[] {
  const out: Blocker[] = [];
  if (input.submitted) {
    out.push({ kind: 'submitted', text: 'evidence was already submitted to PayPal' });
    return out;
  }
  if (!input.analysisComplete) {
    out.push({ kind: 'analysis', text: input.analysisText ?? 'the analysis is still running' });
    return out;
  }
  for (const s of input.sentences) {
    if (s.state === 'checking' || s.state === 'pending') out.push({ kind: 'checking', text: `sentence ${s.num} is being checked` });
  }
  for (const s of input.sentences) {
    if (s.state === 'needs_review') out.push({ kind: 'needs_review', text: `sentence ${s.num} needs review` });
  }
  for (const c of input.contradictions) {
    if ((input.resolutions[c.id]?.status ?? 'open') === 'open') out.push({ kind: 'contradiction', text: `${c.blockerName} is open` });
  }
  if (!input.allowedActions.includes(input.action)) {
    out.push({ kind: 'action', text: 'PayPal does not allow this action right now' });
  } else if (input.action !== 'provide_evidence') {
    out.push({ kind: 'action', text: 'only "Provide evidence" can be sent from this screen for now' });
  }
  if (input.action === 'provide_evidence' && input.evidenceType) {
    if (!input.evidenceType.allowed) out.push({ kind: 'evidence_type', text: `PayPal won't accept "${input.evidenceType.label}" here` });
    else if (!input.evidenceType.satisfied) out.push({ kind: 'evidence_type', text: `the case file lacks what "${input.evidenceType.label}" needs` });
  }
  const notes = notesText(input.sentences);
  if (notes.length > NOTES_LIMIT) out.push({ kind: 'notes_limit', text: `the notes exceed PayPal's ${formatCount(NOTES_LIMIT)}-character limit` });
  return out;
}

/** Blockers the merchant has to act on (transient "checking" states are excluded). */
export function actionableBlockers(blockers: readonly Blocker[]): Blocker[] {
  return blockers.filter((b) => b.kind !== 'analysis' && b.kind !== 'checking');
}

export function blockerSentence(blockers: readonly Blocker[]): string {
  if (blockers.length === 0) return '';
  const texts = blockers.map((b) => b.text);
  const joined = texts.length === 1 ? texts[0] : `${texts.slice(0, -1).join(', ')} and ${texts[texts.length - 1]}`;
  return `To continue: ${joined}.`;
}

export function checklistState(item: ChecklistItem, resolutions: Readonly<Record<string, ContradictionResolution>>): ChecklistState {
  if (item.contradictionId) {
    return (resolutions[item.contradictionId]?.status ?? 'open') === 'open' ? 'contradicts' : 'resolved';
  }
  return item.present ? 'present' : 'missing';
}

export function checklistSummary(states: readonly ChecklistState[]): string {
  const ok = states.filter((s) => s === 'present' || s === 'resolved').length;
  const contra = states.filter((s) => s === 'contradicts').length;
  return `${ok} of ${states.length} present${contra ? ` · ${contra} contradicts` : ''}`;
}
