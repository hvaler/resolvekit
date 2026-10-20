import { describe, expect, it } from 'vitest';
import { agentCase, standardCase } from '../fixtures';
import { CONTRACTS } from './actionContracts';
import { NOT_ALLOWED_ERROR, defaultEvidenceType, evidenceTypeOptions, isEvidenceTypeAllowed, requestedOnlyUnavailable, selectEvidenceType } from './evidenceTypes';

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
    expect(defaultEvidenceType(o, ['PROOF_OF_REFUND', 'OTHER'])).toBe('PROOF_OF_FULFILLMENT');
    expect(defaultEvidenceType(o)).toBe('PROOF_OF_FULFILLMENT');
  });
});
