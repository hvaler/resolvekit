import type { CaseFile, DisputeSnapshot } from '../domain/types';
import { CASE_FILES, agentCase, standardCase } from '@resolvekit/cases';
import { DEMO_NOW, inbox, processingDispute, processingOpening } from './inbox';

export { agentCase, DEMO_NOW, inbox, processingDispute, processingOpening, standardCase };

/** Every inbox dispute with a full case file (all but the one PayPal is still processing). */
export const caseFiles: Readonly<Record<string, CaseFile>> = CASE_FILES;

/**
 * Initial PayPal state of every dispute, as the simulated gateway serves it: a dispute waiting for the seller, or,
 * for the cases further on, the evidence already on it, the buyer's due date and PayPal's outcome.
 */
export const initialSnapshots: DisputeSnapshot[] = [
  ...Object.values(caseFiles).map(
    (c): DisputeSnapshot => ({
      id: c.summary.id,
      status: c.summary.status,
      stage: c.summary.stage,
      allowedActions: [...c.allowedActions],
      evidences: structuredClone(c.simulatedPayPal?.evidences ?? []),
      ...(c.simulatedPayPal?.buyerRespondBy ? { buyerRespondBy: c.simulatedPayPal.buyerRespondBy } : {}),
      ...(c.simulatedPayPal?.outcome ? { outcome: c.simulatedPayPal.outcome } : {}),
      readAt: '',
    }),
  ),
  { id: processingDispute.id, status: processingDispute.status, allowedActions: [], evidences: [], readAt: '' },
];
