import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CaseAnalysis } from '../src/types.ts';
import { computeMetrics } from '../evals/metrics.ts';
import type { EvalCase } from '../evals/cases.ts';

const c = {
  name: 'u',
  trueNotes: [],
  baitNotes: [],
  contradictions: [],
  requiredFacts: [
    { id: 'date', doc: 'E7', needle: 'Delivered 13 Sep' },
    { id: 'sign', doc: 'E8', needle: 'signed for by M. K.' },
  ],
} as unknown as EvalCase;

const analysis = (sentences: unknown[], facts: unknown[]) =>
  ({ facts, droppedFacts: 0, usage: { calls: [], inputTokens: 0, outputTokens: 0, thinkingTokens: 0 }, sentences, contradictions: [], injections: [] }) as unknown as CaseAnalysis;
const cite = (doc: string, quote: string, valid = true) => ({ doc, quote, valid });

test('upload metrics: required facts cited from the uploads, validity and support counted apart', () => {
  const a = analysis(
    [
      { id: 'S1', noteId: null, verdict: 'supported', citations: [cite('E7', 'Delivered  13 Sep 2026 10:04'), cite('E1', 'Order')] },
      { id: 'S2', noteId: 'N1', verdict: 'needs_review', citations: [cite('E7', 'Delivered 13 Sep 2026', false)] },
      { id: 'S3', noteId: null, verdict: 'rejected', citations: [cite('E8', 'signed for by M. K.')] },
    ],
    [
      { id: 'F1', doc: 'E7', quote: 'Delivered 13 Sep 2026 10:04' },
      { id: 'F2', doc: 'E8', quote: 'signed for by M. K.' },
    ],
  );
  const u = computeMetrics([c], [{ name: 'u', analysis: a }]).uploads!;
  assert.deepEqual([u.uploadCitationsValid.n, u.uploadCitationsValid.of], [2, 3]);
  assert.deepEqual(u.sentencesCitingUploads, { supported: 1, total: 2 });
  assert.deepEqual([u.requiredExtracted.n, u.requiredExtracted.of], [2, 2]);
  // "date" is cited by a kept sentence (whitespace-normalised); "sign" only by a removed one
  assert.deepEqual([u.requiredCited.n, u.requiredCited.of], [1, 2]);
  assert.deepEqual(u.rows.map((r) => r.citedFromUpload), [true, false]);
});

test('no upload metrics for a case without required facts', () => {
  const m = computeMetrics([{ ...c, requiredFacts: undefined } as unknown as EvalCase], [{ name: 'u', analysis: analysis([], []) }]);
  assert.equal(m.uploads, undefined);
});
