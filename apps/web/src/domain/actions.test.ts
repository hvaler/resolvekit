import { describe, expect, it } from 'vitest';
import { ACTION_EVIDENCE_BLANK, ACTION_TEXT_LIMIT, intentAction, isActionRequest, isSimpleAction, parseActionRequest } from './actions';
import { isComposeProblem, parseAnyIntentRequest, parseIntentRequest } from './intent';

const upl = (n: number) => `upl-${String(n).padStart(24, '0')}`;
const problem = (r: unknown) => (isComposeProblem(r) ? { status: r.status, error: r.error } : null);

describe('action requests', () => {
  it('parses action requests; refuses everything else', () => {
    expect(parseActionRequest({ action: 'send_message', text: '  Hello,\n\tthe parcel was delivered.  ' })).toEqual({ action: 'send_message', text: 'Hello,\n\tthe parcel was delivered.', attachments: [] });
    expect(parseActionRequest({ action: 'send_message', text: 'See the photo.', attachments: [upl(1)] })).toEqual({ action: 'send_message', text: 'See the photo.', attachments: [upl(1)] });
    expect(parseActionRequest({ action: 'escalate', note: ' Item delivered. ' })).toEqual({ action: 'escalate', note: 'Item delivered.', attachments: [] });
    expect(parseActionRequest({ action: 'accept_claim', acceptType: 'REFUND', note: 'Refunding.', amount: { value: '7', currency: 'USD' } })).toEqual({
      action: 'accept_claim',
      acceptType: 'REFUND',
      note: 'Refunding.',
      amount: { value: '7.00', currency: 'USD' },
      attachments: [],
    });
    expect(parseActionRequest({ action: 'make_offer', offerType: 'REFUND', note: 'Half back.', amount: null })).toEqual({ action: 'make_offer', offerType: 'REFUND', note: 'Half back.', amount: null, attachments: [] });
    expect(parseActionRequest({ action: 'make_offer', offerType: 'REFUND', note: 'Half back.' })).toMatchObject({ amount: null });

    // Text: trimmed, at most ACTION_TEXT_LIMIT, required; line breaks and tabs allowed.
    expect(ACTION_TEXT_LIMIT).toBe(2000);
    expect(parseActionRequest({ action: 'send_message', text: ` ${'x'.repeat(2000)} ` })).toMatchObject({ text: 'x'.repeat(2000) });
    expect(problem(parseActionRequest({ action: 'send_message', text: 'x'.repeat(2001) }))).toEqual({ status: 422, error: 'TEXT_TOO_LONG' });
    expect(problem(parseActionRequest({ action: 'send_message', text: '  \n ' }))).toEqual({ status: 422, error: 'TEXT_REQUIRED' });
    expect(problem(parseActionRequest({ action: 'escalate', note: '' }))).toEqual({ status: 422, error: 'TEXT_REQUIRED' });
    expect(problem(parseActionRequest({ action: 'escalate', note: 'y'.repeat(2001) }))).toEqual({ status: 422, error: 'TEXT_TOO_LONG' });
    expect(problem(parseActionRequest({ action: 'make_offer', offerType: 'REFUND', note: ' ' }))).toEqual({ status: 422, error: 'TEXT_REQUIRED' });
    // accept_claim: the note is optional (absent or blank: ''), still checked when given.
    expect(parseActionRequest({ action: 'accept_claim', acceptType: 'REFUND' })).toEqual({ action: 'accept_claim', acceptType: 'REFUND', note: '', amount: null, attachments: [] });
    expect(parseActionRequest({ action: 'accept_claim', acceptType: 'REFUND', note: '   ' })).toMatchObject({ note: '' });
    expect(problem(parseActionRequest({ action: 'accept_claim', acceptType: 'REFUND', note: 'z'.repeat(2001) }))).toEqual({ status: 422, error: 'TEXT_TOO_LONG' });
    expect(problem(parseActionRequest({ action: 'accept_claim', acceptType: 'REFUND', note: 'ok‮' }))).toEqual({ status: 400, error: 'INVALID_ACTION_REQUEST' });
    expect(problem(parseActionRequest({ action: 'accept_claim', acceptType: 'REFUND', note: 5 }))).toEqual({ status: 400, error: 'INVALID_ACTION_REQUEST' });
    for (const text of ['Hi\u0000', 'Hi\u0007', 'Hi\u000b', 'Hi\u007f', 'Hi‮', 'Hi⁦'])
      expect(problem(parseActionRequest({ action: 'send_message', text }))).toEqual({ status: 400, error: 'INVALID_ACTION_REQUEST' });
    expect(problem(parseActionRequest({ action: 'send_message', text: 1 }))).toEqual({ status: 400, error: 'INVALID_ACTION_REQUEST' });

    // Shape.
    for (const bad of [
      null,
      [],
      'send_message',
      { action: 'provide_evidence' },
      { action: 'refund', text: 'x' },
      { action: 'send_message', text: 'Hi', notes: 'x' },
      { action: 'escalate', note: 'x', amount: null },
      { action: 'send_message', text: 'Hi', attachments: [upl(1), upl(2)] },
      { action: 'send_message', text: 'Hi', attachments: ['E7'] },
      { action: 'send_message', text: 'Hi', attachments: upl(1) },
      { action: 'escalate', note: 'x', attachments: [upl(1)] },
      { action: 'accept_claim', acceptType: 'refund', note: 'x' },
      { action: 'make_offer', note: 'x' },
      { action: 'make_offer', offerType: 'REFUND', note: 'x', amount: '7.00' },
      { action: 'make_offer', offerType: 'REFUND', note: 'x', amount: { value: 7, currency: 'USD' } },
      { action: 'make_offer', offerType: 'REFUND', note: 'x', amount: { value: '7', currency: 'USD', extra: 1 } },
      { action: 'make_offer', offerType: 'REFUND', note: 'x', amount: { value: '7', currency: 'usd' } },
    ])
      expect(problem(parseActionRequest(bad)), JSON.stringify(bad)).toEqual({ status: 400, error: 'INVALID_ACTION_REQUEST' });

    // Amounts: exact, canonical, in a known currency.
    expect(problem(parseActionRequest({ action: 'make_offer', offerType: 'REFUND', note: 'x', amount: { value: '7,00', currency: 'USD' } }))).toEqual({ status: 422, error: 'INVALID_AMOUNT' });
    expect(problem(parseActionRequest({ action: 'accept_claim', acceptType: 'REFUND', note: 'x', amount: { value: '0', currency: 'USD' } }))).toEqual({ status: 422, error: 'INVALID_AMOUNT' });
    expect(problem(parseActionRequest({ action: 'accept_claim', acceptType: 'REFUND', note: 'x', amount: { value: '7', currency: 'XYZ' } }))).toEqual({ status: 422, error: 'UNKNOWN_CURRENCY' });
  });

  it('tells actions apart', () => {
    for (const a of ['send_message', 'accept_claim', 'escalate', 'make_offer']) expect(isSimpleAction(a)).toBe(true);
    for (const a of ['provide_evidence', 'appeal', 'toString', '', null, 1]) expect(isSimpleAction(a)).toBe(false);
    expect(intentAction({ ...ACTION_EVIDENCE_BLANK, caseId: 'X', disputeId: null, files: [] })).toBe('provide_evidence');
    expect(intentAction({ ...ACTION_EVIDENCE_BLANK, caseId: 'X', disputeId: null, files: [], action: 'escalate' })).toBe('escalate');
    expect(isActionRequest({ action: 'escalate', note: 'x', attachments: [] })).toBe(true);
    expect(isActionRequest({ evidenceType: 'OTHER', edits: {}, resolutions: {}, confirmedCorrections: [], attachments: [] })).toBe(false);
    expect(isActionRequest({ evidenceType: 'OTHER', edits: {}, resolutions: {}, confirmedCorrections: [], attachments: [], action: 'appeal' })).toBe(false);
    expect(ACTION_EVIDENCE_BLANK).toEqual({ documentsHash: '', analysisKey: '', evidenceType: 'OTHER', carrier: '', tracking: '', notes: '', sentences: [], resolutionNotes: [] });
  });

  it('parseAnyIntentRequest routes by action', () => {
    expect(parseAnyIntentRequest({ action: 'escalate', note: 'x' })).toEqual({ action: 'escalate', note: 'x', attachments: [] });
    expect(parseAnyIntentRequest({ evidenceType: 'OTHER' })).toEqual({ evidenceType: 'OTHER', edits: {}, resolutions: {}, confirmedCorrections: [], attachments: [] });
    expect(parseAnyIntentRequest({ evidenceType: 'OTHER', action: 'appeal' })).toMatchObject({ action: 'appeal' });
    expect(problem(parseAnyIntentRequest({ action: 'escalate', note: 'x', evidenceType: 'OTHER' }))).toEqual({ status: 400, error: 'INVALID_ACTION_REQUEST' });
    expect(problem(parseAnyIntentRequest({ action: 'refund' }))).toEqual({ status: 400, error: 'INVALID_INTENT_REQUEST' });
    expect(problem(parseAnyIntentRequest(null))).toEqual({ status: 400, error: 'INVALID_INTENT_REQUEST' });
  });
});

describe('evidence requests: appeal and refunds', () => {
  it('parseIntentRequest takes action "appeal" and refundIds; provide_evidence stays absent', () => {
    expect(parseIntentRequest({ evidenceType: 'OTHER', action: 'appeal' })).toEqual({ evidenceType: 'OTHER', edits: {}, resolutions: {}, confirmedCorrections: [], attachments: [], action: 'appeal' });
    const plain = parseIntentRequest({ evidenceType: 'OTHER', action: 'provide_evidence' });
    expect(plain).toEqual({ evidenceType: 'OTHER', edits: {}, resolutions: {}, confirmedCorrections: [], attachments: [] });
    expect(plain).not.toHaveProperty('action');
    expect(parseIntentRequest({ evidenceType: 'OTHER' })).not.toHaveProperty('refundIds');
    expect(parseIntentRequest({ evidenceType: 'PROOF_OF_REFUND', refundIds: ['9ZX12345AB678901C', '1AB23456CD789012E', '9ZX12345AB678901C'] })).toMatchObject({
      refundIds: ['1AB23456CD789012E', '9ZX12345AB678901C'],
    });
    expect(parseIntentRequest({ evidenceType: 'PROOF_OF_REFUND', action: 'provide_evidence', refundIds: ['1AB23456CD789012E'] })).toMatchObject({ refundIds: ['1AB23456CD789012E'] });
    // Refunds only with PROOF_OF_REFUND evidence, never with an appeal.
    for (const other of [{ evidenceType: 'OTHER' }, { evidenceType: 'PROOF_OF_FULFILLMENT' }, { evidenceType: 'PROOF_OF_REFUND', action: 'appeal' }])
      expect(problem(parseIntentRequest({ ...other, refundIds: ['1AB23456CD789012E'] })), JSON.stringify(other)).toEqual({ status: 400, error: 'INVALID_INTENT_REQUEST' });
    for (const action of ['send_message', 'APPEAL', 1, null]) expect(problem(parseIntentRequest({ evidenceType: 'OTHER', action }))).toEqual({ status: 400, error: 'INVALID_INTENT_REQUEST' });
    for (const refundIds of [[], ['1AB2345'], ['1ab23456cd789012e'], ['A'.repeat(33)], [1], 'ABCDEFGH12', Array.from({ length: 6 }, (_, i) => `REFUND0${i}AB`)])
      expect(problem(parseIntentRequest({ evidenceType: 'PROOF_OF_REFUND', refundIds })), JSON.stringify(refundIds)).toEqual({ status: 400, error: 'INVALID_INTENT_REQUEST' });
  });
});
