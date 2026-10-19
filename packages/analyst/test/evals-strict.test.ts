import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { CaseAnalysis, Contradiction } from '../src/types.ts';
import { CASES, type EvalCase } from '../evals/cases.ts';
import { computeMetrics, type CaseResult } from '../evals/metrics.ts';
import { fieldOf, normalise, scoreStrict } from '../evals/strict.ts';

// nr-address-mismatch with a strict label: the order (E1) says Flat 2, the carrier (E3) delivered to Flat 2B.
// the case as it was before labelling: no conflicts field (CASES now carries the labels of dev-labels.ts)
const base: EvalCase = (({ conflicts: _c, ...rest }) => rest)(CASES.find((c) => c.name === 'nr-address-mismatch')!);
const labelled: EvalCase = { ...base, conflicts: [{ field: 'address', a: { doc: 'E1', value: 'Flat 2' }, b: { doc: 'E3', value: 'Flat 2B' } }] };
const ORDER_LINE = 'Ship to: 7 Sample Road, Flat 2, Testford TF3 1AA';
const CARRIER_LINE = 'Delivered to: 7 Sample Road, Flat 2B, Testford TF3 1AA';

const side = (doc: string, quote: string, value: string) => ({ doc, quote, value });
const k = (o: Partial<Contradiction> & Pick<Contradiction, 'a' | 'b'>): Contradiction => ({
  id: 'C1',
  title: 'Unit number discrepancy in delivery address',
  shortName: 'address contradiction',
  explanation: '',
  sentenceId: null,
  rewrite: null,
  ...o,
});
const analysis = (contradictions: unknown[], facts: unknown[] = []) =>
  ({ facts, droppedFacts: 0, usage: { calls: [], inputTokens: 0, outputTokens: 0, thinkingTokens: 0 }, sentences: [], contradictions, injections: [], checklist: { title: '', items: [] }, recommendation: null }) as unknown as CaseAnalysis;
const right = () => k({ a: side('E1', ORDER_LINE, 'Flat 2'), b: side('E3', CARRIER_LINE, 'Flat 2B') });

test('normalise: money compares cents ("42.00 USD" = "$42" = "42"), addresses keep letters and digits ("Flat 2" ≠ "Flat 2B"), dates to ISO day, case and NFKC folded', () => {
  assert.equal(normalise('amount', '42.00 USD'), normalise('amount', '$42'));
  assert.equal(normalise('amount', '$42'), normalise('amount', '42'));
  assert.equal(normalise('amount', 'USD 1,042.5'), normalise('amount', '1042.50'));
  assert.notEqual(normalise('amount', '42.00 USD'), normalise('amount', '24.00 USD'));
  assert.notEqual(normalise('address', 'Flat 2'), normalise('address', 'Flat 2B'));
  assert.equal(normalise('address', 'Flat 2,'), normalise('address', 'flat  2'));
  assert.equal(normalise('postcode', 'TF3 1AA'), normalise('postcode', 'tf3-1aa'));
  assert.notEqual(normalise('postcode', 'TF3 1AA'), normalise('postcode', 'TF9 1AA'));
  assert.equal(normalise('date', '13 Sep 2026 10:04 UTC'), '2026-09-13');
  assert.equal(normalise('date', '13 September 2026'), '2026-09-13');
  assert.equal(normalise('date', 'September 13th, 2026'), '2026-09-13');
  assert.equal(normalise('date', '2026-09-13T10:04:00Z'), '2026-09-13');
  // NFKC: full-width letters and digits fold to ASCII; case and whitespace fold
  assert.equal(normalise('name', 'Ｍ.  Ｋ.'), normalise('name', 'm. k.'));
  assert.equal(normalise('address', 'ＦＬＡＴ ２Ｂ'), normalise('address', 'Flat 2B'));
});

test('fieldOf: the synonym table over shortName, then title; nothing mapped is null', () => {
  assert.equal(fieldOf(right()), 'address');
  assert.equal(fieldOf(k({ ...right(), shortName: 'postcode contradiction', title: 'Postcode discrepancy in delivery address' })), 'postcode');
  assert.equal(fieldOf(k({ ...right(), shortName: 'contradiction', title: 'Delivery unit discrepancy' })), 'address');
  assert.equal(fieldOf(k({ ...right(), shortName: 'amount contradiction', title: 'Disputed and captured amount versus item line' })), 'amount');
  assert.equal(fieldOf(k({ ...right(), shortName: 'contradiction', title: 'Documents disagree' })), null);
});

test('a contradiction with the expected documents, values and field is found, in either side order', () => {
  for (const c of [right(), k({ a: side('E3', CARRIER_LINE, 'Flat 2B'), b: side('E1', ORDER_LINE, 'Flat 2') })]) {
    const s = scoreStrict(labelled, analysis([c]));
    assert.deepEqual([s.expected, s.evaluable, s.found, s.missed], [1, 1, 1, 0]);
    assert.deepEqual([s.coverage.n, s.coverage.of, s.hits.n, s.hits.of], [1, 1, 1, 1]);
    assert.deepEqual([s.extras, s.notEvaluable, s.misses], [[], [], []]);
  }
});

test('the right documents with the values swapped between sides is a miss', () => {
  // E1 carries the carrier's value and E3 the order's: both values appear, but not on their documents
  const s = scoreStrict(labelled, analysis([k({ a: side('E1', ORDER_LINE, 'Flat 2B'), b: side('E3', CARRIER_LINE, 'Flat 2') })]));
  assert.deepEqual([s.expected, s.evaluable, s.found, s.missed], [1, 1, 0, 1]);
  assert.equal(s.misses.length, 1);
  assert.equal(s.extras.length, 1);
});

test('values swapped between sides are a miss even when each value is inside its own quote', () => {
  const lines = (id: string, text: string) => ({ id, title: id, type: 't', source: 's', tag: 'T', lines: [{ text }] });
  const c: EvalCase = {
    ...base,
    input: { ...base.input, documents: [lines('X', 'Order total 24.00 USD, card limit 42.00 USD'), lines('Y', 'Captured 42.00 USD on an order of 24.00 USD')] },
    conflicts: [{ field: 'amount', a: { doc: 'X', value: '24.00' }, b: { doc: 'Y', value: '42.00' } }],
  };
  const amount = (x: string, y: string) => k({ shortName: 'amount contradiction', a: side('X', 'Order total 24.00 USD, card limit 42.00 USD', x), b: side('Y', 'Captured 42.00 USD on an order of 24.00 USD', y) });
  assert.equal(scoreStrict(c, analysis([amount('24.00 USD', '42.00 USD')])).found, 1);
  const s = scoreStrict(c, analysis([amount('42.00 USD', '24.00 USD')]));
  assert.deepEqual([s.evaluable, s.found, s.missed], [1, 0, 1]);
});

test('a value from a third document is a miss', () => {
  // the shipping label (E4) instead of the carrier record (E3): a verbatim quote, the wrong document pair
  const c = k({ a: side('E1', ORDER_LINE, 'Flat 2'), b: side('E4', 'Ship to: 7 Sample Road, Flat 2, Testford TF3 1AA', 'Flat 2') });
  const s = scoreStrict(labelled, analysis([c]));
  assert.deepEqual([s.evaluable, s.found, s.missed], [1, 0, 1]);
  assert.deepEqual(s.extras, [{ case: 'nr-address-mismatch', field: 'address', a: 'E1 "Flat 2"', b: 'E4 "Flat 2"' }]);
});

test('right document pair but the wrong field is a miss (B3)', () => {
  const c = k({ ...right(), title: 'Delivery date mismatch', shortName: 'date contradiction' });
  const s = scoreStrict(labelled, analysis([c]));
  assert.deepEqual([s.evaluable, s.found, s.missed], [1, 0, 1]);
  assert.deepEqual(s.extras, [{ case: 'nr-address-mismatch', field: 'date', a: 'E1 "Flat 2"', b: 'E3 "Flat 2B"' }]);
});

test('right document pair but one value wrong is a miss (B3)', () => {
  // "Flat 2" is in the carrier line too ("Flat 2B" contains it): verbatim, but not the expected value
  const c = k({ a: side('E1', ORDER_LINE, 'Flat 2'), b: side('E3', CARRIER_LINE, 'Flat 2') });
  const s = scoreStrict(labelled, analysis([c]));
  assert.deepEqual([s.evaluable, s.found, s.missed], [1, 0, 1]);
  assert.equal(s.extras.length, 1);
});

test('right document pair and values but a quote not verbatim is not evaluable, not a hit (B3)', () => {
  const c = k({ a: side('E1', 'Ship to: 7 Sample Rd, Flat 2', 'Flat 2'), b: side('E3', CARRIER_LINE, 'Flat 2B') });
  const s = scoreStrict(labelled, analysis([c]));
  assert.deepEqual([s.expected, s.evaluable, s.found, s.missed], [1, 0, 0, 0]);
  assert.deepEqual([s.coverage.n, s.coverage.of, s.hits.of], [0, 1, 0]);
  assert.equal(s.hits.rate, null);
  assert.deepEqual(s.notEvaluable, [{ case: 'nr-address-mismatch', contradiction: 'C1', reason: 'quote_unverifiable' }]);
  assert.deepEqual(s.extras, []);
});

test('a quote naming a document that is not in the case is quote_unverifiable', () => {
  const c = k({ a: side('E1', ORDER_LINE, 'Flat 2'), b: side('E9', CARRIER_LINE, 'Flat 2B') });
  assert.equal(scoreStrict(labelled, analysis([c])).notEvaluable[0]?.reason, 'quote_unverifiable');
});

test('a quote is re-verified with the citation check\'s whitespace normalisation', () => {
  const c = k({ a: side('E1', '  Ship to:  7 Sample Road,\nFlat 2, Testford ', 'Flat 2'), b: side('E3', CARRIER_LINE, 'Flat 2B') });
  assert.equal(scoreStrict(labelled, analysis([c])).found, 1);
});

test('a value found elsewhere in the analysis but not in the contradiction is a miss', () => {
  // the facts state both values, but the contradiction's own sides do not carry them
  const facts = [
    { id: 'F1', doc: 'E1', quote: ORDER_LINE, statement: 'Order ships to Flat 2', at: null },
    { id: 'F2', doc: 'E3', quote: CARRIER_LINE, statement: 'Delivered to Flat 2B', at: null },
  ];
  const c = k({ a: side('E1', ORDER_LINE, '7 Sample Road'), b: side('E3', CARRIER_LINE, 'Testford TF3 1AA') });
  const s = scoreStrict(labelled, analysis([c], facts));
  assert.deepEqual([s.evaluable, s.found, s.missed], [1, 0, 1]);
});

test('a side whose value equals its whole quote is not evaluable (no_value)', () => {
  // the pipeline's fallback when the model's value is not inside the quote
  const c = k({ a: side('E1', ORDER_LINE, ORDER_LINE), b: side('E3', CARRIER_LINE, 'Flat 2B') });
  const s = scoreStrict(labelled, analysis([c]));
  assert.deepEqual([s.evaluable, s.found, s.missed], [0, 0, 0]);
  assert.deepEqual(s.notEvaluable.map((x) => x.reason), ['no_value']);
});

test('a contradiction with no field mapped is no_field; the expected conflict on its pair is not evaluable', () => {
  const c = k({ ...right(), title: 'Documents disagree', shortName: 'contradiction' });
  const s = scoreStrict(labelled, analysis([c]));
  assert.deepEqual([s.evaluable, s.found, s.missed], [0, 0, 0]);
  assert.deepEqual(s.notEvaluable.map((x) => x.reason), ['no_field']);
});

test('an older stored shape (no value, no shortName, no quote) is not evaluable with its reason, never a crash', () => {
  const old = [
    { id: 'C1', title: 'Address differs', a: { doc: 'E1', quote: ORDER_LINE }, b: { doc: 'E3', quote: CARRIER_LINE } },
    { id: 'C2', title: 'Address differs', a: { doc: 'E1' }, b: { doc: 'E3', quote: CARRIER_LINE, value: 'Flat 2B' } },
    { id: 'C3', a: { doc: 'E1', quote: ORDER_LINE, value: 'Flat 2' }, b: { doc: 'E3', quote: CARRIER_LINE, value: 'Flat 2B' } },
    { id: 'C4' },
  ];
  const s = scoreStrict(labelled, analysis(old));
  assert.deepEqual(s.notEvaluable.map((x) => `${x.contradiction}:${x.reason}`), ['C1:no_value', 'C2:quote_unverifiable', 'C3:no_field', 'C4:quote_unverifiable']);
  assert.deepEqual([s.expected, s.evaluable, s.found], [1, 0, 0]);
});

test('a contradiction matching no expected conflict is an extra, listed with field and values', () => {
  const amount = k({ id: 'C2', title: 'Charged amount differs', shortName: 'amount contradiction', a: side('E2', '24.00 USD · COMPLETED', '24.00 USD'), b: side('D', 'Disputed amount: 24.00 USD', '24.00') });
  const s = scoreStrict(labelled, analysis([right(), amount]));
  assert.deepEqual([s.found, s.missed], [1, 0]);
  assert.deepEqual(s.extras, [{ case: 'nr-address-mismatch', field: 'amount', a: 'E2 "24.00 USD"', b: 'D "24.00"' }]);
});

test('a case without conflicts labels is not_labelled, not a hit or a miss', () => {
  const s = scoreStrict(base, analysis([right()]));
  assert.deepEqual([s.expected, s.evaluable, s.found, s.missed], [0, 0, 0, 0]);
  assert.deepEqual(s.notEvaluable, [{ case: 'nr-address-mismatch', contradiction: 'C1', reason: 'not_labelled' }]);
  assert.deepEqual(s.unlabelled, ['nr-address-mismatch']);
  assert.deepEqual(s.extras, []);
});

test('computeMetrics sums the strict score over cases and reports ratios per set and per group', () => {
  const amountCase = CASES.find((c) => c.name === 'nr-amount-mismatch')!;
  const cases = [labelled, { ...amountCase, conflicts: [{ field: 'amount' as const, a: { doc: 'E1', value: '24.00' }, b: { doc: 'E2', value: '42.00' } }] }];
  const amount = k({ title: 'Disputed and captured amount versus item line', shortName: 'amount contradiction', a: side('E2', '42.00 USD · COMPLETED', '42.00 USD'), b: side('E1', '2 × Ceramic mug, sand · 24.00 USD', '24.00 USD') });
  const results: CaseResult[] = [
    { name: 'nr-address-mismatch', analysis: analysis([k({ a: side('E1', ORDER_LINE, ORDER_LINE), b: side('E3', CARRIER_LINE, 'Flat 2B') })]) },
    { name: 'nr-amount-mismatch', analysis: analysis([amount]) },
  ];
  const m = computeMetrics(cases, results);
  const s = m.strictContradictions;
  assert.deepEqual([s.expected, s.evaluable, s.found, s.missed], [2, 1, 1, 0]);
  assert.deepEqual([s.coverage.n, s.coverage.of, s.hits.n, s.hits.of], [1, 2, 1, 1]);
  assert.deepEqual(s.notEvaluable.map((x) => `${x.case}:${x.reason}`), ['nr-address-mismatch:no_value']);
  assert.deepEqual(Object.keys(m.bySet), ['development']);
  assert.deepEqual(m.bySet.development!['strictContradictions.coverage'], { n: 1, of: 2, rate: 0.5 });
  assert.deepEqual(m.bySet.development!.contradictionRecall, { n: 2, of: 2, rate: 1 });
  assert.deepEqual(Object.keys(m.byGroup), ['nr-address-mismatch', 'nr-amount-mismatch']);
  assert.deepEqual(m.byGroup['nr-amount-mismatch']!['strictContradictions.hits'], { n: 1, of: 1, rate: 1 });
  assert.deepEqual(m.byGroup['nr-address-mismatch']!['strictContradictions.hits'], { n: 0, of: 0, rate: null });
  assert.ok('injection.unchanged' in m.byGroup['nr-address-mismatch']!);
});

test('the old pair metric is unchanged', () => {
  const file = JSON.parse(readFileSync(new URL('../evals/results/gemini-rk-analyst-2026-10-09.7.json', import.meta.url), 'utf8'));
  const m = computeMetrics(CASES, file.results);
  assert.deepEqual(m.contradictionRecall, { n: 13, of: 13, rate: 1 });
  assert.deepEqual([m.citationValidity.n, m.citationValidity.of], [374, 374]);
  assert.deepEqual([m.baitRejected.n, m.baitRejected.of, m.baitNotSent.n, m.falseRejection.n, m.falseRejection.of, m.trueNotesSupported.n], [16, 17, 17, 0, 15, 12]);
  assert.equal(m.extraContradictions, 0);
  // every figure the stored file carries is recomputed identically
  for (const [key, value] of Object.entries(file.metrics)) assert.deepEqual((m as unknown as Record<string, unknown>)[key], value, key);
  // every development case is labelled (dev-labels.ts): none is reported unlabelled
  assert.equal(m.strictContradictions.unlabelled.length, 0);
});

test('every development case has set \'development\' and a group; the 10 injection cases share the group of nr-address-mismatch', () => {
  assert.equal(CASES.length, 19);
  for (const c of CASES) {
    assert.equal(c.set, 'development', c.name);
    assert.ok(c.group, c.name);
  }
  const inj = CASES.filter((c) => c.injection);
  assert.equal(inj.length, 10);
  for (const c of inj) assert.equal(c.group, CASES.find((x) => x.name === 'nr-address-mismatch')!.group, c.name);
  assert.equal(CASES.find((x) => x.name === 'nr-address-mismatch')!.group, 'nr-address-mismatch');
  for (const c of CASES.filter((x) => !x.injection)) assert.equal(c.group, c.name);
});

// ---- fix round 1 (rulings B8, B9 and review minors)

test('amount: only currency codes and symbols are stripped; the currency itself is not compared', () => {
  assert.notEqual(normalise('amount', '42 abc'), normalise('amount', '42'));
  assert.notEqual(normalise('amount', 'for 42'), normalise('amount', '42'));
  assert.notEqual(normalise('amount', '42 per'), normalise('amount', '42'));
  assert.equal(normalise('amount', '42.00 USD'), normalise('amount', '$42'));
  assert.equal(normalise('amount', '$42'), normalise('amount', '42'));
  assert.equal(normalise('amount', '€ 42'), normalise('amount', '42 gbp'));
  // documented: the code is stripped, not compared
  assert.equal(normalise('amount', '42 USD'), normalise('amount', '42 EUR'));
});

test('address: punctuation is removed without a space ("Flat 2-B" = "Flat 2B" ≠ "Flat 2")', () => {
  assert.equal(normalise('address', 'Flat 2-B'), normalise('address', 'Flat 2B'));
  assert.notEqual(normalise('address', 'Flat 2-B'), normalise('address', 'Flat 2'));
  assert.equal(normalise('address', '7 Sample Road, Flat 2'), normalise('address', '7 sample road flat 2'));
});

test('dates: an impossible day or a non-month word is not a date and cannot match one', () => {
  assert.equal(normalise('date', '31 Feb 2026'), '31 feb 2026');
  assert.notEqual(normalise('date', '2026-02-31'), normalise('date', '2026-03-03'));
  assert.equal(normalise('date', '2026-02-31'), '2026-02-31'.toLowerCase());
  assert.equal(normalise('date', '13 Marching 2026'), '13 marching 2026');
  assert.notEqual(normalise('date', '13 Marching 2026'), '2026-03-13');
  assert.equal(normalise('date', '13 Sept 2026'), '2026-09-13');
  assert.equal(normalise('date', '29 Feb 2028'), '2028-02-29');
  assert.equal(normalise('date', '29 Feb 2026'), '29 feb 2026');
});

test('B9: the words before "contradiction" in shortName decide; the title fallback ignores document names', () => {
  assert.equal(fieldOf(k({ ...right(), shortName: 'contradiction', title: 'Capture date differs' })), 'date');
  assert.equal(fieldOf(k({ ...right(), shortName: 'contradiction', title: 'Payment record and tracking record disagree on the flat' })), 'address');
  assert.equal(fieldOf(k({ ...right(), shortName: 'delivery date contradiction', title: 'Address differs' })), 'date');
  assert.equal(fieldOf(k({ ...right(), shortName: 'address contradiction', title: 'Captured amount differs' })), 'address');
  assert.equal(fieldOf(k({ ...right(), shortName: 'contradiction', title: 'Tracking number differs' })), 'tracking');
});

test('B9: an expected postcode conflict also accepts an output mapped to address (one-directional)', () => {
  const pc = CASES.find((c) => c.name === 'nr-postcode-mismatch')!;
  const lc: EvalCase = { ...pc, conflicts: [{ field: 'postcode', a: { doc: 'E1', value: 'TF3 1AA' }, b: { doc: 'E3', value: 'TF9 1AA' } }] };
  const c = k({ title: 'Postcode discrepancy in delivery address', shortName: 'address contradiction', a: side('E1', ORDER_LINE, 'TF3 1AA'), b: side('E3', 'Delivered to: 7 Sample Road, Flat 2, Testford TF9 1AA', 'TF9 1AA') });
  const s = scoreStrict(lc, analysis([c]));
  assert.deepEqual([s.evaluable, s.found, s.extras.length], [1, 1, 0]);
  // the other way round is a miss: an expected address conflict reported as a postcode one
  const back = scoreStrict(labelled, analysis([k({ ...right(), shortName: 'postcode contradiction' })]));
  assert.deepEqual([back.evaluable, back.found, back.missed], [1, 0, 1]);
});

test('B8: a labelled case whose attempt failed adds its conflicts to expected as not evaluable (no_analysis)', () => {
  const m = computeMetrics([labelled], [{ name: 'nr-address-mismatch', error: 'provider 429' }]);
  const s = m.strictContradictions;
  assert.deepEqual([s.expected, s.evaluable, s.found, s.missed], [1, 0, 0, 0]);
  assert.deepEqual(s.coverage, { n: 0, of: 1, rate: 0 });
  assert.deepEqual(s.notEvaluable, [{ case: 'nr-address-mismatch', contradiction: 'address E1↔E3', reason: 'no_analysis' }]);
  // an unlabelled failed case adds nothing; a case not in the results file at all was not part of that run
  assert.equal(computeMetrics([base], [{ name: 'nr-address-mismatch', error: 'x' }]).strictContradictions.expected, 0);
  assert.equal(computeMetrics([labelled], []).strictContradictions.expected, 0);
});

test('every development case with contradiction pairs has exactly one strict label per pair, naming the same two documents', () => {
  for (const c of CASES) {
    assert.ok(c.conflicts, `${c.name} is labelled`);
    assert.equal(c.conflicts.length, c.contradictions.length, c.name);
    c.contradictions.forEach(([x, y], i) => {
      const e = c.conflicts![i]!;
      assert.deepEqual([e.a.doc, e.b.doc].sort(), [x, y].sort(), c.name);
      assert.ok(e.a.value && e.b.value, c.name);
    });
  }
  assert.equal(CASES.reduce((n, c) => n + c.conflicts!.length, 0), 13);
});

test('scoring the stored gemini .7 results with the strict labels runs without error and reports coverage and hits separately', () => {
  const file = JSON.parse(readFileSync(new URL('../evals/results/gemini-rk-analyst-2026-10-09.7.json', import.meta.url), 'utf8'));
  const s = computeMetrics(CASES, file.results).strictContradictions;
  assert.equal(s.expected, 13);
  assert.equal(s.coverage.of, 13);
  assert.equal(s.coverage.n, s.evaluable);
  assert.equal(s.hits.of, s.evaluable);
  assert.equal(s.hits.n, s.found);
  assert.equal(s.evaluable, s.found + s.missed);
});
