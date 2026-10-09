import type { InboxDispute } from '../domain/inbox';
import type { ActionCode, DisputeSummary } from '../domain/types';

/**
 * The demo clock for the synthetic disputes: due times are computed from this instant, so the inbox reads
 * the same whenever the demo runs ("now" = 8 Oct 2026 19:00 UTC, as in the design).
 */
export const DEMO_NOW = new Date('2026-10-08T19:00:00Z');

/**
 * The eight synthetic disputes in the inbox. Due dates agree with the case files' "time left"; readiness is the
 * committed analysis's checklist (items present, of five); recorded and closed rows read as the simulator's snapshot
 * makes them (tests check all three).
 */
export const inbox: InboxDispute[] = [
  { id: 'PP-R-TVH-10190665', reason: 'Item not received', item: 'Physical product', amount: 7.0, currency: 'USD', stage: 'INQUIRY', status: 'WAITING_FOR_SELLER_RESPONSE', caseType: 'Standard', ready: 4, next: 'Resolve contradiction', nextKind: 'contra', nextSub: 'Address differs (Apt 4 / 4B)', respondBy: '2026-10-18T17:00:00Z', dueNote: null },
  { id: 'PP-R-MMC-10190702', reason: 'No confirmation of the service', item: 'Service', amount: 1.37, currency: 'USD', stage: 'INQUIRY', status: 'WAITING_FOR_SELLER_RESPONSE', caseType: 'Agent purchase', ready: 5, next: 'Approve response', nextKind: 'approve', nextSub: 'Draft ready · 5 of 7 supported', respondBy: '2026-10-18T18:00:00Z', dueNote: null },
  { id: 'PP-R-NKQ-10194410', reason: 'Item not received', item: 'Digital download', amount: 19.0, currency: 'USD', stage: null, status: 'UNDER_REVIEW', caseType: 'Standard', ready: null, next: 'PayPal processing', nextKind: 'processing', nextSub: 'Opened 4 min ago', respondBy: null, dueNote: 'Not set yet' },
  { id: 'PP-R-BLW-10187733', reason: 'Item not as described', item: 'Physical product', amount: 24.5, currency: 'USD', stage: 'CHARGEBACK', status: 'WAITING_FOR_SELLER_RESPONSE', caseType: 'Standard', ready: 4, next: 'Add photos of the item', nextKind: 'work', nextSub: 'Buyer says the colour differs', respondBy: '2026-10-10T01:00:00Z', dueNote: null },
  { id: 'PP-R-QZE-10181290', reason: 'Buyer doesn’t recognise the payment', item: 'Booking', amount: 49.0, currency: 'USD', stage: 'INQUIRY', status: 'WAITING_FOR_BUYER_RESPONSE', caseType: 'Standard', ready: 5, next: 'Nothing to do · buyer’s turn', nextKind: 'none', nextSub: 'Evidence recorded by the simulator', respondBy: null, dueNote: 'Buyer: by 18 Oct' },
  { id: 'PP-R-HFA-10176021', reason: 'Item not received', item: 'Physical product', amount: 12.0, currency: 'USD', stage: 'INQUIRY', status: 'RESOLVED', caseType: 'Standard', ready: 4, next: 'Nothing to do', nextKind: 'none', nextSub: 'Resolved in your favour · 2 Oct', respondBy: null, dueNote: 'Closed 2 Oct' },
  { id: 'PP-R-KDA-10192258', reason: 'Charged more than the approved budget', item: 'Service', amount: 3.2, currency: 'USD', stage: 'CHARGEBACK', status: 'WAITING_FOR_SELLER_RESPONSE', caseType: 'Agent purchase', ready: 5, next: 'Review 2 sentences', nextKind: 'work', nextSub: 'Draft ready · 4 of 7 supported', respondBy: '2026-10-10T15:00:00Z', dueNote: null },
  { id: 'PP-R-PLN-10189901', reason: 'Item not as described', item: 'Physical product', amount: 86.0, currency: 'USD', stage: 'CHARGEBACK', status: 'WAITING_FOR_SELLER_RESPONSE', caseType: 'Standard', ready: 3, next: 'Resolve contradiction', nextKind: 'contra', nextSub: 'Height differs (45 / 35 cm)', respondBy: '2026-10-13T19:00:00Z', dueNote: null },
];

/** A dispute PayPal has just opened: UNDER_REVIEW with no seller actions yet (see docs/sandbox-findings.md). */
export const processingDispute: DisputeSummary = {
  id: 'PP-R-NKQ-10194410',
  amount: '19.00',
  currency: 'USD',
  reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
  reasonText: 'Buyer says the item was not received',
  buyerItemType: 'Digital download',
  stage: null,
  status: 'UNDER_REVIEW',
  statusReadAgo: 'new dispute',
  respondBy: null,
  timeLeft: null,
  transactionId: '3MB80177RA0626149',
  captureText: 'Captured 7 Oct 2026 · 19.00 USD',
};

/**
 * What the simulated PayPal does with the new dispute: after a while it opens it to the seller
 * (WAITING_FOR_SELLER_RESPONSE in the inquiry stage, due in 10 days), as the sandbox does after ~5 minutes.
 */
export const processingOpening = {
  afterMs: 75_000,
  status: 'WAITING_FOR_SELLER_RESPONSE',
  stage: 'INQUIRY',
  respondBy: '2026-10-18T19:00:00Z',
  allowedActions: ['send_message', 'make_offer', 'accept_claim', 'provide_evidence', 'escalate'],
} as const satisfies { afterMs: number; status: string; stage: string; respondBy: string; allowedActions: readonly ActionCode[] };
