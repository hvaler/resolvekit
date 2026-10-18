import { describe, expect, it } from 'vitest';
import { GatewayTimeoutError, SimulatedDisputeGateway } from './gateway';
import { GatewayRequestError, HttpDisputeGateway, RoutingDisputeGateway, modeFor, type ServerHealth } from './httpGateway';
import { recordedBy } from '../components/ApproveFlow';
import type { DisputeSnapshot, EvidenceSubmission } from './types';

type Call = { url: string; init: RequestInit };
function fake(reply: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return reply(url, init);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

const snap: DisputeSnapshot = { id: 'CASE-1', status: 'WAITING_FOR_SELLER_RESPONSE', allowedActions: ['provide_evidence'], evidences: [], readAt: '' };
const submission: EvidenceSubmission = {
  disputeId: 'CASE-1',
  action: 'provide_evidence',
  evidenceType: 'PROOF_OF_FULFILLMENT',
  carrier: 'UPS',
  tracking: '1Z',
  notes: 'n',
  files: [{ name: 'a.pdf', size: '1 KB' }],
  intentId: 'int-0123456789abcdef01234567',
};

describe('HttpDisputeGateway', () => {
  it('reads a dispute through /api', async () => {
    const f = fake(() => json(200, snap));
    expect(await new HttpDisputeGateway({ fetch: f.fetch }).getDispute('CASE-1')).toEqual(snap);
    expect(f.calls[0]!.url).toBe('/api/disputes/CASE-1');
  });

  it('posts only the approved intent id (the server sends the intent’s own content); 202 resolves', async () => {
    const f = fake(() => json(202, { sent: true }));
    await new HttpDisputeGateway({ fetch: f.fetch }).provideEvidence(submission, { requestId: 'rk-req-1' });
    const c = f.calls[0]!;
    expect(c.url).toBe('/api/disputes/CASE-1/evidence');
    expect(c.init.method).toBe('POST');
    expect(new Headers(c.init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(c.init.body))).toEqual({ intentId: submission.intentId });
  });

  it('never posts a submission without an approved intent', async () => {
    const f = fake(() => json(202, { sent: true }));
    const { intentId: _, ...bare } = submission;
    await expect(new HttpDisputeGateway({ fetch: f.fetch }).provideEvidence(bare)).rejects.toBeInstanceOf(GatewayRequestError);
    expect(f.calls).toHaveLength(0);
  });

  it('surfaces PayPal issue codes', async () => {
    const f = fake(() => json(422, { error: 'PayPal 422 UNPROCESSABLE_ENTITY', paypalIssue: 'EVIDENCE_TYPE_IS_NOT_ALLOWED' }));
    const e = await new HttpDisputeGateway({ fetch: f.fetch }).provideEvidence(submission, { requestId: 'r' }).catch((x) => x);
    expect(e).toBeInstanceOf(GatewayRequestError);
    expect(e).toMatchObject({ status: 422, paypalIssue: 'EVIDENCE_TYPE_IS_NOT_ALLOWED' });
    expect(e.message).toContain('EVIDENCE_TYPE_IS_NOT_ALLOWED');
  });

  it('maps the AbortSignal timeout (and a server 504) to GatewayTimeoutError', async () => {
    const hang = fake(
      (_u, init) =>
        new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')))),
    );
    await expect(new HttpDisputeGateway({ fetch: hang.fetch, sendTimeoutMs: 20 }).provideEvidence(submission, { requestId: 'r' })).rejects.toBeInstanceOf(GatewayTimeoutError);
    const f504 = fake(() => json(504, { error: 'PAYPAL_TIMEOUT' }));
    await expect(new HttpDisputeGateway({ fetch: f504.fetch }).getDispute('CASE-1')).rejects.toBeInstanceOf(GatewayTimeoutError);
  });

  it('health: unconfigured when the server is not running', async () => {
    const down = fake(() => {
      throw new TypeError('fetch failed');
    });
    expect(await new HttpDisputeGateway({ fetch: down.fetch }).health()).toMatchObject({ paypal: 'unconfigured', bound: [], failed: true });
    // A rate-limited or failing health is a failed read, not "nothing bound".
    for (const status of [429, 500, 503]) {
      const r = await new HttpDisputeGateway({ fetch: fake(() => json(status, { error: 'X' })).fetch }).health();
      expect(r).toMatchObject({ paypal: 'unconfigured', bound: [], failed: true });
    }
    const up = fake(() => json(200, { paypal: 'sandbox', bound: ['CASE-1'] }));
    expect(await new HttpDisputeGateway({ fetch: up.fetch }).health()).toEqual({ paypal: 'sandbox', bound: ['CASE-1'] });
  });
});

describe('real or simulated, per case', () => {
  const live: ServerHealth = { paypal: 'sandbox', bound: ['CASE-1'] };

  it('real PayPal only for a bound case while the server reports PayPal connected', () => {
    expect(modeFor('CASE-1', live)).toEqual({ kind: 'paypal', env: 'sandbox' });
    expect(modeFor('CASE-2', live)).toEqual({ kind: 'simulator' });
    expect(modeFor('CASE-1', { paypal: 'unconfigured', bound: ['CASE-1'] })).toEqual({ kind: 'simulator' });
    expect(modeFor('CASE-1', null)).toEqual({ kind: 'simulator' });
  });

  it('"Recorded by PayPal" only with the real gateway', () => {
    expect(recordedBy({ kind: 'paypal', env: 'sandbox' })).toBe('Recorded by PayPal');
    expect(recordedBy({ kind: 'simulator' })).toBe('Recorded by the PayPal simulator');
  });

  it('routes reads and sends: an unbound case never reaches the server', async () => {
    const f = fake(() => json(200, snap));
    const sim = new SimulatedDisputeGateway([{ ...snap, id: 'CASE-2' }], { outcome: () => 'waiting_for_buyer' });
    const g = new RoutingDisputeGateway(new HttpDisputeGateway({ fetch: f.fetch }), sim, (id) => modeFor(id, live));
    await g.getDispute('CASE-1');
    await g.getDispute('CASE-2');
    await g.provideEvidence({ ...submission, disputeId: 'CASE-2' }, { requestId: 'r' });
    expect(f.calls.map((c) => c.url)).toEqual(['/api/disputes/CASE-1']);
    expect(sim.sent).toHaveLength(1);
  });
});
