import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { writeImagePdf, type ImagePage } from '@resolvekit/pdf';

function page(width: number, height: number, seed: number): ImagePage {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 7 + seed) & 0xff;
  return { width, height, rgb };
}
const two = [page(340, 170, 1), page(340, 170, 2)];
const make = (pages: readonly ImagePage[] = two) => Buffer.from(writeImagePdf({ title: 'Evidence (1)', pages, dpi: 170 }));

test('writeImagePdf: one XObject per page, sized from dpi', () => {
  const s = make().toString('latin1');
  assert.equal(s.match(/\/Type \/Page /g)!.length, 2);
  assert.equal(s.match(/\/MediaBox \[0 0 144 72\]/g)!.length, 2);
  assert.equal(s.match(/\/Subtype \/Image /g)!.length, 2);
  assert.match(s, /\/ColorSpace \/DeviceRGB \/BitsPerComponent 8 \/Filter \/FlateDecode/);
  assert.ok(s.includes('/Title (Evidence \\(1\\)) /Producer (ResolveKit)'));
});

test('writeImagePdf: deterministic', () => {
  assert.deepEqual(make(), make());
});

test('writeImagePdf: no fonts, annotations, embedded files, JavaScript or XMP', () => {
  const s = make().toString('latin1');
  for (const bad of ['/Font', '/Annots', '/EmbeddedFile', '/JavaScript', '/JS', '/Metadata', '/Names']) assert.ok(!s.includes(bad), bad);
});

test('writeImagePdf: the image stream inflates back to the exact pixels', () => {
  const pdf = make();
  const s = pdf.toString('latin1');
  const re = /\/Subtype \/Image [^>]*\/Length (\d+) >>\nstream\n/g;
  let n = 0;
  for (const m of s.matchAll(re)) {
    const start = m.index + m[0].length;
    const len = Number(m[1]);
    assert.equal(s.slice(start + len, start + len + '\nendstream'.length), '\nendstream');
    assert.deepEqual(new Uint8Array(inflateSync(pdf.subarray(start, start + len))), two[n]!.rgb);
    n++;
  }
  assert.equal(n, 2);
});

test('writeImagePdf: valid xref offsets', () => {
  const s = make().toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4\n'));
  assert.ok(s.endsWith('%%EOF\n'));
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(s)![1]);
  assert.ok(s.slice(startxref).startsWith('xref\n0 '));
  const entries = [...s.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.equal(entries.length, 3 + 3 * 2);
  entries.forEach((off, i) => assert.ok(s.slice(off).startsWith(`${i + 1} 0 obj`), `object ${i + 1} at ${off}`));
});
