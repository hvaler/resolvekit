import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CORRECTED_MARK, SYSTEM, TRANSCRIBED_MARK, pageMark, renderDocuments, systemFor } from '../src/prompts.ts';
import type { AnalysisDocument } from '../src/types.ts';
import { checkCitations, fragmentsFor, isVerbatim } from '../src/verify.ts';

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
  // A PDF without corrected or transcribed lines gets only the page rule; a document without pages, nothing at all.
  assert.match(systemFor([plain]), /\n5\. In an uploaded PDF, a line "— page N of the original document —" marks where page N starts; it is not document text\. .*a quote never spans two pages\.$/);
  assert.equal(systemFor([plain]).replace(/\n5\. .*$/s, ''), SYSTEM);
  const lines = (d: AnalysisDocument) => ({ ...d, lines: d.lines.map((l, i) => ({ ...l, fragment: `E7.l${i + 1}` })) });
  assert.equal(systemFor([lines(plain)]), SYSTEM);
  assert.ok(!systemFor([lines(correctedOnly)]).includes('page N'));
  assert.ok(!systemFor([correctedOnly]).includes('transcribed manually'));
  // Phase 1's prompt for corrected lines is unchanged (stored analyses keep their keys).
  assert.match(systemFor([correctedOnly]), /\n5\. A line followed by "↳ corrected by the merchant"/);
  assert.match(systemFor([transcribedOnly]), /\n5\. A line followed by "↳ transcribed manually by the merchant" was typed by the merchant/);
  assert.ok(!systemFor([transcribedOnly]).includes('corrected by the merchant'));
  const both = systemFor([pdf]);
  assert.match(both, /\n5\. A line followed by "↳ corrected/);
  assert.match(both, /\n6\. A line followed by "↳ transcribed manually by the merchant" was typed by the merchant, not read from the document/);
  assert.match(both, /\n7\. In an uploaded PDF/);
  assert.ok(!renderDocuments([plain]).text.includes('↳'));
});

test('a quote stays within one page of a PDF: within a page it verifies and resolves, across pages it does not', () => {
  // Page 2's last line and page 8's first are not adjacent in the original: pages 3 to 7 lie between them.
  const across = 'Total 89.00 USD Delivered 8 Oct';
  assert.equal(isVerbatim([pdf], 'E7', across), false);
  assert.deepEqual(fragmentsFor(pdf, across), []);
  assert.equal(checkCitations([pdf], [{ doc: 'E7', quote: across }])[0]!.valid, false);
  const within = 'Delivered 8 Oct 2026 Signed by J. D.';
  assert.equal(isVerbatim([pdf], 'E7', within), true);
  assert.deepEqual(fragmentsFor(pdf, within), ['E7.p8.l1', 'E7.p8.l2']);
  assert.deepEqual(fragmentsFor(pdf, 'Signed by J. D.'), ['E7.p8.l2']);
  assert.deepEqual(fragmentsFor(pdf, 'INVOICE 2026-114 Total 89.00'), ['E7.p2.l1', 'E7.p2.l2']);
  // Any other document keeps quoting across its lines.
  const doc: AnalysisDocument = { ...pdf, id: 'E8', lines: [{ text: 'Total 89.00 USD', fragment: 'E8.l1' }, { text: 'Delivered 8 Oct 2026', fragment: 'E8.l2' }] };
  assert.equal(isVerbatim([doc], 'E8', across), true);
  assert.deepEqual(fragmentsFor(doc, across), ['E8.l1', 'E8.l2']);
});

test('page boundaries of a PDF are shown outside the quotable text; other documents render as before', () => {
  assert.equal(pageMark(8), '   — page 8 of the original document —');
  const rendered = renderDocuments([pdf]).text.split('\n');
  assert.equal(rendered[1], pageMark(2));
  assert.equal(rendered[2], 'INVOICE 2026-114');
  const p8 = rendered.indexOf(pageMark(8));
  assert.ok(p8 > 0);
  assert.equal(rendered[p8 + 1], 'Delivered 8 Oct 2026');
  assert.equal(rendered.filter((l) => l.includes('of the original document')).length, 2);
  assert.equal(isVerbatim([pdf], 'E7', 'page 8 of the original document'), false);
  const doc: AnalysisDocument = { ...pdf, id: 'E8', lines: [{ text: 'a', fragment: 'E8.l1' }, { text: 'b' }] };
  assert.deepEqual(renderDocuments([doc]).text.split('\n').slice(1, 3), ['a', 'b']);
  assert.ok(!renderDocuments([doc]).text.includes('original document'));
});
