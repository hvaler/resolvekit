import { describe, expect, it } from 'vitest';
import { PDF_MAX_SELECTED, SELECTION_WARNING, STUCK_COPY, STUCK_MS, canPick, initialPoll, jobLabel, jobSettled, pickedLabel, pollDelay, pollStep, runningJobs, selectionCopy, thumbsReady, togglePick, wakeDelay } from './pdfReview';

describe('choosing the pages of a long PDF', () => {
  it('says how many pages the document has and how many can be chosen (verbatim)', () => {
    expect(selectionCopy(12)).toBe('This document has 12 pages. Choose up to 5 to add as evidence.');
    expect(SELECTION_WARNING).toBe("Keep the context the dispute needs: don't leave out pages with relevant or contradicting information.");
  });

  it('takes at most 5 picks, but a picked page can always be dropped', () => {
    expect(PDF_MAX_SELECTED).toBe(5);
    expect(canPick([], 3)).toBe(true);
    expect(canPick([1, 2, 3, 4], 9)).toBe(true);
    expect(canPick([1, 2, 3, 4, 5], 9)).toBe(false);
    expect(canPick([1, 2, 3, 4, 5], 5)).toBe(true);
  });

  it('toggles a page in the original order and never goes past 5', () => {
    expect(togglePick([8, 2], 5)).toEqual([2, 5, 8]);
    expect(togglePick([2, 5, 8], 5)).toEqual([2, 8]);
    expect(togglePick([1, 2, 3, 4, 5], 9)).toEqual([1, 2, 3, 4, 5]);
  });

  it('labels a pick with its number in the original document', () => {
    expect(pickedLabel(8)).toBe('Page 8 of the original document');
  });
});

describe('following a PDF job', () => {
  it('labels the job', () => {
    expect(jobLabel({ state: 'rendering', page: 0, of: 3 })).toBe('Preparing pages…');
    expect(jobLabel({ state: 'reading', page: 2, of: 3 })).toBe('Reading page 2 of 3…');
    expect(jobLabel({ state: 'reading', page: 0, of: 3 })).toBe('Reading page 1 of 3…');
    expect(jobLabel({ state: 'failed', error: 'Reading this PDF failed.' })).toBe('Failed: Reading this PDF failed.');
    expect(jobLabel({ state: 'failed' })).toBe('Failed: reading this PDF did not finish. Discard it and upload it again.');
  });

  it('stops polling at reviewing or failed (and while waiting for a selection), not before', () => {
    expect(jobSettled({ state: 'reviewing' })).toBe(true);
    expect(jobSettled({ state: 'failed' })).toBe(true);
    expect(jobSettled({ state: 'selecting', page: undefined })).toBe(true);
    expect(jobSettled({ state: 'selecting', page: 3, of: 12 })).toBe(false);
    expect(jobSettled({ state: 'rendering' })).toBe(false);
    expect(jobSettled({ state: 'reading', page: 1, of: 2 })).toBe(false);
  });

  it('backs off from a second to five seconds and keeps polling', () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(pollDelay)).toEqual([1000, 1500, 2000, 3000, 5000, 5000, 5000]);
  });
});

describe('long PDFs wait for their thumbnails', () => {
  it('opens the page step only when every thumbnail exists, and lets no page be picked before', () => {
    expect(thumbsReady({ state: 'selecting', page: 0, of: 12 })).toBe(false);
    expect(thumbsReady({ state: 'selecting', page: 7, of: 12 })).toBe(false);
    expect(thumbsReady({ state: 'selecting' })).toBe(true);
    expect(thumbsReady({ state: 'reading', page: 1, of: 2 })).toBe(false);
  });

  it('labels the wait, and a settled selection as waiting for the person', () => {
    expect(jobLabel({ state: 'selecting', page: 7, of: 12 })).toBe('Preparing thumbnails (7 of 12)…');
    expect(jobLabel({ state: 'selecting', page: 0, of: 12 })).toBe('Preparing pages…');
    expect(jobLabel({ state: 'selecting' })).toBe('Waiting for the pages to be chosen');
  });
});

describe('polling a running job (one timer, with backoff)', () => {
  const T0 = 1_000_000;
  const job = (page: number) => ({ u1: `reading:${page}/3` });

  it('asks again soon while the job moves, and stops by itself when nothing runs', () => {
    let s = pollStep(initialPoll(), { type: 'ok', jobs: job(1), now: T0 });
    expect(s.delay).toBe(1000);
    s = pollStep(s.state, { type: 'ok', jobs: job(2), now: T0 + 1000 });
    expect(s.delay).toBe(1000);
    s = pollStep(s.state, { type: 'ok', jobs: {}, now: T0 + 2000 });
    expect(s).toMatchObject({ delay: null, stuck: false });
  });

  it('backs off while the job does not move, and a finished upload does not restart the backoff', () => {
    let s = pollStep(initialPoll(), { type: 'ok', jobs: { a: 'reading:1/3', b: 'reading:1/3' }, now: T0 });
    const delays: (number | null)[] = [];
    for (let i = 1; i <= 5; i++) {
      s = pollStep(s.state, { type: 'ok', jobs: { a: 'reading:1/3', b: 'reading:1/3' }, now: T0 + i * 1000 });
      delays.push(s.delay);
    }
    expect(delays).toEqual([1500, 2000, 3000, 5000, 5000]);
    // b finished: a is unchanged, so the schedule goes on (not back to 1 s).
    expect(pollStep(s.state, { type: 'ok', jobs: { a: 'reading:1/3' }, now: T0 + 7000 }).delay).toBe(5000);
    // a moved: back to the start.
    expect(pollStep(s.state, { type: 'ok', jobs: { a: 'reading:2/3', b: 'reading:1/3' }, now: T0 + 7000 }).delay).toBe(1000);
  });

  it('gives up on a job that makes no progress for 5 minutes', () => {
    let s = pollStep(initialPoll(), { type: 'ok', jobs: job(1), now: T0 });
    s = pollStep(s.state, { type: 'ok', jobs: job(1), now: T0 + STUCK_MS - 1 });
    expect(s.stuck).toBe(false);
    s = pollStep(s.state, { type: 'ok', jobs: job(1), now: T0 + STUCK_MS });
    expect(s).toMatchObject({ delay: null, stuck: true });
    expect(STUCK_COPY).toBe('Reading is taking longer than expected. Reload the page to check again.');
  });

  it('retries a failed request with phase 1’s delays, then gives up, and never on 401 or 403', () => {
    let s = pollStep(initialPoll(), { type: 'ok', jobs: job(1), now: T0 });
    const delays: (number | null)[] = [];
    for (let i = 0; i < 8; i++) {
      s = pollStep(s.state, { type: 'error', status: 502, now: T0 + i });
      delays.push(s.delay);
    }
    expect(delays).toEqual([2000, 5000, 10000, 20000, 30000, 30000, 30000, null]);
    expect(pollStep(initialPoll(), { type: 'error', status: 401, now: T0 })).toMatchObject({ delay: null });
    expect(pollStep(initialPoll(), { type: 'error', status: 403, now: T0 })).toMatchObject({ delay: null });
  });

  it('a good answer after errors starts the error backoff over', () => {
    let s = pollStep(initialPoll(), { type: 'error', status: 0, now: T0 });
    s = pollStep(s.state, { type: 'ok', jobs: job(1), now: T0 + 1 });
    expect(pollStep(s.state, { type: 'error', status: 0, now: T0 + 2 }).delay).toBe(2000);
  });

  it('runningJobs lists only the uploads whose job is still moving', () => {
    const up = (id: string, job: { state: 'reading' | 'reviewing' | 'selecting'; page?: number; of?: number }) => ({ id, pdf: { pageCount: 3, selected: null, job } }) as never;
    expect(runningJobs([up('a', { state: 'reading', page: 2, of: 3 }), up('b', { state: 'reviewing' }), up('c', { state: 'selecting' }), { id: 'd' } as never])).toEqual({ a: 'reading:2/3' });
  });
});

describe('waking the timer for a job that starts after the first load', () => {
  it('a put of a running PDF arms a poll when none is pending, a finished one does not', () => {
    expect(wakeDelay(false, { u1: 'rendering:0/3' })).toBe(1000);
    expect(wakeDelay(false, {})).toBeNull();
  });

  it('never makes a second timer: one pending (or a request in flight) wins, however many puts', () => {
    expect(wakeDelay(true, { u1: 'rendering:0/3' })).toBeNull();
    expect(wakeDelay(true, { u1: 'rendering:0/3', u2: 'reading:1/2' })).toBeNull();
  });
});
