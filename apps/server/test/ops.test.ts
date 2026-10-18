import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { DailyCounters } from '@resolvekit/hosting';
import { standardCase } from '@resolvekit/cases';
import { PayPalClient, type Dispute } from '@resolvekit/paypal';
import { DEFAULT_LIMITS } from '@resolvekit/agent';
import { createHostedApp } from '../src/hosted.ts';
import { RunStore, type RunRecord } from '../src/agent/runs.ts';
import { AgentService } from '../src/agent/service.ts';
import type { Receipt } from '../src/metermcp.ts';
import { STD_CAPTURE, TEST_SECRET, standardDispute, testAccounts } from './kit.ts';

const ORIGIN = 'https://rk.example.com';
const HOST = 'rk.example.com';
const CASE = standardCase.summary.id;
const BOUND = 'PP-R-REAL-1';
const OPS = 'o'.repeat(20) + '0123456789abcdef';

/** PayPal: every dispute read answers `dispute()`; reads recorded. */
function paypal(dispute: () => Dispute = () => ({ ...standardDispute(), dispute_id: BOUND })) {
  const calls: string[] = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
    calls.push(`${init.method ?? 'GET'} ${u.pathname}`);
    return new Response(JSON.stringify(dispute()), { status: 200 });
  }) as typeof globalThis.fetch;
  return { calls, client: new PayPalClient({ clientId: 'cid', clientSecret: 'secret', env: 'sandbox', fetch }) };
}

function setup(o: { ops?: string | null; webhook?: boolean; dispute?: () => Dispute; probes?: Array<{ name: string; probe: () => Promise<void> }>; counters?: DailyCounters } = {}) {
  const pp = paypal(o.dispute);
  const app = createHostedApp({
    paypal: pp.client,
    env: 'sandbox',
    bindings: { [CASE]: { dispute: BOUND, capture: STD_CAPTURE } },
    log: () => {},
    counters: o.counters ?? new DailyCounters({ file: null, limits: { 'live-analysis': 5 } }),
    site: null,
    accounts: testAccounts().accounts,
    identity: null,
    sessionSecret: TEST_SECRET,
    origins: [ORIGIN],
    hosts: [HOST],
    https: true,
    webhook: o.webhook === false ? null : { id: 'WEBHOOK0123456789', key: 'k'.repeat(40) },
    opsToken: o.ops === undefined ? OPS : o.ops,
    ...(o.probes ? { modelProbes: o.probes } : {}),
  });
  return { app, pp };
}

/** The check as the demo:check script makes it: no Origin, no cookie, a bearer token. */
const status = (token?: string, query = '') =>
  new Request(`${ORIGIN}/api/ops/status${query}`, { headers: { host: HOST, 'x-forwarded-for': '203.0.113.9', ...(token ? { authorization: `Bearer ${token}` } : {}) } });

type Status = {
  ok: boolean;
  problems: string[];
  paypal: string;
  webhook: 'on' | 'off';
  bindings: Record<string, { dispute: string; capture: string | null; status: string; reasons: string[] }>;
  warmUp: Array<{ caseId: string; outcome: string; detail: string }> | null;
  models: Array<{ name: string; ok: boolean; error?: string }> | null;
};

test('without RESOLVEKIT_OPS_TOKEN the ops route does not exist', async () => {
  const { app } = setup({ ops: null });
  assert.equal((await app(status(OPS))).status, 404);
});

test('a missing or wrong token answers 404, like an unconfigured route', async () => {
  const { app, pp } = setup();
  assert.equal((await app(status())).status, 404);
  assert.equal((await app(status('x'.repeat(36)))).status, 404);
  assert.deepEqual(pp.calls, []);
});

test('with the token: PayPal, the webhook and each binding verified on a fresh read', async () => {
  const { app, pp } = setup();
  const r = await app(status(OPS));
  assert.equal(r.status, 200);
  const s = (await r.json()) as Status;
  assert.equal(s.paypal, 'sandbox');
  assert.equal(s.webhook, 'on');
  assert.equal(s.bindings[CASE]!.dispute, BOUND);
  assert.equal(s.bindings[CASE]!.status, 'verified');
  assert.ok(pp.calls.includes(`GET /v1/customer/disputes/${BOUND}`));
});

test('each call reads PayPal again (a binding is checked now, not remembered)', async () => {
  const { app, pp } = setup();
  await app(status(OPS));
  await app(status(OPS));
  assert.equal(pp.calls.filter((c) => c === `GET /v1/customer/disputes/${BOUND}`).length, 2);
});

test('a binding to the wrong payment is a problem, with PayPal’s reasons', async () => {
  const other = standardDispute();
  const { app } = setup({ dispute: () => ({ ...other, dispute_id: BOUND, disputed_transactions: [{ ...other.disputed_transactions![0]!, seller_transaction_id: 'SOMEOTHERCAPTURE' }] }) });
  const s = (await (await app(status(OPS))).json()) as Status;
  assert.equal(s.bindings[CASE]!.status, 'invalid');
  assert.ok(s.bindings[CASE]!.reasons.length > 0);
  assert.equal(s.ok, false);
  assert.ok(s.problems.some((p) => p.includes(CASE)), s.problems.join(' | '));
});

test('the webhook off is a problem', async () => {
  const { app } = setup({ webhook: false });
  const s = (await (await app(status(OPS))).json()) as Status;
  assert.equal(s.webhook, 'off');
  assert.equal(s.ok, false);
  assert.ok(s.problems.some((p) => /webhook/i.test(p)), s.problems.join(' | '));
});

test('the last warm-up is reported, and a case it could not analyse is a problem', async () => {
  const { app } = setup();
  assert.equal(((await (await app(status(OPS))).json()) as Status).warmUp, null);
  await app.warmUp();
  const s = (await (await app(status(OPS))).json()) as Status;
  assert.deepEqual(s.warmUp!.map((w) => [w.caseId, w.outcome]), [[CASE, 'skipped']]);
  assert.equal(s.ok, false);
  assert.ok(s.problems.some((p) => p.includes('warm-up') && p.includes(CASE)), s.problems.join(' | '));
});

test('all good: ok, no problems', async () => {
  const { app } = setup();
  const s = (await (await app(status(OPS))).json()) as Status;
  assert.deepEqual(s.problems, []);
  assert.equal(s.ok, true);
});

test('models are probed only when asked (?probe=models), each provider on its own', async () => {
  let calls = 0;
  const probes = [
    { name: 'gemini/gemini-3.8-flash', probe: async () => void calls++ },
    { name: 'groq/openai/gpt-oss-120b', probe: async () => (calls++, Promise.reject(new Error('groq answered 401 invalid_api_key'))) },
  ];
  const { app } = setup({ probes });
  const plain = (await (await app(status(OPS))).json()) as Status;
  assert.equal(plain.models, null);
  assert.equal(calls, 0);
  const s = (await (await app(status(OPS, '?probe=models'))).json()) as Status;
  assert.equal(calls, 2);
  assert.deepEqual(s.models!.map((m) => [m.name, m.ok]), [['gemini/gemini-3.8-flash', true], ['groq/openai/gpt-oss-120b', false]]);
  assert.match(s.models![1]!.error!, /401 invalid_api_key/);
  assert.equal(s.ok, false);
  assert.ok(s.problems.some((p) => p.includes('groq/openai/gpt-oss-120b')), s.problems.join(' | '));
});

test('asked to probe with no model configured: a problem', async () => {
  const { app } = setup({ probes: [] });
  const s = (await (await app(status(OPS, '?probe=models'))).json()) as Status;
  assert.deepEqual(s.models, []);
  assert.ok(s.problems.some((p) => /no AI model/i.test(p)), s.problems.join(' | '));
});

test('daily caps that cannot be persisted are a problem (costly actions are refused meanwhile)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-ops-'));
  try {
    const file = join(dir, 'caps.json');
    writeFileSync(file, '{ not json');
    const { app } = setup({ counters: new DailyCounters({ file, limits: { 'live-analysis': 5 } }) });
    const s = (await (await app(status(OPS))).json()) as Status;
    assert.equal(s.ok, false);
    assert.ok(s.problems.some((p) => /daily caps file is unreadable/.test(p)), s.problems.join(' | '));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// GET /api/ops/agent-run/:id: a run as demo:prepare --agent-run reads it, with its receipt.

const RUN_ID = `run-${'a'.repeat(32)}`;
const SESSION_ID = `mm-sess-${'b'.repeat(32)}`;

function agentSetup(o: { receipt?: () => Promise<Receipt> } = {}) {
  const store = new RunStore({ dir: null });
  const meterCalls: string[] = [];
  const meterMcp = {
    findByCapture: async () => (meterCalls.push('findByCapture'), null),
    receipt: async (id: string) => (meterCalls.push(`receipt ${id}`), o.receipt ? o.receipt() : ({ session: { id }, receipt_sha256: 'c'.repeat(64) } as unknown as Receipt)),
    receiptPdf: async () => (meterCalls.push('receiptPdf'), new Uint8Array()),
  };
  const agent = new AgentService({
    store, models: null, meterUrl: 'http://metermcp.internal/agent/mcp', meterHeaders: () => ({}), meterAdmin: null, limits: DEFAULT_LIMITS, returnTo: () => undefined, log: () => {},
    connect: async () => { throw new Error('the ops route never connects to MeterMCP'); },
  });
  const people = testAccounts();
  const pp = paypal();
  const app = createHostedApp({
    paypal: pp.client, env: 'sandbox', bindings: {}, log: () => {}, counters: new DailyCounters({ file: null, limits: {} }), site: null,
    accounts: people.accounts, identity: null, sessionSecret: TEST_SECRET, origins: [ORIGIN], hosts: [HOST], https: true, opsToken: OPS, agent, meterMcp,
  });
  const rec = store.create({
    finishedAt: new Date().toISOString(), by: { personId: 'p1', label: 'Ana', workspaceId: 'w1' }, goal: 'Quote', cap: '1.00', failFirst: [], state: 'done', stopReason: null, answer: 'x',
    steps: [], approvalUrl: null, provider: 'gemini', model: 'gemini-test', usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1, reported: true },
    sessionId: SESSION_ID, orderId: 'ORDER1', captureId: '7AG12345BC678901D', settlement: 'captured', receiptSha256: 'c'.repeat(64), captured: '0.05', released: '0.95', kept: false,
  });
  return { app, rec, store, meterCalls, people };
}

const agentRun = (id: string, o: { token?: string; cookie?: string; method?: string } = {}) =>
  new Request(`${ORIGIN}/api/ops/agent-run/${id}`, {
    method: o.method ?? 'GET',
    headers: { host: HOST, 'x-forwarded-for': '203.0.113.9', ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.cookie ? { cookie: o.cookie } : {}) },
  });

test('ops agent-run: 404 without a valid ops token (missing or wrong), like /api/ops/status, also for a signed-in person; nothing read', async () => {
  const s = agentSetup();
  assert.equal((await s.app(agentRun(s.rec.id))).status, 404);
  assert.equal((await s.app(agentRun(s.rec.id, { token: 'x'.repeat(36) }))).status, 404);
  assert.equal((await s.app(agentRun(s.rec.id, { cookie: s.people.ownerCookie }))).status, 404);
  assert.equal((await s.app(agentRun(s.rec.id, { cookie: s.people.member() }))).status, 404);
  assert.deepEqual(s.meterCalls, []);
});

test('ops agent-run: without RESOLVEKIT_OPS_TOKEN the route does not exist', async () => {
  const pp = paypal();
  const app = createHostedApp({
    paypal: pp.client, env: 'sandbox', bindings: {}, log: () => {}, counters: new DailyCounters({ file: null, limits: {} }), site: null,
    accounts: testAccounts().accounts, identity: null, sessionSecret: TEST_SECRET, origins: [ORIGIN], hosts: [HOST], https: true, opsToken: null,
  });
  assert.equal((await app(agentRun(RUN_ID, { token: OPS }))).status, 404);
});

test('ops agent-run: the full run record and its receipt read through MeterMCP’s admin route', async () => {
  const s = agentSetup();
  const r = await s.app(agentRun(s.rec.id, { token: OPS }));
  assert.equal(r.status, 200);
  const body = (await r.json()) as { run: RunRecord; receipt: { session: { id: string } }; receiptError: string | null };
  assert.deepEqual(body.run, s.store.get(s.rec.id));
  assert.equal(body.receipt.session.id, SESSION_ID);
  assert.equal(body.receiptError, null);
  assert.deepEqual(s.meterCalls, [`receipt ${SESSION_ID}`]);
});

test('ops agent-run: an unknown id is 404, a malformed one 400, only GET; an unreadable receipt is said, not invented', async () => {
  const s = agentSetup({ receipt: async () => { throw new Error('MeterMCP unreachable'); } });
  assert.equal((await s.app(agentRun(`run-${'f'.repeat(32)}`, { token: OPS }))).status, 404);
  for (const bad of ['run-123', 'run-..%2F..%2Fx', `RUN-${'a'.repeat(32)}`, `${RUN_ID}/x`]) assert.equal((await s.app(agentRun(bad, { token: OPS }))).status, 400, bad);
  assert.equal((await s.app(agentRun(s.rec.id, { token: OPS, method: 'DELETE' }))).status, 405);
  const r = (await (await s.app(agentRun(s.rec.id, { token: OPS }))).json()) as { receipt: unknown; receiptError: string };
  assert.equal(r.receipt, null);
  assert.match(r.receiptError, /MeterMCP unreachable/);
});
