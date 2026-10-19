import { describe, expect, it } from 'vitest';
import { AuthClient } from './authClient';

/** A fetch that records each request body and answers with an approval link. */
function recording() {
  const bodies: unknown[] = [];
  const fetch = (async (_url: string | URL | Request, init: RequestInit = {}) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ approvalUrl: 'https://www.sandbox.paypal.com/agreements/approve?ba_token=BA-1' }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { bodies, client: new AuthClient({ fetch }) };
}

describe('PayPal sign-in start', () => {
  it('sends the page to come back to, so the sign-in returns there', async () => {
    const r = recording();
    expect((await r.client.paypalStart('/cases/PP-R-TVH-10190665')).ok).toBe(true);
    expect(r.bodies).toEqual([{ next: '/cases/PP-R-TVH-10190665' }]);
  });

  it('sends nothing for the start page (the server’s default)', async () => {
    const r = recording();
    await r.client.paypalStart('/');
    await r.client.paypalStart();
    expect(r.bodies).toEqual([{}, {}]);
  });
});
