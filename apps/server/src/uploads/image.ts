/**
 * Decode and sanitise an uploaded image (PNG or JPEG, told apart by magic bytes only).
 *
 * The size is read from the header and checked before any pixel is decoded. The sanitised image is a new file
 * encoded from the decoded pixels, with the covered rectangles set to opaque black before encoding: no metadata, no
 * ancillary chunks or segments, none of the original bytes. It is a PNG, except that a covered JPEG photo is stored
 * as a fresh JPEG (see {@link coverImage}).
 */
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { MAX_PIXELS, MAX_SIDE } from './limits.ts';

export type Rect = { x: number; y: number; w: number; h: number };

export type UploadErrorCode = 'UNSUPPORTED_TYPE' | 'TOO_LARGE' | 'UNREADABLE' | 'OCR_TIMEOUT' | 'OCR_FAILED' | 'BAD_REDACTION' | 'TOO_LONG' | 'STORAGE' | 'NOT_FOUND';

export class UploadError extends Error {
  readonly code: UploadErrorCode;
  readonly status: number;
  constructor(code: UploadErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UploadError';
    this.code = code;
    this.status = code === 'TOO_LARGE' || code === 'TOO_LONG' ? 413 : code === 'OCR_TIMEOUT' ? 504 : code === 'STORAGE' ? 503 : code === 'NOT_FOUND' ? 404 : code === 'OCR_FAILED' || code === 'BAD_REDACTION' ? 422 : 415;
  }
}

/** Bit depths the PNG spec allows per colour type. */
const PNG_DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const isPng = (b: Uint8Array) => b.length >= 8 && PNG_MAGIC.every((v, i) => b[i] === v);
const isJpeg = (b: Uint8Array) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/**
 * Walk every PNG chunk (length and type framing) and return what the decoder will see: IHDR must be the first chunk
 * and the only one, interlacing is refused (its inflate size is not bounded by the header), and the IDAT data is
 * inflated here under the size the header allows, so a bomb is refused before pngjs touches it.
 */
function pngSize(b: Uint8Array): [number, number] {
  const bad = () => new UploadError('UNREADABLE', 'Not a readable PNG');
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let w = 0, h = 0, expected = 0;
  const idat: Uint8Array[] = [];
  let o = 8, first = true, ended = false;
  while (o + 12 <= b.length) {
    const len = v.getUint32(o);
    const type = String.fromCharCode(b[o + 4]!, b[o + 5]!, b[o + 6]!, b[o + 7]!);
    if (len > b.length - o - 12) throw bad();
    if (first !== (type === 'IHDR')) throw bad();
    if (first) {
      if (len !== 13) throw bad();
      w = v.getUint32(o + 8);
      h = v.getUint32(o + 12);
      const depth = b[o + 16]!, colour = b[o + 17]!, interlace = b[o + 20]!;
      if (interlace !== 0) throw new UploadError('UNSUPPORTED_TYPE', 'Interlaced PNG images are not accepted');
      if (w < 1 || h < 1) throw new UploadError('UNREADABLE', 'The image has no pixels');
      if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS) throw tooLarge();
      const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colour];
      if (!channels || !PNG_DEPTHS[colour]!.includes(depth)) throw bad();
      expected = h * (1 + Math.ceil((w * channels * depth) / 8));
      if (expected > MAX_PIXELS * 8 + MAX_SIDE) throw tooLarge();
      first = false;
    } else if (type === 'IDAT') idat.push(b.subarray(o + 8, o + 8 + len));
    o += 12 + len;
    if (type === 'IEND') { ended = true; break; }
  }
  if (first || !ended || idat.length === 0) throw bad();
  try {
    if (inflateSync(Buffer.concat(idat), { maxOutputLength: expected }).length !== expected) throw bad();
  } catch (e) {
    throw new UploadError('UNREADABLE', 'The PNG image data does not match its header', { cause: e });
  }
  return [w, h];
}

const tooLarge = () =>
  new UploadError('TOO_LARGE', `The image is larger than ${MAX_SIDE} px on a side or ${MAX_PIXELS.toLocaleString('en-US')} pixels (3840 x 2160); upload a screenshot or a smaller image`);

/** Width and height from the first JPEG start-of-frame segment. */
function jpegSize(b: Uint8Array): [number, number] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 2;
  while (o + 4 <= b.length && b[o] === 0xff) {
    const m = b[o + 1]!;
    if (m === 0xff) { o++; continue; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { o += 2; continue; }
    if (m === 0xd9 || m === 0xda) break;
    // SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc).
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (o + 9 > b.length) break;
      return [v.getUint16(o + 7), v.getUint16(o + 5)];
    }
    o += 2 + v.getUint16(o + 2);
  }
  throw new UploadError('UNREADABLE', 'Not a readable JPEG');
}

/**
 * The EXIF Orientation (1–8) of a JPEG's first Exif APP1 segment, or 1 when there is none or it cannot be read. Every
 * read is bounds-checked against the segment, never past it.
 */
export function jpegOrientation(b: Uint8Array): number {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 2;
  while (o + 4 <= b.length && b[o] === 0xff) {
    const m = b[o + 1]!;
    if (m === 0xff) { o++; continue; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { o += 2; continue; }
    if (m === 0xd9 || m === 0xda) break;
    const len = v.getUint16(o + 2);
    const end = Math.min(b.length, o + 2 + len);
    if (m === 0xe1 && end - (o + 4) >= 14 && String.fromCharCode(...b.subarray(o + 4, o + 10)) === 'Exif\0\0') {
      const t = o + 10;
      const little = b[t] === 0x49 && b[t + 1] === 0x49;
      if (!little && !(b[t] === 0x4d && b[t + 1] === 0x4d)) return 1;
      const u16 = (at: number) => (at + 2 <= end ? v.getUint16(at, little) : -1);
      const u32 = (at: number) => (at + 4 <= end ? v.getUint32(at, little) : -1);
      if (u16(t + 2) !== 42) return 1;
      const ifd = u32(t + 4);
      if (ifd < 8) return 1;
      const n = u16(t + ifd);
      for (let i = 0; i < n; i++) {
        const e = t + ifd + 2 + i * 12;
        if (e + 12 > end) return 1;
        if (u16(e) === 0x0112) {
          const value = u16(e + 2) === 3 && u32(e + 4) === 1 ? u16(e + 8) : -1;
          return value >= 1 && value <= 8 ? value : 1;
        }
      }
      return 1;
    }
    o += 2 + len;
  }
  return 1;
}

/**
 * The pixels turned upright as EXIF Orientation `o` says a viewer must show them (browsers do, so this is the grid the
 * person drew on): 2–4 mirror or turn in place, 5–8 also swap width and height.
 */
function upright(rgba: Uint8Array, w: number, h: number, o: number): { width: number; height: number; rgba: Uint8Array } {
  if (o < 2 || o > 8) return { width: w, height: h, rgba };
  const swap = o >= 5;
  const W = swap ? h : w, H = swap ? w : h;
  const out = new Uint8Array(rgba.length);
  // One pixel per 32-bit word (copied first if the decoder's buffer is not 4-byte aligned).
  const src32 = rgba.byteOffset % 4 === 0 ? new Uint32Array(rgba.buffer, rgba.byteOffset, w * h) : new Uint32Array(rgba.slice().buffer);
  const dst32 = new Uint32Array(out.buffer, 0, W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // The stored pixel shown at (x, y).
      const [sx, sy] =
        o === 2 ? [w - 1 - x, y]
        : o === 3 ? [w - 1 - x, h - 1 - y]
        : o === 4 ? [x, h - 1 - y]
        : o === 5 ? [y, x]
        : o === 6 ? [y, h - 1 - x]
        : o === 7 ? [w - 1 - y, h - 1 - x]
        : [w - 1 - y, x];
      dst32[y * W + x] = src32[sy * w + sx]!;
    }
  }
  return { width: W, height: H, rgba: out };
}

/**
 * Decoded pixels, upright: a JPEG is turned by its EXIF Orientation (a portrait phone photo is stored landscape), so
 * every rectangle and OCR box is in the grid the browser shows.
 */
export function decodeImage(bytes: Uint8Array): { kind: 'png' | 'jpeg'; width: number; height: number; rgba: Uint8Array } {
  const kind = isPng(bytes) ? 'png' : isJpeg(bytes) ? 'jpeg' : null;
  if (!kind) throw new UploadError('UNSUPPORTED_TYPE', 'Only PNG and JPEG images are accepted');
  const [w, h] = kind === 'png' ? pngSize(bytes) : jpegSize(bytes);
  if (w < 1 || h < 1) throw new UploadError('UNREADABLE', 'The image has no pixels');
  if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS) throw tooLarge();
  try {
    if (kind === 'png') {
      const p = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      if (p.width !== w || p.height !== h) throw new Error('size differs from the validated header');
      // The decoder's own buffer, not a copy.
      return { kind, width: p.width, height: p.height, rgba: new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.byteLength) };
    }
    const j = jpeg.decode(bytes, { useTArray: true, maxResolutionInMP: Math.ceil(MAX_PIXELS / 1e6), maxMemoryUsageInMB: 256 });
    if (j.width !== w || j.height !== h) throw new Error('size differs from the validated header');
    return { kind, ...upright(j.data, j.width, j.height, jpegOrientation(bytes)) };
  } catch (e) {
    if (e instanceof UploadError) throw e;
    throw new UploadError('UNREADABLE', 'The image could not be decoded', { cause: e });
  }
}

/**
 * Decode, make every pixel opaque (composited onto white: nothing hides under transparency) and burn the rectangles
 * in as opaque black (clipped to the image; empty ones ignored). The encoder only ever sees these pixels.
 */
function coveredPixels(bytes: Uint8Array, rects: readonly Rect[]): { kind: 'png' | 'jpeg'; width: number; height: number; rgba: Uint8Array } {
  const { kind, width, height, rgba } = decodeImage(bytes);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]!;
    if (a === 255) continue;
    for (let c = i; c < i + 3; c++) rgba[c] = Math.round((rgba[c]! * a + 255 * (255 - a)) / 255);
    rgba[i + 3] = 255;
  }
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(width, Math.floor(r.x) + Math.floor(r.w));
    const y1 = Math.min(height, Math.floor(r.y) + Math.floor(r.h));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        rgba[i] = 0;
        rgba[i + 1] = 0;
        rgba[i + 2] = 0;
        rgba[i + 3] = 255;
      }
    }
  }
  return { kind, width, height, rgba };
}

const encodePng = (width: number, height: number, rgba: Uint8Array) =>
  new Uint8Array(PNG.sync.write({ width, height, data: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength) } as PNG));

/** The covered pixels as a fresh PNG: what OCR reads and what a PDF page is stored as. */
export function sanitiseImage(bytes: Uint8Array, rects: readonly Rect[]): { png: Uint8Array; width: number; height: number; sha256: string } {
  const { width, height, rgba } = coveredPixels(bytes, rects);
  const png = encodePng(width, height, rgba);
  return { png, width, height, sha256: createHash('sha256').update(png).digest('hex') };
}

/**
 * Quality of a covered photo re-encoded as JPEG. 90 is visually lossless for camera photos and keeps small print
 * legible for OCR and for PayPal's reviewers, and the file stays about the size of the uploaded photo (cameras save at
 * about 90 to 95), so a photo within the 5 MiB upload limit stays well under the 9.9 MB stored-file limit; as a
 * lossless PNG the same photo can be three to five times larger and be refused.
 */
export const COVERED_JPEG_QUALITY = 90;

/**
 * An uploaded image with the rectangles covered, as the file to store and send: a JPEG photo becomes a fresh JPEG
 * (baseline, JFIF header only: no EXIF, comments or other segments of the upload), a PNG a fresh PNG (screenshots stay
 * lossless). The covered pixels are black before encoding, so nothing of what was under them reaches the file.
 */
export function coverImage(bytes: Uint8Array, rects: readonly Rect[]): { file: Uint8Array; mime: 'image/png' | 'image/jpeg'; width: number; height: number; sha256: string } {
  const { kind, width, height, rgba } = coveredPixels(bytes, rects);
  const file =
    kind === 'jpeg'
      ? new Uint8Array(jpeg.encode({ data: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height }, COVERED_JPEG_QUALITY).data)
      : encodePng(width, height, rgba);
  return { file, mime: kind === 'jpeg' ? 'image/jpeg' : 'image/png', width, height, sha256: createHash('sha256').update(file).digest('hex') };
}

let slot: Promise<unknown> = Promise.resolve();

/**
 * Run an image job (decode, sanitise, read) when no other is running, server-wide: one image's pixels are held at a
 * time, however small. A failing job frees the slot like a finished one.
 */
export function oneImageAtATime<T>(work: () => Promise<T>): Promise<T> {
  const job = slot.then(work);
  slot = job.catch(() => {});
  return job;
}
