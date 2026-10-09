import { describe, expect, it } from 'vitest';
import { standardCase } from '@resolvekit/cases';
import { composeSubmission, contentHash, intentSubmission, isComposeProblem, parseIntentRequest, type ComposeInput } from './intent';
import { LocalIntentClient } from './intentClient';
import type { CaseFile, Contradiction } from './types';

const k: Contradiction = {
  id: 'C1',
  title: 'Address',
  a: { evidenceId: 'E1', fragment: 'E1.addr', label: 'E1', value: 'Apt 4' },
  b: { evidenceId: 'E3', fragment: 'E3.addr', label: 'E3', value: 'Apt 4B' },
  assessment: '',
  explainSentenceId: 'S2',
  explainText: 'UPS delivered to Apt 4B; the order lists Apt 4.',
  blockerName: 'the address contradiction',
};
const c: CaseFile = {
  ...standardCase,
  sentences: [
    { id: 'S1', text: 'Order #10482 was paid.', verdict: 'supported', citations: [{ evidenceId: 'E1', fragments: [] }] },
    { id: 'S2', text: 'It was delivered.', verdict: 'needs_review', citations: [], reason: 'address differs' },
    { id: 'S3', text: 'The buyer confirmed by phone.', verdict: 'rejected', citations: [] },
  ],
  contradictions: [k],
  analysis: { steps: ['a', 'b', 'c', 'd', 'e', 'f'], contradictionStep: 3, rejectionStep: 5, note: '' },
};
const base = (over: Partial<ComposeInput> = {}): ComposeInput => ({
  c,
  req: { evidenceType: 'PROOF_OF_FULFILLMENT', edits: {}, resolutions: {} },
  verified: () => null,
  allowedActions: ['provide_evidence'],
  submitted: false,
  ...over,
});

describe('composeSubmission (shared by the server and the web app)', () => {
  it('refuses while a sentence needs review or a contradiction is open', () => {
    const r = composeSubmission(base());
    expect(isComposeProblem(r) && r.error).toBe('DRAFT_BLOCKED');
    expect(isComposeProblem(r) && r.blockers).toEqual(['sentence 2 needs review', 'the address contradiction is open']);
  });

  it('an edit counts only with a verdict from the verifier', () => {
    const unverified = composeSubmission(base({ req: { evidenceType: 'PROOF_OF_FULFILLMENT', edits: { S2: k.explainText }, resolutions: { C1: { status: 'explained', sentenceNum: 2 } } } }));
    expect(isComposeProblem(unverified) && unverified.error).toBe('EDIT_NOT_VERIFIED');
    const ok = composeSubmission(
      base({
        req: { evidenceType: 'PROOF_OF_FULFILLMENT', edits: { S2: k.explainText }, resolutions: { C1: { status: 'explained', sentenceNum: 2 } } },
        verified: (t) => (t === k.explainText ? { state: 'supported', reason: null, note: '' } : null),
      }),
    );
    if (isComposeProblem(ok)) throw new Error(ok.detail);
    expect(ok.submission.notes).toBe(`Order #10482 was paid. ${k.explainText}`);
    expect(ok.sentences.map((s) => [s.id, s.edited])).toEqual([['S1', false], ['S2', true]]);
    expect(ok.submission.notes).not.toContain('phone');
  });

  it('a removed sentence cannot be edited back in; PayPal not offering provide_evidence blocks', () => {
    const r = composeSubmission(base({ req: { evidenceType: 'PROOF_OF_FULFILLMENT', edits: { S3: 'The buyer confirmed.' }, resolutions: {} } }));
    expect(isComposeProblem(r) && r.error).toBe('SENTENCE_REMOVED');
    const blocked = composeSubmission(base({ allowedActions: ['send_message'], c: { ...c, sentences: [c.sentences[0]!], contradictions: [] } }));
    expect(isComposeProblem(blocked) && blocked.error).toBe('DRAFT_BLOCKED');
  });

  it('a request carrying notes, files or tracking is refused: the server composes them', () => {
    for (const extra of [{ notes: 'x' }, { files: [] }, { tracking: '1Z' }]) {
      const r = parseIntentRequest({ evidenceType: 'PROOF_OF_FULFILLMENT', ...extra });
      expect(isComposeProblem(r) && r.status).toBe(400);
    }
    expect(parseIntentRequest({ evidenceType: 'OTHER', edits: { S1: ' Paid. ' } })).toEqual({ evidenceType: 'OTHER', edits: { S1: 'Paid.' }, resolutions: {} });
  });
});

describe('LocalIntentClient (no server: simulator only)', () => {
  it('composes an intent whose hash covers its content, and approves it', async () => {
    const submission = { disputeId: 'X', action: 'provide_evidence' as const, evidenceType: 'OTHER' as const, carrier: '', tracking: '', notes: 'Paid.', files: [{ name: 'a.pdf', size: '1 KB' }] };
    const views = [{ id: 'S1', num: 1, text: 'Paid.', state: 'supported' as const, citations: [], reason: null, note: null, edited: false }];
    const l = new LocalIntentClient();
    const i = await l.create('X', { evidenceType: 'OTHER', edits: {}, resolutions: {} }, { submission, views });
    expect(i.disputeId).toBeNull();
    expect(i.contentHash).toBe(await contentHash(i));
    expect(await contentHash({ ...i, notes: 'Paid!' })).not.toBe(i.contentHash);
    expect(intentSubmission(i)).toMatchObject({ notes: 'Paid.', intentId: i.id });
    expect((await l.approve(i)).status).toBe('approved');
  });
});
