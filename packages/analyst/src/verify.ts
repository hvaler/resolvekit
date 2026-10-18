/**
 * Deterministic checks. No model is involved here: a citation is valid only when its quote is an exact substring of
 * the cited document (whitespace normalised, nothing else), and a sentence without a valid citation is rejected.
 */
import type { AnalysisDocument, CitationCheck, DocLine, Quote } from './types.ts';

/** Collapse runs of whitespace to one space and trim. The only normalisation applied to quotes. */
export const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

/** A document's text as the model sees it: one line per row. */
export function docText(d: AnalysisDocument): string {
  return d.lines.map((l) => l.text).join('\n');
}

/** The page of the original document a PDF upload's line is on (`E7.p8.l3` → 8); null for any other line. */
export function pageOfLine(l: DocLine): number | null {
  const m = /^E\d+\.p(\d+)\.l\d+$/.exec(l.fragment ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * The runs of lines a quote may span: the whole document, or for a PDF upload each page on its own. The pages kept
 * are not adjacent in the original (pages 3 to 7 can lie between pages 2 and 8), so a quote never joins two of them.
 */
function runsOf(d: AnalysisDocument): DocLine[][] {
  const runs: DocLine[][] = [];
  let page: number | null = null;
  for (const l of d.lines) {
    const p = pageOfLine(l);
    if (!runs.length || p !== page) runs.push([]);
    runs[runs.length - 1]!.push(l);
    page = p;
  }
  return runs;
}

/** Is `quote` an exact substring of document `docId` (whitespace normalised), within one page on a PDF? Empty quotes never are. */
export function isVerbatim(docs: readonly AnalysisDocument[], docId: string, quote: string): boolean {
  const d = docs.find((x) => x.id === docId);
  const q = normalize(quote);
  return !!d && q.length > 0 && runsOf(d).some((run) => normalize(run.map((l) => l.text).join('\n')).includes(q));
}

export function checkCitations(docs: readonly AnalysisDocument[], quotes: readonly Quote[]): CitationCheck[] {
  return quotes.map((q) => ({ doc: q.doc, quote: q.quote, valid: isVerbatim(docs, q.doc, q.quote) }));
}

/**
 * Fragment keys of the lines a quote covers, so the web app can light exactly those lines. Lines are joined with
 * one space in normalised form (on a PDF, within one page); every line overlapping the quote's span counts. The first
 * occurrence wins: the same text on two pages lights, and labels, the first of them only.
 */
export function fragmentsFor(d: AnalysisDocument, quote: string): string[] {
  const q = normalize(quote);
  if (!q) return [];
  for (const run of runsOf(d)) {
    const parts = run.map((l) => normalize(l.text));
    const at = parts.join(' ').indexOf(q);
    if (at < 0) continue;
    const end = at + q.length;
    const out: string[] = [];
    let pos = 0;
    run.forEach((l, i) => {
      const start = pos;
      const stop = pos + parts[i]!.length;
      pos = stop + 1;
      if (stop > at && start < end && l.fragment && !out.includes(l.fragment)) out.push(l.fragment);
    });
    return out;
  }
  return [];
}

/**
 * Numbers in the sentence that appear in none of its valid quotes (amounts, times, ids). A sentence that states a
 * number its evidence does not contain is a claim the evidence does not make: it goes to review. Ordinals and
 * dates written differently ("6 October" vs "6 Oct") still match on the digits. An amount that is the sum of two to
 * four cited amounts (0.05 + 0.40 + 0.92 = 1.37) counts as cited.
 */
export function unsupportedNumbers(sentence: string, quotes: readonly string[]): string[] {
  const hay = normalize(quotes.join(' ')).toLowerCase();
  // Tokens with a digit: amounts, times, ids, units ("4B" is not "4").
  const tokens = (sentence.toLowerCase().match(/[a-z0-9]*\d[a-z0-9]*(?:[.:,]\d+)*/g) ?? []).map((t) => t.replace(/^(\d+)(?:st|nd|rd|th)$/, '$1'));
  const sums = amountSums(hay);
  const missing: string[] = [];
  for (const n of tokens) {
    const esc = n.replace(/[.:,]/g, (c) => `\\${c}`);
    const found = new RegExp(`(?<![a-z0-9.])${esc}(?![a-z0-9]|[.:,]\\d)`).test(hay) || (/^\d+$/.test(n) && hay.includes(`${n}.00`)) || (/^\d+\.\d{2}$/.test(n) && sums.has(Math.round(Number(n) * 100)));
    if (!found && !missing.includes(n)) missing.push(n);
  }
  return missing;
}

/** Sums (in cents) of every combination of two to four distinct amounts with two decimals in the text. */
function amountSums(text: string): Set<number> {
  const amounts = (text.match(/(?<![\d.])\d+\.\d{2}(?!\d)/g) ?? []).map((a) => Math.round(Number(a) * 100)).slice(0, 24);
  const out = new Set<number>();
  const walk = (start: number, depth: number, sum: number) => {
    if (depth >= 2) out.add(sum);
    if (depth === 4) return;
    for (let i = start; i < amounts.length; i++) walk(i + 1, depth + 1, sum + amounts[i]!);
  };
  walk(0, 0, 0);
  return out;
}
