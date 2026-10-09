import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PayPalClient } from '../src/client.ts';
import { approvalUrl, orderCapture } from '../src/orders.ts';

function fake(body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
    return new Response(JSON.stringify(body), { status: 201 });
  }) as typeof fetch;
  return { client: new PayPalClient({ clientId: 'id', clientSecret: 's', env: 'sandbox', fetch: fn }), calls };
}

test('creates an AUTHORIZE order with a DIGITAL_GOODS item, no shipping, return/cancel URLs and the full representation', async () => {
  const { client, calls } = fake({ id: 'O1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=O1' }] });
  const amount = { currency_code: 'USD', value: '5.00' };
  const o = await client.orders.createAuthorize(
    { amount, items: [{ name: 'Session', quantity: '1', unit_amount: amount, category: 'DIGITAL_GOODS' }], customId: 'mm-sess-1', description: 'd', returnUrl: 'http://127.0.0.1:8790/approved', cancelUrl: 'http://127.0.0.1:8790/cancelled' },
    { requestId: 'mm-sess-1-order' },
  );
  assert.equal(approvalUrl(o), 'https://www.sandbox.paypal.com/checkoutnow?token=O1');
  const c = calls[1]!;
  assert.match(c.url, /\/v2\/checkout\/orders$/);
  const h = c.init.headers as Record<string, string>;
  assert.equal(h['PayPal-Request-Id'], 'mm-sess-1-order');
  assert.equal(h.Prefer, 'return=representation');
  const b = JSON.parse(String(c.init.body));
  assert.equal(b.intent, 'AUTHORIZE');
  assert.deepEqual(b.purchase_units[0].amount.breakdown.item_total, amount);
  assert.equal(b.purchase_units[0].items[0].category, 'DIGITAL_GOODS');
  assert.equal(b.purchase_units[0].custom_id, 'mm-sess-1');
  assert.equal(b.payment_source.paypal.experience_context.shipping_preference, 'NO_SHIPPING');
});

test('captures part of an authorization with final_capture, invoice id and note; void sends no body', async () => {
  const { client, calls } = fake({ id: 'C1', status: 'COMPLETED' });
  await client.payments.captureAuthorization('A1', { amount: { currency_code: 'USD', value: '1.37' }, finalCapture: true, invoiceId: 'mm-sess-1-settle', noteToPayer: 'n' }, { requestId: 'mm-sess-1-settle' });
  assert.match(calls[1]!.url, /\/v2\/payments\/authorizations\/A1\/capture$/);
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { amount: { currency_code: 'USD', value: '1.37' }, final_capture: true, invoice_id: 'mm-sess-1-settle', note_to_payer: 'n' });
  await client.payments.voidAuthorization('A1');
  assert.match(calls[2]!.url, /\/A1\/void$/);
  assert.equal(calls[2]!.init.body, undefined);
  assert.equal((calls[2]!.init.headers as Record<string, string>)['Content-Type'], 'application/json');
});

test('creates a CAPTURE order (physical goods ship to the buyer’s address) and captures it once approved', async () => {
  const { client, calls } = fake({ id: 'O2', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP2', status: 'COMPLETED' }] } }] });
  const amount = { currency_code: 'USD', value: '7.00' };
  await client.orders.createCapture(
    { amount, items: [{ name: 'Linen tote, natural', quantity: '1', unit_amount: amount, category: 'PHYSICAL_GOODS' }], description: 'd', returnUrl: 'https://x/ok', cancelUrl: 'https://x/no', shipping: 'GET_FROM_FILE' },
    { requestId: 'rk-demo-1' },
  );
  const b = JSON.parse(String(calls[1]!.init.body));
  assert.equal(b.intent, 'CAPTURE');
  assert.deepEqual(b.purchase_units[0].amount, { ...amount, breakdown: { item_total: amount } });
  assert.equal(b.purchase_units[0].items[0].category, 'PHYSICAL_GOODS');
  assert.equal(b.payment_source.paypal.experience_context.shipping_preference, 'GET_FROM_FILE');
  assert.equal(b.payment_source.paypal.experience_context.user_action, 'PAY_NOW');
  const done = await client.orders.capture('O2', { requestId: 'rk-demo-1-capture' });
  assert.match(calls[2]!.url, /\/v2\/checkout\/orders\/O2\/capture$/);
  assert.equal(orderCapture(done)?.id, 'CAP2');
  assert.equal(orderCapture({ id: 'O3' }), null);
});
