import { describe, expect, it } from 'vitest';
import { standardCase } from '@resolvekit/cases';
import { correctionsOf } from './draft';
import { composeSubmission, contentHash, intentContent, intentSubmission, isComposeProblem, parseIntentRequest, type ComposeInput, type IntentContent } from './intent';
import { LocalIntentClient } from './intentClient';
import { ACTION_EVIDENCE_BLANK, type DisputePin } from './actions';
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
  req: { evidenceType: 'PROOF_OF_FULFILLMENT', edits: {}, resolutions: {}, confirmedCorrections: [], attachments: [] },
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
    const unverified = composeSubmission(base({ req: { evidenceType: 'PROOF_OF_FULFILLMENT', edits: { S2: k.explainText }, resolutions: { C1: { status: 'explained', sentenceNum: 2 } }, confirmedCorrections: [], attachments: [] } }));
    expect(isComposeProblem(unverified) && unverified.error).toBe('EDIT_NOT_VERIFIED');
    const ok = composeSubmission(
      base({
        req: { evidenceType: 'PROOF_OF_FULFILLMENT', edits: { S2: k.explainText }, resolutions: { C1: { status: 'explained', sentenceNum: 2 } }, confirmedCorrections: [], attachments: [] },
        verified: (t) => (t === k.explainText ? { state: 'supported', reason: null, note: '' } : null),
      }),
    );
    if (isComposeProblem(ok)) throw new Error(ok.detail);
    expect(ok.submission.notes).toBe(`Order #10482 was paid. ${k.explainText}`);
    expect(ok.sentences.map((s) => [s.id, s.edited])).toEqual([['S1', false], ['S2', true]]);
    expect(ok.submission.notes).not.toContain('phone');
  });

  it('a removed sentence cannot be edited back in; PayPal not offering provide_evidence blocks', () => {
    const r = composeSubmission(base({ req: { evidenceType: 'PROOF_OF_FULFILLMENT', edits: { S3: 'The buyer confirmed.' }, resolutions: {}, confirmedCorrections: [], attachments: [] } }));
    expect(isComposeProblem(r) && r.error).toBe('SENTENCE_REMOVED');
    const blocked = composeSubmission(base({ allowedActions: ['send_message'], c: { ...c, sentences: [c.sentences[0]!], contradictions: [] } }));
    expect(isComposeProblem(blocked) && blocked.error).toBe('DRAFT_BLOCKED');
  });

  it('PROOF_OF_REFUND and an appeal are refused 409 VARIANT_NOT_AVAILABLE with the registry reason, even when ready (Task 12)', () => {
    // A draft that would compose: one supported sentence, no contradiction, every type satisfied.
    const ready: CaseFile = {
      ...c,
      sentences: [c.sentences[0]!],
      contradictions: [],
      evidenceTypes: c.evidenceTypes.map((t) => ({ ...t, satisfied: true })),
      requestedEvidenceType: 'PROOF_OF_REFUND',
    };
    const req = (over: Partial<ComposeInput['req']> = {}): ComposeInput['req'] => ({ evidenceType: 'PROOF_OF_FULFILLMENT', edits: {}, resolutions: {}, confirmedCorrections: [], attachments: [], ...over });
    expect(isComposeProblem(composeSubmission(base({ c: ready, req: req() })))).toBe(false);
    expect(composeSubmission(base({ c: ready, req: req({ evidenceType: 'PROOF_OF_REFUND' }) }))).toEqual({ status: 409, error: 'VARIANT_NOT_AVAILABLE', detail: 'Not available: Not verified with PayPal: pending sandbox test (W-11)' });
    expect(composeSubmission(base({ c: ready, allowedActions: ['provide_evidence', 'appeal'], req: req({ action: 'appeal' }) }))).toEqual({
      status: 409,
      error: 'VARIANT_NOT_AVAILABLE',
      detail: 'Not available: Not verified with PayPal: the sandbox could not produce an appealable dispute',
    });
  });

  it('the server releases a sentence held back only by a contradiction the request resolves, as the draft does', () => {
    const contested = { ...c.sentences[1]!, reason: 'Why: it relies on E3 ("Apt 4B"), which E1 contradicts ("Apt 4"). State both or resolve the contradiction.' };
    const cc = { ...c, sentences: [c.sentences[0]!, contested, c.sentences[2]!] };
    const open = composeSubmission(base({ c: cc }));
    expect(isComposeProblem(open) && open.blockers).toEqual(['sentence 2 needs review', 'the address contradiction is open']);
    const r = composeSubmission(base({ c: cc, req: { evidenceType: 'PROOF_OF_FULFILLMENT', edits: {}, resolutions: { C1: { status: 'resolved', note: 'Same building', by: 'x' } }, confirmedCorrections: [], attachments: [] } }));
    expect(isComposeProblem(r)).toBe(false);
    expect(!isComposeProblem(r) && r.sentences.map((x) => x.id)).toEqual(['S1', 'S2']);
  });

  it('a request carrying notes, files or tracking is refused: the server composes them', () => {
    for (const extra of [{ notes: 'x' }, { files: [] }, { tracking: '1Z' }]) {
      const r = parseIntentRequest({ evidenceType: 'PROOF_OF_FULFILLMENT', ...extra });
      expect(isComposeProblem(r) && r.status).toBe(400);
    }
    expect(parseIntentRequest({ evidenceType: 'OTHER', edits: { S1: ' Paid. ' } })).toEqual({ evidenceType: 'OTHER', edits: { S1: 'Paid.' }, resolutions: {}, confirmedCorrections: [], attachments: [] });
  });
});

describe('confirmed corrections', () => {
  const e7 = { id: 'E7', title: 'tracking.png', type: 'Merchant upload · image', source: 'Uploaded by Ana', tag: 'UPL', lines: [{ text: 'Delivered 8 Oct 2026', fragment: 'E7.l1', corrected: 'Ana (member)' }] };
  const cc: CaseFile = { ...c, sentences: [{ id: 'S1', text: 'UPS delivered it on 8 Oct 2026.', verdict: 'supported', citations: [{ evidenceId: 'E7', fragments: ['E7.l1'] }] }], contradictions: [] };
  const req = (confirmedCorrections: string[]) => ({ evidenceType: 'PROOF_OF_FULFILLMENT' as const, edits: {}, resolutions: {}, confirmedCorrections, attachments: [] });

  it('the server holds back a sentence resting on a correction until the request confirms that pair, as the draft does', () => {
    const open = composeSubmission(base({ c: cc, req: req([]), corrections: correctionsOf([e7]) }));
    expect(isComposeProblem(open) && open.blockers).toEqual(['sentence 1 needs review']);
    // A confirmation of another sentence, or of the sentence on another line, does not count.
    for (const other of [['S2@E7.l1'], ['S1@E7.l9']]) {
      const r = composeSubmission(base({ c: cc, req: req(other), corrections: correctionsOf([e7]) }));
      expect(isComposeProblem(r) && r.blockers).toEqual(['sentence 1 needs review']);
    }
    const ok = composeSubmission(base({ c: cc, req: req(['S1@E7.l1']), corrections: correctionsOf([e7]) }));
    if (isComposeProblem(ok)) throw new Error(ok.detail);
    expect(ok.views[0]!.note).toBe('Relies on line 1 of E7 as corrected by Ana (member)');
    expect(ok.submission.notes).toBe('UPS delivered it on 8 Oct 2026.');
  });

  it('confirmed corrections are part of the approved content', async () => {
    expect(parseIntentRequest({ evidenceType: 'OTHER', confirmedCorrections: ['S2@E7.l1', 'S1@E7.l2', 'S2@E7.l1'] })).toEqual({ evidenceType: 'OTHER', edits: {}, resolutions: {}, confirmedCorrections: ['S1@E7.l2', 'S2@E7.l1'], attachments: [] });
    for (const bad of ['S1@E7.l1', [1], ['S1'], ['S1@'], ['@E7.l1'], ['S1@E7.l1@x'], ['bad id!@E7.l1'], Array.from({ length: 51 }, (_, i) => `S${i}@E7.l1`)]) {
      expect(isComposeProblem(parseIntentRequest({ evidenceType: 'OTHER', confirmedCorrections: bad }))).toBe(true);
    }
    const submission = { disputeId: 'X', action: 'provide_evidence' as const, evidenceType: 'OTHER' as const, carrier: '', tracking: '', notes: 'Paid.', files: [] };
    const views = [{ id: 'S1', num: 1, text: 'Paid.', state: 'supported' as const, citations: [], reason: null, note: null, edited: false }];
    const l = new LocalIntentClient();
    const a = await l.create('X', { ...req([]), evidenceType: 'OTHER' }, { submission, views });
    const b = await l.create('X', { ...req(['S1@E7.l1']), evidenceType: 'OTHER' }, { submission, views });
    expect(b.confirmedCorrections).toEqual(['S1@E7.l1']);
    expect(a.contentHash).not.toBe(b.contentHash);
    expect(await contentHash(b)).toBe(b.contentHash);
    // Without confirmations the content (and its hash) is what it was before corrections existed.
    expect(intentContent(a)).not.toHaveProperty('confirmedCorrections');
  });
});

describe('attachments', () => {
  it("the approval covers each attached file's SHA-256", async () => {
    const submission = { disputeId: 'X', action: 'provide_evidence' as const, evidenceType: 'OTHER' as const, carrier: '', tracking: '', notes: 'Paid.', files: [] };
    const views = [{ id: 'S1', num: 1, text: 'Paid.', state: 'supported' as const, citations: [], reason: null, note: null, edited: false }];
    const i = await new LocalIntentClient().create('X', { evidenceType: 'OTHER', edits: {}, resolutions: {}, confirmedCorrections: [], attachments: [] }, { submission, views });
    const file = { name: 'E7-tracking.png', size: '12 KB', source: 'upload' as const };
    const a = { ...i, files: [{ ...file, sha256: 'a'.repeat(64) }] };
    const b = { ...i, files: [{ ...file, sha256: 'b'.repeat(64) }] };
    // Same names and sizes, different bytes: a different content hash.
    expect(await contentHash(a)).not.toBe(await contentHash(b));
    expect(intentContent(a).files).toEqual([{ name: 'E7-tracking.png', size: '12 KB', sha256: 'a'.repeat(64), source: 'upload' }]);
    expect(await contentHash({ ...a, files: [{ ...a.files[0]!, source: 'demo' as const }] })).not.toBe(await contentHash(a));
  });

  it('the request names the selected uploads by id (sorted, unique); anything else is refused', () => {
    const id = (n: number) => `upl-${String(n).padStart(24, '0')}`;
    expect(parseIntentRequest({ evidenceType: 'OTHER', attachments: [id(2), id(1), id(2)] })).toMatchObject({ attachments: [id(1), id(2)] });
    for (const bad of [id(1), ['E7'], [1], ['upl-xyz'], Array.from({ length: 11 }, (_, i) => id(i))]) {
      expect(isComposeProblem(parseIntentRequest({ evidenceType: 'OTHER', attachments: bad }))).toBe(true);
    }
  });
});

describe('LocalIntentClient (no server: simulator only)', () => {
  it('composes an intent whose hash covers its content, and approves it', async () => {
    const submission = { disputeId: 'X', action: 'provide_evidence' as const, evidenceType: 'OTHER' as const, carrier: '', tracking: '', notes: 'Paid.', files: [{ name: 'a.pdf', size: '1 KB' }] };
    const views = [{ id: 'S1', num: 1, text: 'Paid.', state: 'supported' as const, citations: [], reason: null, note: null, edited: false }];
    const l = new LocalIntentClient();
    const i = await l.create('X', { evidenceType: 'OTHER', edits: {}, resolutions: {}, confirmedCorrections: [], attachments: [] }, { submission, views });
    expect(i.disputeId).toBeNull();
    expect(i.contentHash).toBe(await contentHash(i));
    expect(await contentHash({ ...i, notes: 'Paid!' })).not.toBe(i.contentHash);
    expect(intentSubmission(i)).toMatchObject({ notes: 'Paid.', intentId: i.id });
    expect((await l.approve(i)).status).toBe('approved');
  });
});

describe('M3: the audit log shows the server’s events', () => {
  it('reads the case’s events from the server and words each one (who, what, request id, hash)', async () => {
    const { HttpIntentClient, auditLine } = await import('./intentClient');
    const events = [
      { at: '2026-10-09T08:01:00Z', caseId: 'X', kind: 'intent_approved', actor: 'demo session abc123', intentId: 'int-0123456789abcdef', contentHash: 'f'.repeat(64) },
      { at: '2026-10-09T08:02:00Z', caseId: 'X', kind: 'sent', actor: 'demo session abc123', requestId: 'rk-int-1', detail: 'accepted by PayPal' },
    ];
    const seen: string[] = [];
    const fetch = (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ events }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const got = await new HttpIntentClient({ fetch }).events('X');
    expect(seen).toEqual(['/api/disputes/X/audit']);
    expect(got!.map(auditLine)).toEqual([
      { time: '08:01', who: 'demo session abc123', what: 'Approved intent int-01234567… · content sha256 ffffffffffff…' },
      { time: '08:02', who: 'demo session abc123', what: 'PayPal accepted the send · request rk-int-1' },
    ]);
    // A server that cannot answer: no server log (the flow falls back to this browser's, labelled as such).
    const down = (async () => new Response('{}', { status: 403 })) as unknown as typeof globalThis.fetch;
    expect(await new HttpIntentClient({ fetch: down }).events('X')).toBeNull();
  });
});

describe('hash compatibility (B0)', () => {
  // GOLDEN content, unchanged since dcd74c6: intents approved before dispute actions must keep their hashes.
  const GOLDEN: IntentContent = {
    caseId: 'PP-R-TVH-10190665',
    disputeId: 'PP-R-GOLDEN-1',
    documentsHash: 'a'.repeat(64),
    analysisKey: 'b'.repeat(64),
    evidenceType: 'PROOF_OF_FULFILLMENT',
    carrier: 'UPS',
    tracking: '1Z999AA10123456784',
    notes: 'Delivered on 8 Oct 2026.',
    files: [{ name: 'E3-ups-tracking.pdf', size: '2 KB', sha256: 'c'.repeat(64), source: 'demo' }],
    sentences: [{ id: 'S1', text: 'Delivered on 8 Oct 2026.', edited: false }],
    resolutionNotes: [{ contradictionId: 'C1', note: 'Same building.' }],
  };

  it('existing provide-evidence hashes are unchanged (golden)', async () => {
    expect(await contentHash(GOLDEN)).toBe('63fe9916f41178e78070ee0d030a3e7d7791adeb9a61e925ecb352daab83b9c8');
    expect(await contentHash({ ...GOLDEN, confirmedCorrections: ['S1@E7.l2'] })).toBe('ee7919f7a34f78f2d314d1f400d6b856226c51167bdc952c4e5048bd58d12dec');
    expect(await contentHash({ ...GOLDEN, refundIds: [] })).toBe('63fe9916f41178e78070ee0d030a3e7d7791adeb9a61e925ecb352daab83b9c8');
  });

  const pin: DisputePin = { disputeId: 'PP-R-GOLDEN-1', seller: 'SELLER1', stage: 'INQUIRY', status: 'WAITING_FOR_SELLER_RESPONSE', amount: { value: '35.00', currency: 'USD' } };
  const action = (a: Pick<IntentContent, 'action' | 'payload'>): IntentContent => ({ ...ACTION_EVIDENCE_BLANK, caseId: GOLDEN.caseId, disputeId: GOLDEN.disputeId, files: [], pin, ...a });

  it('each action hashes its action, payload and pin; one action never hashes as another', async () => {
    const message = action({ action: 'send_message', payload: { kind: 'send_message', text: 'Delivered.' } });
    const escalate = action({ action: 'escalate', payload: { kind: 'escalate', note: 'Delivered.' } });
    expect(intentContent(message)).toMatchObject({ action: 'send_message', payload: { kind: 'send_message', text: 'Delivered.' }, pin });
    expect(await contentHash(message)).not.toBe(await contentHash(escalate));
    expect(await contentHash(message)).not.toBe(await contentHash({ ...message, action: undefined, payload: undefined, pin: undefined }));
    expect(await contentHash({ ...message, pin: { ...pin, status: 'UNDER_REVIEW' } })).not.toBe(await contentHash(message));
    expect(await contentHash({ ...message, pin: { ...pin, stage: 'CHARGEBACK' } })).not.toBe(await contentHash(message));
    expect(await contentHash({ ...message, pin: { ...pin, amount: { value: '35.00', currency: 'EUR' } } })).not.toBe(await contentHash(message));
    expect(await contentHash({ ...message, payload: { kind: 'send_message', text: 'Delivered!' } })).not.toBe(await contentHash(message));
    const offer = action({ action: 'make_offer', payload: { kind: 'make_offer', offerType: 'REFUND', note: 'Half.', amount: { value: '17.50', currency: 'USD' } } });
    expect(await contentHash({ ...offer, payload: { kind: 'make_offer', offerType: 'REFUND', note: 'Half.', amount: { value: '17.51', currency: 'USD' } } })).not.toBe(await contentHash(offer));
    expect(await contentHash(action({ action: 'appeal' }))).not.toBe(await contentHash({ ...GOLDEN, ...ACTION_EVIDENCE_BLANK, files: [] }));
    // Only the hashed fields: anything else on the object is not part of the content.
    expect(intentContent({ ...message, payload: { kind: 'send_message', text: 'Delivered.', extra: 1 } as never, pin: { ...pin, extra: 1 } as never })).toEqual(intentContent(message));
    // Without an action (or with provide_evidence) none of it is hashed: an evidence intent hashes as it did.
    expect(await contentHash({ ...GOLDEN, payload: message.payload, pin })).toBe('63fe9916f41178e78070ee0d030a3e7d7791adeb9a61e925ecb352daab83b9c8');
    expect(await contentHash({ ...GOLDEN, action: 'provide_evidence', pin })).toBe('63fe9916f41178e78070ee0d030a3e7d7791adeb9a61e925ecb352daab83b9c8');
    // Refunds are part of the content when there are some.
    expect(await contentHash({ ...GOLDEN, refundIds: ['1AB23456CD789012E'] })).not.toBe('63fe9916f41178e78070ee0d030a3e7d7791adeb9a61e925ecb352daab83b9c8');
    expect(intentContent({ ...GOLDEN, refundIds: ['1AB23456CD789012E'] }).refundIds).toEqual(['1AB23456CD789012E']);
  });
});
