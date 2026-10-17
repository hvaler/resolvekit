import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { decodeImage, sanitiseImage, UploadError } from '../src/uploads/image.ts';

function png(w: number, h: number, fill: (x: number, y: number) => [number, number, number] = () => [255, 255, 255]): Uint8Array {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = fill(x, y);
    p.data.set([r, g, b, 255], (y * w + x) * 4);
  }
  return PNG.sync.write(p);
}
function jpg(w: number, h: number): Uint8Array {
  const data = Buffer.alloc(w * h * 4, 255);
  return jpeg.encode({ data, width: w, height: h }, 90).data;
}
const redBlock = (x: number, y: number): [number, number, number] =>
  x >= 10 && x < 60 && y >= 10 && y < 30 ? [255, 0, 0] : [255, 255, 255];
const px = (rgba: Uint8Array, w: number, x: number, y: number) => Array.from(rgba.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));

function chunks(b: Uint8Array): string[] {
  const buf = Buffer.from(b);
  const out: string[] = [];
  for (let o = 8; o < buf.length; ) {
    const len = buf.readUInt32BE(o);
    out.push(buf.toString('latin1', o + 4, o + 8));
    o += 12 + len;
  }
  return out;
}
function code(fn: () => unknown): string {
  try { fn(); } catch (e) { assert.ok(e instanceof UploadError); return e.code; }
  return 'none';
}

test('decodes a PNG and a JPEG by their magic bytes, whatever they are called', () => {
  const a = decodeImage(png(8, 6));
  assert.equal(a.kind, 'png');
  assert.deepEqual([a.width, a.height, a.rgba.length], [8, 6, 8 * 6 * 4]);
  const b = decodeImage(jpg(9, 7));
  assert.equal(b.kind, 'jpeg');
  assert.deepEqual([b.width, b.height, b.rgba.length], [9, 7, 9 * 7 * 4]);
});

test('refuses a GIF, a PDF, random bytes (UNSUPPORTED_TYPE/UNREADABLE) and a 5,000 px wide image (TOO_LARGE) before decoding the pixels', () => {
  assert.equal(code(() => decodeImage(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'))), 'UNSUPPORTED_TYPE');
  assert.equal(code(() => decodeImage(Buffer.from('%PDF-1.7\n1 0 obj\n', 'latin1'))), 'UNSUPPORTED_TYPE');
  assert.equal(code(() => decodeImage(new Uint8Array([1, 2, 3, 4, 5]))), 'UNSUPPORTED_TYPE');
  assert.equal(code(() => decodeImage(new Uint8Array(0))), 'UNSUPPORTED_TYPE');
  // Truncated PNG and JPEG: right magic, no usable image.
  assert.equal(code(() => decodeImage(png(8, 8).subarray(0, 20))), 'UNREADABLE');
  assert.equal(code(() => decodeImage(jpg(8, 8).subarray(0, 4))), 'UNREADABLE');
  // Header says 5,000 wide; the pixel data is not even there, so a refusal proves the header was checked first.
  const wide = Buffer.from(png(1, 1));
  wide.writeUInt32BE(5000, 16);
  assert.equal(code(() => decodeImage(wide)), 'TOO_LARGE');
  const huge = Buffer.from(jpg(8, 8));
  const sof = huge.indexOf(Buffer.from([0xff, 0xc0]));
  huge.writeUInt16BE(5000, sof + 7);
  assert.equal(code(() => decodeImage(huge)), 'TOO_LARGE');
  // Within each side but over 16 MP.
  const mp = Buffer.from(png(1, 1));
  mp.writeUInt32BE(4096, 16);
  mp.writeUInt32BE(4096, 20);
  assert.equal(code(() => decodeImage(mp)), 'UNREADABLE'); // exactly 16 MP is allowed: it only fails as truncated
  const err = (() => { try { decodeImage(wide); } catch (e) { return e as UploadError; } })();
  assert.equal(err?.status, 413);
});

test('covered pixels are black whatever the OCR read', () => {
  const src = png(200, 100, redBlock);
  const out = sanitiseImage(src, [{ x: 5, y: 5, w: 60, h: 30 }]);
  assert.deepEqual([out.width, out.height], [200, 100]);
  const orig = decodeImage(src).rgba;
  const got = decodeImage(out.png).rgba;
  for (let y = 0; y < 100; y++) for (let x = 0; x < 200; x++) {
    const inside = x >= 5 && x < 65 && y >= 5 && y < 35;
    assert.deepEqual(px(got, 200, x, y), inside ? [0, 0, 0, 255] : px(orig, 200, x, y), `${x},${y}`);
  }
});

test('the sanitised file has only IHDR, IDAT and IEND', () => {
  const p = new PNG({ width: 4, height: 4 });
  p.data.fill(200);
  const clean = Buffer.from(PNG.sync.write(p));
  // Splice a tEXt chunk after IHDR with a valid CRC.
  const text = Buffer.alloc(12 + 14);
  text.writeUInt32BE(14, 0);
  text.write('tEXt', 4, 'latin1');
  text.write('Author\0secret!', 8, 'latin1');
  text.writeUInt32BE(crc32(text.subarray(4, 22)), 22);
  const withText = Buffer.concat([clean.subarray(0, 33), text, clean.subarray(33)]);
  assert.ok(chunks(withText).includes('tEXt'));
  const set = (s: string[]) => { assert.equal(s[0], 'IHDR'); assert.equal(s.at(-1), 'IEND'); assert.ok(s.slice(1, -1).every((c) => c === 'IDAT') && s.length > 2); };
  const a = sanitiseImage(withText, []);
  set(chunks(a.png));
  assert.ok(!Buffer.from(a.png).includes('secret'));

  // JPEG with an APP1/EXIF segment right after SOI.
  const j = Buffer.from(jpg(8, 8));
  const exif = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x0f]), Buffer.from('Exif\0\0GPSDATA', 'latin1')]);
  const withExif = Buffer.concat([j.subarray(0, 2), exif, j.subarray(2)]);
  assert.equal(decodeImage(withExif).kind, 'jpeg');
  const b = sanitiseImage(withExif, []);
  set(chunks(b.png));
  assert.ok(!Buffer.from(b.png).includes('GPSDATA'));
});

test('rects outside the image are clipped, negative or zero sizes ignored', () => {
  const src = png(20, 10);
  const out = sanitiseImage(src, [
    { x: -5, y: -5, w: 10, h: 10 }, // covers 0..4 x 0..4
    { x: 18, y: 8, w: 100, h: 100 }, // covers 18..19 x 8..9
    { x: 100, y: 100, w: 5, h: 5 }, // fully outside
    { x: 3, y: 3, w: 0, h: 5 },
    { x: 3, y: 3, w: 5, h: -2 },
    { x: 10, y: 5, w: -3, h: 3 },
  ]);
  const got = decodeImage(out.png).rgba;
  let black = 0;
  for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) {
    const isBlack = px(got, 20, x, y).join() === '0,0,0,255';
    const expected = (x < 5 && y < 5) || (x >= 18 && y >= 8);
    assert.equal(isBlack, expected, `${x},${y}`);
    if (isBlack) black++;
  }
  assert.equal(black, 25 + 4);
});

test('the hash is the SHA-256 of the returned PNG bytes', () => {
  const out = sanitiseImage(png(10, 10), [{ x: 0, y: 0, w: 3, h: 3 }]);
  assert.equal(out.sha256, createHash('sha256').update(out.png).digest('hex'));
});

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function ihdr(w: number, h: number, interlace = 0): Buffer {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(w, 0);
  d.writeUInt32BE(h, 4);
  d.set([8, 6, 0, 0, interlace], 8);
  return chunk('IHDR', d);
}
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const iend = () => chunk('IEND', new Uint8Array(0));

test('refuses a PNG with two IHDR chunks', () => {
  const good = Buffer.from(png(4, 4));
  const idatAndEnd = good.subarray(33);
  const twice = Buffer.concat([SIG, ihdr(4, 4), ihdr(4000, 4000), idatAndEnd]);
  assert.equal(code(() => decodeImage(twice)), 'UNREADABLE');
  const late = Buffer.concat([good.subarray(0, 33), ihdr(4, 4), idatAndEnd]);
  assert.equal(code(() => decodeImage(late)), 'UNREADABLE');
});

test('refuses an interlaced PNG before decoding', () => {
  const good = Buffer.from(png(4, 4));
  const inter = Buffer.concat([SIG, ihdr(4, 4, 1), good.subarray(33)]);
  assert.equal(code(() => decodeImage(inter)), 'UNSUPPORTED_TYPE');
});

test('a PNG whose IDAT inflates beyond its declared size is refused', () => {
  const bomb = deflateSync(Buffer.alloc(50 * 1024 * 1024));
  const b = Buffer.concat([SIG, ihdr(4, 4), chunk('IDAT', bomb), iend()]);
  assert.ok(b.length < 200_000);
  assert.equal(code(() => decodeImage(b)), 'UNREADABLE');
  const short = Buffer.concat([SIG, ihdr(4, 4), chunk('IDAT', deflateSync(Buffer.alloc(10))), iend()]);
  assert.equal(code(() => decodeImage(short)), 'UNREADABLE');
});

test('decoded size must equal the validated header size', () => {
  // A decoy 1x1 start-of-frame ahead of the real one: the decoder would use the later, larger frame.
  const j = Buffer.from(jpg(64, 64));
  const sof = j.indexOf(Buffer.from([0xff, 0xc0]));
  const decoy = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00]);
  const b = Buffer.concat([j.subarray(0, sof), decoy, j.subarray(sof)]);
  assert.equal(code(() => decodeImage(b)), 'UNREADABLE');
});
