/**
 * Local OCR for uploaded images (tesseract.js, WASM, in this process tree).
 *
 * Nothing is fetched at runtime: the language data comes from the `@tesseract.js-data/eng` package on disk and
 * tesseract.js loads its core and worker from `node_modules` in Node. One worker, created lazily, one job at a
 * time, stopped after OCR_IDLE_MS without work (its WASM heap never shrinks) and recreated on demand. OCR reads at most
 * OCR_MAX_PIXELS: a larger image is downscaled for OCR only. A job that times out (or is aborted) terminates the worker, so a stuck recognition cannot hold up the
 * next one; the worker is recreated on demand.
 */
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';
import { createWorker, type Worker } from 'tesseract.js';
import { decodeImage, UploadError, type Rect } from './image.ts';
import { OCR_IDLE_MS, OCR_MAX_PIXELS, OCR_TIMEOUT_MS } from './limits.ts';

export interface OcrLine { text: string; box: Rect; confidence: number }

// The package ships { gzip: true, langPath } describing its own files.
const eng = createRequire(import.meta.url)('@tesseract.js-data/eng') as { langPath: string; gzip: boolean };

const defaultCreate = (): Promise<Worker> => createWorker('eng', 1, { langPath: eng.langPath, gzip: eng.gzip, cacheMethod: 'none' });

let create = defaultCreate;
let idleMs = OCR_IDLE_MS;
let worker: Promise<Worker> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let pending = 0;
let idleTimer: NodeJS.Timeout | undefined;

/** Tests only: a fake worker factory and a short idle time. */
export const ocrTestHooks = {
  set(h: { create?: () => Promise<Worker>; idleMs?: number }) { create = h.create ?? defaultCreate; idleMs = h.idleMs ?? OCR_IDLE_MS; },
  reset() { create = defaultCreate; idleMs = OCR_IDLE_MS; },
};

function getWorker(): Promise<Worker> {
  worker ??= create().catch((e) => {
    worker = null;
    throw e;
  });
  return worker;
}

async function dropWorker(): Promise<void> {
  const w = worker;
  worker = null;
  if (w) await w.then((x) => x.terminate()).catch(() => {});
}

/** Terminate the worker (server stop, end of tests). */
export function closeOcr(): Promise<void> {
  clearTimeout(idleTimer);
  return dropWorker();
}

/** (Re)start the idle clock; it never fires while a job is queued or running, and never keeps the process alive. */
function armIdle(): void {
  clearTimeout(idleTimer);
  if (!worker) return;
  idleTimer = setTimeout(() => { if (pending === 0) void dropWorker(); }, idleMs);
  idleTimer.unref();
}

/**
 * Area-average downscale of an RGBA buffer to at most `maxPixels` pixels, aspect kept. Within the limit the input
 * is returned as it is (no copy).
 */
export function downscaleRgba(rgba: Uint8Array, width: number, height: number, maxPixels: number): { rgba: Uint8Array; width: number; height: number } {
  if (width * height <= maxPixels) return { rgba, width, height };
  const scale = Math.sqrt(maxPixels / (width * height));
  let w = Math.max(1, Math.floor(width * scale));
  let h = Math.max(1, Math.floor(height * scale));
  while (w * h > maxPixels && (w > 1 || h > 1)) { if (w >= h) w--; else h--; }
  const out = new Uint8Array(w * h * 4);
  const sx = width / w, sy = height / h;
  for (let y = 0; y < h; y++) {
    const y0 = y * sy, y1 = (y + 1) * sy;
    for (let x = 0; x < w; x++) {
      const x0 = x * sx, x1 = (x + 1) * sx;
      let r = 0, g = 0, b = 0, a = 0, total = 0;
      for (let yy = Math.floor(y0); yy < Math.min(height, Math.ceil(y1)); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        for (let xx = Math.floor(x0); xx < Math.min(width, Math.ceil(x1)); xx++) {
          const wt = wy * (Math.min(xx + 1, x1) - Math.max(xx, x0));
          const i = (yy * width + xx) * 4;
          r += rgba[i]! * wt; g += rgba[i + 1]! * wt; b += rgba[i + 2]! * wt; a += rgba[i + 3]! * wt;
          total += wt;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = Math.round(r / total); out[o + 1] = Math.round(g / total); out[o + 2] = Math.round(b / total); out[o + 3] = Math.round(a / total);
    }
  }
  return { rgba: out, width: w, height: h };
}

/**
 * What OCR reads: the PNG itself when within OCR_MAX_PIXELS, else a downscaled copy (the stored file is unchanged),
 * with the factors that map its coordinates back to the original image.
 */
function ocrInput(png: Uint8Array): { png: Uint8Array; sx: number; sy: number } {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (png.length < 24 || v.getUint32(16) * v.getUint32(20) <= OCR_MAX_PIXELS) return { png, sx: 1, sy: 1 };
  const d = decodeImage(png);
  const s = downscaleRgba(d.rgba, d.width, d.height, OCR_MAX_PIXELS); // d is released when this returns
  const out = new Uint8Array(PNG.sync.write({ width: s.width, height: s.height, data: Buffer.from(s.rgba.buffer, s.rgba.byteOffset, s.rgba.byteLength) } as PNG));
  return { png: out, sx: d.width / s.width, sy: d.height / s.height };
}

async function run(png: Uint8Array, timeoutMs: number, signal?: AbortSignal): Promise<OcrLine[]> {
  if (signal?.aborted) throw new UploadError('OCR_FAILED', 'OCR aborted');
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UploadError('OCR_TIMEOUT', 'OCR took too long')), timeoutMs);
    onAbort = () => reject(new UploadError('OCR_FAILED', 'OCR aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  const work = (async () => {
    const { png: input, sx, sy } = ocrInput(png);
    const w = await getWorker();
    const { data } = await w.recognize(Buffer.from(input), {}, { blocks: true });
    return (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines)).flatMap((l) => {
      const text = l.text.trim();
      if (!text) return [];
      // Boxes in the original image's pixels, whatever size OCR read.
      const x0 = Math.round(l.bbox.x0 * sx), y0 = Math.round(l.bbox.y0 * sy);
      const x1 = Math.round(l.bbox.x1 * sx), y1 = Math.round(l.bbox.y1 * sy);
      return [{ text, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, confidence: l.confidence }];
    });
  })();
  work.catch(() => {}); // a late failure after the race is lost must not be unhandled
  try {
    return await Promise.race([work, stop]);
  } catch (e) {
    await dropWorker();
    if (e instanceof UploadError) throw e;
    throw new UploadError('OCR_FAILED', 'OCR failed');
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/** Recognise the text lines of a PNG, one job at a time. Rejects with UploadError OCR_TIMEOUT / OCR_FAILED. */
export function ocrPng(png: Uint8Array, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<OcrLine[]> {
  pending++;
  clearTimeout(idleTimer);
  const job = queue.then(() => run(png, o.timeoutMs ?? OCR_TIMEOUT_MS, o.signal));
  queue = job.catch(() => {}).finally(() => { pending--; armIdle(); });
  return job;
}
