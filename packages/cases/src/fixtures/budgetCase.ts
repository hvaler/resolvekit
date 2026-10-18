import type { CaseFile, ReceiptCall } from '../../../../apps/web/src/domain/types.ts';

/**
 * Synthetic agent-purchase case, "incorrect amount" at the claim stage: the buyer approved a 5.00 USD budget for
 * an agent session on MeterMCP (a fictional metered tool provider) and sees 5.00 and 3.20 USD on the statement.
 * The 5.00 USD was the authorization hold; MeterMCP checks the hard cap before every call, captured the 3.20 USD the
 * successful calls cost and released the rest. The mandate, receipt and settlement are demo data (no real MeterMCP
 * session behind this dispute). All names and identifiers are fictional.
 *
 * PayPal's reasons-and-evidence table: for INCORRECT_AMOUNT the seller sends a refund ID for the difference, or
 * notes and documents (OTHER) giving the reason for the price difference.
 */
const SESSION = 'mm-sess-20261006-03';

// Seven tickers: a quote and a report each, one report failed (not charged) and was retried, and a last quote.
const plan: [string, 'quote_lookup' | 'deep_report', boolean][] = [
  ['14:03:10', 'quote_lookup', true],
  ['14:03:41', 'deep_report', true],
  ['14:05:02', 'quote_lookup', true],
  ['14:05:30', 'deep_report', true],
  ['14:06:48', 'quote_lookup', true],
  ['14:07:15', 'deep_report', false],
  ['14:07:52', 'deep_report', true],
  ['14:09:05', 'quote_lookup', true],
  ['14:09:33', 'deep_report', true],
  ['14:10:51', 'quote_lookup', true],
  ['14:11:20', 'deep_report', true],
  ['14:12:40', 'quote_lookup', true],
  ['14:13:06', 'deep_report', true],
  ['14:14:30', 'quote_lookup', true],
  ['14:14:58', 'deep_report', true],
  ['14:16:12', 'quote_lookup', true],
];
const HASHES = ['b1e0…4c2a', '58d3…a917', 'e07c…31f5', '2a9b…d860', '9c44…07e2', 'f6a1…5b3d', '03be…c98f', '7d25…e140', 'a8f0…6d1b', '4c6e…92a7', 'd19a…3f04', '61b7…a8c5', 'c3d8…17e6', '8e52…b0f9', '15fa…4d28', 'b94c…e7a0'];
const calls: ReceiptCall[] = plan.map(([time, tool, ok], i) => ({
  fragment: `r${i + 1}`,
  n: i + 1,
  time,
  tool,
  price: tool === 'quote_lookup' ? '0.05' : '0.40',
  ok,
  hash: HASHES[i]!,
}));

export const budgetCase: CaseFile = {
  kind: 'agent',
  merchant: { name: 'Alex Moreno', initials: 'AM' },
  summary: {
    id: 'PP-R-KDA-10192258',
    amount: '3.20',
    currency: 'USD',
    reason: 'INCORRECT_AMOUNT',
    reasonText: 'Buyer says they were charged more than the budget they approved',
    buyerItemType: 'Service',
    stage: 'CHARGEBACK',
    status: 'WAITING_FOR_SELLER_RESPONSE',
    statusReadAgo: 'read 1 min ago',
    respondBy: '10 Oct 2026',
    timeLeft: '1 d 20 h left',
    transactionId: '4KD02258MX7719034',
    captureText: 'Captured 6 Oct 2026 · 3.20 of 5.00 USD',
    openedAt: '2026-10-07T09:30:00Z',
  },
  evidence: [
    {
      id: 'E1',
      short: 'Mandate',
      title: 'Mandate · approved budget',
      body: {
        kind: 'mandate',
        headline: 'Buyer approved a budget of 5.00 USD for agent session',
        sessionId: SESSION,
        rows: [
          { fragment: 'm1', label: 'Session', value: SESSION },
          { fragment: 'm2', label: 'Approved', value: '6 Oct 2026 14:02 UTC by the buyer in PayPal' },
          { fragment: 'm3', label: 'PayPal order', value: '8XA10394RT2258117' },
          { fragment: 'm4', label: 'Authorization', value: '2GH66019372258404 · 5.00 USD hold' },
          { fragment: 'm5', label: 'Hard cap', value: '5.00 USD · checked before every call' },
        ],
      },
    },
    {
      id: 'E2',
      short: 'Receipt',
      title: 'Per-call receipt',
      caption: 'MeterMCP receipt · sha256 4e9a…c2d7',
      body: { kind: 'receipt', currency: 'USD', cap: '5.00', calls },
    },
    {
      id: 'E3',
      short: 'Settlement',
      title: 'Settlement',
      caption: 'PayPal',
      body: {
        kind: 'settlement',
        headline: 'Captured 3.20 of 5.00 USD · remainder released',
        captured: '3.20',
        released: '1.80',
        cap: '5.00',
        rows: [
          { fragment: 's1', label: 'Capture', value: '4KD02258MX7719034 · 6 Oct 2026 14:20 UTC' },
          { fragment: 's2', label: 'Captured', value: '3.20 USD (15 OK calls)' },
          { fragment: 's3', label: 'Released', value: '1.80 USD authorization remainder' },
        ],
      },
    },
    {
      id: 'E4',
      short: 'Receipt PDF',
      title: 'Session receipt PDF',
      caption: 'MeterMCP · 52 KB',
      body: {
        kind: 'lines',
        lines: [
          { text: `Session ${SESSION} · 16 calls · 15 charged`, fragment: 'p1' },
          { text: 'Total charged 3.20 USD of 5.00 USD budget', fragment: 'p2' },
          { text: 'Each call listed with time, tool, price, status and request hash', fragment: 'p3' },
        ],
      },
    },
    {
      id: 'E5',
      short: 'Authorization',
      title: 'PayPal authorization record',
      meta: { type: 'Authorization record', tag: 'PP', source: 'Simulated PayPal · demo data', received: '6 Oct 2026 · 14:20', hash: '7b31…e05c' },
      body: {
        kind: 'lines',
        lines: [
          { text: 'Authorization 2GH66019372258404 · 5.00 USD · created 6 Oct 2026 14:02 UTC', fragment: 'E5.auth' },
          { text: 'Captured 3.20 USD · 6 Oct 2026 14:20 UTC', fragment: 'E5.cap' },
          { text: 'Remaining 1.80 USD voided · 6 Oct 2026 14:20 UTC · not captured', fragment: 'E5.void' },
        ],
      },
    },
    {
      id: 'E6',
      short: 'Buyer msg',
      title: 'Buyer message',
      meta: { type: 'Dispute message', tag: 'MSG', source: 'PayPal dispute', received: '7 Oct 2026 · 09:30', hash: 'c6f2…18ab' },
      body: {
        kind: 'lines',
        lines: [
          { text: '"I set a 5.00 USD limit for my agent, but my statement shows 5.00 USD and then 3.20 USD. That is more than I approved."', fragment: 'E6.msg' },
          { text: 'From k•••@example.com · 7 Oct 2026 09:30 UTC', fragment: 'E6.date' },
        ],
      },
    },
  ],
  timeline: [],
  timelineCaption: '',
  // The first note confuses a released authorization with a refund (no refund in the case file): the analyst removes it.
  merchantNotes: ['We refunded the 1.80 USD difference to the buyer.', 'MeterMCP refuses any call that would take the total past the approved budget.'],
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
      requirement: 'Notes with the mandate, per-call receipt and settlement · found E1–E5',
      satisfied: true,
    },
    {
      type: 'PROOF_OF_REFUND',
      label: 'Proof of refund',
      requirement: 'Needs a refund ID. Nothing was refunded: the 1.80 USD remainder was released, never captured.',
      satisfied: false,
    },
  ],
  // Notes and documents: no carrier or tracking. The receipt PDF goes as the attachment.
  fulfillment: { carrier: '', carrierLabel: '', tracking: '' },
  attachments: [{ name: `session-receipt-${SESSION}.pdf`, size: '52 KB', fromEvidenceId: 'E4' }],
  recommendation: null,
  allowedActions: ['provide_evidence', 'accept_claim'],
  actionDetails: {
    provide_evidence: { label: 'Provide evidence', sub: 'Mandate, receipt, settlement' },
    accept_claim: { label: 'Accept claim', sub: 'Refund 3.20 USD' },
  },
  refundText: '3.20 USD',
  audit: [],
};
