import { describe, expect, it } from 'vitest';
import { agentCase, standardCase } from '../fixtures';
import { CONTRACTS } from './actionContracts';
import { NOT_ALLOWED_ERROR, defaultEvidenceType, evidenceTypeOptions, isEvidenceTypeAllowed, requestedNotice, requestedOnlyUnavailable, selectEvidenceType } from './evidenceTypes';
import { SIM_TRANSITIONS } from './simulatedActions';
import { notAsDescribedCase } from '@resolvekit/cases';

describe('evidence type choice (docs/sandbox-findings.md)', () => {
  it('disables PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED for not-received disputes', () => {
    expect(isEvidenceTypeAllowed('MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED')).toBe(false);
    expect(isEvidenceTypeAllowed('MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', 'PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED')).toBe(true);
    const o = evidenceTypeOptions(standardCase.summary.reason, standardCase.requestedEvidenceType, standardCase.evidenceTypes);
    const svc = o.find((x) => x.type === 'PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED')!;
    expect(svc.allowed).toBe(false);
    expect(svc.detail).toContain(NOT_ALLOWED_ERROR);
  });

  it('preselects the type PayPal requests, even when the buyer declared a service', () => {
    expect(agentCase.summary.buyerItemType).toBe('Service');
    const o = evidenceTypeOptions(agentCase.summary.reason, agentCase.requestedEvidenceType, agentCase.evidenceTypes);
    expect(defaultEvidenceType(o)).toBe('PROOF_OF_FULFILLMENT');
    expect(o.find((x) => x.requested)?.type).toBe('PROOF_OF_FULFILLMENT');
  });

  it('falls back to the first allowed type whose requirements are met', () => {
    const o = evidenceTypeOptions('MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED', [
      { type: 'PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED', label: 'svc', requirement: '', satisfied: true },
      { type: 'PROOF_OF_REFUND', label: 'refund', requirement: '', satisfied: false },
      { type: 'PROOF_OF_FULFILLMENT', label: 'pof', requirement: '', satisfied: true },
    ]);
    expect(defaultEvidenceType(o)).toBe('PROOF_OF_FULFILLMENT');
  });

  it('ignores a selection PayPal would reject', () => {
    const o = evidenceTypeOptions(standardCase.summary.reason, standardCase.requestedEvidenceType, standardCase.evidenceTypes);
    expect(selectEvidenceType(o, 'PROOF_OF_FULFILLMENT', 'PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED')).toBe('PROOF_OF_FULFILLMENT');
    // PROOF_OF_REFUND is not available in this delivery (registry): choosing it is ignored too.
    expect(selectEvidenceType(o, 'PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND')).toBe('PROOF_OF_FULFILLMENT');
  });
});

describe('PROOF_OF_REFUND is not available in this delivery (Task 12, owner decision 20/10/2026)', () => {
  const REASON = 'Not verified with PayPal: pending sandbox test (W-11)';
  const candidates = [
    { type: 'PROOF_OF_FULFILLMENT' as const, label: 'pof', requirement: 'Carrier and tracking.', satisfied: true },
    { type: 'PROOF_OF_REFUND' as const, label: 'refund', requirement: 'Refund id found.', satisfied: true },
    { type: 'OTHER' as const, label: 'other', requirement: 'Notes.', satisfied: true },
  ];

  it('is shown disabled with the registry reason, even when the case file would satisfy it', () => {
    const o = evidenceTypeOptions('MERCHANDISE_OR_SERVICE_NOT_RECEIVED', null, candidates);
    expect(CONTRACTS['evidence:PROOF_OF_REFUND'].reason).toBe(REASON);
    expect(o.find((x) => x.type === 'PROOF_OF_REFUND')).toMatchObject({ allowed: false, satisfied: false, detail: `Not available: ${REASON}`, unavailable: REASON });
    for (const t of ['PROOF_OF_FULFILLMENT', 'OTHER'] as const) expect(o.find((x) => x.type === t)).toMatchObject({ allowed: true, satisfied: true, unavailable: null });
  });

  it('when PayPal requests it, it stays requested but is never preselected nor selectable; the other types still are', () => {
    const o = evidenceTypeOptions('MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'PROOF_OF_REFUND', candidates);
    expect(o.find((x) => x.type === 'PROOF_OF_REFUND')).toMatchObject({ requested: true, allowed: false });
    expect(defaultEvidenceType(o)).toBe('PROOF_OF_FULFILLMENT');
    expect(selectEvidenceType(o, 'PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND')).toBe('PROOF_OF_FULFILLMENT');
    expect(selectEvidenceType(o, 'PROOF_OF_FULFILLMENT', 'OTHER')).toBe('OTHER');
  });

  it('PayPal asking only for it: the reason is given and nothing is preselected; among other types, the others are', () => {
    const only = `PayPal asks only for Proof of refund, which is not available in this delivery: ${REASON}`;
    expect(requestedOnlyUnavailable(['PROOF_OF_REFUND'])).toBe(only);
    expect(requestedOnlyUnavailable(['PROOF_OF_REFUND', 'PROOF_OF_REFUND'])).toBe(only);
    for (const r of [null, [], ['PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND', 'OTHER'], ['OTHER'], ['SOMETHING_NEW']]) expect(requestedOnlyUnavailable(r)).toBeNull();
    const o = evidenceTypeOptions('MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'PROOF_OF_REFUND', candidates);
    expect(defaultEvidenceType(o, ['PROOF_OF_REFUND'])).toBeNull();
    // Requested types exist: the first requested one that is available, never an unrequested type.
    expect(defaultEvidenceType(o, ['PROOF_OF_REFUND', 'OTHER'])).toBe('OTHER');
    expect(defaultEvidenceType(o)).toBe('PROOF_OF_FULFILLMENT');
  });

  it('preselects the first PayPal-requested type that is available, skipping PROOF_OF_REFUND (W-5 claim, [PROOF_OF_REFUND, OTHER])', () => {
    // W-5 +10 min: the claim requested PROOF_OF_FULFILLMENT, PROOF_OF_REFUND, OTHER.
    const w5 = SIM_TRANSITIONS.escalate![0]!.steps.find((x) => x.at === '10m')!.requested!;
    expect(w5).toEqual(['PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND', 'OTHER']);
    const all = evidenceTypeOptions('MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'PROOF_OF_FULFILLMENT', candidates);
    expect(defaultEvidenceType(all, w5)).toBe('PROOF_OF_FULFILLMENT');
    // A not-as-described case (OTHER satisfied, PROOF_OF_FULFILLMENT met too): OTHER, the requested one.
    const nad = evidenceTypeOptions(notAsDescribedCase.summary.reason, 'PROOF_OF_REFUND', notAsDescribedCase.evidenceTypes);
    expect(defaultEvidenceType(nad, ['PROOF_OF_REFUND', 'OTHER'])).toBe('OTHER');
    // Requested types that are all outside the options: nothing, not an unrequested type.
    expect(defaultEvidenceType(evidenceTypeOptions('MERCHANDISE_OR_SERVICE_NOT_RECEIVED', null, candidates.filter((x) => x.type !== 'OTHER')), ['OTHER'])).toBeNull();
  });

  it('PROOF_OF_REFUND requested with others: the notice says it is not available and points to the other requested types', () => {
    expect(requestedNotice(['PROOF_OF_REFUND', 'OTHER'])).toBe(`Proof of refund is not available in this delivery (${REASON}). PayPal also asks for Other: notes and documents: send that instead.`);
    expect(requestedNotice(['PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND', 'OTHER'])).toBe(
      `Proof of refund is not available in this delivery (${REASON}). PayPal also asks for Proof of fulfillment or Other: notes and documents: send one of those instead.`,
    );
    expect(requestedNotice(['PROOF_OF_REFUND'])).toBe(`PayPal asks only for Proof of refund, which is not available in this delivery: ${REASON}`);
    for (const r of [null, [], ['OTHER'], ['PROOF_OF_FULFILLMENT', 'OTHER']]) expect(requestedNotice(r)).toBeNull();
  });
});
