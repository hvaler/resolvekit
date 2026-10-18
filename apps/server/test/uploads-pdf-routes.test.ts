import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest, createServer } from 'node:http';
import { PNG } from 'pngjs';
import { toNodeListener } from '../src/node.ts';
import { PDF_MAX_BYTES, PDF_RENDER_DPI, PDF_THUMB_DPI } from '../src/uploads/limits.ts';
import { closeOcr } from '../src/uploads/ocr.ts';
import { createPdfJob } from '../src/uploads/pdf-job.ts';
import { UploadStore } from '../src/uploads/store.ts';
import { corruptPdf, encryptedPdf, pagesPdf } from './fixtures/make-pdfs.ts';
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
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

test('a 3-page PDF: all pages selected, rendered and read in the background; pages served, the original only to editors', TIMEOUT, async () => {
  const { app, people, lines } = setup();
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
    assert.match(p.sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.ok(p.readLines.some((l) => l.includes(`Fixture line ${i + 1}`)), JSON.stringify(p.readLines));
    // The view: no counters, no text layer.
    assert.deepEqual(Object.keys(p).sort(), ['added', 'lines', 'original', 'readLines', 'rects', 'sha256']);
  });
  assert.deepEqual(Object.keys(done.pdf).sort(), ['job', 'pageCount', 'pages', 'selected']);

  // The sanitised page image is the one hashed; at the render resolution (A4 at 170 dpi), a fresh opaque PNG.
  const page = await get(app, cookie, `${u.id}/page/2?v=sanitised`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-type'), 'image/png');
  const bytes = new Uint8Array(await page.arrayBuffer());
  assert.equal(sha(bytes), done.pdf.pages[1]!.sha256);
  const png = PNG.sync.read(Buffer.from(bytes));
  assert.equal(png.width, Math.floor((595 * PDF_RENDER_DPI) / 72));
  const orig = await get(app, cookie, `${u.id}/page/2?v=original`);
  assert.equal(orig.status, 200);
  assert.equal(orig.headers.get('content-type'), 'image/png');
  assert.equal(orig.headers.get('cache-control'), 'private, no-store');
  // Another person of the workspace who is a reviewer cannot see the uncovered render of someone else's upload.
  assert.equal((await get(app, people.member(), `${u.id}/page/2?v=original`)).status, 403);

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
  assert.equal((await get(app, cookie, `${id}/page/2`)).status, 200);
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
  store.update(r.body.upload.id, { status: 'confirmed', evidenceId: 'E7' }, { original: null });
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
      assert.ok(working[0]!.pdf!.pages.every((p) => p.sha256), 'a reading before every render was done');
      order.push(working.map((w) => w.name).join());
      await sleep(30);
      return [{ text: 'read', box: { x: 0, y: 0, w: 1, h: 1 }, confidence: 90 }];
    },
  });
  const ids = ['first', 'second'].map((name) => {
    const rec = store.create({ workspaceId: 'ws1', caseId: CASE, boundDisputeId: null, kind: 'pdf', name, uploadedBy: by }, pagesPdf(2));
    const pages = [1, 2].map((original) => ({ original, rects: [], readLines: [], lines: [], added: [], sha256: null, redactions: 0 }));
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
