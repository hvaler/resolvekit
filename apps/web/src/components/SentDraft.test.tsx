/**
 * Once evidence is in, the read-only panel never passes a later analysis off as what was sent: when the draft's notes
 * are not the notes PayPal stored, the header and the read-back say the draft below is not what was sent, and the sent
 * notes (as stored) are shown; when they are the same, it says the draft is what was sent.
 */
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { draftIsWhatWasSent, sentDraftHeader } from '../domain/recorded';
import type { DisputeSnapshot, RecordedEvidence as Entry } from '../domain/types';
import { RecordedEvidence } from './RecordedEvidence';

const SENT = 'The parcel was delivered on 9 October. The tracking shows the signature.';
const seller: Entry = {
  evidenceType: 'PROOF_OF_FULFILLMENT',
  source: 'SUBMITTED_BY_SELLER',
  date: '2026-10-31T10:00:00.000Z',
  carrier: 'UPS',
  tracking: '1Z999',
  notes: SENT,
  files: [],
  storedAt: '31 Oct 2026 10:00:00 UTC',
};
const snap: DisputeSnapshot = { id: 'CASE-1', status: 'UNDER_REVIEW', stage: 'INQUIRY', allowedActions: [], evidences: [seller], readAt: '' };

describe('draftIsWhatWasSent', () => {
  it('the same notes (whitespace aside): yes; other notes: no; nothing recorded: unknown', () => {
    expect(draftIsWhatWasSent(snap, `  ${SENT.replace('. ', '.  ')} `)).toBe(true);
    expect(draftIsWhatWasSent(snap, `${SENT} A sixth sentence from a later analysis.`)).toBe(false);
    expect(draftIsWhatWasSent({ ...snap, evidences: [] }, SENT)).toBeNull();
  });

  it('the header says so', () => {
    expect(sentDraftHeader(true)).toBe('Sent · read-only');
    expect(sentDraftHeader(null)).toBe('Sent · read-only');
    expect(sentDraftHeader(false)).toBe('Sent · read-only · the draft below is not what was sent');
  });
});

describe('the read-back under the sent evidence', () => {
  it('draft from a later analysis: says it is not what was sent, and shows the sent notes as stored', () => {
    const html = renderToString(<RecordedEvidence snapshot={snap} realPayPal draftMatches={false} />);
    expect(html).toContain(SENT);
    expect(html).toContain('The draft below is not what was sent');
    expect(html).toContain('What was sent is the notes above, exactly as PayPal stored them.');
    expect(html).not.toContain('The draft below is the analysis it was built from');
  });

  it('the same draft: says the draft below is what was sent', () => {
    const html = renderToString(<RecordedEvidence snapshot={snap} realPayPal draftMatches />);
    expect(html).toContain('The draft below is what was sent');
    expect(html).not.toContain('not what was sent');
  });

  it('not known yet (the analysis still loading or replaying): claims neither', () => {
    const html = renderToString(<RecordedEvidence snapshot={snap} realPayPal />);
    expect(html).toContain('Only the approved draft’s supported sentences went as the notes');
    expect(html).not.toContain('The draft below is');
  });
});
