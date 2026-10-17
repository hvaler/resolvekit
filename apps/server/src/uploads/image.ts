/**
 * Decode and sanitise an uploaded image (PNG or JPEG, told apart by magic bytes only).
 *
 * The size is read from the header and checked before any pixel is decoded. The sanitised image is a new PNG
 * encoded from the decoded pixels, with the covered rectangles set to opaque black: no metadata, no ancillary
 * chunks, none of the original bytes.
 */
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { MAX_PIXELS, MAX_SIDE } from './limits.ts';

export type Rect = { x: number; y: number; w: number; h: number };

export type UploadErrorCode = 'UNSUPPORTED_TYPE' | 'TOO_LARGE' | 'UNREADABLE' | 'OCR_TIMEOUT' | 'OCR_FAILED' | 'BAD_REDACTION' | 'TOO_LONG';

export class UploadError extends Error {
  readonly code: UploadErrorCode;
  readonly status: number;
  constructor(code: UploadErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UploadError';
    this.code = code;
    this.status = code === 'TOO_LARGE' || code === 'TOO_LONG' ? 413 : code === 'OCR_TIMEOUT' ? 504 : code === 'OCR_FAILED' || code === 'BAD_REDACTION' ? 422 : 415;
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

const tooLarge = () => new UploadError('TOO_LARGE', `The image is larger than ${MAX_SIDE} px or ${MAX_PIXELS / 1024 / 1024} MP`);

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

export function decodeImage(bytes: Uint8Array): { kind: 'png' | 'jpeg'; width: number; height: number; rgba: Uint8Array } {
  const kind = isPng(bytes) ? 'png' : isJpeg(bytes) ? 'jpeg' : null;
  if (!kind) throw new UploadError('UNSUPPORTED_TYPE', 'Only PNG and JPEG images are accepted');
  const [w, h] = kind === 'png' ? pngSize(bytes) : jpegSize(bytes);
  if (w < 1 || h < 1) throw new UploadError('UNREADABLE', 'The image has no pixels');
  if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS) throw new UploadError('TOO_LARGE', `The image is larger than ${MAX_SIDE} px or ${MAX_PIXELS / 1024 / 1024} MP`);
  try {
    if (kind === 'png') {
      const p = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      if (p.width !== w || p.height !== h) throw new Error('size differs from the validated header');
      return { kind, width: p.width, height: p.height, rgba: new Uint8Array(p.data) };
    }
    const j = jpeg.decode(bytes, { useTArray: true, maxResolutionInMP: 16, maxMemoryUsageInMB: 256 });
    if (j.width !== w || j.height !== h) throw new Error('size differs from the validated header');
    return { kind, width: j.width, height: j.height, rgba: new Uint8Array(j.data) };
  } catch (e) {
    if (e instanceof UploadError) throw e;
    throw new UploadError('UNREADABLE', 'The image could not be decoded', { cause: e });
  }
}

/** Decode, burn the rectangles in as opaque black (clipped to the image; empty ones ignored) and encode a fresh PNG. */
export function sanitiseImage(bytes: Uint8Array, rects: readonly Rect[]): { png: Uint8Array; width: number; height: number; sha256: string } {
  const { width, height, rgba } = decodeImage(bytes);
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
  const png = new Uint8Array(PNG.sync.write({ width, height, data: Buffer.from(rgba) } as PNG));
  return { png, width, height, sha256: createHash('sha256').update(png).digest('hex') };
}
