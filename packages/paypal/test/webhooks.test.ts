import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PayPalClient } from '../src/client.ts';
import { parseWebhookEvent, webhookTransmission, type WebhookTransmission } from '../src/webhooks.ts';

const goodHeaders = (over: Record<string, string> = {}) =>
  new Headers({
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77',
    'paypal-transmission-id': '103e3700-8b0c-11e6-8695-6b62a8a99ac4',
    'paypal-transmission-sig': 'sig==',
    'paypal-transmission-time': '2026-10-13T10:00:00Z',
    ...over,
  });

test('transmission headers: all five are required', () => {
  const t = webhookTransmission(goodHeaders()) as WebhookTransmission;
  assert.equal(t.authAlgo, 'SHA256withRSA');
  const h = goodHeaders();
  h.delete('paypal-transmission-sig');
  assert.deepEqual(webhookTransmission(h), { error: 'missing paypal-transmission-sig' });
});

test('transmission headers: a certificate URL off PayPal hosts (or not https) is refused before asking PayPal', () => {
  for (const url of ['https://evil.example/cert', 'http://api.sandbox.paypal.com/cert', 'https://api.sandbox.paypal.com.evil.example/c', 'not a url']) {
    assert.ok('error' in webhookTransmission(goodHeaders({ 'paypal-cert-url': url })), url);
  }
  assert.ok(!('error' in webhookTransmission(goodHeaders({ 'paypal-cert-url': 'https://api.paypal.com/v1/notifications/certs/CERT-1' }))));
});

test('parseWebhookEvent: needs a WH- id and an event type', () => {
  assert.equal(parseWebhookEvent('{"id":"WH-1A2B3C4D5E6F","event_type":"CUSTOMER.DISPUTE.CREATED","resource":{"dispute_id":"PP-R-ABC-1"}}')?.resource?.dispute_id, 'PP-R-ABC-1');
  assert.equal(parseWebhookEvent('{"id":"x","event_type":"CUSTOMER.DISPUTE.CREATED"}'), null);
  assert.equal(parseWebhookEvent('{"id":"WH-1A2B3C4D5E6F"}'), null);
  assert.equal(parseWebhookEvent('not json'), null);
  assert.equal(parseWebhookEvent('[1,2]'), null);
});

test('verify sends the event byte for byte (not re-serialised) with the webhook id, and reads SUCCESS', async () => {
  let sent = '';
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    if (new URL(String(url)).pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
    sent = String(init.body);
    return new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 });
  }) as typeof globalThis.fetch;
  const c = new PayPalClient({ clientId: 'id', clientSecret: 'secret', env: 'sandbox', fetch });
  // Spacing and key order as PayPal sent them; a number with a trailing zero that JSON.stringify would rewrite.
  const raw = '{ "id":"WH-1A2B3C4D5E6F",  "event_type":"CUSTOMER.DISPUTE.UPDATED", "resource":{"amount":1.50} }';
  assert.equal(await c.webhooks.verify(webhookTransmission(goodHeaders()) as WebhookTransmission, 'WEBHOOK123', raw), true);
  assert.ok(sent.endsWith(`"webhook_event":${raw}}`), sent);
  const parsed = JSON.parse(sent);
  assert.equal(parsed.webhook_id, 'WEBHOOK123');
  assert.equal(parsed.transmission_id, '103e3700-8b0c-11e6-8695-6b62a8a99ac4');
  assert.equal(parsed.webhook_event.event_type, 'CUSTOMER.DISPUTE.UPDATED');
});

test('verify reads anything but SUCCESS as not verified', async () => {
  const fetch = (async (url: string | URL) =>
    new URL(String(url)).pathname === '/v1/oauth2/token'
      ? new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 })
      : new Response(JSON.stringify({ verification_status: 'FAILURE' }), { status: 200 })) as typeof globalThis.fetch;
  const c = new PayPalClient({ clientId: 'id', clientSecret: 'secret', env: 'sandbox', fetch });
  assert.equal(await c.webhooks.verify(webhookTransmission(goodHeaders()) as WebhookTransmission, 'W', '{"id":"WH-1A2B3C4D5E6F","event_type":"X"}'), false);
});

test('verify is not retried on 429: the delivery is answered 503 and PayPal delivers it again later', async () => {
  let calls = 0;
  const fetch = (async (url: string | URL) => {
    if (new URL(String(url)).pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
    calls++;
    return new Response('{"name":"RATE_LIMIT_REACHED"}', { status: 429 });
  }) as typeof globalThis.fetch;
  const c = new PayPalClient({ clientId: 'id', clientSecret: 'secret', env: 'sandbox', fetch, sleep: async () => {} });
  await assert.rejects(c.webhooks.verify(webhookTransmission(goodHeaders()) as WebhookTransmission, 'W', '{"id":"WH-1A2B3C4D5E6F","event_type":"X"}'));
  assert.equal(calls, 1);
});
