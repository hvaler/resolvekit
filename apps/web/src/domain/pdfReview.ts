/**
 * Pure helpers of the PDF upload in the web app: choosing the pages of a long document, following the job that
 * renders and reads them (apps/server/src/uploads, `pdf.job`), and reviewing each page (cover, correct, transcribe)
 * before confirming. Copy as the spec words it.
 */
import { listRetryDelay, pageLabel, type PdfJob, type PdfPageView, type Rect, type UploadRecordView } from './uploads';

/** The most pages of a document that can be added as evidence (the server's `PDF_MAX_SELECTED`). */
export const PDF_MAX_SELECTED = 5;

/** `This document has 12 pages. Choose up to 5 to add as evidence.` */
export const selectionCopy = (n: number) => `This document has ${n} pages. Choose up to ${PDF_MAX_SELECTED} to add as evidence.`;

export const SELECTION_WARNING = "Keep the context the dispute needs: don't leave out pages with relevant or contradicting information.";

/** Whether page `n` can be toggled: a picked page can always be dropped, a new one needs room (at most 5). */
export const canPick = (selected: readonly number[], n: number): boolean => selected.includes(n) || selected.length < PDF_MAX_SELECTED;

/** The picks with `n` toggled, in the original page order; unchanged when there is no room. */
export function togglePick(selected: readonly number[], n: number): number[] {
  if (!canPick(selected, n)) return [...selected];
  return (selected.includes(n) ? selected.filter((p) => p !== n) : [...selected, n]).sort((a, b) => a - b);
}

/** A pick by its number in the original document: `Page 8 of the original document`. */
export const pickedLabel = (orig: number): string => pageLabel(orig);

/** What the job is doing now: `Preparing pages…`, `Reading page 2 of 3…`, `Failed: <why>`. */
export function jobLabel(job: PdfJob): string {
  if (job.state === 'failed') return `Failed: ${job.error ?? 'reading this PDF did not finish. Discard it and upload it again.'}`;
  if (job.state === 'selecting') return job.page ? `Preparing thumbnails (${job.page} of ${job.of ?? '?'})…` : job.page === undefined ? 'Waiting for the pages to be chosen' : 'Preparing pages…';
  if (job.state === 'reading') return `Reading page ${Math.max(job.page ?? 0, 1)} of ${job.of ?? '?'}…`;
  return 'Preparing pages…';
}

/** Whether there is nothing to wait for: reviewing, failed, or a long document whose thumbnails are done, waiting for its pages to be chosen. */
export const jobSettled = (job: PdfJob): boolean => job.state === 'reviewing' || job.state === 'failed' || (job.state === 'selecting' && job.page === undefined);

/** Delay before asking for the job again: 1, 1.5, 2, 3 s, then every 5 s (a read of 5 pages can take minutes; never gives up). */
export function pollDelay(attempt: number): number {
  return [1_000, 1_500, 2_000, 3_000][attempt] ?? 5_000;
}

/** A long document's thumbnails are all made: the job is `selecting` with no `page` (it carries one while they are made). */
export const thumbsReady = (job: PdfJob): boolean => job.state === 'selecting' && job.page === undefined;

/** A job that has not moved for this long is given up on (a page render is cut at 20 s, five pages and their reading take minutes). */
export const STUCK_MS = 5 * 60_000;
export const STUCK_COPY = 'Reading is taking longer than expected. Reload the page to check again.';

/** Where the single polling timer is: failures in a row, polls without progress, each running job as last seen, and since when it did not move. */
export interface PollState {
  errors: number;
  polls: number;
  seen: Readonly<Record<string, string>>;
  since: number | null;
}
export const initialPoll = (): PollState => ({ errors: 0, polls: 0, seen: {}, since: null });

/** The running PDF jobs of a list, each as `state:page/of` (what changes when it moves). */
export function runningJobs(uploads: readonly UploadRecordView[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const u of uploads) if (u.pdf && !jobSettled(u.pdf.job)) out[u.id] = `${u.pdf.job.state}:${u.pdf.job.page ?? 0}/${u.pdf.job.of ?? 0}`;
  return out;
}

export type PollEvent = { type: 'ok'; jobs: Readonly<Record<string, string>>; now: number } | { type: 'error'; status: number; now: number };

/**
 * What the list timer does after a request. A good answer with a job running: ask again after `pollDelay`, starting
 * over only when a running job moved (a finished upload does not restart it), and stop (`stuck`) after STUCK_MS
 * without progress; nothing running: stop. A failure: phase 1's `listRetryDelay` (null: give up); 401 or 403: stop.
 */
export function pollStep(s: PollState, e: PollEvent): { state: PollState; delay: number | null; stuck: boolean } {
  if (e.type === 'error') {
    if (e.status === 401 || e.status === 403) return { state: s, delay: null, stuck: false };
    return { state: { ...s, errors: s.errors + 1 }, delay: listRetryDelay(s.errors), stuck: false };
  }
  if (!Object.keys(e.jobs).length) return { state: initialPoll(), delay: null, stuck: false };
  const moved = Object.entries(e.jobs).some(([id, k]) => s.seen[id] !== k);
  const polls = moved ? 0 : s.polls + 1;
  const since = moved || s.since === null ? e.now : s.since;
  const state = { errors: 0, polls, seen: e.jobs, since };
  if (e.now - since >= STUCK_MS) return { state, delay: null, stuck: true };
  return { state, delay: pollDelay(polls), stuck: false };
}

/**
 * A running job appeared (a PDF just added or selected, put in the list without a reload) and the timer is not
 * armed: when to ask first. `timerBusy`: a timer is pending or a request is in flight, which arms the next poll
 * itself, so there is never a second timer. The error backoff is not touched.
 */
export const wakeDelay = (timerBusy: boolean, jobs: Readonly<Record<string, string>>): number | null => (timerBusy || !Object.keys(jobs).length ? null : pollDelay(0));

export const BARCODE_WARNING = "Covering the text next to a barcode or QR code doesn't hide what the code contains. Cover the code too if it carries data you don't want to share.";
export const NO_TEXT_COPY = "No text was read on this page. Transcribe what matters, or the analyst can't use it.";
export const HINT_LABEL = 'Text found in the PDF (a hint for your review; never stored or sent)';
/** The server's refusal of a transcription under a cover (422 BAD_TRANSCRIPTION), said before it is sent. */
export const FROM_COVER = 'A transcribed line cannot come from a covered area.';

/** Whether two areas share a positive area: edges that only touch, or an empty cover, do not (the server's rule). */
const overlaps = (a: Rect, b: Rect) => b.w > 0 && b.h > 0 && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** An area marked for a transcribed line: refused when it overlaps a cover (what is under a cover is never typed in). */
export function transcriptionArea(rect: Rect, covers: readonly Rect[]): { area: Rect } | { error: string } {
  return covers.some((c) => overlaps(rect, c)) ? { error: FROM_COVER } : { area: rect };
}

/** One page as the merchant is reviewing it in the browser: covers as drawn now, lines as corrected, lines typed in. */
export interface PageDraft {
  rects: Rect[];
  lines: string[];
  added: { area: Rect; text: string }[];
}

/** A page with the server's view of it and the merchant's draft. */
export interface ReviewedPage {
  view: PdfPageView;
  draft: PageDraft;
}

/** A page's draft as the server has it: its covers, the lines it read (uncorrected), nothing typed in yet. */
export const pageDraftOf = (p: PdfPageView): PageDraft => ({ rects: p.rects.map((r) => ({ ...r })), lines: [...p.readLines], added: p.added.map(({ area, text }) => ({ area: { ...area }, text })) });

/**
 * After the server covered the page again and read it (`page`, its new view): the covers are the server's, the lines
 * start over (they are new), the typed ones stay (one now under a cover blocks the confirmation, {@link pdfBlocker}).
 */
export const afterCover = (d: PageDraft, page: PdfPageView): PageDraft => ({ ...pageDraftOf(page), added: d.added });

const sameRects = (a: readonly Rect[], b: readonly Rect[]) => JSON.stringify(a) === JSON.stringify(b);

/** `uncovered`: never through the cover step; `stale`: covers drawn since; `covered`: read with the covers as drawn. */
export function pageState(view: PdfPageView, draft: PageDraft): 'uncovered' | 'stale' | 'covered' {
  if (!view.sha256) return 'uncovered';
  return sameRects(draft.rects, view.rects) ? 'covered' : 'stale';
}

/** Why the PDF cannot be confirmed yet (the first reason, page by page), or null. */
export function pdfBlocker(pages: readonly ReviewedPage[]): string | null {
  for (const { view, draft } of pages) {
    const page = `page ${view.original} of the original document`;
    const state = pageState(view, draft);
    if (state === 'uncovered') return `Cover ${page} first, even if nothing needs covering.`;
    if (state === 'stale') return `You changed what is covered on ${page}: cover it again before confirming.`;
    if (draft.added.some((a) => !a.text.trim())) return `Type the text of each transcribed line on ${page}, or remove it.`;
    if (draft.added.some((a) => 'error' in transcriptionArea(a.area, view.rects))) return FROM_COVER;
  }
  return null;
}

/** The confirmation: one entry per selected page, in order, against the covered page it was reviewed on; null while blocked. */
export function confirmPayload(pages: readonly ReviewedPage[]): { lines: string[]; added: { area: Rect; text: string }[]; sha256: string }[] | null {
  if (pdfBlocker(pages)) return null;
  return pages.map(({ view, draft }) => ({ lines: [...draft.lines], added: draft.added.map((a) => ({ area: { ...a.area }, text: a.text.trim() })), sha256: view.sha256! }));
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The pages that go into the evidence, as listed before confirming: `Page 2 of the original document · 2 lines read, 1 corrected`. */
export function includedPages(pages: readonly ReviewedPage[]): string[] {
  return pages.map(({ view, draft }) => {
    const corrected = draft.lines.filter((l, i) => l !== view.readLines[i]).length;
    const text = [
      draft.lines.length ? `${count(draft.lines.length, 'line')} read${corrected ? `, ${corrected} corrected` : ''}` : '',
      draft.added.length ? `${count(draft.added.length, 'line')} transcribed` : '',
    ].filter(Boolean);
    return [pageLabel(view.original), ...(draft.rects.length ? [`${count(draft.rects.length, 'area')} covered`] : []), ...(text.length ? text : ['no text'])].join(' · ');
  });
}

/** `Page 8 of the original document changed; check it again.` */
export const pageChangedCopy = (orig: number) => `${pageLabel(orig)} changed; check it again.`;

/**
 * The drafts once the server's pages are read again (after a 409 UPLOAD_CHANGED, or when a kept review is reopened).
 * A page the server still has as reviewed keeps everything the merchant typed and drew. A changed page takes the
 * server's covers and lines: a correction is kept where its line still reads the same, a transcription where it is
 * outside the new covers; the merchant is told which pages changed. Another selection starts over.
 */
export function mergeAfterChange(pages: readonly ReviewedPage[], fresh: readonly PdfPageView[]): { drafts: PageDraft[]; changed: number[]; notice: string | null } {
  const changed: number[] = [];
  const drafts = fresh.map((f, i) => {
    const old = pages[i];
    if (!old || old.view.original !== f.original) {
      changed.push(f.original);
      return pageDraftOf(f);
    }
    const { view, draft } = old;
    if (view.sha256 === f.sha256 && sameRects(view.rects, f.rects) && JSON.stringify(view.readLines) === JSON.stringify(f.readLines)) return draft;
    changed.push(f.original);
    return {
      rects: f.rects.map((r) => ({ ...r })),
      lines: f.readLines.map((l, j) => (view.readLines[j] === l && draft.lines[j] !== undefined ? draft.lines[j]! : l)),
      added: draft.added.filter((a) => 'area' in transcriptionArea(a.area, f.rects)),
    };
  });
  return { drafts, changed, notice: changed.length ? changed.map(pageChangedCopy).join(' ') : null };
}

/** Whether anything the merchant typed or drew is not confirmed yet (closing asks first; discarding loses it). */
export const hasTypedWork = (pages: readonly ReviewedPage[]): boolean =>
  pages.some(({ view, draft }) => draft.added.length > 0 || !sameRects(draft.rects, view.rects) || draft.lines.some((l, i) => l !== view.readLines[i]));

/**
 * Open reviews by upload id, in this page's memory only (never in browser storage, never sent): closing and reopening
 * the review in the same session keeps what was typed. Forgotten when the upload is confirmed or discarded.
 */
const kept = new Map<string, ReviewedPage[]>();
export const keepReview = (uploadId: string, pages: readonly ReviewedPage[]) => void kept.set(uploadId, [...pages]);
export const keptReview = (uploadId: string): ReviewedPage[] | null => kept.get(uploadId) ?? null;
export const forgetReview = (uploadId: string) => void kept.delete(uploadId);
