/**
 * The last checks before an evidence send (validate.ts), against the dispute as PayPal shows it. No network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestedEvidence } from '@resolvekit/paypal';
import type { EvidenceSubmission } from '../../web/src/domain/types.ts';
import { NOTES_LIMIT, checkAgainstDispute } from '../src/validate.ts';
import { standardDispute } from './kit.ts';

test('notes over the 2,000-character cap are refused, and the cap is named as ResolveKit’s own (not PayPal’s)', () => {
  const d = standardDispute();
  const s: EvidenceSubmission = { disputeId: 'PP-D-1', action: 'provide_evidence', evidenceType: requestedEvidence(d)[0] ?? 'OTHER', carrier: 'UPS', tracking: '1Z999', notes: 'a'.repeat(NOTES_LIMIT + 1), files: [] } as EvidenceSubmission;
  const p = checkAgainstDispute(s, d);
  assert.equal(p?.error, 'NOTES_TOO_LONG');
  assert.equal(p?.detail, `Notes are ${NOTES_LIMIT + 1} characters; ResolveKit sends at most ${NOTES_LIMIT}`);
  assert.ok(!p!.detail.includes('PayPal'));
  assert.equal(checkAgainstDispute({ ...s, notes: 'a'.repeat(NOTES_LIMIT) }, d), null);
});

test('PayPal requests only PROOF_OF_REFUND (not available in this delivery): 409 VARIANT_NOT_AVAILABLE with the registry reason, never «Send PROOF_OF_REFUND»', () => {
  const ev = (types: string[]) => types.map((t) => ({ evidence_type: t, source: 'REQUESTED_FROM_SELLER', date: '2026-10-08T10:00:00.000Z' }));
  const only = standardDispute({ evidences: ev(['PROOF_OF_REFUND']) as never });
  const s: EvidenceSubmission = { disputeId: 'PP-D-1', action: 'provide_evidence', evidenceType: 'PROOF_OF_FULFILLMENT', carrier: 'UPS', tracking: '1Z999', notes: 'Delivered.', files: [] };
  const p = checkAgainstDispute(s, only);
  assert.deepEqual(p, {
    status: 409,
    error: 'VARIANT_NOT_AVAILABLE',
    detail: 'PayPal asks only for Proof of refund, which is not available in this delivery: Not verified with PayPal: pending sandbox test (W-11)',
  });
  assert.ok(!p!.detail.includes('Send PROOF_OF_REFUND'));
  // PROOF_OF_REFUND among other requested types: the others go as before; an unrequested type is still refused.
  const several = standardDispute({ evidences: ev(['PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND', 'OTHER']) as never });
  assert.equal(checkAgainstDispute(s, several), null);
  const other = standardDispute({ evidences: ev(['OTHER', 'PROOF_OF_REFUND']) as never });
  assert.equal(checkAgainstDispute(s, other)?.error, 'EVIDENCE_TYPE_NOT_REQUESTED');
  // [PROOF_OF_REFUND, OTHER]: OTHER, the type the web preselects there, is accepted.
  const refundOther = standardDispute({ evidences: ev(['PROOF_OF_REFUND', 'OTHER']) as never });
  assert.equal(checkAgainstDispute({ ...s, evidenceType: 'OTHER', carrier: '', tracking: '' }, refundOther), null);
});
