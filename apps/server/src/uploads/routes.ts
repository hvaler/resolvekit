/**
 * The HTTP routes of merchant evidence uploads, for the seller's workspace (local mode: the operator):
 *
 *   POST   /api/cases/:id/uploads                  image/png | image/jpeg (raw, `x-upload-name`) or JSON { text, name }
 *   GET    /api/cases/:id/uploads                  this workspace's uploads of the case and its active dispute
 *   GET    /api/cases/:id/uploads/:u/image?v=…     original (pending/reviewing, people who can edit it) | sanitised
 *   POST   /api/cases/:id/uploads/:u/redact        { rects } | { removals } → sanitised file, re-read from it
 *   POST   /api/cases/:id/uploads/:u/confirm       { lines, sha256 } → E<n>, the original dropped
 *   POST   /api/cases/:id/uploads/:u/discard       before confirmation: files removed
 *   DELETE /api/cases/:id/uploads/:u               owners and full members: files removed; refused while a send
 *                                                   using it (attached or in its input) is in flight, voids the unsent
 *                                                   intents using it and purges the analyses that read it
 *
 * Nothing of an upload leaves this server here: OCR is local, nothing is sent to PayPal or a model. Audit details and
 * log lines carry ids and file names only, never text or bytes. A pending upload past its expiry is discarded the
 * first time a route meets it.
 *
 * A refusal given before any decoding or OCR carries the {@link REFUSED_EARLY} header: hosted mode gives the address
 * its upload slot back for those only (and strips the header). Work once started is never refunded.
 */
import type { ActingPerson, Reservation } from '../app.ts';
import { CASE_FILES } from '../documents.ts';
import type { AuditEvent } from '../intents.ts';
import { uploadDocuments } from './documents.ts';
import { UploadError, sanitiseImage, type Rect } from './image.ts';
import { MAX_FILE_BYTES, MAX_STORAGE_BYTES, MAX_TEXT_CHARS, MAX_UPLOADS_PER_CASE } from './limits.ts';
import { ocrPng } from './ocr.ts';
import { canDeleteUpload, canEditUpload } from './permissions.ts';
import type { UploadPatch, UploadRecord, UploadStatus, UploadStore } from './store.ts';
import { pastedTextPdf, redactText, textLines, type TextRemoval } from './text.ts';

/** The one route that takes a raw file body; group 1 is the case id (node.ts sizes its body limit with it). */
export const UPLOAD_PATH = /^\/api\/cases\/([A-Za-z0-9-]{1,64})\/uploads$/;
/** A redaction (each one runs OCR): metered per address like an upload. */
export const REDACT_PATH = /^\/api\/cases\/[A-Za-z0-9-]{1,64}\/uploads\/upl-[0-9a-f]{24}\/redact$/;
/** Set on a refusal given before any decoding or OCR (internal: hosted.ts strips it). */
export const REFUSED_EARLY = 'x-rk-refused-early';
/** Redactions per upload. */
export const MAX_REDACTS = 5;
const ROUTE = /^\/api\/cases\/([A-Za-z0-9-]{1,64})\/uploads(?:\/(upl-[0-9a-f]{24})(?:\/(image|redact|confirm|discard))?)?$/;
const IMAGE_TYPES = ['image/png', 'image/jpeg'];

const mediaType = (contentType: string | null) => (contentType ?? '').split(';')[0]!.trim().toLowerCase();

/** image/png or image/jpeg. */
export const isImageType = (contentType: string | null): boolean => IMAGE_TYPES.includes(mediaType(contentType));

/** Whether a request may carry an image body: POST to the upload route with image/png or image/jpeg. */
export function acceptsImageBody(method: string, path: string, contentType: string | null): boolean {
  return method === 'POST' && UPLOAD_PATH.test(path) && isImageType(contentType);
}

export interface UploadRoutesOptions {
  store: UploadStore;
  /** The person acting; null when signed out. */
  person: (req: Request) => ActingPerson | null;
  /** Whether the request comes from the seller's workspace (local mode: always). */
  isLive: (req: Request) => Promise<boolean>;
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
/** In a confirmed line, also no line break (a tab stays, as in pasted text). */
const LINE_STRAY = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

/**
 * The record as the web app sees it (no workspace id, no analysis keys, no counters), with the analyst's document of a
 * confirmed upload (exactly what the analysis reads: lines, fragment keys, corrections), null before confirmation.
 */
function view(r: UploadRecord) {
  const { workspaceId: _w, analysisKeys: _a, redactions: _r, ...v } = r;
  return { ...v, document: uploadDocuments([r])[0] ?? null };
}

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
  const { store } = o;

  const audit = (s: Scope, kind: AuditEvent['kind'], r: UploadRecord) =>
    o.record({ caseId: s.caseId, kind, actor: s.person.label, team: s.person.workspaceId, disputeId: s.disputeId, detail: [r.id, r.evidenceId, r.name].filter(Boolean).join(' · ') });

  /** A pending or reviewing upload past its expiry is discarded now (files and text purged); null then. */
  const unlessExpired = (r: UploadRecord): UploadRecord | null => {
    if (!EDITABLE.includes(r.status) || r.expiresAt > now().toISOString()) return r;
    store.update(r.id, { status: 'discarded' });
    o.record({ caseId: r.caseId, kind: 'upload_discarded', actor: 'ResolveKit (expired)', team: r.workspaceId, disputeId: r.boundDisputeId, detail: `${r.id} · ${r.name} · expired` });
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
  const archived = (s: Scope, r: UploadRecord) => r.status === 'archived' || r.boundDisputeId !== s.disputeId;
  const archivedRefusal = () => refuse(409, 'UPLOAD_ARCHIVED', 'The case moved to another PayPal dispute since this was uploaded; upload it again for the current one');

  /** POST /uploads: an image (raw body) or pasted text (JSON). Limits and the day's unit are checked before any work. */
  const add = async (req: Request, s: Scope): Promise<Response> => {
    const declared = Number(req.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) return refuse(413, 'TOO_LARGE', `Files up to ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    const type = mediaType(req.headers.get('content-type'));
    let kind: UploadRecord['kind'];
    let original: Uint8Array;
    let name: string;
    let text: string | null = null;
    if (isImageType(type)) {
      original = new Uint8Array(await req.arrayBuffer());
      if (original.length > MAX_FILE_BYTES) return refuse(413, 'TOO_LARGE', `Files up to ${MAX_FILE_BYTES / 1024 / 1024} MB`);
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
      original = new TextEncoder().encode(text);
      kind = 'text';
      name = cleanName(b.name, 'pasted text');
    } else {
      return refuse(415, 'UNSUPPORTED_TYPE', 'Upload a PNG or JPEG image, or paste text');
    }
    if (shown(s).length >= MAX_UPLOADS_PER_CASE) return tooMany();
    if (!hasRoom(original.length)) return storageFull();
    const reserved = o.reserve?.(req) ?? null;
    if (reserved && !reserved.ok) return json(reserved.refusal.status, reserved.refusal.body);

    // From here on the day's unit is spent, whatever happens.
    let readLines: string[];
    if (kind === 'image') {
      s.worked = true;
      // Decoded (type by magic bytes, size checked first) and re-encoded as a PNG: what OCR sees is pixels only. The
      // text goes back to the person only; it is not stored.
      readLines = (await ocrPng(sanitiseImage(original, []).png)).map((l) => l.text);
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
    return json(201, { upload: view(rec), readLines });
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
      const s1 = sanitiseImage(original, rects);
      if (!hasRoom(s1.png.length)) return storageFull();
      const readLines = (await ocrPng(s1.png)).map((l) => l.text);
      patch = { status: 'reviewing', rects, removals: [], readLines, sha256: s1.sha256, size: s1.png.length, mime: 'image/png' };
      file = s1.png;
    } else {
      const lines = textLines(redactText(new TextDecoder().decode(original), removals!));
      const doc = pastedTextPdf({ title: rec.name, by: rec.uploadedBy.name.slice(0, 80), lines });
      if (!hasRoom(doc.pdf.length)) return storageFull();
      patch = { status: 'reviewing', rects: [], removals: removals!, readLines: lines, sha256: doc.sha256, size: doc.pdf.length, mime: 'application/pdf' };
      file = doc.pdf;
    }
    // Someone may have discarded, deleted or confirmed it while OCR ran.
    const cur = store.get(rec.id);
    if (!cur || !EDITABLE.includes(cur.status) || archived(s, cur)) return refuse(409, 'UPLOAD_CHANGED', 'This upload changed while it was being read; open it again');
    const next = store.update(rec.id, patch, { sanitised: file });
    audit(s, 'upload_redacted', next);
    return json(200, { upload: view(next), readLines: next.readLines });
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
    return json(200, { upload: view(next) });
  };

  const discard = (s: Scope, rec: UploadRecord): Response => {
    if (rec.status === 'archived') return refuse(404, 'NOT_FOUND', 'No such upload in this case');
    if (!canEditUpload(s.person, rec)) return refuse(403, 'FORBIDDEN', 'A reviewer discards only their own uploads');
    if (!EDITABLE.includes(rec.status)) return refuse(409, 'WRONG_STATUS', rec.status === 'confirmed' ? 'A confirmed upload is deleted, not discarded' : `This upload is ${rec.status}`);
    const next = store.update(rec.id, { status: 'discarded' });
    audit(s, 'upload_discarded', next);
    return json(200, { upload: view(next) });
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
    audit(s, 'upload_deleted', next);
    o.attachedTo?.invalidate(next, s.person.label);
    return json(200, { upload: view(next) });
  };

  const image = (url: URL, s: Scope, rec: UploadRecord): Response => {
    const v = url.searchParams.get('v') ?? 'sanitised';
    if (v !== 'original' && v !== 'sanitised') return refuse(400, 'BAD_VERSION', 'v=original or v=sanitised');
    if (rec.kind !== 'image' || archived(s, rec)) return refuse(404, 'NOT_FOUND', 'No such image in this case');
    let bytes: Uint8Array | null;
    if (v === 'original') {
      if (!EDITABLE.includes(rec.status)) return refuse(404, 'NOT_FOUND', 'The original is kept only until the upload is confirmed');
      if (!canEditUpload(s.person, rec)) return refuse(403, 'FORBIDDEN', 'The original is shown only to people who can edit this upload');
      bytes = store.original(rec.id);
    } else {
      bytes = store.sanitised(rec.id);
    }
    if (!bytes) return refuse(404, 'NOT_FOUND', 'Not redacted yet');
    const type = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : 'image/png';
    return new Response(bytes as BodyInit, { status: 200, headers: { 'content-type': type, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-disposition': 'inline' } });
  };

  const handle = async (req: Request, url: URL, s: Scope, m: RegExpExecArray): Promise<Response> => {
    const uploadId = m[2];
    const sub = m[3];
    if (!uploadId) {
      if (req.method === 'POST') return add(req, s);
      return json(200, { uploads: shown(s).map(view) });
    }
    const got = store.get(uploadId);
    // Another workspace's upload, one that is gone or expired, does not exist for this request.
    const rec = got && got.workspaceId === s.person.workspaceId && got.caseId === s.caseId && !DEAD.includes(got.status) ? unlessExpired(got) : null;
    if (!rec) return refuse(404, 'NOT_FOUND', 'No such upload in this case');
    if (!sub) return remove(s, rec);
    if (sub === 'image') return image(url, s, rec);
    if (sub === 'redact') return redact(req, s, rec);
    if (sub === 'confirm') return confirm(req, s, rec);
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
    const method = !m[2] ? ['GET', 'POST'] : !m[3] ? ['DELETE'] : m[3] === 'image' ? ['GET'] : ['POST'];
    if (!method.includes(req.method)) return early(refuse(405, 'METHOD_NOT_ALLOWED'));
    if (!Object.hasOwn(CASE_FILES, caseId)) return early(refuse(404, 'UNKNOWN_CASE'));
    const person = o.person(req);
    if (!person) return early(refuse(401, 'SIGN_IN_REQUIRED', 'Sign in to add evidence: with PayPal (merchants) or with the invite link you were given.'));
    if (!(await o.isLive(req))) return early(refuse(403, 'SELLER_WORKSPACE_ONLY', 'Evidence uploads are for the seller’s workspace on this demo.'));
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
