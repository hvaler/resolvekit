/**
 * Strict contradiction metric, next to the pair metric in metrics.ts (which it does not change). Pure: computed from a
 * stored analysis and the case's own input documents, without calling a model.
 *
 * An output contradiction matches an expected conflict `{ field, a: { doc, value }, b: { doc, value } }` when all hold:
 * - its two sides cite the two expected documents (either order);
 * - the side on each document carries that document's expected value, after `normalise` (no fuzzy matching), and
 *   that value is inside the side's own quote;
 * - each side's quote is verbatim in its document, re-verified here with the citation check (`isVerbatim`);
 * - its field, mapped from shortName then title through `FIELD_SYNONYMS`, is the expected field.
 * Finding the values elsewhere in the analysis (facts, sentences) is not enough: they must be on the contradiction.
 *
 * Not evaluable (counted with its reason, never as a hit): a side whose quote is not verbatim in its document or names
 * a missing document (`quote_unverifiable`); a side with no value of its own, i.e. missing or the whole quote, which is
 * the pipeline's fallback when the model's value is not in the quote (`no_value`); no field mapped (`no_field`); a case
 * without strict labels (`not_labelled`). Checked in that order.
 *
 * Coverage and hits are reported apart: an expected conflict is evaluable unless it was not found and a not-evaluable
 * contradiction cites its document pair (that one might have been the hit). coverage = evaluable / expected,
 * hits = found / evaluable. An evaluable contradiction matching no expected conflict is an extra.
 */
import { isVerbatim, normalize } from '../src/verify.ts';
import type { CaseAnalysis, Contradiction } from '../src/types.ts';
import type { ConflictField, EvalCase } from './cases.ts';
import type { Ratio } from './metrics.ts';

export type NotEvaluableReason = 'no_value' | 'quote_unverifiable' | 'no_field' | 'not_labelled';

export interface StrictScore {
  /** Expected conflicts in the labelled cases. */
  expected: number;
  /** Expected conflicts that could be decided (found, or missed with no not-evaluable contradiction on their pair). */
  evaluable: number;
  found: number;
  /** Evaluable and not found. */
  missed: number;
  /** evaluable / expected. */
  coverage: Ratio;
  /** found / evaluable. */
  hits: Ratio;
  misses: Array<{ case: string; field: ConflictField; a: string; b: string }>;
  extras: Array<{ case: string; field: ConflictField | null; a: string; b: string }>;
  notEvaluable: Array<{ case: string; contradiction: string; reason: NotEvaluableReason }>;
  /** Cases scored without strict labels. */
  unlabelled: string[];
}

/**
 * Field synonyms, matched case-insensitively on shortName first, then title. When several match one text, the first
 * field in this order wins: the specific fields before `address`, whose words (ship, deliver) also qualify dates.
 */
export const FIELD_SYNONYMS: Record<ConflictField, RegExp> = {
  postcode: /postcode|post code|postal|zip/i,
  tracking: /tracking|track number|waybill|consignment/i,
  amount: /amount|total|charge|captur|price|paid|payment/i,
  date: /date|\bday\b|\btime\b|timestamp/i,
  quantity: /quantit|\bqty\b|how many|\bcount\b/i,
  name: /\bname\b|recipient|signat|signed/i,
  item: /\bitem|product|colou?r|\bsku\b|description/i,
  address: /address|ship|deliver|flat|\bapt\b|apartment|\bunit\b|street|road/i,
};
const FIELD_ORDER = Object.keys(FIELD_SYNONYMS) as ConflictField[];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function fieldOf(c: Contradiction): ConflictField | null {
  for (const text of [str(c.shortName), str(c.title)]) {
    const f = FIELD_ORDER.find((x) => FIELD_SYNONYMS[x].test(text));
    if (f) return f;
  }
  return null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const iso = (y: string, m: number, d: string) => (m >= 1 && m <= 12 && +d >= 1 && +d <= 31 ? `${y}-${String(m).padStart(2, '0')}-${d.padStart(2, '0')}` : null);
const month = (name: string) => MONTHS.indexOf(name.slice(0, 3)) + 1;

/** The ISO day a date text states, as written (no time zone conversion); null when none is recognised. */
function isoDay(t: string): string | null {
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return iso(m[1]!, +m[2]!, m[3]!);
  m = /(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,})\.?,?\s+(\d{4})/.exec(t);
  if (m && month(m[2]!)) return iso(m[3]!, month(m[2]!), m[1]!);
  m = /([a-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/.exec(t);
  if (m && month(m[1]!)) return iso(m[3]!, month(m[1]!), m[2]!);
  return null;
}

/**
 * The comparable form of a value: NFKC, case and whitespace folded; money as cents with the currency code or symbol
 * stripped; dates as ISO day; addresses with punctuation removed (letters and digits kept, so "Flat 2" ≠ "Flat 2B");
 * postcodes as their letters and digits only. A money or date value that cannot be read stays as folded text.
 */
export function normalise(field: ConflictField, value: string): string {
  const t = normalize(value.normalize('NFKC').toLowerCase());
  switch (field) {
    case 'amount': {
      const n = t.replace(/[\p{Sc}]/gu, '').replace(/\b[a-z]{3}\b/g, '').replace(/,/g, '').trim();
      return /^\d+(?:\.\d+)?$/.test(n) ? String(Math.round(Number(n) * 100)) : t;
    }
    case 'date':
      return isoDay(t) ?? t;
    case 'address':
      return normalize(t.replace(/[^\p{L}\p{N}]+/gu, ' '));
    case 'postcode':
      return t.replace(/[^\p{L}\p{N}]+/gu, '');
    default:
      return t;
  }
}

type Side = { doc: string; quote: string; value: string };

/** Why a side cannot be scored, or null when it can. Tolerates stored shapes without quote or value. */
function sideProblem(docs: EvalCase['input']['documents'], s: unknown): NotEvaluableReason | null {
  const x = (s ?? {}) as Partial<Side>;
  if (!str(x.doc) || !str(x.quote) || !isVerbatim(docs, x.doc!, x.quote!)) return 'quote_unverifiable';
  const v = normalize(str(x.value));
  if (!v || v === normalize(x.quote!)) return 'no_value';
  return null;
}

const ratio = (n: number, of: number): Ratio => ({ n, of, rate: of ? n / of : null });
const show = (s: { doc: string; value: string }) => `${s.doc} "${s.value}"`;
const samePair = (x: string, y: string, p: string, q: string) => (x === p && y === q) || (x === q && y === p);

export function scoreStrict(c: EvalCase, a: CaseAnalysis): StrictScore {
  const out: StrictScore = { expected: 0, evaluable: 0, found: 0, missed: 0, coverage: ratio(0, 0), hits: ratio(0, 0), misses: [], extras: [], notEvaluable: [], unlabelled: [] };
  const list = (Array.isArray(a.contradictions) ? a.contradictions : []) as Array<Partial<Contradiction>>;
  const id = (k: Partial<Contradiction>, i: number) => str(k.id) || `#${i + 1}`;
  if (!c.conflicts) {
    out.unlabelled.push(c.name);
    list.forEach((k, i) => out.notEvaluable.push({ case: c.name, contradiction: id(k, i), reason: 'not_labelled' }));
    return out;
  }
  const docs = c.input.documents;
  const scored: Array<{ field: ConflictField; a: Side; b: Side; matched: boolean }> = [];
  const unscoredPairs: Array<[string, string]> = [];
  list.forEach((k, i) => {
    const reason = sideProblem(docs, k.a) ?? sideProblem(docs, k.b) ?? (fieldOf(k as Contradiction) ? null : 'no_field');
    if (reason) {
      out.notEvaluable.push({ case: c.name, contradiction: id(k, i), reason });
      unscoredPairs.push([str((k.a as Side | undefined)?.doc), str((k.b as Side | undefined)?.doc)]);
    } else scored.push({ field: fieldOf(k as Contradiction)!, a: k.a as Side, b: k.b as Side, matched: false });
  });
  for (const e of c.conflicts) {
    out.expected++;
    const want = (s: Side) => (s.doc === e.a.doc ? e.a : s.doc === e.b.doc ? e.b : null);
    const hit = scored.filter((k) => {
      if (k.field !== e.field || !samePair(k.a.doc, k.b.doc, e.a.doc, e.b.doc)) return false;
      // each side must carry the value of ITS document: the right pair with the values swapped is not a hit
      const ok = (s: Side) => normalize(s.quote).includes(normalize(s.value)) && normalise(e.field, s.value) === normalise(e.field, want(s)!.value);
      return ok(k.a) && ok(k.b);
    });
    hit.forEach((k) => (k.matched = true));
    if (hit.length) {
      out.evaluable++;
      out.found++;
    } else if (!unscoredPairs.some(([x, y]) => samePair(x, y, e.a.doc, e.b.doc))) {
      out.evaluable++;
      out.missed++;
      out.misses.push({ case: c.name, field: e.field, a: show(e.a), b: show(e.b) });
    }
  }
  for (const k of scored) if (!k.matched) out.extras.push({ case: c.name, field: k.field, a: show(k.a), b: show(k.b) });
  out.coverage = ratio(out.evaluable, out.expected);
  out.hits = ratio(out.found, out.evaluable);
  return out;
}

/** The scores of several cases summed, with coverage and hits recomputed over the totals. */
export function sumStrict(scores: readonly StrictScore[]): StrictScore {
  const t = (k: 'expected' | 'evaluable' | 'found' | 'missed') => scores.reduce((n, s) => n + s[k], 0);
  const [expected, evaluable, found, missed] = [t('expected'), t('evaluable'), t('found'), t('missed')];
  return {
    expected,
    evaluable,
    found,
    missed,
    coverage: ratio(evaluable, expected),
    hits: ratio(found, evaluable),
    misses: scores.flatMap((s) => s.misses),
    extras: scores.flatMap((s) => s.extras),
    notEvaluable: scores.flatMap((s) => s.notEvaluable),
    unlabelled: scores.flatMap((s) => s.unlabelled),
  };
}
