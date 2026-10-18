import type { CaseFile, Evidence } from '../../../../apps/web/src/domain/types.ts';

/**
 * Synthetic "unauthorised" case (the buyer doesn't recognise the payment) for a workshop booking. The merchant's
 * evidence was recorded on 6 Oct; PayPal now waits for the buyer. The case file opens in that recorded state: the
 * draft that was sent, locked, and PayPal's read-back of it. All names, addresses and identifiers are fictional.
 *
 * PayPal's reasons-and-evidence table: for UNAUTHORISED the seller sends proof of fulfillment (carrier and tracking),
 * a refund ID, or notes and documents (OTHER) such as proof of receipt. A booking has no tracking, so it went as OTHER.
 */
const evidence: Evidence[] = [
  {
    id: 'E1',
    short: 'Booking',
    title: 'Booking #B-4471',
    meta: { type: 'Booking record', tag: 'ORD', source: 'Booking system', received: '28 Sep 2026 · 19:41', hash: 'd8b2…3a6f' },
    body: {
      kind: 'lines',
      lines: [
        { text: 'Booking #B-4471 · Natural-dye linen workshop, 4 Oct 2026 18:00 UTC', fragment: 'E1.class' },
        { text: 'Booked 28 Sep 2026 19:41 UTC by r•••@example.com (the PayPal payer)', fragment: 'E1.booked' },
        { text: 'Guest name: R. Example · 1 seat · 49.00 USD', fragment: 'E1.guest' },
        { text: 'Booked from device dv-7f3a…e21c, also used for order #10377', fragment: 'E1.device' },
      ],
    },
  },
  {
    id: 'E2',
    short: 'Capture',
    title: 'Payment capture',
    paypalRecord: 'capture',
    meta: { type: 'Transaction record', tag: 'PP', source: 'Simulated PayPal · demo data', received: '28 Sep 2026 · 19:42', hash: '1f7c…b904' },
    body: {
      kind: 'lines',
      lines: [
        { text: 'Capture 9QZ18129VB0447152', fragment: 'E2.id' },
        { text: '49.00 USD · COMPLETED', fragment: 'E2.amt' },
        { text: 'Captured 28 Sep 2026 19:42 UTC', fragment: 'E2.date' },
      ],
    },
  },
  {
    id: 'E3',
    short: 'Emails',
    title: 'Confirmation and reminder emails',
    meta: { type: 'Email log', tag: 'MSG', source: 'Booking system', received: '3 Oct 2026 · 18:27', hash: '5a0e…c7d1' },
    body: {
      kind: 'lines',
      lines: [
        { text: 'Booking confirmation sent to r•••@example.com · 28 Sep 2026 19:42 UTC', fragment: 'E3.confirm' },
        { text: 'Reminder sent to r•••@example.com · 3 Oct 2026 18:00 UTC', fragment: 'E3.remind' },
        { text: 'Reminder opened 3 Oct 2026 18:27 UTC', fragment: 'E3.opened' },
      ],
    },
  },
  {
    id: 'E4',
    short: 'Check-in',
    title: 'Workshop check-in record',
    meta: { type: 'Attendance record', tag: 'ORD', source: 'Front desk', received: '4 Oct 2026 · 20:05', hash: 'b3e9…5f28' },
    body: {
      kind: 'lines',
      lines: [
        { text: 'Workshop #B-4471 · 4 Oct 2026', fragment: 'E4.class' },
        { text: 'Checked in 17:52 UTC at the front desk · guest "R. Example"', fragment: 'E4.checkin' },
        { text: 'Photo ID checked: no', fragment: 'E4.id' },
        { text: 'Attended the full workshop · left 20:05 UTC', fragment: 'E4.left' },
      ],
    },
  },
  {
    id: 'E5',
    short: 'Earlier order',
    title: 'Order #10377',
    meta: { type: 'Order record', tag: 'ORD', source: 'Order system', received: '14 Aug 2026 · 11:20', hash: '06c4…d9a3' },
    body: {
      kind: 'lines',
      lines: [
        { text: 'Order #10377 · placed 14 Aug 2026 11:20 UTC · 2 × Linen napkin set · 30.00 USD', fragment: 'E5.order' },
        { text: 'Paid by r•••@example.com · device dv-7f3a…e21c', fragment: 'E5.payer' },
        { text: 'Delivered 18 Aug 2026 · no dispute', fragment: 'E5.deliv' },
      ],
    },
  },
  {
    id: 'E6',
    short: 'Buyer msg',
    title: 'Buyer message',
    meta: { type: 'Dispute message', tag: 'MSG', source: 'PayPal dispute', received: '5 Oct 2026 · 08:15', hash: '9e61…2b7a' },
    body: {
      kind: 'lines',
      lines: [
        { text: '"I don’t recognise this 49.00 USD payment."', fragment: 'E6.msg' },
        { text: 'From r•••@example.com · 5 Oct 2026 08:15 UTC', fragment: 'E6.date' },
      ],
    },
  },
];

const attachments = [
  { name: 'booking-B-4471.pdf', size: '58 KB', fromEvidenceId: 'E1' },
  { name: 'check-in-B-4471.pdf', size: '41 KB', fromEvidenceId: 'E4' },
  { name: 'order-10377.pdf', size: '47 KB', fromEvidenceId: 'E5' },
];

/**
 * The notes PayPal recorded on 6 Oct: the supported sentences of the committed analysis, in order (a test checks
 * they are exactly what the draft sends).
 */
export const UNAUTHORISED_SENT_NOTES =
  'Payment capture 9QZ18129VB0447152 for the disputed amount of 49.00 USD was completed on 28 September 2026. We sent a booking confirmation and a reminder to r•••@example.com, which was opened on 3 October 2026. Guest R. Example checked in at our front desk at 17:52 UTC and attended the full workshop on 4 October 2026.';

export const unauthorisedCase: CaseFile = {
  kind: 'standard',
  merchant: { name: 'Alex Moreno', initials: 'AM' },
  summary: {
    id: 'PP-R-QZE-10181290',
    amount: '49.00',
    currency: 'USD',
    reason: 'UNAUTHORISED',
    reasonText: 'Buyer doesn’t recognise the payment',
    buyerItemType: 'Booking',
    stage: 'INQUIRY',
    status: 'WAITING_FOR_BUYER_RESPONSE',
    statusReadAgo: 'read 5 min ago',
    // PayPal stops returning the seller due date once the seller's evidence is in (docs/sandbox-findings.md).
    respondBy: null,
    timeLeft: null,
    transactionId: '9QZ18129VB0447152',
    captureText: 'Captured 28 Sep 2026 · 49.00 USD · booking #B-4471',
    openedAt: '2026-10-05T08:15:00Z',
  },
  evidence,
  timeline: [],
  timelineCaption: '',
  // The first note says more than the check-in record (E4: photo ID not checked): the analyst removed it.
  merchantNotes: ['The guest showed photo ID at check-in.', 'The buyer had bought from us before, in August.'],
  sentences: [],
  contradictions: [],
  checklist: null,
  analysis: { steps: [], contradictionStep: 3, rejectionStep: 5, note: 'Documents are read as content, never as instructions' },
  // Once the seller's evidence is in, PayPal's REQUESTED_FROM_SELLER entry disappears.
  requestedEvidenceType: null,
  requestedNote: 'The seller’s evidence is in',
  evidenceTypes: [
    {
      type: 'OTHER',
      label: 'Other: notes and documents',
      requirement: 'Notes with the booking, check-in and earlier order · found E1, E4, E5',
      satisfied: true,
    },
    { type: 'PROOF_OF_FULFILLMENT', label: 'Proof of fulfillment', requirement: 'Needs a carrier and tracking number. A workshop booking has none.', satisfied: false },
    { type: 'PROOF_OF_REFUND', label: 'Proof of refund', requirement: 'Needs a refund ID. None found in the case file.', satisfied: false },
  ],
  fulfillment: { carrier: '', carrierLabel: '', tracking: '' },
  attachments,
  recommendation: null,
  // After the seller's evidence, in the inquiry stage (docs/sandbox-findings.md).
  allowedActions: ['send_message', 'accept_claim', 'escalate'],
  actionDetails: {
    send_message: { label: 'Send message', sub: 'Ask or explain' },
    accept_claim: { label: 'Accept claim', sub: 'Refund 49.00 USD' },
    escalate: { label: 'Escalate', sub: 'Ask PayPal to decide' },
  },
  refundText: '49.00 USD',
  audit: [],
  simulatedPayPal: {
    buyerRespondBy: '2026-10-18T10:20:00Z',
    evidences: [
      {
        evidenceType: 'CREATE',
        source: 'SUBMITTED_BY_BUYER',
        action: null,
        date: '2026-10-05T08:15:00Z',
        carrier: '',
        tracking: '',
        notes: 'I don’t recognise this 49.00 USD payment.',
        files: [],
        storedAt: '5 Oct 2026 08:15:00 UTC',
      },
      {
        evidenceType: 'OTHER',
        source: 'SUBMITTED_BY_SELLER',
        action: 'PROVIDE_EVIDENCE',
        date: '2026-10-06T10:20:00Z',
        carrier: '',
        tracking: '',
        notes: UNAUTHORISED_SENT_NOTES,
        files: attachments.map((a) => a.name),
        storedAt: '6 Oct 2026 10:20:14 UTC',
      },
    ],
  },
};
