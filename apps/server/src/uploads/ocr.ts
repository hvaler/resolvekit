/**
 * Local OCR for uploaded images (tesseract.js, WASM, in this process tree).
 *
 * Nothing is fetched at runtime: the language data comes from the `@tesseract.js-data/eng` package on disk and
 * tesseract.js loads its core and worker from `node_modules` in Node. One worker, created lazily, one job at a
 * time. A job that times out (or is aborted) terminates the worker, so a stuck recognition cannot hold up the
 * next one; the worker is recreated on demand.
 */
import { createRequire } from 'node:module';
import { createWorker, type Worker } from 'tesseract.js';
import { UploadError, type Rect } from './image.ts';
import { OCR_TIMEOUT_MS } from './limits.ts';

export interface OcrLine { text: string; box: Rect; confidence: number }

// The package ships { gzip: true, langPath } describing its own files.
const eng = createRequire(import.meta.url)('@tesseract.js-data/eng') as { langPath: string; gzip: boolean };

let worker: Promise<Worker> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function getWorker(): Promise<Worker> {
  worker ??= createWorker('eng', 1, { langPath: eng.langPath, gzip: eng.gzip, cacheMethod: 'none' }).catch((e) => {
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
  return dropWorker();
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
    const w = await getWorker();
    const { data } = await w.recognize(Buffer.from(png), {}, { blocks: true });
    return (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines)).flatMap((l) => {
      const text = l.text.trim();
      if (!text) return [];
      const { x0, y0, x1, y1 } = l.bbox;
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
  const job = queue.then(() => run(png, o.timeoutMs ?? OCR_TIMEOUT_MS, o.signal));
  queue = job.catch(() => {});
  return job;
}
