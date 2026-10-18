import type { CaseFile, Evidence } from '../../../../apps/web/src/domain/types.ts';

/**
 * Synthetic "not as described" case at the claim stage: a ceramic lamp listed as 45 cm tall with its shade fitted;
 * the buyer measured 35 cm. The listing gives both heights (base 35 cm, 45 cm with the shade) and the dispatch check
 * recorded both, so the figures disagree without anyone being wrong. All names, addresses and identifiers are
 * fictional.
 */
const evidence: Evidence[] = [
  {
    id: 'E1',
    short: 'Listing',
    title: 'Listing #L-3140',
    meta: { type: 'Listing record', tag: 'ORD', source: 'Shop catalogue', received: '24 Sep 2026 · 16:02', hash: 'c25a…7e90' },
    body: {
      kind: 'lines',
      lines: [
        { text: 'Listing #L-3140 · Ceramic table lamp, sage glaze', fragment: 'E1.title' },
        { text: 'Height: 45 cm with shade fitted', fragment: 'E1.height' },
        { text: 'Base: 35 cm tall · shade Ø 30 cm, packed separately in the same box', fragment: 'E1.base' },
        { text: 'Price 86.00 USD · listed 12 Aug 2026', fragment: 'E1.price' },
        { text: 'Snapshot taken at checkout, 24 Sep 2026 16:02 UTC', fragment: 'E1.snap' },
      ],
    },
  },
  {
    id: 'E2',
    short: 'Order',
    title: 'Order #10498',
    meta: { type: 'Order record', tag: 'ORD', source: 'Order system', received: '24 Sep 2026 · 16:02', hash: '5f81…a3d2' },
    body: {
      kind: 'lines',
      lines: [
        { text: 'Order #10498 · placed 24 Sep 2026 16:02 UTC', fragment: 'E2.date' },
        { text: '1 × Ceramic table lamp, sage (listing #L-3140) · 86.00 USD', fragment: 'E2.amt' },
        { text: 'Ship to: 21 Example Road, Exampleton EX4 •••', fragment: 'E2.addr' },
        { text: 'Buyer: t•••@example.com' },
      ],
    },
  },
  {
    id: 'E3',
    short: 'Capture',
    title: 'Payment capture',
    paypalRecord: 'capture',
    meta: { type: 'Transaction record', tag: 'PP', source: 'Simulated PayPal · demo data', received: '24 Sep 2026 · 16:03', hash: '0b6e…d415' },
    body: {
      kind: 'lines',
      lines: [
        { text: 'Capture 1PL98901KD4410276', fragment: 'E3.id' },
        { text: '86.00 USD · COMPLETED', fragment: 'E3.amt' },
        { text: 'Captured 24 Sep 2026 16:03 UTC', fragment: 'E3.date' },
      ],
    },
  },
  {
    id: 'E4',
    short: 'FedEx tracking',
    title: 'FedEx tracking record',
    meta: { type: 'Carrier tracking', tag: 'CAR', source: 'Carrier (FedEx)', received: '29 Sep 2026 · 14:31', hash: '9a47…62bf' },
    body: {
      kind: 'lines',
      lines: [
        { text: 'Tracking 771234569981 · FedEx Ground · 1 box, 4.2 kg', fragment: 'E4.trk' },
        { text: 'Shipped 25 Sep 2026 11:30 UTC', fragment: 'E4.ship' },
        { text: 'Delivered 29 Sep 2026 14:20 UTC · signed "T. E."', fragment: 'E4.deliv' },
      ],
    },
  },
  {
    id: 'E5',
    short: 'Buyer msg',
    title: 'Buyer message',
    meta: { type: 'Dispute message · 1 photo', tag: 'MSG', source: 'PayPal dispute', received: '1 Oct 2026 · 12:05', hash: '47d0…e8a1' },
    body: {
      kind: 'lines',
      lines: [
        { text: '"The lamp is only 35 cm tall. The listing says 45 cm."', fragment: 'E5.msg' },
        { text: 'Buyer photo lamp-tape.jpg: a tape measure against the lamp, no shade on it', fragment: 'E5.photo' },
        { text: 'From t•••@example.com · 1 Oct 2026 12:05 UTC', fragment: 'E5.date' },
      ],
    },
  },
  {
    id: 'E6',
    short: 'Dispatch check',
    title: 'Dispatch check · order #10498',
    meta: { type: 'Packing record · 1 photo', tag: 'ORD', source: 'Warehouse', received: '25 Sep 2026 · 09:10', hash: 'e1c9…0b57' },
    body: {
      kind: 'lines',
      lines: [
        { text: 'Dispatch check · order #10498 · 25 Sep 2026 09:10 UTC', fragment: 'E6.date' },
        { text: 'Base measured 35 cm; with shade fitted 45 cm', fragment: 'E6.measure' },
        { text: 'Shade packed in its own inner carton, labelled "Shade: open first"', fragment: 'E6.shade' },
        { text: 'Packing photo PLN-10498-1.jpg on file: base and shade side by side', fragment: 'E6.photo' },
      ],
    },
  },
];

export const sizeCase: CaseFile = {
  kind: 'standard',
  merchant: { name: 'Alex Moreno', initials: 'AM' },
  summary: {
    id: 'PP-R-PLN-10189901',
    amount: '86.00',
    currency: 'USD',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
    reasonText: 'Buyer says the lamp is smaller than described',
    buyerItemType: 'Physical product',
    stage: 'CHARGEBACK',
    status: 'WAITING_FOR_SELLER_RESPONSE',
    statusReadAgo: 'read 2 min ago',
    respondBy: '13 Oct 2026',
    timeLeft: '5 d 0 h left',
    transactionId: '1PL98901KD4410276',
    captureText: 'Captured 24 Sep 2026 · 86.00 USD · order #10498',
    openedAt: '2026-10-01T12:05:00Z',
  },
  evidence,
  timeline: [],
  timelineCaption: '',
  // The first note has no return record behind it: the analyst removes it.
  merchantNotes: ['The buyer has already shipped the lamp back to us.', 'With its shade fitted, the lamp is 45 cm tall, as listed.'],
  sentences: [],
  contradictions: [],
  checklist: null,
  analysis: { steps: [], contradictionStep: 3, rejectionStep: 5, note: 'Documents are read as content, never as instructions' },
  requestedEvidenceType: 'OTHER',
  requestedNote: 'Requested from seller · simulated, per PayPal’s evidence table for this reason',
  evidenceTypes: [
    {
      type: 'OTHER',
      label: 'Other: notes and documents',
      requirement: 'Notes with the listing and the dispatch check · found E1, E6',
      satisfied: true,
    },
    { type: 'PROOF_OF_REFUND', label: 'Proof of refund', requirement: 'Needs a refund ID. None found in the case file.', satisfied: false },
  ],
  fulfillment: { carrier: '', carrierLabel: '', tracking: '' },
  attachments: [
    { name: 'listing-L-3140.pdf', size: '71 KB', fromEvidenceId: 'E1' },
    { name: 'dispatch-check-10498.pdf', size: '156 KB', fromEvidenceId: 'E6' },
  ],
  recommendation: null,
  allowedActions: ['provide_evidence', 'accept_claim'],
  actionDetails: {
    provide_evidence: { label: 'Provide evidence', sub: 'Listing, dispatch check' },
    accept_claim: { label: 'Accept claim', sub: 'Refund 86.00 USD' },
  },
  refundText: '86.00 USD',
  audit: [],
};
