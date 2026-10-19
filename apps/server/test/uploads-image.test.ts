import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { coverImage, decodeImage, oneImageAtATime, sanitiseImage, UploadError, type Rect } from '../src/uploads/image.ts';
import { MAX_FILE_BYTES, MAX_STORED_BYTES } from '../src/uploads/limits.ts';

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
  const err = (() => { try { decodeImage(wide); } catch (e) { return e as UploadError; } })();
  assert.equal(err?.status, 413);
});

test('at most 8,294,400 pixels (3840 x 2160): one more row is refused (413) with a message asking for a screenshot or a smaller image', () => {
  const sized = (w: number, h: number) => {
    const b = Buffer.from(png(1, 1));
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  };
  assert.equal(code(() => decodeImage(sized(3840, 2160))), 'UNREADABLE'); // allowed: it only fails as truncated
  assert.equal(code(() => decodeImage(sized(2160, 3840))), 'UNREADABLE');
  for (const [w, h] of [[3840, 2161], [4096, 4096], [4096, 2100]]) {
    const err = (() => { try { decodeImage(sized(w!, h!)); } catch (e) { return e as UploadError; } })();
    assert.equal(err?.code, 'TOO_LARGE', `${w}x${h}`);
    assert.equal(err?.status, 413);
    assert.match(err!.message, /screenshot or a smaller image/);
  }
  const j = Buffer.from(jpg(8, 8));
  const sof = j.indexOf(Buffer.from([0xff, 0xc0]));
  j.writeUInt16BE(2161, sof + 5);
  j.writeUInt16BE(3840, sof + 7);
  assert.equal(code(() => decodeImage(j)), 'TOO_LARGE');
});

test('one image at a time: two concurrent image jobs never overlap, and a failing one frees the slot', async () => {
  const events: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((ok) => (open = ok));
  const a = oneImageAtATime(async () => { events.push('a start'); await gate; events.push('a end'); return 'a'; });
  const b = oneImageAtATime(async () => { events.push('b start'); events.push('b end'); throw new Error('b failed'); });
  const c = oneImageAtATime(async () => { events.push('c start'); events.push('c end'); return 'c'; });
  await new Promise((ok) => setTimeout(ok, 20));
  assert.deepEqual(events, ['a start'], 'b waits while a holds the slot');
  open();
  assert.equal(await a, 'a');
  await assert.rejects(b, /b failed/);
  assert.equal(await c, 'c');
  assert.deepEqual(events, ['a start', 'a end', 'b start', 'b end', 'c start', 'c end']);
});

test('every pixel of the sanitised image is opaque: transparent pixels are composited onto white, colour under alpha 0 does not survive', () => {
  const p = new PNG({ width: 3, height: 1 });
  p.data.set([12, 34, 56, 0, 200, 0, 0, 128, 10, 20, 30, 255]);
  const out = decodeImage(sanitiseImage(PNG.sync.write(p), []).png).rgba;
  assert.deepEqual(px(out, 3, 0, 0), [255, 255, 255, 255]);
  assert.deepEqual(px(out, 3, 1, 0), [227, 127, 127, 255]);
  assert.deepEqual(px(out, 3, 2, 0), [10, 20, 30, 255]);
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

function ihdrRaw(w: number, h: number, depth: number, colour: number): Buffer {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(w, 0);
  d.writeUInt32BE(h, 4);
  d.set([depth, colour, 0, 0, 0], 8);
  return chunk('IHDR', d);
}

test('refuses a PNG whose bit depth is not allowed for its colour type', () => {
  const idat = chunk('IDAT', deflateSync(Buffer.alloc(100)));
  for (const [depth, colour] of [[4, 2], [255, 6], [16, 3], [2, 4], [8, 1], [0, 0]] as const) {
    const b = Buffer.concat([SIG, ihdrRaw(4, 4, depth, colour), idat, iend()]);
    assert.equal(code(() => decodeImage(b)), 'UNREADABLE', `${depth}/${colour}`);
  }
});

test('the inflate budget never exceeds the absolute cap', () => {
  // Largest legal header (3840 x 2160, 16-bit RGBA): the budget is its exact size, so a small stream is refused.
  const b = Buffer.concat([SIG, ihdrRaw(3840, 2160, 16, 6), chunk('IDAT', deflateSync(Buffer.alloc(100))), iend()]);
  assert.equal(code(() => decodeImage(b)), 'UNREADABLE');
  // One more pixel row is over the side limit before any budget is computed.
  assert.equal(code(() => decodeImage(Buffer.concat([SIG, ihdrRaw(4096, 4097, 16, 6), iend()]))), 'TOO_LARGE');
});

test('an UNREADABLE from a corrupt PNG carries its cause', () => {
  const b = Buffer.concat([SIG, ihdr(4, 4), chunk('IDAT', Buffer.from('not zlib')), iend()]);
  try { decodeImage(b); assert.fail('no error'); } catch (e) {
    assert.ok(e instanceof UploadError);
    assert.equal(e.code, 'UNREADABLE');
    assert.ok(e.cause);
  }
});

// ------------------------------------------------------------------------------------------------ covered photos

/**
 * A camera-like photo at the largest accepted size (3840 x 2160): a smooth scene plus per-pixel sensor noise, saved
 * as a JPEG at quality 92 (about 3.7 MB, under the 5 MiB upload limit). Seeded, so every run makes the same bytes.
 */
function cameraPhoto(o: { w?: number; h?: number; seed?: number; inside?: { rect: Rect; rgb: [number, number, number] } } = {}): Uint8Array {
  const w = o.w ?? 3840, h = o.h ?? 2160;
  let s = (o.seed ?? 1) >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const r = o.inside?.rect;
    const base = r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h ? o.inside!.rgb
      : y < h * 0.45 ? [90 + (y / h) * 120, 140 + (y / h) * 80, 230] : [70 + 40 * Math.sin(x / 37), 110 + 30 * Math.cos(y / 23), 50 + 20 * Math.sin((x + y) / 51)];
    for (let c = 0; c < 3; c++) data[i + c] = Math.max(0, Math.min(255, Math.round(base[c]! + (rnd() - 0.5) * 20)));
    data[i + 3] = 255;
  }
  return new Uint8Array(jpeg.encode({ data, width: w, height: h }, 92).data);
}

/** The marker of each JPEG segment up to the scan (SOI first). */
function jpegMarkers(b: Uint8Array): number[] {
  const out = [b[1]!];
  for (let o = 2; o + 4 <= b.length && b[o] === 0xff; o += 2 + ((b[o + 2]! << 8) | b[o + 3]!)) {
    out.push(b[o + 1]!);
    if (b[o + 1] === 0xda) break;
  }
  return out;
}

test('a covered camera photo (JPEG) is stored as a JPEG and fits the stored-file limit; as a PNG it would not', () => {
  const src = cameraPhoto();
  assert.ok(src.length > 3_000_000 && src.length <= MAX_FILE_BYTES, String(src.length));
  const rect = { x: 1200, y: 800, w: 900, h: 300 };
  const out = coverImage(src, [rect]);
  assert.equal(out.mime, 'image/jpeg');
  assert.deepEqual([out.width, out.height], [3840, 2160]);
  assert.equal(decodeImage(out.file).kind, 'jpeg');
  assert.ok(out.file.length < MAX_STORED_BYTES, String(out.file.length));
  // About the size of the photo itself (quality 90 against the camera's 92), not the lossless PNG's.
  assert.ok(out.file.length < src.length * 1.2, `${out.file.length} vs ${src.length}`);
  assert.ok(sanitiseImage(src, [rect]).png.length > MAX_STORED_BYTES);
  assert.equal(out.sha256, createHash('sha256').update(out.file).digest('hex'));
});

test('a covered JPEG keeps nothing of what was covered: sources that differ only there give the same bytes', () => {
  // On the photos' 16 px block grid, so the two uploads differ only inside the area (a JPEG's own blocks would
  // otherwise carry the difference a few pixels past it, in pixels that are not covered).
  const rect = { x: 32, y: 16, w: 64, h: 48 };
  const a = cameraPhoto({ w: 160, h: 96, seed: 7, inside: { rect, rgb: [250, 20, 20] } });
  const b = cameraPhoto({ w: 160, h: 96, seed: 7, inside: { rect, rgb: [20, 250, 250] } });
  assert.notDeepEqual(a, b);
  const ca = coverImage(a, [rect]);
  assert.deepEqual(ca.file, coverImage(b, [rect]).file);
  // Decoded, the covered area is black, up to JPEG ringing near its edges.
  const got = decodeImage(ca.file).rgba;
  for (let y = rect.y + 4; y < rect.y + rect.h - 4; y++) for (let x = rect.x + 4; x < rect.x + rect.w - 4; x++) {
    assert.ok(px(got, 160, x, y).slice(0, 3).every((v) => v <= 24), `${x},${y}: ${px(got, 160, x, y)}`);
  }
});

test('a covered JPEG carries no metadata: EXIF, comments and other segments of the upload are not kept', () => {
  const j = Buffer.from(jpg(16, 16));
  const exif = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x0f]), Buffer.from('Exif\0\0GPSDATA', 'latin1')]);
  const com = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x08]), Buffer.from('secret', 'latin1')]);
  const src = Buffer.concat([j.subarray(0, 2), exif, com, j.subarray(2)]);
  assert.deepEqual(jpegMarkers(src).slice(0, 4), [0xd8, 0xe1, 0xfe, 0xe0]);
  const out = coverImage(src, [{ x: 0, y: 0, w: 4, h: 4 }]);
  assert.equal(out.mime, 'image/jpeg');
  // A fresh file: SOI, JFIF APP0, tables, frame, huffman tables, scan; nothing else before the image data.
  assert.deepEqual(jpegMarkers(out.file), [0xd8, 0xe0, 0xdb, 0xc0, 0xc4, 0xda]);
  for (const s of ['Exif', 'GPSDATA', 'secret']) assert.ok(!Buffer.from(out.file).includes(s), s);
});

test('a covered PNG stays a PNG (lossless, as a screenshot needs): the same file sanitiseImage makes', () => {
  const src = png(200, 100, redBlock);
  const rects = [{ x: 5, y: 5, w: 60, h: 30 }];
  const out = coverImage(src, rects);
  assert.equal(out.mime, 'image/png');
  assert.deepEqual(out.file, sanitiseImage(src, rects).png);
});

// ------------------------------------------------------------------------------------------------ EXIF orientation

/** An EXIF APP1 segment whose IFD0 holds only Orientation (tag 0x0112, SHORT), big- or little-endian. */
function exifOrientation(o: number, little = false): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  const u16 = (v: number, at: number) => (little ? tiff.writeUInt16LE(v, at) : tiff.writeUInt16BE(v, at));
  const u32 = (v: number, at: number) => (little ? tiff.writeUInt32LE(v, at) : tiff.writeUInt32BE(v, at));
  tiff.write(little ? 'II' : 'MM', 0, 'latin1');
  u16(42, 2);
  u32(8, 4);
  u16(1, 8);
  u16(0x0112, 10);
  u16(3, 12);
  u32(1, 14);
  u16(o, 18);
  u32(0, 22);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

/**
 * A camera JPEG stored landscape, 64 x 32, light grey with a red 16 x 16 marker in its stored top-left corner, carrying
 * EXIF Orientation `o` (how a viewer must turn it to show it upright).
 */
function orientedJpeg(o: number, little = false): Uint8Array {
  const w = 64, h = 32;
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(x < 16 && y < 16 ? [230, 20, 20, 255] : [200, 200, 200, 255], (y * w + x) * 4);
  const j = Buffer.from(jpeg.encode({ data, width: w, height: h }, 100).data);
  return Buffer.concat([j.subarray(0, 2), exifOrientation(o, little), j.subarray(2)]);
}

const isRed = (p: number[]) => p[0]! > 180 && p[1]! < 80 && p[2]! < 80;

test('a JPEG is turned upright by its EXIF Orientation before anything is covered: the output is what the browser showed', () => {
  // Where the stored top-left marker shows once upright, and the upright size.
  const cases = [
    { o: 1, size: [64, 32], marker: [2, 2] },
    { o: 3, size: [64, 32], marker: [61, 29] },
    { o: 6, size: [32, 64], marker: [29, 2] },
    { o: 8, size: [32, 64], marker: [2, 61] },
  ] as const;
  for (const c of cases) for (const little of [false, true]) {
    const d = decodeImage(orientedJpeg(c.o, little));
    assert.deepEqual([d.width, d.height], c.size, `orientation ${c.o}`);
    assert.ok(isRed(px(d.rgba, d.width, c.marker[0], c.marker[1])), `orientation ${c.o}: marker at ${c.marker}`);
    // A rectangle drawn on the upright view covers exactly those pixels of the stored (and sent) file.
    const rect = { x: 3, y: 5, w: 11, h: 7 };
    const out = sanitiseImage(orientedJpeg(c.o, little), [rect]);
    assert.deepEqual([out.width, out.height], c.size);
    const got = decodeImage(out.png).rgba;
    for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
      const inside = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
      const p = px(got, out.width, x, y);
      if (inside) assert.deepEqual(p, [0, 0, 0, 255], `o${c.o} ${x},${y}`);
      else assert.ok(p.slice(0, 3).some((v) => v > 150), `o${c.o} ${x},${y}: ${p}`);
    }
    // The covered photo is stored upright too, with no EXIF left to turn it again.
    const photo = coverImage(orientedJpeg(c.o, little), [rect]);
    assert.deepEqual([photo.width, photo.height], c.size);
    assert.ok(!Buffer.from(photo.file).includes('Exif'));
  }
});

test('a missing, unknown or malformed EXIF Orientation leaves the pixels as stored', () => {
  for (const o of [0, 9, 0xffff]) {
    const d = decodeImage(orientedJpeg(o));
    assert.deepEqual([d.width, d.height], [64, 32]);
    assert.ok(isRed(px(d.rgba, 64, 2, 2)));
  }
  // A truncated APP1 (declared longer than the TIFF data it holds) is ignored, not read past.
  const j = Buffer.from(orientedJpeg(1));
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x0c]), Buffer.from('Exif\0\0MM\0*', 'latin1')]);
  const src = Buffer.concat([j.subarray(0, 2), app1, j.subarray(2)]);
  assert.deepEqual([decodeImage(src).width, decodeImage(src).height], [64, 32]);
});
