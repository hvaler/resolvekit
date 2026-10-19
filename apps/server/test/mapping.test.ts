import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapStatus, proofEntriesOf, toSnapshot } from '../src/mapping.ts';
import { buildAttachments, CASE_FILES, evidenceLines, SYNTHETIC_HEADER, UnknownFileError } from '../src/documents.ts';
import { writePdf } from '@resolvekit/pdf';
import { evidenceInDispute, fakePayPal, waitingDispute } from './fixtures.ts';
import { checkBindings } from '../src/bindings.ts';
import { PayPalClient } from '@resolvekit/paypal';
import type { DisputeSnapshot } from '../../web/src/domain/types.ts';
import { readFileSync } from 'node:fs';
import { caseInput, standardCase, type PayPalSource } from '@resolvekit/cases';
import type { Dispute } from '@resolvekit/paypal';

const at = new Date(Date.UTC(2026, 9, 9, 8, 0, 0));

test('maps a real-shaped dispute: status, stage, reason, item type, actions, requested evidence, due date', () => {
  const s: DisputeSnapshot = toSnapshot(waitingDispute(), 'CASE-1', 'sandbox', at);
  assert.equal(s.id, 'CASE-1');
  assert.equal(s.status, 'WAITING_FOR_SELLER_RESPONSE');
  assert.equal(s.stage, 'INQUIRY');
  assert.equal(s.reason, 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED');
  assert.equal(s.buyerItemType, 'PRODUCT');
  assert.deepEqual(s.allowedActions, ['provide_evidence', 'send_message', 'make_offer', 'accept_claim', 'escalate']);
  assert.deepEqual(s.requestedEvidence, ['PROOF_OF_FULFILLMENT']);
  assert.equal(s.respondBy, '2026-10-28T19:31:23.864Z');
  assert.deepEqual(s.amount, { value: '1.37', currency: 'USD' });
  assert.equal(s.createdAt, '2026-10-08T19:31:23.864Z');
  assert.deepEqual(s.transaction, { id: '4FT237453Y5353014', createdAt: '2026-10-08T19:30:33.000Z', amount: { value: '1.37', currency: 'USD' }, status: 'HELD' });
  assert.equal(s.buyerRespondBy, null);
  assert.equal(s.readAt, '9 Oct 2026 08:00:00 UTC');
  assert.deepEqual(s.origin, { kind: 'paypal', env: 'sandbox', disputeId: 'PP-R-REAL-1' });
  // The buyer entry and PayPal's request are kept verbatim with their source, so the web never mistakes them for seller evidence.
  assert.deepEqual(s.evidences.map((e) => [e.evidenceType, e.source]), [['CREATE', 'SUBMITTED_BY_BUYER'], ['PROOF_OF_FULFILLMENT', 'REQUESTED_FROM_SELLER']]);
});

test('after seller evidence: no seller due date (null, never stale), buyer due date, nothing requested, no provide_evidence', () => {
  const s = toSnapshot(evidenceInDispute(), 'C', 'sandbox', at);
  assert.equal(s.status, 'WAITING_FOR_BUYER_RESPONSE');
  assert.equal(s.respondBy, null);
  assert.equal(s.buyerRespondBy, '2026-10-19T04:37:54.000Z');
  assert.deepEqual(s.requestedEvidence, []);
  assert.deepEqual(s.allowedActions, ['send_message', 'accept_claim', 'escalate']);
  assert.deepEqual(s.amount, { value: '1.37', currency: 'USD' });
});

test('a dispute without amount, transaction or dates maps them to null', () => {
  const s = toSnapshot({ dispute_id: 'X', status: 'UNDER_REVIEW' }, 'C', 'sandbox', at);
  assert.equal(s.amount, null);
  assert.equal(s.transaction, null);
  assert.equal(s.createdAt, null);
  assert.equal(s.respondBy, null);
  assert.equal(s.reason, null);
  assert.equal(s.buyerItemType, null);
});

test('startup binding check verifies each bound dispute and logs why one is not this payment, without writing', async () => {
  const std = { ...waitingDispute(), dispute_amount: { currency_code: 'USD', value: '7.00' }, disputed_transactions: [{ ...waitingDispute().disputed_transactions![0]!, gross_amount: { currency_code: 'USD', value: '7.00' } }] };
  const pp = fakePayPal([{ status: 200, body: waitingDispute() }, { status: 200, body: std }, { status: 404, body: { name: 'RESOURCE_NOT_FOUND' } }]);
  const paypal = new PayPalClient({ clientId: 'id', clientSecret: 'secret', env: 'sandbox', fetch: pp.fetch });
  const lines: string[] = [];
  const capture = '4FT237453Y5353014';
  await checkBindings({
    paypal,
    bindings: { 'CASE-A': { dispute: 'PP-R-REAL-1', capture }, 'CASE-B': { dispute: 'PP-R-REAL-1', capture }, 'CASE-C': { dispute: 'PP-R-3', capture } },
    cases: Object.fromEntries(['CASE-A', 'CASE-B', 'CASE-C'].map((k) => [k, { value: '7.00', currency: 'USD', transactionId: 'DEMO0000000001' }])),
    log: (l) => lines.push(l),
  });
  assert.ok(lines.some((l) => l.includes('CASE-A → PP-R-REAL-1') && l.includes('INVALID') && l.includes('1.37 USD; this case’s order is 7.00 USD')), lines.join(' | '));
  assert.ok(lines.some((l) => l.includes('CASE-B → PP-R-REAL-1') && l.includes('verified (7.00 USD)')), lines.join(' | '));
  assert.ok(lines.some((l) => l.includes('CASE-C → PP-R-3') && l.includes('could not read')));
  assert.ok(pp.apiCalls().every((c) => c.method === 'GET'));
  assert.ok(!lines.join(' | ').includes('secret'));
});

test('maps seller evidence with tracking, document names, notes, action and date', () => {
  const d = waitingDispute();
  d.evidences!.push({
    evidence_type: 'PROOF_OF_FULFILLMENT',
    source: 'SUBMITTED_BY_SELLER',
    date: '2026-10-09T08:01:02.000Z',
    notes: 'Delivered.',
    action_info: { action: 'PROVIDE_EVIDENCE' },
    evidence_info: { tracking_info: [{ carrier_name: 'UPS', tracking_number: '1Z9' }] },
    documents: [{ name: 'a.pdf' }, { name: 'b.pdf' }],
  });
  const e = toSnapshot(d, 'C', 'sandbox', at).evidences[2]!;
  assert.deepEqual(e, {
    evidenceType: 'PROOF_OF_FULFILLMENT',
    source: 'SUBMITTED_BY_SELLER',
    action: 'PROVIDE_EVIDENCE',
    date: '2026-10-09T08:01:02.000Z',
    carrier: 'UPS',
    tracking: '1Z9',
    notes: 'Delivered.',
    files: ['a.pdf', 'b.pdf'],
    storedAt: '9 Oct 2026 08:01:02 UTC',
  });
});

test('unknown PayPal statuses become OTHER; no personal data is copied', () => {
  assert.equal(mapStatus('SOMETHING_NEW'), 'OTHER');
  assert.equal(mapStatus(undefined), 'OTHER');
  const raw = { ...waitingDispute(), messages: [{ content: 'secret buyer message' }], buyer: { email: 'b@example.com' } };
  assert.ok(!JSON.stringify(toSnapshot(raw, 'C', 'sandbox', at)).includes('b@example.com'));
});

test('writes a valid minimal PDF: header, objects, xref with correct offsets, trailer, EOF', () => {
  const pdf = Buffer.from(writePdf({ header: SYNTHETIC_HEADER, title: 'T (1)', lines: ['Tracking 1Z · UPS', 'back\\slash'] }));
  const s = pdf.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4\n'));
  assert.ok(s.endsWith('%%EOF\n'));
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(s)![1]);
  assert.ok(s.slice(startxref).startsWith('xref\n0 '));
  const entries = [...s.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  entries.forEach((off, i) => assert.ok(s.slice(off).startsWith(`${i + 1} 0 obj`), `object ${i + 1} at ${off}`));
  assert.match(s, /\(SYNTHETIC TEST DOCUMENT\) Tj/);
  assert.match(s, /\(T \\\(1\\\)\) Tj/);
  assert.match(s, /\(Tracking 1Z \xb7 UPS\) Tj/);
  const len = Number(/\/Length (\d+) >>\nstream\n/.exec(s)![1]);
  const start = s.indexOf('stream\n') + 'stream\n'.length;
  assert.equal(s.slice(start + len, start + len + '\nendstream'.length), '\nendstream');
});

test('long documents spill onto more pages', () => {
  const s = Buffer.from(writePdf({ title: 'Long', lines: Array.from({ length: 120 }, (_, i) => `line ${i}`) })).toString('latin1');
  assert.match(s, /\/Count 3 /);
});

test('builds the case PDFs by name from the case documents, with the synthetic header', () => {
  const [f] = buildAttachments('PP-R-TVH-10190665', [{ name: 'ups-tracking-1Z999AA10123456784.pdf', size: '112 KB' }]);
  const s = Buffer.from(f!.data).toString('latin1');
  assert.equal(f!.type, 'application/pdf');
  assert.match(s, /SYNTHETIC TEST DOCUMENT/);
  assert.match(s, /Tracking 1Z999AA10123456784/);
  assert.throws(() => buildAttachments('PP-R-TVH-10190665', [{ name: 'x.pdf', size: '1' }]), UnknownFileError);
  assert.throws(() => buildAttachments('NOT-A-CASE', [{ name: 'ups-tracking-1Z999AA10123456784.pdf', size: '1' }]), UnknownFileError);
});

test('every attachment of every case resolves to a document with text', () => {
  for (const c of Object.values(CASE_FILES)) {
    for (const a of c.attachments) {
      const ev = c.evidence.find((e) => e.id === a.fromEvidenceId);
      assert.ok(ev && evidenceLines(ev).length > 0, `${c.summary.id} ${a.name}`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// B0: the thread, offers and response options, from the recorded sandbox reads (packages/paypal/contracts/reads/).

const readContract = (f: string): Dispute => JSON.parse(readFileSync(new URL(`../../../packages/paypal/contracts/${f}`, import.meta.url), 'utf8')) as Dispute;
const live = (snap: DisputeSnapshot): PayPalSource => ({ kind: 'live', snap, failed: null });
const CASE = standardCase.summary.id;
const NOW = at;

test('the thread, offers, options and outcome are mapped from a recorded read; the analyst input does not change', () => {
  const d = readContract('reads/inquiry-waiting-seller-KHH.json');
  const s = toSnapshot(d, CASE, 'sandbox', NOW);
  assert.ok(Array.isArray(s.messages));
  assert.deepEqual(s.messages, [{ postedBy: 'BUYER', time: '2026-10-18T08:04:20.960Z', content: '<buyer message, 49 chars>', files: [] }]);
  assert.deepEqual(s.offerHistory, []);
  assert.deepEqual(s.responseOptions, { acceptClaimTypes: ['PARTIAL_REFUND', 'REFUND'], offerTypes: ['REFUND'] });
  assert.equal(s.outcome, null);
  assert.equal(s.proofEntries, undefined);
  // KHH links no appeal, so the filter below is a no-op here; the next assertion adds appeal and covers it.
  assert.deepEqual(caseInput(standardCase, live(s)), caseInput(standardCase, live({ ...s, messages: [], offerHistory: [], responseOptions: undefined, allowedActions: s.allowedActions.filter((a) => a !== 'appeal') })));
  // Appeal, once PayPal links it, never reaches the analyst either: the analysis keys stay stable.
  assert.deepEqual(caseInput(standardCase, live({ ...s, allowedActions: [...s.allowedActions, 'appeal'] })), caseInput(standardCase, live(s)));
  // Nor does the thread's text.
  assert.ok(!JSON.stringify(caseInput(standardCase, live(s))).includes('<buyer message'));
});

test('a seller message, the options after evidence and a resolved outcome are mapped from recorded reads', () => {
  const tvh = toSnapshot(readContract('reads/inquiry-after-evidence-TVH.json'), 'C', 'sandbox', NOW);
  assert.deepEqual(tvh.messages?.map((m) => [m.postedBy, m.time]), [['BUYER', '2026-10-08T18:19:33.715Z'], ['SELLER', '2026-10-08T18:25:08.597Z']]);
  assert.equal(tvh.messages?.[1]?.content, 'Prueba de puerta: el pedido salió el 7/10; adjuntamos el seguimiento.');
  assert.deepEqual(tvh.responseOptions, { acceptClaimTypes: ['REFUND'], offerTypes: [] });
  const gfc = toSnapshot(readContract('reads/resolved-GFC.json'), 'C', 'sandbox', NOW);
  assert.equal(gfc.status, 'RESOLVED');
  assert.deepEqual(gfc.outcome, { code: 'RESOLVED_BUYER_FAVOUR', closedAt: '2026-10-08T18:27:03.605Z' });
  assert.deepEqual(gfc.responseOptions, { acceptClaimTypes: [], offerTypes: [] });
  assert.deepEqual(gfc.allowedActions, []);
});

test('proof entries keep only the contract’s proof fields, as strings or null; nothing else of the raw entry', () => {
  // No contract names an unmapped list today (so toSnapshot leaves proofEntries out); this checks the guard with a
  // contract naming one. The entry is synthetic on purpose: it carries fields that must never be copied.
  const contracts = { x: { proof: { list: 'adjudications' as const, actorField: 'party', actorValue: 'SELLER', timeField: 'adjudication_time', matchFields: ['outcome.code', 'amount'], normalise: [] } } };
  const d = { ...readContract('reads/resolved-GFC.json'), adjudications: [{ party: 'SELLER', adjudication_time: '2026-10-08T18:27:03.605Z', outcome: { code: 'X', name: 'Jane Buyer' }, amount: 8, email: 'buyer@example.com', note: 'secret' }] };
  const e = proofEntriesOf(d, contracts);
  assert.deepEqual(e, [{ party: 'SELLER', adjudication_time: '2026-10-08T18:27:03.605Z', 'outcome.code': 'X', amount: null }]);
  assert.ok(!JSON.stringify(e).includes('example.com') && !JSON.stringify(e).includes('Jane') && !JSON.stringify(e).includes('secret'));
  assert.equal(proofEntriesOf(d, {}), undefined);
  assert.equal(toSnapshot(d, 'C', 'sandbox', NOW).proofEntries, undefined);
});
