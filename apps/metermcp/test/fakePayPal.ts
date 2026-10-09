/**
 * A stateful fake of the PayPal Orders v2 / Payments v2 calls MeterMCP makes, shaped like the sandbox answers of
 * 2026-10-08 (docs: paypal-authorize-capture). The buyer's approval is a test action: `approve(orderId)`.
 */
import { PayPalClient } from '@resolvekit/paypal';

type Money = { currency_code: string; value: string };
interface FakeOrder { id: string; status: string; amount: Money; customId: string; body: any; authorizationId?: string }
interface FakeAuth { id: string; status: string; amount: Money; orderId: string; captures: Array<{ id: string; amount: Money; body: any }> }

export function fakePayPal() {
  const orders = new Map<string, FakeOrder>();
  const auths = new Map<string, FakeAuth>();
  const calls: Array<{ method: string; path: string; body: any; headers: Record<string, string> }> = [];
  const failures: Array<{ match: RegExp; status: number; body: unknown }> = [];
  let seq = 0;
  const id = (p: string) => `${p}${String(++seq).padStart(4, '0')}FAKE`;

  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'paypal-debug-id': 'dbgfake' } });

  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? 'GET';
    if (u.pathname === '/v1/oauth2/token') return reply(200, { access_token: 'tok', expires_in: 32400 });
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname, body, headers: { ...(init.headers as Record<string, string>) } });
    const f = failures.findIndex((x) => x.match.test(`${method} ${u.pathname}`));
    if (f >= 0) {
      const x = failures.splice(f, 1)[0]!;
      return reply(x.status, x.body);
    }
    let m: RegExpExecArray | null;
    if (method === 'POST' && u.pathname === '/v2/checkout/orders') {
      const pu = body.purchase_units[0];
      const o: FakeOrder = { id: id('ORD'), status: 'PAYER_ACTION_REQUIRED', amount: pu.amount, customId: pu.custom_id, body };
      orders.set(o.id, o);
      return reply(200, {
        id: o.id,
        intent: 'AUTHORIZE',
        status: o.status,
        links: [
          { rel: 'self', href: `https://api.sandbox.paypal.com/v2/checkout/orders/${o.id}`, method: 'GET' },
          { rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${o.id}`, method: 'GET' },
        ],
      });
    }
    const orderView = (o: FakeOrder) => ({
      id: o.id,
      intent: 'AUTHORIZE',
      status: o.status,
      purchase_units: [
        {
          custom_id: o.customId,
          amount: o.amount,
          ...(o.authorizationId
            ? {
                payments: {
                  authorizations: [
                    { id: o.authorizationId, status: auths.get(o.authorizationId)!.status, amount: o.amount, expiration_time: '2026-11-06T18:09:13Z', create_time: '2026-10-08T18:09:13Z' },
                  ],
                },
              }
            : {}),
        },
      ],
    });
    if ((m = /^\/v2\/checkout\/orders\/([^/]+)$/.exec(u.pathname)) && method === 'GET') {
      const o = orders.get(m[1]!);
      return o ? reply(200, orderView(o)) : reply(404, { name: 'RESOURCE_NOT_FOUND' });
    }
    if ((m = /^\/v2\/checkout\/orders\/([^/]+)\/authorize$/.exec(u.pathname)) && method === 'POST') {
      const o = orders.get(m[1]!);
      if (!o) return reply(404, { name: 'RESOURCE_NOT_FOUND' });
      if (o.status !== 'APPROVED') return reply(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: o.authorizationId ? 'ORDER_ALREADY_AUTHORIZED' : 'ORDER_NOT_APPROVED' }] });
      const a: FakeAuth = { id: id('AUTH'), status: 'CREATED', amount: o.amount, orderId: o.id, captures: [] };
      auths.set(a.id, a);
      o.authorizationId = a.id;
      o.status = 'COMPLETED';
      return reply(201, orderView(o));
    }
    if ((m = /^\/v2\/payments\/authorizations\/([^/]+)$/.exec(u.pathname)) && method === 'GET') {
      const a = auths.get(m[1]!);
      return a ? reply(200, { id: a.id, status: a.status, amount: a.amount }) : reply(404, { name: 'RESOURCE_NOT_FOUND' });
    }
    if ((m = /^\/v2\/payments\/authorizations\/([^/]+)\/capture$/.exec(u.pathname)) && method === 'POST') {
      const a = auths.get(m[1]!);
      if (!a) return reply(404, { name: 'RESOURCE_NOT_FOUND' });
      // PayPal-Request-Id replay: the same capture comes back.
      const rid = (init.headers as Record<string, string>)['PayPal-Request-Id'];
      const again = a.captures.find((c) => c.body.rid === rid);
      if (again) return reply(201, { id: again.id, status: 'COMPLETED', amount: again.amount });
      if (a.status !== 'CREATED') return reply(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'AUTHORIZATION_ALREADY_CAPTURED' }] });
      const c = { id: id('CAP'), amount: body.amount, body: { ...body, rid } };
      a.captures.push(c);
      if (body.final_capture) a.status = 'CAPTURED';
      return reply(201, { id: c.id, status: 'COMPLETED', amount: c.amount, final_capture: body.final_capture, invoice_id: body.invoice_id });
    }
    if ((m = /^\/v2\/payments\/authorizations\/([^/]+)\/void$/.exec(u.pathname)) && method === 'POST') {
      const a = auths.get(m[1]!);
      if (!a) return reply(404, { name: 'RESOURCE_NOT_FOUND' });
      a.status = 'VOIDED';
      return reply(200, { id: a.id, status: 'VOIDED', amount: a.amount });
    }
    return reply(500, { name: 'NO_FAKE_ROUTE', path: u.pathname });
  }) as typeof globalThis.fetch;

  return {
    client: new PayPalClient({ clientId: 'id', clientSecret: 'secret', env: 'sandbox', fetch }),
    orders,
    auths,
    calls,
    approve(orderId: string) {
      const o = orders.get(orderId);
      if (!o) throw new Error(`no order ${orderId}`);
      o.status = 'APPROVED';
    },
    /** The next request matching `METHOD /path` answers this error. */
    failNext(match: RegExp, status = 500, body: unknown = { name: 'INTERNAL_SERVER_ERROR', message: 'fake outage' }) {
      failures.push({ match, status, body });
    },
    count: (re: RegExp) => calls.filter((c) => re.test(`${c.method} ${c.path}`)).length,
  };
}
