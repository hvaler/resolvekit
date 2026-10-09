import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DailyCounters } from '@resolvekit/hosting';
import { createApp, DEMO_CODE_HEADER, TOKEN_HEADER } from '../src/app.ts';
import { Ledger } from '../src/ledger.ts';
import { Meter } from '../src/meter.ts';
import { fakePayPal } from './fakePayPal.ts';

const PUBLIC = 'https://metermcp.example.com';
const HOST = 'metermcp.example.com';
const INTERNAL = 'metermcp-ab12:10000';
const TOKEN = 'a'.repeat(64);
const CODE = 'judges-code-2026';

function setup(o: { budgets?: number; badCodes?: number } = {}) {
  const pp = fakePayPal();
  const meter = new Meter({ ledger: new Ledger(':memory:'), paypal: pp.client, env: 'sandbox', publicUrl: PUBLIC });
  const budgets = new DailyCounters({ file: null, limits: { budget: o.budgets ?? 5 } });
  const app = createApp({
    meter,
    env: 'sandbox',
    port: 10000,
    token: TOKEN,
    allowedOrigins: [],
    hosted: { publicHosts: [HOST], https: true, demoCode: CODE, budgets, badCodesPerIp: { limit: o.badCodes ?? 5, windowMs: 900_000 } },
  });
  // What Render's proxy does for public traffic: Host is the public host, X-Forwarded-For carries the client.
  const publicFetch = (ip = '203.0.113.9') =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const r = new Request(input, init);
      const h = new Headers(r.headers);
      h.set('host', HOST);
      h.set('x-forwarded-for', ip);
      return app(new Request(r, { headers: h }));
    }) as typeof globalThis.fetch;
  return { pp, meter, app, budgets, publicFetch };
}

async function connect(fetch: typeof globalThis.fetch, code?: string) {
  const client = new Client({ name: 'judge-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${PUBLIC}/mcp`), { fetch, ...(code ? { requestInit: { headers: { [DEMO_CODE_HEADER]: code } } } : {}) }));
  return client;
}
const body = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text);

test('hosted MeterMCP: public routes only on the public host; /healthz on any host; security headers', async () => {
  const { app } = setup();
  const pub = await app(new Request(`${PUBLIC}/health`, { headers: { host: HOST, 'x-forwarded-for': '203.0.113.9' } }));
  assert.equal(pub.status, 200);
  assert.equal(pub.headers.get('x-content-type-options'), 'nosniff');
  assert.match(pub.headers.get('strict-transport-security')!, /max-age/);
  assert.equal((await app(new Request(`${PUBLIC}/health`, { headers: { host: 'evil.example' } }))).status, 403);
  assert.equal((await app(new Request(`${PUBLIC}/healthz`, { headers: { host: '10.0.0.3:10000' } }))).status, 200);
});

test('hosted MeterMCP: admin routes only from the private network (no proxy hop, not the public Host) and with the token', async () => {
  const { app } = setup();
  const path = `${PUBLIC}/sessions?capture=CAP0001FAKE`;
  // Through the public proxy, even with the right token: not there.
  assert.equal((await app(new Request(path, { headers: { host: HOST, 'x-forwarded-for': '203.0.113.9', [TOKEN_HEADER]: TOKEN } }))).status, 404);
  assert.equal((await app(new Request(path, { headers: { host: HOST, [TOKEN_HEADER]: TOKEN } }))).status, 404);
  assert.equal((await app(new Request(path, { headers: { host: INTERNAL, 'x-forwarded-for': '10.0.0.9', [TOKEN_HEADER]: TOKEN } }))).status, 404);
  // Private network: the token decides.
  assert.equal((await app(new Request(path, { headers: { host: INTERNAL } }))).status, 401);
  assert.equal((await app(new Request(path, { headers: { host: INTERNAL, [TOKEN_HEADER]: 'b'.repeat(64) } }))).status, 401);
  const ok = await app(new Request(path, { headers: { host: INTERNAL, [TOKEN_HEADER]: TOKEN } }));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { sessions: [] });
});

test('hosted MeterMCP: without the demo code a paid tool answers demo_code_required and no PayPal order is created; free tools work', async () => {
  const { pp, publicFetch, budgets } = setup();
  const client = await connect(publicFetch());
  const r = await client.callTool({ name: 'quote_lookup', arguments: { symbol: 'ACME-42' } });
  assert.equal(r.isError, true);
  const b = body(r);
  assert.equal(b.error, 'demo_code_required');
  assert.match(b.message, /x-demo-code/);
  assert.equal(pp.count(/POST \/v2\/checkout\/orders$/), 0);
  assert.equal(budgets.state().caps.budget!.used, 0);
  const prices = body(await client.callTool({ name: 'price_list', arguments: {} }));
  assert.equal(prices.tools.length, 3);
  const bal = body(await client.callTool({ name: 'get_balance', arguments: {} }));
  assert.equal(bal.status, 'none');
  await client.close();
});

test('hosted MeterMCP: with the demo code the paid tool answers payment_required with an approval URL; return URLs are public', async () => {
  const { pp, publicFetch, budgets } = setup();
  const client = await connect(publicFetch(), CODE);
  const b = body(await client.callTool({ name: 'quote_lookup', arguments: { symbol: 'ACME-42' } }));
  assert.equal(b.error, 'payment_required');
  assert.match(b.approval_url, /^https:\/\//);
  assert.equal(pp.count(/POST \/v2\/checkout\/orders$/), 1);
  assert.equal(budgets.state().caps.budget!.used, 1);
  const order = [...pp.orders.values()][0] as unknown as { body?: { payment_source?: unknown; application_context?: { return_url?: string } } } & Record<string, unknown>;
  assert.ok(JSON.stringify(order).includes(`${PUBLIC}/approved`), 'return URL on the public host');
  // The same MCP session asking again does not create another budget.
  await client.callTool({ name: 'quote_lookup', arguments: { symbol: 'ACME-42' } });
  assert.equal(pp.count(/POST \/v2\/checkout\/orders$/), 1);
  await client.close();
});

test('hosted MeterMCP: a wrong demo code is refused; repeated wrong codes block the IP, even for the right code', async () => {
  const { publicFetch } = setup({ badCodes: 3 });
  const f = publicFetch('198.51.100.4');
  const init = (code: string) => ({ method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', [DEMO_CODE_HEADER]: code }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }) });
  for (let i = 0; i < 3; i++) assert.equal((await f(`${PUBLIC}/mcp`, init(`guess-${i}`))).status, 403);
  assert.equal((await f(`${PUBLIC}/mcp`, init(CODE))).status, 429);
  // Concurrent guesses from another IP: never more than the limit get an answer other than 429.
  const g = publicFetch('198.51.100.5');
  const all = await Promise.all(Array.from({ length: 12 }, (_, i) => g(`${PUBLIC}/mcp`, init(`g-${i}`))));
  assert.equal(all.filter((r) => r.status === 403).length, 3);
  assert.equal(all.filter((r) => r.status === 429).length, 9);
});

test('hosted MeterMCP: concurrent budgets never exceed the daily cap; a budget PayPal could not create is refunded', async () => {
  const { pp, publicFetch, budgets } = setup({ budgets: 2 });
  pp.failNext(/POST \/v2\/checkout\/orders$/);
  const first = await connect(publicFetch(), CODE);
  const failed = body(await first.callTool({ name: 'quote_lookup', arguments: { symbol: 'A' } }));
  assert.equal(failed.error, 'paypal_unavailable');
  assert.equal(budgets.state().caps.budget!.used, 0);
  const clients = await Promise.all(Array.from({ length: 6 }, (_, i) => connect(publicFetch(`203.0.113.${20 + i}`), CODE)));
  const answers = await Promise.all(clients.map((c) => c.callTool({ name: 'quote_lookup', arguments: { symbol: 'A' } }).then(body)));
  assert.equal(answers.filter((a) => a.error === 'payment_required').length, 2);
  assert.equal(answers.filter((a) => a.error === 'daily_cap').length, 4);
  assert.equal(budgets.state().caps.budget!.used, 2);
  for (const c of [first, ...clients]) await c.close();
});
