import { describe, expect, it } from 'vitest';
import { allowedActionsAfter } from './allowedActions';
import { SimulatedDisputeGateway, safeRetry, submitWithReadBack, type SendPhase, type SimulatedOutcome } from './gateway';
import type { DisputeSnapshot, EvidenceSubmission } from './types';

const initial: DisputeSnapshot = {
  id: 'D1',
  status: 'WAITING_FOR_SELLER_RESPONSE',
  allowedActions: ['provide_evidence', 'send_message', 'make_offer', 'accept_claim'],
  evidences: [],
  readAt: '',
};
const submission: EvidenceSubmission = {
  disputeId: 'D1',
  action: 'provide_evidence',
  evidenceType: 'PROOF_OF_FULFILLMENT',
  carrier: 'UPS',
  tracking: '1Z',
  notes: 'n',
  files: [{ name: 'a.pdf', size: '1 KB' }],
};
const gw = (outcome: SimulatedOutcome) =>
  new SimulatedDisputeGateway([initial], { outcome: () => outcome, now: () => new Date(Date.UTC(2026, 9, 8, 19, 4, 2)) });

describe('submitWithReadBack', () => {
  it('reports recorded only from the read-back, and PayPal removes provide_evidence', async () => {
    const g = gw('waiting_for_buyer');
    const phases: SendPhase[] = [];
    const r = await submitWithReadBack(g, submission, { requestId: 'rk-1', onPhase: (p) => phases.push(p) });
    expect(phases).toEqual(['sending', 'awaiting', 'rereading']);
    expect(r.kind).toBe('recorded');
    if (r.kind !== 'recorded') return;
    expect(r.snapshot.status).toBe('WAITING_FOR_BUYER_RESPONSE');
    expect(r.recorded.storedAt).toBe('8 Oct 2026 19:04:02 UTC');
    const rows = allowedActionsAfter(initial.allowedActions, r.snapshot);
    expect(rows.find((a) => a.code === 'provide_evidence')).toMatchObject({ allowed: false, why: 'Removed by PayPal: evidence already submitted' });
    expect(rows.filter((a) => a.allowed).map((a) => a.code)).toEqual(['send_message', 'make_offer', 'accept_claim']);
  });

  it('under review: only send_message remains', async () => {
    const r = await submitWithReadBack(gw('under_review'), submission, { requestId: 'rk-1' });
    expect(r.kind).toBe('recorded');
    if (r.kind !== 'recorded') return;
    expect(r.snapshot.status).toBe('UNDER_REVIEW');
    const rows = allowedActionsAfter(initial.allowedActions, r.snapshot);
    expect(rows.find((a) => a.code === 'make_offer')?.why).toBe('Not offered while PayPal reviews');
  });

  it('on timeout reads back and reports not recorded', async () => {
    const g = gw('timeout');
    const phases: SendPhase[] = [];
    const r = await submitWithReadBack(g, submission, { requestId: 'rk-1', onPhase: (p) => phases.push(p) });
    expect(phases).toEqual(['sending', 'rereading']);
    expect(r.kind).toBe('not_recorded');
    expect(r.snapshot.status).toBe('WAITING_FOR_SELLER_RESPONSE');
    expect(g.sent).toHaveLength(0);
  });
});

describe('safeRetry', () => {
  it('reads back first and only re-sends when PayPal shows nothing recorded', async () => {
    const g = gw('timeout');
    const first = await submitWithReadBack(g, submission, { requestId: 'rk-1' });
    const phases: SendPhase[] = [];
    const r = await safeRetry(g, submission, { requestId: 'rk-1', baseline: first.baseline, onPhase: (p) => phases.push(p) });
    expect(phases[0]).toBe('checking');
    expect(r.kind === 'recorded' && r.resent).toBe(true);
    expect(g.sent).toHaveLength(1);
  });

  it('does not send again when evidence is already recorded', async () => {
    const g = gw('waiting_for_buyer');
    const first = await submitWithReadBack(g, submission, { requestId: 'rk-1' });
    const r = await safeRetry(g, submission, { requestId: 'rk-1', baseline: first.baseline });
    expect(r.kind).toBe('recorded');
    expect(r.kind === 'recorded' && r.resent).toBe(false);
    expect(g.sent).toHaveLength(1);
  });

  it('refuses a second submission like PayPal does', async () => {
    const g = gw('waiting_for_buyer');
    await submitWithReadBack(g, submission, { requestId: 'rk-1' });
    await expect(g.provideEvidence(submission, { requestId: 'rk-2' })).rejects.toThrow(/NOT_AUTHORIZED/);
  });
});

describe('new disputes opened by PayPal', () => {
  const fresh: DisputeSnapshot = { id: 'N1', status: 'UNDER_REVIEW', allowedActions: [], evidences: [], readAt: '' };
  const opening = {
    afterMs: 60_000,
    status: 'WAITING_FOR_SELLER_RESPONSE' as const,
    stage: 'INQUIRY',
    respondBy: '2026-10-18T19:00:00Z',
    allowedActions: ['send_message', 'provide_evidence'] as const,
  };

  it('stays UNDER_REVIEW with no actions until the opening time, then reads back opened', async () => {
    let now = Date.UTC(2026, 9, 8, 19, 0, 0);
    const g = new SimulatedDisputeGateway([fresh], { outcome: () => 'waiting_for_buyer', now: () => new Date(now), openings: { N1: opening } });
    expect(await g.getDispute('N1')).toMatchObject({ status: 'UNDER_REVIEW', allowedActions: [] });
    now += 60_000;
    expect(await g.getDispute('N1')).toMatchObject({ status: 'WAITING_FOR_SELLER_RESPONSE', stage: 'INQUIRY', respondBy: opening.respondBy, allowedActions: ['send_message', 'provide_evidence'] });
  });

  it('can be opened on demand, and fails reads while offline', async () => {
    const g = new SimulatedDisputeGateway([fresh], { outcome: () => 'waiting_for_buyer', openings: { N1: opening } });
    g.openNow('N1');
    g.setOffline(true);
    await expect(g.getDispute('N1')).rejects.toThrow('PayPal could not be reached');
    g.setOffline(false);
    expect((await g.getDispute('N1')).status).toBe('WAITING_FOR_SELLER_RESPONSE');
  });
});
