import { describe, expect, it } from 'vitest';
import {
  BARCODE_WARNING,
  FROM_COVER,
  HINT_LABEL,
  NO_TEXT_COPY,
  PDF_MAX_SELECTED,
  SELECTION_WARNING,
  STUCK_COPY,
  STUCK_MS,
  afterCover,
  canPick,
  clearKeptReviews,
  confirmPayload,
  forgetReview,
  hasTypedWork,
  keepReview,
  keptReview,
  mergeAfterChange,
  type PageDraft,
  includedPages,
  initialPoll,
  jobLabel,
  jobSettled,
  pageDraftOf,
  pageState,
  pdfBlocker,
  reviewsBelongTo,
  pickedLabel,
  pollDelay,
  pollStep,
  runningJobs,
  selectionCopy,
  thumbsReady,
  togglePick,
  transcriptionArea,
  wakeDelay,
} from './pdfReview';
import { pageLabel, type PdfPageView } from './uploads';

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

describe('reviewing the pages of a PDF', () => {
  const SHA = (c: string) => c.repeat(64);
  const view = (over: Partial<PdfPageView> = {}): PdfPageView => ({ original: 2, rects: [], readLines: ['INVOICE 2026-114', 'Total 89.00 USD'], lines: [], added: [], sha256: SHA('a'), ...over });
  const cover = { x: 10, y: 10, w: 100, h: 40 };

  it('says the copy of a page verbatim', () => {
    expect(BARCODE_WARNING).toBe("Covering the text next to a barcode or QR code doesn't hide what the code contains. Cover the code too if it carries data you don't want to share.");
    expect(NO_TEXT_COPY).toBe("No text was read on this page. Transcribe what matters, or the analyst can't use it.");
    expect(HINT_LABEL).toBe('Text found in the PDF (a hint for your review; never stored or sent)');
    expect(FROM_COVER).toBe('A transcribed line cannot come from a covered area.');
    expect(pageLabel(8)).toBe('Page 8 of the original document');
  });

  it('refuses a transcription area that overlaps a cover, accepts one beside or inside the uncovered page', () => {
    expect(transcriptionArea({ x: 50, y: 30, w: 80, h: 20 }, [cover])).toEqual({ error: 'A transcribed line cannot come from a covered area.' });
    expect(transcriptionArea({ x: 0, y: 0, w: 300, h: 300 }, [cover])).toEqual({ error: FROM_COVER });
    expect(transcriptionArea({ x: 20, y: 20, w: 10, h: 10 }, [cover])).toEqual({ error: FROM_COVER });
    // Touching an edge is not overlapping (the server's rule), and an empty cover covers nothing.
    expect(transcriptionArea({ x: 110, y: 10, w: 50, h: 20 }, [cover])).toEqual({ area: { x: 110, y: 10, w: 50, h: 20 } });
    expect(transcriptionArea({ x: 10, y: 60, w: 50, h: 20 }, [cover, { x: 0, y: 0, w: 0, h: 0 }])).toEqual({ area: { x: 10, y: 60, w: 50, h: 20 } });
    expect(transcriptionArea({ x: 10, y: 60, w: 50, h: 20 }, [])).toEqual({ area: { x: 10, y: 60, w: 50, h: 20 } });
  });

  it('starts a page from what the server read, and keeps the transcriptions when the page is covered again', () => {
    const d = pageDraftOf(view({ rects: [cover] }));
    expect(d).toEqual({ rects: [cover], lines: ['INVOICE 2026-114', 'Total 89.00 USD'], added: [] });
    const withText = { ...d, lines: ['INVOICE 2026-114', 'Total 98.00 USD'], added: [{ area: { x: 200, y: 200, w: 50, h: 10 }, text: 'Signed' }] };
    expect(afterCover(withText, view({ rects: [cover], readLines: ['INVOICE 2026-114'], sha256: 'b'.repeat(64) }))).toEqual({ rects: [cover], lines: ['INVOICE 2026-114'], added: withText.added });
  });

  it('a page is covered once the server read it with the covers as drawn now', () => {
    expect(pageState(view({ sha256: null }), pageDraftOf(view({ sha256: null })))).toBe('uncovered');
    expect(pageState(view(), pageDraftOf(view()))).toBe('covered');
    expect(pageState(view(), { ...pageDraftOf(view()), rects: [cover] })).toBe('stale');
  });

  it('confirms only when every page is covered as drawn and every transcription is typed and outside the covers', () => {
    const p1 = { view: view(), draft: pageDraftOf(view()) };
    const p2v = view({ original: 8, rects: [cover], readLines: [], sha256: SHA('b') });
    const p2 = { view: p2v, draft: pageDraftOf(p2v) };
    expect(pdfBlocker([p1, p2])).toBeNull();
    expect(pdfBlocker([p1, { view: view({ original: 8, sha256: null }), draft: pageDraftOf(view({ sha256: null })) }])).toBe('Cover page 8 of the original document first, even if nothing needs covering.');
    expect(pdfBlocker([{ ...p1, draft: { ...p1.draft, rects: [cover] } }, p2])).toBe('You changed what is covered on page 2 of the original document: cover it again before confirming.');
    expect(pdfBlocker([p1, { ...p2, draft: { ...p2.draft, added: [{ area: { x: 300, y: 300, w: 20, h: 20 }, text: '  ' }] } }])).toBe('Type the text of each transcribed line on page 8 of the original document, or remove it.');
    expect(pdfBlocker([p1, { ...p2, draft: { ...p2.draft, added: [{ area: { x: 20, y: 20, w: 20, h: 20 }, text: 'x' }] } }])).toBe(FROM_COVER);
    expect(confirmPayload([p1, { ...p2, draft: { ...p2.draft, added: [{ area: { x: 20, y: 20, w: 20, h: 20 }, text: 'x' }] } }])).toBeNull();
  });

  it('sends one entry per page, in order, with its reviewed lines, transcriptions and sha256', () => {
    const p1 = { view: view(), draft: { ...pageDraftOf(view()), lines: ['INVOICE 2026-114', 'Total 98.00 USD'] } };
    const p2v = view({ original: 8, rects: [cover], readLines: [], sha256: SHA('b') });
    const p2 = { view: p2v, draft: { ...pageDraftOf(p2v), added: [{ area: { x: 200, y: 200, w: 50, h: 10 }, text: ' Signed by J. D. ' }] } };
    expect(confirmPayload([p1, p2])).toEqual([
      { lines: ['INVOICE 2026-114', 'Total 98.00 USD'], added: [], sha256: SHA('a') },
      { lines: [], added: [{ area: { x: 200, y: 200, w: 50, h: 10 }, text: 'Signed by J. D.' }], sha256: SHA('b') },
    ]);
  });

  it('lists the pages included before confirming, with what was corrected and transcribed', () => {
    const p1 = { view: view(), draft: { ...pageDraftOf(view()), lines: ['INVOICE 2026-114', 'Total 98.00 USD'] } };
    const p2v = view({ original: 8, rects: [cover], readLines: [], sha256: SHA('b') });
    const p2 = { view: p2v, draft: { ...pageDraftOf(p2v), added: [{ area: { x: 200, y: 200, w: 50, h: 10 }, text: 'Signed' }] } };
    const p3v = view({ original: 9, readLines: [], sha256: SHA('c') });
    expect(includedPages([p1, p2, { view: p3v, draft: pageDraftOf(p3v) }])).toEqual([
      'Page 2 of the original document · 2 lines read, 1 corrected',
      'Page 8 of the original document · 1 area covered · 1 line transcribed',
      'Page 9 of the original document · no text',
    ]);
  });
});

describe('a page that changed on the server (409 UPLOAD_CHANGED, or a review reopened)', () => {
  const SHA = (c: string) => c.repeat(64);
  const cover = { x: 10, y: 10, w: 100, h: 40 };
  const v = (over: Partial<PdfPageView> = {}): PdfPageView => ({ original: 2, rects: [], readLines: ['INVOICE 2026-114', 'Total 89.00 USD'], lines: [], added: [], sha256: SHA('a'), ...over });
  const typed = (view: PdfPageView): PageDraft => ({ ...pageDraftOf(view), lines: ['INVOICE 2026-114', 'Total 98.00 USD'], added: [{ area: { x: 200, y: 200, w: 50, h: 10 }, text: 'Signed' }, { area: { x: 20, y: 20, w: 20, h: 10 }, text: 'Under' }] });

  it('an unchanged page keeps everything the merchant typed, and its covers as drawn', () => {
    const view = v();
    const draft = { ...typed(view), rects: [cover] };
    const m = mergeAfterChange([{ view, draft }], [v()]);
    expect(m.drafts).toEqual([draft]);
    expect(m.changed).toEqual([]);
    expect(m.notice).toBeNull();
  });

  it('a changed page takes the server covers and lines, keeps transcriptions outside them and corrections of lines that did not change', () => {
    const view = v();
    const fresh = v({ rects: [cover], readLines: ['INVOICE 2026-114', 'Total 89.00 USD', 'Paid'], sha256: SHA('b') });
    const m = mergeAfterChange([{ view, draft: typed(view) }], [fresh]);
    expect(m.drafts).toEqual([{ rects: [cover], lines: ['INVOICE 2026-114', 'Total 98.00 USD', 'Paid'], added: [{ area: { x: 200, y: 200, w: 50, h: 10 }, text: 'Signed' }] }]);
    expect(m.changed).toEqual([2]);
    expect(m.notice).toBe('Page 2 of the original document changed; check it again.');
  });

  it('a correction of a line the server now reads differently is dropped (the new reading is shown)', () => {
    const view = v();
    const fresh = v({ readLines: ['INVOICE 2026-114', 'Total 89.50 USD'], sha256: SHA('b') });
    expect(mergeAfterChange([{ view, draft: typed(view) }], [fresh]).drafts[0]!.lines).toEqual(['INVOICE 2026-114', 'Total 89.50 USD']);
  });

  it('a retry after the merge sends the fresh sha256', () => {
    const view = v();
    const fresh = v({ sha256: SHA('c') });
    const p2 = v({ original: 8, readLines: [], sha256: SHA('d') });
    const m = mergeAfterChange([{ view, draft: { ...typed(view), added: [] } }, { view: p2, draft: pageDraftOf(p2) }], [fresh, p2]);
    expect(m.changed).toEqual([2]);
    expect(confirmPayload([{ view: fresh, draft: m.drafts[0]! }, { view: p2, draft: m.drafts[1]! }])!.map((p) => p.sha256)).toEqual([SHA('c'), SHA('d')]);
  });

  it('a page now uncovered on the server is uncovered again, with what was typed kept', () => {
    const view = v();
    const fresh = v({ sha256: null });
    const m = mergeAfterChange([{ view, draft: { ...typed(view), added: [] } }], [fresh]);
    expect(pageState(fresh, m.drafts[0]!)).toBe('uncovered');
    expect(m.drafts[0]!.lines).toEqual(['INVOICE 2026-114', 'Total 98.00 USD']);
  });

  it('a selection that is not the same pages starts over from the server', () => {
    const view = v();
    const other = v({ original: 9 });
    const m = mergeAfterChange([{ view, draft: typed(view) }], [other]);
    expect(m.drafts).toEqual([pageDraftOf(other)]);
    expect(m.changed).toEqual([9]);
    expect(m.notice).toBe('Page 9 of the original document changed; check it again.');
  });

  it('names every changed page', () => {
    const a = v();
    const b = v({ original: 8, sha256: SHA('d') });
    const m = mergeAfterChange([{ view: a, draft: pageDraftOf(a) }, { view: b, draft: pageDraftOf(b) }], [v({ sha256: SHA('x') }), v({ original: 8, sha256: SHA('y') })]);
    expect(m.notice).toBe('Page 2 of the original document changed; check it again. Page 8 of the original document changed; check it again.');
  });

  it('knows whether the merchant typed or drew anything not confirmed yet', () => {
    const view = v();
    expect(hasTypedWork([{ view, draft: pageDraftOf(view) }])).toBe(false);
    expect(hasTypedWork([{ view, draft: { ...pageDraftOf(view), lines: ['x', 'Total 89.00 USD'] } }])).toBe(true);
    expect(hasTypedWork([{ view, draft: { ...pageDraftOf(view), rects: [cover] } }])).toBe(true);
    expect(hasTypedWork([{ view, draft: { ...pageDraftOf(view), added: [{ area: cover, text: '' }] } }])).toBe(true);
  });

  it('keeps an open review in memory by person and upload id until it is confirmed or discarded', () => {
    const view = v();
    const pages = [{ view, draft: typed(view) }];
    reviewsBelongTo('p1');
    keepReview('p1', 'upl-1', pages);
    expect(keptReview('p1', 'upl-1')).toEqual(pages);
    expect(keptReview('p1', 'upl-2')).toBeNull();
    forgetReview('p1', 'upl-1');
    expect(keptReview('p1', 'upl-1')).toBeNull();
  });

  it("never returns one person's typed work to another, and a change of person clears every kept review", () => {
    const view = v();
    const pages = [{ view, draft: typed(view) }];
    reviewsBelongTo('p1');
    keepReview('p1', 'upl-1', pages);
    keepReview('p1', 'upl-2', pages);
    reviewsBelongTo('p1');
    expect(keptReview('p1', 'upl-1')).toEqual(pages);
    // Person B on the same upload: nothing, and person A's reviews are gone (not just hidden).
    expect(keptReview('p2', 'upl-1')).toBeNull();
    expect(keptReview('p1', 'upl-1')).toBeNull();
    keepReview('p1', 'upl-1', pages);
    // Signed out (or the session expired): everything is cleared.
    reviewsBelongTo('local');
    expect(keptReview('p1', 'upl-1')).toBeNull();
    keepReview('p2', 'upl-1', pages);
    clearKeptReviews();
    expect(keptReview('p2', 'upl-1')).toBeNull();
  });
});
