import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInput } from '@resolvekit/analyst';
import type { AgentRunSummary, CaseFile, DisputeSnapshot, MeteredSession } from '../../../apps/web/src/domain/types.ts';
import { agentCase, caseView, withMeterMcp, withPayPal, type PayPalSource } from '../src/index.ts';

const SID = 'mm-sess-0123456789abcdef0123456789abcdef';

/** A real session: one OK call of 0.40, captured 0.40 of a 1.00 budget. */
function session(over: Partial<MeteredSession> = {}): MeteredSession {
  return {
    sessionId: SID,
    currency: 'USD',
    receiptSha256: 'ab'.repeat(32),
    mandate: { cap: '1.00', orderId: 'ORDER1', authorizationId: 'AUTH1', authorizationStatus: 'CAPTURED', approvedAt: '2026-10-18T11:02:03.000Z', authorizedAt: '2026-10-18T11:02:03Z' },
    calls: [{ n: 1, time: '2026-10-18T11:03:00.000Z', tool: 'deep_report', price: '0.40', status: 'OK', requestHash: '1'.repeat(64) }],
    totals: { calls: 1, ok: 1, failed: 0, charged: '0.40', cap: '1.00' },
    settlement: { status: 'captured', captureId: 'CAPREAL1', captureStatus: 'COMPLETED', captured: '0.40', released: '0.60', remainderReleased: true, settledAt: '2026-10-18T11:06:00.000Z' },
    ...over,
  };
}

const RUN: AgentRunSummary = {
  runId: 'run-' + 'c'.repeat(32),
  goal: 'Get a deep report on ACME and stay under budget',
  outcome: 'done',
  stopReason: null,
  steps: [
    { n: 1, tool: 'price_list', state: 'done', reason: 'Check prices first', summary: 'Price list: deep_report 0.40 USD' },
    { n: 2, tool: 'deep_report', state: 'done', reason: 'The report answers the goal', summary: 'Deep report on ACME' },
    { n: 3, tool: 'finish', state: 'done', reason: 'Goal met', summary: 'done' },
  ],
};

function live(o: { session?: MeteredSession; run?: AgentRunSummary; amount?: { value: string; currency: string } | null; itemType?: string | null } = {}): PayPalSource {
  const snap: DisputeSnapshot = {
    id: agentCase.summary.id,
    status: 'WAITING_FOR_SELLER_RESPONSE',
    stage: 'INQUIRY',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    buyerItemType: o.itemType === undefined ? null : o.itemType,
    allowedActions: ['provide_evidence', 'send_message', 'accept_claim'],
    requestedEvidence: ['PROOF_OF_FULFILLMENT'],
    amount: o.amount === undefined ? { value: '0.40', currency: 'USD' } : o.amount,
    createdAt: '2026-10-18T12:00:00.000Z',
    transaction: { id: 'CAPREAL1', amount: { value: '0.40', currency: 'USD' }, status: 'COMPLETED', createdAt: '2026-10-18T11:06:00.000Z' },
    evidences: [],
    readAt: '18 Oct 2026 12:05 UTC',
    origin: { kind: 'paypal', env: 'sandbox', disputeId: 'PP-D-REAL-9' },
    agentReceipt: { kind: 'metermcp', session: o.session ?? session(), ...(o.run ? { run: o.run } : {}) },
  };
  return { kind: 'live', snap, failed: null };
}

const e5 = (c: CaseFile) => c.evidence.find((e) => e.id === 'E5');
const lineTexts = (c: CaseFile) => {
  const b = e5(c)!.body;
  return b.kind === 'lines' ? b.lines.map((l) => l.text) : [];
};

test('a live agent case with a real session has no synthetic merchant notes, and no 1.37 in any text field unless the receipt says 1.37', () => {
  const c = caseView(agentCase, live());
  assert.deepEqual(c.merchantNotes, []);
  const all = JSON.stringify(c);
  for (const v of ['1.37', 'four tool calls', 'mm-sess-20261008-01', '7HF40211KM3390816', '5.00 USD budget', 'confirmation of the service', 'even though the buyer declared', '46 KB', 'Recommended']) {
    assert.ok(!all.includes(v), `synthetic leftover: ${v}`);
  }
  // The analyst's input as well: the dispute record and the documents.
  const input = JSON.stringify(buildInput(c));
  for (const v of ['1.37', 'four tool calls', 'confirmation of the service']) assert.ok(!input.includes(v), `synthetic leftover in the analyst input: ${v}`);
  // A receipt that really says 1.37 shows it.
  const s137 = session({ totals: { calls: 1, ok: 1, failed: 0, charged: '1.37', cap: '5.00' }, settlement: { ...session().settlement, captured: '1.37', released: '3.63' } });
  assert.ok(JSON.stringify(caseView(agentCase, live({ session: s137, amount: { value: '1.37', currency: 'USD' } }))).includes('1.37'));
});

test('refund text and capture text come from the live amount and the receipt', () => {
  const c = caseView(agentCase, live());
  assert.equal(c.summary.captureText, 'Captured 0.40 of 1.00 USD');
  assert.equal(c.refundText, '0.40 USD');
  assert.equal(c.actionDetails.accept_claim?.sub, 'Refund 0.40 USD');
  // PayPal's disputed amount wins; without one, the receipt's captured amount.
  assert.equal(caseView(agentCase, live({ amount: { value: '0.25', currency: 'USD' } })).refundText, '0.25 USD');
  assert.equal(caseView(agentCase, live({ amount: null })).refundText, '0.40 USD');
  // Not captured: the settlement as the receipt states it, never a captured amount.
  const voided = session({ totals: { calls: 1, ok: 0, failed: 1, charged: '0.00', cap: '1.00' }, settlement: { status: 'voided', captureId: null, captureStatus: null, captured: null, released: null, remainderReleased: false, settledAt: '2026-10-18T11:06:00.000Z' } });
  assert.equal(caseView(agentCase, live({ session: voided })).summary.captureText, 'Nothing charged · 1.00 USD authorization voided');
  // The reason and item type come from PayPal, not from the synthetic buyer quote.
  assert.equal(c.summary.buyerItemType, 'Not reported by PayPal');
  assert.equal(caseView(agentCase, live({ itemType: 'SERVICE' })).summary.buyerItemType, 'Service');
  assert.match(c.summary.reasonText, /MERCHANDISE_OR_SERVICE_NOT_RECEIVED/);
  assert.equal(c.requestedNote, 'Requested from seller · read from PayPal');
});

test('with a run summary, E5 lists the goal, each step’s reason and the outcome', () => {
  assert.equal(e5(caseView(agentCase, live())), undefined, 'no run record: no E5');
  const c = caseView(agentCase, live({ run: RUN }));
  const doc = e5(c)!;
  assert.equal(doc.title, 'Agent run record');
  assert.deepEqual(doc.sourceLabel, { kind: 'resolvekit', text: `From ResolveKit · run ${RUN.runId.slice(0, 16)}…`, title: `From ResolveKit · run ${RUN.runId}` });
  assert.deepEqual(lineTexts(c), [
    'Goal: Get a deep report on ACME and stay under budget',
    '1 · price_list · Check prices first · Price list: deep_report 0.40 USD',
    '2 · deep_report · The report answers the goal · Deep report on ACME',
    '3 · finish · Goal met · done',
    'Outcome: Done',
  ]);
  // The analyst reads it like the other documents, as ResolveKit's.
  const d = buildInput(c).documents.find((x) => x.id === 'E5')!;
  assert.equal(d.source, 'ResolveKit');
  assert.equal(d.lines.length, 5);

  // An uncertain step says so; a stopped or interrupted run is never called done.
  const stopped: AgentRunSummary = {
    ...RUN,
    outcome: 'interrupted',
    steps: [{ n: 1, tool: 'deep_report', state: 'uncertain', reason: 'Get the report', summary: 'Result unknown: the server restarted during this call' }],
  };
  const t = lineTexts(caseView(agentCase, live({ run: stopped })));
  assert.equal(t[1], '1 · deep_report · Get the report · result unknown: Result unknown: the server restarted during this call');
  assert.equal(t.at(-1), 'Outcome: Interrupted (stopped or server restart)');
  const limit = lineTexts(caseView(agentCase, live({ run: { ...RUN, outcome: 'stopped', stopReason: 'max_actions' } })));
  assert.equal(limit.at(-1), 'Outcome: Stopped: action limit reached');
  for (const x of [t, limit]) assert.ok(!x.at(-1)!.includes('Done'));
});

test('the simulated agent case is unchanged', () => {
  const sim = withMeterMcp(agentCase, { kind: 'simulated' });
  const expected: CaseFile = {
    ...agentCase,
    evidence: agentCase.evidence.map((e) => ({ ...e, sourceLabel: { kind: 'demo', text: 'Demo data' }, caption: e.id === 'E3' ? 'Demo settlement' : e.caption })),
  };
  assert.deepEqual(sim, expected);
  assert.deepEqual(sim.merchantNotes, agentCase.merchantNotes);
  assert.equal(withPayPal(agentCase, { kind: 'simulated' }), agentCase);
});
