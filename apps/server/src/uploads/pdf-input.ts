/**
 * Read an uploaded PDF, which is hostile input: count its pages, render pages to pixels, read a page's text layer as
 * a hint. Nothing else of the file is used.
 *
 * pdf.js runs in a forked child process (pdf-child.ts, the same Node with type stripping, V8 heap capped at 160 MB),
 * never in the server: a decompression bomb or a parser loop takes the child down, not the server. The parent kills
 * the child with SIGKILL when one operation outlasts its deadline and, on Linux (the hosted instance), when its
 * resident memory passes PDF_CHILD_MAX_RSS_BYTES, read from /proc/<pid>/statm every 100 ms. On other platforms
 * (Windows, macOS: development only) only the deadline applies. A session holds the server-wide image slot until its
 * child has exited, PDF_SESSION_BUDGET_MS at most in all; a crashed or killed child never throws in the parent, and the
 * next session starts a fresh one. The OCR worker is closed before a child starts (both hold a large heap, and the
 * hosted instance has room for one of them only); it restarts on the next OCR.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UploadError, oneImageAtATime } from './image.ts';
import { PDF_CHILD_MAX_RSS_BYTES, PDF_MAX_BYTES, PDF_MAX_PAGES, PDF_MAX_PAGE_PIXELS, PDF_PAGE_TIMEOUT_MS, PDF_SESSION_BUDGET_MS, sizeLimitText } from './limits.ts';
import { closeOcr } from './ocr.ts';
import type { ChildError, ChildReply, ChildRequest, ChildStrip } from './pdf-child.ts';

/** The refusal of a PDF over PDF_MAX_BYTES or PDF_MAX_PAGES (also given by the upload route on the declared size). */
export const TOO_BIG = `This PDF is larger than ${sizeLimitText(PDF_MAX_BYTES)} or has more than ${PDF_MAX_PAGES} pages. Prepare a smaller extract and upload it again.`;
const ENCRYPTED = 'This PDF is password-protected or encrypted. Upload a version without protection.';
const UNREADABLE = 'This file could not be read as a PDF.';
export const TOO_SLOW = 'Reading this PDF page took too long. Prepare a smaller extract and upload it again.';
/** A session past PDF_SESSION_BUDGET_MS. */
export const OVER_BUDGET = 'This PDF takes too long to read. Prepare a smaller extract and upload it again.';
export const CANNOT_START = 'The PDF reader could not start. Try again later.';
const TOO_HUNGRY = 'This PDF needs more memory than the demo allows. Prepare a smaller extract and upload it again.';

const CHILD = fileURLToPath(new URL('./pdf-child.ts', import.meta.url));
const RSS_POLL_MS = 100;
/** /proc/<pid>/statm counts pages; 4 KiB on the hosted x86-64 Linux. */
const PAGE_BYTES = 4096;

export type RenderedPage = { width: number; height: number; rgba: Uint8Array; dpi: number };

export interface PdfSession {
  readonly pages: number;
  /** Page `page` (1-based) at `dpi`, or lower when the page would pass the pixel or side limit: `dpi` is the one used. */
  render(page: number, dpi: number): Promise<RenderedPage>;
  /** The text layer of page `page` (1-based) as trimmed lines: a hint for review, never a source (it can hold invisible text). */
  hint(page: number): Promise<string[]>;
  /** Kill the child and free the slot. Also happens on any refusal, after PDF_PAGE_TIMEOUT_MS without a call and past the budget. */
  close(): Promise<void>;
}

/**
 * Test hooks: replace the RSS reader, make the spawn throw, make the child hang or crash on open (or skip its raw
 * `/Encrypt` scan), see the network attempts it counted and the text layer reads asked of it.
 */
export const pdfChildTestHooks: {
  rss: (pid: number) => number | undefined;
  spawnThrows: boolean;
  onOpen: 'hang' | 'crash' | 'no-scan' | undefined;
  networkAttempts: number;
  /** Text layer reads asked of a child (each one a hint). */
  hintReads: number;
} = { rss: readRss, spawnThrows: false, onOpen: undefined, networkAttempts: 0, hintReads: 0 };

/** Resident bytes of a process, on Linux only. */
export function readRss(pid: number): number | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    return Number(readFileSync(`/proc/${pid}/statm`, 'latin1').split(' ')[1]) * PAGE_BYTES;
  } catch {
    return undefined;
  }
}

const fromChild = (e: ChildError) =>
  new UploadError(e.code, e.reason === 'too-big' ? TOO_BIG : e.reason === 'encrypted' ? ENCRYPTED : e.reason === 'no-page' ? 'This page is not in the PDF' : UNREADABLE);

/** The few variables a Node process needs; none of the server's secrets reach the child. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

/** One child and its single in-flight request. Once it has died every call rejects with the reason it died. */
class Reader {
  private readonly proc: ChildProcess;
  private pending: { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout; rgba?: Uint8Array } | undefined;
  private death: UploadError | undefined;
  private killedFor: UploadError | undefined;
  private readonly poll: NodeJS.Timeout;
  readonly exited: Promise<void>;

  /** Throws when the child cannot be spawned synchronously (Node throws errnos such as ENOMEM rather than emit them). */
  constructor() {
    if (pdfChildTestHooks.spawnThrows) throw new Error('spawn ENOMEM (test hook)');
    this.proc = fork(CHILD, [], {
      execArgv: ['--max-old-space-size=160'],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      env: childEnv(),
    });
    let exit!: () => void;
    this.exited = new Promise((resolve) => { exit = resolve; });
    const end = () => { this.died(); exit(); };
    this.proc.on('message', (m: ChildReply | ChildStrip) => ('strip' in m ? this.strip(m) : this.answer(m)));
    // A child that could not be spawned never emits 'exit': it ends here, so the slot is not held forever.
    this.proc.on('error', () => (this.proc.pid === undefined ? end() : this.kill(new UploadError('UNREADABLE', UNREADABLE))));
    this.proc.once('exit', end);
    this.poll = setInterval(() => {
      const rss = this.proc.pid === undefined ? undefined : pdfChildTestHooks.rss(this.proc.pid);
      if (rss !== undefined && rss > PDF_CHILD_MAX_RSS_BYTES) this.kill(new UploadError('TOO_LARGE', TOO_HUNGRY));
    }, RSS_POLL_MS);
  }

  call(msg: ChildRequest, timeoutMs: number): Promise<unknown> {
    if (this.death) return Promise.reject(this.death);
    if (this.pending) return Promise.reject(new Error('one PDF request at a time'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.kill(new UploadError('UNREADABLE', TOO_SLOW)), timeoutMs);
      this.pending = { resolve, reject, timer };
      try {
        this.proc.send(msg);
      } catch {
        this.kill(new UploadError('UNREADABLE', UNREADABLE));
      }
    });
  }

  /** SIGKILL (the child is not asked: it may be stuck), remembering why for the request in flight. */
  kill(reason: UploadError): void {
    this.killedFor ??= reason;
    if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill('SIGKILL');
  }

  /** Rows of a page being rendered, copied into the page buffer (allocated once, at the size the first strip gives). */
  private strip(m: ChildStrip): void {
    const p = this.pending;
    if (!p) return;
    const size = m.width * m.height * 4;
    if (!p.rgba && Number.isInteger(size) && size > 0 && size <= PDF_MAX_PAGE_PIXELS * 4) p.rgba = new Uint8Array(size);
    const at = m.y * m.width * 4;
    if (!p.rgba || p.rgba.length !== size || !(m.rgba instanceof Uint8Array) || at < 0 || at + m.rgba.length > size) {
      this.kill(new UploadError('UNREADABLE', UNREADABLE));
      return;
    }
    p.rgba.set(m.rgba, at);
  }

  private answer(m: ChildReply): void {
    const p = this.pending;
    if (!p) return;
    this.pending = undefined;
    clearTimeout(p.timer);
    pdfChildTestHooks.networkAttempts = m.net;
    if (!m.ok) p.reject(fromChild(m.error));
    else if (p.rgba) p.resolve({ ...(m.result as object), rgba: p.rgba });
    else p.resolve(m.result);
  }

  private died(): void {
    if (this.death) return;
    clearInterval(this.poll);
    this.death = this.killedFor ?? new UploadError('UNREADABLE', UNREADABLE);
    const p = this.pending;
    this.pending = undefined;
    if (p) {
      clearTimeout(p.timer);
      p.reject(this.death);
    }
  }
}

export interface PdfSessionOptions {
  /** Each call (open, render, hint) and the idle time between calls (default PDF_PAGE_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Each render, when shorter than `timeoutMs` (thumbnails: PDF_THUMB_TIMEOUT_MS). */
  renderTimeoutMs?: number;
  /** The whole session, from its child's start (default PDF_SESSION_BUDGET_MS): past it the child is killed (OVER_BUDGET). */
  budgetMs?: number;
}

/**
 * Open a PDF in a fresh child, holding the image slot until `close()` (or a refusal, or PDF_PAGE_TIMEOUT_MS without a
 * call, or the session budget) so several pages are rendered from one parse. Too large, encrypted, broken or empty
 * files are refused here.
 */
export function openPdfSession(bytes: Uint8Array, o: PdfSessionOptions = {}): Promise<PdfSession> {
  if (bytes.byteLength > PDF_MAX_BYTES) return Promise.reject(new UploadError('TOO_LARGE', TOO_BIG));
  if (!looksLikePdf(bytes)) return Promise.reject(new UploadError('UNREADABLE', UNREADABLE));
  const timeoutMs = o.timeoutMs ?? PDF_PAGE_TIMEOUT_MS;
  const renderTimeoutMs = Math.min(timeoutMs, o.renderTimeoutMs ?? timeoutMs);
  const budgetMs = o.budgetMs ?? PDF_SESSION_BUDGET_MS;
  return new Promise((resolveSession, rejectSession) => {
    oneImageAtATime(async () => {
      // Inside the slot no OCR runs (it takes the slot too): the worker is stopped, never resident beside the child.
      await closeOcr();
      let reader: Reader;
      try {
        reader = new Reader();
      } catch (e) {
        // Nothing was started: refuse and free the slot.
        rejectSession(new UploadError('UNREADABLE', CANNOT_START, { cause: e }));
        return;
      }
      const budget = setTimeout(() => reader.kill(new UploadError('UNREADABLE', OVER_BUDGET)), budgetMs);
      void reader.exited.then(() => clearTimeout(budget));
      let closed = false;
      let idle: NodeJS.Timeout | undefined;
      const close = async () => {
        closed = true;
        clearTimeout(idle);
        reader.kill(new UploadError('UNREADABLE', 'The PDF session is closed'));
        await reader.exited;
      };
      /** One request at a time; a refusal or a death ends the session. */
      let queue: Promise<unknown> = Promise.resolve();
      const run = <T>(msg: ChildRequest, callMs = timeoutMs): Promise<T> => {
        const job = queue.then(async () => {
          clearTimeout(idle);
          try {
            return (await reader.call(msg, callMs)) as T;
          } catch (e) {
            await close();
            throw e;
          } finally {
            if (!closed) {
              idle = setTimeout(() => void close(), timeoutMs);
              idle.unref();
            }
          }
        });
        queue = job.catch(() => {});
        return job;
      };
      try {
        const { pages } = await run<{ pages: number }>({ op: 'open', bytes, test: pdfChildTestHooks.onOpen });
        resolveSession({
          pages,
          render: (page, dpi) =>
            dpi > 0 && Number.isFinite(dpi) ? run<RenderedPage>({ op: 'render', page, dpi }, renderTimeoutMs) : Promise.reject(new RangeError('dpi must be a positive number')),
          hint: (page) => (pdfChildTestHooks.hintReads++, run<string[]>({ op: 'hint', page })),
          close,
        });
      } catch (e) {
        rejectSession(e);
      }
      // The slot is held until the child has really stopped.
      await reader.exited;
    }).catch((e: unknown) => rejectSession(e)); // never an unhandled rejection: a late one after settling is a no-op
  });
}

/** A PDF starts with `%PDF-` within its first 1024 bytes (readers tolerate leading junk up to there). */
function looksLikePdf(b: Uint8Array): boolean {
  return Buffer.from(b.buffer, b.byteOffset, Math.min(b.byteLength, 1024)).toString('latin1').includes('%PDF-');
}

async function once<T>(bytes: Uint8Array, o: PdfSessionOptions, work: (s: PdfSession) => Promise<T>): Promise<T> {
  const s = await openPdfSession(bytes, o);
  try {
    return await work(s);
  } finally {
    await s.close();
  }
}

/** The number of pages, refusing what cannot be used (too large, encrypted, unreadable, empty). */
export function inspectPdf(bytes: Uint8Array, o: PdfSessionOptions = {}): Promise<{ pages: number }> {
  return once(bytes, o, async (s) => ({ pages: s.pages }));
}

/** One page, in its own session: see `PdfSession.render`. */
export function renderPage(bytes: Uint8Array, page: number, dpi: number, o: PdfSessionOptions = {}): Promise<RenderedPage> {
  return once(bytes, o, (s) => s.render(page, dpi));
}

/** One page's text layer, in its own session: see `PdfSession.hint`. */
export function pageTextHint(bytes: Uint8Array, page: number, o: PdfSessionOptions = {}): Promise<string[]> {
  return once(bytes, o, (s) => s.hint(page));
}
