import test from 'node:test';
import assert from 'node:assert/strict';
import type { CaseAnalysis } from '@resolvekit/analyst/node';
import { uploadDocuments, uploadFileName, uploadTitle } from '../src/uploads/documents.ts';
import type { PdfPage, UploadRecord, UploadStore } from '../src/uploads/store.ts';
import { CASE, REAL, TIMEOUT, fileBytes, sendSetup, sha } from './uploads-kit.ts';

const area = { x: 10, y: 10, w: 200, h: 20 };
const page = (original: number, lines: PdfPage['lines'], added: PdfPage['added'] = []): PdfPage => ({ original, rects: [], readLines: lines.map((l) => l.original ?? l.text), lines, added, sha256: 'a'.repeat(64), redactions: 0, dpi: 170 });
const ocr = (text: string, correctedBy: string | null = null) => ({ text, correctedBy, original: correctedBy ? `${text}?` : null });

/** Pages 2 and 8 of a 12-page PDF, confirmed as E7: a corrected line on page 2, a transcribed one on page 8, and a page with no text. */
const pages = (signed = 'Signed by J. D.') => [
  page(2, [ocr('INVOICE 2026-114'), ocr('Total 89.00 USD', 'Ana Lopez (member)')]),
  page(5, []),
  page(8, [ocr('Delivered 8 Oct 2026')], [{ area, text: signed, by: 'Ana Lopez (member)' }]),
];

const pdfRecord = (over: Partial<UploadRecord> = {}): UploadRecord => ({
  id: 'upl-0123456789abcdef01234567',
  workspaceId: 'ws1',
  caseId: CASE,
  boundDisputeId: REAL,
  evidenceId: 'E7',
  kind: 'pdf',
  name: 'invoice-ES9121000418450200051332.pdf',
  uploadedBy: { id: 'p1', label: 'Ana Lopez (member)', name: 'Ana Lopez' },
  status: 'confirmed',
  rects: [],
  removals: [],
  readLines: [],
  lines: [],
  sha256: 'b'.repeat(64),
  size: 1000,
  mime: 'application/pdf',
  createdAt: '2026-10-18T10:00:00.000Z',
  expiresAt: '2026-10-19T10:00:00.000Z',
  confirmedAt: '2026-10-18T10:05:00.000Z',
  analysisKeys: [],
  pdf: { pageCount: 12, selected: [2, 5, 8], pages: pages(), job: { state: 'reviewing' } },
  ...over,
});

test('a confirmed PDF is one document: lines in page order, page-scoped fragments, added lines after the OCR lines of their page', () => {
  const [d] = uploadDocuments([pdfRecord()]);
  assert.equal(d!.id, 'E7');
  assert.equal(d!.title, 'Uploaded PDF');
  assert.equal(uploadTitle('pdf'), 'Uploaded PDF');
  assert.equal(d!.type, 'Merchant upload · PDF');
  assert.equal(d!.source, 'Uploaded by Ana Lopez');
  assert.deepEqual(d!.lines, [
    { text: 'INVOICE 2026-114', fragment: 'E7.p2.l1' },
    { text: 'Total 89.00 USD', fragment: 'E7.p2.l2', corrected: 'Ana Lopez (member)' },
    // Page 5 has no lines: it contributes nothing.
    { text: 'Delivered 8 Oct 2026', fragment: 'E7.p8.l1' },
    { text: 'Signed by J. D.', fragment: 'E7.p8.l2', transcribed: 'Ana Lopez (member)' },
  ]);
  // The uploaded name is nowhere in the analyst's document.
  assert.ok(!JSON.stringify(d).includes('ES912'));
});

test("PayPal's file name for a PDF upload is E<n>-upload.pdf", () => {
  assert.equal(uploadFileName({ evidenceId: 'E7', kind: 'pdf' }), 'E7-upload.pdf');
  assert.equal(uploadFileName({ evidenceId: 'E7', kind: 'image' }), 'E7-upload.png');
  assert.equal(uploadFileName({ evidenceId: 'E7', kind: 'text' }), 'E7-pasted.pdf');
});

// ------------------------------------------------------------------------------------- approval and the send

const SANITISED = new TextEncoder().encode('%PDF-1.4\n% the PDF rebuilt from the covered page images\n%%EOF\n');

const ORIGINAL = new TextEncoder().encode('%PDF-1.7 the original with its text layer ORIGINALWORDS');
const PAGE = (k: number) => new TextEncoder().encode(`\x89PNG covered page ${k}`);
const ORIG_PAGE = (k: number) => new TextEncoder().encode(`\x89PNG uncovered render ${k}`);

/**
 * A confirmed PDF upload E7 of the seller's workspace, as Task 5's confirm leaves it; with `keepFiles`, the original
 * and the per-page renders are still stored beside it (they must never be what is sent).
 */
function confirmedPdf(store: UploadStore, workspaceId: string, o: { signed?: string; keepFiles?: boolean } = {}) {
  const r = store.create({ workspaceId, caseId: CASE, boundDisputeId: REAL, kind: 'pdf', name: 'invoice.pdf', uploadedBy: { id: 'p1', label: 'Ana Lopez (member)', name: 'Ana Lopez' } }, ORIGINAL);
  if (o.keepFiles) store.update(r.id, { status: 'reviewing' }, { pages: { 1: PAGE(1), 2: PAGE(2), 3: PAGE(3) }, origPages: { 1: ORIG_PAGE(1), 2: ORIG_PAGE(2), 3: ORIG_PAGE(3) } });
  return store.update(
    r.id,
    { status: 'confirmed', evidenceId: 'E7', sha256: sha(SANITISED), size: SANITISED.length, mime: 'application/pdf', confirmedAt: new Date().toISOString(), pdf: { pageCount: 12, selected: [2, 5, 8], pages: pages(o.signed), job: { state: 'reviewing' } } },
    { sanitised: SANITISED, ...(o.keepFiles ? {} : { original: null }) },
  );
}

const S7 = (quote: string) => ({ id: 'S7', text: 'The buyer signed for the parcel.', noteId: null, citations: [{ doc: 'E7', quote, valid: true }], verdict: 'supported', reason: null, decidedBy: 'model', rewrite: null }) as unknown as CaseAnalysis['sentences'][number];

test('a sentence citing a transcribed line is composed only with its sentence@line confirmation; the content hash follows the transcription', TIMEOUT, async () => {
  const s = sendSetup();
  const cookie = s.people.fullMember('Ana Lopez');
  const e7 = confirmedPdf(s.store, s.people.workspace.id);
  await s.analyse(cookie, [S7('Signed by J. D.')]);
  for (const confirmedCorrections of [[], ['S7@E7.p8.l1'], ['S1@E7.p8.l2'], ['S7@E7.l2']]) {
    const r = await s.intent(cookie, { confirmedCorrections });
    assert.equal(r.status, 422, JSON.stringify(confirmedCorrections));
    assert.equal(r.body.error, 'DRAFT_BLOCKED');
    assert.ok(r.body.blockers!.includes('sentence 7 needs review'), JSON.stringify(r.body.blockers));
  }
  const ok = await s.intent(cookie, { confirmedCorrections: ['S7@E7.p8.l2'] });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.ok((ok.body as unknown as { sentences: { id: string }[] }).sentences.some((x) => x.id === 'S7'));

  // The same sentence and confirmation over another transcription of that line is another content.
  s.store.update(e7.id, { pdf: { ...s.store.get(e7.id)!.pdf!, pages: pages('Signed by J. Doe') } });  await s.analyse(cookie, [S7('Signed by J. Doe')]);
  const again = await s.intent(cookie, { confirmedCorrections: ['S7@E7.p8.l2'] });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.notEqual(again.body.contentHash, ok.body.contentHash);
});

test('the send attaches exactly the stored sanitised.pdf, as E7-upload.pdf: never the original nor a page render', TIMEOUT, async () => {
  const s = sendSetup();
  const cookie = s.people.fullMember('Ana Lopez');
  const e7 = confirmedPdf(s.store, s.people.workspace.id, { keepFiles: true });
  // The original and the covered page renders are still on the server (the uncovered renders went at confirm).
  assert.deepEqual(s.store.original(e7.id), ORIGINAL);
  assert.deepEqual(s.store.pageImage(e7.id, 2), PAGE(2));
  await s.analyse(cookie);
  const i = await s.approved(cookie, { attachments: [e7.id] });
  assert.deepEqual(i.files.filter((f) => f.source === 'upload').map((f) => [f.name, f.sha256]), [['E7-upload.pdf', sha(SANITISED)]]);
  const r = await s.send(cookie, i.id);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const files = s.sends[0]!.getAll('evidence-file') as File[];
  // Every file PayPal received is one the intent names; besides the case's own documents, only E7-upload.pdf.
  assert.deepEqual(files.map((f) => f.name), i.files.map((f) => f.name));
  const demo = new Set(i.files.filter((f) => f.source === 'demo').map((f) => f.name));
  const ups = files.filter((f) => !demo.has(f.name));
  assert.deepEqual(ups.map((f) => [f.name, f.type]), [['E7-upload.pdf', 'application/pdf']]);
  assert.equal(sha(await fileBytes(ups[0]!)), sha(SANITISED));
  assert.deepEqual(await fileBytes(ups[0]!), s.store.sanitised(e7.id));
  // No file sent carries the original or any page render.
  const stored = [ORIGINAL, ...[1, 2, 3].flatMap((k) => [PAGE(k), ORIG_PAGE(k)])].map(sha);
  for (const f of files) assert.ok(!stored.includes(sha(await fileBytes(f))), f.name);
  assert.ok(!files.some((f) => f.name.includes('invoice') || /page-|\.png$/.test(f.name)));
});
