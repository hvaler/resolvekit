import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CORRECTED_MARK, SYSTEM, TRANSCRIBED_MARK, renderDocuments, systemFor } from '../src/prompts.ts';
import type { AnalysisDocument } from '../src/types.ts';
import { checkCitations, fragmentsFor } from '../src/verify.ts';

/** A confirmed PDF upload of pages 2 and 8: page-scoped fragments, a corrected line and a transcribed one. */
const pdf: AnalysisDocument = {
  id: 'E7',
  title: 'Uploaded PDF',
  type: 'Merchant upload · PDF',
  source: 'Uploaded by Ana',
  tag: 'UPL',
  lines: [
    { text: 'INVOICE 2026-114', fragment: 'E7.p2.l1' },
    { text: 'Total 89.00 USD', fragment: 'E7.p2.l2', corrected: 'Ana (member)' },
    { text: 'Delivered 8 Oct 2026', fragment: 'E7.p8.l1' },
    { text: 'Signed by J. D.', fragment: 'E7.p8.l2', transcribed: 'Ana (member)' },
  ],
};

test('TRANSCRIBED_MARK follows a transcribed line on its own line, outside the quotable text', () => {
  assert.equal(TRANSCRIBED_MARK, '   ↳ transcribed manually by the merchant');
  const rendered = renderDocuments([pdf]).text.split('\n');
  const at = rendered.indexOf('Signed by J. D.');
  assert.ok(at > 0);
  assert.equal(rendered[at + 1], TRANSCRIBED_MARK);
  assert.equal(rendered.filter((l) => l === TRANSCRIBED_MARK).length, 1);
  assert.equal(rendered[rendered.indexOf('Total 89.00 USD') + 1], CORRECTED_MARK);
  // The marker is not content: a quote of it does not verify; the transcribed line itself does.
  assert.deepEqual(checkCitations([pdf], [{ doc: 'E7', quote: 'transcribed manually by the merchant' }, { doc: 'E7', quote: 'Signed by J. D.' }]).map((c) => c.valid), [false, true]);
});

test('the transcription rule is in the system prompt only when a transcribed line exists', () => {
  const plain = { ...pdf, lines: pdf.lines.map(({ corrected: _c, transcribed: _t, ...l }) => l) };
  const correctedOnly = { ...pdf, lines: pdf.lines.map(({ transcribed: _t, ...l }) => l) };
  const transcribedOnly = { ...pdf, lines: pdf.lines.map(({ corrected: _c, ...l }) => l) };
  assert.equal(systemFor([plain]), SYSTEM);
  assert.ok(!systemFor([correctedOnly]).includes('transcribed manually'));
  // Phase 1's prompt for corrected lines is unchanged (stored analyses keep their keys).
  assert.match(systemFor([correctedOnly]), /\n5\. A line followed by "↳ corrected by the merchant"/);
  assert.match(systemFor([transcribedOnly]), /\n5\. A line followed by "↳ transcribed manually by the merchant" was typed by the merchant/);
  assert.ok(!systemFor([transcribedOnly]).includes('corrected by the merchant'));
  const both = systemFor([pdf]);
  assert.match(both, /\n5\. A line followed by "↳ corrected/);
  assert.match(both, /\n6\. A line followed by "↳ transcribed manually by the merchant" was typed by the merchant, not read from the document/);
  assert.ok(!renderDocuments([plain]).text.includes('↳'));
});

test('page-scoped fragments resolve in the verifier', () => {
  assert.deepEqual(fragmentsFor(pdf, 'Total 89.00 USD Delivered 8 Oct'), ['E7.p2.l2', 'E7.p8.l1']);
  assert.deepEqual(fragmentsFor(pdf, 'Signed by J. D.'), ['E7.p8.l2']);
});
