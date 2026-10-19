/**
 * The HTTP routes of merchant evidence uploads, for the seller's workspace (local mode: the operator):
 *
 *   POST   /api/cases/:id/uploads                  image/png | image/jpeg | application/pdf (raw, `x-upload-name`) or
 *                                                   JSON { text, name }; a PDF of up to 5 pages is selected whole and
 *                                                   its job starts, a longer one waits for a selection (thumbnails)
 *   GET    /api/cases/:id/uploads                  this workspace's uploads of the case and its active dispute
 *   GET    /api/cases/:id/uploads/:u/image?v=…     original (pending/reviewing, people who can edit it) | sanitised
 *   POST   /api/cases/:id/uploads/:u/select        { pages }: 1–5 pages of a PDF, once, while selecting → its job starts
 *   GET    /api/cases/:id/uploads/:u/page/:k?v=…   page k of the selection: original (the uncovered render, as for
 *                                                   an image's original) | sanitised
 *   GET    /api/cases/:id/uploads/:u/page/:k/hint  { lines }: page k's PDF text layer, a hint while it is reviewed
 *                                                   (people who can edit it), read from the original, never stored
 *   GET    /api/cases/:id/uploads/:u/thumb/:n      thumbnail of page n of the PDF, while selecting
 *   POST   /api/cases/:id/uploads/:u/redact        { rects } | { removals } → sanitised file, re-read from it;
 *                                                   a PDF: { page, rects } → that page covered, re-read from it
 *   POST   /api/cases/:id/uploads/:u/confirm       { lines, sha256 } → E<n>, the original dropped; a PDF: { pages:
 *                                                   [{ lines, added, sha256 }] } → its PDF rebuilt from the covered
 *                                                   pages, the original and uncovered renders dropped
 *   POST   /api/cases/:id/uploads/:u/discard       before confirmation: files removed
 *   DELETE /api/cases/:id/uploads/:u               owners and full members: files removed; refused while a send
 *                                                   using it (attached or in its input) is in flight, voids the unsent
 *                                                   intents using it and purges the analyses that read it
 *
 * Nothing of an upload leaves this server here: OCR is local, nothing is sent to PayPal or a model. Audit details and
 * log lines carry ids (and an error code) only, never file names, text or bytes. A pending upload past its expiry is discarded the
 * first time a route meets it.
 *
 * A refusal given before any decoding or OCR carries the {@link REFUSED_EARLY} header: hosted mode gives the address
 * its upload slot back for those only (and strips the header). Work once started is never refunded.
 */
import { createHash } from 'node:crypto';
import type { ActingPerson, Reservation } from '../app.ts';
import { CASE_FILES } from '../documents.ts';
import type { AuditEvent } from '../intents.ts';
import { uploadDocuments, uploadTitle } from './documents.ts';
import { UploadError, coverImage, oneImageAtATime, sanitiseImage, type Rect } from './image.ts';
import { MAX_FILE_BYTES, MAX_REDACTS_PER_PAGE, MAX_STORAGE_BYTES, MAX_STORED_BYTES, MAX_TEXT_CHARS, MAX_UPLOADS_PER_CASE, PDF_MAX_BYTES, PDF_MAX_PAGES, PDF_MAX_SELECTED, PDF_RENDER_DPI, sizeLimitText } from './limits.ts';
import { ocrPng } from './ocr.ts';
import { CANNOT_START, OVER_BUDGET, TOO_BIG, TOO_SLOW, inspectPdf, pageTextHint } from './pdf-input.ts';
import { coveredPagesPdf, type PdfJob } from './pdf-job.ts';
import { canDeleteUpload, canEditUpload } from './permissions.ts';
import type { PdfPage, PdfState, UploadPatch, UploadRecord, UploadStatus, UploadStore } from './store.ts';
import { pastedTextPdf, redactText, textLines, type TextRemoval } from './text.ts';

/** The one route that takes a raw file body; group 1 is the case id (node.ts sizes its body limit with it). */
export const UPLOAD_PATH = /^\/api\/cases\/([A-Za-z0-9-]{1,64})\/uploads$/;
/** A redaction (each one runs OCR): metered per address like an upload. */
export const REDACT_PATH = /^\/api\/cases\/[A-Za-z0-9-]{1,64}\/uploads\/upl-[0-9a-f]{24}\/redact$/;
/** A PDF page's text hint (a pdf.js read of the original when not cached): metered per address like a read. */
export const HINT_PATH = /^\/api\/cases\/[A-Za-z0-9-]{1,64}\/uploads\/upl-[0-9a-f]{24}\/page\/[^/]*\/hint$/;

/**
 * The text hints read in this review, by `<upload id>/<page>`: in memory only (never on disk, never logged, lost on
 * a restart), so each page's text layer is read at most once per review. Dropped when the upload is confirmed,
 * discarded, deleted or expires, and on the next hint once it is no longer in review (failed, archived).
 */
const hints = new Map<string, Promise<string[]>>();
const forgetHints = (uploadId: string) => {
  for (const key of hints.keys()) if (key.startsWith(`${uploadId}/`)) hints.delete(key);
};
/** Tests: how many pages of an upload have a hint kept. */
export const hintCacheSize = (uploadId: string): number => [...hints.keys()].filter((k) => k.startsWith(`${uploadId}/`)).length;
/** Set on a refusal given before any decoding or OCR (internal: hosted.ts strips it). */
export const REFUSED_EARLY = 'x-rk-refused-early';
/** Redactions per upload. */
export const MAX_REDACTS = 5;
/**
 * Groups 4 and 5: `page` or `thumb` and its number as sent, checked by the route (400), never trusted by the pattern;
 * group 6: `/hint` after it.
 */
const ROUTE = /^\/api\/cases\/([A-Za-z0-9-]{1,64})\/uploads(?:\/(upl-[0-9a-f]{24})(?:\/(image|redact|confirm|discard|select)|\/(page|thumb)\/([^/]*)(\/hint)?)?)?$/;
const IMAGE_TYPES = ['image/png', 'image/jpeg'];
const PDF_TYPE = 'application/pdf';

const mediaType = (contentType: string | null) => (contentType ?? '').split(';')[0]!.trim().toLowerCase();

/** image/png or image/jpeg. */
export const isImageType = (contentType: string | null): boolean => IMAGE_TYPES.includes(mediaType(contentType));
/** application/pdf. */
export const isPdfType = (contentType: string | null): boolean => mediaType(contentType) === PDF_TYPE;

/** Whether a request may carry a file body: POST to the upload route with image/png, image/jpeg or application/pdf. */
export function acceptsFileBody(method: string, path: string, contentType: string | null): boolean {
  return method === 'POST' && UPLOAD_PATH.test(path) && (isImageType(contentType) || isPdfType(contentType));
}

/** A page or thumbnail number as written in a path: 1..PDF_MAX_PAGES, digits only, no leading zero; else null. */
const pageNumber = (raw: string): number | null => (/^[1-9]\d{0,2}$/.test(raw) && Number(raw) <= PDF_MAX_PAGES ? Number(raw) : null);

export interface UploadRoutesOptions {
  store: UploadStore;
  /** The person acting; null when signed out. */
  person: (req: Request) => ActingPerson | null;
  /** Whether this request may address the case at all (false: UNKNOWN_CASE). Hosted: the seller's workspace only. */
  caseVisible: (req: Request, caseId: string) => Promise<boolean>;
  /** Hosted: reserve one of the day's `upload` units (seller workspace, cap, caps file). null: no cap (local mode). */
  reserve: ((req: Request) => Reservation) | null;
  /** The case's active PayPal dispute id, or null for a simulated case. */
  caseBinding: (caseId: string) => string | null;
  /** The audit trail (intents.record). */
  record: (e: Omit<AuditEvent, 'at'>) => void;
  log: (line: string) => void;
  now?: () => Date;
  /** Total size of stored upload files (default MAX_STORAGE_BYTES). */
  maxStorageBytes?: number;
  /** Size of one stored (sanitised) file (default MAX_STORED_BYTES). */
  maxStoredBytes?: number;
  /**
   * The submission intents using an upload (attaching it, or composed from an input containing it): whether one is
   * being sent right now (deleting it waits for the outcome), and invalidating the unsent ones when it is deleted.
   * Absent: none.
   */
  attachedTo?: { sending(uploadId: string): boolean; invalidate(rec: UploadRecord, actor: string): void };
  /**
   * Deleting an upload forgets what quotes it: the analyses (by key) that read it, whatever hangs from them (running
   * job, progress, re-check verdicts), and the case's pinned input. May throw if a stored file cannot be removed.
   */
  purge?: (analysisKeys: string[], caseId: string, uploadId: string) => void;
  /** Renders and reads PDF uploads in the background. Absent: PDFs are refused (415). */
  pdfJob?: Pick<PdfJob, 'start'> | null;
  /**
   * Hosted: count `pages` page reads against the address's upload limit, all or none (a redaction is one). Called
   * before a PDF's pages are chosen for reading; a refusal is answered as it is. Absent: not metered (local mode).
   */
  meterPages?: ((req: Request, pages: number) => Reservation) | null;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const refuse = (status: number, error: string, detail?: string) => json(status, { error, ...(detail ? { detail } : {}) });

/** Uploads that count towards the per-case limit and are shown in the case. */
const SHOWN: UploadStatus[] = ['pending', 'reviewing', 'confirmed'];
const EDITABLE: UploadStatus[] = ['pending', 'reviewing'];
const DEAD: UploadStatus[] = ['discarded', 'deleted'];
const MAX_ITEMS = 200;
const MAX_LINE = 1000;
const MAX_NAME = 120;

/** Control characters (tab and line feed excepted), C1 controls and bidi overrides: replaced by a space in pasted text. */
const STRAY = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
/** Outside Latin-1 (U+0000–U+00FF): the PDF PayPal receives cannot show it, while the analyst would quote it. */
const NOT_LATIN1 = /[^\u0000-\u00ff]/u;

/** The refusal of pasted text with a character outside Latin-1, naming the first one (never the text around it). */
function notLatin1(text: string): Response | null {
  const m = NOT_LATIN1.exec(text);
  if (!m) return null;
  const c = m[0];
  const code = `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
  return refuse(422, 'TEXT_UNSUPPORTED', `The text has “${c}” (${code}), which the PDF sent to PayPal cannot show: only Latin-1 characters (Western European letters and accents) can be pasted. Replace it (for example € with EUR, curly quotes with straight ones) and paste again.`);
}

/** In a confirmed line, also no line break (a tab stays, as in pasted text). */
const LINE_STRAY = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

/**
 * The record as the web app sees it (no workspace id, no analysis keys, no counters), with the analyst's document of a
 * confirmed upload (exactly what the analysis reads: lines, fragment keys, corrections), null before confirmation.
 * Until it is confirmed, someone who cannot edit it sees only that it exists (`restricted`): who added what kind of
 * file when, and where its job is; nothing it shows or reads.
 */
function view(r: UploadRecord, viewer: ActingPerson) {
  if (EDITABLE.includes(r.status) && !canEditUpload(viewer, r)) {
    const { id, kind, name, uploadedBy, status, createdAt, expiresAt, pdf } = r;
    const pdfView = pdf ? { pdf: { pageCount: pdf.pageCount, selected: pdf.selected, job: pdf.job } } : {};
    return { id, kind, name, uploadedBy, status, createdAt, expiresAt, ...pdfView, restricted: true as const };
  }
  const { workspaceId: _w, analysisKeys: _a, redactions: _r, pdf, ...v } = r;
  // A PDF's pages without their counters and render dpi; the text layer is never part of the record.
  const pdfView = pdf ? { pdf: { pageCount: pdf.pageCount, selected: pdf.selected, pages: pdf.pages.map(({ redactions: _n, dpi: _d, ...p }) => p), job: pdf.job } } : {};
  return { ...v, ...pdfView, document: uploadDocuments([r])[0] ?? null };
}

/** A refusal from a cap or a limit, with its Retry-After header when it says when to retry. */
function capRefusal(r: { status: number; body: unknown }): Response {
  const res = json(r.status, r.body);
  const after = isObject(r.body) ? r.body.retryAfterSec : undefined;
  if (typeof after === 'number' && Number.isSafeInteger(after) && after > 0) res.headers.set('retry-after', String(after));
  return res;
}

/** A stored image (PNG or, for a covered photo, JPEG; an original may be either), never cached, never sniffed. */
function imageResponse(bytes: Uint8Array): Response {
  const type = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : 'image/png';
  return new Response(bytes as BodyInit, { status: 200, headers: { 'content-type': type, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-disposition': 'inline' } });
}

/** A page of the selection before it is rendered: nothing covered, read or added yet. */
const freshPage = (original: number): PdfPage => ({ original, rects: [], readLines: [], lines: [], added: [], sha256: null, redactions: 0, dpi: PDF_RENDER_DPI });

/** A file name to show: the last path segment, without control characters, at most 120 characters. */
function cleanName(raw: unknown, fallback: string): string {
  let s = typeof raw === 'string' ? raw : '';
  try {
    s = decodeURIComponent(s);
  } catch {
    /* as sent */
  }
  s = (s.split(/[\\/]/).pop() ?? '').replace(STRAY, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
  return s || fallback;
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function parseRects(v: unknown): Rect[] | null {
  if (!Array.isArray(v) || v.length > MAX_ITEMS) return null;
  const out: Rect[] = [];
  for (const r of v) {
    if (!isObject(r) || !isCount(r.x) || !isCount(r.y) || !isCount(r.w) || !isCount(r.h)) return null;
    out.push({ x: r.x, y: r.y, w: r.w, h: r.h });
  }
  return out;
}

function parseRemovals(v: unknown): TextRemoval[] | null {
  if (!Array.isArray(v) || v.length > MAX_ITEMS) return null;
  const out: TextRemoval[] = [];
  for (const r of v) {
    if (!isObject(r) || !isCount(r.start) || !isCount(r.end)) return null;
    out.push({ start: r.start, end: r.end });
  }
  return out;
}

/** A PDF whose pages are rendered and read, and not confirmed yet: its pages can be covered, hinted and confirmed. */
type PdfUpload = UploadRecord & { pdf: PdfState };
const inReview = (r: UploadRecord): r is PdfUpload => !!r.pdf && EDITABLE.includes(r.status) && r.pdf.job.state === 'reviewing';

/** Width and height of a stored page image, from its header: trusted for PNGs this server wrote, never client bytes. */
function pngSize(png: Uint8Array): { width: number; height: number } {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

/** Whether two areas share a positive area: edges that only touch, or an empty cover, do not. */
const overlaps = (a: Rect, b: Rect) => b.w > 0 && b.h > 0 && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The refusal of a transcribed line read from under a cover (Review Focus 4). */
const FROM_COVER = 'A transcribed line cannot come from a covered area.';

/** One page of a PDF confirmation as sent: its lines, its transcribed lines and the hash of the page reviewed. */
type PageConfirmation = { lines: string[]; added: { area: Rect; text: string }[]; sha256: string };

const isLine = (l: unknown): l is string => typeof l === 'string' && l.length <= MAX_LINE && !LINE_STRAY.test(l);

/** The shape of a PDF confirmation (types and sizes only; the line rules of transcriptions are checked later, 422). */
function parsePageConfirmations(v: unknown): PageConfirmation[] | Response {
  const shape = () => refuse(400, 'BAD_CONFIRMATION', `pages: one { lines, added, sha256 } per selected page, in order; added: up to ${MAX_ITEMS} { area: { x, y, w, h }, text }`);
  if (!Array.isArray(v) || v.length < 1 || v.length > PDF_MAX_SELECTED) return shape();
  const out: PageConfirmation[] = [];
  for (const p of v) {
    if (!isObject(p) || typeof p.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(p.sha256) || !Array.isArray(p.added) || p.added.length > MAX_ITEMS) return shape();
    if (!Array.isArray(p.lines) || !p.lines.every(isLine)) {
      return refuse(400, 'BAD_LINES', `lines: one string per line, up to ${MAX_LINE} characters, without line breaks or control characters`);
    }
    const added: PageConfirmation['added'] = [];
    for (const a of p.added) {
      const area = isObject(a) ? parseRects([a.area]) : null;
      if (!area || !isObject(a) || typeof a.text !== 'string') return shape();
      added.push({ area: area[0]!, text: a.text });
    }
    out.push({ lines: p.lines, added, sha256: p.sha256 });
  }
  return out;
}

const evidenceNumber = (id: string | null) => Number(/^E(\d+)$/.exec(id ?? '')?.[1] ?? 0);

async function readJson(req: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await req.json() };
  } catch {
    return { ok: false };
  }
}

/** What the person is acting in: their workspace, the case and the dispute active now; and whether work started. */
interface Scope {
  caseId: string;
  person: ActingPerson;
  disputeId: string | null;
  /** Decoding or OCR has run for this request: from here on, nothing is refunded. */
  worked: boolean;
}

export function createUploadRoutes(o: UploadRoutesOptions): (req: Request, url: URL) => Promise<Response | null> {
  const now = o.now ?? (() => new Date());
  const maxStorage = o.maxStorageBytes ?? MAX_STORAGE_BYTES;
  const maxStored = o.maxStoredBytes ?? MAX_STORED_BYTES;
  const { store } = o;

  const audit = (s: Scope, kind: AuditEvent['kind'], r: UploadRecord) =>
    o.record({ caseId: s.caseId, kind, actor: s.person.label, team: s.person.workspaceId, disputeId: s.disputeId, detail: [r.id, r.evidenceId].filter(Boolean).join(' · ') });

  /** A pending or reviewing upload past its expiry is discarded now (files and text purged); null then. */
  const unlessExpired = (r: UploadRecord): UploadRecord | null => {
    if (!EDITABLE.includes(r.status) || r.expiresAt > now().toISOString()) return r;
    store.update(r.id, { status: 'discarded' });
    forgetHints(r.id);
    o.record({ caseId: r.caseId, kind: 'upload_discarded', actor: 'ResolveKit (expired)', team: r.workspaceId, disputeId: r.boundDisputeId, detail: `${r.id} · expired` });
    return null;
  };
  /** The uploads shown in the case for this workspace and dispute (expired ones discarded on the way). */
  const shown = (s: Scope) =>
    store
      .list({ workspaceId: s.person.workspaceId, caseId: s.caseId, boundDisputeId: s.disputeId, statuses: SHOWN })
      .map(unlessExpired)
      .filter((r): r is UploadRecord => r !== null);

  const tooMany = () => refuse(409, 'TOO_MANY_UPLOADS', `A case takes at most ${MAX_UPLOADS_PER_CASE} uploads; discard or delete one first`);
  const storageFull = () => refuse(507, 'STORAGE_FULL', 'The demo has no room for more uploads right now');
  const hasRoom = (bytes: number) => store.usedBytes() + bytes <= maxStorage;
  const megabytes = sizeLimitText(maxStored);
  /** A sanitised file over the per-file limit: 413 with what the person can do. */
  const tooBig = (kind: UploadRecord['kind']) =>
    refuse(413, 'TOO_LARGE', kind === 'image'
      ? `Once cleaned, this image is larger than ${megabytes}, the most a stored file can be; upload a screenshot or a smaller image`
      : `Once cleaned, this text is larger than ${megabytes}, the most a stored file can be; paste a shorter text`);
  const archived = (s: Scope, r: UploadRecord) => r.status === 'archived' || r.boundDisputeId !== s.disputeId;
  const archivedRefusal = () => refuse(409, 'UPLOAD_ARCHIVED', 'The case moved to another PayPal dispute since this was uploaded; upload it again for the current one');

  /**
   * POST /uploads with a PDF: its pages counted (refused when too large, encrypted or unreadable), then stored with
   * its job state. Up to PDF_MAX_SELECTED pages are all selected and read now; a longer one waits for a selection.
   */
  const addPdf = async (req: Request, s: Scope): Promise<Response> => {
    if (!o.pdfJob) return refuse(415, 'UNSUPPORTED_TYPE', 'Upload a PNG or JPEG image, or paste text');
    const original = new Uint8Array(await req.arrayBuffer());
    if (original.length > PDF_MAX_BYTES) return refuse(413, 'TOO_LARGE', TOO_BIG);
    const name = cleanName(req.headers.get('x-upload-name'), 'document.pdf');
    if (shown(s).length >= MAX_UPLOADS_PER_CASE) return tooMany();
    if (!hasRoom(original.length)) return storageFull();
    const reserved = o.reserve?.(req) ?? null;
    if (reserved && !reserved.ok) return json(reserved.refusal.status, reserved.refusal.body);

    // From here on the day's unit is spent, whatever happens: the file is parsed (in the PDF reader's child).
    s.worked = true;
    let pageCount: number;
    try {
      pageCount = (await inspectPdf(original)).pages;
    } catch (e) {
      // The reader could not start: nothing was read, try again later.
      if (e instanceof UploadError && e.message === CANNOT_START) {
        if (reserved?.ok) reserved.release();
        return refuse(503, 'PDF_READER_UNAVAILABLE', e.message);
      }
      // Encrypted or not a readable PDF: the file is the problem, not the request's type.
      if (e instanceof UploadError && e.code === 'UNREADABLE') return refuse(422, e.code, e.message);
      throw e;
    }
    // Checked again in the same synchronous step as storing: concurrent uploads cannot pass the limits.
    if (shown(s).length >= MAX_UPLOADS_PER_CASE) return tooMany();
    if (!hasRoom(original.length)) return storageFull();
    const whole = pageCount <= PDF_MAX_SELECTED;
    // Every page read counts once: the upload itself is the first (as an image's is its reading), the others here.
    const metered = whole && pageCount > 1 ? (o.meterPages?.(req, pageCount - 1) ?? null) : null;
    if (metered && !metered.ok) {
      // No page was read and nothing is stored: the day's unit goes back (the parsing is the address's to pay).
      if (reserved?.ok) reserved.release();
      return capRefusal(metered.refusal);
    }
    const selected = whole ? Array.from({ length: pageCount }, (_, i) => i + 1) : null;
    const pdf = {
      pageCount,
      selected,
      pages: (selected ?? []).map(freshPage),
      job: whole ? { state: 'rendering' as const, page: 0, of: pageCount } : { state: 'selecting' as const, page: 0, of: pageCount },
    };
    let rec: UploadRecord;
    try {
      const created = store.create({ workspaceId: s.person.workspaceId, caseId: s.caseId, boundDisputeId: s.disputeId, kind: 'pdf', name, uploadedBy: { id: s.person.id, label: s.person.label, name: s.person.name } }, original);
      try {
        rec = store.update(created.id, { pdf });
      } catch (e) {
        try { store.update(created.id, { status: 'discarded' }); } catch { /* the sweep drops what is left */ }
        throw e;
      }
    } catch (e) {
      // No page was read.
      if (metered?.ok) metered.release();
      throw e;
    }
    audit(s, 'upload_added', rec);
    o.pdfJob.start(rec.id);
    return json(201, { upload: view(rec, s.person) });
  };

  /** POST /uploads: an image or a PDF (raw body) or pasted text (JSON). Limits and the day's unit are checked before any work. */
  const add = async (req: Request, s: Scope): Promise<Response> => {
    const type = mediaType(req.headers.get('content-type'));
    const declared = Number(req.headers.get('content-length') ?? '');
    if (type === PDF_TYPE) {
      if (Number.isFinite(declared) && declared > PDF_MAX_BYTES) return refuse(413, 'TOO_LARGE', TOO_BIG);
      return addPdf(req, s);
    }
    if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) return refuse(413, 'TOO_LARGE', `Files up to ${sizeLimitText(MAX_FILE_BYTES)}`);
    let kind: UploadRecord['kind'];
    let original: Uint8Array;
    let name: string;
    let text: string | null = null;
    if (isImageType(type)) {
      original = new Uint8Array(await req.arrayBuffer());
      if (original.length > MAX_FILE_BYTES) return refuse(413, 'TOO_LARGE', `Files up to ${sizeLimitText(MAX_FILE_BYTES)}`);
      kind = 'image';
      name = cleanName(req.headers.get('x-upload-name'), type === 'image/png' ? 'image.png' : 'image.jpg');
    } else if (type === 'application/json') {
      const parsed = await readJson(req);
      if (!parsed.ok) return refuse(400, 'INVALID_JSON');
      const b = parsed.body;
      if (!isObject(b) || typeof b.text !== 'string' || (b.name !== undefined && typeof b.name !== 'string')) return refuse(400, 'INVALID_UPLOAD', 'The body must be { "text": "…", "name": "…" }');
      text = b.text.replace(/\r\n?/g, '\n').replace(STRAY, ' ');
      if (!text.trim()) return refuse(400, 'EMPTY_TEXT', 'There is no text to add');
      if (text.length > MAX_TEXT_CHARS) return refuse(413, 'TOO_LONG', `Pasted text up to ${MAX_TEXT_CHARS} characters`);
      const unsupported = notLatin1(text);
      if (unsupported) return unsupported;
      original = new TextEncoder().encode(text);
      kind = 'text';
      name = cleanName(b.name, 'pasted text');
    } else {
      return refuse(415, 'UNSUPPORTED_TYPE', 'Upload a PNG or JPEG image or a PDF, or paste text');
    }
    if (shown(s).length >= MAX_UPLOADS_PER_CASE) return tooMany();
    if (!hasRoom(original.length)) return storageFull();
    const reserved = o.reserve?.(req) ?? null;
    if (reserved && !reserved.ok) return json(reserved.refusal.status, reserved.refusal.body);

    // From here on the day's unit is spent, whatever happens.
    let readLines: string[];
    if (kind === 'image') {
      s.worked = true;
      // Decoded once (type by magic bytes, size checked first), one image at a time server-wide, and re-encoded as a
      // PNG: what OCR sees is pixels only. The text goes back to the person only; it is not stored.
      readLines = await oneImageAtATime(async () => (await ocrPng(sanitiseImage(original, []).png)).map((l) => l.text));
      // Checked again in the same synchronous step as storing: concurrent uploads cannot pass the limits.
      if (shown(s).length >= MAX_UPLOADS_PER_CASE) return tooMany();
      if (!hasRoom(original.length)) return storageFull();
    } else {
      readLines = textLines(text!);
    }
    let rec: UploadRecord;
    try {
      rec = store.create({ workspaceId: s.person.workspaceId, caseId: s.caseId, boundDisputeId: s.disputeId, kind, name, uploadedBy: { id: s.person.id, label: s.person.label, name: s.person.name } }, original);
    } catch (e) {
      // Pasted text did no work worth a unit; an image's decode and OCR did.
      if (!s.worked && reserved?.ok) reserved.release();
      throw e;
    }
    audit(s, 'upload_added', rec);
    return json(201, { upload: view(rec, s.person), readLines });
  };

  /** POST /redact: the sanitised file, then its text read again from that file (never derived from the original's). */
  const redact = async (req: Request, s: Scope, rec: UploadRecord): Promise<Response> => {
    if (!canEditUpload(s.person, rec)) return refuse(403, 'FORBIDDEN', 'A reviewer edits only their own uploads');
    if (archived(s, rec)) return archivedRefusal();
    if (!EDITABLE.includes(rec.status)) return refuse(409, 'WRONG_STATUS', `This upload is ${rec.status}`);
    const parsed = await readJson(req);
    if (!parsed.ok) return refuse(400, 'INVALID_JSON');
    const b = isObject(parsed.body) ? parsed.body : {};
    const rects = rec.kind === 'image' && b.removals === undefined ? parseRects(b.rects) : null;
    const removals = rec.kind === 'text' && b.rects === undefined ? parseRemovals(b.removals) : null;
    if (rec.kind === 'image' && !rects) return refuse(400, 'BAD_REDACTION', `rects: up to ${MAX_ITEMS} areas { x, y, w, h } in whole pixels`);
    if (rec.kind === 'text' && !removals) return refuse(400, 'BAD_REDACTION', `removals: up to ${MAX_ITEMS} spans { start, end }`);
    // Read again: another redact may have counted while this body was read.
    const done = store.get(rec.id)?.redactions ?? 0;
    if (done >= MAX_REDACTS) return refuse(409, 'TOO_MANY_REDACTS', `An upload can be redacted ${MAX_REDACTS} times; discard it and upload it again`);
    const original = store.original(rec.id);
    if (!original) return refuse(404, 'NOT_FOUND', 'The original of this upload is gone');
    // Counted before the work, so failed attempts count too.
    store.update(rec.id, { redactions: done + 1 });
    s.worked = true;

    let patch: UploadPatch;
    let file: Uint8Array;
    if (rects) {
      // Decoded once, one image at a time server-wide; the text is read again from the sanitised file (a PNG, or a
      // JPEG for a JPEG photo: as a lossless PNG a camera photo can outgrow the stored-file limit).
      const read = await oneImageAtATime(async () => {
        const s1 = coverImage(original, rects);
        if (s1.file.length > maxStored) return tooBig('image');
        if (!hasRoom(s1.file.length)) return storageFull();
        return { s1, readLines: (await ocrPng(s1.file)).map((l) => l.text) };
      });
      if (read instanceof Response) return read;
      const { s1, readLines } = read;
      patch = { status: 'reviewing', rects, removals: [], readLines, sha256: s1.sha256, size: s1.file.length, mime: s1.mime };
      file = s1.file;
    } else {
      const lines = textLines(redactText(new TextDecoder().decode(original), removals!));
      const doc = pastedTextPdf({ title: uploadTitle('text'), by: rec.uploadedBy.name.slice(0, 80), lines });
      if (doc.pdf.length > maxStored) return tooBig('text');
      if (!hasRoom(doc.pdf.length)) return storageFull();
      patch = { status: 'reviewing', rects: [], removals: removals!, readLines: lines, sha256: doc.sha256, size: doc.pdf.length, mime: 'application/pdf' };
      file = doc.pdf;
    }
    // Someone may have discarded, deleted or confirmed it while OCR ran.
    const cur = store.get(rec.id);
    if (!cur || !EDITABLE.includes(cur.status) || archived(s, cur)) return refuse(409, 'UPLOAD_CHANGED', 'This upload changed while it was being read; open it again');
    const next = store.update(rec.id, patch, { sanitised: file });
    audit(s, 'upload_redacted', next);
    return json(200, { upload: view(next, s.person), readLines: next.readLines });
  };

  /** A PDF that is not in review: why (its job failed, it is still being read, or it is not editable any more). */
  const notInReview = (r: UploadRecord): Response =>
    r.pdf?.job.state === 'failed' ? refuse(409, 'JOB_FAILED', r.pdf.job.error ?? 'Reading this PDF failed. Discard it and upload it again.')
      : EDITABLE.includes(r.status) ? refuse(409, 'WRONG_STATUS', 'The pages of this PDF are not read yet; wait until they are')
        : refuse(409, 'WRONG_STATUS', `This upload is ${r.status}`);
  const changed = () => refuse(409, 'UPLOAD_CHANGED', 'This upload changed meanwhile; open it again');

  /**
   * POST /redact on a PDF: { page, rects }. Page k is covered again from its uncovered render (never from a covered
   * one), stored as its sanitised page and read again from that page; its corrections and transcriptions start over.
   * At most MAX_REDACTS_PER_PAGE attempts per page; each one is one read in the per-address limit (REDACT_PATH).
   */
  const redactPdf = async (req: Request, s: Scope, rec: UploadRecord): Promise<Response> => {
    if (!canEditUpload(s.person, rec)) return refuse(403, 'FORBIDDEN', 'A reviewer edits only their own uploads');
    if (archived(s, rec)) return archivedRefusal();
    if (!inReview(rec)) return notInReview(rec);
    const parsed = await readJson(req);
    if (!parsed.ok) return refuse(400, 'INVALID_JSON');
    const b = isObject(parsed.body) ? parsed.body : {};
    const k = b.page;
    const rects = b.removals === undefined ? parseRects(b.rects) : null;
    if (typeof k !== 'number' || !Number.isInteger(k) || k < 1 || k > rec.pdf.pages.length || !rects) {
      return refuse(400, 'BAD_REDACTION', `page: a page of the selection (1 to ${rec.pdf.pages.length}); rects: up to ${MAX_ITEMS} areas { x, y, w, h } in whole pixels`);
    }
    // Read again: another cover may have counted while this body was read.
    const before = store.get(rec.id);
    if (!before || !inReview(before) || archived(s, before)) return changed();
    const done = before.pdf.pages[k - 1]!.redactions;
    if (done >= MAX_REDACTS_PER_PAGE) return refuse(409, 'TOO_MANY_REDACTS', `A page can be covered ${MAX_REDACTS_PER_PAGE} times; discard this PDF and upload it again`);
    const orig = store.origPage(rec.id, k);
    if (!orig) return refuse(404, 'NOT_FOUND', 'The uncovered page is gone');
    // Counted before the work, so failed attempts count too.
    store.update(rec.id, { pdf: { ...before.pdf, pages: before.pdf.pages.map((p, i) => (i === k - 1 ? { ...p, redactions: done + 1 } : p)) } });
    s.worked = true;
    // One image at a time server-wide; the text is read from the covered page only.
    const read = await oneImageAtATime(async () => {
      const page = sanitiseImage(orig, rects);
      if (!hasRoom(page.png.length)) return storageFull();
      return { page, readLines: (await ocrPng(page.png)).map((l) => l.text) };
    });
    if (read instanceof Response) return read;
    const { page, readLines } = read;
    // Someone may have discarded, deleted or confirmed it while OCR ran, or it expired meanwhile.
    const after = store.get(rec.id);
    const cur = after ? unlessExpired(after) : null;
    if (!cur || !inReview(cur) || archived(s, cur)) return changed();
    const pages = cur.pdf.pages.map((p, i) => (i === k - 1 ? { ...p, rects, readLines, lines: [], added: [], sha256: page.sha256 } : p));
    const next = store.update(rec.id, { status: 'reviewing', pdf: { ...cur.pdf, pages } }, { pages: { [k]: page.png } });
    audit(s, 'upload_redacted', next);
    return json(200, { upload: view(next, s.person), readLines });
  };

  /**
   * POST /confirm on a PDF: { pages: [{ lines, added, sha256 }] }, one per selected page in order, each against the
   * covered page it was reviewed on. A transcribed line is one line of text whose area is on the page, at least 2×2
   * and outside every cover. The PDF is rebuilt from the covered pages (in the image slot); then the original and the
   * uncovered renders go.
   */
  const confirmPdf = async (req: Request, s: Scope, rec: UploadRecord): Promise<Response> => {
    if (!canEditUpload(s.person, rec)) return refuse(403, 'FORBIDDEN', 'A reviewer confirms only their own uploads');
    const parsed = await readJson(req);
    if (!parsed.ok) return refuse(400, 'INVALID_JSON');
    const sent = parsePageConfirmations(isObject(parsed.body) ? parsed.body.pages : undefined);
    if (sent instanceof Response) return sent;
    // Checked after the body was read.
    const got = store.get(rec.id);
    const cur = got && !DEAD.includes(got.status) ? unlessExpired(got) : null;
    if (!cur) return refuse(404, 'NOT_FOUND', 'No such upload in this case');
    if (archived(s, cur)) return archivedRefusal();
    if (!inReview(cur)) return notInReview(cur);
    if (cur.status !== 'reviewing' || cur.pdf.pages.some((p) => !p.sha256)) {
      return refuse(409, 'WRONG_STATUS', 'Cover what must not be shared on every page first (redact), even if nothing needs covering');
    }
    const pages = cur.pdf.pages;
    if (sent.length !== pages.length) return refuse(400, 'BAD_CONFIRMATION', `pages: one entry per selected page (${pages.length}), in order`);
    for (const [i, p] of sent.entries()) {
      if (p.lines.length !== pages[i]!.readLines.length) return refuse(400, 'BAD_LINES', `pages[${i}].lines: exactly the ${pages[i]!.readLines.length} lines read from that page, corrected where needed`);
    }
    if (sent.reduce((n, p) => n + p.lines.join('').length + p.added.reduce((m, a) => m + a.text.length, 0), 0) > MAX_TEXT_CHARS) {
      return refuse(400, 'BAD_LINES', `The text of a PDF, read and transcribed, is at most ${MAX_TEXT_CHARS} characters`);
    }
    const images: { png: Uint8Array; dpi: number }[] = [];
    for (const [i, p] of sent.entries()) {
      const png = store.pageImage(cur.id, i + 1);
      if (p.sha256 !== pages[i]!.sha256 || !png || sha256(png) !== pages[i]!.sha256) return refuse(409, 'UPLOAD_CHANGED', `Page ${pages[i]!.original} of the original document changed since you reviewed it; review it again`);
      const { width, height } = pngSize(png);
      for (const a of p.added) {
        if (!a.text.trim() || !isLine(a.text)) return refuse(422, 'BAD_TRANSCRIPTION', `A transcribed line is one line of text, up to ${MAX_LINE} characters`);
        if (a.area.w < 2 || a.area.h < 2 || a.area.x + a.area.w > width || a.area.y + a.area.h > height) {
          return refuse(422, 'BAD_TRANSCRIPTION', 'A transcribed line marks where it is on the page: an area of at least 2×2 pixels within the page');
        }
        if (pages[i]!.rects.some((r) => overlaps(a.area, r))) return refuse(422, 'BAD_TRANSCRIPTION', FROM_COVER);
      }
      images.push({ png, dpi: pages[i]!.dpi });
    }
    // The heavy step, in the image slot: never beside a render, a decode or an OCR.
    const pdf = await oneImageAtATime(async () => coveredPagesPdf(images));
    if (pdf.length > maxStored) return refuse(413, 'TOO_LARGE', `Once rebuilt from its covered pages, this PDF is larger than ${megabytes}, the most a stored file can be; upload it again and choose fewer pages`);
    if (!hasRoom(pdf.length)) return storageFull();
    // Nothing awaits from here on: the pages built are the ones stored now, and the evidence number is free.
    const built = store.get(cur.id);
    const last = built ? unlessExpired(built) : null;
    if (!last?.pdf || last.status !== 'reviewing' || archived(s, last) || last.pdf.pages.some((p, i) => p.sha256 !== pages[i]!.sha256)) return changed();
    const highest = Math.max(
      0,
      ...CASE_FILES[s.caseId]!.evidence.map((e) => evidenceNumber(e.id)),
      ...store.list({ workspaceId: s.person.workspaceId, caseId: s.caseId, boundDisputeId: s.disputeId }).map((r) => evidenceNumber(r.evidenceId)),
    );
    const confirmed = last.pdf.pages.map((p, i) => ({
      ...p,
      lines: sent[i]!.lines.map((text, j) => (text === p.readLines[j] ? { text, correctedBy: null, original: null } : { text, correctedBy: s.person.label, original: p.readLines[j]! })),
      added: sent[i]!.added.map((a) => ({ ...a, by: s.person.label })),
    }));
    const next = store.update(
      cur.id,
      { status: 'confirmed', evidenceId: `E${highest + 1}`, sha256: sha256(pdf), size: pdf.length, mime: 'application/pdf', confirmedAt: now().toISOString(), pdf: { ...last.pdf, pages: confirmed } },
      { sanitised: pdf, original: null },
    );
    forgetHints(cur.id);
    audit(s, 'upload_confirmed', next);
    return json(200, { upload: view(next, s.person) });
  };

  /** POST /confirm: the reviewed lines against the sanitised file they were reviewed on. */
  const confirm = async (req: Request, s: Scope, rec: UploadRecord): Promise<Response> => {
    if (!canEditUpload(s.person, rec)) return refuse(403, 'FORBIDDEN', 'A reviewer confirms only their own uploads');
    const parsed = await readJson(req);
    if (!parsed.ok) return refuse(400, 'INVALID_JSON');
    const b = isObject(parsed.body) ? parsed.body : {};
    if (typeof b.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(b.sha256)) return refuse(400, 'BAD_CONFIRMATION', 'sha256 (of the sanitised file you reviewed) is required');
    const lines = b.lines;
    if (!Array.isArray(lines) || !lines.every((l): l is string => typeof l === 'string' && l.length <= MAX_LINE && !LINE_STRAY.test(l))) {
      return refuse(400, 'BAD_LINES', `lines: one string per line, up to ${MAX_LINE} characters, without line breaks or control characters`);
    }
    // Checked after the body was read (nothing awaits from here on, so nothing changes in between).
    const got = store.get(rec.id);
    const cur = got && !DEAD.includes(got.status) ? unlessExpired(got) : null;
    if (!cur) return refuse(404, 'NOT_FOUND', 'No such upload in this case');
    if (archived(s, cur)) return archivedRefusal();
    if (cur.status !== 'reviewing') return refuse(409, 'WRONG_STATUS', cur.status === 'pending' ? 'Cover what must not be shared first (redact), even if nothing needs covering' : `This upload is ${cur.status}`);
    if (lines.length !== cur.readLines.length || lines.join('').length > MAX_TEXT_CHARS) return refuse(400, 'BAD_LINES', `lines: exactly the ${cur.readLines.length} lines read from the sanitised file, corrected where needed`);
    if (b.sha256 !== cur.sha256) return refuse(409, 'UPLOAD_CHANGED', 'The file changed since you reviewed it; review it again');
    const highest = Math.max(
      0,
      ...CASE_FILES[s.caseId]!.evidence.map((e) => evidenceNumber(e.id)),
      ...store.list({ workspaceId: s.person.workspaceId, caseId: s.caseId, boundDisputeId: s.disputeId }).map((r) => evidenceNumber(r.evidenceId)),
    );
    const final = lines.map((text, i) => {
      const read = cur.readLines[i]!;
      return text === read ? { text, correctedBy: null, original: null } : { text, correctedBy: s.person.label, original: read };
    });
    const next = store.update(cur.id, { status: 'confirmed', evidenceId: `E${highest + 1}`, lines: final, confirmedAt: now().toISOString() }, { original: null });
    audit(s, 'upload_confirmed', next);
    return json(200, { upload: view(next, s.person) });
  };

  const discard = (s: Scope, rec: UploadRecord): Response => {
    if (rec.status === 'archived') return refuse(404, 'NOT_FOUND', 'No such upload in this case');
    if (!canEditUpload(s.person, rec)) return refuse(403, 'FORBIDDEN', 'A reviewer discards only their own uploads');
    if (!EDITABLE.includes(rec.status)) return refuse(409, 'WRONG_STATUS', rec.status === 'confirmed' ? 'A confirmed upload is deleted, not discarded' : `This upload is ${rec.status}`);
    const next = store.update(rec.id, { status: 'discarded' });
    forgetHints(rec.id);
    audit(s, 'upload_discarded', next);
    return json(200, { upload: view(next, s.person) });
  };

  const remove = (s: Scope, rec: UploadRecord): Response => {
    if (!canDeleteUpload(s.person)) return refuse(403, 'FORBIDDEN', 'Only owners and full members delete uploads');
    // Checked and done in one synchronous step: a send cannot start in between (its start is synchronous too).
    if (o.attachedTo?.sending(rec.id)) return refuse(409, 'SEND_IN_PROGRESS', 'A response that attaches or quotes this upload is being sent to PayPal right now; delete it once the outcome is known');
    // The analyses that read it (and what hangs from them) go first: if that fails the upload stays, and deleting can be retried.
    try {
      o.purge?.(rec.analysisKeys, rec.caseId, rec.id);
    } catch {
      return refuse(500, 'PURGE_FAILED', 'The analyses that quote this upload could not be removed, so it was not deleted; try again');
    }
    const next = store.update(rec.id, { status: 'deleted', analysisKeys: [] });
    forgetHints(rec.id);
    audit(s, 'upload_deleted', next);
    o.attachedTo?.invalidate(next, s.person.label);
    return json(200, { upload: view(next, s.person) });
  };

  const image = (url: URL, s: Scope, rec: UploadRecord): Response => {
    const v = url.searchParams.get('v') ?? 'sanitised';
    if (v !== 'original' && v !== 'sanitised') return refuse(400, 'BAD_VERSION', 'v=original or v=sanitised');
    if (rec.kind !== 'image' || archived(s, rec)) return refuse(404, 'NOT_FOUND', 'No such image in this case');
    let bytes: Uint8Array | null;
    if (v === 'original') {
      if (!EDITABLE.includes(rec.status)) return refuse(404, 'NOT_FOUND', 'The original is kept only until the upload is confirmed');
      bytes = store.original(rec.id);
    } else {
      bytes = store.sanitised(rec.id);
    }
    if (!bytes) return refuse(404, 'NOT_FOUND', 'Not redacted yet');
    return imageResponse(bytes);
  };

  /** POST /select: the pages of a long PDF to read, once, while it is selecting; the thumbnails go, the job starts. */
  const choose = async (req: Request, s: Scope, rec: UploadRecord): Promise<Response> => {
    if (rec.kind !== 'pdf' || !rec.pdf || !o.pdfJob) return refuse(404, 'NOT_FOUND', 'No such PDF in this case');
    if (!canEditUpload(s.person, rec)) return refuse(403, 'FORBIDDEN', 'A reviewer chooses the pages of their own uploads only');
    if (archived(s, rec)) return archivedRefusal();
    const chosen = 'The pages of this PDF are chosen already; discard it and upload it again to choose others';
    if (rec.pdf.job.state === 'failed') return refuse(409, 'JOB_FAILED', rec.pdf.job.error ?? 'Reading this PDF failed. Discard it and upload it again.');
    if (!EDITABLE.includes(rec.status) || rec.pdf.selected || rec.pdf.job.state !== 'selecting') return refuse(409, 'WRONG_STATUS', chosen);
    const parsed = await readJson(req);
    if (!parsed.ok) return refuse(400, 'INVALID_JSON');
    const pages = isObject(parsed.body) ? parsed.body.pages : undefined;
    const count = rec.pdf.pageCount;
    if (
      !Array.isArray(pages) || pages.length < 1 || pages.length > PDF_MAX_SELECTED || new Set(pages).size !== pages.length
      || !pages.every((p): p is number => Number.isInteger(p) && p >= 1 && p <= count)
    ) {
      return refuse(400, 'BAD_SELECTION', `pages: 1 to ${PDF_MAX_SELECTED} different page numbers of the document (1 to ${count})`);
    }
    // Read again after the body (nothing awaits from here on, so nothing changes in between).
    const cur = store.get(rec.id);
    if (!cur?.pdf || !EDITABLE.includes(cur.status) || archived(s, cur)) return refuse(409, 'UPLOAD_CHANGED', 'This upload changed meanwhile; open it again');
    if (cur.pdf.job.state === 'failed') return refuse(409, 'JOB_FAILED', cur.pdf.job.error ?? 'Reading this PDF failed. Discard it and upload it again.');
    if (cur.pdf.selected || cur.pdf.job.state !== 'selecting') return refuse(409, 'WRONG_STATUS', chosen);
    const metered = o.meterPages?.(req, pages.length) ?? null;
    if (metered && !metered.ok) return capRefusal(metered.refusal);
    const selected = [...pages].sort((a, b) => a - b);
    const thumbs = Object.fromEntries(Array.from({ length: cur.pdf.pageCount }, (_, i) => [i + 1, null]));
    let next: UploadRecord;
    try {
      next = store.update(cur.id, { pdf: { ...cur.pdf, selected, pages: selected.map(freshPage), job: { state: 'rendering', page: 0, of: selected.length } } }, { thumbs });
    } catch (e) {
      if (metered?.ok) metered.release();
      throw e;
    }
    audit(s, 'upload_selected', next);
    o.pdfJob.start(next.id);
    return json(200, { upload: view(next, s.person) });
  };

  /**
   * GET /page/:k: page k of the selection, sanitised (once it went through the cover step), or until confirmed its
   * uncovered render (the job stores only that one). Whom it is shown to is decided in `handle`.
   */
  const page = (url: URL, s: Scope, rec: UploadRecord, k: number | null): Response => {
    if (k === null) return refuse(400, 'BAD_PAGE', `A page number from 1 to ${PDF_MAX_PAGES}`);
    const v = url.searchParams.get('v') ?? 'sanitised';
    if (v !== 'original' && v !== 'sanitised') return refuse(400, 'BAD_VERSION', 'v=original or v=sanitised');
    if (rec.kind !== 'pdf' || !rec.pdf || archived(s, rec)) return refuse(404, 'NOT_FOUND', 'No such PDF in this case');
    if (k > rec.pdf.pages.length) return refuse(404, 'NOT_FOUND', 'No such page in the selection');
    let bytes: Uint8Array | null;
    if (v === 'original') {
      if (!EDITABLE.includes(rec.status)) return refuse(404, 'NOT_FOUND', 'The uncovered page is kept only until the upload is confirmed');
      bytes = store.origPage(rec.id, k);
    } else {
      bytes = store.pageImage(rec.id, k);
    }
    return bytes ? imageResponse(bytes) : refuse(404, 'NOT_FOUND', v === 'original' ? 'Not rendered yet' : 'Not covered yet');
  };

  /**
   * GET /page/:k/hint: the text layer of page k, read from the original in the PDF reader's child, while the pages are
   * reviewed. A hint for spotting OCR mistakes: it can hold hidden text, so it is never stored, logged or audited; it
   * is read once per page per review and kept in memory only ({@link hints}). A failed read is not kept.
   */
  const hint = async (s: Scope, rec: UploadRecord, k: number | null): Promise<Response> => {
    if (k === null) return refuse(400, 'BAD_PAGE', `A page number from 1 to ${PDF_MAX_PAGES}`);
    // Hints of uploads that left review (failed, archived) are dropped here.
    for (const key of hints.keys()) {
      const r = store.get(key.slice(0, key.indexOf('/')));
      if (!r || !inReview(r)) hints.delete(key);
    }
    if (rec.kind !== 'pdf' || !rec.pdf || archived(s, rec)) return refuse(404, 'NOT_FOUND', 'No such PDF in this case');
    const original = inReview(rec) && k <= rec.pdf.pages.length ? store.original(rec.id) : null;
    if (!original) return refuse(404, 'NOT_FOUND', 'The text found in the PDF is shown only while its pages are reviewed');
    const key = `${rec.id}/${k}`;
    let read = hints.get(key);
    if (!read) {
      read = pageTextHint(original, rec.pdf.pages[k - 1]!.original);
      hints.set(key, read);
    }
    try {
      return json(200, { lines: await read });
    } catch (e) {
      if (hints.get(key) === read) hints.delete(key);
      // Never a 500: the reader could not start or was too slow (try again), or the page could not be read.
      if (!(e instanceof UploadError) || e.message === CANNOT_START || e.message === TOO_SLOW || e.message === OVER_BUDGET) return refuse(503, 'PDF_READER_UNAVAILABLE', 'The PDF reader could not read this page now. Try again later.');
      return refuse(422, 'UNREADABLE', e.message);
    }
  };

  /** GET /thumb/:n: the thumbnail of page n (uncovered, like an original), while it is selecting. */
  const thumb = (s: Scope, rec: UploadRecord, n: number | null): Response => {
    if (n === null) return refuse(400, 'BAD_PAGE', `A page number from 1 to ${PDF_MAX_PAGES}`);
    if (rec.kind !== 'pdf' || !rec.pdf || archived(s, rec)) return refuse(404, 'NOT_FOUND', 'No such PDF in this case');
    if (n > rec.pdf.pageCount || rec.pdf.selected || rec.pdf.job.state !== 'selecting') return refuse(404, 'NOT_FOUND', 'Thumbnails are kept only until the pages are chosen');
    const bytes = store.thumb(rec.id, n);
    return bytes ? imageResponse(bytes) : refuse(404, 'NOT_FOUND', 'Not made yet');
  };

  const handle = async (req: Request, url: URL, s: Scope, m: RegExpExecArray): Promise<Response> => {
    const uploadId = m[2];
    const sub = m[3] ?? m[4];
    if (!uploadId) {
      if (req.method === 'POST') return add(req, s);
      return json(200, { uploads: shown(s).map((r) => view(r, s.person)) });
    }
    const got = store.get(uploadId);
    // Another workspace's upload, one that is gone or expired, does not exist for this request.
    const rec = got && got.workspaceId === s.person.workspaceId && got.caseId === s.caseId && !DEAD.includes(got.status) ? unlessExpired(got) : null;
    if (!rec) return refuse(404, 'NOT_FOUND', 'No such upload in this case');
    if (!sub) return remove(s, rec);
    // Until confirmed, its files are only for people who can edit it; for anyone else they do not exist.
    if ((sub === 'image' || sub === 'page' || sub === 'thumb') && EDITABLE.includes(rec.status) && !canEditUpload(s.person, rec)) return refuse(404, 'NOT_FOUND', 'No such file in this case');
    if (sub === 'image') return image(url, s, rec);
    if (m[6]) return sub === 'page' ? hint(s, rec, pageNumber(m[5]!)) : refuse(404, 'NOT_FOUND', 'No such file in this case');
    if (sub === 'page') return page(url, s, rec, pageNumber(m[5]!));
    if (sub === 'thumb') return thumb(s, rec, pageNumber(m[5]!));
    if (sub === 'select') return choose(req, s, rec);
    // A PDF is covered and confirmed page by page.
    if (sub === 'redact') return rec.kind === 'pdf' ? redactPdf(req, s, rec) : redact(req, s, rec);
    if (sub === 'confirm') return rec.kind === 'pdf' ? confirmPdf(req, s, rec) : confirm(req, s, rec);
    return discard(s, rec);
  };

  return async (req, url) => {
    const m = ROUTE.exec(url.pathname);
    if (!m) return null;
    const caseId = m[1]!;
    let s: Scope | null = null;
    const early = (r: Response) => {
      if (r.status >= 400 && !s?.worked) r.headers.set(REFUSED_EARLY, '1');
      return r;
    };
    const method = !m[2] ? ['GET', 'POST'] : m[4] || m[3] === 'image' ? ['GET'] : !m[3] ? ['DELETE'] : ['POST'];
    if (!method.includes(req.method)) return early(refuse(405, 'METHOD_NOT_ALLOWED'));
    if (!(await o.caseVisible(req, caseId))) return early(refuse(404, 'UNKNOWN_CASE'));
    const person = o.person(req);
    if (!person) return early(refuse(401, 'SIGN_IN_REQUIRED', 'Sign in to add evidence: with PayPal (merchants) or with the invite link you were given.'));
    s = { caseId, person, disputeId: o.caseBinding(caseId), worked: false };
    try {
      return early(await handle(req, url, s, m));
    } catch (e) {
      if (!(e instanceof UploadError)) throw e;
      // Codes and fixed messages only: an UploadError never carries content.
      if (e.code === 'STORAGE') o.log(`uploads · case ${caseId} · ${e.message}`);
      return early(refuse(e.status, e.code, e.message));
    }
  };
}
