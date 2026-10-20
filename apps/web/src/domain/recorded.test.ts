import { describe, expect, it } from 'vitest';
import { safeRetry, submitWithReadBack, type DisputeGateway } from './gateway';
import { resolvedCase, standardCase } from '@resolvekit/cases';
import { hasSellerEvidence, newSellerEvidence, startsFurtherOn } from './recorded';
import type { DisputeSnapshot, EvidenceSubmission, RecordedEvidence } from './types';

// Evidence entries shaped like a real sandbox dispute read (2026-10-08): the buyer's own entry and PayPal's request
// are always there, and neither is the merchant's evidence.
const buyerCreate: RecordedEvidence = {
  evidenceType: 'CREATE',
  source: 'SUBMITTED_BY_BUYER',
  date: '2026-10-08T10:12:31.000Z',
  carrier: '',
  tracking: '',
  notes: 'I never received the item.',
  files: [],
  storedAt: '8 Oct 2026 10:12:31 UTC',
};
const requested: RecordedEvidence = {
  evidenceType: 'PROOF_OF_FULFILLMENT',
  source: 'REQUESTED_FROM_SELLER',
  carrier: '',
  tracking: '',
  notes: '',
  files: [],
  storedAt: '',
};
const sellerEntry = (date: string, tracking = '1Z999AA10123456784'): RecordedEvidence => ({
  evidenceType: 'PROOF_OF_FULFILLMENT',
  source: 'SUBMITTED_BY_SELLER',
  action: 'PROVIDE_EVIDENCE',
  date,
  carrier: 'UPS',
  tracking,
  notes: 'Delivered.',
  files: ['proof.pdf'],
  storedAt: date,
});

const snap = (evidences: RecordedEvidence[], status: DisputeSnapshot['status'] = 'WAITING_FOR_SELLER_RESPONSE'): DisputeSnapshot => ({
  id: 'PP-R-X',
  status,
  allowedActions: status === 'WAITING_FOR_SELLER_RESPONSE' ? ['provide_evidence', 'send_message'] : ['send_message'],
  evidences,
  readAt: '',
});

const submission: EvidenceSubmission = {
  disputeId: 'PP-R-X',
  action: 'provide_evidence',
  evidenceType: 'PROOF_OF_FULFILLMENT',
  carrier: 'UPS',
  tracking: '1Z999AA10123456784',
  notes: 'Delivered.',
  files: [{ name: 'proof.pdf', size: '1 KB' }],
};

/** A gateway that answers reads from a script and records sends, like the server-backed one would. */
function scripted(reads: DisputeSnapshot[], send: () => Promise<void> = async () => {}): DisputeGateway & { sends: number } {
  let i = 0;
  const g = {
    sends: 0,
    async getDispute() {
      const s = reads[Math.min(i, reads.length - 1)];
      i += 1;
      return structuredClone(s!);
    },
    async provideEvidence() {
      g.sends += 1;
      await send();
    },
    async sendAction() {
      return { sent: true as const };
    },
  };
  return g;
}

describe('which evidence is the merchant’s', () => {
  it('buyer CREATE and REQUESTED_FROM_SELLER entries are not seller evidence', () => {
    expect(hasSellerEvidence(snap([buyerCreate, requested]))).toBe(false);
    expect(newSellerEvidence(snap([buyerCreate, requested]), snap([]))).toBeNull();
  });

  it('seller evidence with another action_info.action is not a provide-evidence submission', () => {
    const other = { ...sellerEntry('2026-10-09T08:00:00Z'), action: 'ACKNOWLEDGE_RETURN_ITEM' };
    expect(hasSellerEvidence(snap([buyerCreate, other]))).toBe(false);
  });

  it('seller evidence already there before sending is not new', () => {
    const old = sellerEntry('2026-10-08T12:00:00Z');
    expect(newSellerEvidence(snap([buyerCreate, old]), snap([buyerCreate, old]))).toBeNull();
    const fresh = sellerEntry('2026-10-09T08:00:00Z', '1ZNEW');
    expect(newSellerEvidence(snap([buyerCreate, old, fresh]), snap([buyerCreate, old]))?.tracking).toBe('1ZNEW');
  });
});

describe('read-back against a real-shaped dispute', () => {
  const before = snap([buyerCreate, requested]);

  it('PayPal accepted the send but shows no seller evidence: not recorded (rereads first)', async () => {
    const g = scripted([before]);
    const r = await submitWithReadBack(g, submission, { requestId: 'rk-1', rereads: 2 });
    expect(r.kind).toBe('not_recorded');
    expect(g.sends).toBe(1);
  });

  it('the seller entry shows up on a later read: recorded, with what PayPal stored', async () => {
    const after = snap([buyerCreate, sellerEntry('2026-10-09T08:00:00Z')], 'UNDER_REVIEW');
    const g = scripted([before, before, after]);
    const r = await submitWithReadBack(g, submission, { requestId: 'rk-1', rereads: 3 });
    expect(r.kind).toBe('recorded');
    if (r.kind !== 'recorded') return;
    expect(r.recorded).toMatchObject({ source: 'SUBMITTED_BY_SELLER', tracking: '1Z999AA10123456784', files: ['proof.pdf'] });
    expect(r.snapshot.status).toBe('UNDER_REVIEW');
  });

  it('a failed send with only buyer entries is not recorded and is not re-read in a loop', async () => {
    const g = scripted([before], async () => {
      throw new Error('PayPal 422 UNPROCESSABLE_ENTITY [EVIDENCE_TYPE_IS_NOT_ALLOWED]');
    });
    const r = await submitWithReadBack(g, submission, { requestId: 'rk-1', rereads: 5 });
    expect(r).toMatchObject({ kind: 'not_recorded', error: expect.stringContaining('EVIDENCE_TYPE_IS_NOT_ALLOWED') });
  });

  it('safe retry: old seller evidence does not count, so it sends; new evidence does, so it does not', async () => {
    const old = sellerEntry('2026-10-08T12:00:00Z');
    const base = snap([buyerCreate, old]);
    const g1 = scripted([base]);
    const r1 = await safeRetry(g1, submission, { requestId: 'rk-1', baseline: base });
    expect(g1.sends).toBe(1);
    expect(r1.kind).toBe('not_recorded');

    const g2 = scripted([snap([buyerCreate, old, sellerEntry('2026-10-09T08:00:00Z')], 'UNDER_REVIEW')]);
    const r2 = await safeRetry(g2, submission, { requestId: 'rk-1', baseline: base });
    expect(g2.sends).toBe(0);
    expect(r2).toMatchObject({ kind: 'recorded', resent: false, recorded: { date: '2026-10-09T08:00:00Z' } });

    // M1: new seller evidence with another tracking is someone else's: not "recorded", and still nothing is sent.
    const g3 = scripted([snap([buyerCreate, old, sellerEntry('2026-10-09T08:00:00Z', '1ZNEW')], 'UNDER_REVIEW')]);
    const r3 = await safeRetry(g3, submission, { requestId: 'rk-1', baseline: base });
    expect(g3.sends).toBe(0);
    expect(r3).toMatchObject({ kind: 'mismatch', differs: ['tracking'], recorded: { tracking: '1ZNEW' } });
  });
});

describe('PayPal events after the documents', () => {
  it('the seller’s evidence and the outcome, in the timeline’s format, labelled by who recorded them', async () => {
    const { payPalEvents } = await import('./recorded');
    const s = {
      id: 'X',
      status: 'RESOLVED' as const,
      allowedActions: [],
      readAt: '',
      outcome: { code: 'RESOLVED_SELLER_FAVOUR', closedAt: '2026-10-02T16:00:00Z' },
      evidences: [
        { evidenceType: 'CREATE', source: 'SUBMITTED_BY_BUYER', date: '2026-09-25T09:00:00Z', carrier: '', tracking: '', notes: '', files: [], storedAt: '' },
        { evidenceType: 'PROOF_OF_FULFILLMENT', source: 'SUBMITTED_BY_SELLER', action: 'PROVIDE_EVIDENCE', date: '2026-09-26T11:05:00Z', carrier: 'USPS', tracking: '9', notes: 'n', files: [], storedAt: '' },
      ],
    };
    expect(payPalEvents(s, 'the simulator').map((e) => (e.kind === 'event' ? [e.time, e.title, e.sub] : null))).toEqual([
      ['26 Sep 11:05', 'Evidence sent', 'PROOF_OF_FULFILLMENT · recorded by the simulator'],
      ['2 Oct 16:00', 'Dispute closed', 'RESOLVED_SELLER_FAVOUR · the simulator'],
    ]);
  });
});

describe('the timeline after a send (Task 8 review)', () => {
  it('a thread alone does not make a case start further on: the standard case’s timeline stays the analysis’s', () => {
    expect(standardCase.simulatedPayPal?.messages?.length).toBe(1);
    expect(startsFurtherOn(standardCase)).toBe(false);
    expect(startsFurtherOn(resolvedCase)).toBe(true);
  });
});
