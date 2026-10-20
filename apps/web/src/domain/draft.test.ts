import { describe, expect, it } from 'vitest';
import { standardCase } from '../fixtures';
import { standardTestChecklist, standardTestContradictions, standardTestSentences } from '../fixtures/testDrafts';
import {
  NOTES_LIMIT,
  blockerSentence,
  checklistState,
  checklistSummary,
  citationUse,
  correctionsOf,
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

  it('evidence not available after an escalation (outside W-6) is a blocker with its reason (Task 10)', () => {
    const why = 'Not available: after an escalation, evidence was verified with PayPal only once the claim waits for the seller';
    const ok = { sentences: deriveSentences(S, { ...done, edits: { S4: explain }, rechecks: explainedOk }), resolutions: explained };
    expect(draftBlockers(base({ ...ok, evidenceUnavailable: why }))).toEqual([{ kind: 'action', text: why }]);
    expect(draftBlockers(base({ ...ok, evidenceUnavailable: null }))).toEqual([]);
  });

  it('blocks while the analysis runs or a sentence is being re-checked', () => {
    expect(draftBlockers(base({ analysisComplete: false }))[0]!.kind).toBe('analysis');
    const v = deriveSentences(S, { ...done, checking: 'S1' });
    expect(draftBlockers(base({ sentences: v })).some((x) => x.kind === 'checking')).toBe(true);
  });

  it('blocks when the notes exceed the limit, named as ResolveKit’s own cap (PayPal documents none)', () => {
    const long: DraftSentence[] = [{ id: 'L', text: 'a'.repeat(NOTES_LIMIT + 1), verdict: 'supported', citations: [] }];
    const b = draftBlockers(base({ sentences: deriveSentences(long, done), contradictions: [] }));
    expect(b.map((x) => x.kind)).toEqual(['notes_limit']);
    expect(b[0]!.text).toBe("the notes exceed ResolveKit's 2,000-character limit");
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

  it('another action PayPal allows is no longer blocked as «only Provide evidence» (its own flow decides)', () => {
    const b = draftBlockers(base({ action: 'send_message', allowedActions: ['provide_evidence', 'send_message'] }));
    expect(b.filter((x) => x.kind === 'action')).toEqual([]);
    expect(b.some((x) => x.text.includes('only "Provide evidence"'))).toBe(false);
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

describe('corrections of an uploaded file', () => {
  // The merchant corrected line 2 of E7: the text recognition read "Not delivered 8 Oct 2026".
  const e7 = {
    id: 'E7',
    title: 'tracking.png',
    type: 'Merchant upload · image',
    source: 'Uploaded by Ana',
    tag: 'UPL',
    lines: [
      { text: 'UPS tracking', fragment: 'E7.l1' },
      { text: 'Delivered 8 Oct 2026', fragment: 'E7.l2', corrected: 'Ana (member)' },
    ],
  };
  const corrections = correctionsOf([e7]);
  const base: DraftSentence[] = [
    { id: 'S1', text: 'UPS delivered the parcel on 8 Oct 2026.', verdict: 'supported', citations: [{ evidenceId: 'E7', fragments: ['E7.l2'], quotes: ['Delivered 8 Oct 2026'] }] },
    { id: 'S2', text: 'UPS tracked it.', verdict: 'supported', citations: [{ evidenceId: 'E7', fragments: ['E7.l1'] }] },
  ];

  it('a correction that flips meaning needs an explicit confirmation', () => {
    expect(corrections.get('E7.l2')).toEqual({ kind: 'corrected', line: 2, fragment: 'E7.l2', evidenceId: 'E7', text: 'Delivered 8 Oct 2026', by: 'Ana (member)' });
    const open = deriveSentences(base, { ...done, corrections });
    expect(byId(open, 'S1').state).toBe('needs_review');
    expect(byId(open, 'S1').reason).toBe('Why: it depends on your correction of line 2 of E7 ("Delivered 8 Oct 2026"). Confirm it reads the file correctly.');
    // A sentence citing only uncorrected lines is not affected.
    expect(byId(open, 'S2').state).toBe('supported');
    expect(byId(open, 'S2').note).toBeNull();

    // The confirmation is of a sentence on a line: the sentence alone, or another line, does not confirm it.
    for (const pairs of [['S1'], ['S1@E7.l1'], ['S2@E7.l2']]) expect(byId(deriveSentences(base, { ...done, corrections, confirmedCorrections: new Set(pairs) }), 'S1').state).toBe('needs_review');
    const confirmed = deriveSentences(base, { ...done, corrections, confirmedCorrections: new Set(['S1@E7.l2']) });
    expect(byId(confirmed, 'S1').state).toBe('supported');
    expect(byId(confirmed, 'S1').reason).toBeNull();
    expect(byId(confirmed, 'S1').note).toBe('Relies on line 2 of E7 as corrected by Ana (member)');
  });

  it('a held-back sentence names the corrected lines it waits on, whatever its reason says', () => {
    const two = correctionsOf([{ ...e7, lines: [{ ...e7.lines[0]!, corrected: 'Ana (member)' }, e7.lines[1]!] }]);
    const s: DraftSentence[] = [{ ...base[0]!, citations: [{ evidenceId: 'E7', fragments: ['E7.l1', 'E7.l2'] }] }];
    expect(byId(deriveSentences(s, { ...done, corrections: two }), 'S1').awaitsCorrections).toEqual(['E7.l1', 'E7.l2']);
    expect(byId(deriveSentences(s, { ...done, corrections: two, confirmedCorrections: new Set(['S1@E7.l1']) }), 'S1').awaitsCorrections).toEqual(['E7.l2']);
    // Confirmed, or held back for the analyst's own reason: nothing awaited.
    expect(byId(deriveSentences(s, { ...done, corrections: two, confirmedCorrections: new Set(['S1@E7.l1', 'S1@E7.l2']) }), 'S1').awaitsCorrections).toBeUndefined();
    expect(byId(deriveSentences([{ ...s[0]!, verdict: 'needs_review', reason: 'Why: the date differs.' }], { ...done, corrections: two }), 'S1').awaitsCorrections).toBeUndefined();
  });

  it('a sentence citing two corrected lines needs both confirmed', () => {
    const two = correctionsOf([{ ...e7, lines: [{ ...e7.lines[0]!, corrected: 'Ana (member)' }, e7.lines[1]!] }]);
    const s: DraftSentence[] = [{ ...base[0]!, citations: [{ evidenceId: 'E7', fragments: ['E7.l1', 'E7.l2'] }] }];
    const one = byId(deriveSentences(s, { ...done, corrections: two, confirmedCorrections: new Set(['S1@E7.l1']) }), 'S1');
    expect(one.state).toBe('needs_review');
    expect(one.reason).toBe('Why: it depends on your correction of line 2 of E7 ("Delivered 8 Oct 2026"). Confirm it reads the file correctly.');
    const both = byId(deriveSentences(s, { ...done, corrections: two, confirmedCorrections: new Set(['S1@E7.l1', 'S1@E7.l2']) }), 'S1');
    expect(both.state).toBe('supported');
    expect(both.note).toBe('Relies on line 1 of E7 as corrected by Ana (member) · Relies on line 2 of E7 as corrected by Ana (member)');
  });

  it('a confirmation does not lift another reason, and a removed sentence stays removed', () => {
    const held: DraftSentence[] = [
      { ...base[0]!, verdict: 'needs_review', reason: 'Why: the date differs.' },
      { ...base[0]!, id: 'S3', verdict: 'rejected', reason: 'Removed: no.' },
    ];
    const v = deriveSentences(held, { ...done, corrections, confirmedCorrections: new Set(['S1@E7.l2', 'S3@E7.l2']) });
    expect(byId(v, 'S1').state).toBe('needs_review');
    expect(byId(v, 'S1').reason).toBe('Why: the date differs.');
    expect(byId(v, 'S3').state).toBe('rejected');
  });
});
