import { describe, expect, it } from 'vitest';
import { compareSentRecorded } from './compare';
import type { EvidenceSubmission, RecordedEvidence } from './types';

const sent: EvidenceSubmission = {
  disputeId: 'PP-R-TVH-10190665',
  action: 'provide_evidence',
  evidenceType: 'PROOF_OF_FULFILLMENT',
  carrier: 'UPS',
  tracking: '1Z999AA10123456784',
  notes: 'Order #10482 was placed.',
  files: [
    { name: 'a.pdf', size: '112 KB' },
    { name: 'b.pdf', size: '84 KB' },
  ],
};
const recorded: RecordedEvidence = {
  evidenceType: 'PROOF_OF_FULFILLMENT',
  carrier: 'UPS',
  tracking: '1Z999AA10123456784',
  notes: 'Order #10482 was placed.',
  files: ['b.pdf', 'a.pdf'],
  storedAt: '8 Oct 2026 19:04:02 UTC',
};

describe('compareSentRecorded', () => {
  it('matches all six fields when PayPal stored exactly what was sent', () => {
    const c = compareSentRecorded(sent, recorded, '8 Oct 2026 19:03:58 UTC');
    expect(c.rows.map((r) => r.field)).toEqual(['Evidence type', 'Carrier', 'Tracking number', 'Files', 'Notes', 'Submitted']);
    expect(c.matched).toBe(6);
    expect(c.allMatch).toBe(true);
    expect(c.rows[5]!.recorded).toBe('Stored 8 Oct 2026 19:04:02 UTC');
  });

  it('compares notes by content, not only by length', () => {
    const c = compareSentRecorded(sent, { ...recorded, notes: 'Order #10482 was placed!' }, '');
    expect(c.rows.find((r) => r.field === 'Notes')!.match).toBe(false);
    expect(c.allMatch).toBe(false);
  });

  it('flags missing files and a different tracking number', () => {
    const c = compareSentRecorded(sent, { ...recorded, files: ['a.pdf'], tracking: 'X' }, '');
    expect(c.rows.filter((r) => !r.match).map((r) => r.field)).toEqual(['Tracking number', 'Files']);
  });

  it('reports nothing as matching when PayPal recorded nothing', () => {
    const c = compareSentRecorded(sent, null, '');
    expect(c.matched).toBe(0);
    expect(c.rows.every((r) => r.recorded === 'Not recorded')).toBe(true);
  });
});
