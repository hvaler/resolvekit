/**
 * The analyst pipeline over one case:
 *
 *   read (deterministic injection scan) → 1 extract (model) → 2 timeline · contradictions · checklist · draft (model,
 *   from the extracted facts only) → 3 verify (deterministic citation checks, then the model's support check on the
 *   cited quotes only) → 4 recommendation (deterministic rule; the model only explains it).
 *
 * Every quote the model returns is checked against the documents; what does not match is dropped or invalid.
 */
import { scanForInjection, mergeFlags } from './injection.ts';
import { ModelError, type AnalystModel } from './model.ts';
import {
  ANALYZE_SCHEMA,
  EXPLAIN_SCHEMA,
  EXTRACT_SCHEMA,
  PROMPT_VERSION,
  RECHECK_SCHEMA,
  SCREEN_SCHEMA,
  SYSTEM,
  VERIFY_SCHEMA,
  analyzePrompt,
  explainPrompt,
  extractPrompt,
  recheckPrompt,
  screenPrompt,
  verifyPrompt,
} from './prompts.ts';
import { decideAction, requirementsFor } from './rules.ts';
import type {
  AnalysisInput,
  CallUsage,
  CaseAnalysis,
  ChecklistItem,
  CitationCheck,
  Contradiction,
  Fact,
  InjectionFlag,
  Progress,
  Sentence,
  Stage,
  TimelineEvent,
  Usage,
  Verdict,
} from './types.ts';
import { isVerbatim, normalize, unsupportedNumbers } from './verify.ts';


export interface RunOptions {
  model: AnalystModel;
  /** The primary model's id, recorded as `requestedModel`. */
  requestedModel?: string;
  key?: string;
  now?: () => Date;
  onProgress?: (p: Progress) => void;
  onUsage?: (u: CallUsage) => void;
  /**
   * Evals only (ablation): run as if nothing had been detected. Flags are still computed and reported, but are not
   * marked in the prompts and do not cap verdicts, to measure that safety does not depend on detection.
   */
  ignoreDetection?: boolean;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function sumUsage(calls: CallUsage[]): Usage {
  return {
    calls,
    inputTokens: calls.reduce((a, c) => a + c.inputTokens, 0),
    outputTokens: calls.reduce((a, c) => a + c.outputTokens, 0),
    thinkingTokens: calls.reduce((a, c) => a + c.thinkingTokens, 0),
  };
}

const validIso = (s: unknown): s is string => isStr(s) && !Number.isNaN(Date.parse(s));

/** Facts with a verbatim quote from a known document, renumbered F1…; the rest are dropped and counted. */
export function cleanFacts(raw: unknown, input: AnalysisInput): { facts: Fact[]; dropped: number } {
  const facts: Fact[] = [];
  let dropped = 0;
  for (const r of asArr(raw).map(rec)) {
    const doc = isStr(r.doc) ? r.doc : '';
    const quote = isStr(r.quote) ? r.quote : '';
    if (!isVerbatim(input.documents, doc, quote)) {
      dropped++;
      continue;
    }
    facts.push({ id: `F${facts.length + 1}`, doc, quote, statement: isStr(r.statement) ? r.statement : quote, at: validIso(r.at) ? new Date(r.at).toISOString() : null });
  }
  return { facts, dropped };
}

function cite(facts: readonly Fact[], ids: unknown): CitationCheck[] {
  const out: CitationCheck[] = [];
  for (const id of asArr(ids)) {
    const f = facts.find((x) => x.id === id);
    if (f && !out.some((c) => c.doc === f.doc && c.quote === f.quote)) out.push({ doc: f.doc, quote: f.quote, valid: true });
  }
  return out;
}

export interface ModelVerdict {
  verdict: Verdict;
  reason: string;
  rewrite: string;
}

/**
 * Deterministic part of verification, before and after the model:
 * - no valid citation → rejected (the model is not asked);
 * - the model's verdict stands, except that a "supported" sentence stating a number none of its quotes contain goes
 *   to review.
 */
export function settleVerdict(text: string, citations: readonly CitationCheck[], model: ModelVerdict | null): Pick<Sentence, 'verdict' | 'reason' | 'decidedBy' | 'rewrite'> {
  const valid = citations.filter((c) => c.valid);
  if (valid.length === 0) {
    return { verdict: 'rejected', reason: 'Removed: no evidence in the case file is cited for this. It will not be sent.', decidedBy: 'deterministic', rewrite: null };
  }
  if (!model) return { verdict: 'needs_review', reason: 'Why: the support check did not answer for this sentence.', decidedBy: 'deterministic', rewrite: null };
  const rewrite = model.rewrite.trim() ? model.rewrite.trim() : null;
  if (model.verdict === 'supported') {
    const missing = unsupportedNumbers(text, valid.map((c) => c.quote));
    if (missing.length) {
      return { verdict: 'needs_review', reason: `Why: ${missing.map((n) => `"${n}"`).join(', ')} does not appear in the cited evidence.`, decidedBy: 'deterministic', rewrite };
    }
    return { verdict: 'supported', reason: null, decidedBy: 'model', rewrite: null };
  }
  const why = model.reason.trim() || (model.verdict === 'rejected' ? 'the cited evidence does not state this' : 'the cited evidence only partly supports this');
  const body = why.charAt(0).toUpperCase() + why.slice(1);
  return model.verdict === 'rejected'
    ? { verdict: 'rejected', reason: `Removed: ${body.replace(/\.?$/, '.')} It will not be sent.`, decidedBy: 'model', rewrite }
    : { verdict: 'needs_review', reason: `Why: ${body.replace(/\.?$/, '.')}`, decidedBy: 'model', rewrite };
}

/**
 * A sentence resting on an instruction-bearing document is never "supported" automatically: at most it goes to
 * review, so the merchant decides. (Detection only adds this caution; safety does not depend on it.)
 */
export function capFlagged(
  v: Pick<Sentence, 'verdict' | 'reason' | 'decidedBy' | 'rewrite'>,
  citations: readonly CitationCheck[],
  flagged: ReadonlySet<string>,
): Pick<Sentence, 'verdict' | 'reason' | 'decidedBy' | 'rewrite'> {
  const docs = [...new Set(citations.filter((c) => c.valid && flagged.has(c.doc)).map((c) => c.doc))];
  if (v.verdict !== 'supported' || docs.length === 0) return v;
  return { ...v, verdict: 'needs_review', reason: `Why: it cites ${docs.join(', ')}, a document that contains instructions; confirm it yourself.`, decidedBy: 'deterministic' };
}

/**
 * A sentence citing one side of a detected contradiction but not the other is never "supported" automatically: its
 * cited quotes agree with it only because the conflicting document was left out. Citing both sides (stating both
 * values) is fine.
 */
export function capContested(
  v: Pick<Sentence, 'verdict' | 'reason' | 'decidedBy' | 'rewrite'>,
  citations: readonly CitationCheck[],
  contradictions: readonly Contradiction[],
): Pick<Sentence, 'verdict' | 'reason' | 'decidedBy' | 'rewrite'> {
  if (v.verdict !== 'supported') return v;
  const cites = (side: Contradiction['a']) => citations.some((c) => c.valid && c.doc === side.doc && normalize(c.quote) === normalize(side.quote));
  for (const k of contradictions) {
    const [one, other] = cites(k.a) && !cites(k.b) ? [k.a, k.b] : cites(k.b) && !cites(k.a) ? [k.b, k.a] : [null, null];
    if (one && other) {
      return { ...v, verdict: 'needs_review', reason: `Why: it relies on ${one.doc} ("${one.value}"), which ${other.doc} contradicts ("${other.value}"). State both or resolve the contradiction.`, decidedBy: 'deterministic' };
    }
  }
  return v;
}

/** Remove fact/note id references a model may write into a sentence ("… (F5, F6)"): ids are not evidence text. */
export const stripIdRefs = (t: string) => normalize(t.replace(/\s*[([]\s*(?:[FNSE]\d{1,3}\s*[,;]?\s*)+[)\]]/g, '')).replace(/\s+([.,;:])/g, '$1');

function parseVerdict(r: Record<string, unknown>): ModelVerdict {
  const v = r.verdict;
  return {
    verdict: v === 'supported' || v === 'needs_review' || v === 'rejected' ? v : 'needs_review',
    reason: isStr(r.reason) ? r.reason : '',
    rewrite: isStr(r.rewrite) ? r.rewrite : '',
  };
}

/**
 * Instruction flags reported by a model. A flag on a real document always counts (a signal can add, never clear);
 * its quote is kept only when verbatim, otherwise the document's first content line is shown.
 */
export function modelFlagsFrom(raw: unknown, input: AnalysisInput, by: 'model' | 'classifier'): InjectionFlag[] {
  const out: InjectionFlag[] = [];
  for (const r of asArr(raw).map(rec)) {
    const d = input.documents.find((x) => x.id === r.doc && x.id !== 'D');
    if (!d || out.some((f) => f.doc === d.id)) continue;
    const quote = isStr(r.quote) && isVerbatim(input.documents, d.id, r.quote) ? normalize(r.quote) : normalize(d.lines.find((l) => !l.text.startsWith('Received: '))?.text ?? d.title);
    out.push({ doc: d.id, quote, by: [by] });
  }
  return out;
}

/** Run up to `limit` tasks at a time, results in order. */
async function pool<T, R>(items: readonly T[], limit: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await f(items[i]!);
      }
    }),
  );
  return out;
}

/** Run the whole pipeline. Throws ModelError when the model (and its fallback) cannot answer. */
export async function analyzeCase(input: AnalysisInput, o: RunOptions): Promise<CaseAnalysis> {
  const calls: CallUsage[] = [];
  const now = o.now ?? (() => new Date());
  const call = async (stage: string, user: string, schema: Record<string, unknown>, maxOutputTokens: number) => {
    const r = await o.model.generate({ stage, system: SYSTEM, user, schema, maxOutputTokens });
    calls.push(r.usage);
    o.onUsage?.(r.usage);
    return rec(r.json);
  };
  const progress = (stage: Stage, label: string) => o.onProgress?.({ stage, label });
  const docs = input.documents;
  const evidenceDocs = docs.filter((d) => d.id !== 'D');

  // 0. Read: deterministic injection scan.
  const patternFlags = scanForInjection(docs);
  progress('read', `Read ${plural(evidenceDocs.length, 'document')}`);

  // 1. Extract facts with verbatim quotes; in parallel, the classifier screens the documents for instructions. The
  // classifier can only add flags: if it fails, the other signals stand.
  const [ex, screen] = await Promise.all([
    call('extract', extractPrompt(input.dispute, docs), EXTRACT_SCHEMA, 12_000),
    call('screen', screenPrompt(evidenceDocs), SCREEN_SCHEMA, 1_500).catch(() => null),
  ]);
  const { facts, dropped } = cleanFacts(ex.facts, input);
  if (facts.length === 0) throw new ModelError('The model extracted no verifiable facts', { retryable: false });
  const injections = mergeFlags(patternFlags, modelFlagsFrom(ex.instructions, input, 'model'), modelFlagsFrom(screen?.flags, input, 'classifier'));
  const flagged = new Set(o.ignoreDetection ? [] : injections.map((f) => f.doc));
  progress('extract', `Extracted ${plural(facts.length, 'fact')}`);

  // 2. Timeline, contradictions, checklist and draft, from the facts only.
  const reqs = requirementsFor(input.dispute);
  const an = await call('analyze', analyzePrompt({ dispute: input.dispute, documents: evidenceDocs, facts, flagged, requirements: reqs.items, notes: input.merchantNotes }), ANALYZE_SCHEMA, 12_000);
  const factById = (id: unknown) => facts.find((f) => f.id === id);

  const timeline: TimelineEvent[] = asArr(an.timeline)
    .map(rec)
    .filter((t) => validIso(t.at) && isStr(t.title))
    .map((t) => {
      const f = factById(t.fact);
      return { at: new Date(t.at as string).toISOString(), title: t.title as string, sub: isStr(t.sub) ? t.sub : '', doc: f?.doc ?? null, quote: f?.quote ?? null, negated: t.negated === true };
    })
    .filter((t) => t.doc !== null)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  progress('timeline', `Built timeline · ${plural(timeline.length, 'event')}`);

  const rawSentences = asArr(an.sentences).map(rec).filter((s) => isStr(s.text) && s.text.trim());
  const sentenceIds = rawSentences.map((_, i) => `S${i + 1}`);
  const modelSentenceId = (v: unknown) => {
    const i = rawSentences.findIndex((s) => s.id === v);
    return i >= 0 ? sentenceIds[i]! : null;
  };

  const contradictions: Contradiction[] = [];
  const contradictionIndex = new Map<number, string>();
  asArr(an.contradictions)
    .map(rec)
    .forEach((c, i) => {
      const a = rec(c.a);
      const b = rec(c.b);
      const fa = factById(a.fact);
      const fb = factById(b.fact);
      if (!fa || !fb || fa.doc === fb.doc) return;
      const value = (f: Fact, v: unknown) => (isStr(v) && normalize(f.quote).includes(normalize(v)) && v.trim() ? normalize(v) : f.quote);
      const id = `C${contradictions.length + 1}`;
      contradictionIndex.set(i, id);
      contradictions.push({
        id,
        title: isStr(c.title) ? c.title : 'Documents disagree',
        shortName: isStr(c.shortName) && c.shortName.trim() ? c.shortName.trim() : 'contradiction',
        a: { doc: fa.doc, quote: fa.quote, value: value(fa, a.value) },
        b: { doc: fb.doc, quote: fb.quote, value: value(fb, b.value) },
        explanation: isStr(c.explanation) ? c.explanation : '',
        sentenceId: modelSentenceId(c.sentence),
        rewrite: isStr(c.rewrite) && c.rewrite.trim() ? c.rewrite.trim() : null,
      });
    });
  progress('contradictions', contradictions.length ? `Found ${plural(contradictions.length, 'contradiction')}` : 'No contradictions');

  const rawChecklist = asArr(an.checklist).map(rec);
  const checklistItems: ChecklistItem[] = reqs.items.map((r) => {
    const m = rawChecklist.find((x) => x.id === r.id);
    const evidence = cite(facts, m?.facts).map(({ doc, quote }) => ({ doc, quote }));
    let status: ChecklistItem['status'] = m?.status === 'present' || m?.status === 'contradicts' ? m.status : 'missing';
    const cid = typeof m?.contradiction === 'number' ? (contradictionIndex.get(m.contradiction) ?? null) : null;
    // "contradicts" needs a contradiction that survived the checks; "present" needs evidence.
    if (status === 'contradicts' && !cid) status = evidence.length ? 'present' : 'missing';
    if (status === 'present' && evidence.length === 0) status = 'missing';
    return { id: r.id, label: r.label, critical: r.critical, status, evidence, contradictionId: status === 'contradicts' ? cid : null };
  });

  const drafted = rawSentences.map((s, i) => ({
    id: sentenceIds[i]!,
    text: stripIdRefs(s.text as string),
    noteId: isStr(s.note) && input.merchantNotes.some((n) => n.id === s.note) ? (s.note as string) : null,
    citations: cite(facts, s.facts),
  }));
  progress('draft', `Drafted ${plural(drafted.length, 'sentence')}`);

  // 3. Verify. Citations come from verified facts. Each sentence is judged in its own call, seeing only its text and
  // its own cited quotes: text from a document it does not cite (an undetected injection included) cannot reach
  // its verdict. A failed call leaves the sentence in review, never supported.
  const toCheck = drafted.filter((s) => s.citations.some((c) => c.valid));
  const verdicts = new Map<string, ModelVerdict>();
  await pool(toCheck, 4, async (s) => {
    try {
      const v = await call('verify', verifyPrompt([{ id: s.id, text: s.text, quotes: s.citations.filter((c) => c.valid) }]), VERIFY_SCHEMA, 2_000);
      const r = asArr(v.results).map(rec).find((x) => x.id === s.id) ?? asArr(v.results).map(rec)[0];
      if (r) verdicts.set(s.id, parseVerdict(r));
    } catch {
      /* no verdict: settleVerdict keeps it in review */
    }
  });
  const sentences: Sentence[] = drafted.map((s) => ({
    ...s,
    ...capContested(capFlagged(settleVerdict(s.text, s.citations, verdicts.get(s.id) ?? null), s.citations, flagged), s.citations, contradictions),
  }));
  const removed = sentences.filter((s) => s.verdict === 'rejected').length;
  progress('verify', removed ? `Removed ${plural(removed, 'unsupported claim')}` : 'Every claim checked');

  // 4. Recommendation: rule decides, model explains from supported sentences only.
  const decided = decideAction({ dispute: input.dispute, checklist: checklistItems, sentences });
  let recommendation: CaseAnalysis['recommendation'] = null;
  if (decided) {
    const supported = sentences.filter((s) => s.verdict === 'supported').map((s) => s.text);
    let explanation = '';
    try {
      const e = await call('explain', explainPrompt({ dispute: input.dispute, action: decided.action, rule: decided.rule, supported }), EXPLAIN_SCHEMA, 2_000);
      explanation = isStr(e.explanation) ? e.explanation.trim() : '';
    } catch {
      explanation = '';
    }
    recommendation = { ...decided, explanation: explanation || `${decided.rule}. The decision is yours, and PayPal decides the outcome.` };
  }
  progress('ready', 'Ready for your review');

  const last = calls[calls.length - 1];
  return {
    caseId: input.caseId,
    key: o.key ?? '',
    promptVersion: PROMPT_VERSION,
    requestedModel: o.requestedModel ?? o.model.model,
    provider: last?.provider ?? o.model.provider,
    model: last?.model ?? o.model.model,
    createdAt: now().toISOString(),
    facts: facts.map(({ id, doc, quote, statement, at }) => ({ id, doc, quote, statement, at })),
    droppedFacts: dropped,
    timeline,
    contradictions,
    checklist: { title: reqs.title, items: checklistItems },
    sentences,
    injections,
    recommendation,
    usage: sumUsage(calls),
  };
}


/** Re-check one edited sentence against the analysis's facts: the model picks citations and judges support. */
export async function recheckSentence(
  analysis: Pick<CaseAnalysis, 'facts' | 'injections'> & { contradictions?: CaseAnalysis['contradictions'] },
  input: Pick<AnalysisInput, 'documents'>,
  text: string,
  o: Pick<RunOptions, 'model' | 'onUsage'>,
): Promise<{ citations: CitationCheck[]; usage: CallUsage } & Pick<Sentence, 'verdict' | 'reason' | 'decidedBy' | 'rewrite'>> {
  const flagged = new Set(analysis.injections.map((f) => f.doc));
  const r = await o.model.generate({ stage: 'recheck', system: SYSTEM, user: recheckPrompt(normalize(text), analysis.facts, flagged), schema: RECHECK_SCHEMA, maxOutputTokens: 3_000 });
  o.onUsage?.(r.usage);
  const j = rec(r.json);
  // Facts are re-verified against the documents: a cached analysis could be stale.
  const citations = cite(analysis.facts, j.facts).map((c) => ({ ...c, valid: isVerbatim(input.documents, c.doc, c.quote) }));
  const settled = capFlagged(settleVerdict(normalize(text), citations, parseVerdict(j)), citations, flagged);
  return { citations, usage: r.usage, ...capContested(settled, citations, analysis.contradictions ?? []) };
}

