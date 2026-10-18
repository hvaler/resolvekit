import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { inspectPdf, pageTextHint, renderPage } from '../src/uploads/pdf-input.ts';
import { MAX_PIXELS, MAX_SIDE, PDF_MAX_BYTES, PDF_MAX_PAGES, PDF_MAX_PAGE_PIXELS, PDF_MAX_SELECTED, PDF_PAGE_TIMEOUT_MS, PDF_RENDER_DPI, PDF_THUMB_DPI, MAX_REDACTS_PER_PAGE } from '../src/uploads/limits.ts';
import { A3_LANDSCAPE, HIDDEN, HUGE, corruptPdf, encryptedPdf, hiddenPdf, pagesPdf, textPdf, zeroPagePdf } from './fixtures/make-pdfs.ts';

const TIMEOUT = { timeout: 60_000 };
const TOO_BIG = 'This PDF is larger than 10 MB or has more than 30 pages. Prepare a smaller extract and upload it again.';
const ENCRYPTED = 'This PDF is password-protected or encrypted. Upload a version without protection.';
const UNREADABLE = 'This file could not be read as a PDF.';

test('limits', () => {
  assert.equal(PDF_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(PDF_MAX_PAGES, 30);
  assert.equal(PDF_MAX_SELECTED, 5);
  assert.equal(PDF_RENDER_DPI, 170);
  assert.equal(PDF_THUMB_DPI, 36);
  assert.equal(PDF_MAX_PAGE_PIXELS, MAX_PIXELS);
  assert.equal(PDF_PAGE_TIMEOUT_MS, 20_000);
  assert.equal(MAX_REDACTS_PER_PAGE, 5);
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
  assert.equal(r.rgba.length, r.width * r.height * 4);
  let dark = 0;
  for (let i = 0; i < r.rgba.length; i += 4) {
    assert.equal(r.rgba[i + 3], 255);
    if (r.rgba[i]! < 128) dark++;
  }
  assert.ok(dark > 100, `dark pixels: ${dark}`);
});

test('a page outside the document is refused', TIMEOUT, async () => {
  for (const page of [0, 4, 1.5]) await assert.rejects(renderPage(pagesPdf(3), page, 36), { name: 'UploadError' });
});

test('a landscape A3 and a 14400 pt page stay within the pixel and side limits', TIMEOUT, async () => {
  const a3 = await renderPage(textPdf([{ ...A3_LANDSCAPE, lines: ['A3'] }]), 1, 170);
  assert.ok(Math.abs(a3.width - 2812) <= 2 && Math.abs(a3.height - 1988) <= 2, `${a3.width}x${a3.height}`);
  const huge = await renderPage(textPdf([{ ...HUGE, lines: ['Poster'] }]), 1, 170);
  assert.ok(huge.width * huge.height <= PDF_MAX_PAGE_PIXELS && huge.width * huge.height > PDF_MAX_PAGE_PIXELS * 0.98, `${huge.width}x${huge.height}`);
  assert.equal(huge.width, huge.height);
  const strip = await renderPage(textPdf([{ w: 200, h: 14400, lines: ['Receipt'] }]), 1, 170);
  assert.ok(strip.height <= MAX_SIDE && strip.width * strip.height <= PDF_MAX_PAGE_PIXELS, `${strip.width}x${strip.height}`);
  assert.ok(Math.abs(strip.width / strip.height - 200 / 14400) < 0.01);
});

test('a render over the timeout is refused, and the next job still runs', TIMEOUT, async () => {
  const slow = renderPage(pagesPdf(3), 1, 170, { timeoutMs: 1 });
  const next = renderPage(pagesPdf(3), 3, 36);
  await assert.rejects(slow, { code: 'UNREADABLE', message: /took too long/ });
  assert.ok((await next).width > 0);
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

test('never fetches from the network', TIMEOUT, async () => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => { calls++; throw new Error('network is off'); }) as typeof fetch;
  try {
    assert.deepEqual(await inspectPdf(hiddenPdf()), { pages: 1 });
    assert.ok((await renderPage(hiddenPdf(), 1, 170)).width > 0);
    assert.ok((await pageTextHint(hiddenPdf(), 1)).length > 0);
    assert.ok((await renderPage(textPdf([{ ...A3_LANDSCAPE, lines: ['Standard font from the package'] }]), 1, 36)).width > 0);
  } finally { globalThis.fetch = real; }
  assert.equal(calls, 0);
});
