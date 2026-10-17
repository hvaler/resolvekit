import { describe, expect, it } from 'vitest';
import { standardCase } from '../fixtures';
import { standardTestChecklist, standardTestContradictions, standardTestSentences } from '../fixtures/testDrafts';
import {
  NOTES_LIMIT,
  blockerSentence,
  checklistState,
  checklistSummary,
  citationUse,
  deriveSentences,
  draftBlockers,
  draftCounts,
  notesCountLabel,
  notesText,
  type BlockerInput,
  type DraftContext,
  type Recheck,
} from './draft';
import type { ContradictionResolution, DraftSentence, SentenceView } from './types';

const done: DraftContext = { edits: {}, checking: null, analysisStep: 6, rejectionStep: 4 };
const S = standardTestSentences;
const byId = (views: SentenceView[], id: string) => views.find((v) => v.id === id)!;
const explain = standardTestContradictions[0]!.explainText;
// What the verifier answers for the explained address sentence (the real check runs on the server).
const explainedOk: Record<string, Recheck> = { S4: { state: 'supported', reason: null, note: 'Edited · re-checked by gemini-3.8-flash: supported' } };

describe('deriveSentences', () => {
  it('keeps the analyst verdicts once the analysis is complete', () => {
    const v = deriveSentences(S, done);
    expect(v.map((x) => x.state)).toEqual(['supported', 'supported', 'supported', 'needs_review', 'rejected', 'supported', 'supported']);
    expect(v.map((x) => x.num)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('shows rejected sentences as pending until the rejection step has run', () => {
    expect(byId(deriveSentences(S, { ...done, analysisStep: 4 }), 'S5').state).toBe('pending');
    expect(byId(deriveSentences(S, { ...done, analysisStep: 5 }), 'S5').state).toBe('rejected');
  });

  it('marks a sentence as checking while it is re-checked', () => {
    expect(byId(deriveSentences(S, { ...done, checking: 'S2' }), 'S2').state).toBe('checking');
  });

  it('takes the verifier verdict for an edit, and its citations when it chose new ones', () => {
    const cites = [{ evidenceId: 'E3', fragments: ['E3.addr'], quotes: ['Delivered to: 12 Example Street, Apt 4B'] }];
    const v = byId(deriveSentences(S, { ...done, edits: { S4: explain }, rechecks: { S4: { ...explainedOk.S4!, citations: cites } } }), 'S4');
    expect(v.state).toBe('supported');
    expect(v.reason).toBeNull();
    expect(v.note).toMatch(/supported/);
    expect(v.edited).toBe(true);
    expect(v.citations).toEqual(cites);
  });

  it('never trusts an edit before the verifier has answered', () => {
    const v = byId(deriveSentences(S, { ...done, edits: { S2: 'We shipped it by drone.' } }), 'S2');
    expect(v.state).toBe('checking');
    expect(v.text).toBe('We shipped it by drone.');
  });

  it('keeps needs review (with the reason) when the verifier says so', () => {
    const r: Recheck = { state: 'needs_review', reason: 'Why: the delivered unit is not stated.', note: 'Edited · re-checked by gemini-3.8-flash: needs review' };
    const v = byId(deriveSentences(S, { ...done, edits: { S4: 'It was delivered.' }, rechecks: { S4: r } }), 'S4');
    expect(v.state).toBe('needs_review');
    expect(v.reason).toBe('Why: the delivered unit is not stated.');
  });

  it('ignores edits to rejected sentences', () => {
    const v = byId(deriveSentences(S, { ...done, edits: { S5: 'Something else' } }), 'S5');
    expect(v.state).toBe('rejected');
    expect(v.text).toBe('The customer confirmed receipt by phone.');
  });
});

describe('notesText', () => {
  it('assembles supported sentences only, in order', () => {
    const n = notesText(deriveSentences(S, done));
    expect(n.startsWith('Order #10482 was placed')).toBe(true);
    expect(n).not.toContain('confirmed receipt by phone');
    expect(n).not.toContain('address the buyer gave at checkout');
    expect(n.endsWith('are attached.')).toBe(true);
  });

  it('includes an edited sentence once it is supported, but not while re-checking', () => {
    expect(notesText(deriveSentences(S, { ...done, edits: { S4: explain }, rechecks: explainedOk }))).toContain('Apt 4B');
    expect(notesText(deriveSentences(S, { ...done, edits: { S4: explain }, rechecks: explainedOk, checking: 'S4' }))).not.toContain('Apt 4B');
  });

  it('formats the count against the 2,000-character limit', () => {
    expect(NOTES_LIMIT).toBe(2000);
    expect(notesCountLabel('x'.repeat(1234))).toBe('1,234 / 2,000');
  });
});

describe('citationUse and counts', () => {
  it('counts citations from sentences that can be sent or still need review', () => {
    const v = deriveSentences(S, done);
    expect(citationUse(v)).toEqual({ E1: 2, E2: 1, E3: 5, E4: 2, E5: 1 });
    expect(draftCounts(v)).toEqual({ total: 7, supported: 5, needsReview: 1, removed: 1 });
  });
});

describe('draftBlockers', () => {
  const base = (over: Partial<BlockerInput> = {}): BlockerInput => ({
    sentences: deriveSentences(S, done),
    contradictions: standardTestContradictions,
    resolutions: {},
    analysisComplete: true,
    action: 'provide_evidence',
    allowedActions: standardCase.allowedActions,
    evidenceType: { allowed: true, satisfied: true, label: 'Proof of fulfillment' },
    submitted: false,
    ...over,
  });
  const explained: Record<string, ContradictionResolution> = { C1: { status: 'explained', sentenceNum: 4 } };

  it('blocks on the needs-review sentence and the open contradiction', () => {
    const b = draftBlockers(base());
    expect(b.map((x) => x.kind)).toEqual(['needs_review', 'contradiction']);
    expect(blockerSentence(b)).toBe('To continue: sentence 4 needs review and the address contradiction is open.');
  });

  it('is empty once the contradiction is explained and sentence 4 re-checked', () => {
    const b = draftBlockers(base({ sentences: deriveSentences(S, { ...done, edits: { S4: explain }, rechecks: explainedOk }), resolutions: explained }));
    expect(b).toEqual([]);
  });

  it('still blocks on sentence 4 when the contradiction is only resolved with a note', () => {
    const b = draftBlockers(base({ resolutions: { C1: { status: 'resolved', note: 'Same flat', by: 'Alex Moreno' } } }));
    expect(b.map((x) => x.kind)).toEqual(['needs_review']);
  });

  it('blocks while the analysis runs or a sentence is being re-checked', () => {
    expect(draftBlockers(base({ analysisComplete: false }))[0]!.kind).toBe('analysis');
    const v = deriveSentences(S, { ...done, checking: 'S1' });
    expect(draftBlockers(base({ sentences: v })).some((x) => x.kind === 'checking')).toBe(true);
  });

  it('blocks when the notes exceed the PayPal limit', () => {
    const long: DraftSentence[] = [{ id: 'L', text: 'a'.repeat(NOTES_LIMIT + 1), verdict: 'supported', citations: [] }];
    const b = draftBlockers(base({ sentences: deriveSentences(long, done), contradictions: [] }));
    expect(b.map((x) => x.kind)).toEqual(['notes_limit']);
  });

  it('blocks a disallowed or unmet evidence type', () => {
    const ready = { sentences: deriveSentences(S, { ...done, edits: { S4: 'Apt 4B' }, rechecks: explainedOk }), resolutions: explained };
    expect(draftBlockers(base({ ...ready, evidenceType: { allowed: false, satisfied: false, label: 'X' } }))[0]!.kind).toBe('evidence_type');
    expect(draftBlockers(base({ ...ready, evidenceType: { allowed: true, satisfied: false, label: 'Proof of refund' } }))[0]!.kind).toBe('evidence_type');
  });

  it('blocks actions PayPal does not allow and anything after submission', () => {
    expect(draftBlockers(base({ allowedActions: ['send_message'] })).some((x) => x.kind === 'action')).toBe(true);
    expect(draftBlockers(base({ submitted: true })).map((x) => x.kind)).toEqual(['submitted']);
  });
});

describe('checklist', () => {
  it('reflects the contradiction state', () => {
    const items = standardTestChecklist;
    const open = items.map((i) => checklistState(i, {}));
    expect(open[2]).toBe('contradicts');
    expect(checklistSummary(open)).toBe('4 of 5 present · 1 contradicts');
    const resolved = items.map((i) => checklistState(i, { C1: { status: 'explained', sentenceNum: 4 } }));
    expect(resolved[2]).toBe('resolved');
    expect(checklistSummary(resolved)).toBe('5 of 5 present');
  });
});

describe('a sentence held back only by a contradiction the merchant resolved', () => {
  const K = standardTestContradictions;
  const held: DraftSentence = {
    id: 'S9',
    text: 'UPS delivered the parcel to 12 Example Street, Apt 4B.',
    verdict: 'needs_review',
    citations: [],
    reason: 'Why: it relies on E3 ("Apt 4B"), which E1 contradicts ("Apt 4"). State both or resolve the contradiction.',
  };
  const resolved: Record<string, ContradictionResolution> = { C1: { status: 'resolved', note: 'Same building: unit 4B', by: 'Judge 2' } };

  it('is released once that contradiction is resolved, and says by whom', () => {
    const v = byId(deriveSentences([held], { ...done, contradictions: K, resolutions: resolved }), 'S9');
    expect(v.state).toBe('supported');
    expect(v.reason).toBeNull();
    expect(v.note).toMatch(/Judge 2/);
  });

  it('stays in review while it is open or only explained in another sentence', () => {
    for (const r of [{}, { C1: { status: 'open' } }, { C1: { status: 'explained', sentenceNum: 4 } }] as Record<string, ContradictionResolution>[]) {
      expect(byId(deriveSentences([held], { ...done, contradictions: K, resolutions: r }), 'S9').state).toBe('needs_review');
    }
  });

  it('any other reason for review is not lifted by a resolution', () => {
    const other = { ...held, reason: 'Why: "UPS" does not appear in the cited evidence.' };
    expect(byId(deriveSentences([other], { ...done, contradictions: K, resolutions: resolved }), 'S9').state).toBe('needs_review');
  });

  it('an edit the verifier held back for the same contradiction is released too', () => {
    const rechecks: Record<string, Recheck> = { S9: { state: 'needs_review', reason: held.reason!, note: 'Edited · re-checked by gemini-3.8-flash: needs review' } };
    const ok = { ...held, verdict: 'supported' as const, reason: undefined };
    const v = byId(deriveSentences([ok], { ...done, edits: { S9: 'UPS delivered it to Apt 4B.' }, rechecks, contradictions: K, resolutions: resolved }), 'S9');
    expect(v.state).toBe('supported');
  });
});
