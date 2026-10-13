import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PayPalClient, PayPalError } from '../src/client.ts';

type Answer = { status: number; body: string; headers?: Record<string, string> };

// Fake fetch: answers OAuth, then the queued raw answers in order, and records every API call.
function fakeFetch(answers: Answer[]) {
  const calls: Array<{ method: string; path: string; headers: Headers }> = [];
  const fn = async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
    calls.push({ method: init.method ?? 'GET', path: u.pathname, headers: new Headers(init.headers) });
    const a = answers.shift() ?? { status: 500, body: '{"name":"NO_FAKE_ANSWER"}' };
    return new Response(a.status === 204 ? null : a.body, { status: a.status, headers: a.headers });
  };
  return { fn: fn as typeof fetch, calls };
}

function client(f: typeof fetch) {
  const waits: number[] = [];
  const c = new PayPalClient({ clientId: 'id', clientSecret: 'secret', env: 'sandbox', fetch: f, sleep: async (ms) => void waits.push(ms) });
  return { c, waits };
}

test('every PayPal error carries its debug_id in the message, so each log line that prints it can be traced', async () => {
  const { fn } = fakeFetch([{ status: 422, body: '{"name":"UNPROCESSABLE_ENTITY","details":[{"issue":"INSTRUMENT_DECLINED"}]}', headers: { 'paypal-debug-id': 'f00dcafe1234' } }]);
  const { c } = client(fn);
  await assert.rejects(c.orders.get('ORD1'), (e: PayPalError) => {
    assert.equal(e.debugId, 'f00dcafe1234');
    assert.match(e.message, /422 UNPROCESSABLE_ENTITY.*INSTRUMENT_DECLINED.*debug_id f00dcafe1234/);
    return true;
  });
});

test('a non-JSON error page from PayPal keeps its status and debug_id instead of becoming a parse error', async () => {
  const { fn } = fakeFetch([{ status: 503, body: '<html><body>Service Unavailable</body></html>', headers: { 'paypal-debug-id': 'abc123' } }]);
  const { c } = client(fn);
  await assert.rejects(c.orders.get('ORD1'), (e: unknown) => {
    assert.ok(e instanceof PayPalError, String(e));
    assert.equal(e.status, 503);
    assert.equal(e.debugId, 'abc123');
    assert.match(e.message, /503 NON_JSON_RESPONSE/);
    assert.ok(!e.message.includes('<html>'));
    return true;
  });
});

test('a 2xx answer that is not JSON is an error, not a crash', async () => {
  const { fn } = fakeFetch([{ status: 200, body: 'OK' }]);
  await assert.rejects(client(fn).c.orders.get('ORD1'), (e: unknown) => e instanceof PayPalError && e.status === 200 && /NON_JSON_RESPONSE/.test(e.message));
});

test('an empty 2xx answer (204) is an empty object', async () => {
  const { fn } = fakeFetch([{ status: 204, body: '' }]);
  assert.deepEqual(await client(fn).c.request('POST', '/v2/payments/authorizations/A1/void', undefined, { requestId: 'x-void' }), {});
});

test('429 is retried after Retry-After (capped), keeping the same PayPal-Request-Id; then the answer is returned', async () => {
  const { fn, calls } = fakeFetch([
    { status: 429, body: '{"name":"RATE_LIMIT_REACHED"}', headers: { 'retry-after': '2' } },
    { status: 429, body: '{"name":"RATE_LIMIT_REACHED"}', headers: { 'retry-after': '120' } },
    { status: 201, body: '{"id":"ORD9","status":"CREATED"}' },
  ]);
  const { c, waits } = client(fn);
  const r = await c.request<{ id: string }>('POST', '/v2/checkout/orders', { intent: 'AUTHORIZE' }, { requestId: 'sess-order' });
  assert.equal(r.id, 'ORD9');
  assert.deepEqual(waits, [2000, 5000]);
  assert.deepEqual(calls.map((x) => x.headers.get('paypal-request-id')), ['sess-order', 'sess-order', 'sess-order']);
});

test('without Retry-After, 429 backs off exponentially; after the last attempt the 429 is thrown', async () => {
  const limited = { status: 429, body: '{"name":"RATE_LIMIT_REACHED"}' };
  const { fn, calls } = fakeFetch([limited, limited, limited]);
  const { c, waits } = client(fn);
  await assert.rejects(c.orders.get('ORD1'), (e: PayPalError) => e.status === 429);
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test('other errors are never retried by the client (5xx retries stay with the callers that read back first)', async () => {
  const { fn, calls } = fakeFetch([{ status: 500, body: '{"name":"INTERNAL_SERVER_ERROR"}' }]);
  await assert.rejects(client(fn).c.orders.get('ORD1'), (e: PayPalError) => e.status === 500);
  assert.equal(calls.length, 1);
});

test('a non-JSON OAuth failure is a PayPalError with its status, without the secret', async () => {
  const fn = (async () => new Response('<html>Bad Gateway</html>', { status: 502 })) as typeof fetch;
  await assert.rejects(client(fn).c.verifyCredentials(), (e: unknown) => e instanceof PayPalError && e.status === 502 && !e.message.includes('secret'));
});
