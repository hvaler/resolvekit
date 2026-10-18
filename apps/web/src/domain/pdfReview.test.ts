import { describe, expect, it } from 'vitest';
import { PDF_MAX_SELECTED, SELECTION_WARNING, canPick, jobLabel, jobSettled, pickedLabel, pollDelay, selectionCopy, togglePick } from './pdfReview';

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
