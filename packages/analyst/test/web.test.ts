import assert from 'node:assert/strict';
import { test } from 'node:test';
import { standardCase } from '../../../apps/web/src/fixtures/standardCase.ts';
import { analyzeCase } from '../src/pipeline.ts';
import { analysisSteps, withAnalysis } from '../src/web.ts';
import { fakeModel, input, standardScript } from './fake.ts';

test('web mapping: sentences carry citations as fragment keys plus the exact quotes; verdicts and reasons kept', async () => {
  const inp = input();
  const a = await analyzeCase(inp, { model: fakeModel(standardScript).model });
  const c = withAnalysis(standardCase, a, inp);
  const s1 = c.sentences.find((s) => s.id === 'S1')!;
  assert.equal(s1.verdict, 'supported');
  assert.deepEqual(s1.citations, [
    { evidenceId: 'E1', fragments: ['E1.date'], quotes: ['Order #10482 · placed 6 Oct 2026 14:02 UTC'] },
    { evidenceId: 'E2', fragments: ['E2.amt'], quotes: ['7.00 USD · COMPLETED'] },
  ]);
  const s5 = c.sentences.find((s) => s.id === 'S5')!;
  assert.equal(s5.verdict, 'rejected');
  assert.equal(s5.origin, 'merchant_note');
  const s6 = c.sentences.find((s) => s.id === 'S6')!;
  assert.deepEqual(s6.suggestion, { label: 'Rephrase to what the evidence shows', text: 'UPS delivered to 12 Example Street, Apt 4B.' });
});

test('web mapping: contradiction card, timeline placement, evidence flags, checklist and recommendation', async () => {
  const inp = input();
  const a = await analyzeCase(inp, { model: fakeModel(standardScript).model });
  const c = withAnalysis(standardCase, a, inp);
  const k = c.contradictions[0]!;
  assert.deepEqual(k.a, { evidenceId: 'E1', fragment: 'E1.addr', label: 'E1 · Order', value: 'Apt 4' });
  assert.deepEqual(k.b, { evidenceId: 'E3', fragment: 'E3.addr', label: 'E3 · UPS tracking', value: 'Apt 4B' });
  assert.equal(k.explainSentenceId, 'S3');
  assert.equal(k.blockerName, 'the address contradiction');
  // The contradiction sits right after the last event of a document it involves (E3's delivery).
  assert.deepEqual(
    c.timeline.map((t) => (t.kind === 'event' ? t.title : `[${t.contradictionId}]`)),
    ['Order placed', 'Shipped', 'Delivered', '[C1]'],
  );
  const delivered = c.timeline[2]!;
  assert.ok(delivered.kind === 'event' && delivered.fragment === 'E3.deliv' && delivered.time === '8 Oct 11:52' && delivered.tag === 'CAR');
  assert.match(c.evidence.find((e) => e.id === 'E6')!.warning!, /contains instructions .*treated as content only/);
  assert.equal(c.evidence.find((e) => e.id === 'E1')!.contradictionId, 'C1');
  assert.equal(c.evidence.find((e) => e.id === 'E5')!.warning, undefined);
  assert.deepEqual(
    c.checklist!.items.map((i) => [i.label, i.refs, i.present, i.contradictionId ?? null]),
    [
      ['Tracking number with delivery confirmation', 'E3', true, null],
      ['Carrier and ship date', 'E3', true, null],
      ['Delivery address matches the order', 'E1 ↔ E3', false, 'C1'],
      ['Signature or proof of receipt', '—', false, null],
      ['Payment record for the disputed amount', 'E2', true, null],
    ],
  );
  assert.equal(c.recommendation!.title, 'Recommended: Provide evidence.');
  assert.deepEqual(analysisSteps(a, inp), ['Read 6 documents', 'Extracted 7 facts', 'Built timeline · 3 events', 'Found 1 contradiction', 'Drafted 6 sentences', 'Removed 1 unsupported']);
  assert.equal(c.analysis.contradictionStep, 3);
  assert.equal(c.analysis.rejectionStep, 5);
  // Document content is never changed by the analysis.
  assert.deepEqual(
    c.evidence.map((e) => e.body),
    standardCase.evidence.map((e) => e.body),
  );
});
