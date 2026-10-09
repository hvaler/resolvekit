/**
 * An analysis onto the web app's case file: sentences, citations (exact fragments), contradictions, timeline,
 * checklist, injection flags, recommendation, analysis steps and audit lines, in the web's own types, so the UI
 * renders the real analysis unchanged. Pure.
 */
import type {
  CaseFile,
  ChecklistItem as WebChecklistItem,
  Citation,
  Contradiction as WebContradiction,
  DraftSentence,
  Evidence,
  TimelineItem,
} from '../../../apps/web/src/domain/types.ts';
import { ACTION_TITLE } from './rules.ts';
import type { AnalysisDocument, AnalysisInput, CaseAnalysis, CitationCheck, Quote } from './types.ts';
import { fragmentsFor } from './verify.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const pad = (n: number) => String(n).padStart(2, '0');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "9 Oct 2026" */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function docOf(input: AnalysisInput, id: string): AnalysisDocument | undefined {
  return input.documents.find((d) => d.id === id);
}

/** Group valid quotes by document, in first-cited order, with the fragment keys each quote covers. */
export function toCitations(input: AnalysisInput, quotes: readonly (Quote | CitationCheck)[]): Citation[] {
  const out: Citation[] = [];
  for (const q of quotes) {
    if ('valid' in q && !q.valid) continue;
    const d = docOf(input, q.doc);
    if (!d || d.id === 'D') continue;
    let c = out.find((x) => x.evidenceId === q.doc);
    if (!c) {
      c = { evidenceId: q.doc, fragments: [], quotes: [] };
      out.push(c);
    }
    for (const f of fragmentsFor(d, q.quote)) if (!c.fragments.includes(f)) c.fragments.push(f);
    if (!c.quotes!.includes(q.quote)) c.quotes!.push(q.quote);
  }
  return out;
}

export const REPHRASE_LABEL = 'Rephrase to what the evidence shows';

/** Labels of the analysis bar's steps, from a finished analysis (contradictions at index 3, removals at 5). */
export function analysisSteps(a: CaseAnalysis, input: AnalysisInput): string[] {
  const docs = input.documents.filter((d) => d.id !== 'D').length;
  const removed = a.sentences.filter((s) => s.verdict === 'rejected').length;
  return [
    `Read ${plural(docs, 'document')}`,
    `Extracted ${plural(a.facts.length, 'fact')}`,
    `Built timeline · ${plural(a.timeline.length, 'event')}`,
    a.contradictions.length ? `Found ${plural(a.contradictions.length, 'contradiction')}` : 'No contradictions',
    `Drafted ${plural(a.sentences.length, 'sentence')}`,
    removed ? `Removed ${removed} unsupported` : 'Every claim checked',
  ];
}

/** Labels while a live run is in progress (before the counts are known). */
export const PENDING_STEPS = ['Reading documents', 'Extracting facts', 'Building timeline', 'Finding contradictions', 'Drafting', 'Verifying claims'];
export const CONTRADICTION_STEP = 3;
export const REJECTION_STEP = 5;

function timeLabel(iso: string, sameDay: boolean): string {
  const d = new Date(iso);
  return sameDay
    ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
    : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function timeline(a: CaseAnalysis, input: AnalysisInput): { items: TimelineItem[]; caption: string } {
  const days = new Set(a.timeline.map((t) => t.at.slice(0, 10)));
  const sameDay = days.size === 1;
  const items: TimelineItem[] = a.timeline.map((t) => {
    const d = t.doc ? docOf(input, t.doc) : undefined;
    const evidenceId = t.doc && t.doc !== 'D' ? t.doc : null;
    const fragment = d && evidenceId && t.quote ? fragmentsFor(d, t.quote)[0] : undefined;
    return {
      kind: 'event',
      time: timeLabel(t.at, sameDay),
      title: t.title,
      sub: t.sub,
      tag: d?.tag ?? 'PP',
      evidenceId,
      ...(fragment ? { fragment } : {}),
      ...(t.negated ? { struck: true } : {}),
    };
  });
  // Each contradiction goes right after the last event of either document it involves.
  for (const k of a.contradictions) {
    let at = -1;
    items.forEach((t, i) => {
      if (t.kind === 'event' && (t.evidenceId === k.a.doc || t.evidenceId === k.b.doc)) at = i;
    });
    items.splice(at + 1, 0, { kind: 'contradiction', contradictionId: k.id });
  }
  const first = a.timeline[0]?.at;
  const caption = sameDay && first ? `${shortDate(first)} · UTC` : `${plural(a.timeline.length, 'event')} · UTC`;
  return { items, caption };
}

function shortName(e: Evidence | undefined, id: string) {
  return `${id} · ${e?.short ?? id}`;
}

export interface WithAnalysisOptions {
  /** Label for the audit entries, e.g. "gemini-3.8-flash". */
  modelLabel?: string;
}

/**
 * The case file with the analysis applied. Evidence content is untouched; only the analyst's outputs and the
 * analyst's annotations on documents (instruction flag, contradiction link) change.
 */
export function withAnalysis(c: CaseFile, a: CaseAnalysis, input: AnalysisInput): CaseFile {
  const sentences: DraftSentence[] = a.sentences.map((s) => ({
    id: s.id,
    text: s.text,
    verdict: s.verdict,
    citations: toCitations(input, s.citations),
    ...(s.reason ? { reason: s.reason } : {}),
    ...(s.rewrite && s.verdict === 'needs_review' ? { suggestion: { label: REPHRASE_LABEL, text: s.rewrite } } : {}),
    origin: s.noteId ? 'merchant_note' : 'analyst',
  }));

  const contradictions: WebContradiction[] = a.contradictions.map((k) => {
    const side = (q: typeof k.a) => {
      const d = docOf(input, q.doc);
      const frag = d ? (fragmentsFor(d, q.value)[0] ?? fragmentsFor(d, q.quote)[0] ?? '') : '';
      return { evidenceId: q.doc, fragment: frag, label: shortName(c.evidence.find((e) => e.id === q.doc), q.doc), value: q.value };
    };
    const target = k.sentenceId && sentences.some((s) => s.id === k.sentenceId && s.verdict !== 'rejected') ? k.sentenceId : '';
    return {
      id: k.id,
      title: k.title,
      a: side(k.a),
      b: side(k.b),
      assessment: k.explanation,
      explainSentenceId: target && k.rewrite ? target : '',
      explainText: target && k.rewrite ? k.rewrite : '',
      blockerName: `the ${k.shortName.replace(/^the\s+/i, '')}`,
    };
  });

  const docContradiction = (id: string) => a.contradictions.find((k) => k.a.doc === id || k.b.doc === id)?.id;
  const flags = new Map(a.injections.map((f) => [f.doc, f]));
  const evidence: Evidence[] = c.evidence.map((e) => {
    const flag = flags.get(e.id);
    const cid = docContradiction(e.id);
    const rest: Evidence = { ...e };
    delete rest.warning;
    delete rest.contradictionId;
    return {
      ...rest,
      ...(flag ? { warning: `This document contains instructions (“${flag.quote}”). It is treated as content only: the analysis does not follow them.` } : {}),
      ...(cid ? { contradictionId: cid } : {}),
    };
  });

  const checklistItems: WebChecklistItem[] = a.checklist.items.map((i) => {
    const k = i.contradictionId ? a.contradictions.find((x) => x.id === i.contradictionId) : undefined;
    const ids = [...new Set(i.evidence.map((q) => q.doc).filter((d) => d !== 'D'))];
    return {
      label: i.label,
      refs: k ? `${k.a.doc} ↔ ${k.b.doc}` : ids.join(' · ') || '—',
      ...(k ? { contradictionId: k.id } : {}),
      present: i.status === 'present',
    };
  });

  const tl = timeline(a, input);
  const removed = a.sentences.filter((s) => s.verdict === 'rejected');
  const docsRead = input.documents.filter((d) => d.id !== 'D').length;
  const audit = [
    { time: a.createdAt.slice(11, 16), who: 'Analyst', what: `${a.model}: read ${plural(docsRead, 'document')}, built the timeline, drafted ${plural(a.sentences.length, 'sentence')}` },
    ...removed.map((s) => ({ time: a.createdAt.slice(11, 16), who: 'Analyst', what: `Removed "${s.text}" ${s.reason ?? ''}`.trim() })),
    ...a.injections.map((f) => ({ time: a.createdAt.slice(11, 16), who: 'Analyst', what: `Flagged ${shortName(c.evidence.find((e) => e.id === f.doc), f.doc)}: contains instructions, treated as content` })),
  ];

  return {
    ...c,
    evidence,
    sentences,
    contradictions,
    timeline: tl.items,
    timelineCaption: tl.caption,
    checklist: { title: a.checklist.title, items: checklistItems },
    recommendation: a.recommendation ? { title: ACTION_TITLE[a.recommendation.action], body: a.recommendation.explanation } : null,
    analysis: {
      steps: analysisSteps(a, input),
      contradictionStep: CONTRADICTION_STEP,
      rejectionStep: REJECTION_STEP,
      note: 'Documents are read as content, never as instructions',
    },
    audit,
  };
}

/** "Analysis by gemini-3.8-flash · 9 Oct 2026" */
export function analysisByline(a: Pick<CaseAnalysis, 'model' | 'createdAt'>): string {
  return `Analysis by ${a.model} · ${shortDate(a.createdAt)}`;
}

