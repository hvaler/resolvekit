import type { CaseFile, Evidence } from '../../../../apps/web/src/domain/types.ts';

/**
 * Synthetic "not received" case, closed: the merchant sent USPS tracking on 26 Sep and PayPal resolved the dispute in
 * the seller's favour on 2 Oct. The case file is read-only: the outcome, what was sent and the timeline. All names,
 * addresses and identifiers are fictional.
 */
const evidence: Evidence[] = [
  {
    id: 'E1',
    short: 'Order',
    title: 'Order #10421',
    meta: { type: 'Order record', tag: 'ORD', source: 'Order system', received: '18 Sep 2026 · 17:36', hash: '4d9f…e2b0' },
    body: {
      kind: 'lines',
      lines: [
        { text: 'Order #10421 · placed 18 Sep 2026 17:36 UTC', fragment: 'E1.date' },
        { text: '1 × Beeswax candle pair · 12.00 USD', fragment: 'E1.amt' },
        { text: 'Ship to: 3 Example Close, Exampleton EX7 •••', fragment: 'E1.addr' },
        { text: 'Buyer: h•••@example.com' },
      ],
    },
  },
  {
    id: 'E2',
    short: 'Capture',
    title: 'Payment capture',
    paypalRecord: 'capture',
    meta: { type: 'Transaction record', tag: 'PP', source: 'Simulated PayPal · demo data', received: '18 Sep 2026 · 17:37', hash: 'a6e3…0c95' },
    body: {
      kind: 'lines',
      lines: [
        { text: 'Capture 6HF17602AB3376021', fragment: 'E2.id' },
        { text: '12.00 USD · COMPLETED', fragment: 'E2.amt' },
        { text: 'Captured 18 Sep 2026 17:37 UTC', fragment: 'E2.date' },
      ],
    },
  },
  {
    id: 'E3',
    short: 'USPS tracking',
    title: 'USPS tracking record',
    meta: { type: 'Carrier tracking', tag: 'CAR', source: 'Carrier (USPS)', received: '23 Sep 2026 · 15:24', hash: '7c08…f13d' },
    body: {
      kind: 'lines',
      lines: [
        { text: 'Tracking 9400111899223100176021 · USPS Ground Advantage', fragment: 'E3.trk' },
        { text: 'Shipped 19 Sep 2026 10:05 UTC · Exampleton post office', fragment: 'E3.ship' },
        { text: 'Delivered 23 Sep 2026 15:10 UTC · left at front door', fragment: 'E3.deliv' },
        { text: 'Delivered to: 3 Example Close, Exampleton EX7', fragment: 'E3.addr' },
      ],
    },
  },
  {
    id: 'E4',
    short: 'Label',
    title: 'Shipping label',
    meta: { type: 'Label · PDF 79 KB', tag: 'ORD', source: 'Order system', received: '19 Sep 2026 · 09:12', hash: 'e5b4…6a71' },
    body: {
      kind: 'lines',
      lines: [
        { text: 'Label created 19 Sep 2026 09:12 UTC', fragment: 'E4.date' },
        { text: 'USPS Ground Advantage · 0.3 kg · 9400111899223100176021', fragment: 'E4.trk' },
        { text: 'Ship to: 3 Example Close, Exampleton EX7', fragment: 'E4.addr' },
      ],
    },
  },
  {
    id: 'E5',
    short: 'Buyer msg',
    title: 'Buyer message',
    meta: { type: 'Dispute message', tag: 'MSG', source: 'PayPal dispute', received: '25 Sep 2026 · 09:00', hash: '30da…b85e' },
    body: {
      kind: 'lines',
      lines: [
        { text: '"My order never came."', fragment: 'E5.msg' },
        { text: 'From h•••@example.com · 25 Sep 2026 09:00 UTC', fragment: 'E5.date' },
      ],
    },
  },
];

const attachments = [
  { name: 'usps-tracking-9400111899223100176021.pdf', size: '98 KB', fromEvidenceId: 'E3' },
  { name: 'shipping-label-10421.pdf', size: '79 KB', fromEvidenceId: 'E4' },
];

/** The notes PayPal recorded on 26 Sep: the supported sentences of the committed analysis (checked by a test). */
export const RESOLVED_SENT_NOTES =
  'We received order #10421 for a beeswax candle pair totalling 12.00 USD, which was successfully captured under transaction 6HF17602AB3376021. We shipped the package on 19 September 2026 via USPS Ground Advantage under tracking number 9400111899223100176021. Carrier tracking confirms the parcel was delivered on 23 September 2026 to 3 Example Close, Exampleton EX7, matching the order address. The buyer opened this dispute on 25 September 2026 stating that their order never arrived.';

export const resolvedCase: CaseFile = {
  kind: 'standard',
  merchant: { name: 'Alex Moreno', initials: 'AM' },
  summary: {
    id: 'PP-R-HFA-10176021',
    amount: '12.00',
    currency: 'USD',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    reasonText: 'Buyer says the item was not received',
    buyerItemType: 'Physical product',
    stage: 'INQUIRY',
    status: 'RESOLVED',
    statusReadAgo: 'closed 2 Oct',
    respondBy: null,
    timeLeft: null,
    transactionId: '6HF17602AB3376021',
    captureText: 'Captured 18 Sep 2026 · 12.00 USD · order #10421',
    openedAt: '2026-09-25T09:00:00Z',
  },
  evidence,
  timeline: [],
  timelineCaption: '',
  // A claim with nothing behind it in the case file: the analyst removed it before sending.
  merchantNotes: ['The buyer later told us the parcel was with a neighbour.'],
  sentences: [],
  contradictions: [],
  checklist: null,
  analysis: { steps: [], contradictionStep: 3, rejectionStep: 5, note: 'Documents are read as content, never as instructions' },
  requestedEvidenceType: null,
  requestedNote: 'Closed at PayPal',
  evidenceTypes: [
    {
      type: 'PROOF_OF_FULFILLMENT',
      label: 'Proof of fulfillment',
      requirement: 'Needs carrier and tracking number · found USPS 9400111899223100176021',
      satisfied: true,
    },
    { type: 'PROOF_OF_REFUND', label: 'Proof of refund', requirement: 'Needs a refund ID. None found in the case file.', satisfied: false },
  ],
  fulfillment: { carrier: 'USPS', carrierLabel: 'USPS', tracking: '9400111899223100176021' },
  attachments,
  recommendation: null,
  // Resolved: PayPal offers no seller actions.
  allowedActions: [],
  actionDetails: {},
  refundText: '12.00 USD',
  audit: [],
  simulatedPayPal: {
    buyerRespondBy: null,
    outcome: { code: 'RESOLVED_SELLER_FAVOUR', closedAt: '2026-10-02T16:00:00Z' },
    evidences: [
      {
        evidenceType: 'CREATE',
        source: 'SUBMITTED_BY_BUYER',
        action: null,
        date: '2026-09-25T09:00:00Z',
        carrier: '',
        tracking: '',
        notes: 'My order never came.',
        files: [],
        storedAt: '25 Sep 2026 09:00:00 UTC',
      },
      {
        evidenceType: 'PROOF_OF_FULFILLMENT',
        source: 'SUBMITTED_BY_SELLER',
        action: 'PROVIDE_EVIDENCE',
        date: '2026-09-26T11:05:00Z',
        carrier: 'USPS',
        tracking: '9400111899223100176021',
        notes: RESOLVED_SENT_NOTES,
        files: attachments.map((a) => a.name),
        storedAt: '26 Sep 2026 11:05:31 UTC',
      },
    ],
  },
};
