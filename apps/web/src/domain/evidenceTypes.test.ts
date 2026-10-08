import { describe, expect, it } from 'vitest';
import { agentCase, standardCase } from '../fixtures';
import { NOT_ALLOWED_ERROR, defaultEvidenceType, evidenceTypeOptions, isEvidenceTypeAllowed, selectEvidenceType } from './evidenceTypes';

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
    expect(selectEvidenceType(o, 'PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND')).toBe('PROOF_OF_REFUND');
  });
});
