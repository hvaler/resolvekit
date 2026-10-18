/**
 * Pure helpers of the PDF upload in the web app: choosing the pages of a long document, and following the job that
 * renders and reads them (apps/server/src/uploads, `pdf.job`). Copy as the spec words it.
 */
import { listRetryDelay, pageLabel, type PdfJob, type UploadRecordView } from './uploads';

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
