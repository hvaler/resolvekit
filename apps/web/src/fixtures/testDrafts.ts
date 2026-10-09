/**
 * Hand-written draft data for unit tests of the draft rules (blockers, counts, checklist states, notes). Never
 * shown in the app: the case files' analysis comes from the real analyst (packages/analyst).
 */
import type { ChecklistItem, Contradiction, DraftSentence } from '../domain/types';

export const standardTestSentences: DraftSentence[] = [
    {
      id: 'S1',
      text: 'Order #10482 was placed on 6 October 2026 and paid in full (7.00 USD).',
      verdict: 'supported',
      citations: [
        { evidenceId: 'E1', fragments: ['E1.date', 'E1.amt'] },
        { evidenceId: 'E2', fragments: ['E2.amt'] },
      ],
    },
    {
      id: 'S2',
      text: 'We shipped it on 7 October 2026 with UPS, tracking number 1Z999AA10123456784.',
      verdict: 'supported',
      citations: [
        { evidenceId: 'E3', fragments: ['E3.ship', 'E3.trk'] },
        { evidenceId: 'E4', fragments: ['E4.trk'] },
      ],
    },
    {
      id: 'S3',
      text: 'UPS recorded delivery on 8 October 2026 at 11:52 UTC, signed for by "J. D."',
      verdict: 'supported',
      citations: [{ evidenceId: 'E3', fragments: ['E3.deliv'] }],
    },
    {
      id: 'S4',
      text: 'The package was delivered to the address the buyer gave at checkout.',
      verdict: 'needs_review',
      citations: [
        { evidenceId: 'E1', fragments: ['E1.addr'] },
        { evidenceId: 'E3', fragments: ['E3.addr'] },
      ],
      reason: 'Why: the addresses differ. The order says "Apt 4" and the delivery says "Apt 4B".',
    },
    {
      id: 'S5',
      text: 'The customer confirmed receipt by phone.',
      verdict: 'rejected',
      citations: [],
      reason: 'Removed: no call log, note or message in the case file records this call. It will not be sent.',
    },
    {
      id: 'S6',
      text: 'The buyer’s message saying the package never arrived was sent about six hours after the recorded delivery.',
      verdict: 'supported',
      citations: [
        { evidenceId: 'E5', fragments: ['E5.msg', 'E5.date'] },
        { evidenceId: 'E3', fragments: ['E3.deliv'] },
      ],
    },
    {
      id: 'S7',
      text: 'The carrier tracking record and the shipping label are attached.',
      verdict: 'supported',
      citations: [
        { evidenceId: 'E3', fragments: [] },
        { evidenceId: 'E4', fragments: [] },
      ],
    },
  ];

export const standardTestContradictions: Contradiction[] = [
    {
      id: 'C1',
      title: 'Delivery address differs from order address',
      a: { evidenceId: 'E1', fragment: 'E1.addr', label: 'E1 · Order', value: 'Apt 4' },
      b: { evidenceId: 'E3', fragment: 'E3.addr', label: 'E3 · UPS delivered', value: 'Apt 4B' },
      assessment: 'Street, number and postcode match. Probably the same unit written two ways. Your call, not a fraud signal.',
      explainSentenceId: 'S4',
      explainText: 'UPS delivered to 12 Example Street, Apt 4B. The order lists Apt 4. The street, number and postcode match.',
      blockerName: 'the address contradiction',
    },
  ];

export const standardTestChecklist: ChecklistItem[] = [
      { label: 'Tracking number with delivery confirmation', refs: 'E3', present: true },
      { label: 'Carrier and ship date', refs: 'E3 · E4', present: true },
      { label: 'Delivery address matches the order', refs: 'E1 ↔ E3', contradictionId: 'C1', present: true },
      { label: 'Signature or proof of receipt', refs: 'E3', present: true },
      { label: 'Payment record for the disputed amount', refs: 'E2', present: true },
    ];

export const agentTestSentences: DraftSentence[] = [
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
  ];
