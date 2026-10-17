/**
 * Merchant evidence uploads (`/api/cases/:id/uploads…` on the ResolveKit server, apps/server/src/uploads/routes.ts):
 * the client, and how a confirmed upload takes part in the case — an evidence card with its provenance, a document of
 * the analyst's input (exactly the server's), corrected lines a sentence must have confirmed, and an attachment the
 * merchant chooses in the final review. Nothing here reads or keeps an upload's content beyond what the server returns.
 */
import type { AnalysisDocument, AnalysisInput } from '@resolvekit/analyst';
import { correctionPair, correctionsOf, type Correction } from './draft';
import type { IntentRequest } from './intent';
import { utcStamp } from './time';
import type { ContradictionResolution, Evidence, EvidenceType, SentenceView } from './types';

/** An area to cover, in whole pixels of the uploaded image. */
export interface Rect { x: number; y: number; w: number; h: number }
/** A span of pasted text to remove, as UTF-16 offsets into it (`end` exclusive). */
export interface TextRemoval { start: number; end: number }

export type UploadStatus = 'pending' | 'reviewing' | 'confirmed';

/** An upload as the server shows it to the seller's workspace (no workspace id, no analysis keys). */
export interface UploadRecordView {
  id: string;
  caseId: string;
  boundDisputeId: string | null;
  /** E7…, set at confirmation. */
  evidenceId: string | null;
  kind: 'image' | 'text';
  name: string;
  uploadedBy: { id: string; label: string; name: string };
  status: UploadStatus;
  rects: Rect[];
  removals: TextRemoval[];
  /** Read again from the sanitised file (after a redaction). */
  readLines: string[];
  lines: { text: string; correctedBy: string | null; original: string | null }[];
  /** Of the stored sanitised file. */
  sha256: string | null;
  size: number | null;
  mime: 'image/png' | 'application/pdf' | null;
  createdAt: string;
  expiresAt: string;
  confirmedAt: string | null;
  /** The analyst's document of a confirmed upload (lines, fragment keys, corrections); null before confirmation. */
  document: AnalysisDocument | null;
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
    listUploads: async () => (await call<{ uploads: UploadRecordView[] }>('', { method: 'GET' }, 15_000)).uploads,
    /** A PNG or JPEG, sent as is; the server reads its text locally (OCR). */
    uploadImage: (file: File) => call<ReadAnswer>('', { method: 'POST', headers: { 'content-type': file.type || 'image/png', 'x-upload-name': encodeURIComponent(file.name) }, body: file }),
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

const evidenceNumber = (id: string | null) => Number(/^E(\d+)$/.exec(id ?? '')?.[1] ?? 0);

/** The confirmed uploads (those with a document), in evidence order. */
export function confirmedUploads(uploads: readonly UploadRecordView[]): UploadRecordView[] {
  return uploads.filter((u) => u.status === 'confirmed' && u.document && evidenceNumber(u.evidenceId) > 0).sort((a, b) => evidenceNumber(a.evidenceId) - evidenceNumber(b.evidenceId));
}

/** A confirmed upload as an evidence card: the server's lines and fragments, who uploaded it, who corrected what. */
export function uploadEvidence(r: UploadRecordView): Evidence {
  const doc = r.document!;
  return {
    id: doc.id,
    short: r.name,
    title: r.name,
    meta: { type: doc.type, tag: doc.tag, source: doc.source, received: r.confirmedAt ? utcStamp(new Date(r.confirmedAt)) : '', hash: r.sha256 ?? '' },
    sourceLabel: { kind: 'upload', text: `Uploaded by ${r.uploadedBy.name}` },
    body: { kind: 'lines', lines: doc.lines.map((l) => ({ text: l.text, ...(l.fragment ? { fragment: l.fragment } : {}), ...(l.corrected ? { corrected: l.corrected } : {}) })) },
  };
}

/** The analyst's input with the confirmed uploads' documents after the case's own: what the server analyses. */
export function withUploadDocuments(input: AnalysisInput, uploads: readonly UploadRecordView[]): AnalysisInput {
  const docs = confirmedUploads(uploads).map((u) => u.document!);
  return docs.length ? { ...input, documents: [...input.documents, ...docs] } : input;
}

/** The corrected lines of the confirmed uploads, by fragment key (as the server derives them from its input). */
export function uploadCorrections(uploads: readonly UploadRecordView[]): Map<string, Correction> {
  return correctionsOf(confirmedUploads(uploads).map((u) => u.document!));
}

/** Evidence ids of confirmed uploads that the analysis on screen did not read (none ready: all of them). */
export function notAnalysed(uploads: readonly UploadRecordView[], analysed: AnalysisInput | null): string[] {
  const read = new Set(analysed?.documents.map((d) => d.id) ?? []);
  return confirmedUploads(uploads).map((u) => u.evidenceId!).filter((id) => !read.has(id));
}

const DEPENDS = 'Why: it depends on your correction';

/** The corrected lines this sentence is held back on until the merchant confirms them (in citation order). */
export function correctionsToConfirm(view: SentenceView, corrections: ReadonlyMap<string, Correction>, confirmed: ReadonlySet<string>): Correction[] {
  if (view.state !== 'needs_review' || !view.reason?.startsWith(DEPENDS)) return [];
  const out: Correction[] = [];
  for (const c of view.citations) {
    for (const f of c.fragments) {
      const k = corrections.get(f);
      if (k && !out.includes(k) && !confirmed.has(correctionPair(view.id, f))) out.push(k);
    }
  }
  return out;
}

/** The pairs without those of `sentenceId` (its text changed: what it relies on must be confirmed again). */
export const dropPairsOf = (pairs: readonly string[], sentenceId: string): string[] => pairs.filter((p) => !p.startsWith(`${sentenceId}@`));

/** The confirmed pairs that still mean something: a sentence to be sent citing that corrected line. */
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

/** One confirmed upload offered as an attachment in the final review. */
export interface AttachmentChoice {
  id: string;
  evidenceId: string;
  name: string;
  /** "Uploaded by <name>". */
  provenance: string;
  /** "lines corrected by <who>" when any line was corrected by hand. */
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
    const by = [...new Set(u.lines.map((l) => l.correctedBy).filter((x): x is string => !!x))];
    const isCited = cited.has(u.evidenceId!);
    return { id: u.id, evidenceId: u.evidenceId!, name: u.name, provenance: `Uploaded by ${u.uploadedBy.name}`, corrected: by.length ? `lines corrected by ${by.join(', ')}` : null, cited: isCited, selected: isCited, sha256: u.sha256 };
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
