import { describe, expect, it } from 'vitest';
import { composerShown } from './actionDrafts';
import { draftKey, loadDraft, saveDraft, type SavedDraft } from './draftStore';

/** An in-memory Storage, optionally failing. */
function memory(o: { failWrites?: boolean; failReads?: boolean } = {}) {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => {
      if (o.failReads) throw new Error('blocked');
      return m.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (o.failWrites) throw new Error('quota');
      m.set(k, v);
    },
    removeItem: (k: string) => void m.delete(k),
  };
}

const draft: SavedDraft = {
  edits: { S3: 'We shipped to Apt 4 and UPS recorded delivery to Apt 4B.' },
  rechecks: { S3: { state: 'supported', reason: null, note: 'Edited · re-checked by gemini-3.8-flash: supported' } },
  resolutions: { C1: { status: 'resolved', note: 'Same building', by: 'Judge 2' } },
  action: 'provide_evidence',
  evidenceType: 'PROOF_OF_FULFILLMENT',
};
const key = draftKey({ scope: 'p_judge2', caseId: 'PP-R-TVH-10190665', analysis: 'k1:2026-10-17T19:00:00Z' });

describe('the draft survives a reload', () => {
  it('what was saved comes back, for the same person, case and analysis', () => {
    const s = memory();
    saveDraft(s, key, draft);
    expect(loadDraft(s, key)).toEqual(draft);
  });

  it('the confirmations of corrected upload lines come back with the draft, and alone keep it', () => {
    const s = memory();
    const only: SavedDraft = { edits: {}, rechecks: {}, resolutions: {}, confirmedCorrections: ['S1@E7.l2'], action: 'provide_evidence', evidenceType: 'PROOF_OF_FULFILLMENT' };
    saveDraft(s, key, only);
    expect(loadDraft(s, key)).toEqual(only);
  });

  it('another person, case or analysis has its own (none here)', () => {
    const s = memory();
    saveDraft(s, key, draft);
    expect(loadDraft(s, draftKey({ scope: 'p_judge1', caseId: 'PP-R-TVH-10190665', analysis: 'k1:2026-10-17T19:00:00Z' }))).toBeNull();
    expect(loadDraft(s, draftKey({ scope: 'p_judge2', caseId: 'PP-R-TVH-10190665', analysis: 'k2:2026-10-17T20:00:00Z' }))).toBeNull();
  });

  it('an edit whose re-check had not come back is not taken as checked: it needs review, and says why', () => {
    const s = memory();
    saveDraft(s, key, { ...draft, rechecks: {} });
    const back = loadDraft(s, key)!;
    expect(back.rechecks.S3).toMatchObject({ state: 'needs_review' });
    expect(back.rechecks.S3!.reason).toMatch(/not re-checked/);
  });

  it('corrupt, foreign or blocked storage gives no draft and never throws', () => {
    const s = memory();
    s.m.set(key, '{ not json');
    expect(loadDraft(s, key)).toBeNull();
    s.m.set(key, JSON.stringify({ v: 1, edits: 'nope' }));
    expect(loadDraft(s, key)).toBeNull();
    expect(loadDraft(memory({ failReads: true }), key)).toBeNull();
    expect(() => saveDraft(memory({ failWrites: true }), key, draft)).not.toThrow();
    expect(loadDraft(null, key)).toBeNull();
  });

  it('an empty draft clears what was saved', () => {
    const s = memory();
    saveDraft(s, key, draft);
    saveDraft(s, key, { edits: {}, rechecks: {}, resolutions: {}, action: 'provide_evidence', evidenceType: 'PROOF_OF_FULFILLMENT' });
    expect(s.m.has(key)).toBe(false);
  });
});

describe('a reload never reopens an action other than evidence', () => {
  it('a saved non-evidence action is restored as provide_evidence (its dialog opens only from a card click)', () => {
    const s = new Map<string, string>();
    const store = { getItem: (k: string) => s.get(k) ?? null, setItem: (k: string, v: string) => void s.set(k, v), removeItem: (k: string) => void s.delete(k) };
    const key = draftKey({ scope: 'local', caseId: 'C', analysis: 'a' });
    saveDraft(store, key, { edits: {}, rechecks: {}, resolutions: {}, confirmedCorrections: ['S1@E7.l2'], action: 'escalate', evidenceType: 'PROOF_OF_FULFILLMENT' });
    expect(loadDraft(store, key)?.action).toBe('provide_evidence');
    // An older save that holds another action is read the same way.
    s.set(key, JSON.stringify({ ...JSON.parse(s.get(key)!), action: 'make_offer' }));
    expect(loadDraft(store, key)?.action).toBe('provide_evidence');
  });

  it('the dialog is shown only while opened from a card in this page', () => {
    expect(composerShown(false, 'escalate')).toBe(false);
    expect(composerShown(true, 'escalate')).toBe(true);
    expect(composerShown(true, null)).toBe(false);
  });
});
