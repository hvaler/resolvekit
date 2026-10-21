import { describe, expect, it } from 'vitest';
import { CONTRACTS, STATUS_LABEL, statusLabel, unavailableReason, variantOf, type VariantId } from './actionContracts';

/** The variants whose flow is built (Task 8 onwards). */
const BUILT: VariantId[] = ['send_message', 'send_message:file', 'accept_claim:REFUND', 'accept_claim:PARTIAL_REFUND', 'escalate', 'evidence:after_escalation', 'make_offer:REFUND'];

/** Verified through ResolveKit's own flow in the sandbox, 20/10/2026 (V-1..V-6) and 21/10/2026 (V-7, the file message): every built variant. */
const VERIFIED: VariantId[] = ['send_message', 'send_message:file', 'make_offer:REFUND', 'accept_claim:PARTIAL_REFUND', 'accept_claim:REFUND', 'escalate', 'evidence:after_escalation'];

const IDS: VariantId[] = [
  'send_message',
  'send_message:file',
  'accept_claim:REFUND',
  'accept_claim:PARTIAL_REFUND',
  'escalate',
  'make_offer:REFUND',
  'make_offer:REPLACEMENT_WITHOUT_REFUND',
  'make_offer:withdraw',
  'appeal',
  'evidence:PROOF_OF_REFUND',
  'evidence:after_escalation',
  'return_address',
];

describe('action contracts', () => {
  it('every variant is Not available until its contract is recorded', () => {
    for (const c of Object.values(CONTRACTS)) if (!c.recorded) expect(c).toMatchObject({ status: 'not_available' });
    expect(Object.values(CONTRACTS).every((c) => c.status === 'not_available' || (c.recorded && c.evidence))).toBe(true);
  });

  it('lists exactly the variants, each under its own id, with a reason when not available', () => {
    expect(Object.keys(CONTRACTS).sort()).toEqual([...IDS].sort());
    for (const [id, c] of Object.entries(CONTRACTS)) {
      expect(c.id).toBe(id);
      if (c.status === 'not_available') expect(c.reason).toBeTruthy();
    }
  });

  it('documents the route and body of every variant PayPal documents', () => {
    for (const c of Object.values(CONTRACTS)) {
      if (c.route === null) continue;
      expect(c.route).toMatch(/^(POST|GET) \/v[12]\//);
      expect(c.docUrl).toMatch(/^https:\/\/developer\.paypal\.com\//);
      expect(c.body === 'json' || c.body === 'multipart' || c.route.startsWith('GET')).toBe(true);
    }
    expect(CONTRACTS.send_message.route).toBe('POST /v1/customer/disputes/{id}/send-message');
    expect(CONTRACTS['evidence:PROOF_OF_REFUND'].route).toBe('POST /v1/customer/disputes/{id}/provide-evidence');
  });

  it('says why withdraw and return types are not available, and claims a proof only where a read showed it', () => {
    expect(CONTRACTS['make_offer:withdraw'].reason).toBe('PayPal documents no route to withdraw an offer');
    expect(CONTRACTS.return_address.reason).toBe('Not in this delivery (owner decision)');
    expect(CONTRACTS['make_offer:REPLACEMENT_WITHOUT_REFUND']).toMatchObject({ status: 'not_available', recorded: null, reason: 'Not verified with PayPal: never offered on a sandbox dispute' });
    expect(CONTRACTS['evidence:PROOF_OF_REFUND']).toMatchObject({ status: 'not_available', recorded: null, reason: 'Not verified with PayPal: pending sandbox test (W-11)' });
    expect(CONTRACTS.appeal).toMatchObject({ status: 'not_available', recorded: null, reason: 'Not verified with PayPal: the sandbox could not produce an appealable dispute' });
    for (const id of IDS.filter((i) => CONTRACTS[i].recorded === null && i !== 'make_offer:withdraw' && i !== 'return_address' && i !== 'appeal' && i !== 'make_offer:REPLACEMENT_WITHOUT_REFUND' && i !== 'evidence:PROOF_OF_REFUND')) expect(CONTRACTS[id].reason).toBe('Contract not recorded yet');
    // A recorded contract whose flow is not built stays Not available, and says so.
    for (const id of IDS.filter((i) => CONTRACTS[i].recorded !== null && !BUILT.includes(i))) expect(CONTRACTS[id]).toMatchObject({ status: 'not_available', reason: 'Contract recorded; flow not built yet' });
    // Built (Tasks 8–11); verified in the sandbox through the app flow (V-1..V-7).
    for (const id of BUILT) expect(CONTRACTS[id]).toMatchObject({ status: VERIFIED.includes(id) ? 'verified_in_sandbox' : 'tested_locally', reason: null });
    expect(CONTRACTS['send_message:file'].status).toBe('verified_in_sandbox');
    expect(IDS.filter((i) => CONTRACTS[i].status === 'verified_in_sandbox').sort()).toEqual([...VERIFIED].sort());
    // Nothing is deployed: the branch is neither merged nor deployed.
    expect(IDS.filter((i) => CONTRACTS[i].status === 'deployed')).toEqual([]);
    expect(CONTRACTS.send_message).toMatchObject({ recorded: 'packages/paypal/contracts/send_message.json', absentAfterMs: 60_000, requestIdDedupes: false, body: 'json' });
    const withProof = IDS.filter((i) => CONTRACTS[i].proof !== null).sort();
    expect(withProof).toEqual(['accept_claim:PARTIAL_REFUND', 'accept_claim:REFUND', 'escalate', 'make_offer:REFUND', 'send_message', 'send_message:file']);
  });

  it('a variant verified in sandbox has its recorded contract and its evidence', () => {
    for (const c of Object.values(CONTRACTS)) {
      if (c.status !== 'verified_in_sandbox') continue;
      expect(c.recorded).toMatch(/^packages\/paypal\/contracts\/.+\.json$/);
      expect(c.evidence).toMatch(/\.md$/);
      expect(c.reason).toBeNull();
    }
  });

  it('only the built variants are available (no «Not available» reason)', () => {
    for (const id of IDS) expect(unavailableReason(id) === null).toBe(BUILT.includes(id));
  });

  it('status labels: «Not available: reason» or the status by name', () => {
    expect(statusLabel(CONTRACTS.send_message)).toBe('Verified in sandbox');
    expect(statusLabel(CONTRACTS['send_message:file'])).toBe('Verified in sandbox');
    expect(statusLabel(CONTRACTS.appeal)).toBe('Not available: Not verified with PayPal: the sandbox could not produce an appealable dispute');
    expect(statusLabel({ ...CONTRACTS.escalate, status: 'not_available', reason: null })).toBe('Not available');
    expect(Object.values(STATUS_LABEL)).toEqual(['Not available', 'Implemented', 'Tested locally', 'Verified in sandbox', 'Deployed']);
  });

  it('maps an action and its type to its variant; anything unknown is null', () => {
    expect(variantOf('send_message')).toBe('send_message');
    expect(variantOf('send_message', 'file')).toBe('send_message:file');
    expect(variantOf('accept_claim', 'REFUND')).toBe('accept_claim:REFUND');
    expect(variantOf('accept_claim', 'PARTIAL_REFUND')).toBe('accept_claim:PARTIAL_REFUND');
    expect(variantOf('accept_claim', 'REFUND_WITH_RETURN')).toBe('return_address');
    expect(variantOf('make_offer', 'REFUND')).toBe('make_offer:REFUND');
    expect(variantOf('make_offer', 'REPLACEMENT_WITHOUT_REFUND')).toBe('make_offer:REPLACEMENT_WITHOUT_REFUND');
    expect(variantOf('make_offer', 'REFUND_WITH_RETURN')).toBe('return_address');
    expect(variantOf('make_offer', 'withdraw')).toBe('make_offer:withdraw');
    expect(variantOf('escalate')).toBe('escalate');
    expect(variantOf('appeal')).toBe('appeal');
    expect(variantOf('provide_evidence', 'PROOF_OF_REFUND')).toBe('evidence:PROOF_OF_REFUND');
    expect(variantOf('provide_evidence', 'after_escalation')).toBe('evidence:after_escalation');
    expect(variantOf('provide_evidence', 'PROOF_OF_FULFILLMENT')).toBeNull();
    expect(variantOf('provide_evidence')).toBeNull();
    expect(variantOf('accept_claim')).toBeNull();
    expect(variantOf('accept_claim', 'SOMETHING_ELSE')).toBeNull();
    expect(variantOf('make_offer', null)).toBeNull();
  });
});
