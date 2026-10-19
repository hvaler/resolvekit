/**
 * Strict contradiction metric, next to the pair metric in metrics.ts (which it does not change). Pure: computed from a
 * stored analysis and the case's own input documents, without calling a model.
 *
 * An output contradiction matches an expected conflict `{ field, a: { doc, value }, b: { doc, value } }` when all hold:
 * - its two sides cite the two expected documents (either order);
 * - the side on each document carries that document's expected value, after `normalise` (no fuzzy matching), and
 *   that value is inside the side's own quote;
 * - each side's quote is verbatim in its document, re-verified here with the citation check (`isVerbatim`);
 * - its field (`fieldOf`) is the expected field; an expected `postcode` also accepts an output mapped to `address`
 *   (the prompt groups postcodes under addresses). One-directional: an expected address never accepts a postcode.
 * Finding the values elsewhere in the analysis (facts, sentences) is not enough: they must be on the contradiction.
 *
 * Not evaluable (counted with its reason, never as a hit): a side whose quote is not verbatim in its document or names
 * a missing document (`quote_unverifiable`); a side with no value of its own, i.e. missing or the whole quote, which is
 * the pipeline's fallback when the model's value is not in the quote (`no_value`); no field mapped (`no_field`); a case
 * without strict labels (`not_labelled`). Checked in that order. A labelled case whose attempt has no analysis (a failed
 * attempt) adds each expected conflict as not evaluable (`no_analysis`), so coverage never overstates.
 *
 * Coverage and hits are reported apart: an expected conflict is evaluable unless it was not found and a not-evaluable
 * contradiction cites its document pair (that one might have been the hit). coverage = evaluable / expected,
 * hits = found / evaluable. An evaluable contradiction matching no expected conflict is an extra.
 */
import { isVerbatim, normalize } from '../src/verify.ts';
import type { CaseAnalysis, Contradiction } from '../src/types.ts';
import type { ConflictField, EvalCase } from './cases.ts';
import type { Ratio } from './metrics.ts';

export type NotEvaluableReason = 'no_value' | 'quote_unverifiable' | 'no_field' | 'not_labelled' | 'no_analysis';

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
 * Field synonyms for shortName, matched case-insensitively on the words before "contradiction" ("address
 * contradiction" → address), or on the whole shortName when it has no such word. When several match one text, the
 * first field in this order wins: the specific fields before `address`, whose words (ship, deliver) also qualify dates.
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

/**
 * The title fallback, used only when shortName maps no field. Titles name the documents ("Capture date differs",
 * "tracking record"), so document-name words (capture, payment, charge, tracking record, label) are left out.
 */
export const TITLE_SYNONYMS: Record<ConflictField, RegExp> = {
  ...FIELD_SYNONYMS,
  tracking: /tracking (?:number|no\b|id|code)|waybill|consignment/i,
  amount: /amount|total|price|\bpaid\b/i,
};

export function fieldOf(c: Contradiction): ConflictField | null {
  const short = str(c.shortName);
  const before = /^(.*?)\bcontradiction/i.exec(short)?.[1] ?? short;
  const title = str(c.title);
  return FIELD_ORDER.find((x) => FIELD_SYNONYMS[x].test(before)) ?? FIELD_ORDER.find((x) => TITLE_SYNONYMS[x].test(title)) ?? null;
}

/** Does an output field satisfy the expected one? Equal, or an address output for an expected postcode. */
const fieldAccepts = (expected: ConflictField, got: ConflictField) => got === expected || (expected === 'postcode' && got === 'address');

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** A month's number from its full name, its three-letter abbreviation or "sept"; 0 for any other word. */
const month = (w: string) => MONTHS.findIndex((m) => w === m || w === m.slice(0, 3) || (m === 'september' && w === 'sept')) + 1;
/** The ISO day, or null when that day does not exist (31 Feb, 29 Feb in a common year). */
function iso(y: string, m: number, d: string): string | null {
  const t = new Date(Date.UTC(+y, m - 1, +d));
  const ok = m >= 1 && t.getUTCFullYear() === +y && t.getUTCMonth() === m - 1 && t.getUTCDate() === +d;
  return ok ? `${y}-${String(m).padStart(2, '0')}-${d.padStart(2, '0')}` : null;
}

/** The ISO day a date text states, as written (no time zone conversion); null when none is recognised or valid. */
function isoDay(t: string): string | null {
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return iso(m[1]!, +m[2]!, m[3]!);
  m = /(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,})\b\.?,?\s+(\d{4})/.exec(t);
  if (m && month(m[2]!)) return iso(m[3]!, month(m[2]!), m[1]!);
  m = /\b([a-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/.exec(t);
  if (m && month(m[1]!)) return iso(m[3]!, month(m[1]!), m[2]!);
  return null;
}

/** ISO 4217 codes the runtime knows, lower-cased: the only words an amount may carry. */
const CURRENCIES = new Set(Intl.supportedValuesOf('currency').map((c) => c.toLowerCase()));

/**
 * The comparable form of a value: NFKC, case and whitespace folded; money as cents with currency symbols and ISO 4217
 * codes stripped (the currency itself is not compared: "42 USD" = "42 EUR"; any other word, as in "42 per", keeps the
 * value from reading as money); dates as ISO day; addresses with punctuation removed, no space put in its place
 * (letters and digits kept, so "Flat 2-B" = "Flat 2B" ≠ "Flat 2"); postcodes as their letters and digits only. A money
 * or date value that cannot be read (an impossible day, a word that is not a month) stays as folded text, so it
 * cannot match a real one.
 */
export function normalise(field: ConflictField, value: string): string {
  const t = normalize(value.normalize('NFKC').toLowerCase());
  switch (field) {
    case 'amount': {
      const n = t.replace(/\p{Sc}/gu, '').replace(/\b[a-z]{3}\b/g, (w) => (CURRENCIES.has(w) ? '' : w)).replace(/,/g, '').trim();
      return /^\d+(?:\.\d+)?$/.test(n) ? String(Math.round(Number(n) * 100)) : t;
    }
    case 'date':
      return isoDay(t) ?? t;
    case 'address':
      return normalize(t.replace(/[^\p{L}\p{N}\s]+/gu, ''));
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

/** How a contradiction is named in `notEvaluable`: its id, else its 1-based position (`#n`). */
export const contradictionId = (k: Partial<Contradiction>, i: number) => str(k.id) || `#${i + 1}`;

/** Why an output contradiction cannot be scored (checked in this order), or null when it can. */
export function contradictionProblem(docs: EvalCase['input']['documents'], k: Partial<Contradiction>): NotEvaluableReason | null {
  return sideProblem(docs, k.a) ?? sideProblem(docs, k.b) ?? (fieldOf(k as Contradiction) ? null : 'no_field');
}

const ratio = (n: number, of: number): Ratio => ({ n, of, rate: of ? n / of : null });
const show = (s: { doc: string; value: string }) => `${s.doc} "${s.value}"`;
const samePair = (x: string, y: string, p: string, q: string) => (x === p && y === q) || (x === q && y === p);

/** `a` undefined: the case's attempt produced no analysis (a failed attempt). */
export function scoreStrict(c: EvalCase, a: CaseAnalysis | undefined): StrictScore {
  const out: StrictScore = { expected: 0, evaluable: 0, found: 0, missed: 0, coverage: ratio(0, 0), hits: ratio(0, 0), misses: [], extras: [], notEvaluable: [], unlabelled: [] };
  if (!a) {
    for (const e of c.conflicts ?? []) out.notEvaluable.push({ case: c.name, contradiction: `${e.field} ${e.a.doc}↔${e.b.doc}`, reason: 'no_analysis' });
    out.expected = c.conflicts?.length ?? 0;
    out.coverage = ratio(0, out.expected);
    return out;
  }
  const list = (Array.isArray(a.contradictions) ? a.contradictions : []) as Array<Partial<Contradiction>>;
  const id = contradictionId;
  if (!c.conflicts) {
    out.unlabelled.push(c.name);
    list.forEach((k, i) => out.notEvaluable.push({ case: c.name, contradiction: id(k, i), reason: 'not_labelled' }));
    return out;
  }
  const docs = c.input.documents;
  const scored: Array<{ field: ConflictField; a: Side; b: Side; matched: boolean }> = [];
  const unscoredPairs: Array<[string, string]> = [];
  list.forEach((k, i) => {
    const reason = contradictionProblem(docs, k);
    if (reason) {
      out.notEvaluable.push({ case: c.name, contradiction: id(k, i), reason });
      unscoredPairs.push([str((k.a as Side | undefined)?.doc), str((k.b as Side | undefined)?.doc)]);
    } else scored.push({ field: fieldOf(k as Contradiction)!, a: k.a as Side, b: k.b as Side, matched: false });
  });
  for (const e of c.conflicts) {
    out.expected++;
    const want = (s: Side) => (s.doc === e.a.doc ? e.a : s.doc === e.b.doc ? e.b : null);
    const hit = scored.filter((k) => {
      if (!fieldAccepts(e.field, k.field) || !samePair(k.a.doc, k.b.doc, e.a.doc, e.b.doc)) return false;
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
