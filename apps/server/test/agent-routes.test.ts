import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DailyCounters } from '@resolvekit/hosting';
import { standardCase } from '@resolvekit/cases';
import { PayPalClient } from '@resolvekit/paypal';
import { DEFAULT_LIMITS, type AgentModel, type MeterAnswer, type MeterConnection, type MeterTool, type ModelTurn } from '@resolvekit/agent';
import { createApi } from '../src/app.ts';
import { createHostedApp } from '../src/hosted.ts';
import { RunStore, type NewRun } from '../src/agent/runs.ts';
import { AgentService, RECONCILE_EVERY_MS } from '../src/agent/service.ts';
import { PersonRunCaps } from '../src/agent/person-caps.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STD_CAPTURE, TEST_SECRET, standardDispute, testAccounts } from './kit.ts';

const ORIGIN = 'https://rk.example.com';
const HOST = 'rk.example.com';
const CASE = standardCase.summary.id;
const ADMIN_TOKEN = 'ADMINTOKEN-'.padEnd(64, 'z');
const tick = () => new Promise((r) => setTimeout(r, 5));
async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------------------------------------
// A fake MeterMCP reached through each run's own connection: one budget per run, never approved.

const free = (name: string): MeterTool => ({ name, title: name, description: `${name} (free).`, price: null, inputSchema: { type: 'object', properties: {} } });
const TOOLS: MeterTool[] = [
  { name: 'quote_lookup', title: 'Quote', description: 'Look up a quote.', price: '0.05', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'], additionalProperties: false } },
  free('price_list'),
  free('get_balance'),
  free('open_budget'),
  free('close_session'),
  free('get_receipt'),
];

function fakeMeter() {
  const connects: string[] = [];
  const opened: string[] = [];
  const returnTo: unknown[] = [];
  const ok = (body: Record<string, any>): MeterAnswer => ({ isError: false, body });
  const connect = async (c: { url: string; headers: Record<string, string> }): Promise<MeterConnection> => {
    const run = c.headers['x-agent-run']!;
    connects.push(run);
    let session: string | null = null;
    return {
      async listTools() {
        return TOOLS;
      },
      async call(name, args) {
        if (name === 'open_budget') {
          session = `mm-${run.slice(-8)}`;
          opened.push(run);
          returnTo.push(args.return_to);
          return ok({ session_id: session, order_id: `ORDER-${session}`, approval_url: `https://paypal.example/checkoutnow?token=ORDER-${session}`, cap: args.cap, status: 'pending_approval' });
        }
        if (name === 'get_balance') return ok(session ? { session_id: session, status: 'pending_approval', cap: '1.00', remaining: '1.00' } : { status: 'none' });
        if (name === 'close_session') return ok({ status: 'cancelled', session_id: session });
        if (name === 'get_receipt') return ok({ session: { id: session }, mandate: { order_id: `ORDER-${session}` }, settlement: { status: 'not_approved', capture_id: null }, receipt_sha256: 'a'.repeat(64) });
        if (name === 'price_list') return ok({ tools: [{ name: 'quote_lookup', price: '0.05' }] });
        return { isError: true, body: { error: 'payment_required' } };
      },
      async close() {},
    };
  };
  return { connects, opened, returnTo, connect };
}

const USAGE = { inputTokens: 100, outputTokens: 10, reported: true };
const FINISH: ModelTurn = { calls: [{ name: 'finish', arguments: { outcome: 'done', answer: 'ACME is 412.37 USD', reason: 'done' } }], text: null, usage: USAGE };
const QUOTE: ModelTurn = { calls: [{ name: 'quote_lookup', arguments: { symbol: 'ACME', reason: 'the price' } }], text: null, usage: USAGE };

/** A model whose turns `plan` decides; `hold` (when set) keeps every turn waiting until it resolves. */
function controlledModel() {
  const c = { plan: (): ModelTurn => FINISH, hold: null as Promise<void> | null, asked: 0 };
  const model: AgentModel = {
    provider: 'gemini',
    model: 'gemini-test',
    async turn() {
      c.asked += 1;
      if (c.hold) await c.hold;
      return c.plan();
    },
  };
  return { c, model };
}
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

function agentService(o: { models?: 'none'; log: (l: string) => void }) {
  const mm = fakeMeter();
  const m = controlledModel();
  const store = new RunStore({ dir: null });
  const agent = new AgentService({
    store,
    models: o.models === 'none' ? null : { primary: m.model, fallback: null },
    meterUrl: 'http://metermcp.internal/agent/mcp',
    meterHeaders: (runId) => ({ 'x-metermcp-token': ADMIN_TOKEN, 'x-agent-run': runId }),
    meterAdmin: null,
    limits: DEFAULT_LIMITS,
    returnTo: (runId) => `${ORIGIN}/agent?run=${runId}`,
    log: o.log,
    connect: mm.connect,
  });
  return { agent, store, mm, model: m.c };
}

function setup(o: { agentRuns?: number; perPerson?: number; personCaps?: PersonRunCaps; models?: 'none' } = {}) {
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  const fetch = (async (url: string | URL) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
    return new Response(JSON.stringify(standardDispute()), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  const paypal = new PayPalClient({ clientId: 'cid', clientSecret: 'secret', env: 'sandbox', fetch });
  const s = agentService({ ...(o.models ? { models: o.models } : {}), log });
  const counters = new DailyCounters({ file: null, limits: { 'agent-run': o.agentRuns ?? 20 } });
  const people = testAccounts();
  const app = createHostedApp({
    paypal,
    env: 'sandbox',
    bindings: { [CASE]: { dispute: 'PP-R-REAL-1', capture: STD_CAPTURE } },
    log,
    site: null,
    counters,
    accounts: people.accounts,
    identity: null,
    sessionSecret: TEST_SECRET,
    origins: [ORIGIN],
    hosts: [HOST],
    https: true,
    agent: s.agent,
    ...(o.personCaps ? { agentRunsPerPerson: o.personCaps } : {}),
    ...(o.perPerson ? { agentRunsPerPerson: new PersonRunCaps({ file: null, limit: o.perPerson }) } : {}),
  });
  const call = async (path: string, i: { cookie?: string; body?: unknown; method?: string } = {}) => {
    const method = i.method ?? (i.body !== undefined ? 'POST' : 'GET');
    const headers: Record<string, string> = { host: HOST, 'x-forwarded-for': '203.0.113.7', ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/json' } : {}), ...(i.cookie ? { cookie: i.cookie } : {}) };
    const res = await app(new Request(ORIGIN + path, { method, headers, ...(i.body !== undefined ? { body: JSON.stringify(i.body) } : {}) }));
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as Record<string, any>, headers: res.headers };
  };
  const personId = (cookie: string) => app.personOf(new Request(ORIGIN + '/api/health', { headers: { host: HOST, cookie } }))!.id;
  return { app, call, people, counters, lines, personId, ...s };
}

const GOAL = { goal: 'Price ACME and summarise it', cap: '1.00' };
const finished = (store: RunStore, id: string) => until(() => !['running', 'awaiting_approval'].includes(store.get(id)!.state), `run ${id} to end`);

/** A record of another person, as if started earlier. */
function seeded(store: RunStore, by: NewRun['by']) {
  return store.create({
    finishedAt: new Date().toISOString(), by, goal: 'Theirs', cap: '1.00', failFirst: [], state: 'done', stopReason: null, answer: 'x', steps: [], approvalUrl: null, provider: 'gemini', model: 'gemini-test',
    usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1, reported: true }, sessionId: null, orderId: null, captureId: null, settlement: 'none', receiptSha256: null, kept: false,
  });
}

// ---------------------------------------------------------------------------------------------

test('a signed-in member starts a run and reads it back; another member gets 404 for it; the owner sees it only with scope=workspace, logged', async (t) => {
  const s = setup();
  t.after(() => s.agent.stop());
  const ana = s.people.member('Ana');
  const bea = s.people.member('Bea');

  const started = await s.call('/api/agent/runs', { cookie: ana, body: { ...GOAL, failFirst: ['quote_lookup'] } });
  assert.equal(started.status, 201, started.text);
  const id = started.body.run.id as string;
  assert.match(id, /^run-[0-9a-f]{32}$/);
  assert.deepEqual([started.body.run.goal, started.body.run.cap, started.body.run.failFirst, started.body.run.by.label], [GOAL.goal, '1.00', ['quote_lookup'], 'Ana']);
  await finished(s.store, id);

  const mine = await s.call(`/api/agent/runs/${id}`, { cookie: ana });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.run.state, 'done');
  assert.equal(mine.body.run.answer, 'ACME is 412.37 USD');
  assert.equal(mine.body.run.viewedAs, undefined);
  assert.deepEqual((await s.call('/api/agent/runs', { cookie: ana })).body.runs.map((r: any) => r.id), [id]);

  // Another member: cannot get, list, stop or keep it (compare reads runs through these same routes).
  assert.equal((await s.call(`/api/agent/runs/${id}`, { cookie: bea })).status, 404);
  assert.equal((await s.call(`/api/agent/runs/${id}?scope=workspace`, { cookie: bea })).status, 404);
  assert.deepEqual((await s.call('/api/agent/runs', { cookie: bea })).body.runs, []);
  assert.equal((await s.call('/api/agent/runs?scope=workspace', { cookie: bea })).status, 403);
  assert.equal((await s.call(`/api/agent/runs/${id}/stop`, { cookie: bea, body: {} })).status, 404);
  assert.equal((await s.call(`/api/agent/runs/${id}/stop?scope=workspace`, { cookie: bea, body: {} })).status, 404);
  assert.equal((await s.call(`/api/agent/runs/${id}/keep`, { cookie: bea, body: { kept: true } })).status, 403);
  // An id that does not exist answers the same as one that is not theirs.
  assert.equal((await s.call(`/api/agent/runs/run-${'0'.repeat(32)}`, { cookie: bea })).status, 404);

  // The owner: 404 without asking for the workspace's view; 200 with it, marked and logged.
  assert.equal((await s.call(`/api/agent/runs/${id}`, { cookie: s.people.ownerCookie })).status, 404);
  assert.deepEqual((await s.call('/api/agent/runs', { cookie: s.people.ownerCookie })).body.runs, []);
  const before = s.lines.length;
  const owner = await s.call(`/api/agent/runs/${id}?scope=workspace`, { cookie: s.people.ownerCookie });
  assert.equal(owner.status, 200);
  assert.equal(owner.body.run.viewedAs, 'owner');
  assert.equal(owner.body.run.id, id);
  const viewLog = s.lines.slice(before).filter((l) => l.includes(`agent run ${id}: viewed by the owner`));
  assert.equal(viewLog.length, 1);
  assert.ok(viewLog[0]!.includes('Northwind Goods'));
  const beforeList = s.lines.length;
  const list = await s.call('/api/agent/runs?scope=workspace', { cookie: s.people.ownerCookie });
  const listLog = s.lines.slice(beforeList).filter((l) => l.includes('(workspace list)'));
  assert.equal(listLog.length, 1);
  assert.ok(listLog[0]!.includes(id) && listLog[0]!.includes('viewed by the owner Northwind Goods'), listLog[0]);
  assert.deepEqual(list.body.runs.map((r: any) => [r.id, r.viewedAs]), [[id, 'owner']]);
});

test('a run of another workspace is 404 even for an owner with scope=workspace', async (t) => {
  const s = setup();
  t.after(() => s.agent.stop());
  const other = seeded(s.store, { personId: 'p-elsewhere', label: 'Elsewhere', workspaceId: 'ws-elsewhere' });
  assert.equal((await s.call(`/api/agent/runs/${other.id}?scope=workspace`, { cookie: s.people.ownerCookie })).status, 404);
  assert.equal((await s.call(`/api/agent/runs/${other.id}/keep`, { cookie: s.people.ownerCookie, body: { kept: true } })).status, 404);
  assert.equal((await s.call(`/api/agent/runs/${other.id}/stop?scope=workspace`, { cookie: s.people.ownerCookie, body: {} })).status, 404);
  assert.deepEqual((await s.call('/api/agent/runs?scope=workspace', { cookie: s.people.ownerCookie })).body.runs, []);
  assert.equal(s.store.get(other.id)!.kept, false);
});

test('signed out: 401 on every agent route', async (t) => {
  const s = setup();
  t.after(() => s.agent.stop());
  assert.equal((await s.call('/api/agent/runs', { body: GOAL })).status, 401);
  assert.equal((await s.call('/api/agent/runs')).status, 401);
  assert.equal((await s.call(`/api/agent/runs/run-${'0'.repeat(32)}`)).status, 401);
  assert.equal(s.mm.connects.length, 0);
});

test('invalid goal (empty, 301 chars) and invalid cap (0.49, 5.01, 1.234) are refused before anything is opened', async (t) => {
  const s = setup({ agentRuns: 20, perPerson: 5 });
  t.after(() => s.agent.stop());
  const ana = s.people.member('Ana');
  const bad: Array<[unknown, string]> = [
    [{ goal: '', cap: '1.00' }, 'INVALID_GOAL'],
    [{ goal: '   ', cap: '1.00' }, 'INVALID_GOAL'],
    [{ goal: 'a'.repeat(301), cap: '1.00' }, 'INVALID_GOAL'],
    [{ cap: '1.00' }, 'INVALID_GOAL'],
    [{ goal: 'ok', cap: '0.49' }, 'INVALID_CAP'],
    [{ goal: 'ok', cap: '5.01' }, 'INVALID_CAP'],
    [{ goal: 'ok', cap: '1.234' }, 'INVALID_CAP'],
    [{ goal: 'ok', cap: 1 }, 'INVALID_CAP'],
    [{ goal: 'ok', cap: '1.00', failFirst: 'deep_report' }, 'INVALID_FAIL_FIRST'],
  ];
  for (const [body, error] of bad) {
    const r = await s.call('/api/agent/runs', { cookie: ana, body });
    assert.deepEqual([r.status, r.body.error], [400, error], JSON.stringify(body));
    assert.equal(typeof r.body.detail, 'string');
  }
  // Nothing reserved, recorded or opened.
  assert.equal(s.counters.state().caps['agent-run']!.used, 0);
  assert.deepEqual(s.store.all(), []);
  assert.deepEqual(s.mm.connects, []);
  // The bounds themselves pass (300 characters, 0.50 and 5.00), and the per-person limit was not touched: 5 still fit.
  assert.equal((await s.call('/api/agent/runs', { cookie: ana, body: { goal: 'a'.repeat(300), cap: '0.50' } })).status, 201);
});

test('a double submit from the same person answers 409 RUN_IN_PROGRESS and opens no second MeterMCP session', async (t) => {
  const s = setup();
  const hold = gate();
  s.model.hold = hold.promise;
  t.after(async () => {
    hold.open();
    await s.agent.stop();
  });
  const ana = s.people.member('Ana');
  const [a, b] = await Promise.all([s.call('/api/agent/runs', { cookie: ana, body: GOAL }), s.call('/api/agent/runs', { cookie: ana, body: GOAL })]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [201, 409]);
  const refused = a.status === 409 ? a : b;
  assert.equal(refused.body.error, 'RUN_IN_PROGRESS');
  assert.equal(typeof refused.body.detail, 'string');
  await until(() => s.mm.connects.length === 1, 'the first run to connect');
  assert.equal(s.store.all().length, 1);
  assert.equal(s.mm.connects.length, 1);
  assert.deepEqual(s.mm.opened, []);
  // The refusal gave its daily unit back.
  assert.equal(s.counters.state().caps['agent-run']!.used, 1);
});

test('the daily agent-run cap and the per-person cap answer 429 and are released when start refuses', async (t) => {
  // Per person: 2 a day. A refused start (409) gives both units back.
  const s = setup({ agentRuns: 3, perPerson: 2 });
  const hold = gate();
  s.model.hold = hold.promise;
  t.after(async () => {
    hold.open();
    await s.agent.stop();
  });
  const ana = s.people.member('Ana');
  const first = await s.call('/api/agent/runs', { cookie: ana, body: GOAL });
  assert.equal(first.status, 201);
  assert.equal((await s.call('/api/agent/runs', { cookie: ana, body: GOAL })).status, 409);
  assert.equal(s.counters.state().caps['agent-run']!.used, 1);
  hold.open();
  await finished(s.store, first.body.run.id);
  assert.equal((await s.call('/api/agent/runs', { cookie: ana, body: GOAL })).status, 201);
  await until(() => s.agent.store.all().every((r) => r.state !== 'running'), 'the second run to end');
  const person = await s.call('/api/agent/runs', { cookie: ana, body: GOAL });
  assert.equal(person.status, 429);
  assert.equal(person.body.error, 'PERSON_CAP');
  assert.ok(person.body.retryAfterSec > 0 && person.body.retryAfterSec <= 86_400);
  assert.equal(person.headers.get('retry-after'), String(person.body.retryAfterSec));
  // The person's refusal did not use a daily unit.
  assert.equal(s.counters.state().caps['agent-run']!.used, 2);

  // Daily: the third unit goes to another member; then everyone gets 429 DAILY_CAP.
  const bea = s.people.member('Bea');
  const third = await s.call('/api/agent/runs', { cookie: bea, body: GOAL });
  assert.equal(third.status, 201);
  await finished(s.store, third.body.run.id);
  const daily = await s.call('/api/agent/runs', { cookie: s.people.member('Cal'), body: GOAL });
  assert.equal(daily.status, 429);
  assert.equal(daily.body.error, 'DAILY_CAP');
  assert.match(daily.body.detail, /3 agent runs per day/);
  assert.equal(daily.body.resetsAt, s.counters.state().resetsAt);
});

test('a start the service refuses (no model) answers 503 MODEL_UNAVAILABLE and gives both units back', async (t) => {
  const s = setup({ agentRuns: 1, perPerson: 1, models: 'none' });
  t.after(() => s.agent.stop());
  const ana = s.people.member('Ana');
  for (let i = 0; i < 3; i++) {
    const r = await s.call('/api/agent/runs', { cookie: ana, body: GOAL });
    assert.deepEqual([r.status, r.body.error], [503, 'MODEL_UNAVAILABLE']);
    assert.equal(typeof r.body.detail, 'string');
  }
  assert.equal(s.counters.state().caps['agent-run']!.used, 0);
  assert.deepEqual(s.mm.connects, []);
});

test('keep is owner-only', async (t) => {
  const s = setup();
  t.after(() => s.agent.stop());
  const ana = s.people.member('Ana');
  const id = (await s.call('/api/agent/runs', { cookie: ana, body: GOAL })).body.run.id as string;
  await finished(s.store, id);
  // The author, a member, cannot keep their own run.
  const own = await s.call(`/api/agent/runs/${id}/keep`, { cookie: ana, body: { kept: true } });
  assert.deepEqual([own.status, own.body.error], [403, 'OWNER_ONLY']);
  assert.equal(s.store.get(id)!.kept, false);
  // The owner can, with or without scope; a malformed body is 400.
  assert.equal((await s.call(`/api/agent/runs/${id}/keep`, { cookie: s.people.ownerCookie, body: { kept: 'yes' } })).status, 400);
  const kept = await s.call(`/api/agent/runs/${id}/keep`, { cookie: s.people.ownerCookie, body: { kept: true } });
  assert.equal(kept.status, 200);
  // Only the flag, never the run: keep is no way around the explicit workspace view.
  assert.deepEqual(kept.body, { id, kept: true });
  assert.equal(s.store.get(id)!.kept, true);
  assert.equal((await s.call(`/api/agent/runs/${id}/keep?scope=workspace`, { cookie: s.people.ownerCookie, body: { kept: false } })).status, 200);
  assert.equal(s.store.get(id)!.kept, false);
  assert.ok(s.lines.some((l) => l.includes(`agent run ${id}: kept by the owner`)));
});

test('the author stops a run waiting for approval: it ends interrupted; the owner may stop only with scope=workspace', async (t) => {
  const s = setup();
  t.after(() => s.agent.stop());
  s.model.plan = () => QUOTE;
  const ana = s.people.member('Ana');
  const id = (await s.call('/api/agent/runs', { cookie: ana, body: GOAL })).body.run.id as string;
  await until(() => s.store.get(id)!.state === 'awaiting_approval', 'the approval wait');
  assert.equal((await s.call(`/api/agent/runs/${id}/stop`, { cookie: s.people.ownerCookie, body: {} })).status, 404);
  const stopped = await s.call(`/api/agent/runs/${id}/stop`, { cookie: ana, body: {} });
  assert.equal(stopped.status, 202);
  await finished(s.store, id);
  assert.equal(s.store.get(id)!.state, 'interrupted');
  assert.equal((await s.call(`/api/agent/runs/${id}/stop`, { cookie: ana, body: {} })).status, 409);

  // The owner, explicitly: another run of Bea's, stopped through the workspace's view (logged).
  const bea = s.people.member('Bea');
  const other = (await s.call('/api/agent/runs', { cookie: bea, body: GOAL })).body.run.id as string;
  await until(() => s.store.get(other)!.state === 'awaiting_approval', 'the approval wait');
  assert.equal((await s.call(`/api/agent/runs/${other}/stop?scope=workspace`, { cookie: s.people.ownerCookie, body: {} })).status, 202);
  await finished(s.store, other);
  assert.equal(s.store.get(other)!.state, 'interrupted');
  assert.ok(s.lines.some((l) => l.includes(`agent run ${other}: stopped by the owner`)));
});

test('PublicRun never carries personId, approval tokens or secrets; the approval link is the author’s only', async (t) => {
  const s = setup();
  t.after(() => s.agent.stop());
  s.model.plan = () => QUOTE;
  const ana = s.people.member('Ana');
  const anaId = s.personId(ana);
  const started = await s.call('/api/agent/runs', { cookie: ana, body: GOAL });
  const id = started.body.run.id as string;
  await until(() => s.store.get(id)!.state === 'awaiting_approval', 'the approval wait');
  assert.ok(s.store.get(id)!.by.personId === anaId);

  const author = await s.call(`/api/agent/runs/${id}`, { cookie: ana });
  assert.equal(author.body.run.state, 'awaiting_approval');
  assert.match(author.body.run.approvalUrl, /^https:\/\/paypal\.example\/checkoutnow\?token=/);
  const owner = await s.call(`/api/agent/runs/${id}?scope=workspace`, { cookie: s.people.ownerCookie });
  assert.equal('approvalUrl' in owner.body.run, false);
  // Ruling A10: the order id (the approval link's token) and the session id are the author's only.
  assert.ok(author.body.run.orderId && author.body.run.sessionId);
  assert.equal('orderId' in owner.body.run, false);
  assert.equal('sessionId' in owner.body.run, false);
  assert.ok(!owner.text.includes(author.body.run.orderId) && !owner.text.includes(author.body.run.sessionId));
  assert.ok(!owner.text.includes('checkoutnow'));
  const ownerList = await s.call('/api/agent/runs?scope=workspace', { cookie: s.people.ownerCookie });
  assert.ok(!ownerList.text.includes('checkoutnow'));
  assert.ok(!ownerList.text.includes(author.body.run.orderId) && !ownerList.text.includes(author.body.run.sessionId));

  for (const r of [started, author, owner, ownerList, await s.call('/api/agent/runs', { cookie: ana })]) {
    assert.ok(!r.text.includes('personId'), r.text);
    assert.ok(!r.text.includes(anaId), r.text);
    assert.ok(!r.text.includes(ADMIN_TOKEN));
    assert.ok(!r.text.includes('x-metermcp-token'));
  }
  assert.ok(!s.lines.join('\n').includes(ADMIN_TOKEN));
  assert.deepEqual(Object.keys(author.body.run.by).sort(), ['label', 'workspaceId']);
  // The return URL PayPal sends the buyer back to names the run.
  assert.deepEqual(s.mm.returnTo, [`${ORIGIN}/agent?run=${id}`]);
  await s.call(`/api/agent/runs/${id}/stop`, { cookie: ana, body: {} });
  await finished(s.store, id);
});

test('local mode: the operator starts and reads runs, with no caps', async (t) => {
  const lines: string[] = [];
  const s = agentService({ log: (l) => lines.push(l) });
  t.after(() => s.agent.stop());
  const api = createApi({ paypal: null, env: 'sandbox', bindings: {}, agent: s.agent, log: (l) => lines.push(l) });
  const post = (body: unknown) => api(new Request('http://127.0.0.1:8787/api/agent/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const r = await post(GOAL);
  assert.equal(r.status, 201);
  const run = ((await r.json()) as any).run;
  assert.equal(run.by.label, 'local operator');
  await finished(s.store, run.id);
  const again = await post(GOAL);
  assert.equal(again.status, 201);
  const list = (await (await api(new Request('http://127.0.0.1:8787/api/agent/runs'))).json()) as any;
  assert.equal(list.runs.length, 2);
  // No agent service: 503.
  const none = createApi({ paypal: null, env: 'sandbox', bindings: {} });
  assert.equal((await none(new Request('http://127.0.0.1:8787/api/agent/runs'))).status, 503);
});

test('the per-person agent-run count survives a restart: a new instance over the same file keeps it, and fails closed on an unreadable file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-caps-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'agent-run-caps.json');
  let at = Date.parse('2026-10-18T10:00:00Z');
  const now = () => new Date(at);
  const a = new PersonRunCaps({ file, limit: 2, now });
  const first = a.take('p-ana');
  assert.ok(first.ok);
  assert.ok(a.take('p-ana').ok);
  assert.ok(a.take('p-bea').ok);
  // The same day after a restart: Ana is at her limit; Bea has one left; a release on the new instance counts.
  const b = new PersonRunCaps({ file, limit: 2, now });
  assert.deepEqual([b.used('p-ana'), b.used('p-bea')], [2, 1]);
  const refused = b.take('p-ana');
  assert.ok(!refused.ok && refused.reason === 'cap' && refused.retryAfterSec === 14 * 3600);
  if (first.ok) b.release('p-ana', first.day);
  assert.equal(new PersonRunCaps({ file, limit: 2, now }).used('p-ana'), 1);
  // The next UTC day starts at zero.
  at = Date.parse('2026-10-19T00:00:01Z');
  assert.equal(new PersonRunCaps({ file, limit: 2, now }).used('p-ana'), 0);
  // A file that is there but unreadable refuses (storage) and is not overwritten.
  writeFileSync(file, '{not json');
  const c = new PersonRunCaps({ file, limit: 2, now });
  const broken = c.take('p-cal');
  assert.ok(!broken.ok && broken.reason === 'storage');
});

test('hosted: an unreadable per-person caps file refuses a run with 503 CAPS_UNAVAILABLE and gives the daily unit back', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-caps-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'agent-run-caps.json');
  writeFileSync(file, '{not json');
  const s = setup({ personCaps: new PersonRunCaps({ file, limit: 5 }) });
  t.after(() => s.agent.stop());
  const r = await s.call('/api/agent/runs', { cookie: s.people.member('Ana'), body: GOAL });
  assert.deepEqual([r.status, r.body.error], [503, 'CAPS_UNAVAILABLE']);
  assert.equal(s.counters.state().caps['agent-run']!.used, 0);
  assert.deepEqual(s.store.all(), []);
});

test('the reconcile sweep runs every 5 minutes', () => {
  assert.equal(RECONCILE_EVERY_MS, 5 * 60_000);
});
