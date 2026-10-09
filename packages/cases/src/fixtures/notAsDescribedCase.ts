import type { CaseFile, Evidence } from '../../../../apps/web/src/domain/types.ts';

/**
 * Synthetic "not as described" case at the claim stage: a linen tote listed as natural (undyed) linen; the buyer says
 * the one received is navy. The case file has the listing, the catalogue photos and the return policy, but no photo
 * of the unit that was shipped: the gap the merchant has to close. The warehouse pick list (E7) records the navy SKU
 * for this order while the listing and the order are the natural one: the merchant's own records contradict each other,
 * and the analyst has to say so instead of drafting a defence they don't support. All names, addresses and identifiers
 * are fictional.
 *
 * PayPal's reasons-and-evidence table: for MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED the seller sends notes or
 * documents (evidence type OTHER) such as the product description and the return policy, or a refund ID.
 */
const evidence: Evidence[] = [
  {
    id: 'E1',
    short: 'Listing',
    title: 'Listing #L-2207',
    meta: { type: 'Listing record', tag: 'ORD', source: 'Shop catalogue', received: '29 Sep 2026 · 10:14', hash: '3b7e…c18a' },
    body: {
      kind: 'lines',
      lines: [
        { text: 'Listing #L-2207 · Linen tote, natural', fragment: 'E1.title' },
        { text: 'Colour: natural (undyed flax linen) · SKU TOTE-NAT-38', fragment: 'E1.colour' },
        { text: 'A navy version (SKU TOTE-NAV-38) is sold under listing #L-2231', fragment: 'E1.variant' },
        { text: 'Size 38 × 42 cm · cotton webbing handles', fragment: 'E1.size' },
        { text: 'Price 24.50 USD · listed 2 Sep 2026, unchanged since', fragment: 'E1.price' },
        { text: 'Snapshot taken at checkout, 29 Sep 2026 10:14 UTC', fragment: 'E1.snap' },
      ],
    },
  },
  {
    id: 'E2',
    short: 'Order',
    title: 'Order #10511',
    meta: { type: 'Order record', tag: 'ORD', source: 'Order system', received: '29 Sep 2026 · 10:14', hash: 'a90d…5e27' },
    body: {
      kind: 'lines',
      lines: [
        { text: 'Order #10511 · placed 29 Sep 2026 10:14 UTC', fragment: 'E2.date' },
        { text: '1 × Linen tote, natural (listing #L-2207, SKU TOTE-NAT-38) · 24.50 USD', fragment: 'E2.amt' },
        { text: 'Shipped 30 Sep 2026 · UPS 1Z999AA10123459921 · delivered 2 Oct 2026', fragment: 'E2.ship' },
        { text: 'Ship to: 7 Example Lane, Exampleton EX2 •••', fragment: 'E2.addr' },
        { text: 'Buyer: m•••@example.com' },
      ],
    },
  },
  {
    id: 'E3',
    short: 'Capture',
    title: 'Payment capture',
    paypalRecord: 'capture',
    meta: { type: 'Transaction record', tag: 'PP', source: 'Simulated PayPal · demo data', received: '29 Sep 2026 · 10:15', hash: '6c21…9fb0' },
    body: {
      kind: 'lines',
      lines: [
        { text: 'Capture 5RT61848PC2207415', fragment: 'E3.id' },
        { text: '24.50 USD · COMPLETED', fragment: 'E3.amt' },
        { text: 'Captured 29 Sep 2026 10:15 UTC', fragment: 'E3.date' },
      ],
    },
  },
  {
    id: 'E4',
    short: 'Photos',
    title: 'Product photos record',
    meta: { type: 'Photo log · 3 images', tag: 'ORD', source: 'Shop catalogue', received: '2 Sep 2026 · 15:30', hash: 'f4a8…1d63' },
    body: {
      kind: 'lines',
      lines: [
        { text: 'Listing photos for #L-2207 · taken 2 Sep 2026 in the studio', fragment: 'E4.taken' },
        { text: 'Photo 1 (front): tote on a white background, oatmeal-coloured undyed linen', fragment: 'E4.p1' },
        { text: 'Photo 2 (detail): weave close-up, natural flax fibres with visible slubs', fragment: 'E4.p2' },
        { text: 'Photo 3 (in use): tote carried over the shoulder, same oatmeal colour', fragment: 'E4.p3' },
        { text: 'Packing photo of order #10511: none on file', fragment: 'E4.packing' },
      ],
    },
  },
  {
    id: 'E5',
    short: 'Buyer msg',
    title: 'Buyer message',
    meta: { type: 'Dispute message · 1 photo', tag: 'MSG', source: 'PayPal dispute', received: '3 Oct 2026 · 08:40', hash: '2e5f…b7c4' },
    body: {
      kind: 'lines',
      lines: [
        { text: '"The tote I received is navy blue, not the natural colour shown in the listing."', fragment: 'E5.msg' },
        { text: 'Buyer photo tote-received.jpg: a dark navy tote lying on a bed, label not visible', fragment: 'E5.photo' },
        { text: 'From m•••@example.com · 3 Oct 2026 08:40 UTC', fragment: 'E5.date' },
      ],
    },
  },
  {
    id: 'E6',
    short: 'Returns',
    title: 'Return policy',
    meta: { type: 'Policy · PDF 38 KB', tag: 'ORD', source: 'Shop website', received: '1 Sep 2026 · 09:00', hash: '8d13…40e9' },
    body: {
      kind: 'lines',
      lines: [
        { text: 'Return policy · version of 1 Sep 2026', fragment: 'E6.ver' },
        { text: 'Returns accepted within 30 days of delivery', fragment: 'E6.window' },
        { text: 'If an item is not as described, we pay return shipping', fragment: 'E6.ship' },
        { text: 'Refund issued within 5 business days of receiving the return', fragment: 'E6.refund' },
      ],
    },
  },
  {
    id: 'E7',
    short: 'Pick list',
    title: 'Warehouse pick list',
    meta: { type: 'Fulfilment record', tag: 'ORD', source: 'Warehouse system', received: '30 Sep 2026 · 09:12', hash: 'c57a…0e3d' },
    body: {
      kind: 'lines',
      lines: [
        { text: 'Pick list PL-30-0918 · 30 Sep 2026 09:12 UTC · station 2', fragment: 'E7.date' },
        { text: 'Order #10511 · picked SKU TOTE-NAV-38 · qty 1', fragment: 'E7.sku' },
        { text: 'Scanned bin B-14 (navy totes) · packed and labelled 09:20 UTC', fragment: 'E7.bin' },
      ],
    },
  },
];

export const notAsDescribedCase: CaseFile = {
  kind: 'standard',
  merchant: { name: 'Alex Moreno', initials: 'AM' },
  summary: {
    id: 'PP-R-BLW-10187733',
    amount: '24.50',
    currency: 'USD',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
    reasonText: 'Buyer says the colour differs from the listing',
    buyerItemType: 'Physical product',
    stage: 'CHARGEBACK',
    status: 'WAITING_FOR_SELLER_RESPONSE',
    statusReadAgo: 'read 3 min ago',
    respondBy: '10 Oct 2026',
    timeLeft: '1 d 6 h left',
    transactionId: '5RT61848PC2207415',
    captureText: 'Captured 29 Sep 2026 · 24.50 USD · order #10511',
    openedAt: '2026-10-03T08:40:00Z',
  },
  evidence,
  evidenceSources: '7 documents',
  timeline: [],
  timelineCaption: '',
  // The first note claims a packing photo the case file does not have (E4: none on file): the analyst removes it.
  merchantNotes: ['Our packing photo shows the natural tote going into the box.', 'We offer the buyer a free return for a full refund.'],
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
      requirement: 'Notes with the listing, photos and return policy · found E1, E4, E6',
      satisfied: true,
    },
    { type: 'PROOF_OF_REFUND', label: 'Proof of refund', requirement: 'Needs a refund ID. None found in the case file.', satisfied: false },
  ],
  // Notes-and-documents evidence: no carrier or tracking goes to PayPal.
  fulfillment: { carrier: '', carrierLabel: '', tracking: '' },
  attachments: [
    { name: 'listing-L-2207.pdf', size: '64 KB', fromEvidenceId: 'E1' },
    { name: 'listing-photos-L-2207.pdf', size: '212 KB', fromEvidenceId: 'E4' },
    { name: 'return-policy.pdf', size: '38 KB', fromEvidenceId: 'E6' },
  ],
  recommendation: null,
  // Claim stage: PayPal's API allows send-message, make-offer and escalate only in the inquiry stage.
  allowedActions: ['provide_evidence', 'accept_claim'],
  actionDetails: {
    provide_evidence: { label: 'Provide evidence', sub: 'Listing, photos, policy' },
    accept_claim: { label: 'Accept claim', sub: 'Refund 24.50 USD' },
  },
  refundText: '24.50 USD',
  audit: [],
};
