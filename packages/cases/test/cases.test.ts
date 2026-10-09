import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { analysisKey, buildInput, type CaseAnalysis } from '@resolvekit/analyst';
import type { DisputeSnapshot } from '../../../apps/web/src/domain/types.ts';
import { CASE_FILES, agentCase, caseAllowedActions, caseInput, caseView, documentsSignature, standardCase, type PayPalSource } from '../src/index.ts';

const golden = readdirSync(new URL('../../analyst/golden/', import.meta.url))
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(new URL(`../../analyst/golden/${f}`, import.meta.url), 'utf8')) as CaseAnalysis);

const live = (over: Partial<DisputeSnapshot> = {}): PayPalSource => ({
  kind: 'live',
  failed: null,
  snap: {
    id: standardCase.summary.id,
    status: 'WAITING_FOR_SELLER_RESPONSE',
    stage: 'INQUIRY',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    allowedActions: ['provide_evidence', 'send_message'],
    requestedEvidence: ['PROOF_OF_FULFILLMENT'],
    amount: { value: '7.00', currency: 'USD' },
    createdAt: '2026-10-10T10:00:00.000Z',
    transaction: { id: 'CAPREAL7', amount: { value: '7.00', currency: 'USD' }, status: 'COMPLETED', createdAt: '2026-10-10T09:58:00.000Z' },
    evidences: [],
    readAt: '10 Oct 2026 10:05 UTC',
    origin: { kind: 'paypal', env: 'sandbox', disputeId: 'PP-D-REAL-7' },
    ...over,
  } as DisputeSnapshot,
});

test('simulated cases: the input is the demo case as committed, so the golden analyses still match', async () => {
  for (const c of [standardCase, agentCase]) {
    const input = caseInput(c, { kind: 'simulated' });
    assert.deepEqual(input, buildInput(c));
    const g = golden.find((a) => a.caseId === c.summary.id);
    assert.ok(g, `golden analysis for ${c.summary.id}`);
    assert.equal(await analysisKey(input, g.requestedModel, g.promptVersion), g.key);
  }
  assert.deepEqual(Object.keys(CASE_FILES).sort(), [agentCase.summary.id, standardCase.summary.id].sort());
});

test('bound case: PayPal’s capture and dispute record come from the read; merchant documents and notes stay', () => {
  const src = live();
  const input = caseInput(standardCase, src);
  const capture = input.documents.find((d) => d.id === 'E2')!;
  assert.deepEqual(capture.lines.map((l) => l.text), ['Capture CAPREAL7', '7.00 USD · COMPLETED', 'Transaction created 10 Oct 2026 09:58 UTC']);
  assert.ok(input.documents.find((d) => d.id === 'D')!.lines.some((l) => l.text === 'Opened: 10 Oct 2026 10:00:00 UTC'));
  assert.deepEqual(input.dispute.allowedActions, ['provide_evidence', 'send_message']);
  const demo = buildInput(standardCase);
  assert.deepEqual(input.documents.find((d) => d.id === 'E1'), demo.documents.find((d) => d.id === 'E1'));
  assert.deepEqual(input.merchantNotes, demo.merchantNotes);
  // The web app's own path (case view + its allowed actions) gives the same input.
  assert.deepEqual(input, buildInput(caseView(standardCase, src), { allowedActions: caseAllowedActions(src, undefined, standardCase.allowedActions) }));
});

test('the read time is not content: two reads of the same dispute give the same input', () => {
  assert.deepEqual(caseInput(standardCase, live()), caseInput(standardCase, live({ readAt: '10 Oct 2026 11:00 UTC' })));
});

test('documents signature ignores allowed actions only', () => {
  const a = caseInput(standardCase, live());
  const b = caseInput(standardCase, live({ allowedActions: ['send_message'] }));
  assert.equal(documentsSignature(a), documentsSignature(b));
  assert.notEqual(documentsSignature(a), documentsSignature(caseInput(standardCase, live({ stage: 'CHARGEBACK' }))));
});
