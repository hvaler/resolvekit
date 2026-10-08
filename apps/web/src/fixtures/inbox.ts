import type { DisputeSummary, InboxRow } from '../domain/types';

export const inbox: InboxRow[] = [
  { id: 'PP-R-NKQ-10194410', reasonText: 'Buyer says the item was not received', item: 'Digital download', customer: 'r•••@example.net', amount: '19.00', stage: null, status: 'UNDER_REVIEW', respondBy: 'Not set yet', left: 'Opens shortly', state: 'processing', note: 'Actions appear shortly', ready: null },
  { id: 'PP-R-BLW-10187733', reasonText: 'Item not as described', item: 'Physical product', customer: 'm•••@example.org', amount: '24.50', stage: 'CHARGEBACK', status: 'WAITING_FOR_SELLER_RESPONSE', respondBy: '12 Oct 2026', left: '3 d 22 h', urgent: true, state: 'drafting', note: 'Analyst reading 4 of 7 documents', ready: 58 },
  { id: 'PP-R-TVH-10190665', reasonText: 'Buyer says the item was not received', item: 'Physical product', customer: 'j•••@example.com', amount: '7.00', stage: 'INQUIRY', status: 'WAITING_FOR_SELLER_RESPONSE', respondBy: '18 Oct 2026', left: '9 d 22 h', state: 'ready', note: 'Needs your approval', ready: 92 },
  { id: 'PP-R-MMC-10190702', reasonText: 'No confirmation of the service', item: 'Service', customer: 'a•••@example.com', amount: '1.37', stage: 'INQUIRY', status: 'WAITING_FOR_SELLER_RESPONSE', respondBy: '18 Oct 2026', left: '9 d 23 h', state: 'ready', note: 'Needs your approval', ready: 100, agent: true },
  { id: 'PP-R-QZE-10181290', reasonText: 'Buyer doesn’t recognise the payment', item: 'Booking', customer: 'k•••@example.com', amount: '49.00', stage: 'INQUIRY', status: 'WAITING_FOR_BUYER_RESPONSE', respondBy: '—', left: 'Buyer has 10 d', state: 'sent', note: 'Evidence recorded by PayPal', ready: 100 },
  { id: 'PP-R-HFA-10176021', reasonText: 'Buyer says the item was not received', item: 'Physical product', customer: 't•••@example.com', amount: '12.00', stage: 'INQUIRY', status: 'RESOLVED', respondBy: '—', left: 'Closed 2 Oct', state: 'closed', note: 'Resolved in your favour', ready: 100 },
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
