/**
 * The background job of PDF uploads. A PDF takes longer than a request: the upload route answers at once and this job
 * renders and reads in the background, recording its progress in the upload's `pdf.job` after each page so the web
 * app can poll `GET /uploads`.
 *
 *   selecting  thumbnails of every page (PDF_THUMB_DPI), `page`/`of` while they are made, none once all are there
 *   rendering  the selected pages, all in ONE pdf.js session (it holds the server-wide image slot), then closed
 *   reading    OCR of each stored page image, one page at a time, never while a render runs
 *   reviewing  done: every selected page has its image (`page-<k>.png`), its uncovered render (`page-<k>.orig.png`),
 *              its sha256 and its read lines
 *   failed     with a fixed message (never content); the person discards it and uploads again
 *
 * One upload at a time server-wide, in the order started. A rendered page is encoded as a PNG and passed through
 * `sanitiseImage`, the code path of every covered image, so a page image is always a fresh, opaque PNG. An upload
 * discarded, deleted or archived while the job runs is left alone from its next step on. Log lines carry the upload
 * id and an error code only.
 */
import { PNG } from 'pngjs';
import { UploadError, oneImageAtATime, sanitiseImage } from './image.ts';
import { MAX_STORAGE_BYTES, PDF_RENDER_DPI, PDF_THUMB_DPI } from './limits.ts';
import { ocrPng, type OcrLine } from './ocr.ts';
import { openPdfSession, type RenderedPage } from './pdf-input.ts';
import type { PdfState, UploadRecord, UploadStore } from './store.ts';

export interface PdfJobOptions {
  store: UploadStore;
  log: (line: string) => void;
  /** Total size of stored upload files (default MAX_STORAGE_BYTES). */
  maxStorageBytes?: number;
  /** Tests: another reader of a page image (default ocrPng). */
  ocr?: (png: Uint8Array) => Promise<OcrLine[]>;
}

export interface PdfJob {
  /** Queue the upload's next step: its thumbnails (selecting, nothing selected) or its selected pages (rendering). */
  start(uploadId: string): void;
  /** Resolves when every queued step has finished (tests, shutdown). */
  idle(): Promise<void>;
}

const FAILED = 'This PDF could not be read. Discard it and upload it again.';
const GONE = 'The original of this PDF is gone. Discard it and upload it again.';
const FULL = 'The demo has no room for more uploads right now. Discard it and try again later.';

/** A step that cannot go on, with a code for the log and a fixed message for the person. */
class Stop extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** A fresh PNG of a render, through the same sanitising path as an uploaded image (no covers yet). */
function pagePng(p: RenderedPage): { png: Uint8Array; sha256: string } {
  const raw = new Uint8Array(PNG.sync.write({ width: p.width, height: p.height, data: Buffer.from(p.rgba.buffer, p.rgba.byteOffset, p.rgba.byteLength) } as PNG));
  const s = sanitiseImage(raw, []);
  return { png: s.png, sha256: s.sha256 };
}

export function createPdfJob(o: PdfJobOptions): PdfJob {
  const { store, log } = o;
  const maxStorage = o.maxStorageBytes ?? MAX_STORAGE_BYTES;
  const ocr = o.ocr ?? ((png: Uint8Array) => ocrPng(png));
  let queue: Promise<void> = Promise.resolve();

  /** The upload while it is still worked on (pending or reviewing, a pdf), else null: the job stops there. */
  const current = (id: string): (UploadRecord & { pdf: PdfState }) | null => {
    const r = store.get(id);
    return r?.pdf && (r.status === 'pending' || r.status === 'reviewing') ? (r as UploadRecord & { pdf: PdfState }) : null;
  };
  const setJob = (r: UploadRecord & { pdf: PdfState }, job: PdfState['job'], pages = r.pdf.pages) => store.update(r.id, { pdf: { ...r.pdf, pages, job } });
  const room = (bytes: number) => {
    if (store.usedBytes() + bytes > maxStorage) throw new Stop('STORAGE_FULL', FULL);
  };

  /** Thumbnails of every page, while the person has not chosen; stops as soon as a selection is made. */
  const thumbnails = async (id: string) => {
    const r = current(id);
    const original = store.original(id);
    if (!r || !original) throw new Stop('GONE', GONE);
    const of = r.pdf.pageCount;
    const session = await openPdfSession(original);
    try {
      for (let n = 1; n <= of; n++) {
        const thumb = pagePng(await session.render(n, PDF_THUMB_DPI));
        // Checked and written in one synchronous step: a selection made meanwhile wins, and no thumbnail outlives it.
        const cur = current(id);
        if (!cur || cur.pdf.selected || cur.pdf.job.state !== 'selecting') return;
        room(thumb.png.length);
        store.update(id, { pdf: { ...cur.pdf, job: n < of ? { state: 'selecting', page: n, of } : { state: 'selecting' } } }, { thumbs: { [n]: thumb.png } });
      }
    } finally {
      await session.close();
    }
  };

  /** The selected pages: every render first (one session, then closed), then every OCR. */
  const pages = async (id: string) => {
    const r = current(id);
    const original = store.original(id);
    if (!r || !original || !r.pdf.selected) throw new Stop('GONE', GONE);
    const selected = r.pdf.selected;
    const of = selected.length;
    const session = await openPdfSession(original);
    try {
      for (let k = 1; k <= of; k++) {
        const before = current(id);
        if (!before) return;
        setJob(before, { state: 'rendering', page: k, of });
        const page = pagePng(await session.render(selected[k - 1]!, PDF_RENDER_DPI));
        const cur = current(id);
        if (!cur) return;
        room(page.png.length * 2);
        const next = cur.pdf.pages.map((p, i) => (i === k - 1 ? { ...p, sha256: page.sha256 } : p));
        store.update(id, { pdf: { ...cur.pdf, pages: next } }, { pages: { [k]: page.png }, origPages: { [k]: page.png } });
      }
    } finally {
      await session.close();
    }
    for (let k = 1; k <= of; k++) {
      const before = current(id);
      if (!before) return;
      setJob(before, { state: 'reading', page: k, of });
      const png = store.pageImage(id, k);
      if (!png) throw new Stop('GONE', GONE);
      // The image slot as phase 1's OCR takes it: no decode of another upload runs beside this reading.
      const readLines = (await oneImageAtATime(() => ocr(png))).map((l) => l.text);
      const cur = current(id);
      if (!cur) return;
      const next = cur.pdf.pages.map((p, i) => (i === k - 1 ? { ...p, readLines } : p));
      setJob(cur, k < of ? { state: 'reading', page: k, of } : { state: 'reviewing' }, next);
    }
  };

  const run = async (id: string) => {
    const r = current(id);
    if (!r) return;
    try {
      if (r.pdf.job.state === 'selecting' && !r.pdf.selected) await thumbnails(id);
      else if (r.pdf.job.state === 'rendering' && r.pdf.selected) await pages(id);
    } catch (e) {
      // Fixed messages only: neither a Stop nor an UploadError carries content.
      const known = e instanceof Stop || e instanceof UploadError;
      const code = known ? e.code : 'ERROR';
      const error = known ? e.message : FAILED;
      log(`uploads · pdf job · ${id} · failed · ${code}`);
      const cur = current(id);
      if (!cur) return;
      try {
        setJob(cur, { state: 'failed', error });
      } catch {
        log(`uploads · pdf job · ${id} · its failure could not be recorded`);
      }
    }
  };

  return {
    start(uploadId) {
      queue = queue.then(() => run(uploadId)).catch(() => {});
    },
    idle: () => queue,
  };
}
