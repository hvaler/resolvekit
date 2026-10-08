import { describe, expect, it } from 'vitest';
import { agentCase, standardCase } from '../fixtures';
import { quoteFor } from './quotes';
import { chargedTotal, receiptTotal } from './receipt';
import { buildSubmission, totalSize } from './submission';
import { deriveSentences } from './draft';

describe('agent receipt', () => {
  it('charges only completed calls: 0.05 + 0.40 + 0.92 = 1.37', () => {
    const e2 = agentCase.evidence.find((e) => e.id === 'E2')!;
    if (e2.body.kind !== 'receipt') throw new Error('E2 is not a receipt');
    expect(chargedTotal(e2.body.calls)).toEqual({ total: '1.37', parts: ['0.05', '0.40', '0.92'] });
    expect(chargedTotal(e2.body.calls).total).toBe(agentCase.summary.amount);
  });

  it('pins a total row of OK calls against the approved budget: 1.37 of 5.00 USD', () => {
    const e2 = agentCase.evidence.find((e) => e.id === 'E2')!;
    if (e2.body.kind !== 'receipt') throw new Error('E2 is not a receipt');
    expect(receiptTotal(e2.body.calls, e2.body.currency, e2.body.cap)).toEqual({ label: 'Total · 3 OK calls', total: '1.37', ofCap: 'of 5.00 USD approved' });
    expect(receiptTotal(e2.body.calls.slice(0, 1), 'USD').ofCap).toBe('USD');
  });
});

describe('quotes and submission', () => {
  it('quotes the cited fragments verbatim from the source', () => {
    expect(quoteFor(standardCase.evidence, { evidenceId: 'E3', fragments: ['E3.addr'] })).toBe('Delivered to: 12 Example Street, Apt 4B');
    expect(quoteFor(standardCase.evidence, { evidenceId: 'E4', fragments: [] })).toBe('Shipping label (attached)');
    expect(quoteFor(agentCase.evidence, { evidenceId: 'E2', fragments: ['r2'] })).toBe('#2 09:15:40 deep_report 0.40 FAILED · not charged');
  });

  it('maps the agent session to digital delivery: carrier OTHER, session as reference, receipt PDF attached', () => {
    const views = deriveSentences(agentCase.sentences, { edits: {}, checking: null, analysisStep: 99, rejectionStep: 4 });
    const s = buildSubmission(agentCase, views, 'PROOF_OF_FULFILLMENT');
    expect(s).toMatchObject({ carrier: 'OTHER', tracking: 'mm-sess-20261008-01', evidenceType: 'PROOF_OF_FULFILLMENT' });
    expect(s.files.map((f) => f.name)).toEqual(['session-receipt-mm-sess-20261008-01.pdf']);
    expect(s.notes).not.toContain('All four tool calls completed successfully');
    expect(totalSize(standardCase.attachments)).toBe('196 KB');
  });

  it('uses only clearly fictional addresses in the fixtures', () => {
    const text = JSON.stringify(standardCase);
    expect(text).not.toMatch(/Harbour|Portsmouth|PO1/);
    expect(text).toContain('12 Example Street, Apt 4,');
    expect(text).toContain('12 Example Street, Apt 4B');
  });
});
