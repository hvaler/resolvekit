import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { closeOcr, ocrPng } from '../src/uploads/ocr.ts';
import { sanitiseImage } from '../src/uploads/image.ts';

const TIMEOUT = { timeout: 60_000 };
const fixture = new Uint8Array(readFileSync(new URL('./fixtures/tracking.png', import.meta.url)));
const compact = (s: string) => s.replace(/\s+/g, ' ');

after(() => closeOcr());

test('reads the tracking number and the date from the fixture', TIMEOUT, async () => {
  const lines = await ocrPng(fixture);
  assert.ok(lines.some((l) => l.text.includes('1Z999AA10123456784')), JSON.stringify(lines.map((l) => l.text)));
  assert.ok(lines.some((l) => compact(l.text).includes('8 Oct 2026')), JSON.stringify(lines.map((l) => l.text)));
  for (const l of lines) assert.ok(l.box.w > 0 && l.box.h > 0 && l.confidence >= 0 && l.text === l.text.trim());
});

test('a covered tracking number is not read', TIMEOUT, async () => {
  const line = (await ocrPng(fixture)).find((l) => l.text.includes('1Z999'));
  assert.ok(line);
  const { png } = sanitiseImage(fixture, [line.box]);
  const lines = await ocrPng(png);
  assert.ok(!lines.some((l) => l.text.includes('1Z999')), JSON.stringify(lines.map((l) => l.text)));
});

test('gives up after the timeout', TIMEOUT, async () => {
  await assert.rejects(ocrPng(fixture, { timeoutMs: 1 }), { code: 'OCR_TIMEOUT' });
  // the queue recovers: the next job still works
  assert.ok((await ocrPng(fixture)).length > 0);
});

test('never fetches from the network', TIMEOUT, async () => {
  await closeOcr(); // a fresh worker, created while fetch is off
  const real = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('network is off'); }) as typeof fetch;
  try {
    const lines = await ocrPng(fixture);
    assert.ok(lines.some((l) => l.text.includes('1Z999AA10123456784')));
  } finally { globalThis.fetch = real; }
});

// ---- memory: bounded OCR input and idle worker ----
import { PNG } from 'pngjs';
import { downscaleRgba, ocrTestHooks } from '../src/uploads/ocr.ts';
import { OCR_MAX_PIXELS, OCR_IDLE_MS } from '../src/uploads/limits.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const solidPng = (w: number, h: number) => new Uint8Array(PNG.sync.write({ width: w, height: h, data: Buffer.alloc(w * h * 4, 255) } as PNG));
const dims = (b: Uint8Array) => [Buffer.from(b).readUInt32BE(16), Buffer.from(b).readUInt32BE(20)];

test('limits: 4 MP of OCR input, 60 s idle', () => {
  assert.equal(OCR_MAX_PIXELS, 4_000_000);
  assert.equal(OCR_IDLE_MS, 60_000);
});

test('downscale: 3840x2160 fits the limit and keeps the aspect', () => {
  const rgba = new Uint8Array(3840 * 2160 * 4).fill(200);
  const o = downscaleRgba(rgba, 3840, 2160, OCR_MAX_PIXELS);
  assert.ok(o.width * o.height <= OCR_MAX_PIXELS);
  assert.ok(o.width * o.height > OCR_MAX_PIXELS * 0.97);
  assert.ok(Math.abs(o.width / o.height - 3840 / 2160) < 0.01);
  assert.equal(o.rgba.length, o.width * o.height * 4);
  assert.equal(o.rgba[0], 200);
});

test('downscale: area average, and an image within the limit is untouched', () => {
  // 2x2 black/white checker averaged into one pixel
  const px = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
  const o = downscaleRgba(px, 2, 2, 1);
  assert.deepEqual([o.width, o.height], [1, 1]);
  assert.ok(Math.abs(o.rgba[0]! - 128) <= 1 && o.rgba[3] === 255);
  const same = downscaleRgba(px, 2, 2, 4);
  assert.equal(same.rgba, px);
  assert.deepEqual([same.width, same.height], [2, 2]);
});

function fakeWorker(seen: { sizes: number[][]; created: number; terminated: number }, delay = 0) {
  return async () => {
    seen.created++;
    return {
      recognize: async (img: Buffer) => { seen.sizes.push(dims(img)); if (delay) await wait(delay); return { data: { blocks: [] } }; },
      terminate: async () => { seen.terminated++; },
    } as never;
  };
}

test('a big image reaches the recognizer downscaled; a small one as it is', async () => {
  const seen = { sizes: [] as number[][], created: 0, terminated: 0 };
  await closeOcr();
  ocrTestHooks.set({ create: fakeWorker(seen), idleMs: 60_000 });
  try {
    await ocrPng(solidPng(2800, 1700)); // 4.76 MP
    await ocrPng(solidPng(100, 50));
    const [w, h] = seen.sizes[0]!;
    assert.ok(w! * h! <= OCR_MAX_PIXELS && w! < 2800 && Math.abs(w! / h! - 2800 / 1700) < 0.01, JSON.stringify(seen.sizes));
    assert.deepEqual(seen.sizes[1], [100, 50]);
  } finally { await closeOcr(); ocrTestHooks.reset(); }
});

test('the worker stops after the idle time, is recreated for the next job, and never stops mid-job', async () => {
  const seen = { sizes: [] as number[][], created: 0, terminated: 0 };
  await closeOcr();
  ocrTestHooks.set({ create: fakeWorker(seen, 120), idleMs: 40 });
  try {
    await ocrPng(solidPng(10, 10)); // the job outlasts the idle time: not stopped while it ran
    assert.equal(seen.terminated, 0);
    await wait(150);
    assert.equal(seen.terminated, 1);
    await ocrPng(solidPng(10, 10));
    assert.equal(seen.created, 2);
    await wait(150);
    assert.equal(seen.terminated, 2);
  } finally { await closeOcr(); ocrTestHooks.reset(); }
});
