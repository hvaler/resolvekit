import type { CaseFile, DisputeSnapshot } from '../domain/types';
import { CASE_FILES, agentCase, standardCase } from '@resolvekit/cases';
import { DEMO_NOW, inbox, ownerInbox, processingDispute, processingOpening } from './inbox';

export { agentCase, DEMO_NOW, inbox, ownerInbox, processingDispute, processingOpening, standardCase };

/** Every inbox dispute with a full case file (all but the one PayPal is still processing). */
export const caseFiles: Readonly<Record<string, CaseFile>> = CASE_FILES;

/**
 * The accept and offer types PayPal allows on an inquiry waiting for the seller, as every such sandbox read showed them
 * (reads/inquiry-waiting-seller-KHH.json, the `before` of W-9 and W-10): accept PARTIAL_REFUND or REFUND, offer
 * REFUND. Only for a case in that state that offers the action; any other state allows none in the simulator.
 */
function waitingSellerOptions(c: CaseFile): DisputeSnapshot['responseOptions'] | null {
  if (c.summary.stage !== 'INQUIRY' || c.summary.status !== 'WAITING_FOR_SELLER_RESPONSE') return null;
  return {
    acceptClaimTypes: c.allowedActions.includes('accept_claim') ? ['PARTIAL_REFUND', 'REFUND'] : [],
    offerTypes: c.allowedActions.includes('make_offer') ? ['REFUND'] : [],
  };
}

/**
 * Initial PayPal state of every dispute, as the simulated gateway serves it: a dispute waiting for the seller, or,
 * for the cases further on, the evidence already on it, the buyer's due date and PayPal's outcome.
 */
// The owner-only settlement case gets a snapshot too (a 9th, never listed in the demo inbox): harmless, unused there.
export const initialSnapshots: DisputeSnapshot[] = [
  ...Object.values(caseFiles).map(
    (c): DisputeSnapshot => ({
      id: c.summary.id,
      status: c.summary.status,
      stage: c.summary.stage,
      allowedActions: [...c.allowedActions],
      amount: { value: c.summary.amount, currency: c.summary.currency },
      reason: c.summary.reason,
      // What PayPal would refund: the dispute amount, as every waiting inquiry read showed it.
      ...(waitingSellerOptions(c) ? { allowedRefund: { value: c.summary.amount, currency: c.summary.currency } } : {}),
      ...(waitingSellerOptions(c) ? { responseOptions: waitingSellerOptions(c)! } : {}),
      evidences: structuredClone(c.simulatedPayPal?.evidences ?? []),
      ...(c.simulatedPayPal?.buyerRespondBy ? { buyerRespondBy: c.simulatedPayPal.buyerRespondBy } : {}),
      ...(c.simulatedPayPal?.outcome ? { outcome: c.simulatedPayPal.outcome } : {}),
      // The thread as PayPal would give it (empty when the case has none); a real read replaces it.
      messages: structuredClone(c.simulatedPayPal?.messages ?? []),
      readAt: '',
    }),
  ),
  { id: processingDispute.id, status: processingDispute.status, allowedActions: [], evidences: [], readAt: '' },
];
