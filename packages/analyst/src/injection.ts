/**
 * Deterministic prompt-injection scan. A document that addresses the reviewer, the AI or the analyst, or tells it to
 * ignore evidence or decide the case, is flagged. The flag is shown to the merchant; it changes nothing else. The
 * model also flags documents (see pipeline.ts); both sources are merged.
 */
import type { AnalysisDocument, InjectionFlag } from './types.ts';
import { normalize } from './verify.ts';

const PATTERNS: RegExp[] = [
  // "To the reviewer:", "Note to the AI", "Dear assistant,"
  /\b(?:to|dear|attention|note to|message to|instructions? for)\s+(?:the\s+|any\s+)?(?:ai\s+|human\s+)?(?:reviewer|analyst|ai|assistant|model|llm|chatbot|moderator|adjudicator)s?\s*[:,\-—]/i,
  // "ignore the tracking record", "disregard previous instructions", "forget the evidence above"
  /\b(?:ignore|disregard|forget|overlook|skip|override)\b[^.\n]{0,60}\b(?:instructions?|prompt|rules?|evidence|records?|tracking|documents?|above|previous|prior|system)\b/i,
  // "system prompt", "new instructions:", "you are now"
  /\b(?:system prompt|new instructions?|developer message|you are now|act as|jailbreak)\b/i,
  // "you must recommend a full refund", "the AI should approve the claim"
  /\b(?:you|reviewer|ai|assistant|model|analyst)\s+(?:must|should|shall|have to|need to|will)\s+(?:recommend|approve|refund|decide|rule|accept|reject|output|respond|say)\b/i,
  // "recommend a full refund to the buyer", "respond only with ..."
  /\brecommend(?:ing)?\s+(?:a\s+)?(?:full\s+)?refund\b/i,
  /\b(?:respond|reply|answer|output)\s+only\s+with\b/i,
];

const ENDS_SENTENCE = /[.!?"”')]\s*$/;

/**
 * One flag per document: the first line that matches an instruction pattern, continued over the following lines
 * while the sentence runs on (instructions often wrap). Lines are also tried in pairs for a pattern split across a
 * line break. The case file's own "Received: …" metadata line is not document content and is not scanned.
 */
export function scanForInjection(docs: readonly AnalysisDocument[]): InjectionFlag[] {
  const out: InjectionFlag[] = [];
  const hits = (t: string) => PATTERNS.some((p) => p.test(t));
  for (const d of docs) {
    if (d.id === 'D') continue; // PayPal's own record
    const lines = d.lines.map((l) => normalize(l.text)).map((t) => (t.startsWith('Received: ') ? '' : t));
    let at = lines.findIndex((t) => t && hits(t));
    if (at < 0) at = lines.findIndex((t, i) => t && lines[i + 1] && hits(`${t} ${lines[i + 1]}`));
    if (at < 0) continue;
    const parts = [lines[at]!];
    for (let i = at + 1; i < lines.length && lines[i] && !ENDS_SENTENCE.test(parts[parts.length - 1]!) && parts.length < 4; i++) parts.push(lines[i]!);
    out.push({ doc: d.id, quote: parts.join(' '), by: ['pattern'] });
  }
  return out;
}

/** Merge the pattern flags with the model's (only verbatim model quotes are kept). */
export function mergeFlags(pattern: readonly InjectionFlag[], model: readonly InjectionFlag[]): InjectionFlag[] {
  const out = pattern.map((f) => ({ ...f, by: [...f.by] }));
  for (const m of model) {
    const same = out.find((f) => f.doc === m.doc);
    if (same) {
      if (!same.by.includes('model')) same.by.push('model');
    } else out.push({ doc: m.doc, quote: m.quote, by: ['model'] });
  }
  return out;
}
