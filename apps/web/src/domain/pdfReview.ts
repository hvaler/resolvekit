/**
 * Pure helpers of the PDF upload in the web app: choosing the pages of a long document, and following the job that
 * renders and reads them (apps/server/src/uploads, `pdf.job`). Copy as the spec words it.
 */
import { pageLabel, type PdfJob } from './uploads';

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
  if (job.state === 'reading') return `Reading page ${Math.max(job.page ?? 0, 1)} of ${job.of ?? '?'}…`;
  return 'Preparing pages…';
}

/** Whether there is nothing to wait for: reviewing, failed, or a long document whose thumbnails are done, waiting for its pages to be chosen. */
export const jobSettled = (job: PdfJob): boolean => job.state === 'reviewing' || job.state === 'failed' || (job.state === 'selecting' && job.page === undefined);

/** Delay before asking for the job again: 1, 1.5, 2, 3 s, then every 5 s (a read of 5 pages can take minutes; never gives up). */
export function pollDelay(attempt: number): number {
  return [1_000, 1_500, 2_000, 3_000][attempt] ?? 5_000;
}
