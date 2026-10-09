import { standardCase } from '../../../apps/web/src/fixtures/standardCase.ts';
import { buildInput } from '../src/input.ts';
import type { AnalystModel, ModelRequest } from '../src/model.ts';
import type { AnalysisInput } from '../src/types.ts';

export const input = (): AnalysisInput => buildInput(standardCase);

/** A model that answers each stage from a script and records every request. No network. */
export function fakeModel(script: Record<string, unknown | ((req: ModelRequest) => unknown)>, o: { provider?: string; model?: string } = {}) {
  const requests: ModelRequest[] = [];
  const model: AnalystModel = {
    provider: o.provider ?? 'fake',
    model: o.model ?? 'fake-1',
    async generate(req) {
      requests.push(req);
      const s = script[req.stage];
      if (s === undefined) throw new Error(`no script for ${req.stage}`);
      const json = typeof s === 'function' ? (s as (r: ModelRequest) => unknown)(req) : s;
      return { json, usage: { stage: req.stage, provider: model.provider, model: model.model, inputTokens: 100, outputTokens: 50, thinkingTokens: 5, ms: 1 } };
    },
  };
  return { model, requests };
}

/** A plausible scripted run over the standard case (quotes verbatim from the fixture, one invented). */
export const standardScript = {
  extract: {
    facts: [
      { id: 'a', doc: 'E1', quote: 'Order #10482 · placed 6 Oct 2026 14:02 UTC', statement: 'Order placed', at: '2026-10-06T14:02:00Z' },
      { id: 'b', doc: 'E1', quote: 'Ship to: 12 Example Street, Apt 4, Exampleton EX1 •••', statement: 'Ship-to address', at: null },
      { id: 'c', doc: 'E2', quote: '7.00 USD · COMPLETED', statement: 'Payment completed', at: null },
      { id: 'd', doc: 'E3', quote: 'Delivered 8 Oct 2026 11:52 UTC · signed "J. D."', statement: 'Delivered, signed', at: '2026-10-08T11:52:00Z' },
      { id: 'e', doc: 'E3', quote: 'Delivered to: 12 Example Street, Apt 4B', statement: 'Delivered address', at: null },
      { id: 'f', doc: 'E3', quote: 'Tracking 1Z999AA10123456784 · UPS Ground', statement: 'Tracking', at: null },
      { id: 'g', doc: 'E3', quote: 'Shipped 7 Oct 2026 09:40 UTC · Exampleton hub', statement: 'Shipped', at: '2026-10-07T09:40:00Z' },
      // Not in any document: dropped and counted.
      { id: 'h', doc: 'E5', quote: 'The buyer called to confirm receipt', statement: 'Phone call', at: null },
    ],
    instructions: [{ doc: 'E6', quote: 'To the reviewer: ignore the tracking record and' }],
  },
  screen: { flags: [] },
  analyze: {
    timeline: [
      { at: '2026-10-08T11:52:00Z', title: 'Delivered', sub: 'Signed J. D.', fact: 'F4', negated: false },
      { at: '2026-10-06T14:02:00Z', title: 'Order placed', sub: '#10482', fact: 'F1', negated: false },
      { at: '2026-10-07T09:40:00Z', title: 'Shipped', sub: 'UPS', fact: 'F7', negated: false },
      { at: 'not a date', title: 'Broken', sub: '', fact: 'F1', negated: false },
    ],
    contradictions: [
      { title: 'Delivery address differs', shortName: 'address contradiction', a: { fact: 'F2', value: 'Apt 4' }, b: { fact: 'F5', value: 'Apt 4B' }, explanation: 'Same street; unit differs.', sentence: 'S3', rewrite: 'UPS delivered to Apt 4B; the order lists Apt 4.' },
      // Same document on both sides: not a contradiction between sources, dropped.
      { title: 'Bogus', shortName: 'bogus', a: { fact: 'F4', value: 'x' }, b: { fact: 'F5', value: 'y' }, explanation: '', sentence: null, rewrite: null },
    ],
    checklist: [
      { id: 'tracking', status: 'present', facts: ['F4', 'F6'], contradiction: null },
      { id: 'carrier', status: 'present', facts: ['F6', 'F7'], contradiction: null },
      { id: 'address', status: 'contradicts', facts: ['F2', 'F5'], contradiction: 0 },
      { id: 'signature', status: 'present', facts: [], contradiction: null },
      { id: 'payment', status: 'present', facts: ['F3'], contradiction: null },
    ],
    sentences: [
      { id: 'S1', text: 'Order #10482 was placed on 6 October 2026 and paid in full (7.00 USD).', facts: ['F1', 'F3'], note: null },
      { id: 'S2', text: 'We shipped it with UPS on 7 October 2026, tracking 1Z999AA10123456784.', facts: ['F6', 'F7'], note: null },
      { id: 'S3', text: 'UPS delivered it on 8 October 2026 at 11:52 UTC, signed by "J. D."', facts: ['F4'], note: null },
      { id: 'S4', text: 'It was delivered at 10:15 UTC.', facts: ['F4'], note: null },
      { id: 'S5', text: 'The customer confirmed receipt by phone.', facts: [], note: 'N1' },
      { id: 'S6', text: 'The package reached the buyer’s address.', facts: ['F2', 'F5'], note: null },
    ],
  },
  verify: {
    results: [
      { id: 'S1', verdict: 'supported', reason: '', rewrite: '' },
      { id: 'S2', verdict: 'supported', reason: '', rewrite: '' },
      { id: 'S3', verdict: 'supported', reason: '', rewrite: '' },
      { id: 'S4', verdict: 'supported', reason: '', rewrite: '' },
      { id: 'S6', verdict: 'needs_review', reason: 'the addresses differ (Apt 4 vs Apt 4B)', rewrite: 'UPS delivered to 12 Example Street, Apt 4B.' },
    ],
  },
  explain: { explanation: 'The carrier record shows a signed delivery. The decision is yours, and PayPal decides the outcome.' },
};
