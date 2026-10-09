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

    return { id: s.id, num: i + 1, text, state, citations, reason, note, edited: edit !== undefined, ...(s.origin === 'merchant_note' ? { fromNote: true } : {}) };
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
