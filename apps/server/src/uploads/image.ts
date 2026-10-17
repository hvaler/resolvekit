/**
 * Decode and sanitise an uploaded image (PNG or JPEG, told apart by magic bytes only).
 *
 * The size is read from the header and checked before any pixel is decoded. The sanitised image is a new PNG
 * encoded from the decoded pixels, with the covered rectangles set to opaque black: no metadata, no ancillary
 * chunks, none of the original bytes.
 */
import { createHash } from 'node:crypto';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { MAX_PIXELS, MAX_SIDE } from './limits.ts';

export type Rect = { x: number; y: number; w: number; h: number };

export type UploadErrorCode = 'UNSUPPORTED_TYPE' | 'TOO_LARGE' | 'UNREADABLE';

export class UploadError extends Error {
  readonly code: UploadErrorCode;
  readonly status: number;
  constructor(code: UploadErrorCode, message: string) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
    this.status = code === 'TOO_LARGE' ? 413 : 415;
  }
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const isPng = (b: Uint8Array) => b.length >= 8 && PNG_MAGIC.every((v, i) => b[i] === v);
const isJpeg = (b: Uint8Array) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** Width and height from the PNG IHDR chunk. */
function pngSize(b: Uint8Array): [number, number] {
  if (b.length < 24 || String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!) !== 'IHDR') throw new UploadError('UNREADABLE', 'Not a readable PNG');
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return [v.getUint32(16), v.getUint32(20)];
}

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
      return { kind, width: p.width, height: p.height, rgba: new Uint8Array(p.data) };
    }
    const j = jpeg.decode(bytes, { useTArray: true, maxResolutionInMP: 16, maxMemoryUsageInMB: 256 });
    return { kind, width: j.width, height: j.height, rgba: new Uint8Array(j.data) };
  } catch {
    throw new UploadError('UNREADABLE', 'The image could not be decoded');
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
