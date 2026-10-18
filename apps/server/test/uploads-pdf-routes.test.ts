import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { request as httpRequest, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { writeImagePdf } from '@resolvekit/pdf';
import { toNodeListener } from '../src/node.ts';
import { UploadError, oneImageAtATime } from '../src/uploads/image.ts';
import { PDF_MAX_BYTES, PDF_RENDER_DPI, PDF_THUMB_DPI } from '../src/uploads/limits.ts';
import { closeOcr } from '../src/uploads/ocr.ts';
import { inspectPdf, pdfChildTestHooks } from '../src/uploads/pdf-input.ts';
import { createPdfJob } from '../src/uploads/pdf-job.ts';
import { hintCacheSize } from '../src/uploads/routes.ts';
import { UploadStore } from '../src/uploads/store.ts';
import { A3_LANDSCAPE, HIDDEN, corruptPdf, encryptedPdf, hiddenPdf, pagesPdf, textPdf } from './fixtures/make-pdfs.ts';
import { CASE, P, TIMEOUT, call, req, setup, type App } from './uploads-kit.ts';

after(() => closeOcr());

const TOO_BIG = 'This PDF is larger than 10 MB or has more than 30 pages. Prepare a smaller extract and upload it again.';
const ENCRYPTED = 'This PDF is password-protected or encrypted. Upload a version without protection.';
const UNREADABLE = 'This file could not be read as a PDF.';

type Job = { state: string; page?: number; of?: number; error?: string };
type PdfPageView = { original: number; rects: unknown[]; readLines: string[]; lines: unknown[]; added: unknown[]; sha256: string | null };
type PdfView = { id: string; kind: string; status: string; name: string; pdf: { pageCount: number; selected: number[] | null; pages: PdfPageView[]; job: Job } };
type PdfAnswer = { upload: PdfView; uploads?: PdfView[]; error?: string; detail?: string };

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const uploadPdf = async (app: App, cookie: string, bytes: Uint8Array, name = 'invoice.pdf') => {
  const r = await call(app, P, { body: bytes, type: 'application/pdf', cookie, headers: { 'x-upload-name': name } });
  return { ...r, body: r.body as unknown as PdfAnswer };
};
const select = async (app: App, cookie: string, id: string, pages: unknown) => {
  const r = await call(app, `${P}/${id}/select`, { body: { pages }, cookie });
  return { ...r, body: r.body as unknown as PdfAnswer };
};
/** Poll GET /uploads, as the web app does, until the upload's job satisfies `done`. */
async function waitFor(app: App, cookie: string, id: string, done: (j: Job) => boolean): Promise<PdfView> {
  for (let i = 0; i < 1200; i++) {
    const list = await call(app, P, { cookie });
    const u = (list.body.uploads as unknown as PdfView[]).find((x) => x.id === id)!;
    if (done(u.pdf.job)) return u;
    await sleep(100);
  }
  throw new Error('the job did not finish');
}
const settled = (j: Job) => j.state === 'reviewing' || j.state === 'failed';
const thumbsReady = (j: Job) => j.state === 'selecting' && j.page === undefined;
const get = (app: App, cookie: string, path: string) => app(req(`${P}/${path}`, { cookie }));

test('a 3-page PDF: all pages selected, rendered and read in the background; pages served, the original only to editors', TIMEOUT, async () => {
  const { app, people, lines, intents, store } = setup();
  const cookie = people.fullMember();
  const r = await uploadPdf(app, cookie, pagesPdf(3), 'statement-9988776655.pdf');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const u = r.body.upload;
  assert.equal(u.kind, 'pdf');
  assert.equal(u.name, 'statement-9988776655.pdf');
  assert.equal(u.pdf.pageCount, 3);
  assert.deepEqual(u.pdf.selected, [1, 2, 3]);
  assert.ok(['rendering', 'reading'].includes(u.pdf.job.state), JSON.stringify(u.pdf.job));

  const done = await waitFor(app, cookie, u.id, settled);
  assert.equal(done.pdf.job.state, 'reviewing', JSON.stringify(done.pdf.job));
  assert.deepEqual(done.pdf.pages.map((p) => p.original), [1, 2, 3]);
  done.pdf.pages.forEach((p, i) => {
    // Read from the uncovered render; nothing is a sanitised page before the cover step.
    assert.equal(p.sha256, null);
    assert.ok(p.readLines.some((l) => l.includes(`Fixture line ${i + 1}`)), JSON.stringify(p.readLines));
    // The view: no counters, no text layer.
    assert.deepEqual(Object.keys(p).sort(), ['added', 'lines', 'original', 'readLines', 'rects', 'sha256']);
  });
  assert.deepEqual(Object.keys(done.pdf).sort(), ['job', 'pageCount', 'pages', 'selected']);

  // Before the cover step only the uncovered render exists: at the render resolution (A4 at 170 dpi), a fresh PNG.
  assert.equal((await get(app, cookie, `${u.id}/page/2?v=sanitised`)).status, 404);
  assert.equal((await get(app, cookie, `${u.id}/page/2`)).status, 404);
  const orig = await get(app, cookie, `${u.id}/page/2?v=original`);
  assert.equal(orig.status, 200);
  assert.equal(orig.headers.get('content-type'), 'image/png');
  assert.equal(orig.headers.get('cache-control'), 'private, no-store');
  const png = PNG.sync.read(Buffer.from(await orig.arrayBuffer()));
  assert.equal(png.width, Math.floor((595 * PDF_RENDER_DPI) / 72));
  assert.equal(store.pageImage(u.id, 2), null);

  // Another person of the workspace who cannot edit it (a reviewer) sees the metadata only, and no page at all.
  const other = people.member();
  const seen = ((await call(app, P, { cookie: other })).body.uploads as unknown as Record<string, unknown>[]).find((x) => x.id === u.id)!;
  assert.deepEqual(Object.keys(seen).sort(), ['createdAt', 'expiresAt', 'id', 'kind', 'name', 'pdf', 'restricted', 'status', 'uploadedBy']);
  assert.deepEqual(seen.pdf, { pageCount: 3, selected: [1, 2, 3], job: { state: 'reviewing' } });
  assert.ok(!JSON.stringify(seen).includes('Fixture line'));
  for (const v of ['original', 'sanitised']) assert.equal((await get(app, other, `${u.id}/page/2?v=${v}`)).status, 404, v);
  // Once confirmed (Task 5 covers and confirms; done here through the store), the workspace sees the document.
  store.update(u.id, { status: 'confirmed', evidenceId: 'E7' }, { pages: { 2: new Uint8Array(await (await get(app, cookie, `${u.id}/page/2?v=original`)).arrayBuffer()) }, original: null });
  assert.equal((await get(app, other, `${u.id}/page/2?v=sanitised`)).status, 200);
  const after = ((await call(app, P, { cookie: other })).body.uploads as unknown as PdfView[]).find((x) => x.id === u.id)!;
  assert.ok(after.pdf.pages[1]!.readLines.some((l) => l.includes('Fixture line 2')));
  // No file name in the audit trail (it carries an account number here).
  const audit = JSON.stringify(intents.events(CASE));
  assert.ok(audit.includes(u.id) && !audit.includes('9988776655') && !audit.includes('statement'), audit);

  // Page numbers: malformed or out of the limits is 400, a page outside the selection 404; never a 500.
  for (const k of ['0', '31', '-1', '1.5', 'abc', '01', '99999999999999999999']) {
    const res = await get(app, cookie, `${u.id}/page/${k}`);
    assert.equal(res.status, 400, `page ${k}`);
  }
  assert.equal((await get(app, cookie, `${u.id}/page/4`)).status, 404);
  assert.equal((await get(app, cookie, `${u.id}/page/1?v=other`)).status, 400);
  // No thumbnails once the pages are chosen (here: never needed).
  assert.equal((await get(app, cookie, `${u.id}/thumb/1`)).status, 404);
  // Not an image upload.
  assert.equal((await get(app, cookie, `${u.id}/image`)).status, 404);
  // Neither the file name nor the text read is in the log.
  assert.ok(!lines.some((l) => l.includes('9988776655') || l.includes('Fixture line')), lines.join('\n'));
});

test('a 12-page PDF waits for a selection with thumbnails; selecting [8, 2] reads pages 2 and 8 and drops the thumbnails', TIMEOUT, async () => {
  const { app, people } = setup();
  const cookie = people.fullMember();
  const r = await uploadPdf(app, cookie, pagesPdf(12));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.upload.pdf.job.state, 'selecting');
  assert.equal(r.body.upload.pdf.selected, null);
  assert.deepEqual(r.body.upload.pdf.pages, []);
  const id = r.body.upload.id;
  await waitFor(app, cookie, id, thumbsReady);
  for (const n of [1, 12]) {
    const t = await get(app, cookie, `${id}/thumb/${n}`);
    assert.equal(t.status, 200, `thumb ${n}`);
    assert.equal(t.headers.get('content-type'), 'image/png');
    const png = PNG.sync.read(Buffer.from(await t.arrayBuffer()));
    assert.equal(png.width, Math.floor((595 * PDF_THUMB_DPI) / 72));
  }
  assert.equal((await get(app, cookie, `${id}/thumb/13`)).status, 404);
  assert.equal((await get(app, cookie, `${id}/thumb/0`)).status, 400);
  assert.equal((await get(app, cookie, `${id}/thumb/x`)).status, 400);
  // Nothing rendered at full size yet.
  assert.equal((await get(app, cookie, `${id}/page/1`)).status, 404);

  const s = await select(app, cookie, id, [8, 2]);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.deepEqual(s.body.upload.pdf.selected, [2, 8]);
  assert.deepEqual(s.body.upload.pdf.pages.map((p) => p.original), [2, 8]);
  assert.equal((await get(app, cookie, `${id}/thumb/1`)).status, 404);
  assert.equal((await get(app, cookie, `${id}/thumb/8`)).status, 404);

  const done = await waitFor(app, cookie, id, settled);
  assert.equal(done.pdf.job.state, 'reviewing', JSON.stringify(done.pdf.job));
  assert.ok(done.pdf.pages[1]!.readLines.some((l) => l.includes('Fixture line 8')), JSON.stringify(done.pdf.pages[1]!.readLines));
  assert.equal((await get(app, cookie, `${id}/page/2?v=original`)).status, 200);
  assert.equal((await get(app, cookie, `${id}/page/3`)).status, 404);
});

test('a selection is 1 to 5 distinct pages of the document, made once, only while selecting', TIMEOUT, async () => {
  const { app, people, store } = setup();
  const cookie = people.fullMember();
  const r = await uploadPdf(app, cookie, pagesPdf(12));
  const id = r.body.upload.id;
  for (const pages of [[1, 2, 3, 4, 5, 6], [0], [13], [2, 2], [], [1.5], ['1'], 'all', null, [-1]]) {
    const s = await select(app, cookie, id, pages);
    assert.equal(s.status, 400, JSON.stringify(pages));
    assert.equal(s.body.error, 'BAD_SELECTION');
  }
  assert.equal((await call(app, `${P}/${id}/select`, { body: 'nope{', cookie })).status, 400);
  assert.equal((await select(app, cookie, id, [1, 12, 3, 4, 5])).status, 200);
  const again = await select(app, cookie, id, [1]);
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'WRONG_STATUS');
  // A PDF of 5 pages or fewer is selected whole: nothing to choose.
  const small = await uploadPdf(app, cookie, pagesPdf(2));
  assert.equal((await select(app, cookie, small.body.upload.id, [1])).status, 409);
  // Not a PDF.
  const text = await call(app, P, { body: { text: 'a note', name: 'n.txt' }, cookie });
  assert.equal((await select(app, cookie, text.body.upload.id, [1])).status, 404);
  // Chosen while the thumbnails were still being made: none is left behind.
  assert.equal((await waitFor(app, cookie, id, settled)).pdf.job.state, 'reviewing');
  for (let n = 1; n <= 12; n++) assert.equal(store.thumb(id, n), null, `thumb ${n}`);
  await waitFor(app, cookie, small.body.upload.id, settled);
});

test('an 11 MB PDF is refused before it is read (413); a PDF under 10 MB takes the large-body slot', TIMEOUT, async () => {
  let handled = 0;
  const server = createServer(toNodeListener(async (r) => (handled++, await r.arrayBuffer(), new Response('{}', { status: 200 })), 'http://127.0.0.1'));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as { port: number };
  const post = (headers: Record<string, string | number>, body: Buffer | null, path = P) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      });
      r.on('error', reject);
      if (body) r.end(body);
      else r.write(Buffer.alloc(1024));
    });
  try {
    const big = await post({ 'content-type': 'application/pdf', 'content-length': 11 * 1024 * 1024 }, null);
    assert.equal(big.status, 413);
    assert.match(big.body, /BODY_TOO_LARGE/);
    assert.equal(handled, 0);
    const six = Buffer.alloc(6 * 1024 * 1024);
    assert.equal((await post({ 'content-type': 'application/pdf', 'content-length': six.length }, six)).status, 200);
    // Images keep their 5 MB.
    assert.equal((await post({ 'content-type': 'image/png', 'content-length': six.length }, six)).status, 413);
    // An unknown case gets no large body.
    assert.equal((await post({ 'content-type': 'application/pdf', 'content-length': six.length }, six, '/api/cases/NOPE-1/uploads')).status, 413);
    assert.equal(handled, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
  }
  // Handed straight to the app: still refused, with what to do.
  const { app, people } = setup();
  const over = new Uint8Array(PDF_MAX_BYTES + 1);
  over.set(pagesPdf(1));
  const r = await uploadPdf(app, people.fullMember(), over);
  assert.equal(r.status, 413);
  assert.equal(r.body.detail, TOO_BIG);
});

test('encrypted, broken, non-PDF and 31-page files are refused with their reason, and nothing is stored', TIMEOUT, async () => {
  const { app, people, store } = setup();
  const cookie = people.fullMember();
  const enc = await uploadPdf(app, cookie, encryptedPdf({ userPassword: false }));
  assert.equal(enc.status, 422);
  assert.equal(enc.body.detail, ENCRYPTED);
  for (const bytes of [corruptPdf(), new TextEncoder().encode('just some text, not a PDF')]) {
    const bad = await uploadPdf(app, cookie, bytes);
    assert.equal(bad.status, 422);
    assert.equal(bad.body.detail, UNREADABLE);
  }
  const long = await uploadPdf(app, cookie, pagesPdf(31));
  assert.equal(long.status, 413);
  assert.equal(long.body.detail, TOO_BIG);
  assert.equal(store.usedBytes(), 0);
  assert.deepEqual((await call(app, P, { cookie })).body.uploads, []);
});

test('another workspace, a signed-out visitor or an unbound case get 404 UNKNOWN_CASE; a reviewer uploads and selects their own PDF', TIMEOUT, async () => {
  const { app, people, bindings } = setup();
  const reviewer = people.member('Rita Reviewer');
  const r = await uploadPdf(app, reviewer, pagesPdf(7));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.upload.id;
  for (const who of [people.outsider(), '']) {
    const up = await uploadPdf(app, who, pagesPdf(1));
    assert.equal(up.status, 404);
    assert.equal(up.body.error, 'UNKNOWN_CASE');
    assert.equal((await select(app, who, id, [1])).body.error, 'UNKNOWN_CASE');
    assert.equal((await get(app, who, `${id}/thumb/1`)).status, 404);
    assert.equal((await get(app, who, `${id}/page/1`)).status, 404);
  }
  // Another reviewer does not choose the pages of Rita's upload; Rita does.
  assert.equal((await select(app, people.member(), id, [1])).status, 403);
  const s = await select(app, reviewer, id, [7]);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  await waitFor(app, reviewer, id, settled);

  delete bindings[CASE];
  const unbound = await uploadPdf(app, reviewer, pagesPdf(1));
  assert.equal(unbound.status, 404);
  assert.equal(unbound.body.error, 'UNKNOWN_CASE');
});

test('one PDF is one daily upload unit; each page read counts once in the per-address upload limit', TIMEOUT, async () => {
  const daily = setup({ caps: { upload: 1 } });
  const cookie = daily.people.fullMember();
  const r = await uploadPdf(daily.app, cookie, pagesPdf(7));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await select(daily.app, cookie, r.body.upload.id, [1, 2])).status, 200);
  const over = await call(daily.app, P, { body: { text: 'a note' }, cookie });
  assert.equal(over.status, 429);
  assert.equal(over.body.error, 'DAILY_CAP');
  await waitFor(daily.app, cookie, r.body.upload.id, settled);

  // 4 per address: a 3-page PDF reads 3 pages (its upload is the first read), so one more read is left.
  const perIp = setup({ limits: { uploadsPerIp: { limit: 4, windowMs: 600_000 } } });
  const c = perIp.people.fullMember();
  const three = await uploadPdf(perIp.app, c, pagesPdf(3));
  assert.equal(three.status, 201, JSON.stringify(three.body));
  // 7 pages: the upload is the 4th unit (thumbnails); choosing 1 page needs a 5th.
  const seven = await uploadPdf(perIp.app, c, pagesPdf(7));
  assert.equal(seven.status, 201, JSON.stringify(seven.body));
  const refused = await select(perIp.app, c, seven.body.upload.id, [1]);
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error, 'RATE_LIMITED');
  // Refused before anything was chosen: still selecting.
  const still = (await call(perIp.app, P, { cookie: c })).body.uploads as unknown as PdfView[];
  assert.equal(still.find((u) => u.id === seven.body.upload.id)!.pdf.selected, null);
  await waitFor(perIp.app, c, three.body.upload.id, settled);

  // A 4-page PDF needs 3 reads beyond its upload: with 2 left it is refused, and nothing is stored.
  const tight = setup({ limits: { uploadsPerIp: { limit: 3, windowMs: 600_000 } } });
  const t = tight.people.fullMember();
  const four = await uploadPdf(tight.app, t, pagesPdf(4));
  assert.equal(four.status, 429);
  assert.deepEqual((await call(tight.app, P, { cookie: t })).body.uploads, []);
});

test('the uncovered render is refused once the upload is confirmed; the page image stays', TIMEOUT, async () => {
  const { app, people, store } = setup();
  const cookie = people.fullMember();
  const r = await uploadPdf(app, cookie, pagesPdf(1));
  await waitFor(app, cookie, r.body.upload.id, settled);
  assert.equal((await get(app, cookie, `${r.body.upload.id}/page/1?v=original`)).status, 200);
  const render = new Uint8Array(await (await get(app, cookie, `${r.body.upload.id}/page/1?v=original`)).arrayBuffer());
  store.update(r.body.upload.id, { status: 'confirmed', evidenceId: 'E7' }, { pages: { 1: render }, original: null });
  assert.equal((await get(app, cookie, `${r.body.upload.id}/page/1?v=original`)).status, 404);
  assert.equal((await get(app, cookie, `${r.body.upload.id}/page/1?v=sanitised`)).status, 200);
});

test('the job works on one upload at a time: the second waits until the first is read', TIMEOUT, async () => {
  const store = new UploadStore({ dir: null });
  const busy: number[] = [];
  const order: string[] = [];
  const by = { id: 'p1', label: 'Ana', name: 'Ana' };
  const job = createPdfJob({
    store,
    log: () => {},
    ocr: async () => {
      const working = store.list({ workspaceId: 'ws1', caseId: CASE, boundDisputeId: null }).filter((r) => r.pdf && r.pdf.job.page && (r.pdf.job.state === 'rendering' || r.pdf.job.state === 'reading'));
      busy.push(working.length);
      // Every page of the upload is rendered (and its session closed) before the first reading.
      assert.ok([1, 2].every((k) => store.origPage(working[0]!.id, k)), 'a reading before every render was done');
      assert.ok([1, 2].every((k) => !store.pageImage(working[0]!.id, k)), 'a page stored as sanitised before the cover step');
      order.push(working.map((w) => w.name).join());
      await sleep(30);
      return [{ text: 'read', box: { x: 0, y: 0, w: 1, h: 1 }, confidence: 90 }];
    },
  });
  const ids = ['first', 'second'].map((name) => {
    const rec = store.create({ workspaceId: 'ws1', caseId: CASE, boundDisputeId: null, kind: 'pdf', name, uploadedBy: by }, pagesPdf(2));
    const pages = [1, 2].map((original) => ({ original, rects: [], readLines: [], lines: [], added: [], sha256: null, redactions: 0, dpi: PDF_RENDER_DPI }));
    store.update(rec.id, { pdf: { pageCount: 2, selected: [1, 2], pages, job: { state: 'rendering', page: 0, of: 2 } } });
    return rec.id;
  });
  for (const id of ids) job.start(id);
  await job.idle();
  assert.deepEqual(busy, [1, 1, 1, 1]);
  assert.deepEqual(order, ['first', 'first', 'second', 'second']);
  for (const id of ids) {
    const r = store.get(id)!;
    assert.equal(r.pdf!.job.state, 'reviewing');
    assert.deepEqual(r.pdf!.pages.map((p) => p.readLines), [['read'], ['read']]);
  }
});

const BY = { id: 'p1', label: 'Ana', name: 'Ana' };
/** A pdf upload in the store as the route leaves it: `selected` pages (null: still choosing) and its job state. */
function pdfRecord(store: UploadStore, n: number, selected: number[] | null, job: { state: 'selecting' | 'rendering' | 'reading'; page?: number; of?: number }, name = 'doc') {
  const rec = store.create({ workspaceId: 'ws1', caseId: CASE, boundDisputeId: null, kind: 'pdf', name, uploadedBy: BY }, pagesPdf(n));
  const pages = (selected ?? []).map((original) => ({ original, rects: [], readLines: [], lines: [], added: [], sha256: null, redactions: 0, dpi: PDF_RENDER_DPI }));
  store.update(rec.id, { pdf: { pageCount: n, selected, pages, job } });
  return rec.id;
}

test('a failed job keeps its message and frees everything: original, renders, thumbnails, text; the next upload still runs', TIMEOUT, async () => {
  const store = new UploadStore({ dir: null });
  let calls = 0;
  const job = createPdfJob({
    store,
    log: () => {},
    ocr: async () => {
      // The first upload's second page fails to read; its first page was read already.
      if (++calls === 2) throw new UploadError('OCR_TIMEOUT', 'OCR took too long');
      return [{ text: 'read', box: { x: 0, y: 0, w: 1, h: 1 }, confidence: 90 }];
    },
  });
  const failing = pdfRecord(store, 2, [1, 2], { state: 'rendering', page: 0, of: 2 }, 'failing');
  const next = pdfRecord(store, 2, [1, 2], { state: 'rendering', page: 0, of: 2 }, 'next');
  job.start(failing);
  job.start(next);
  await job.idle();
  const r = store.get(failing)!;
  assert.deepEqual(r.pdf!.job, { state: 'failed', error: 'OCR took too long' });
  assert.equal(r.status, 'pending');
  assert.equal(store.original(failing), null);
  for (const k of [1, 2]) {
    assert.equal(store.origPage(failing, k), null);
    assert.equal(store.pageImage(failing, k), null);
  }
  assert.ok(r.pdf!.pages.every((p) => p.readLines.length === 0 && p.lines.length === 0 && p.added.length === 0 && p.sha256 === null), JSON.stringify(r.pdf!.pages));
  assert.equal(store.usedBytes(), [1, 2].reduce((n, k) => n + store.origPage(next, k)!.length, store.original(next)!.length));
  assert.equal(store.get(next)!.pdf!.job.state, 'reviewing');
});

test('a PDF session over its budget, or a thumbnail over its deadline, fails the job and frees everything', TIMEOUT, async () => {
  const OVER_BUDGET = 'This PDF takes too long to read. Prepare a smaller extract and upload it again.';
  const TOO_SLOW = 'Reading this PDF page took too long. Prepare a smaller extract and upload it again.';
  const read = async () => [{ text: 'read', box: { x: 0, y: 0, w: 1, h: 1 }, confidence: 90 }];
  const freed = (store: UploadStore, id: string, n: number) => {
    assert.equal(store.original(id), null);
    for (let k = 1; k <= n; k++) {
      assert.equal(store.thumb(id, k), null);
      assert.equal(store.origPage(id, k), null);
    }
  };
  for (const [opts, error] of [[{ sessionBudgetMs: 1 }, OVER_BUDGET], [{ thumbTimeoutMs: 1 }, TOO_SLOW]] as const) {
    const store = new UploadStore({ dir: null });
    const lines: string[] = [];
    const job = createPdfJob({ store, log: (l) => lines.push(l), ocr: read, ...opts });
    const thumbs = pdfRecord(store, 7, null, { state: 'selecting', page: 0, of: 7 });
    job.start(thumbs);
    await job.idle();
    assert.deepEqual(store.get(thumbs)!.pdf!.job, { state: 'failed', error });
    freed(store, thumbs, 7);
    assert.ok(lines.every((l) => l === `uploads · pdf job · ${thumbs} · failed · UNREADABLE`), JSON.stringify(lines));
  }
  // The selected pages' session has the same budget.
  const store = new UploadStore({ dir: null });
  const job = createPdfJob({ store, log: () => {}, ocr: read, sessionBudgetMs: 1 });
  const pages = pdfRecord(store, 2, [1, 2], { state: 'rendering', page: 0, of: 2 });
  job.start(pages);
  await job.idle();
  assert.deepEqual(store.get(pages)!.pdf!.job, { state: 'failed', error: OVER_BUDGET });
  freed(store, pages, 2);
  assert.ok(store.get(pages)!.pdf!.pages.every((p) => p.readLines.length === 0), 'nothing was read');
  assert.equal(store.usedBytes(), 0);
});

test('a reader that dies while rendering fails the job: the uncovered renders are gone, and choosing again says why', TIMEOUT, async () => {
  const { app, people, store } = setup();
  const cookie = people.fullMember();
  const r = await uploadPdf(app, cookie, pagesPdf(7));
  const id = r.body.upload.id;
  await waitFor(app, cookie, id, thumbsReady);
  pdfChildTestHooks.onOpen = 'crash';
  try {
    assert.equal((await select(app, cookie, id, [1, 2])).status, 200);
    const done = await waitFor(app, cookie, id, settled);
    assert.equal(done.pdf.job.state, 'failed');
    assert.equal(done.pdf.job.error, UNREADABLE);
  } finally {
    pdfChildTestHooks.onOpen = undefined;
  }
  for (const v of ['original', 'sanitised']) assert.equal((await get(app, cookie, `${id}/page/1?v=${v}`)).status, 404, v);
  assert.equal(store.original(id), null);

  // A job that failed before the pages were chosen: choosing answers its failure, not "already chosen".
  const other = await uploadPdf(app, cookie, pagesPdf(7));
  const oid = other.body.upload.id;
  await waitFor(app, cookie, oid, thumbsReady);
  const cur = store.get(oid)!;
  store.update(oid, { pdf: { ...cur.pdf!, job: { state: 'failed', error: 'The demo has no room for more uploads right now. Discard it and try again later.' } } });
  const s = await select(app, cookie, oid, [1]);
  assert.equal(s.status, 409);
  assert.equal(s.body.error, 'JOB_FAILED');
  assert.equal(s.body.detail, 'The demo has no room for more uploads right now. Discard it and try again later.');
  assert.equal((await get(app, cookie, `${oid}/thumb/1`)).status, 404);
});

test('after a restart, a PDF whose thumbnails were still being made is failed with the restart message and freed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-pdf-restart-'));
  const before = new UploadStore({ dir });
  const making = pdfRecord(before, 12, null, { state: 'selecting', page: 3, of: 12 });
  before.update(making, {}, { thumbs: { 1: new Uint8Array([1]), 2: new Uint8Array([2]), 3: new Uint8Array([3]) } });
  const ready = pdfRecord(before, 12, null, { state: 'selecting' });
  before.update(ready, {}, { thumbs: { 1: new Uint8Array([1]) } });
  const after = new UploadStore({ dir });
  const r = after.get(making)!;
  assert.deepEqual(r.pdf!.job, { state: 'failed', error: 'The server restarted while reading this PDF. Discard it and upload it again.' });
  assert.equal(after.original(making), null);
  assert.equal(after.thumb(making, 1), null);
  // Thumbnails all made: still choosing, nothing lost.
  assert.deepEqual(after.get(ready)!.pdf!.job, { state: 'selecting' });
  assert.ok(after.thumb(ready, 1));
  assert.ok(after.original(ready));
});

test("a page metering refusal gives the day's unit back and says when to retry; a reader that cannot start is 503", TIMEOUT, async () => {
  const { app, people } = setup({ caps: { upload: 1 }, limits: { uploadsPerIp: { limit: 3, windowMs: 600_000 } } });
  const cookie = people.fullMember();
  const four = await uploadPdf(app, cookie, pagesPdf(4));
  assert.equal(four.status, 429);
  assert.equal(four.body.error, 'RATE_LIMITED');
  assert.match(four.res.headers.get('retry-after') ?? '', /^[0-9]+$/);
  // Nothing was read or stored, so the day's only unit is still there.
  assert.equal((await call(app, P, { body: { text: 'a note' }, cookie })).status, 201);

  const s2 = setup();
  pdfChildTestHooks.spawnThrows = true;
  try {
    const r = await uploadPdf(s2.app, s2.people.fullMember(), pagesPdf(1));
    assert.equal(r.status, 503);
    assert.equal(r.body.detail, 'The PDF reader could not start. Try again later.');
  } finally {
    pdfChildTestHooks.spawnThrows = false;
  }
});

// ---- Task 5: cover, transcribe, confirm ----

const OVERLAP = 'A transcribed line cannot come from a covered area.';
type Rect = { x: number; y: number; w: number; h: number };
type ConfirmPage = { lines: string[]; added: { area: Rect; text: string }[]; sha256: string | null };
type Confirmed = Omit<PdfView, 'pdf'> & { evidenceId: string; sha256: string; size: number; mime: string; uploadedBy: { label: string }; pdf: { pages: (Omit<PdfPageView, 'added' | 'lines'> & { added: { area: Rect; text: string; by: string }[]; lines: { text: string; correctedBy: string | null; original: string | null }[] })[] } };
const redactPage = async (app: App, cookie: string, id: string, page: unknown, rects: unknown) => {
  const r = await call(app, `${P}/${id}/redact`, { body: { page, rects }, cookie });
  return { ...r, body: r.body as unknown as PdfAnswer & { readLines: string[] } };
};
const confirmPdf = async (app: App, cookie: string, id: string, pages: unknown) => {
  const r = await call(app, `${P}/${id}/confirm`, { body: { pages }, cookie });
  return { ...r, body: r.body as unknown as { upload: Confirmed; error?: string; detail?: string } };
};
/** An A4 page at the render dpi, in pixels. */
const PAGE_W = Math.floor((595 * PDF_RENDER_DPI) / 72);
/** The top of a page, where the fixture's two lines are. */
const TOP: Rect = { x: 0, y: 0, w: PAGE_W, h: 400 };

test('covering page 2 changes only page 2: re-read from the covered page; each page is covered at most 5 times', TIMEOUT, async () => {
  const { app, people, store } = setup();
  const cookie = people.fullMember();
  const r = await uploadPdf(app, cookie, pagesPdf(3));
  const id = r.body.upload.id;
  const before = await waitFor(app, cookie, id, settled);
  // Malformed covers: 400, nothing counted.
  for (const page of [0, 4, '2', 1.5, undefined]) assert.equal((await redactPage(app, cookie, id, page, [])).status, 400, String(page));
  assert.equal((await redactPage(app, cookie, id, 2, [{ x: -1, y: 0, w: 1, h: 1 }])).status, 400);
  assert.equal((await call(app, `${P}/${id}/redact`, { body: { page: 2, removals: [] }, cookie })).status, 400);

  const c = await redactPage(app, cookie, id, 2, [TOP]);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const [p1, p2, p3] = c.body.upload.pdf.pages;
  assert.deepEqual(p2!.rects, [TOP]);
  assert.match(p2!.sha256 ?? '', /^[0-9a-f]{64}$/);
  assert.ok(!p2!.readLines.some((l) => l.includes('Fixture line')), JSON.stringify(p2!.readLines));
  assert.deepEqual(c.body.readLines, p2!.readLines);
  assert.deepEqual(p2!.lines, []);
  assert.deepEqual(p2!.added, []);
  assert.deepEqual([p1, p3], [before.pdf.pages[0], before.pdf.pages[2]]);
  assert.equal(c.body.upload.status, 'reviewing');
  // The covered page is stored and served; the cover is burnt in.
  const served = await get(app, cookie, `${id}/page/2?v=sanitised`);
  assert.equal(served.status, 200);
  const png = PNG.sync.read(Buffer.from(await served.arrayBuffer()));
  assert.deepEqual([...png.data.subarray(0, 4)], [0, 0, 0, 255]);
  assert.equal(createHash('sha256').update(store.pageImage(id, 2)!).digest('hex'), p2!.sha256);
  assert.equal(store.pageImage(id, 1), null);
  // Always from the uncovered render: covering nothing afterwards shows the page's lines again.
  const again = await redactPage(app, cookie, id, 2, []);
  assert.ok(again.body.upload.pdf.pages[1]!.readLines.some((l) => l.includes('Fixture line 2')), JSON.stringify(again.body.readLines));
  for (let i = 3; i <= 5; i++) assert.equal((await redactPage(app, cookie, id, 2, [])).status, 200, `attempt ${i}`);
  const sixth = await redactPage(app, cookie, id, 2, []);
  assert.equal(sixth.status, 409);
  assert.equal(sixth.body.error, 'TOO_MANY_REDACTS');
  // Per page: page 1 still has its five.
  assert.equal((await redactPage(app, cookie, id, 1, [])).status, 200);
  // Another reviewer does not cover someone else's PDF.
  assert.equal((await redactPage(app, people.member(), id, 1, [])).status, 403);
});

test('covering a PDF page counts one read in the per-address upload limit, and only once its pages are read', TIMEOUT, async () => {
  const { app, people } = setup({ limits: { uploadsPerIp: { limit: 3, windowMs: 600_000 } } });
  const cookie = people.fullMember();
  const r = await uploadPdf(app, cookie, pagesPdf(1));
  const id = r.body.upload.id;
  // Still being read: refused before any work (its unit given back).
  const early = await redactPage(app, cookie, id, 1, []);
  assert.equal(early.status, 409);
  await waitFor(app, cookie, id, settled);
  for (let i = 0; i < 2; i++) assert.equal((await redactPage(app, cookie, id, 1, [])).status, 200);
  const over = await redactPage(app, cookie, id, 1, []);
  assert.equal(over.status, 429);
  assert.equal(over.body.error, 'RATE_LIMITED');
});

test('the PDF text hint: for its editors while it is reviewed, never cached, stored, logged or audited; refused after confirm', TIMEOUT, async () => {
  const { app, people, store, lines, intents } = setup();
  const rita = people.member('Rita Reviewer');
  // Its text layer holds white text no one sees on the page: the hint shows it, nothing keeps it.
  const r = await uploadPdf(app, rita, hiddenPdf());
  const id = r.body.upload.id;
  await waitFor(app, rita, id, settled);
  const h = await get(app, rita, `${id}/page/1/hint`);
  assert.equal(h.status, 200);
  assert.equal(h.headers.get('cache-control'), 'no-store');
  const hint = (await h.json()) as { lines: string[] };
  assert.ok(hint.lines.includes(HIDDEN.visible) && hint.lines.includes(HIDDEN.white), JSON.stringify(hint));
  // An owner or full member may edit it, so sees it too; another reviewer does not.
  assert.equal((await get(app, people.fullMember(), `${id}/page/1/hint`)).status, 200);
  assert.equal((await get(app, people.member(), `${id}/page/1/hint`)).status, 404);
  assert.equal((await get(app, rita, `${id}/page/2/hint`)).status, 404);
  assert.equal((await get(app, rita, `${id}/page/0/hint`)).status, 400);
  assert.equal((await get(app, rita, `${id}/thumb/1/hint`)).status, 404);
  assert.equal((await call(app, `${P}/${id}/page/1/hint`, { body: {}, cookie: rita })).status, 405);

  const c1 = await redactPage(app, rita, id, 1, []);
  assert.equal(c1.status, 200, JSON.stringify(c1.body));
  const p = c1.body.upload.pdf.pages[0]!;
  const c = await confirmPdf(app, rita, id, [{ lines: p.readLines, added: [], sha256: p.sha256 }]);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal((await get(app, rita, `${id}/page/1/hint`)).status, 404);
  const out = JSON.stringify(store.get(id)) + JSON.stringify(intents.events(CASE)) + lines.join('\n');
  assert.ok(!out.includes(HIDDEN.white), out);
});

test('confirm: every page covered, its lines and sha256; transcriptions outside covers; a PDF rebuilt from the covered pages', TIMEOUT, async () => {
  const { app, people, store, lines } = setup();
  const cookie = people.fullMember();
  const r = await uploadPdf(app, cookie, pagesPdf(2));
  const id = r.body.upload.id;
  await waitFor(app, cookie, id, settled);
  const blank = [{ lines: [], added: [], sha256: '0'.repeat(64) }, { lines: [], added: [], sha256: '0'.repeat(64) }];
  // Nothing covered yet (phase 1: confirm needs the cover step, even covering nothing).
  const early = await confirmPdf(app, cookie, id, blank);
  assert.equal(early.status, 409);
  assert.equal(early.body.error, 'WRONG_STATUS');

  // Page 1: its two lines covered, so nothing is read; page 2: nothing covered.
  const c1 = await redactPage(app, cookie, id, 1, [TOP]);
  assert.deepEqual(c1.body.readLines, []);
  assert.equal((await confirmPdf(app, cookie, id, blank)).status, 409, 'page 2 is not covered yet');
  const c2 = await redactPage(app, cookie, id, 2, []);
  const p1 = c2.body.upload.pdf.pages[0]!;
  const p2 = c2.body.upload.pdf.pages[1]!;
  assert.ok(p2.readLines.length >= 2, JSON.stringify(p2.readLines));
  const corrected = p2.readLines.map((l, i) => (i === 1 ? 'Fixture line 2 (checked)' : l));
  const ok: ConfirmPage[] = [
    // Touching the cover's lower edge is outside it.
    { lines: [], added: [{ area: { x: 100, y: 400, w: 300, h: 30 }, text: 'Order 1234 shipped' }], sha256: p1.sha256 },
    { lines: corrected, added: [], sha256: p2.sha256 },
  ];
  const withPage1 = (added: unknown) => [{ ...ok[0], added }, ok[1]];

  // Review Focus 4: a line read from under a cover is refused, with the reason.
  const overlap = await confirmPdf(app, cookie, id, withPage1([{ area: { x: 50, y: 350, w: 100, h: 100 }, text: 'Card 4111 1111 1111 1111' }]));
  assert.equal(overlap.status, 422);
  assert.equal(overlap.body.error, 'BAD_TRANSCRIPTION');
  assert.equal(overlap.body.detail, OVERLAP);
  for (const added of [
    [{ area: { x: 100, y: 500, w: 1, h: 30 }, text: 'too thin' }],
    [{ area: { x: PAGE_W - 10, y: 500, w: 20, h: 30 }, text: 'off the page' }],
    [{ area: { x: 100, y: 500, w: 30, h: 30 }, text: '   ' }],
    [{ area: { x: 100, y: 500, w: 30, h: 30 }, text: 'two\nlines' }],
    [{ area: { x: 100, y: 500, w: 30, h: 30 }, text: 'x'.repeat(1001) }],
  ]) {
    const bad = await confirmPdf(app, cookie, id, withPage1(added));
    assert.equal(bad.status, 422, JSON.stringify(added));
    assert.equal(bad.body.error, 'BAD_TRANSCRIPTION');
  }
  for (const added of [[{ area: { x: 1 }, text: 'x' }], 'none', [{ text: 'no area' }], [{ area: { x: 1, y: 1, w: 5, h: 5 }, text: 7 }]]) {
    assert.equal((await confirmPdf(app, cookie, id, withPage1(added))).status, 400, JSON.stringify(added));
  }
  // One entry per selected page, as many lines as were read, the whole text within MAX_TEXT_CHARS.
  assert.equal((await confirmPdf(app, cookie, id, [ok[0]])).status, 400);
  assert.equal((await confirmPdf(app, cookie, id, [ok[0], { ...ok[1], lines: corrected.slice(1) }])).status, 400);
  assert.equal((await confirmPdf(app, cookie, id, withPage1(Array(21).fill({ area: { x: 100, y: 500, w: 30, h: 30 }, text: 'x'.repeat(1000) })))).status, 400);
  // A stale page hash: the page changed since it was reviewed.
  const stale = await confirmPdf(app, cookie, id, [ok[0], { ...ok[1], sha256: p1.sha256 }]);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'UPLOAD_CHANGED');
  assert.equal(stale.body.detail, 'Page 2 of the original document changed since you reviewed it; review it again');
  // Another reviewer does not confirm it.
  assert.equal((await confirmPdf(app, people.member(), id, ok)).status, 403);

  // Review Focus 5: page 1 read nothing and confirms with no lines and a transcribed one.
  const done = await confirmPdf(app, cookie, id, ok);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const u = done.body.upload;
  assert.equal(u.status, 'confirmed');
  assert.match(u.evidenceId, /^E\d+$/);
  assert.equal(u.mime, 'application/pdf');
  assert.deepEqual(u.pdf.pages[0]!.added, [{ ...ok[0]!.added[0]!, by: u.uploadedBy.label }]);
  assert.deepEqual(u.pdf.pages[0]!.lines, []);
  assert.deepEqual(u.pdf.pages[1]!.lines.map((l) => l.text), corrected);
  assert.deepEqual(u.pdf.pages[1]!.lines[1], { text: corrected[1], correctedBy: u.uploadedBy.label, original: p2.readLines[1] });
  assert.deepEqual(u.pdf.pages[1]!.lines[0], { text: corrected[0], correctedBy: null, original: null });

  // The PDF: the stored covered pages, one per selected page, exactly as writeImagePdf builds them ("same version").
  const pdf = store.sanitised(id)!;
  assert.equal(u.size, pdf.length);
  assert.equal(u.sha256, createHash('sha256').update(pdf).digest('hex'));
  const imgs = [1, 2].map((k) => {
    const p = PNG.sync.read(Buffer.from(store.pageImage(id, k)!));
    const rgb = new Uint8Array(p.width * p.height * 3);
    for (let i = 0, j = 0; i < p.data.length; i += 4, j += 3) rgb.set(p.data.subarray(i, i + 3), j);
    return { width: p.width, height: p.height, rgb, dpi: store.get(id)!.pdf!.pages[k - 1]!.dpi };
  });
  assert.ok(Buffer.from(pdf).equals(Buffer.from(writeImagePdf({ title: 'Uploaded PDF', pages: imgs, dpi: 1 }))));
  assert.equal((await inspectPdf(pdf)).pages, 2);
  // The original and the uncovered renders are gone; the covered pages stay.
  assert.equal(store.original(id), null);
  for (const k of [1, 2]) {
    assert.equal(store.origPage(id, k), null);
    assert.ok(store.pageImage(id, k));
    assert.equal((await get(app, cookie, `${id}/page/${k}?v=original`)).status, 404);
  }
  assert.equal(store.usedBytes(), pdf.length + store.pageImage(id, 1)!.length + store.pageImage(id, 2)!.length);
  // Confirmed once.
  assert.equal((await confirmPdf(app, cookie, id, ok)).status, 409);
  assert.equal((await redactPage(app, cookie, id, 1, [])).status, 409);
  assert.ok(!lines.some((l) => l.includes('Order 1234') || l.includes('Fixture line')), lines.join('\n'));
});

test('a rebuilt PDF over the stored-file limit is refused (413) and the upload stays reviewable', TIMEOUT, async () => {
  const { app, people, store } = setup({ storedFileBytes: 1_000 });
  const cookie = people.fullMember();
  const r = await uploadPdf(app, cookie, pagesPdf(1));
  const id = r.body.upload.id;
  await waitFor(app, cookie, id, settled);
  const c = await redactPage(app, cookie, id, 1, []);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const p = c.body.upload.pdf.pages[0]!;
  const big = await confirmPdf(app, cookie, id, [{ lines: p.readLines, added: [], sha256: p.sha256 }]);
  assert.equal(big.status, 413);
  assert.equal(big.body.error, 'TOO_LARGE');
  assert.equal(store.get(id)!.status, 'reviewing');
  assert.ok(store.original(id));
  assert.equal(store.sanitised(id), null);
});

// ---- Task 5, fix round 1 ----

/** Every `/MediaBox [0 0 w h]` of a PDF, in points. */
const mediaBoxes = (pdf: Uint8Array) => [...Buffer.from(pdf).toString('latin1').matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => [Number(m[1]), Number(m[2])]);

test('a page rendered below the render dpi (an A3 page over the pixel limit) keeps its physical size in the rebuilt PDF', TIMEOUT, async () => {
  const { app, people, store } = setup();
  const cookie = people.fullMember();
  const r = await uploadPdf(app, cookie, textPdf([{ ...A3_LANDSCAPE, lines: ['A3 page'] }, { w: 595, h: 842, lines: ['A4 page'] }]));
  const id = r.body.upload.id;
  await waitFor(app, cookie, id, settled);
  const [a3, a4] = store.get(id)!.pdf!.pages;
  assert.ok(a3!.dpi < PDF_RENDER_DPI, String(a3!.dpi));
  assert.equal(a4!.dpi, PDF_RENDER_DPI);
  // The dpi is the job's, not shown in the view.
  assert.ok(!('dpi' in (await waitFor(app, cookie, id, settled)).pdf.pages[0]!));
  for (const k of [1, 2]) assert.equal((await redactPage(app, cookie, id, k, [])).status, 200);
  const pages = store.get(id)!.pdf!.pages;
  const c = await confirmPdf(app, cookie, id, pages.map((p) => ({ lines: p.readLines, added: [], sha256: p.sha256 })));
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const [b3, b4] = mediaBoxes(store.sanitised(id)!);
  // Whole pixels: at most one pixel (under a point at these dpi) short of the original page.
  assert.ok(b3![0]! <= A3_LANDSCAPE.w && b3![0]! > A3_LANDSCAPE.w - 1 && b3![1]! <= A3_LANDSCAPE.h && b3![1]! > A3_LANDSCAPE.h - 1, JSON.stringify(b3));
  assert.ok(b4![0]! <= 595 && b4![0]! > 594 && b4![1]! <= 842 && b4![1]! > 841, JSON.stringify(b4));
});

test('the text hint is read once per page per review, kept in memory only, and forgotten at confirm and discard', TIMEOUT, async () => {
  const { app, people, store } = setup();
  const cookie = people.fullMember();
  const r = await uploadPdf(app, cookie, pagesPdf(2));
  const id = r.body.upload.id;
  await waitFor(app, cookie, id, settled);
  const reads = pdfChildTestHooks.hintReads;
  for (let i = 0; i < 3; i++) assert.deepEqual(((await (await get(app, cookie, `${id}/page/1/hint`)).json()) as { lines: string[] }).lines, ['Page 1 of 2', 'Fixture line 1']);
  assert.equal(pdfChildTestHooks.hintReads, reads + 1);
  assert.equal(hintCacheSize(id), 1);
  await get(app, cookie, `${id}/page/2/hint`);
  assert.equal(pdfChildTestHooks.hintReads, reads + 2);
  assert.equal(hintCacheSize(id), 2);
  for (const k of [1, 2]) assert.equal((await redactPage(app, cookie, id, k, [])).status, 200);
  const pages = store.get(id)!.pdf!.pages;
  assert.equal((await confirmPdf(app, cookie, id, pages.map((p) => ({ lines: p.readLines, added: [], sha256: p.sha256 })))).status, 200);
  assert.equal(hintCacheSize(id), 0);

  const other = await uploadPdf(app, cookie, pagesPdf(1));
  const oid = other.body.upload.id;
  await waitFor(app, cookie, oid, settled);
  await get(app, cookie, `${oid}/page/1/hint`);
  assert.equal(hintCacheSize(oid), 1);
  assert.equal((await call(app, `${P}/${oid}/discard`, { body: {}, cookie })).status, 200);
  assert.equal(hintCacheSize(oid), 0);
});

test('a hint the reader cannot give is 422 or 503, never a 500, and is not kept; hints count in the per-address read limit', TIMEOUT, async () => {
  const { app, people } = setup({ limits: { paypalReads: { limit: 3, windowMs: 600_000 } } });
  const cookie = people.fullMember();
  const r = await uploadPdf(app, cookie, pagesPdf(1));
  const id = r.body.upload.id;
  await waitFor(app, cookie, id, settled);
  pdfChildTestHooks.spawnThrows = true;
  try {
    const busy = await call(app, `${P}/${id}/page/1/hint`, { cookie });
    assert.equal(busy.status, 503);
    assert.equal(busy.body.error, 'PDF_READER_UNAVAILABLE');
  } finally {
    pdfChildTestHooks.spawnThrows = false;
  }
  pdfChildTestHooks.onOpen = 'crash';
  try {
    assert.equal((await call(app, `${P}/${id}/page/1/hint`, { cookie })).status, 422);
  } finally {
    pdfChildTestHooks.onOpen = undefined;
  }
  assert.equal(hintCacheSize(id), 0);
  assert.equal((await call(app, `${P}/${id}/page/1/hint`, { cookie })).status, 200);
  // The 4th hint request from this address: refused before any work.
  const over = await call(app, `${P}/${id}/page/1/hint`, { cookie });
  assert.equal(over.status, 429);
  assert.equal(over.body.error, 'RATE_LIMITED');
});

test('an upload that expires while its cover or its confirmation waits for the image slot is discarded, not changed', TIMEOUT, async () => {
  const { app, people, store } = setup();
  const cookie = people.fullMember();
  const r = await uploadPdf(app, cookie, pagesPdf(1));
  const id = r.body.upload.id;
  await waitFor(app, cookie, id, settled);
  /** Hold the image slot until `release`; `run` starts while it is held. */
  const held = async (run: () => Promise<{ status: number; body: unknown }>, queued: () => boolean) => {
    let release!: () => void;
    const slot = oneImageAtATime(() => new Promise<void>((ok) => (release = ok)));
    const pending = run();
    for (let i = 0; i < 200 && !queued(); i++) await sleep(10);
    assert.ok(queued(), 'the request did not reach the slot');
    store.update(id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    release();
    await slot;
    return pending;
  };
  const cover = await held(() => redactPage(app, cookie, id, 1, []), () => store.get(id)!.pdf!.pages[0]!.redactions === 1);
  assert.equal(cover.status, 409);
  assert.equal(store.get(id)!.status, 'discarded');

  const r2 = await uploadPdf(app, cookie, pagesPdf(1));
  const id2 = r2.body.upload.id;
  await waitFor(app, cookie, id2, settled);
  const p = (await redactPage(app, cookie, id2, 1, [])).body.upload.pdf.pages[0]!;
  let release!: () => void;
  const slot = oneImageAtATime(() => new Promise<void>((ok) => (release = ok)));
  const pending = confirmPdf(app, cookie, id2, [{ lines: p.readLines, added: [], sha256: p.sha256 }]);
  await sleep(300);
  store.update(id2, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  release();
  await slot;
  const conf = await pending;
  assert.equal(conf.status, 409);
  assert.equal(store.get(id2)!.status, 'discarded');
  assert.equal(store.sanitised(id2), null);
});

test('a stale page names its page of the original document, not its place in the selection', TIMEOUT, async () => {
  const { app, people } = setup();
  const cookie = people.fullMember();
  const id = (await uploadPdf(app, cookie, pagesPdf(7))).body.upload.id;
  await waitFor(app, cookie, id, thumbsReady);
  assert.equal((await select(app, cookie, id, [3, 6])).status, 200);
  await waitFor(app, cookie, id, settled);
  const c1 = await redactPage(app, cookie, id, 1, []);
  const c2 = await redactPage(app, cookie, id, 2, []);
  const [p1, p2] = c2.body.upload.pdf.pages as [PdfPageView, PdfPageView];
  assert.ok(c1.status === 200 && p1.sha256 && p2.sha256);
  const stale = await confirmPdf(app, cookie, id, [
    { lines: p1.readLines, added: [], sha256: p1.sha256 },
    { lines: p2.readLines, added: [], sha256: '0'.repeat(64) },
  ]);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'UPLOAD_CHANGED');
  assert.equal(stale.body.detail, 'Page 6 of the original document changed since you reviewed it; review it again');
});
