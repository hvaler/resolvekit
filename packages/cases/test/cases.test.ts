import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { analysisKey, buildInput, type CaseAnalysis } from '@resolvekit/analyst';
import type { DisputeSnapshot } from '../../../apps/web/src/domain/types.ts';
import { PAYPAL_EVIDENCE_BY_REASON } from '../../../apps/web/src/domain/evidenceTypes.ts';
import {
  CASE_FILES,
  RESOLVED_SENT_NOTES,
  UNAUTHORISED_SENT_NOTES,
  agentCase,
  caseAllowedActions,
  caseInput,
  caseView,
  documentsSignature,
  resolvedCase,
  SETTLEMENT_CASE_ID,
  settlementCase,
  standardCase,
  unauthorisedCase,
  type PayPalSource,
} from '../src/index.ts';

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
  for (const c of Object.values(CASE_FILES)) {
    // The owner-only settlement case has no golden analysis (it is never warmed up or shown in the demo).
    if (c.audience === 'owner') continue;
    const input = caseInput(c, { kind: 'simulated' });
    assert.deepEqual(input, buildInput(c));
    const g = golden.find((a) => a.caseId === c.summary.id);
    assert.ok(g, `golden analysis for ${c.summary.id} (else: npm run golden -- --case ${c.summary.id} --golden)`);
    assert.equal(await analysisKey(input, g.requestedModel, g.promptVersion), g.key, c.summary.id);
  }
  assert.equal(Object.keys(CASE_FILES).length, 8);
  assert.ok(CASE_FILES[standardCase.summary.id] && CASE_FILES[agentCase.summary.id]);
});

test('the settlement case: the standard case (same 7.00 USD order) under its own id, owner only', () => {
  assert.equal(SETTLEMENT_CASE_ID, 'PP-R-STL-10190667');
  assert.equal(settlementCase.summary.id, SETTLEMENT_CASE_ID);
  assert.equal(CASE_FILES[SETTLEMENT_CASE_ID], settlementCase);
  assert.equal(settlementCase.audience, 'owner');
  assert.equal(settlementCase.summary.title, 'Owner settlement case (sandbox)');
  assert.equal(standardCase.audience, undefined);
  const { id: _a, title: _t, ...same } = settlementCase.summary;
  const { id: _b, ...std } = standardCase.summary;
  assert.deepEqual(same, std);
  assert.deepEqual(settlementCase.evidence, standardCase.evidence);
  assert.deepEqual(settlementCase.attachments, standardCase.attachments);
});

test('every case follows PayPal: actions by stage, evidence types from the reasons-and-evidence table, state by status', () => {
  for (const c of Object.values(CASE_FILES)) {
    const id = c.summary.id;
    const table = PAYPAL_EVIDENCE_BY_REASON[c.summary.reason];
    // send-message, make-offer and escalate exist only in the inquiry stage (Customer Disputes API reference).
    if (c.summary.stage === 'CHARGEBACK') assert.ok(!c.allowedActions.some((a) => a === 'send_message' || a === 'make_offer' || a === 'escalate'), id);
    if (c.requestedEvidenceType) {
      assert.ok(table.includes(c.requestedEvidenceType), `${id}: PayPal lists ${c.requestedEvidenceType} for ${c.summary.reason}`);
      assert.ok(c.evidenceTypes.some((t) => t.type === c.requestedEvidenceType && t.satisfied), `${id}: the requested type is offered and met`);
    }
    // Notes-and-documents evidence carries no tracking; proof of fulfillment needs it.
    for (const t of c.evidenceTypes) if (t.type === 'OTHER' && c.requestedEvidenceType === 'OTHER') assert.equal(c.fulfillment.tracking, '', id);
    const seller = (c.simulatedPayPal?.evidences ?? []).filter((e) => e.source === 'SUBMITTED_BY_SELLER');
    switch (c.summary.status) {
      case 'WAITING_FOR_SELLER_RESPONSE':
        assert.equal(seller.length, 0, id);
        assert.ok(c.allowedActions.includes('provide_evidence') && c.summary.respondBy && c.requestedEvidenceType, id);
        break;
      case 'WAITING_FOR_BUYER_RESPONSE':
        // Once the seller's evidence is in: no provide_evidence, no request, no seller due date (docs/sandbox-findings.md).
        assert.equal(seller.length, 1, id);
        assert.ok(!c.allowedActions.includes('provide_evidence') && !c.requestedEvidenceType && !c.summary.respondBy, id);
        assert.ok(c.simulatedPayPal?.buyerRespondBy, id);
        break;
      case 'RESOLVED':
        assert.deepEqual(c.allowedActions, [], id);
        assert.ok(c.simulatedPayPal?.outcome?.code, id);
        break;
      default:
        assert.fail(`${id}: unexpected status ${c.summary.status}`);
    }
    for (const e of seller) {
      assert.ok(table.includes(e.evidenceType as never), `${id}: recorded ${e.evidenceType}`);
      assert.deepEqual(e.files, c.attachments.map((a) => a.name), id);
      assert.equal(e.carrier, c.fulfillment.carrier, id);
      assert.equal(e.tracking, c.fulfillment.tracking, id);
    }
  }
});

test('recorded cases: the notes PayPal holds are exactly the supported sentences of the committed analysis', () => {
  for (const [c, notes] of [
    [unauthorisedCase, UNAUTHORISED_SENT_NOTES],
    [resolvedCase, RESOLVED_SENT_NOTES],
  ] as const) {
    const g = golden.find((a) => a.caseId === c.summary.id)!;
    const sent = g.sentences.filter((s) => s.verdict === 'supported').map((s) => s.text.trim()).join(' ');
    assert.ok(sent.length > 0 && sent.length <= 2000, c.summary.id);
    assert.equal(notes, sent, c.summary.id);
    assert.equal(c.simulatedPayPal!.evidences.find((e) => e.source === 'SUBMITTED_BY_SELLER')!.notes, notes);
    // The removed merchant note never went to PayPal.
    for (const s of g.sentences.filter((x) => x.verdict === 'rejected')) assert.ok(!notes.includes(s.text), s.text);
  }
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
