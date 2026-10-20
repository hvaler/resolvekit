import { describe, expect, it } from 'vitest';
import { CONTRACTS, type VariantContract } from './actionContracts';
import {
  ACTION_EVIDENCE_BLANK,
  ACTION_RULES,
  ACTION_TEXT_LIMIT,
  actionAvailability,
  actionAvailabilityWith,
  composeAction,
  composeActionWith,
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
import w1 from '../../../../packages/paypal/contracts/send_message.json';
import w2 from '../../../../packages/paypal/contracts/send_message-request-id.json';
import w3 from '../../../../packages/paypal/contracts/send_message-file.json';
import w9 from '../../../../packages/paypal/contracts/accept_claim-partial_refund.json';
import w10 from '../../../../packages/paypal/contracts/accept_claim-refund.json';
import w5 from '../../../../packages/paypal/contracts/escalate.json';

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
  allowedRefund: { value: '7.00', currency: 'USD' },
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
/** The registry as it was before send_message's contract was recorded (both message variants «Not available»). */
const UNRECORDED = {
  ...CONTRACTS,
  send_message: { ...CONTRACTS.send_message, status: 'not_available' as const, reason: 'Contract not recorded yet' },
  'send_message:file': { ...CONTRACTS['send_message:file'], status: 'not_available' as const, reason: 'Contract not recorded yet' },
};

describe('availability', () => {
  it('availability is rebuilt from the fresh read and the registry', () => {
    expect(OWNER_ACTIONS).toEqual(['accept_claim', 'make_offer', 'escalate', 'appeal']);
    // Link absent: not offered.
    const gone = actionAvailability(khh({ allowedActions: ['provide_evidence'] }), 'send_message', OWNER);
    expect(gone).toMatchObject({ action: 'send_message', offered: false, sendable: false, why: 'PayPal does not offer this action on this dispute right now' });
    // Registry not_available: the variant carries the registry's reason.
    const msg = actionAvailabilityWith(khh(), 'send_message', OWNER, UNRECORDED);
    expect(msg.offered).toBe(true);
    expect(msg.sendable).toBe(false);
    expect(msg.variants).toEqual([
      { variant: 'send_message', type: null, available: false, why: 'Contract not recorded yet' },
      { variant: 'send_message:file', type: 'file', available: false, why: 'Contract not recorded yet' },
    ]);
    expect(msg.why).toBe('Contract not recorded yet');
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
    // Types PayPal offers that no ResolveKit variant covers: listed as unavailable, with their own reason.
    expect(actionAvailability(khh({ responseOptions: { acceptClaimTypes: [], offerTypes: ['REFUND_WITH_REPLACEMENT'] } }), 'make_offer', OWNER)).toEqual({
      action: 'make_offer',
      offered: true,
      sendable: false,
      why: 'ResolveKit cannot send the types PayPal offers on this dispute',
      variants: [{ variant: null, type: 'REFUND_WITH_REPLACEMENT', available: false, why: 'ResolveKit cannot send this type' }],
    });
    // A covered variant's reason wins over an uncovered type's.
    expect(actionAvailability(khh({ responseOptions: { acceptClaimTypes: [], offerTypes: ['REFUND_WITH_REPLACEMENT', 'REFUND'] } }), 'make_offer', OWNER).why).toBe(CONTRACTS['make_offer:REFUND'].reason);

    // With a test-only recorded contract, the same fresh read makes it sendable, for a reviewer too (not owner-only).
    const reg = { ...CONTRACTS, send_message: testContract('send_message') };
    expect(actionAvailabilityWith(khh(), 'send_message', REVIEWER, reg)).toMatchObject({ offered: true, sendable: true, why: null });
    expect(actionAvailabilityWith(khh({ allowedActions: [] }), 'send_message', OWNER, reg)).toMatchObject({ offered: false, sendable: false });
    const acc = {
      ...CONTRACTS,
      'accept_claim:REFUND': testContract('accept_claim:REFUND'),
      'accept_claim:PARTIAL_REFUND': { ...CONTRACTS['accept_claim:PARTIAL_REFUND'], status: 'not_available' as const, reason: 'Contract not recorded yet' },
    };
    expect(actionAvailabilityWith(khh(), 'accept_claim', OWNER, acc)).toMatchObject({ sendable: true, why: null });
    expect(actionAvailabilityWith(khh(), 'accept_claim', REVIEWER, acc)).toMatchObject({ sendable: false, why: 'Only the workspace owner can send this action' });
    // PayPal no longer allows REFUND: the recorded variant is not offered.
    expect(actionAvailabilityWith(khh({ responseOptions: { acceptClaimTypes: ['PARTIAL_REFUND'], offerTypes: [] } }), 'accept_claim', OWNER, acc).sendable).toBe(false);
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
    const r = composeActionWith({ ...base, req: { action: 'send_message', text: 'Hi', attachments: [] }, snap: khh() }, UNRECORDED);
    expect(r).toMatchObject({ status: 409, error: 'VARIANT_NOT_AVAILABLE', detail: 'Not available: Contract not recorded yet' });
    expect(err(composeActionWith({ ...base, req: { action: 'escalate', note: 'Delivered.', attachments: [] }, snap: khh() }, { ...CONTRACTS, escalate: { ...CONTRACTS.escalate, status: 'not_available', reason: 'Contract not recorded yet' } }))).toBe('409 VARIANT_NOT_AVAILABLE');
    // PayPal does not allow the type now.
    const acc = { ...CONTRACTS, 'accept_claim:REFUND': testContract('accept_claim:REFUND') };
    const onlyPartial = khh({ responseOptions: { acceptClaimTypes: ['PARTIAL_REFUND'], offerTypes: [] } });
    expect(err(composeActionWith({ ...base, req: { action: 'accept_claim', acceptType: 'REFUND', note: '', amount: null, attachments: [] }, snap: onlyPartial }, acc))).toBe('409 VARIANT_NOT_AVAILABLE');
    // Available in the registry, but the action's rules have not landed yet.
    const reg = { ...CONTRACTS, 'make_offer:REFUND': testContract('make_offer:REFUND') };
    expect(composeActionWith({ ...base, req: { action: 'make_offer', offerType: 'REFUND', note: 'x', amount: { value: '1.00', currency: 'USD' }, attachments: [] }, snap: khh() }, reg)).toMatchObject({
      status: 409,
      error: 'VARIANT_NOT_AVAILABLE',
      detail: 'Not available: not implemented yet',
    });
  });

  it('then stage, currency, amount and text, in that order', () => {
    const reg = { ...CONTRACTS, 'make_offer:REFUND': testContract('make_offer:REFUND'), send_message: testContract('send_message') };
    const offer: ActionRules = { stages: ['INQUIRY'], amount: 'required', text: 'required' };
    const rules = { make_offer: () => offer, send_message: (): ActionRules => ({ stages: null, amount: 'not_allowed', text: 'required' }) };
    const req = (amount: { value: string; currency: string } | null, note = 'Half back.') => ({ action: 'make_offer' as const, offerType: 'REFUND', note, amount, attachments: [] as [] });
    const go = (r: ReturnType<typeof req>, snap = khh()) => composeActionWith({ ...base, req: r, snap }, reg, rules);

    expect(err(go(req({ value: '9.00', currency: 'EUR' }, ''), khh({ stage: 'CHARGEBACK' })))).toBe('409 ACTION_STAGE');
    expect(err(go(req({ value: '9.00', currency: 'EUR' }, '')))).toBe('422 CURRENCY_MISMATCH');
    expect(err(go(req({ value: '9.00', currency: 'USD' }, ''), khh({ amount: { value: '7', currency: 'XYZ' } })))).toBe('422 UNKNOWN_CURRENCY');
    expect(err(go(req({ value: '9.00', currency: 'USD' }, ''), khh({ amount: null })))).toBe('422 DISPUTE_AMOUNT_UNKNOWN');
    expect(err(go(req({ value: '7.01', currency: 'USD' }, '')))).toBe('422 AMOUNT_ABOVE_DISPUTE');
    expect(err(go(req({ value: '0', currency: 'USD' }, '')))).toBe('422 AMOUNT_ABOVE_DISPUTE');
    expect(err(go(req(null, '')))).toBe('422 AMOUNT_REQUIRED');
    expect(err(go(req({ value: '7.00', currency: 'USD' }, '')))).toBe('422 TEXT_REQUIRED');
    expect(err(go(req({ value: '7.00', currency: 'USD' }, 'x'.repeat(ACTION_TEXT_LIMIT + 1))))).toBe('422 TEXT_TOO_LONG');
    // No amount asked: the dispute amount is not needed.
    expect(err(composeActionWith({ ...base, req: { action: 'send_message', text: 'Hi', attachments: [] }, snap: khh({ amount: null }) }, reg, rules))).toBe('ok');

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
    expect(err(composeActionWith({ ...base, req: req({ value: '7.00', currency: 'USD' }), snap: khh() }, reg, { make_offer: () => ({ ...offer, belowDispute: true }) }))).toBe('422 AMOUNT_ABOVE_DISPUTE');
    expect(err(composeActionWith({ ...base, req: req({ value: '1.00', currency: 'USD' }), snap: khh() }, reg, { make_offer: () => ({ ...offer, amount: 'not_allowed' }) }))).toBe('422 AMOUNT_NOT_ALLOWED');
  });

  it('an accept with no amount and no dispute amount is refused: the owner never confirms a refund without an amount', () => {
    const acc = { ...CONTRACTS, 'accept_claim:REFUND': testContract('accept_claim:REFUND') };
    const rules = { accept_claim: (): ActionRules => ({ stages: null, amount: 'not_allowed', text: 'optional' }) };
    const accept = { action: 'accept_claim' as const, acceptType: 'REFUND', note: '', amount: null, attachments: [] as [] };
    expect(composeActionWith({ ...base, req: accept, snap: khh({ amount: null }) }, acc, rules)).toMatchObject({ status: 422, error: 'DISPUTE_AMOUNT_UNKNOWN' });
    expect(composeActionWith({ ...base, req: accept, snap: khh() }, acc, rules)).toMatchObject({ action: 'accept_claim', pin: { amount: { value: '7.00', currency: 'USD' } } });
  });

  it('the public entry points use the registry and the frozen rules only', () => {
    expect(Object.isFrozen(ACTION_RULES)).toBe(true);
    expect(composeAction.length).toBe(1);
    expect(actionAvailability.length).toBe(3);
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

  it('a second buyer message with the same key as one at approval still holds the send (multiset)', () => {
    const untimed = { postedBy: 'BUYER', time: null, content: 'Hi!', files: [] };
    const keys = [messageKey(untimed)];
    expect(relevantNewBuyerMessages('send_message', keys, khh({ messages: [untimed] }))).toEqual([]);
    expect(relevantNewBuyerMessages('send_message', keys, khh({ messages: [untimed, { ...untimed, content: 'Yo!' }] }))).toEqual([{ ...untimed, content: 'Yo!' }]);
  });
});

describe('send_message rules (Task 8, from the recorded contract)', () => {
  const base = { caseId: 'case-1', disputeId: 'PP-R-VQD-10193598', seller: 'JWULA7T75ZA4Q', files: [] };
  const msg = (text = 'The parcel left on 7 October.', attachments: string[] = []) => ({ action: 'send_message' as const, text, attachments });
  const err = (r: unknown) => (isComposeProblem(r) ? `${r.status} ${r.error}` : 'ok');
  const recorded = [w1, w2, w3] as Array<{ before: { dispute_life_cycle_stage: string }; after: Array<{ dispute: { dispute_life_cycle_stage: string } }> }>;

  it('the stage rule is the stages the contract recorded: INQUIRY only', () => {
    const stages = new Set(recorded.flatMap((c) => [c.before.dispute_life_cycle_stage, ...c.after.map((a) => a.dispute.dispute_life_cycle_stage)]));
    expect([...stages]).toEqual(['INQUIRY']);
    expect(ACTION_RULES.send_message?.(msg(), khh())).toEqual({ stages: ['INQUIRY'], amount: 'not_allowed', text: 'required' });
    expect(composeAction({ ...base, req: msg(), snap: khh({ stage: 'CHARGEBACK' }) })).toMatchObject({ status: 409, error: 'ACTION_STAGE' });
    expect(err(composeAction({ ...base, req: msg(), snap: khh({ stage: null }) }))).toBe('409 ACTION_STAGE');
  });

  it('composes through the real registry and rules: the text only, no amount, ≤ 2,000', () => {
    const ok = composeAction({ ...base, req: msg(), snap: khh() });
    expect(ok).toEqual({
      caseId: 'case-1',
      disputeId: 'PP-R-VQD-10193598',
      ...ACTION_EVIDENCE_BLANK,
      files: [],
      action: 'send_message',
      payload: { kind: 'send_message', text: 'The parcel left on 7 October.' },
      pin: { disputeId: 'PP-R-VQD-10193598', seller: 'JWULA7T75ZA4Q', stage: 'INQUIRY', status: 'WAITING_FOR_SELLER_RESPONSE', amount: { value: '7.00', currency: 'USD' } },
    });
    // No dispute amount is needed for a message.
    expect(err(composeAction({ ...base, req: msg(), snap: khh({ amount: null }) }))).toBe('ok');
    expect(err(composeAction({ ...base, req: msg('x'.repeat(ACTION_TEXT_LIMIT)), snap: khh() }))).toBe('ok');
    expect(err(composeAction({ ...base, req: msg('x'.repeat(ACTION_TEXT_LIMIT + 1)), snap: khh() }))).toBe('422 TEXT_TOO_LONG');
    expect(err(composeAction({ ...base, req: msg('   '), snap: khh() }))).toBe('422 TEXT_REQUIRED');
    // The availability says so too, for a reviewer and a member (messages are not owner-only).
    for (const who of [OWNER, REVIEWER, MEMBER]) expect(actionAvailability(khh(), 'send_message', who)).toMatchObject({ offered: true, sendable: true, why: null });
  });

  it('one confirmed upload goes with it only while send_message:file is available', () => {
    const file = { name: 'tracking.png', size: '2 KB' };
    expect(composeAction({ ...base, req: msg('Screenshot attached.', [upl(1)]), snap: khh(), files: [file] })).toMatchObject({ action: 'send_message', files: [file] });
    const noFile = { ...CONTRACTS, 'send_message:file': { ...CONTRACTS['send_message:file'], status: 'not_available' as const, reason: 'Contract not recorded yet' } };
    expect(composeActionWith({ ...base, req: msg('Screenshot attached.', [upl(1)]), snap: khh(), files: [file] }, noFile)).toMatchObject({ status: 409, error: 'VARIANT_NOT_AVAILABLE', detail: 'Not available: Contract not recorded yet' });
    // The text alone is still available then.
    expect(err(composeActionWith({ ...base, req: msg(), snap: khh() }, noFile))).toBe('ok');
  });
});

describe('accept_claim rules (Task 9, from the recorded contracts W-9 and W-10)', () => {
  const base = { caseId: 'case-1', disputeId: 'PP-R-PAU-10193600', seller: 'JWULA7T75ZA4Q', files: [] };
  const accept = (acceptType: string, amount: { value: string; currency: string } | null = null, note = w10.request.body.note) => ({ action: 'accept_claim' as const, acceptType, note, amount, attachments: [] as [] });
  const err = (r: unknown) => (isComposeProblem(r) ? `${r.status} ${r.error}` : 'ok');
  const approved = (c: unknown): SubmissionIntent => ({ ...(c as SubmissionIntent), id: 'int-9', contentHash: 'b'.repeat(64), requestId: 'rk-int-9', status: 'approved' });

  it('accept variants: REFUND and PARTIAL_REFUND available as recorded; return-address types follow the registry', () => {
    expect(actionAvailability(khh(), 'accept_claim', OWNER)).toMatchObject({
      offered: true,
      sendable: true,
      why: null,
      variants: [
        { variant: 'accept_claim:PARTIAL_REFUND', type: 'PARTIAL_REFUND', available: true, why: null },
        { variant: 'accept_claim:REFUND', type: 'REFUND', available: true, why: null },
      ],
    });
    for (const who of [REVIEWER, MEMBER]) expect(actionAvailability(khh(), 'accept_claim', who)).toMatchObject({ sendable: false, why: 'Only the workspace owner can send this action' });
    const ret = khh({ responseOptions: { acceptClaimTypes: ['REFUND_WITH_RETURN', 'REFUND'], offerTypes: [] } });
    expect(actionAvailability(ret, 'accept_claim', OWNER).variants[0]).toEqual({ variant: 'return_address', type: 'REFUND_WITH_RETURN', available: false, why: CONTRACTS.return_address.reason });
    expect(composeAction({ ...base, req: accept('REFUND_WITH_RETURN'), snap: ret })).toMatchObject({ status: 409, error: 'VARIANT_NOT_AVAILABLE', detail: `Not available: ${CONTRACTS.return_address.reason}` });
    // Only the types PayPal allows now: after a partial accept, REFUND only (W-9 +30 s).
    const after = khh({ status: 'WAITING_FOR_BUYER_RESPONSE', responseOptions: { acceptClaimTypes: w9.after[1]!.dispute.allowed_response_options!.accept_claim.accept_claim_types, offerTypes: [] } });
    expect(err(composeAction({ ...base, req: accept('PARTIAL_REFUND', { value: '2.00', currency: 'USD' }), snap: after }))).toBe('409 VARIANT_NOT_AVAILABLE');
  });

  it('the stage rule is the stage both contracts recorded: INQUIRY only', () => {
    const stages = new Set([w9, w10].flatMap((c) => [c.before.dispute_life_cycle_stage, ...c.after.map((a) => a.dispute.dispute_life_cycle_stage)]));
    expect([...stages]).toEqual(['INQUIRY']);
    expect(err(composeAction({ ...base, req: accept('REFUND'), snap: khh({ stage: 'CHARGEBACK' }) }))).toBe('409 ACTION_STAGE');
  });

  it('REFUND: no amount for not-received (W-10 passed none); the terms name the dispute amount and REFUNDS_BUYER', () => {
    expect(w10.before.reason).toBe('MERCHANDISE_OR_SERVICE_NOT_RECEIVED');
    expect(Object.keys(w10.request.body)).toEqual(['note', 'accept_claim_type']);
    expect(composeAction({ ...base, req: accept('REFUND', { value: '7.00', currency: 'USD' }), snap: khh() })).toMatchObject({ status: 422, error: 'AMOUNT_NOT_ALLOWED' });
    const c = composeAction({ ...base, req: accept('REFUND'), snap: khh() });
    expect(c).toMatchObject({ action: 'accept_claim', payload: { kind: 'accept_claim', acceptType: 'REFUND', note: w10.request.body.note, amount: null } });
    const i = approved(c);
    expect(confirmationTerms(i, false)).toEqual({ intentId: 'int-9', contentHash: 'b'.repeat(64), action: 'accept_claim', amount: '7.00', currency: 'USD', consequence: 'REFUNDS_BUYER' });
    expect(consequenceText(i)).toBe('PayPal refunds 7.00 USD to the buyer and closes the dispute in the buyer’s favour. This cannot be undone.');
    // A note is required in this delivery: an accept without one was never recorded.
    for (const t of ['REFUND', 'PARTIAL_REFUND']) expect(err(composeAction({ ...base, req: accept(t, t === 'REFUND' ? null : { value: '2.00', currency: 'USD' }, ''), snap: khh() }))).toBe('422 TEXT_REQUIRED');
    expect(ACTION_RULES.accept_claim?.(accept('REFUND'), khh())).toMatchObject({ text: 'required' });
    // The note is trimmed in the approved content, as the composer and the server's parser trim it.
    expect(composeAction({ ...base, req: accept('REFUND', null, '  Refund accepted.  '), snap: khh() })).toMatchObject({ payload: { note: 'Refund accepted.' } });
  });

  it('REFUND is bound to what PayPal will refund: allowed_refund_amount equal to the dispute amount, as W-10 recorded', () => {
    expect(w10.before.refund_details.allowed_refund_amount).toEqual(w10.before.dispute_amount);
    const why = "Not available: PayPal's refundable amount differs from the dispute amount";
    for (const allowedRefund of [{ value: '5.00', currency: 'USD' }, null, undefined]) {
      const s = khh({ allowedRefund });
      expect(composeAction({ ...base, req: accept('REFUND'), snap: s })).toMatchObject({ status: 409, error: 'VARIANT_NOT_AVAILABLE', detail: why });
      expect(actionAvailability(s, 'accept_claim', OWNER).variants.find((v) => v.type === 'REFUND')).toMatchObject({ available: false, why: why.replace('Not available: ', '') });
    }
    // PARTIAL_REFUND: strictly below the refundable amount.
    const five = khh({ allowedRefund: { value: '5.00', currency: 'USD' } });
    expect(err(composeAction({ ...base, req: accept('PARTIAL_REFUND', { value: '5.00', currency: 'USD' }), snap: five }))).toBe('422 AMOUNT_ABOVE_REFUNDABLE');
    expect(err(composeAction({ ...base, req: accept('PARTIAL_REFUND', { value: '4.99', currency: 'USD' }), snap: five }))).toBe('ok');
    expect(err(composeAction({ ...base, req: accept('PARTIAL_REFUND', { value: '1.00', currency: 'USD' }), snap: khh({ allowedRefund: null }) }))).toBe('409 VARIANT_NOT_AVAILABLE');
  });

  it('only the recorded reason (not received): another reason is not verified with PayPal', () => {
    const nad = khh({ reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' });
    for (const [t, amount] of [['REFUND', null], ['PARTIAL_REFUND', { value: '2.00', currency: 'USD' }]] as const)
      expect(composeAction({ ...base, req: accept(t, amount), snap: nad })).toMatchObject({ status: 409, error: 'VARIANT_NOT_AVAILABLE', detail: 'Not available: not verified with PayPal for this dispute reason' });
    expect(actionAvailability(nad, 'accept_claim', OWNER)).toMatchObject({ sendable: false, why: 'not verified with PayPal for this dispute reason' });
  });

  it('PARTIAL_REFUND: an amount below the dispute amount; an offer to the buyer, never presented as a refund', () => {
    expect(w9.request.body).toEqual({ note: w9.request.body.note, accept_claim_type: 'PARTIAL_REFUND', refund_amount: { currency_code: 'USD', value: '2.00' } });
    expect(err(composeAction({ ...base, req: accept('PARTIAL_REFUND'), snap: khh() }))).toBe('422 AMOUNT_REQUIRED');
    expect(err(composeAction({ ...base, req: accept('PARTIAL_REFUND', { value: '7.00', currency: 'USD' }), snap: khh() }))).toBe('422 AMOUNT_ABOVE_DISPUTE');
    expect(err(composeAction({ ...base, req: accept('PARTIAL_REFUND', { value: '2.00', currency: 'EUR' }), snap: khh() }))).toBe('422 CURRENCY_MISMATCH');
    const c = composeAction({ ...base, req: accept('PARTIAL_REFUND', { value: '2', currency: 'USD' }, w9.request.body.note), snap: khh() });
    expect(c).toMatchObject({ payload: { kind: 'accept_claim', acceptType: 'PARTIAL_REFUND', note: w9.request.body.note, amount: { value: '2.00', currency: 'USD' } } });
    const i = approved(c);
    expect(confirmationTerms(i, false)).toEqual({ intentId: 'int-9', contentHash: 'b'.repeat(64), action: 'accept_claim', amount: '2.00', currency: 'USD', consequence: 'OFFERS_PARTIAL_REFUND' });
    const text = consequenceText(i);
    expect(text).toContain('2.00 USD');
    expect(text).toContain('buyer');
    expect(text).toBe('PayPal offers the buyer a partial refund of 2.00 USD. The buyer has to agree to it: unless they accept, no money moves and the dispute stays open.');
    expect(text).not.toMatch(/PayPal refunds|closes the dispute|cannot be undone/);
  });
});

describe('escalate rules (Task 10, from the recorded contract W-5)', () => {
  const base = { caseId: 'case-1', disputeId: 'PP-R-NDZ-10193597', seller: 'JWULA7T75ZA4Q', files: [] };
  const escalate = (note = w5.request.body.note) => ({ action: 'escalate' as const, note, attachments: [] as [] });
  const err = (r: unknown) => (isComposeProblem(r) ? `${r.status} ${r.error}` : 'ok');
  const approved = (c: unknown): SubmissionIntent => ({ ...(c as SubmissionIntent), id: 'int-10', contentHash: 'e'.repeat(64), requestId: 'rk-int-10', status: 'approved' });

  it('available as recorded, to the owner only; another reason is not verified with PayPal', () => {
    expect(actionAvailability(khh(), 'escalate', OWNER)).toMatchObject({ offered: true, sendable: true, why: null, variants: [{ variant: 'escalate', type: null, available: true, why: null }] });
    for (const who of [REVIEWER, MEMBER]) expect(actionAvailability(khh(), 'escalate', who)).toMatchObject({ sendable: false, why: 'Only the workspace owner can send this action' });
    const nad = khh({ reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' });
    expect(actionAvailability(nad, 'escalate', OWNER)).toMatchObject({ sendable: false, why: 'not verified with PayPal for this dispute reason' });
    expect(composeAction({ ...base, req: escalate(), snap: nad })).toMatchObject({ status: 409, error: 'VARIANT_NOT_AVAILABLE', detail: 'Not available: not verified with PayPal for this dispute reason' });
  });

  it('the stage rule is the stage W-5 was sent from: INQUIRY only', () => {
    expect(w5.before.dispute_life_cycle_stage).toBe('INQUIRY');
    expect(err(composeAction({ ...base, req: escalate(), snap: khh({ stage: 'CHARGEBACK' }) }))).toBe('409 ACTION_STAGE');
  });

  it('a note (≤ 2,000, trimmed), no amount; terms MOVES_TO_CLAIM with no amount; the consequence in plain words', () => {
    expect(Object.keys(w5.request.body)).toEqual(['note']);
    expect(err(composeAction({ ...base, req: escalate('  '), snap: khh() }))).toBe('422 TEXT_REQUIRED');
    expect(err(composeAction({ ...base, req: escalate('x'.repeat(ACTION_TEXT_LIMIT + 1)), snap: khh() }))).toBe('422 TEXT_TOO_LONG');
    expect(ACTION_RULES.escalate?.(escalate(), khh())).toEqual({ stages: ['INQUIRY'], amount: 'not_allowed', text: 'required' });
    const c = composeAction({ ...base, req: escalate(`  ${w5.request.body.note}  `), snap: khh() });
    expect(c).toMatchObject({ action: 'escalate', payload: { kind: 'escalate', note: w5.request.body.note } });
    const i = approved(c);
    expect(confirmationTerms(i, false)).toEqual({ intentId: 'int-10', contentHash: 'e'.repeat(64), action: 'escalate', amount: null, currency: null, consequence: 'MOVES_TO_CLAIM' });
    expect(consequenceText(i)).toBe('The inquiry becomes a claim decided by PayPal. Inquiry actions end; what you can do next is what PayPal offers on the claim.');
  });

  it('a new buyer message does not hold escalate', () => {
    const i = approved(composeAction({ ...base, req: escalate(), snap: khh() }));
    const fresh = khh({ messages: [...khh().messages!, { postedBy: 'BUYER', time: '2026-10-19T09:00:00.000Z', content: 'Still nothing.', files: [] }] });
    expect(relevantNewBuyerMessages(intentAction(i), khh().messages!.map(messageKey), fresh)).toEqual([]);
  });
});
