import type { CaseFile } from '../domain/types';

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
  evidenceSources: '4 documents',
  timeline: [
    { kind: 'event', time: '09:12:30', title: 'Budget approved', sub: '5.00 USD cap · in PayPal', tag: 'PP', evidenceId: 'E1' },
    { kind: 'event', time: '09:14:03', title: 'quote_lookup', sub: '0.05 USD · OK', tag: 'MCP', evidenceId: 'E2', fragment: 'r1' },
    { kind: 'event', time: '09:15:40', title: 'deep_report', sub: '0.40 USD · failed, not charged', tag: 'MCP', evidenceId: 'E2', fragment: 'r2', struck: true },
    { kind: 'event', time: '09:16:12', title: 'deep_report', sub: '0.40 USD · OK', tag: 'MCP', evidenceId: 'E2', fragment: 'r3' },
    { kind: 'event', time: '09:18:55', title: 'bulk_export', sub: '0.92 USD · OK', tag: 'MCP', evidenceId: 'E2', fragment: 'r4' },
    { kind: 'event', time: '09:25:00', title: 'Settled', sub: 'Captured 1.37 · 3.63 released', tag: 'PP', evidenceId: 'E3' },
    { kind: 'event', time: '09:25:02', title: 'Session receipt issued', sub: 'PDF · 46 KB', tag: 'MCP', evidenceId: 'E4' },
    { kind: 'event', time: '17:40:11', title: 'Dispute opened', sub: '"I didn’t receive any confirmation of the service"', tag: 'PP', evidenceId: null },
  ],
  timelineCaption: '8 Oct 2026 · UTC',
  sentences: [
    {
      id: 'G1',
      verdict: 'supported',
      text: 'On 8 October 2026 the buyer approved a budget of up to 5.00 USD for agent session mm-sess-20261008-01.',
      citations: [{ evidenceId: 'E1', fragments: ['m1', 'm2', 'm5'] }],
    },
    {
      id: 'G2',
      verdict: 'supported',
      text: 'During the session the buyer’s agent made four tool calls. Three completed and one failed.',
      citations: [{ evidenceId: 'E2', fragments: ['r1', 'r2', 'r3', 'r4'] }],
    },
    {
      id: 'G3',
      verdict: 'supported',
      text: 'We charged only the three completed calls: 0.05 + 0.40 + 0.92 = 1.37 USD.',
      citations: [
        { evidenceId: 'E2', fragments: ['r1', 'r3', 'r4'] },
        { evidenceId: 'E3', fragments: ['s2'] },
      ],
    },
    {
      id: 'G4',
      verdict: 'supported',
      text: 'The failed deep_report call at 09:15:40 UTC was not charged.',
      citations: [{ evidenceId: 'E2', fragments: ['r2'] }],
    },
    {
      id: 'G5',
      verdict: 'supported',
      text: 'The remaining 3.63 USD of the approved budget was released.',
      citations: [{ evidenceId: 'E3', fragments: ['s3'] }],
    },
    {
      id: 'G6',
      verdict: 'needs_review',
      text: 'The buyer received a confirmation for every completed call.',
      citations: [{ evidenceId: 'E2', fragments: ['r1', 'r3', 'r4'] }],
      reason: 'Why: the receipt shows status OK and a response hash for each call. It does not show what the buyer saw.',
      recheck: { supportedIf: 'request hash', supportedNote: 'Rephrased · re-checked against E2: supported' },
      suggestion: {
        label: 'Rephrase to what the receipt shows',
        text: 'Each completed call returned a response to the buyer’s agent, recorded with its request hash in the session receipt.',
      },
    },
    {
      id: 'G7',
      verdict: 'rejected',
      text: 'All four tool calls completed successfully.',
      citations: [],
      reason: 'Removed: contradicted by E2. Call 2 (deep_report, 09:15:40) FAILED and was not charged.',
    },
    {
      id: 'G8',
      verdict: 'supported',
      text: 'The session receipt, listing every call with its price, status and request hash, is attached.',
      citations: [{ evidenceId: 'E4', fragments: [] }],
    },
  ],
  contradictions: [],
  checklist: null,
  analysis: {
    steps: ['Read 4 documents', 'Built timeline · 8 events', 'Matched charges to calls · 1.37 = 0.05 + 0.40 + 0.92', 'Drafted 8 sentences', 'Removed 1 contradicted'],
    contradictionStep: 2,
    rejectionStep: 4,
    note: 'Receipts are verified by request hash',
  },
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
  audit: [
    { time: '17:46', who: 'Analyst', what: 'Read 4 documents, matched 3 charges to calls, drafted 8 sentences' },
    { time: '17:46', who: 'Analyst', what: 'Removed "All four tool calls completed successfully." Contradicted by E2' },
  ],
};
