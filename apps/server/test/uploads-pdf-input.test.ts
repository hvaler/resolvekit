import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { inspectPdf, openPdfSession, pageTextHint, pdfChildTestHooks, readRss, renderPage } from '../src/uploads/pdf-input.ts';
import { MAX_SIDE, PDF_CHILD_MAX_RSS_BYTES, PDF_MAX_BYTES, PDF_MAX_PAGES, PDF_MAX_PAGE_PIXELS, PDF_MAX_SELECTED, PDF_PAGE_TIMEOUT_MS, PDF_RENDER_DPI, PDF_THUMB_DPI, MAX_REDACTS_PER_PAGE } from '../src/uploads/limits.ts';
import { closeOcr, ocrPng, ocrTestHooks } from '../src/uploads/ocr.ts';
import { A3_LANDSCAPE, HIDDEN, HUGE, bombPdf, corruptPdf, encryptedPdf, hiddenPdf, pagesPdf, resourcesPdf, textPdf, zeroPagePdf } from './fixtures/make-pdfs.ts';

const TIMEOUT = { timeout: 60_000 };
const TOO_BIG = 'This PDF is larger than 10 MB or has more than 30 pages. Prepare a smaller extract and upload it again.';
const ENCRYPTED = 'This PDF is password-protected or encrypted. Upload a version without protection.';
const UNREADABLE = 'This file could not be read as a PDF.';
const TOO_SLOW = 'Reading this PDF page took too long. Prepare a smaller extract and upload it again.';
const TOO_HUNGRY = 'This PDF needs more memory than the demo allows. Prepare a smaller extract and upload it again.';
const MiB = 1024 * 1024;

test('limits', () => {
  assert.equal(PDF_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(PDF_MAX_PAGES, 30);
  assert.equal(PDF_MAX_SELECTED, 5);
  assert.equal(PDF_RENDER_DPI, 170);
  assert.equal(PDF_THUMB_DPI, 36);
  assert.equal(PDF_MAX_PAGE_PIXELS, 4_000_000);
  assert.equal(PDF_PAGE_TIMEOUT_MS, 20_000);
  assert.equal(MAX_REDACTS_PER_PAGE, 5);
  assert.equal(PDF_CHILD_MAX_RSS_BYTES, 200 * 1024 * 1024);
});

test('inspect counts the pages', TIMEOUT, async () => {
  assert.deepEqual(await inspectPdf(pagesPdf(3)), { pages: 3 });
  assert.deepEqual(await inspectPdf(pagesPdf(30)), { pages: 30 });
});

test('31 pages is too large', TIMEOUT, async () => {
  await assert.rejects(inspectPdf(pagesPdf(31)), { name: 'UploadError', code: 'TOO_LARGE', message: TOO_BIG });
});

test('over 10 MB is too large, before anything is parsed', TIMEOUT, async () => {
  const big = new Uint8Array(PDF_MAX_BYTES + 1);
  big.set(pagesPdf(1));
  await assert.rejects(inspectPdf(big), { code: 'TOO_LARGE', message: TOO_BIG });
});

test('an encrypted PDF is refused, with or without a user password', TIMEOUT, async () => {
  await assert.rejects(inspectPdf(encryptedPdf({ userPassword: true })), { code: 'UNREADABLE', message: ENCRYPTED });
  await assert.rejects(inspectPdf(encryptedPdf({ userPassword: false })), { code: 'UNREADABLE', message: ENCRYPTED });
  await assert.rejects(renderPage(encryptedPdf({ userPassword: false }), 1, 36), { code: 'UNREADABLE', message: ENCRYPTED });
  await assert.rejects(pageTextHint(encryptedPdf({ userPassword: false }), 1), { code: 'UNREADABLE', message: ENCRYPTED });
  // `/Encr#79pt` plus a comment and no /P: the byte scan decodes the escape; pdf.js's own check refuses it too.
  await assert.rejects(inspectPdf(encryptedPdf({ userPassword: false, disguised: true })), { code: 'UNREADABLE', message: ENCRYPTED });
  try {
    pdfChildTestHooks.onOpen = 'no-scan';
    for (const pdf of [encryptedPdf({ userPassword: false, disguised: true }), encryptedPdf({ userPassword: false }), encryptedPdf({ userPassword: true })]) {
      await assert.rejects(inspectPdf(pdf), { code: 'UNREADABLE', message: ENCRYPTED });
    }
    assert.deepEqual(await inspectPdf(pagesPdf(2)), { pages: 2 });
  } finally {
    pdfChildTestHooks.onOpen = undefined;
  }
});

test('corrupt, zero pages, a PNG or nothing sent as a PDF is unreadable', TIMEOUT, async () => {
  const png = new Uint8Array(PNG.sync.write({ width: 4, height: 4, data: Buffer.alloc(64, 255) } as PNG));
  for (const bad of [corruptPdf(), zeroPagePdf(), png, new Uint8Array(0), pagesPdf(2).subarray(0, 300)]) {
    await assert.rejects(inspectPdf(bad), { code: 'UNREADABLE', message: UNREADABLE });
  }
});

test('page 2 of 3 at 170 dpi is A4 (1405 x 1988, within 2 px), opaque, with ink', TIMEOUT, async () => {
  const r = await renderPage(pagesPdf(3), 2, 170);
  assert.ok(Math.abs(r.width - 1405) <= 2 && Math.abs(r.height - 1988) <= 2, `${r.width}x${r.height}`);
  assert.equal(r.dpi, 170);
  assert.equal(r.rgba.length, r.width * r.height * 4);
  let dark = 0;
  for (let i = 0; i < r.rgba.length; i += 4) {
    assert.equal(r.rgba[i + 3], 255);
    if (r.rgba[i]! < 128) dark++;
  }
  assert.ok(dark > 100, `dark pixels: ${dark}`);
});

test('a page outside the document is refused', TIMEOUT, async () => {
  for (const page of [0, 4, 1.5]) await assert.rejects(renderPage(pagesPdf(3), page, 36), { name: 'UploadError', code: 'NOT_FOUND' });
});

test('a landscape A3 and a 14400 pt page stay within the pixel and side limits, and say the dpi used', TIMEOUT, async () => {
  // A3 at 170 dpi would be 2812 x 1988 (5.6 MP): rendered at ~144 dpi to fit 4 MP.
  const a3 = await renderPage(textPdf([{ ...A3_LANDSCAPE, lines: ['A3'] }]), 1, 170);
  assert.ok(a3.width * a3.height <= PDF_MAX_PAGE_PIXELS && a3.width * a3.height > PDF_MAX_PAGE_PIXELS * 0.99, `${a3.width}x${a3.height}`);
  assert.ok(Math.abs(a3.width / a3.height - 1191 / 842) < 0.01);
  assert.ok(Math.abs(a3.dpi - 143.8) < 0.5, String(a3.dpi));
  const huge = await renderPage(textPdf([{ ...HUGE, lines: ['Poster'] }]), 1, 170);
  assert.ok(huge.width * huge.height <= PDF_MAX_PAGE_PIXELS && huge.width * huge.height > PDF_MAX_PAGE_PIXELS * 0.98, `${huge.width}x${huge.height}`);
  assert.equal(huge.width, huge.height);
  assert.equal(huge.rgba.length, huge.width * huge.height * 4);
  assert.equal(huge.width, 2000);
  assert.ok(Math.abs(huge.dpi - 10) < 0.1, String(huge.dpi));
  const strip = await renderPage(textPdf([{ w: 200, h: 14400, lines: ['Receipt'] }]), 1, 170);
  assert.ok(strip.height <= MAX_SIDE && strip.width * strip.height <= PDF_MAX_PAGE_PIXELS, `${strip.width}x${strip.height}`);
  assert.ok(Math.abs(strip.width / strip.height - 200 / 14400) < 0.01);
  assert.ok(strip.dpi < 21, String(strip.dpi));
});

test('a session renders several pages and hints from one open, and holds the slot until it is closed', TIMEOUT, async () => {
  const s = await openPdfSession(pagesPdf(3));
  assert.equal(s.pages, 3);
  let other = false;
  const next = inspectPdf(pagesPdf(2)).then((r) => { other = true; return r; });
  for (const page of [1, 2, 3]) assert.equal((await s.render(page, 36)).width, 297);
  assert.deepEqual(await s.hint(3), ['Page 3 of 3', 'Fixture line 3']);
  assert.equal(other, false);
  await s.close();
  assert.deepEqual(await next, { pages: 2 });
  await assert.rejects(s.render(1, 36), { name: 'UploadError' });
});

test('a render over the timeout is refused, and the next job still runs', TIMEOUT, async () => {
  const slow = renderPage(pagesPdf(3), 1, 170, { timeoutMs: 1 });
  const next = renderPage(pagesPdf(3), 3, 36);
  await assert.rejects(slow, { code: 'UNREADABLE', message: TOO_SLOW });
  assert.ok((await next).width > 0);
});

test('the OCR worker is closed before a PDF reader starts: the two are never resident together', TIMEOUT, async () => {
  const seen = { created: 0, terminated: 0 };
  await closeOcr();
  ocrTestHooks.set({
    create: async () => {
      seen.created++;
      return { recognize: async () => ({ data: { blocks: [] } }), terminate: async () => { seen.terminated++; } } as never;
    },
    idleMs: 60_000,
  });
  try {
    await ocrPng(new Uint8Array(PNG.sync.write({ width: 4, height: 4, data: Buffer.alloc(64, 255) } as PNG)));
    assert.deepEqual(seen, { created: 1, terminated: 0 }); // kept for OCR_IDLE_MS after its job
    const s = await openPdfSession(pagesPdf(1));
    assert.deepEqual(seen, { created: 1, terminated: 1 });
    await s.close();
  } finally {
    await closeOcr();
    ocrTestHooks.reset();
  }
});

test('a child that hangs is killed at the deadline; one that crashes is unreadable; the next PDF works', TIMEOUT, async () => {
  try {
    pdfChildTestHooks.onOpen = 'hang';
    const started = Date.now();
    await assert.rejects(inspectPdf(pagesPdf(1), { timeoutMs: 1500 }), { code: 'UNREADABLE', message: TOO_SLOW });
    assert.ok(Date.now() - started < 4000, `${Date.now() - started} ms`);
    pdfChildTestHooks.onOpen = 'crash';
    await assert.rejects(inspectPdf(pagesPdf(1)), { code: 'UNREADABLE', message: UNREADABLE });
  } finally {
    pdfChildTestHooks.onOpen = undefined;
  }
  assert.deepEqual(await inspectPdf(pagesPdf(1)), { pages: 1 });
});

test('a reader that cannot be spawned is refused, frees the slot, and does not crash the server', TIMEOUT, async () => {
  try {
    pdfChildTestHooks.spawnThrows = true;
    await assert.rejects(inspectPdf(pagesPdf(1)), { code: 'UNREADABLE', message: 'The PDF reader could not start. Try again later.' });
    await assert.rejects(openPdfSession(pagesPdf(1)), { code: 'UNREADABLE', message: 'The PDF reader could not start. Try again later.' });
  } finally {
    pdfChildTestHooks.spawnThrows = false;
  }
  assert.deepEqual(await inspectPdf(pagesPdf(1)), { pages: 1 });
});

test('a child above the memory ceiling is killed: too large', TIMEOUT, async () => {
  try {
    pdfChildTestHooks.rss = () => PDF_CHILD_MAX_RSS_BYTES + 1;
    await assert.rejects(inspectPdf(pagesPdf(1)), { code: 'TOO_LARGE', message: TOO_HUNGRY });
  } finally {
    pdfChildTestHooks.rss = readRss;
  }
  assert.deepEqual(await inspectPdf(pagesPdf(1)), { pages: 1 });
});

test('the RSS reader works where it applies (Linux) and says nothing elsewhere', () => {
  const own = readRss(process.pid);
  if (process.platform === 'linux') assert.ok(own! > 10 * MiB && own! < 4096 * MiB, String(own));
  else assert.equal(own, undefined);
});

/** Peak RSS of this (the parent) process while `work` runs. */
async function parentPeak<T>(work: () => Promise<T>): Promise<{ base: number; peak: number; ms: number; result: PromiseSettledResult<T> }> {
  const base = process.memoryUsage().rss;
  const started = Date.now();
  let peak = base;
  const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
  const [result] = await Promise.allSettled([work()]);
  clearInterval(iv);
  return { base, peak: Math.max(peak, process.memoryUsage().rss), ms: Date.now() - started, result: result! };
}

test('decompression bombs stay in the child: metadata is never decoded, content and font bombs are refused at the deadline', { timeout: 120_000 }, async (t) => {
  // 1 GiB of zeros in /Metadata (a 1 MB file): never decoded, so the page count comes back at once.
  const metadata = await bombPdf('metadata', 1024);
  const m = await parentPeak(() => inspectPdf(metadata, { timeoutMs: 5000 }));
  t.diagnostic(`metadata bomb: ${m.result.status} in ${m.ms} ms; parent RSS ${(m.base / MiB) | 0} -> peak ${(m.peak / MiB) | 0} MiB`);
  assert.deepEqual(m.result, { status: 'fulfilled', value: { pages: 1 } });
  assert.ok(m.ms < 5000, `${m.ms} ms`);
  assert.ok(m.peak - m.base < 100 * MiB, `parent grew ${((m.peak - m.base) / MiB) | 0} MiB`);
  // 1 GiB in the content stream and in a font file: more work than the deadline allows (and, on Linux, more memory
  // than the ceiling). The child is killed; the parent stays small.
  for (const where of ['content', 'font'] as const) {
    const bomb = await bombPdf(where, 1024);
    const r = await parentPeak(() => renderPage(bomb, 1, 170, { timeoutMs: 1000 }));
    const why = r.result.status === 'rejected' ? (r.result.reason as Error).message : 'rendered';
    t.diagnostic(`${where} bomb: ${why} in ${r.ms} ms; parent RSS ${(r.base / MiB) | 0} -> peak ${(r.peak / MiB) | 0} MiB`);
    assert.equal(r.result.status, 'rejected');
    assert.ok(['TOO_LARGE', 'UNREADABLE'].includes((r.result as PromiseRejectedResult).reason.code), why);
    assert.ok(r.ms < 3000, `${r.ms} ms`);
    assert.ok(r.peak - r.base < 100 * MiB, `parent grew ${((r.peak - r.base) / MiB) | 0} MiB`);
  }
  assert.ok((await renderPage(pagesPdf(1), 1, 36)).width > 0);
});

test('the text hint returns the text layer lines, hidden ones included, and leaves the bytes untouched', TIMEOUT, async () => {
  const bytes = pagesPdf(3);
  const copy = bytes.slice();
  assert.deepEqual(await pageTextHint(bytes, 2), ['Page 2 of 3', 'Fixture line 2']);
  assert.deepEqual(bytes, copy);
  const hidden = await pageTextHint(hiddenPdf(), 1);
  assert.ok(hidden.includes(HIDDEN.visible) && hidden.includes(HIDDEN.white), JSON.stringify(hidden));
  assert.ok(!hidden.some((l) => l.includes(HIDDEN.annotation) || l.includes(HIDDEN.attachment) || l.includes(HIDDEN.title)), JSON.stringify(hidden));
});

test('never fetches from the network: standard fonts, CMaps and the WASM decoder are local, ICC colour is off', TIMEOUT, async () => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => { calls++; throw new Error('network is off'); }) as typeof fetch;
  try {
    for (const pdf of [hiddenPdf(), resourcesPdf(), textPdf([{ ...A3_LANDSCAPE, lines: ['Standard font from the package'] }])]) {
      const s = await openPdfSession(pdf);
      try {
        assert.ok((await s.render(1, 72)).width > 0);
        assert.equal(pdfChildTestHooks.networkAttempts, 0);
        assert.ok((await s.hint(1)).length > 0);
        assert.equal(pdfChildTestHooks.networkAttempts, 0);
      } finally {
        await s.close();
      }
    }
    // The CJK line is read through the CMaps in the package folder.
    assert.deepEqual(await pageTextHint(resourcesPdf(), 1), ['あ']);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(calls, 0);
});
