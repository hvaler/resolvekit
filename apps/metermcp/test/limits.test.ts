/**
 * M2: live MCP sessions are capped (in all and per client IP), idle ones expire (transport freed, payment session
 * closed), and the counters show on /health. Fake PayPal only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { Ledger } from '../src/ledger.ts';
import { Meter } from '../src/meter.ts';
import { fakePayPal } from './fakePayPal.ts';

const BASE = 'http://127.0.0.1:8790';
const TOKEN = 'a'.repeat(64);

function setup(limits: { maxSessions: number; maxPerIp: number; idleMs: number }) {
  let t = Date.UTC(2026, 9, 9, 8, 0, 0);
  const pp = fakePayPal();
  const ledger = new Ledger(':memory:');
  const meter = new Meter({ ledger, paypal: pp.client, env: 'sandbox', publicUrl: BASE });
  const app = createApp({ meter, env: 'sandbox', port: 8790, token: TOKEN, allowedOrigins: [], mcpLimits: { ...limits, now: () => t } });
  return { app, pp, ledger, meter, advance: (ms: number) => void (t += ms) };
}

const init = (app: ReturnType<typeof setup>['app']) =>
  app(
    new Request(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'flood', version: '1' } } }),
    }),
  );
const health = async (app: ReturnType<typeof setup>['app']) => (await (await app(new Request(`${BASE}/health`))).json()) as { mcpSessions: number; mcpRejected: number; mcpExpired: number };

test('M2: repeated initializations never exceed the cap; refusals are counted', async () => {
  const { app } = setup({ maxSessions: 5, maxPerIp: 5, idleMs: 60_000 });
  const statuses: number[] = [];
  for (let k = 0; k < 12; k++) statuses.push((await init(app)).status);
  assert.equal(statuses.filter((s) => s === 200).length, 5);
  assert.equal(statuses.filter((s) => s === 503).length, 7);
  const h = await health(app);
  assert.deepEqual([h.mcpSessions, h.mcpRejected], [5, 7]);
});

test('M2: concurrent initializations cannot overshoot the cap (the slot is reserved before setup)', async () => {
  const { app } = setup({ maxSessions: 4, maxPerIp: 4, idleMs: 60_000 });
  const all = await Promise.all(Array.from({ length: 20 }, () => init(app)));
  assert.equal(all.filter((r) => r.status === 200).length, 4);
  assert.equal((await health(app)).mcpSessions, 4);
});

test('M2: idle sessions expire, freeing room; new sessions work after expiry; an idle session’s payment session is closed', async () => {
  const { app, pp, ledger, advance } = setup({ maxSessions: 2, maxPerIp: 2, idleMs: 60_000 });
  const a = await init(app);
  const sid = a.headers.get('mcp-session-id')!;
  // This MCP session asks for a budget (a pending PayPal order): its payment session exists.
  const call = await app(
    new Request(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sid, 'mcp-protocol-version': '2025-03-26' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'quote_lookup', arguments: { symbol: 'A' } } }),
    }),
  );
  assert.equal(call.status, 200);
  assert.equal(pp.orders.size, 1);
  assert.equal((await init(app)).status, 200);
  assert.equal((await init(app)).status, 503);
  advance(61_000);
  // The next initialization sweeps the idle ones first: room again.
  assert.equal((await init(app)).status, 200);
  const h = await health(app);
  assert.deepEqual([h.mcpSessions, h.mcpExpired], [1, 2]);
  // The expired session is gone, and its never-approved payment session was closed (cancelled, nothing held).
  const gone = await app(new Request(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'mcp-session-id': sid }, body: '{}' }));
  assert.equal(gone.status, 404);
  assert.equal(ledger.sessionsWithStatus('cancelled').length, 1);
});

test('M2: the per-IP cap holds in hosted-style use (one address cannot take every slot)', async () => {
  const { app } = setup({ maxSessions: 10, maxPerIp: 3, idleMs: 60_000 });
  const statuses: number[] = [];
  for (let k = 0; k < 6; k++) statuses.push((await init(app)).status);
  // Local mode: every request is the same client ("local").
  assert.equal(statuses.filter((s) => s === 200).length, 3);
});

test('M2: the sweep the server runs on a timer also frees idle sessions', async () => {
  const { app, advance } = setup({ maxSessions: 3, maxPerIp: 3, idleMs: 1_000 });
  await init(app);
  await init(app);
  advance(2_000);
  assert.equal((await app.sweepMcp()).length, 2);
  assert.equal(app.metrics().live, 0);
});
