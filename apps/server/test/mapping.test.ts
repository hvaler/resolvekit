import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapStatus, toSnapshot } from '../src/mapping.ts';
import { buildAttachments, CASE_FILES, evidenceLines, SYNTHETIC_HEADER, UnknownFileError } from '../src/documents.ts';
import { writePdf } from '@resolvekit/pdf';
import { evidenceInDispute, fakePayPal, waitingDispute } from './fixtures.ts';
import { checkBindings } from '../src/bindings.ts';
import { PayPalClient } from '@resolvekit/paypal';
import type { DisputeSnapshot } from '../../web/src/domain/types.ts';

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

test('startup binding check logs a mismatch between the bound dispute and the demo case order, without writing', async () => {
  const pp = fakePayPal([{ status: 200, body: waitingDispute() }, { status: 200, body: { ...waitingDispute(), dispute_amount: { currency_code: 'USD', value: '7.00' } } }, { status: 404, body: { name: 'RESOURCE_NOT_FOUND' } }]);
  const paypal = new PayPalClient({ clientId: 'id', clientSecret: 'secret', env: 'sandbox', fetch: pp.fetch });
  const lines: string[] = [];
  await checkBindings({
    paypal,
    bindings: { 'CASE-A': 'PP-R-1', 'CASE-B': 'PP-R-2', 'CASE-C': 'PP-R-3' },
    caseOrders: { 'CASE-A': { value: '7.00', currency: 'USD' }, 'CASE-B': { value: '7.00', currency: 'USD' }, 'CASE-C': { value: '1.00', currency: 'USD' } },
    log: (l) => lines.push(l),
  });
  assert.ok(lines.some((l) => l.includes('CASE-A → PP-R-1: MISMATCH') && l.includes('is 1.37 USD; this demo case’s order is 7.00 USD')), lines.join(' | '));
  assert.ok(lines.some((l) => l.includes('CASE-B → PP-R-2: amount matches (7.00 USD)')));
  assert.ok(lines.some((l) => l.includes('CASE-C → PP-R-3: could not read')));
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
