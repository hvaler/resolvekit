import { CONTRACTS, unavailableReason, variantOf } from './actionContracts.ts';
import type { ContractRegistry } from './actions.ts';
import type { DisputeReason, EvidenceType, EvidenceTypeCandidate } from './types';

/**
 * Evidence types PayPal rejects for a dispute reason, as verified in the sandbox
 * (docs/sandbox-findings.md): for "item or service not received" PayPal requests PROOF_OF_FULFILLMENT
 * even when the buyer declared a service, and answers PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED with
 * EVIDENCE_TYPE_IS_NOT_ALLOWED.
 */
export const NOT_ALLOWED_BY_REASON: Readonly<Partial<Record<DisputeReason, readonly EvidenceType[]>>> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: ['PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED'],
};

/**
 * The evidence types PayPal's "Dispute reasons and evidence" table lists for each reason
 * (developer.paypal.com/disputes/reasons-evidence, read 9 Oct 2026). The demo cases only send these.
 */
export const PAYPAL_EVIDENCE_BY_REASON: Readonly<Record<DisputeReason, readonly EvidenceType[]>> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: ['PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND', 'OTHER'],
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: ['OTHER', 'PROOF_OF_REFUND'],
  UNAUTHORISED: ['PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND', 'OTHER'],
  INCORRECT_AMOUNT: ['PROOF_OF_REFUND', 'OTHER'],
};

export const NOT_ALLOWED_ERROR = 'EVIDENCE_TYPE_IS_NOT_ALLOWED';

export const EVIDENCE_TYPE_LABEL: Readonly<Record<EvidenceType, string>> = {
  PROOF_OF_FULFILLMENT: 'Proof of fulfillment',
  PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED: 'Proof the service was delivered',
  PROOF_OF_REFUND: 'Proof of refund',
  OTHER: 'Other: notes and documents',
};

export interface EvidenceTypeOption {
  type: EvidenceType;
  label: string;
  /** Requirement line, or PayPal's reason when the type is not allowed. */
  detail: string;
  allowed: boolean;
  satisfied: boolean;
  /** PayPal asks for this type (source REQUESTED_FROM_SELLER). */
  requested: boolean;
  /**
   * The registry's reason when ResolveKit does not send this type in this delivery ([A2], [A7]; e.g. PROOF_OF_REFUND,
   * pending sandbox test W-11); null when it does. Such a type is shown disabled, never preselected nor selectable.
   */
  unavailable: string | null;
}

/** The registry's reason when evidence of this type is a variant not available (null: available, or not a variant). */
export function evidenceTypeUnavailable(type: EvidenceType, contracts: ContractRegistry = CONTRACTS): string | null {
  const v = variantOf('provide_evidence', type);
  return v ? unavailableReason(v, contracts) : null;
}

const isEvidenceType = (t: string): t is EvidenceType => Object.hasOwn(EVIDENCE_TYPE_LABEL, t);

/**
 * When PayPal requests evidence and every type it requests is one ResolveKit does not send in this delivery (today:
 * only PROOF_OF_REFUND requested), what to tell the person; null otherwise (nothing requested, or a requested type
 * ResolveKit sends). PayPal refuses any other type then (EVIDENCE_TYPE_NOT_REQUESTED), so nothing can be sent.
 */
export function requestedOnlyUnavailable(requested: readonly string[] | null | undefined, contracts: ContractRegistry = CONTRACTS): string | null {
  const types = [...new Set(requested ?? [])];
  if (!types.length) return null;
  const reasons = types.map((t) => (isEvidenceType(t) ? evidenceTypeUnavailable(t, contracts) : null));
  if (reasons.some((r) => r === null)) return null;
  const labels = types.map((t) => EVIDENCE_TYPE_LABEL[t as EvidenceType]).join(' and ');
  const why = [...new Set(reasons as string[])].join('; ');
  return `PayPal asks only for ${labels}, which ${types.length > 1 ? 'are' : 'is'} not available in this delivery: ${why}`;
}

export function isEvidenceTypeAllowed(reason: DisputeReason, type: EvidenceType): boolean {
  return !(NOT_ALLOWED_BY_REASON[reason] ?? []).includes(type);
}

export function evidenceTypeOptions(
  reason: DisputeReason,
  requested: EvidenceType | null,
  candidates: readonly EvidenceTypeCandidate[],
): EvidenceTypeOption[] {
  return candidates.map((c) => {
    const unavailable = evidenceTypeUnavailable(c.type);
    const allowed = !unavailable && isEvidenceTypeAllowed(reason, c.type);
    return {
      type: c.type,
      label: c.label,
      detail: unavailable ? `Not available: ${unavailable}` : allowed ? c.requirement : `PayPal won’t accept this type for a not-received dispute · ${NOT_ALLOWED_ERROR}`,
      allowed,
      satisfied: allowed && c.satisfied,
      requested: c.type === requested,
      unavailable,
    };
  });
}

/**
 * The type to preselect: none when every type PayPal requests (`requested`, the fresh read's list) is unavailable;
 * PayPal's requested type when it is allowed; otherwise the first allowed type whose requirements the case file meets;
 * otherwise null.
 */
export function defaultEvidenceType(options: readonly EvidenceTypeOption[], requested?: readonly string[] | null): EvidenceType | null {
  // PayPal asks only for types ResolveKit does not send: preselect nothing (any other type would be refused).
  if (requestedOnlyUnavailable(requested)) return null;
  const req = options.find((o) => o.requested && o.allowed);
  if (req) return req.type;
  return options.find((o) => o.allowed && o.satisfied)?.type ?? null;
}

/** Selecting a type that PayPal does not allow is ignored. */
export function selectEvidenceType(options: readonly EvidenceTypeOption[], current: EvidenceType | null, next: EvidenceType): EvidenceType | null {
  const o = options.find((x) => x.type === next);
  return o && o.allowed ? next : current;
}
