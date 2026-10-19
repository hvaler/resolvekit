import { describe, expect, it } from 'vitest';
import { CONTRACTS, type VariantContract } from './actionContracts';
import {
  ACTION_EVIDENCE_BLANK,
  ACTION_TEXT_LIMIT,
  actionAvailability,
  composeAction,
  confirmationTerms,
  consequenceText,
  disputePin,
  intentAction,
  isActionRequest,
  isSimpleAction,
  messageKey,
  OWNER_ACTIONS,
  parseActionRequest,
  relevantNewBuyerMessages,
  sameTerms,
  type ActionRules,
  type Viewer,
} from './actions';
import { isComposeProblem, parseAnyIntentRequest, parseIntentRequest, type SubmissionIntent } from './intent';
import type { DisputeSnapshot } from './types';

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

/** A waiting-for-seller inquiry with the codes of the recorded read reads/inquiry-waiting-seller-KHH.json. */
const khh = (over: Partial<DisputeSnapshot> = {}): DisputeSnapshot => ({
  id: 'case-1',
  status: 'WAITING_FOR_SELLER_RESPONSE',
  stage: 'INQUIRY',
  allowedActions: ['accept_claim', 'provide_evidence', 'send_message', 'escalate', 'make_offer'],
  evidences: [],
  readAt: '2026-10-19 10:00 UTC',
  amount: { value: '7.00', currency: 'USD' },
  reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
  messages: [{ postedBy: 'BUYER', time: '2026-10-18T08:04:20.960Z', content: 'Where is my parcel?', files: [] }],
  offerHistory: [],
  responseOptions: { acceptClaimTypes: ['PARTIAL_REFUND', 'REFUND'], offerTypes: ['REFUND'] },
  ...over,
});
const OWNER: Viewer = { role: 'owner', reviewer: false };
const REVIEWER: Viewer = { role: 'member', reviewer: true };
const MEMBER: Viewer = { role: 'member', reviewer: false };

/** A test-only contract (never a real registry entry flipped): a copy of the registry entry, marked recorded. */
const testContract = (id: VariantContract['id']): VariantContract => ({ ...CONTRACTS[id], status: 'implemented', reason: null, recorded: 'test-only.json', evidence: 'test-only.md' });

describe('availability', () => {
  it('availability is rebuilt from the fresh read and the registry', () => {
    expect(OWNER_ACTIONS).toEqual(['accept_claim', 'make_offer', 'escalate', 'appeal']);
    // Link absent: not offered.
    const gone = actionAvailability(khh({ allowedActions: ['provide_evidence'] }), 'send_message', OWNER);
    expect(gone).toMatchObject({ action: 'send_message', offered: false, sendable: false, why: 'PayPal does not offer this action on this dispute right now' });
    // Registry not_available: the variant carries the registry's reason.
    const msg = actionAvailability(khh(), 'send_message', OWNER);
    expect(msg.offered).toBe(true);
    expect(msg.sendable).toBe(false);
    expect(msg.variants).toEqual([
      { variant: 'send_message', type: null, available: false, why: CONTRACTS.send_message.reason },
      { variant: 'send_message:file', type: 'file', available: false, why: CONTRACTS['send_message:file'].reason },
    ]);
    expect(msg.why).toBe(CONTRACTS.send_message.reason);
    // Owner-only for a reviewer or a member.
    for (const who of [REVIEWER, MEMBER]) expect(actionAvailability(khh(), 'accept_claim', who)).toMatchObject({ offered: true, sendable: false, why: 'Only the workspace owner can send this action' });
    // Accept and offer variants are PayPal's allowed response options now, each with its registry state.
    expect(actionAvailability(khh(), 'accept_claim', OWNER).variants.map((v) => [v.variant, v.type])).toEqual([
      ['accept_claim:PARTIAL_REFUND', 'PARTIAL_REFUND'],
      ['accept_claim:REFUND', 'REFUND'],
    ]);
    expect(actionAvailability(khh({ responseOptions: { acceptClaimTypes: [], offerTypes: ['REFUND_WITH_RETURN'] } }), 'make_offer', OWNER).variants).toEqual([
      { variant: 'return_address', type: 'REFUND_WITH_RETURN', available: false, why: CONTRACTS.return_address.reason },
    ]);
    expect(actionAvailability(khh({ responseOptions: undefined }), 'accept_claim', OWNER)).toMatchObject({ sendable: false, variants: [], why: 'PayPal offers no type for this action on this dispute right now' });

    // With a test-only recorded contract, the same fresh read makes it sendable, for a reviewer too (not owner-only).
    const reg = { ...CONTRACTS, send_message: testContract('send_message') };
    expect(actionAvailability(khh(), 'send_message', REVIEWER, reg)).toMatchObject({ offered: true, sendable: true, why: null });
    expect(actionAvailability(khh({ allowedActions: [] }), 'send_message', OWNER, reg)).toMatchObject({ offered: false, sendable: false });
    const acc = { ...CONTRACTS, 'accept_claim:REFUND': testContract('accept_claim:REFUND') };
    expect(actionAvailability(khh(), 'accept_claim', OWNER, acc)).toMatchObject({ sendable: true, why: null });
    expect(actionAvailability(khh(), 'accept_claim', REVIEWER, acc)).toMatchObject({ sendable: false, why: 'Only the workspace owner can send this action' });
    // PayPal no longer allows REFUND: the recorded variant is not offered.
    expect(actionAvailability(khh({ responseOptions: { acceptClaimTypes: ['PARTIAL_REFUND'], offerTypes: [] } }), 'accept_claim', OWNER, acc).sendable).toBe(false);
  });

  it('the pin is the fresh read', () => {
    expect(disputePin(khh(), 'PP-R-KHH-10193360', 'JWULA7T75ZA4Q')).toEqual({ disputeId: 'PP-R-KHH-10193360', seller: 'JWULA7T75ZA4Q', stage: 'INQUIRY', status: 'WAITING_FOR_SELLER_RESPONSE', amount: { value: '7.00', currency: 'USD' } });
    expect(disputePin(khh({ stage: undefined, amount: undefined }), null, null)).toEqual({ disputeId: null, seller: null, stage: null, status: 'WAITING_FOR_SELLER_RESPONSE', amount: null });
  });
});

describe('compose', () => {
  const base = { caseId: 'case-1', disputeId: 'PP-R-KHH-10193360', seller: 'JWULA7T75ZA4Q', files: [] };
  const err = (r: unknown) => (isComposeProblem(r) ? `${r.status} ${r.error}` : 'ok');

  it('availability first: a link gone or a variant without a recorded contract', () => {
    expect(err(composeAction({ ...base, req: { action: 'send_message', text: 'Hi', attachments: [] }, snap: khh({ allowedActions: [] }) }))).toBe('409 ACTION_NOT_OFFERED');
    const r = composeAction({ ...base, req: { action: 'send_message', text: 'Hi', attachments: [] }, snap: khh() });
    expect(r).toMatchObject({ status: 409, error: 'VARIANT_NOT_AVAILABLE', detail: `Not available: ${CONTRACTS.send_message.reason}` });
    expect(err(composeAction({ ...base, req: { action: 'accept_claim', acceptType: 'REFUND', note: '', amount: null, attachments: [] }, snap: khh() }))).toBe('409 VARIANT_NOT_AVAILABLE');
    // PayPal does not allow the type now.
    const acc = { ...CONTRACTS, 'accept_claim:REFUND': testContract('accept_claim:REFUND') };
    const onlyPartial = khh({ responseOptions: { acceptClaimTypes: ['PARTIAL_REFUND'], offerTypes: [] } });
    expect(err(composeAction({ ...base, req: { action: 'accept_claim', acceptType: 'REFUND', note: '', amount: null, attachments: [] }, snap: onlyPartial }, acc))).toBe('409 VARIANT_NOT_AVAILABLE');
    // Available in the registry, but the action's rules have not landed yet.
    const reg = { ...CONTRACTS, send_message: testContract('send_message') };
    expect(composeAction({ ...base, req: { action: 'send_message', text: 'Hi', attachments: [] }, snap: khh() }, reg)).toMatchObject({ status: 409, error: 'VARIANT_NOT_AVAILABLE' });
  });

  it('then stage, currency, amount and text, in that order', () => {
    const reg = { ...CONTRACTS, 'make_offer:REFUND': testContract('make_offer:REFUND'), send_message: testContract('send_message') };
    const offer: ActionRules = { stages: ['INQUIRY'], amount: 'required', text: 'required' };
    const rules = { make_offer: () => offer, send_message: (): ActionRules => ({ stages: null, amount: 'not_allowed', text: 'required' }) };
    const req = (amount: { value: string; currency: string } | null, note = 'Half back.') => ({ action: 'make_offer' as const, offerType: 'REFUND', note, amount, attachments: [] as [] });
    const go = (r: ReturnType<typeof req>, snap = khh()) => composeAction({ ...base, req: r, snap }, reg, rules);

    expect(err(go(req({ value: '9.00', currency: 'EUR' }, ''), khh({ stage: 'CHARGEBACK' })))).toBe('409 ACTION_STAGE');
    expect(err(go(req({ value: '9.00', currency: 'EUR' }, '')))).toBe('422 CURRENCY_MISMATCH');
    expect(err(go(req({ value: '9.00', currency: 'USD' }, ''), khh({ amount: { value: '7', currency: 'XYZ' } })))).toBe('422 UNKNOWN_CURRENCY');
    expect(err(go(req({ value: '9.00', currency: 'USD' }, ''), khh({ amount: null })))).toBe('422 UNKNOWN_CURRENCY');
    expect(err(go(req({ value: '7.01', currency: 'USD' }, '')))).toBe('422 AMOUNT_ABOVE_DISPUTE');
    expect(err(go(req({ value: '0', currency: 'USD' }, '')))).toBe('422 AMOUNT_ABOVE_DISPUTE');
    expect(err(go(req(null, '')))).toBe('422 AMOUNT_REQUIRED');
    expect(err(go(req({ value: '7.00', currency: 'USD' }, '')))).toBe('422 TEXT_REQUIRED');
    expect(err(go(req({ value: '7.00', currency: 'USD' }, 'x'.repeat(ACTION_TEXT_LIMIT + 1))))).toBe('422 TEXT_TOO_LONG');
    // No amount asked: the dispute amount is not needed.
    expect(err(composeAction({ ...base, req: { action: 'send_message', text: 'Hi', attachments: [] }, snap: khh({ amount: null }) }, reg, rules))).toBe('ok');

    const ok = go(req({ value: '7.00', currency: 'USD' }));
    expect(ok).toEqual({
      caseId: 'case-1',
      disputeId: 'PP-R-KHH-10193360',
      ...ACTION_EVIDENCE_BLANK,
      files: [],
      action: 'make_offer',
      payload: { kind: 'make_offer', offerType: 'REFUND', note: 'Half back.', amount: { value: '7.00', currency: 'USD' } },
      pin: { disputeId: 'PP-R-KHH-10193360', seller: 'JWULA7T75ZA4Q', stage: 'INQUIRY', status: 'WAITING_FOR_SELLER_RESPONSE', amount: { value: '7.00', currency: 'USD' } },
    });
    // Amounts compare as minor units: 7 is 7.00, and the payload carries the canonical string.
    expect(go(req({ value: '7', currency: 'USD' }))).toMatchObject({ payload: { amount: { value: '7.00', currency: 'USD' } } });
    // Below the dispute amount when the rules say so (a partial refund).
    expect(err(composeAction({ ...base, req: req({ value: '7.00', currency: 'USD' }), snap: khh() }, reg, { make_offer: () => ({ ...offer, belowDispute: true }) }))).toBe('422 AMOUNT_ABOVE_DISPUTE');
    expect(err(composeAction({ ...base, req: req({ value: '1.00', currency: 'USD' }), snap: khh() }, reg, { make_offer: () => ({ ...offer, amount: 'not_allowed' }) }))).toBe('422 AMOUNT_NOT_ALLOWED');
  });
});

describe('second confirmation', () => {
  const intent = (over: Partial<SubmissionIntent>): SubmissionIntent => ({
    caseId: 'case-1',
    disputeId: 'PP-R-KHH-10193360',
    ...ACTION_EVIDENCE_BLANK,
    files: [],
    id: 'int-1',
    contentHash: 'a'.repeat(64),
    requestId: 'req-1',
    status: 'approved',
    createdAt: '2026-10-19T10:00:00.000Z',
    expiresAt: '2026-10-19T11:00:00.000Z',
    approvedBy: 'p-owner',
    approvedAt: '2026-10-19T10:01:00.000Z',
    sentAt: null,
    reason: null,
    ...over,
  });
  const pin = { disputeId: 'PP-R-KHH-10193360', seller: 'JWULA7T75ZA4Q', stage: 'INQUIRY', status: 'WAITING_FOR_SELLER_RESPONSE', amount: { value: '7.00', currency: 'USD' } };
  const acceptIntent = intent({ action: 'accept_claim', payload: { kind: 'accept_claim', acceptType: 'REFUND', note: '', amount: null }, pin });

  it('second-confirmation terms cover id, hash, action, amount, currency and consequence', () => {
    const t = confirmationTerms(acceptIntent, false)!;
    expect(t).toEqual({ intentId: acceptIntent.id, contentHash: acceptIntent.contentHash, action: 'accept_claim', amount: '7.00', currency: 'USD', consequence: 'REFUNDS_BUYER' });
    for (const k of Object.keys(t)) expect(sameTerms(t, { ...t, [k]: k === 'amount' ? '7.01' : 'x' })).toBe(false);
    expect(sameTerms(t, { ...t, amount: '7' })).toBe(false); // the client must echo the canonical string
    expect(sameTerms(t, { ...t })).toBe(true);
    const { consequence: _dropped, ...partial } = t;
    for (const bad of [null, undefined, 'x', [], { ...t, extra: 1 }, { ...t, amount: 7 }, partial]) expect(sameTerms(t, bad)).toBe(false);
  });

  it('terms by action; a first-time message needs none, a repeated one names REPEATS_MESSAGE', () => {
    const msg = intent({ action: 'send_message', payload: { kind: 'send_message', text: 'Hello' }, pin });
    expect(confirmationTerms(msg, false)).toBeNull();
    expect(confirmationTerms(msg, true)).toEqual({ intentId: 'int-1', contentHash: 'a'.repeat(64), action: 'send_message', amount: null, currency: null, consequence: 'REPEATS_MESSAGE' });
    expect(confirmationTerms(intent({ action: 'make_offer', payload: { kind: 'make_offer', offerType: 'REFUND', note: 'x', amount: { value: '3.5', currency: 'USD' } }, pin }), false)).toMatchObject({ amount: '3.50', currency: 'USD', consequence: 'OFFERS_SETTLEMENT' });
    expect(confirmationTerms(intent({ action: 'escalate', payload: { kind: 'escalate', note: 'x' }, pin }), false)).toMatchObject({ amount: null, currency: null, consequence: 'MOVES_TO_CLAIM' });
    expect(confirmationTerms(intent({ action: 'appeal', pin }), true)).toMatchObject({ amount: null, consequence: 'APPEALS_DECISION' });
    expect(confirmationTerms(intent({}), false)).toBeNull(); // evidence: no second confirmation
  });

  it('consequence text per action', () => {
    expect(consequenceText({ ...acceptIntent, action: 'send_message', payload: { kind: 'send_message', text: 'Hi' } })).toBe('The buyer sees this message in PayPal.');
    expect(consequenceText(acceptIntent)).toContain('7.00 USD');
    for (const action of ['escalate', 'make_offer', 'appeal', 'provide_evidence'] as const) expect(consequenceText({ ...acceptIntent, action }).length).toBeGreaterThan(0);
  });
});

describe('new buyer messages after approval', () => {
  it('a new buyer message after approval matters for message/offer/accept, not for escalate/appeal; own messages never', () => {
    const before = khh();
    const keys = (before.messages ?? []).map(messageKey);
    expect(keys).toEqual(['BUYER|2026-10-18T08:04:20.960Z|19']);
    const buyer = { postedBy: 'BUYER', time: '2026-10-19T09:00:00.000Z', content: 'Any news?', files: [] };
    const seller = { postedBy: 'SELLER', time: '2026-10-19T09:05:00.000Z', content: 'On its way.', files: [] };
    const fresh = khh({ messages: [seller, ...(before.messages ?? []), buyer], readAt: '2026-10-19 11:00 UTC', allowedActions: ['make_offer', 'send_message', 'escalate', 'accept_claim'] });
    for (const a of ['send_message', 'make_offer', 'accept_claim'] as const) expect(relevantNewBuyerMessages(a, keys, fresh)).toEqual([buyer]);
    for (const a of ['escalate', 'appeal', 'provide_evidence'] as const) expect(relevantNewBuyerMessages(a, keys, fresh)).toEqual([]);
    // Only the merchant's own message, the read time and the link order changed: nothing holds the send.
    expect(relevantNewBuyerMessages('send_message', keys, khh({ messages: [...(before.messages ?? []), seller], readAt: 'later', allowedActions: [...before.allowedActions].reverse() }))).toEqual([]);
    expect(relevantNewBuyerMessages('send_message', keys, khh({ messages: undefined }))).toEqual([]);
  });
});
