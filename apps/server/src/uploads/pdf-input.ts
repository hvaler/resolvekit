/**
 * Read an uploaded PDF, which is hostile input: count its pages, render one page to pixels, read one page's text
 * layer as a hint. Nothing else of the file is used.
 *
 * pdf.js (legacy Node build) runs in-process: its worker code is loaded from the package as a module (no worker
 * thread, nothing fetched). Data only, never a URL; no XFA, no scripting (6.x has no eval path left), no system
 * fonts, no font-face; the standard fonts, CMaps, ICC profiles and WASM decoders are read from the package's own
 * folders with fs (`useWorkerFetch: false`). Every job takes the server-wide image slot, has a deadline, and
 * destroys the pdf.js document, its page and the canvas when it ends.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { UploadError, oneImageAtATime } from './image.ts';
import { MAX_SIDE, MAX_TEXT_CHARS, PDF_MAX_BYTES, PDF_MAX_PAGE_PIXELS, PDF_MAX_PAGES, PDF_PAGE_TIMEOUT_MS } from './limits.ts';

const TOO_BIG = 'This PDF is larger than 10 MB or has more than 30 pages. Prepare a smaller extract and upload it again.';
const ENCRYPTED = 'This PDF is password-protected or encrypted. Upload a version without protection.';
const UNREADABLE = 'This file could not be read as a PDF.';
const TOO_SLOW = 'Reading this PDF page took too long. Prepare a smaller extract and upload it again.';

/** Embedded images above this many pixels are skipped by pdf.js instead of decoded (an A4 scan at ~500 dpi). */
const MAX_IMAGE_PIXELS = 25_000_000;

type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

const PKG = dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
/** pdf.js joins these with a file name, so each ends in '/'; in Node it reads them with fs.readFile. */
const folder = (name: string) => `${join(PKG, name)}/`;

const OPTIONS = {
  isEvalSupported: false, // gone from pdf.js 6 (no eval at all); kept so an older build could not turn it on
  enableXfa: false,
  disableFontFace: true,
  useSystemFonts: false,
  useWorkerFetch: false,
  standardFontDataUrl: folder('standard_fonts'),
  cMapUrl: folder('cmaps'),
  cMapPacked: true,
  iccUrl: folder('iccs'),
  wasmUrl: folder('wasm'),
  isOffscreenCanvasSupported: false,
  isImageDecoderSupported: false,
  enableHWA: false,
  maxImageSize: MAX_IMAGE_PIXELS,
  disableRange: true,
  disableStream: true,
  disableAutoFetch: true,
  verbosity: 0, // errors only: pdf.js warnings can quote names from the file
};

let lib: Promise<Pdfjs> | undefined;

/** Load pdf.js once, with its worker code on the main thread (the "fake worker"), so nothing is spawned or fetched. */
function pdfjs(): Promise<Pdfjs> {
  lib ??= (async () => {
    const workerModule = 'pdfjs-dist/legacy/build/pdf.worker.mjs';
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = await import(workerModule);
    return import('pdfjs-dist/legacy/build/pdf.mjs');
  })();
  return lib;
}

const tooBig = () => new UploadError('TOO_LARGE', TOO_BIG);
const unreadable = (cause?: unknown) => new UploadError('UNREADABLE', UNREADABLE, { cause });

/** A PDF starts with `%PDF-` within its first 1024 bytes (readers tolerate leading junk up to there). */
function looksLikePdf(b: Uint8Array): boolean {
  const head = Buffer.from(b.buffer, b.byteOffset, Math.min(b.byteLength, 1024)).toString('latin1');
  return head.includes('%PDF-');
}

/**
 * Open the PDF in the image slot and run `work` on it before the deadline. Too large, encrypted, broken, empty
 * or slow files end as an UploadError with the copy for each; the document is destroyed in every case.
 */
function withPdf<T>(bytes: Uint8Array, timeoutMs: number, work: (doc: PDFDocumentProxy, deadline: number) => Promise<T>): Promise<T> {
  if (bytes.byteLength > PDF_MAX_BYTES) return Promise.reject(tooBig());
  if (!looksLikePdf(bytes)) return Promise.reject(unreadable());
  return oneImageAtATime(async () => {
    const { getDocument } = await pdfjs();
    const deadline = Date.now() + timeoutMs;
    // A copy: pdf.js transfers (detaches) the buffer it is given.
    const task = getDocument({ ...OPTIONS, data: bytes.slice() });
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new UploadError('UNREADABLE', TOO_SLOW)), timeoutMs); });
    const run = async () => {
      const doc = await task.promise;
      const { info } = await doc.getMetadata();
      // Opened with the empty user password, but encrypted all the same (an owner password only).
      if ((info as { EncryptFilterName?: string | null }).EncryptFilterName) throw new UploadError('UNREADABLE', ENCRYPTED);
      if (doc.numPages > PDF_MAX_PAGES) throw tooBig();
      if (doc.numPages < 1) throw unreadable();
      return work(doc, deadline);
    };
    try {
      return await Promise.race([run(), late]);
    } catch (e) {
      if (e instanceof UploadError) throw e;
      if (Date.now() >= deadline) throw new UploadError('UNREADABLE', TOO_SLOW, { cause: e });
      if ((e as Error | undefined)?.name === 'PasswordException') throw new UploadError('UNREADABLE', ENCRYPTED, { cause: e });
      throw unreadable(e);
    } finally {
      clearTimeout(timer);
      await task.destroy().catch(() => {});
    }
  });
}

function checkPage(doc: PDFDocumentProxy, page: number): void {
  if (!Number.isInteger(page) || page < 1 || page > doc.numPages) throw new UploadError('NOT_FOUND', 'This page is not in the PDF');
}

/** The number of pages, refusing what cannot be used (too large, encrypted, unreadable, empty). */
export function inspectPdf(bytes: Uint8Array): Promise<{ pages: number }> {
  return withPdf(bytes, PDF_PAGE_TIMEOUT_MS, async (doc) => ({ pages: doc.numPages }));
}

/**
 * The scale for a page of `w` x `h` points at `dpi`, lowered so the page fits PDF_MAX_PAGE_PIXELS and MAX_SIDE on
 * each side (a poster or a long receipt is rendered smaller rather than refused).
 */
function fitScale(w: number, h: number, dpi: number): number {
  return Math.min(dpi / 72, MAX_SIDE / w, MAX_SIDE / h, Math.sqrt(PDF_MAX_PAGE_PIXELS / (w * h)));
}

/** Render page `page` (1-based) at `dpi` (lower if the page is too large) to opaque RGBA on white. */
export function renderPage(bytes: Uint8Array, page: number, dpi: number, o: { timeoutMs?: number } = {}): Promise<{ width: number; height: number; rgba: Uint8Array }> {
  if (!(dpi > 0 && Number.isFinite(dpi))) return Promise.reject(new RangeError('dpi must be a positive number'));
  return withPdf(bytes, o.timeoutMs ?? PDF_PAGE_TIMEOUT_MS, async (doc, deadline) => {
    checkPage(doc, page);
    const p = await doc.getPage(page);
    try {
      const base = p.getViewport({ scale: 1 });
      const viewport = p.getViewport({ scale: fitScale(base.width, base.height, dpi) });
      const width = Math.max(1, Math.floor(viewport.width));
      const height = Math.max(1, Math.floor(viewport.height));
      const canvas = createCanvas(width, height);
      try {
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        const render = p.render({
          canvas: canvas as unknown as HTMLCanvasElement,
          canvasContext: ctx as unknown as CanvasRenderingContext2D,
          viewport,
          background: '#ffffff',
        });
        // pdf.js chains its render steps as microtasks; yielding between them lets the deadline timer fire.
        render.onContinue = (next: () => void) => { if (Date.now() >= deadline) render.cancel(); else setImmediate(next); };
        await render.promise;
        const { data } = ctx.getImageData(0, 0, width, height);
        const rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
        return { width, height, rgba };
      } finally {
        // Frees the native surface now rather than at garbage collection.
        canvas.width = 0;
        canvas.height = 0;
      }
    } finally {
      p.cleanup();
    }
  });
}

/**
 * The text layer of page `page` (1-based) as trimmed lines, for review only: it may hold text no one sees (white,
 * off the page), so it is a hint and never a source. Capped at MAX_TEXT_CHARS in all.
 */
export function pageTextHint(bytes: Uint8Array, page: number): Promise<string[]> {
  return withPdf(bytes, PDF_PAGE_TIMEOUT_MS, async (doc) => {
    checkPage(doc, page);
    const p = await doc.getPage(page);
    try {
      const { items } = await p.getTextContent();
      const lines: string[] = [];
      let line = '';
      let y: number | undefined;
      let total = 0;
      const flush = () => {
        const t = line.replace(/\s+/g, ' ').trim();
        line = '';
        if (!t || total >= MAX_TEXT_CHARS) return;
        const kept = t.slice(0, MAX_TEXT_CHARS - total);
        total += kept.length;
        lines.push(kept);
      };
      for (const item of items) {
        if (!('str' in item)) continue;
        const iy = item.transform[5] as number;
        if (y !== undefined && Math.abs(iy - y) > Math.max(1, item.height / 2)) flush();
        y = iy;
        line += item.str;
        if (item.hasEOL) flush();
      }
      flush();
      return lines;
    } finally {
      p.cleanup();
    }
  });
}
