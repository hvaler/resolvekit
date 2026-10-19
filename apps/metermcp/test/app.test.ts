import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp, TOKEN_HEADER } from '../src/app.ts';
import { Ledger } from '../src/ledger.ts';
import { Meter } from '../src/meter.ts';
import { fakePayPal } from './fakePayPal.ts';

const BASE = 'http://127.0.0.1:8790';
const TOKEN = 'a'.repeat(64);

function setup(o: { returnOrigins?: string[] } = {}) {
  const pp = fakePayPal();
  const meter = new Meter({ ledger: new Ledger(':memory:'), paypal: pp.client, env: 'sandbox', publicUrl: BASE, failFirst: ['deep_report'], returnOrigins: o.returnOrigins });
  const app = createApp({ meter, env: 'sandbox', port: 8790, token: TOKEN, allowedOrigins: [] });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => app(new Request(input, init))) as typeof globalThis.fetch;
  return { pp, meter, app, fetch };
}

async function connect(fetch: typeof globalThis.fetch) {
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { fetch }));
  return client;
}

const json = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text);
const admin = { [TOKEN_HEADER]: TOKEN };

test('guards: Host, browser Origin, JSON-only POST', async () => {
  const { app } = setup();
  const post = (headers: Record<string, string>) => app(new Request(`${BASE}/mcp`, { method: 'POST', headers, body: '{}' }));
  assert.equal((await app(new Request(`${BASE}/health`, { headers: { host: 'evil.example:8790' } }))).status, 403);
  assert.equal((await app(new Request(`${BASE}/health`, { headers: { host: 'localhost:8790' } }))).status, 200);
  assert.equal((await post({ 'content-type': 'application/json', origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post({ 'content-type': 'application/json' })).status, 400); // not an initialize request
  assert.equal((await app(new Request(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'mcp-session-id': 'nope' }, body: '{}' }))).status, 404);
});

test('admin routes need the per-launch token; a session id alone authorizes nothing', async () => {
  const { app, pp, fetch } = setup();
  const client = await connect(fetch);
  const pr = json(await client.callTool({ name: 'quote_lookup', arguments: { symbol: 'A' } }));
  pp.approve(pr.order_id);
  await client.callTool({ name: 'quote_lookup', arguments: { symbol: 'A' } });
  const id = pr.session_id as string;
  for (const headers of [{}, { [TOKEN_HEADER]: 'b'.repeat(64) }, { [TOKEN_HEADER]: 'short' }] as Array<Record<string, string>>) {
    assert.equal((await app(new Request(`${BASE}/sessions/${id}/receipt.json`, { headers }))).status, 401);
    assert.equal((await app(new Request(`${BASE}/sessions?capture=CAP0001FAKE`, { headers }))).status, 401);
    const close = await app(new Request(`${BASE}/sessions/${id}/close`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' }));
    assert.equal(close.status, 401);
  }
  assert.equal(pp.count(/capture$/), 0);
  // With the token: close (settles), receipt JSON/PDF, lookup by capture.
  const closed = await (await app(new Request(`${BASE}/sessions/${id}/close`, { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: '{}' }))).json();
  assert.equal(closed.status, 'settled');
  const found = await (await app(new Request(`${BASE}/sessions?capture=${closed.capture_id}`, { headers: admin }))).json();
  assert.deepEqual(found.sessions, [{ id, status: 'settled', capture_id: closed.capture_id }]);
  const receipt = await (await app(new Request(`${BASE}/sessions/${id}/receipt.json`, { headers: admin }))).json();
  assert.equal(receipt.settlement.capture_id, closed.capture_id);
  const pdf = await app(new Request(`${BASE}/sessions/${id}/receipt.pdf`, { headers: admin }));
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.ok(Buffer.from(await pdf.arrayBuffer()).toString('latin1').startsWith('%PDF-1.4'));
  assert.equal((await app(new Request(`${BASE}/sessions/mm-sess-unknown/receipt.json`, { headers: admin }))).status, 404);
  await client.close();
  await app.close();
});

test('over MCP (Streamable HTTP): tools declare prices; payment_required → approval → 4 calls → close settles 1.37', async () => {
  const { app, pp, fetch } = setup();
  const client = await connect(fetch);
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const [name, price] of [['quote_lookup', '0.05'], ['deep_report', '0.40'], ['bulk_export', '0.92']] as const) {
    assert.match(byName[name]!.description!, new RegExp(`Price: ${price.replace('.', '\\.')} USD per successful call`));
    assert.match(byName[name]!.annotations!.title!, new RegExp(`${price.replace('.', '\\.')} USD per call`));
    assert.deepEqual((byName[name]!._meta as Record<string, unknown>)['metermcp/price'], { amount: price, currency: 'USD', per: 'successful call' });
  }
  for (const free of ['price_list', 'get_balance', 'close_session', 'get_receipt', 'open_budget']) assert.ok(byName[free], free);
  assert.equal(byName.open_budget!.title, 'Open budget · free');
  assert.match(byName.open_budget!.description!, /approved by the user in PayPal/);

  const pr = await client.callTool({ name: 'quote_lookup', arguments: { symbol: 'ACME' } });
  assert.equal(pr.isError, true);
  const p = json(pr);
  assert.equal(p.error, 'payment_required');
  assert.match(p.approval_url, /^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=/);

  // The buyer approves in PayPal and is sent back to /approved: MeterMCP re-reads the order and authorizes it.
  pp.approve(p.order_id);
  const page = await app(new Request(`${BASE}/approved?token=${p.order_id}&PayerID=XYZ`));
  assert.match(await page.text(), /Budget approved/);
  assert.equal(json(await client.callTool({ name: 'get_balance', arguments: {} })).status, 'active');

  const statuses = [];
  for (const [name, args] of [
    ['quote_lookup', { symbol: 'ACME' }],
    ['deep_report', { topic: 'agents' }],
    ['deep_report', { topic: 'agents' }],
    ['bulk_export', { dataset: 'quotes' }],
  ] as const) {
    const r = await client.callTool({ name, arguments: args });
    statuses.push(json(r).metering.status);
  }
  assert.deepEqual(statuses, ['OK', 'FAILED', 'OK', 'OK']);
  const closed = json(await client.callTool({ name: 'close_session', arguments: {} }));
  assert.equal(closed.status, 'settled');
  assert.equal(closed.captured, '1.37');
  const receipt = json(await client.callTool({ name: 'get_receipt', arguments: {} }));
  assert.equal(receipt.totals.charged, '1.37');

  // A second MCP client cannot see or close the first one's session.
  const other = await connect(fetch);
  assert.equal(json(await other.callTool({ name: 'get_balance', arguments: {} })).status, 'none');
  assert.equal(json(await other.callTool({ name: 'close_session', arguments: {} })).error, 'no_session');
  assert.equal(json(await other.callTool({ name: 'get_receipt', arguments: {} })).error, 'no_session');
  await other.close();
  await client.close();
  await app.close();
});

test('/approved and /cancelled trust PayPal, not the URL', async () => {
  const { app, pp, fetch } = setup();
  const client = await connect(fetch);
  const p = json(await client.callTool({ name: 'quote_lookup', arguments: { symbol: 'A' } }));
  // Not approved in PayPal: /approved does not open the session.
  assert.match(await (await app(new Request(`${BASE}/approved?token=${p.order_id}`))).text(), /Waiting for PayPal/);
  assert.equal(pp.count(/authorize$/), 0);
  assert.match(await (await app(new Request(`${BASE}/cancelled?token=${p.order_id}`))).text(), /Budget not approved/);
  assert.equal(json(await client.callTool({ name: 'get_balance', arguments: {} })).status, 'pending_approval');
  assert.match(await (await app(new Request(`${BASE}/approved?token=<script>`))).text(), /Unknown order/);
  await client.close();
  await app.close();
});

test('GET /approved for an active session with return_to redirects 303 to return_to; without it the page is unchanged', async () => {
  const { app, pp, fetch } = setup({ returnOrigins: ['https://resolvekit.example'] });
  const client = await connect(fetch);
  const ob = await client.callTool({ name: 'open_budget', arguments: { cap: '1.50', fail_first: ['deep_report'], return_to: 'https://resolvekit.example/agent?run=run-1' } });
  assert.equal(ob.isError, undefined, JSON.stringify(ob));
  const b = json(ob);
  assert.deepEqual([b.cap, b.fail_first, b.status], ['1.50', ['deep_report'], 'pending_approval']);
  // Not approved in PayPal yet: no redirect, the waiting page.
  const waiting = await app(new Request(`${BASE}/approved?token=${b.order_id}`));
  assert.equal(waiting.status, 200);
  assert.match(await waiting.text(), /Waiting for PayPal/);
  pp.approve(b.order_id);
  const res = await app(new Request(`${BASE}/approved?token=${b.order_id}&PayerID=XYZ`));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), 'https://resolvekit.example/agent?run=run-1');
  assert.equal(json(await client.callTool({ name: 'get_balance', arguments: {} })).status, 'active');
  // /cancelled never redirects.
  assert.match(await (await app(new Request(`${BASE}/cancelled?token=${b.order_id}`))).text(), /Budget approved/);
  // A session without return_to (payment_required, or a return_to not on the allowlist): the existing page.
  const other = await connect(fetch);
  const ob2 = json(await other.callTool({ name: 'open_budget', arguments: { cap: '1.00', return_to: 'https://evil.example/x' } }));
  pp.approve(ob2.order_id);
  const page = await app(new Request(`${BASE}/approved?token=${ob2.order_id}`));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Budget approved/);
  await other.close();
  await client.close();
  await app.close();
});

test('local mode: /agent/mcp is the same MCP endpoint as /mcp, without the admin token or a run id', async () => {
  const { app, fetch } = setup();
  const client = new Client({ name: 'resolvekit-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/agent/mcp`), { fetch }));
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes('open_budget') && names.includes('price_list'), names.join(','));
  // open_budget needs no demo code locally: it answers an approval URL.
  const b = json(await client.callTool({ name: 'open_budget', arguments: { cap: '1.00' } }));
  assert.equal(b.status, 'pending_approval');
  assert.match(b.approval_url, /^https:\/\//);
  // The session is shared with /mcp's table: the same id answers there too.
  const sid = (client.transport as StreamableHTTPClientTransport).sessionId!;
  const viaMcp = await app(new Request(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }) }));
  assert.equal(viaMcp.status, 200);
  await client.close();
  await app.close();
});
