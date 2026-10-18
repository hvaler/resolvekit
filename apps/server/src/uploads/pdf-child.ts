/**
 * The child process that reads one uploaded PDF (hostile input) with pdf.js, forked by pdf-input.ts. It holds one
 * document, answers `open`, `render` and `hint` messages one at a time over IPC (advanced serialization, so page
 * pixels travel as binary), and is killed by its parent at the deadline or above the memory ceiling: whatever a
 * hostile file makes pdf.js do, it happens here, not in the server.
 *
 * pdf.js (legacy Node build) runs with its worker code on this process's main thread (the "fake worker"): no worker
 * is spawned and nothing is fetched. Data only, never a URL; no XFA, no scripting (6.x has no eval path left), no
 * system fonts, no font-face. Standard fonts, CMaps and the WASM image decoders are read from the package's own
 * folders with fs (`useWorkerFetch: false`, which also turns off the ICC/WASM colour path that would use XHR).
 * fetch and XMLHttpRequest are replaced by functions that throw, and the attempts are counted in every reply.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { MAX_PIXELS, MAX_SIDE, MAX_TEXT_CHARS, PDF_MAX_PAGE_PIXELS, PDF_MAX_PAGES } from './limits.ts';

export type ChildRequest =
  | { op: 'open'; bytes: Uint8Array; test?: 'hang' | 'crash' }
  | { op: 'render'; page: number; dpi: number }
  | { op: 'hint'; page: number };
export type ChildError = { code: 'TOO_LARGE' | 'UNREADABLE' | 'NOT_FOUND'; reason: 'too-big' | 'encrypted' | 'unreadable' | 'no-page' };
export type ChildReply = { ok: true; result: unknown; net: number } | { ok: false; error: ChildError; net: number };
/** Rows of a rendered page, sent before the render's reply so no second copy of the page is held here. */
export type ChildStrip = { strip: true; width: number; height: number; y: number; rgba: Uint8Array };

/** Rows per strip: about 2.8 MB for the widest page (4096 px). */
const STRIP_ROWS = 170;

let net = 0;
const offline = () => { net++; throw new Error('network is off in the PDF reader'); };
globalThis.fetch = offline as unknown as typeof fetch;
(globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = function XMLHttpRequest() { offline(); };

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
  wasmUrl: folder('wasm'),
  isOffscreenCanvasSupported: false,
  isImageDecoderSupported: false,
  enableHWA: false,
  /** Embedded images above phase 1's pixel limit are skipped instead of decoded. */
  maxImageSize: MAX_PIXELS,
  disableRange: true,
  disableStream: true,
  disableAutoFetch: true,
  verbosity: 0, // errors only: pdf.js warnings can quote names from the file
};

let lib: Promise<Pdfjs> | undefined;

/** Load pdf.js once, with its worker code on this thread; a failed load is not kept, so the next call retries. */
function pdfjs(): Promise<Pdfjs> {
  lib ??= (async () => {
    const workerModule = 'pdfjs-dist/legacy/build/pdf.worker.mjs';
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = await import(workerModule);
    return import('pdfjs-dist/legacy/build/pdf.mjs');
  })();
  lib.catch(() => { lib = undefined; });
  return lib;
}

class Refusal extends Error {
  readonly error: ChildError;
  constructor(error: ChildError) {
    super(error.reason);
    this.error = error;
  }
}
const refuse = (code: ChildError['code'], reason: ChildError['reason']) => new Refusal({ code, reason });

/**
 * `/Encrypt` in the raw bytes, as a trailer or xref-stream key, for a file pdf.js opens with the empty user password
 * (an owner password only); pdf.js's own permissions read covers a key spelled with `#` escapes.
 */
const ENCRYPT_KEY = /\/Encrypt(?=[\s/<\[(0-9])/;

let doc: PDFDocumentProxy | undefined;

async function open(bytes: Uint8Array): Promise<{ pages: number }> {
  const { getDocument } = await pdfjs();
  // A copy is not needed here: the bytes arrived over IPC and belong to this process.
  try {
    doc = await getDocument({ ...OPTIONS, data: bytes }).promise;
  } catch (e) {
    throw (e as Error | undefined)?.name === 'PasswordException' ? refuse('UNREADABLE', 'encrypted') : e;
  }
  if ((await doc.getPermissions()) !== null || ENCRYPT_KEY.test(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1'))) throw refuse('UNREADABLE', 'encrypted');
  if (doc.numPages > PDF_MAX_PAGES) throw refuse('TOO_LARGE', 'too-big');
  if (doc.numPages < 1) throw refuse('UNREADABLE', 'unreadable');
  return { pages: doc.numPages };
}

async function getPage(page: number) {
  if (!doc) throw new Error('no document open');
  if (!Number.isInteger(page) || page < 1 || page > doc.numPages) throw refuse('NOT_FOUND', 'no-page');
  return doc.getPage(page);
}

/**
 * The scale for a page of `w` x `h` points at `dpi`, lowered so the page fits PDF_MAX_PAGE_PIXELS and MAX_SIDE on
 * each side (a poster or a long receipt is rendered smaller rather than refused; the caller gets the dpi used).
 */
function fitScale(w: number, h: number, dpi: number): number {
  return Math.min(dpi / 72, MAX_SIDE / w, MAX_SIDE / h, Math.sqrt(PDF_MAX_PAGE_PIXELS / (w * h)));
}

async function render(page: number, dpi: number) {
  const p = await getPage(page);
  try {
    const base = p.getViewport({ scale: 1 });
    const scale = fitScale(base.width, base.height, dpi);
    const viewport = p.getViewport({ scale });
    const width = Math.max(1, Math.floor(viewport.width));
    const height = Math.max(1, Math.floor(viewport.height));
    const canvas = createCanvas(width, height);
    try {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      await p.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport, background: '#ffffff' }).promise;
      // Read and send the pixels in strips, each flushed before the next: the canvas plus one strip at a time.
      for (let y = 0; y < height; y += STRIP_ROWS) {
        const rows = Math.min(STRIP_ROWS, height - y);
        const { data } = ctx.getImageData(0, y, width, rows);
        const rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
        await send({ strip: true, width, height, y, rgba });
      }
      return { width, height, dpi: scale * 72 };
    } finally {
      // Frees the native surface now rather than at garbage collection.
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    p.cleanup();
  }
}

/** The text layer as trimmed lines (joined on end-of-line or a baseline change), capped at MAX_TEXT_CHARS in all. */
async function hint(page: number): Promise<string[]> {
  const p = await getPage(page);
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
}

async function handle(m: ChildRequest): Promise<unknown> {
  switch (m.op) {
    case 'open':
      if (m.test === 'hang') for (;;) { /* test hook: never answers, the parent kills it at the deadline */ }
      if (m.test === 'crash') process.exit(70);
      return open(m.bytes);
    case 'render':
      return render(m.page, m.dpi);
    case 'hint':
      return hint(m.page);
  }
}

const send = (m: ChildReply | ChildStrip) => new Promise<void>((resolve, reject) => { process.send!(m, (e: Error | null) => (e ? reject(e) : resolve())); });

/** Replies go out in order: a reply is only sent once the strips before it are flushed. */
const reply = (r: ChildReply) => void send(r).catch(() => process.exit(0));

process.on('message', (m: ChildRequest) => {
  handle(m).then(
    (result) => reply({ ok: true, result, net }),
    (e) => reply({ ok: false, error: e instanceof Refusal ? e.error : { code: 'UNREADABLE', reason: 'unreadable' }, net }),
  );
});
// The parent went away: nothing more to do.
process.on('disconnect', () => process.exit(0));
