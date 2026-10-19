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
