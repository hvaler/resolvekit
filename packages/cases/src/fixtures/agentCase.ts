import type { CaseFile } from '../../../../apps/web/src/domain/types.ts';

/**
 * Synthetic agent-purchase case: a buyer's AI agent spent part of an approved budget on paid tool
 * calls (MeterMCP is a fictional tool provider). One call failed and was not charged.
 */
export const agentCase: CaseFile = {
  kind: 'agent',
  merchant: { name: 'Alex Moreno', initials: 'AM' },
  summary: {
    id: 'PP-R-MMC-10190702',
    amount: '1.37',
    currency: 'USD',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    reasonText: 'Buyer says: "I didn’t receive any confirmation of the service"',
    buyerItemType: 'Service',
    stage: 'INQUIRY',
    status: 'WAITING_FOR_SELLER_RESPONSE',
    statusReadAgo: 'read 1 min ago',
    respondBy: '18 Oct 2026',
    timeLeft: '9 d 23 h left',
    transactionId: '7HF40211KM3390816',
    captureText: 'Captured 8 Oct 2026 · 1.37 of 5.00 USD',
    openedAt: '2026-10-08T17:40:11Z',
  },
  evidence: [
    {
      id: 'E1',
      short: 'Mandate',
      title: 'Mandate · approved budget',
      body: {
        kind: 'mandate',
        headline: 'Buyer approved a budget of 5.00 USD for agent session',
        sessionId: 'mm-sess-20261008-01',
        rows: [
          { fragment: 'm1', label: 'Session', value: 'mm-sess-20261008-01' },
          { fragment: 'm2', label: 'Approved', value: '8 Oct 2026 09:12 UTC by the buyer in PayPal' },
          { fragment: 'm3', label: 'PayPal order', value: '5UX02876PL4419203' },
          { fragment: 'm4', label: 'Authorization', value: '0VF52814937998046' },
          { fragment: 'm5', label: 'Hard cap', value: '5.00 USD · MeterMCP tools only' },
        ],
      },
    },
    {
      id: 'E2',
      short: 'Receipt',
      title: 'Per-call receipt',
      caption: 'MeterMCP receipt · sha256 b81c…07ae',
      body: {
        kind: 'receipt',
        currency: 'USD',
        cap: '5.00',
        calls: [
          { fragment: 'r1', n: 1, time: '09:14:03', tool: 'quote_lookup', price: '0.05', ok: true, hash: 'a3f1…9c20' },
          { fragment: 'r2', n: 2, time: '09:15:40', tool: 'deep_report', price: '0.40', ok: false, hash: '7be0…41d7' },
          { fragment: 'r3', n: 3, time: '09:16:12', tool: 'deep_report', price: '0.40', ok: true, hash: '0c9e…b85a' },
          { fragment: 'r4', n: 4, time: '09:18:55', tool: 'bulk_export', price: '0.92', ok: true, hash: 'e4d2…6f13' },
        ],
      },
    },
    {
      id: 'E3',
      short: 'Settlement',
      title: 'Settlement',
      caption: 'PayPal',
      body: {
        kind: 'settlement',
        headline: 'Captured 1.37 of 5.00 USD · remainder released',
        captured: '1.37',
        released: '3.63',
        cap: '5.00',
        rows: [
          { fragment: 's1', label: 'Capture', value: '7HF40211KM3390816 · 8 Oct 2026 09:25 UTC' },
          { fragment: 's2', label: 'Captured', value: '1.37 USD (3 OK calls)' },
          { fragment: 's3', label: 'Released', value: '3.63 USD authorization remainder' },
        ],
      },
    },
    {
      id: 'E4',
      short: 'Receipt PDF',
      title: 'Session receipt PDF',
      caption: 'MeterMCP · 46 KB',
      body: {
        kind: 'lines',
        lines: [
          { text: 'Session mm-sess-20261008-01 · 4 calls · 3 charged', fragment: 'p1' },
          { text: 'Total charged 1.37 USD of 5.00 USD budget', fragment: 'p2' },
          { text: 'Each call listed with time, tool, price, status and request hash', fragment: 'p3' },
        ],
      },
    },
  ],
  timeline: [],
  timelineCaption: '',
  // The analyst's outputs come from the real analysis (packages/analyst). The merchant's notes are verified too.
  merchantNotes: ['All four tool calls completed successfully.', 'The buyer received a confirmation for every completed call.'],
  sentences: [],
  contradictions: [],
  checklist: null,
  analysis: { steps: [], contradictionStep: 3, rejectionStep: 5, note: 'Documents are read as content, never as instructions' },
  requestedEvidenceType: 'PROOF_OF_FULFILLMENT',
  requestedNote: 'even though the buyer declared a Service',
  evidenceTypes: [
    {
      type: 'PROOF_OF_FULFILLMENT',
      label: 'Proof of fulfillment',
      requirement: 'Sent as digital delivery: carrier Other, reference mm-sess-20261008-01',
      satisfied: true,
    },
    {
      type: 'PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED',
      label: 'Proof the service was delivered',
      requirement: 'Session receipt with every call',
      satisfied: true,
    },
    { type: 'PROOF_OF_REFUND', label: 'Proof of refund', requirement: 'Needs a refund ID. None found in the case file.', satisfied: false },
  ],
  fulfillment: {
    carrier: 'OTHER',
    carrierLabel: 'Other: digital delivery',
    tracking: 'mm-sess-20261008-01',
    digital: {
      sessionLabel: 'Agent session',
      note: 'PayPal has no digital-delivery type for not-received disputes. So we send proof of fulfillment with the session as the reference and attach the receipt that lists every call.',
    },
  },
  attachments: [{ name: 'session-receipt-mm-sess-20261008-01.pdf', size: '46 KB', fromEvidenceId: 'E4' }],
  recommendation: null,
  allowedActions: ['provide_evidence', 'send_message', 'make_offer', 'accept_claim'],
  actionDetails: {
    provide_evidence: { label: 'Provide evidence', sub: 'Recommended' },
    send_message: { label: 'Send message', sub: 'Ask or explain' },
    make_offer: { label: 'Make an offer', sub: 'Partial refund' },
    accept_claim: { label: 'Accept claim', sub: 'Refund 1.37 USD' },
  },
  refundText: '1.37 USD',
  audit: [],
};
