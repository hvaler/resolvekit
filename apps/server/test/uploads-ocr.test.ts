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
