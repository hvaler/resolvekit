/**
 * Merchant evidence uploads (`/api/cases/:id/uploads…` on the ResolveKit server, apps/server/src/uploads/routes.ts):
 * the client, and how a confirmed upload takes part in the case — an evidence card with its provenance, a document of
 * the analyst's input (exactly the server's), corrected or transcribed lines a sentence must have confirmed, and an
 * attachment the merchant chooses in the final review. Nothing here reads or keeps an upload's content beyond what the server returns.
 */
import type { AnalysisDocument, AnalysisInput } from '@resolvekit/analyst';
import { correctionPair, linesToConfirmOf, pageOf, type Correction } from './draft';
import type { IntentRequest } from './intent';
import { utcStamp } from './time';
import type { Citation, ContradictionResolution, Evidence, EvidenceType, SentenceView } from './types';

/** An area to cover, in whole pixels of the uploaded image. */
export interface Rect { x: number; y: number; w: number; h: number }
/** A span of pasted text to remove, as UTF-16 offsets into it (`end` exclusive). */
export interface TextRemoval { start: number; end: number }

export type UploadStatus = 'pending' | 'reviewing' | 'confirmed';

/** An upload as the server shows it to the seller's workspace (no workspace id, no analysis keys). */
export interface UploadRecordView {
  id: string;
  kind: 'image' | 'text' | 'pdf';
  name: string;
  uploadedBy: { id: string; label: string; name: string };
  status: UploadStatus;
  createdAt: string;
  expiresAt: string;
  /**
   * A pending upload someone else is reviewing, shown to a person who cannot edit it: metadata only (who added what
   * kind of file when, where its job is). Every field below that holds what the upload shows or reads is then absent.
   */
  restricted?: true;
  caseId?: string;
  boundDisputeId?: string | null;
  /** E7…, set at confirmation. */
  evidenceId?: string | null;
  rects?: Rect[];
  removals?: TextRemoval[];
  /** Read again from the sanitised file (after a redaction). */
  readLines?: string[];
  lines?: { text: string; correctedBy: string | null; original: string | null }[];
  /** Of the stored sanitised file. */
  sha256?: string | null;
  size?: number | null;
  mime?: 'image/png' | 'application/pdf' | null;
  confirmedAt?: string | null;
  /** The analyst's document of a confirmed upload (lines, fragment keys, corrections); null before confirmation. */
  document?: AnalysisDocument | null;
  /** A PDF: its pages and its job. A restricted view has only `pageCount`, `selected` and `job`. */
  pdf?: PdfView;
}

/** One selected page of a PDF upload, as the server shows it (no text layer, no counters). */
export interface PdfPageView {
  /** The page number in the uploaded PDF. */
  original: number;
  rects: Rect[];
  readLines: string[];
  lines: { text: string; correctedBy: string | null; original: string | null }[];
  added: { area: Rect; text: string }[];
  /** Of the covered page image; null until the page went through the cover step. */
  sha256: string | null;
}

/** Where the reading of a PDF is. `selecting`: waiting for the pages to choose (a document of more than 5 pages). */
export interface PdfJob {
  state: 'selecting' | 'rendering' | 'reading' | 'reviewing' | 'failed';
  page?: number | undefined;
  of?: number | undefined;
  error?: string | undefined;
}

export interface PdfView {
  pageCount: number;
  /** The original page numbers chosen, once chosen. */
  selected: number[] | null;
  pages?: PdfPageView[];
  job: PdfJob;
}

/** A refusal by the uploads routes, with the server's code and words. */
export class UploadRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, body: { error?: string; detail?: string }) {
    super(body.detail ?? body.error ?? `HTTP ${status}`);
    this.name = 'UploadRequestError';
    this.status = status;
    this.code = body.error ?? `HTTP_${status}`;
  }
}

/** Answers that come with the text read from the file (to the person only; the server does not keep a pending one's). */
export interface ReadAnswer {
  upload: UploadRecordView;
  readLines: string[];
}

/** The uploads of one case. `fetch` and `base` as the other clients (tests pass their own). */
export function createUploadsClient(caseId: string, o: { base?: string; fetch?: typeof fetch } = {}) {
  const base = `${o.base ?? '/api'}/cases/${encodeURIComponent(caseId)}/uploads`;
  const f = o.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const call = async <T>(path: string, init: RequestInit, timeoutMs = 120_000): Promise<T> => {
    let r: Response;
    try {
      r = await f(base + path, { credentials: 'same-origin', ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new UploadRequestError(0, { error: 'SERVER_UNREACHABLE', detail: 'The ResolveKit server could not be reached' });
    }
    const body = (await r.json().catch(() => ({}))) as T & { error?: string; detail?: string };
    if (!r.ok) throw new UploadRequestError(r.status, body);
    return body;
  };
  // Every state-changing call is JSON (the local guards accept JSON, and an image only on the upload route).
  const post = <T>(path: string, body: unknown) => call<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const one = (id: string) => `/${encodeURIComponent(id)}`;
  return {
    listUploads: async () => {
      const body = await call<{ uploads?: unknown }>('', { method: 'GET' }, 15_000);
      // Not a list (e.g. a static host answering /api with a page): there is no ResolveKit server behind it.
      if (!Array.isArray(body.uploads)) throw new UploadRequestError(0, { error: 'SERVER_UNREACHABLE', detail: 'The ResolveKit server did not answer' });
      return body.uploads as UploadRecordView[];
    },
    /** A PNG or JPEG, sent as is; the server reads its text locally (OCR). */
    uploadImage: (file: File) => call<ReadAnswer>('', { method: 'POST', headers: { 'content-type': file.type || 'image/png', 'x-upload-name': encodeURIComponent(file.name) }, body: file }),
    /** A PDF, sent as is; the server counts its pages and, up to 5, reads them at once (a job to follow), else waits for a selection. */
    uploadPdf: (file: File) => call<{ upload: UploadRecordView }>('', { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-upload-name': encodeURIComponent(file.name) }, body: file }),
    /** The pages (numbers in the original PDF) of a long one to read, once; its job starts. */
    select: async (id: string, pages: number[]) => (await post<{ upload: UploadRecordView }>(`${one(id)}/select`, { pages })).upload,
    /** Cover areas of page `k` of the selection (in pixels of its render); the server reads that page again. */
    redactPage: (id: string, k: number, rects: Rect[]) => post<ReadAnswer>(`${one(id)}/redact`, { page: k, rects }),
    /** One entry per selected page, in order: its reviewed lines, transcribed lines and the hash of the covered page. */
    confirmPdf: async (id: string, pages: { lines: string[]; added: { area: Rect; text: string }[]; sha256: string }[]) => (await post<{ upload: UploadRecordView }>(`${one(id)}/confirm`, { pages })).upload,
    /** The text layer of page `k`, a hint for the review (only while it is reviewed; never stored or sent anywhere). */
    hint: async (id: string, k: number) => (await call<{ lines: string[] }>(`${one(id)}/page/${k}/hint`, { method: 'GET' }, 60_000)).lines,
    /** Page `k` of the selection: the uncovered render (while reviewed) or the covered one. */
    pageUrl: (id: string, k: number, v: 'sanitised' | 'original', version = '') => `${base}${one(id)}/page/${k}?v=${v}${version ? `&k=${version.slice(0, 16)}` : ''}`,
    /** Thumbnail of page `n` of the original document, while the pages are chosen. */
    thumbUrl: (id: string, n: number) => `${base}${one(id)}/thumb/${n}`,
    uploadText: (text: string, name: string) => post<ReadAnswer>('', { text, name }),
    /** Cover areas (image) or remove spans (pasted text): the server makes the sanitised file and reads it again. */
    redact: (id: string, r: { rects: Rect[] } | { removals: TextRemoval[] }) => post<ReadAnswer>(`${one(id)}/redact`, r),
    /** The reviewed lines (one per line read), against the sanitised file they were reviewed on. */
    confirm: async (id: string, lines: string[], sha256: string) => (await post<{ upload: UploadRecordView }>(`${one(id)}/confirm`, { lines, sha256 })).upload,
    discard: async (id: string) => (await post<{ upload: UploadRecordView }>(`${one(id)}/discard`, {})).upload,
    remove: async (id: string) => (await call<{ upload: UploadRecordView }>(one(id), { method: 'DELETE', headers: { 'content-type': 'application/json' } })).upload,
    /** The image to show: the original (only while it is reviewed, to people who can edit it) or the sanitised file. */
    imageUrl: (id: string, v: 'original' | 'sanitised', version = '') => `${base}${one(id)}/image?v=${v}${version ? `&k=${version.slice(0, 16)}` : ''}`,
  };
}

export type UploadsClient = ReturnType<typeof createUploadsClient>;

/** `pending · contract.pdf · uploaded by Eva`: how an upload this person cannot edit is shown (it has nothing else to show). */
export const pendingLine = (u: Pick<UploadRecordView, 'name' | 'uploadedBy'>) => `pending · ${u.name} · uploaded by ${u.uploadedBy.name}`;

const evidenceNumber = (id: string | null | undefined) => Number(/^E(\d+)$/.exec(id ?? '')?.[1] ?? 0);

/** The confirmed uploads (those with a document), in evidence order. */
export function confirmedUploads(uploads: readonly UploadRecordView[]): UploadRecordView[] {
  return uploads.filter((u) => !u.restricted && u.status === 'confirmed' && u.document && evidenceNumber(u.evidenceId) > 0).sort((a, b) => evidenceNumber(a.evidenceId) - evidenceNumber(b.evidenceId));
}

/** The evidence heading's count: the cards shown, so confirmed uploads count like the case's own documents. */
export function evidenceCount(evidence: readonly unknown[]): string {
  return `${evidence.length} document${evidence.length === 1 ? '' : 's'}`;
}

/** A confirmed upload as an evidence card: the server's lines and fragments, who uploaded it, who corrected or transcribed what. */
export function uploadEvidence(r: UploadRecordView): Evidence {
  const doc = r.document!;
  return {
    id: doc.id,
    short: r.name,
    title: r.name,
    meta: { type: doc.type, tag: doc.tag, source: doc.source, received: r.confirmedAt ? utcStamp(new Date(r.confirmedAt)) : '', hash: r.sha256 ?? '' },
    sourceLabel: { kind: 'upload', text: `Uploaded by ${r.uploadedBy.name}` },
    body: { kind: 'lines', lines: doc.lines.map((l) => ({ text: l.text, ...(l.fragment ? { fragment: l.fragment } : {}), ...(l.corrected ? { corrected: l.corrected } : {}), ...(l.transcribed ? { transcribed: l.transcribed } : {}) })) },
  };
}

/** The analyst's input with the confirmed uploads' documents after the case's own: what the server analyses. */
export function withUploadDocuments(input: AnalysisInput, uploads: readonly UploadRecordView[]): AnalysisInput {
  const docs = confirmedUploads(uploads).map((u) => u.document!);
  return docs.length ? { ...input, documents: [...input.documents, ...docs] } : input;
}

/**
 * The corrected and transcribed lines of the confirmed uploads, by fragment key (as the server derives them from its
 * input): every line a sentence needs a confirmation for.
 */
export function uploadCorrections(uploads: readonly UploadRecordView[]): Map<string, Correction> {
  return linesToConfirmOf(confirmedUploads(uploads).map((u) => u.document!));
}

/** Evidence ids of confirmed uploads that the analysis on screen did not read (none ready: all of them). */
export function notAnalysed(uploads: readonly UploadRecordView[], analysed: AnalysisInput | null): string[] {
  const read = new Set(analysed?.documents.map((d) => d.id) ?? []);
  return confirmedUploads(uploads).map((u) => u.evidenceId!).filter((id) => !read.has(id));
}

/** The corrected or transcribed lines this sentence is held back on until the merchant confirms them (deriveSentences says which). */
export function correctionsToConfirm(view: SentenceView, corrections: ReadonlyMap<string, Correction>, confirmed: ReadonlySet<string>): Correction[] {
  if (view.state !== 'needs_review' || !view.awaitsCorrections) return [];
  return view.awaitsCorrections.flatMap((f) => {
    const k = corrections.get(f);
    return k && !confirmed.has(correctionPair(view.id, f)) ? [k] : [];
  });
}

/** The pairs without those of `sentenceId` (its text changed: what it relies on must be confirmed again). */
export const dropPairsOf = (pairs: readonly string[], sentenceId: string): string[] => pairs.filter((p) => !p.startsWith(`${sentenceId}@`));

/** The confirmed pairs that still mean something: a sentence to be sent citing that corrected or transcribed line. */
export function effectivePairs(views: readonly SentenceView[], corrections: ReadonlyMap<string, Correction>, confirmed: Iterable<string>): string[] {
  const live = new Set<string>();
  for (const v of views) {
    if (v.state !== 'supported') continue;
    for (const c of v.citations) for (const f of c.fragments) if (corrections.has(f)) live.add(correctionPair(v.id, f));
  }
  return [...new Set(confirmed)].filter((p) => live.has(p)).sort();
}

/** What the merchant asks the server to compose: their choices, with the confirmations and attachments that apply. */
export function approvalRequest(o: {
  evidenceType: EvidenceType;
  edits: Record<string, string>;
  resolutions: Record<string, ContradictionResolution>;
  views: readonly SentenceView[];
  corrections: ReadonlyMap<string, Correction>;
  confirmed: Iterable<string>;
  attachments: Iterable<string>;
}): IntentRequest {
  return {
    evidenceType: o.evidenceType,
    edits: o.edits,
    resolutions: o.resolutions,
    confirmedCorrections: effectivePairs(o.views, o.corrections, o.confirmed),
    attachments: [...new Set(o.attachments)].sort(),
  };
}

/** What a document is, as every card, citation and review shows it. */
export interface Provenance {
  kind: 'upload' | 'demo' | 'paypal' | 'metermcp';
  text: string;
}

/** Where a PDF upload's cited line is: `Page 8 of the original document` (the page number in the uploaded PDF). */
export const pageLabel = (page: number) => `Page ${page} of the original document`;

/** Who typed a line of a PDF upload by hand: `Transcribed manually by Ana (member)`. */
export const transcribedLabel = (person: string) => `Transcribed manually by ${person}`;

/** The pages of the original document a citation of a PDF upload covers, in order (none for any other citation). */
const citedPages = (c: Citation): number[] => [...new Set(c.fragments.map((f) => pageOf(f)?.page).filter((p): p is number => p !== undefined))].sort((a, b) => a - b);

/**
 * Where a document comes from: a merchant upload (and who uploaded it), the real MeterMCP session, PayPal's record of
 * the disputed payment as read from PayPal, or a synthetic demo document (the demo case's own, or PayPal's record on a
 * simulated case). One decision for the whole app. For a citation `c` of a PDF upload, also the pages it cites.
 */
export function provenanceOf(e: Evidence, c?: Citation): Provenance {
  const l = e.sourceLabel;
  if (l?.kind === 'upload') return { kind: 'upload', text: [l.text, ...(c ? citedPages(c).map(pageLabel) : [])].join(' · ') };
  if (l?.kind === 'metermcp') return { kind: l.kind, text: l.text };
  if (e.paypalRecord === 'capture' && e.meta?.source.startsWith('PayPal')) {
    // Bound case: from the PayPal read, or (not read yet) a placeholder that says so; never demo data.
    if (e.meta.received.startsWith('read ')) return { kind: 'paypal', text: `From ${e.meta.source}` };
    if (e.meta.received === '—') return { kind: 'paypal', text: 'PayPal · not read yet' };
  }
  return { kind: 'demo', text: l?.kind === 'demo' ? l.text : 'Synthetic demo document' };
}

/** A cited line the merchant corrected or transcribed by hand, and the words that say so on the citation. */
export interface CitedCorrection {
  /** 1-based line number in the upload; on a PDF, in its page. */
  line: number;
  /** On a PDF: the page of the original document. */
  page?: number;
  fragment: string;
  by: string;
  kind: Correction['kind'];
  /** `line 2 corrected by Ana`; on a PDF `Page 8 of the original document · line 2 corrected by Ana`, or `… · Transcribed manually by Ana`. */
  label: string;
}

/** The lines of `e` this citation covers that the merchant corrected or transcribed by hand. */
export function citedCorrections(e: Evidence, c: Citation): CitedCorrection[] {
  if (e.body.kind !== 'lines' || !c.fragments.length) return [];
  return e.body.lines.flatMap((l, i) => {
    const kind = l.corrected ? 'corrected' : l.transcribed ? 'transcribed' : null;
    const by = l.corrected ?? l.transcribed;
    if (!kind || !by || !l.fragment || !c.fragments.includes(l.fragment)) return [];
    const p = pageOf(l.fragment);
    const line = p ? p.line : i + 1;
    const what = kind === 'transcribed' ? transcribedLabel(by) : `line ${line} corrected by ${by}`;
    return [{ line, ...(p ? { page: p.page } : {}), fragment: l.fragment, by, kind, label: p ? `${pageLabel(p.page)} · ${what}` : what }];
  });
}

/** Who may review (redact, correct, confirm) or discard an upload: owners and members any; a reviewer their own (server's rule). Local mode (no person): the operator. */
export function canEditUpload(p: { id: string; role: 'owner' | 'member'; reviewer: boolean } | null | undefined, u: Pick<UploadRecordView, 'uploadedBy'>): boolean {
  return !p || p.role === 'owner' || !p.reviewer || p.id === u.uploadedBy.id;
}

/** Whether this person can open a review of the upload: the server's edit rule, and never on a restricted view (nothing to open). */
export const canReviewUpload = (p: Parameters<typeof canEditUpload>[0], u: UploadRecordView): boolean => !u.restricted && canEditUpload(p, u);

/** The case's uploads list as the page holds it. */
export interface UploadsListState {
  uploads: UploadRecordView[];
  /** A list came back (or the person may not see one): the analysis input can be built. */
  known: boolean;
  /** Why this person cannot add evidence here (the server's 401/403 words). */
  refused: string | null;
  /** The last list request failed (the page shows it with a Retry). */
  error: string | null;
}

export type UploadsListEvent =
  | { type: 'loaded'; uploads: UploadRecordView[] }
  | { type: 'refused'; reason: string }
  /** `status` 0: unreachable; `code` the server's error code, `HTTP_<status>` when the answer carried none. */
  | { type: 'failed'; error: string; status: number; code: string }
  | { type: 'put'; id: string; upload: UploadRecordView | null };

const SHOWN: UploadStatus[] = ['pending', 'reviewing', 'confirmed'];

/** Unreachable, or a 5xx that is not the uploads route answering (no error code of its own). */
const serverAbsent = (status: number, code: string) => status === 0 || (status >= 500 && code === `HTTP_${status}`);

/** Delays before retrying a failed list: 2, 5, 10, 20 s, then every 30 s, about two minutes in all; null: stop. */
export function listRetryDelay(attempt: number): number | null {
  const d = [2_000, 5_000, 10_000, 20_000, 30_000, 30_000, 30_000];
  return d[attempt] ?? null;
}

/**
 * The uploads that go into the analysis input, or null while it must wait: someone who can have uploads waits for a
 * known list; anyone else (signed out, another workspace) is analysed without uploads, whatever the list did.
 */
const NO_UPLOADS: UploadRecordView[] = [];

export function uploadsForInput(s: UploadsListState, canHaveUploads: boolean): UploadRecordView[] | null {
  if (!canHaveUploads) return NO_UPLOADS;
  return s.known ? s.uploads : null;
}

/**
 * A failed list never stands for "no uploads" while the uploads route is there: until one has come back the list is
 * not known (nothing is analysed as if there were none); after that, a failure keeps the last list and says so. With
 * no server behind the request at all, the list is known and empty (no analysis can read an upload then).
 */
export function uploadsListReducer(s: UploadsListState, e: UploadsListEvent): UploadsListState {
  switch (e.type) {
    case 'loaded':
      return { uploads: e.uploads, known: true, refused: null, error: null };
    case 'refused':
      return { uploads: [], known: true, refused: e.reason, error: null };
    case 'failed':
      // No server behind the request (unreachable, or a proxy/deploy 5xx without the route's own code): no upload can be
      // in any analysis either, so the list is known and empty and the analysis is not held.
      return serverAbsent(e.status, e.code) ? { ...s, known: true, error: e.error } : { ...s, error: e.error };
    case 'put': {
      const rest = s.uploads.filter((x) => x.id !== e.id);
      const uploads = e.upload && SHOWN.includes(e.upload.status) ? [...rest, e.upload].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : rest;
      return { ...s, uploads };
    }
  }
}

/** One confirmed upload offered as an attachment in the final review. */
export interface AttachmentChoice {
  id: string;
  evidenceId: string;
  name: string;
  /** "Uploaded by <name>". */
  provenance: string;
  /** "lines corrected by <who>" and/or "lines transcribed manually by <who>" (joined by " · "), when any line was. */
  corrected: string | null;
  /** A sentence that will be sent cites it. */
  cited: boolean;
  /** Proposed: ticked when cited. */
  selected: boolean;
  sha256: string | null;
}

/** The confirmed uploads to offer as attachments, in evidence order: the cited ones pre-selected. */
export function attachmentChoices(uploads: readonly UploadRecordView[], views: readonly SentenceView[]): AttachmentChoice[] {
  const cited = new Set(views.filter((v) => v.state === 'supported').flatMap((v) => v.citations.map((c) => c.evidenceId)));
  return confirmedUploads(uploads).map((u) => {
    // From the document (a PDF's lines are in its pages, not in `lines`), as the analysis read it.
    const who = (k: 'corrected' | 'transcribed') => [...new Set(u.document!.lines.map((l) => l[k]).filter((x): x is string => !!x))];
    const corrected = [who('corrected'), who('transcribed')].flatMap((by, i) => (by.length ? [`lines ${i ? 'transcribed manually' : 'corrected'} by ${by.join(', ')}`] : []));
    const isCited = cited.has(u.evidenceId!);
    return { id: u.id, evidenceId: u.evidenceId!, name: u.name, provenance: `Uploaded by ${u.uploadedBy.name}`, corrected: corrected.length ? corrected.join(' · ') : null, cited: isCited, selected: isCited, sha256: u.sha256 ?? null };
  });
}

/**
 * A rectangle dragged from `a` to `b` on the image as displayed (`shown`, CSS pixels from its top-left corner), in
 * whole pixels of the image itself (`natural`), clipped to it; null when it covers no area.
 */
export function toImageRect(a: { x: number; y: number }, b: { x: number; y: number }, shown: { width: number; height: number }, natural: { width: number; height: number }): Rect | null {
  if (!shown.width || !shown.height) return null;
  const sx = natural.width / shown.width;
  const sy = natural.height / shown.height;
  const clip = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  const x0 = Math.floor(clip(Math.min(a.x, b.x) * sx, natural.width));
  const y0 = Math.floor(clip(Math.min(a.y, b.y) * sy, natural.height));
  const x1 = Math.ceil(clip(Math.max(a.x, b.x) * sx, natural.width));
  const y1 = Math.ceil(clip(Math.max(a.y, b.y) * sy, natural.height));
  return x1 - x0 >= 2 && y1 - y0 >= 2 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** The spans with one more, sorted; overlapping or touching spans merge (as the server does). An empty span adds nothing. */
export function mergeRemoval(spans: readonly TextRemoval[], add: TextRemoval): TextRemoval[] {
  const all = add.end > add.start ? [...spans, add] : [...spans];
  const sorted = all.map((s) => ({ ...s })).sort((x, y) => x.start - y.start);
  const out: TextRemoval[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push(s);
  }
  return out;
}
