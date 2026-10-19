export * from './paypal.ts';
export * from './agent.ts';
export * from './input.ts';
import type { CaseFile } from '../../../apps/web/src/domain/types.ts';
import { agentCase } from './fixtures/agentCase.ts';
import { budgetCase } from './fixtures/budgetCase.ts';
import { notAsDescribedCase } from './fixtures/notAsDescribedCase.ts';
import { RESOLVED_SENT_NOTES, resolvedCase } from './fixtures/resolvedCase.ts';
import { SETTLEMENT_CASE_ID, settlementCase } from './fixtures/settlementCase.ts';
import { sizeCase } from './fixtures/sizeCase.ts';
import { standardCase } from './fixtures/standardCase.ts';
import { UNAUTHORISED_SENT_NOTES, unauthorisedCase } from './fixtures/unauthorisedCase.ts';

export { agentCase, budgetCase, notAsDescribedCase, resolvedCase, settlementCase, sizeCase, standardCase, unauthorisedCase };
export { SETTLEMENT_CASE_ID };
export { RESOLVED_SENT_NOTES, UNAUTHORISED_SENT_NOTES };

/**
 * The cases with a full case file, by case id: every dispute in the inbox except the one PayPal is still processing,
 * and the owner-only settlement case (`audience: 'owner'`: no golden analysis, not in the demo inbox).
 */
export const CASE_FILES: Readonly<Record<string, CaseFile>> = Object.fromEntries(
  [standardCase, agentCase, notAsDescribedCase, sizeCase, budgetCase, unauthorisedCase, resolvedCase, settlementCase].map((c) => [c.summary.id, c]),
);
