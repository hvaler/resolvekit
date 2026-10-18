import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentModelsFromEnv, DEFAULT_LIMITS, type AgentModel, type MeterAnswer, type MeterConnection, type MeterTool, type ModelCall, type ModelTurn, type Step } from '@resolvekit/agent';
import { MeterMcpClient } from '../src/metermcp.ts';
import { RunStore, type RunRecord } from '../src/agent/runs.ts';
import { AgentService, MAX_RUNNING, MAX_RUNNING_PER_PERSON, RECOVERED_SUMMARY, type MeterAdmin } from '../src/agent/service.ts';

const ADMIN_TOKEN = 'ADMINTOKEN-'.padEnd(64, 'z');
const GEMINI_KEY = 'GEMINIKEY-0123456789-secret';
const GROQ_KEY = 'GROQKEY-0123456789-secret';
const BY = { personId: 'p-ana', label: 'Ana', workspaceId: 'ws-1' };
const T0 = Date.parse('2026-10-18T10:00:00Z');
const RUN_RE = /^run-[0-9a-f]{32}$/;

const tmp = () => mkdtempSync(join(tmpdir(), 'agent-runs-'));
const tick = () => new Promise((r) => setTimeout(r, 5));
async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${what}`);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// ---------------------------------------------------------------------------------------------
// A fake MeterMCP: one session per run (as /agent/mcp binds it to x-agent-run), reachable both through the run's
// MCP connection and through the admin routes, so recovery and the sweep act on the same state.

const PRICES: Record<string, string> = { quote_lookup: '0.05', deep_report: '0.40' };
const free = (name: string): MeterTool => ({ name, title: name, description: `${name} (free).`, price: null, inputSchema: { type: 'object', properties: {} } });
const TOOLS: MeterTool[] = [
  { name: 'quote_lookup', title: 'Quote', description: 'Look up a quote.', price: '0.05', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'], additionalProperties: false } },
  { name: 'deep_report', title: 'Report', description: 'Write a report.', price: '0.40', inputSchema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'], additionalProperties: false } },
  free('price_list'),
  free('get_balance'),
  free('open_budget'),
  free('close_session'),
  free('get_receipt'),
];
const cents = (s: string) => Math.round(Number(s) * 100);
const usd = (c: number) => (c / 100).toFixed(2);

interface FakeSession {
  id: string;
  run: string;
  status: string;
  capCents: number;
  usedCents: number;
  captureId: string | null;
}

function fakeMeterMcp(o: { autoApprove?: boolean; duringCall?: (tool: string) => void | Promise<void> } = {}) {
  const sessions = new Map<string, FakeSession>();
  const paid: string[] = [];
  const mcp: Array<{ run: string; name: string }> = [];
  const connects: Array<{ url: string; headers: Record<string, string> }> = [];
  let n = 0;
  const ok = (body: Record<string, any>): MeterAnswer => ({ isError: false, body });
  const err = (body: Record<string, any>): MeterAnswer => ({ isError: true, body });
  const SETTLE: Record<string, string> = { pending_approval: 'not_approved', cancelled: 'not_approved', active: 'open', settled: 'captured', voided: 'voided', capture_pending: 'capture_pending' };
  const closeSession = (s: FakeSession) => {
    if (s.status === 'pending_approval') s.status = 'cancelled';
    else if (s.status === 'active') {
      if (s.usedCents > 0) {
        s.status = 'settled';
        s.captureId = `CAP${s.id.slice(-4).toUpperCase()}`;
      } else s.status = 'voided';
    }
  };
  const receiptOf = (s: FakeSession) => ({
    kind: 'metermcp.session_receipt',
    session: { id: s.id, status: s.status },
    mandate: { order_id: `ORDER-${s.id}`, cap: usd(s.capCents) },
    totals: { charged: usd(s.usedCents) },
    settlement: { status: SETTLE[s.status] ?? 'failed', capture_id: s.captureId },
    receipt_sha256: `${s.id.slice(-1)}`.repeat(64),
  });

  const admin: MeterAdmin & { closes: string[]; reconciles: string[]; receipts: number; receiptFails: boolean; closeGate: Promise<void> | null } = {
    closes: [],
    reconciles: [],
    receipts: 0,
    receiptFails: false,
    closeGate: null,
    async close(id) {
      admin.closes.push(id);
      if (admin.closeGate) await admin.closeGate;
      const s = sessions.get(id);
      if (!s) throw new Error('MeterMCP answered 404');
      closeSession(s);
      return { status: s.status, session_id: s.id };
    },
    async reconcile(id) {
      admin.reconciles.push(id);
      const s = sessions.get(id);
      if (!s) throw new Error('MeterMCP answered 404');
      if (s.status === 'capture_pending') s.status = 'settled';
      return { session_id: s.id, status: s.status, capture_id: s.captureId, capture_status: 'COMPLETED' };
    },
    async receipt(id) {
      admin.receipts += 1;
      const s = sessions.get(id);
      if (admin.receiptFails || !s) throw new Error('MeterMCP unreachable');
      return receiptOf(s) as any;
    },
  };

  async function connect(c: { url: string; headers: Record<string, string> }): Promise<MeterConnection> {
    connects.push(c);
    const run = c.headers['x-agent-run']!;
    const own = () => [...sessions.values()].find((s) => s.run === run) ?? null;
    return {
      async listTools() {
        return TOOLS;
      },
      async call(name, args) {
        mcp.push({ run, name });
        const s = own();
        if (name === 'price_list') return ok({ tools: Object.entries(PRICES).map(([t, price]) => ({ name: t, price })) });
        if (name === 'get_balance') {
          if (!s) return ok({ status: 'none' });
          if (s.status === 'pending_approval' && o.autoApprove) s.status = 'active';
          return ok({ session_id: s.id, status: s.status, cap: usd(s.capCents), remaining: usd(s.capCents - s.usedCents) });
        }
        if (name === 'open_budget') {
          if (s) return err({ error: 'budget_exists' });
          const id = `mm-sess-${String(++n).padStart(4, '0')}`;
          sessions.set(id, { id, run, status: 'pending_approval', capCents: cents(String(args.cap)), usedCents: 0, captureId: null });
          return ok({ session_id: id, order_id: `ORDER-${id}`, approval_url: `https://paypal.example/checkoutnow?token=ORDER-${id}`, cap: String(args.cap), status: 'pending_approval' });
        }
        if (name === 'close_session') {
          if (!s) return err({ error: 'no_session' });
          closeSession(s);
          return ok({ status: s.status, session_id: s.id });
        }
        if (name === 'get_receipt') return s ? ok(receiptOf(s)) : err({ error: 'no_session' });
        const price = PRICES[name];
        if (!price) return err({ error: 'unknown_tool' });
        if (!s || s.status !== 'active') return err({ error: 'payment_required' });
        paid.push(name);
        await o.duringCall?.(name);
        s.usedCents += cents(price);
        return ok({ result: { quote: '412.37', currency: 'USD' }, metering: { tool: name, price, status: 'OK', remaining: usd(s.capCents - s.usedCents) } });
      },
      async close() {},
    };
  }

  /** A session as MeterMCP holds it, for records written as if the process had died. */
  function seed(run: string, status: string, usedCents = 0): FakeSession {
    const id = `mm-sess-${String(++n).padStart(4, '0')}`;
    const s = { id, run, status, capCents: 100, usedCents, captureId: null };
    sessions.set(id, s);
    return s;
  }
  return { sessions, paid, mcp, connects, admin, connect, seed };
}

// ---------------------------------------------------------------------------------------------
// Fake models: scripted turns; a gate holds a turn until released.

const USAGE = { inputTokens: 100, outputTokens: 10, reported: true };
const act = (name: string, args: Record<string, unknown> = {}, reason = 'because'): ModelCall => ({ name, arguments: { ...args, reason } });
const turn = (c: ModelCall): ModelTurn => ({ calls: [c], text: null, usage: USAGE });
const finish = (outcome = 'done', answer = 'answer') => turn(act('finish', { outcome, answer }));

function scripted(turns: Array<ModelTurn | (() => Promise<ModelTurn>)>): AgentModel & { asked: number } {
  const m = {
    provider: 'gemini' as const,
    model: 'gemini-test',
    asked: 0,
    async turn() {
      m.asked += 1;
      const t = turns.shift();
      if (!t) throw new Error('script exhausted');
      return typeof t === 'function' ? t() : t;
    },
  };
  return m;
}

const INPUT = { goal: 'Price ACME and summarise it', cap: '1.00', failFirst: [] as string[] };

function service(o: { store: RunStore; mm: ReturnType<typeof fakeMeterMcp>; models?: { primary: AgentModel; fallback: AgentModel | null } | null; admin?: MeterAdmin | null; logs?: string[]; now?: () => Date }) {
  const logs = o.logs ?? [];
  const svc = new AgentService({
    store: o.store,
    models: o.models === undefined ? { primary: scripted([finish()]), fallback: null } : o.models,
    meterUrl: 'http://metermcp.internal/agent/mcp',
    meterHeaders: (runId) => ({ 'x-metermcp-token': ADMIN_TOKEN, 'x-agent-run': runId }),
    meterAdmin: o.admin === undefined ? o.mm.admin : o.admin,
    limits: DEFAULT_LIMITS,
    returnTo: (runId) => `https://resolvekit.example/agent?run=${runId}`,
    log: (l) => logs.push(l),
    now: o.now,
    connect: o.mm.connect,
  });
  return { svc, logs };
}

/** A record on disk as a process that died left it. */
function crashed(dir: string, patch: Partial<RunRecord>): RunRecord {
  const at = new Date(T0).toISOString();
  const rec: RunRecord = {
    id: `run-${'ab'.repeat(16)}`,
    createdAt: at,
    updatedAt: at,
    finishedAt: null,
    by: BY,
    goal: INPUT.goal,
    cap: '1.00',
    failFirst: [],
    state: 'running',
    stopReason: null,
    answer: null,
    steps: [],
    approvalUrl: null,
    provider: 'gemini',
    model: 'gemini-test',
    usage: { modelCalls: 1, inputTokens: 100, outputTokens: 10, reported: true },
    sessionId: null,
    orderId: null,
    captureId: null,
    settlement: 'none',
    receiptSha256: null,
    kept: false,
    ...patch,
  };
  writeFileSync(join(dir, `${rec.id}.json`), JSON.stringify(rec));
  return rec;
}

const step = (n: number, s: Partial<Step>): Step => ({ n, at: new Date(T0).toISOString(), state: 'done', kind: 'call', tool: 'quote_lookup', arguments: { symbol: 'ACME' }, reason: 'because', summary: '', metering: null, ...s });

const onDisk = (dir: string, id: string) => JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as RunRecord;

async function finished(store: RunStore, id: string) {
  await until(() => !['running', 'awaiting_approval'].includes(store.get(id)!.state), `run ${id} to end`);
  return store.get(id)!;
}

// ---------------------------------------------------------------------------------------------

test('a record is written at each step, and a store reopened from disk has the same steps', async (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let seenBeforeCall: RunRecord | null = null;
  let runId = '';
  const mm = fakeMeterMcp({ autoApprove: true, duringCall: () => void (seenBeforeCall = onDisk(dir, runId)) });
  const store = new RunStore({ dir });
  const model = scripted([turn(act('price_list')), turn(act('quote_lookup', { symbol: 'ACME' })), finish('done', 'ACME is 412.37 USD')]);
  const { svc } = service({ store, mm, models: { primary: model, fallback: null } });
  const r = svc.start(BY, INPUT);
  assert.ok(r.ok);
  runId = r.run.id;
  assert.match(runId, RUN_RE);
  assert.equal(r.run.state, 'running');
  assert.equal(onDisk(dir, runId).state, 'running');

  const done = await finished(store, runId);
  // Write-ahead: when MeterMCP ran the paid call, the disk already held that step as pending.
  const last = seenBeforeCall!.steps.at(-1)!;
  assert.deepEqual([last.tool, last.state], ['quote_lookup', 'pending']);
  assert.equal(seenBeforeCall!.sessionId, 'mm-sess-0001');

  assert.equal(done.state, 'done');
  assert.equal(done.answer, 'ACME is 412.37 USD');
  assert.deepEqual(done.steps.map((s) => [s.n, s.tool ?? s.kind, s.state]), [[1, 'price_list', 'done'], [2, 'quote_lookup', 'done'], [3, 'finish', 'done']]);
  assert.equal(done.settlement, 'captured');
  assert.equal(done.captureId, 'CAP0001');
  assert.equal(done.receiptSha256, '1'.repeat(64));
  assert.equal(done.orderId, 'ORDER-mm-sess-0001');
  assert.deepEqual([done.provider, done.model, done.usage.modelCalls, done.usage.reported], ['gemini', 'gemini-test', 3, true]);
  assert.ok(done.finishedAt);
  // The run's own connection to /agent/mcp, with its run key; the return URL names the run.
  assert.deepEqual(mm.connects.map((c) => [c.url, c.headers['x-agent-run']]), [['http://metermcp.internal/agent/mcp', runId]]);
  await svc.stop();

  const reopened = new RunStore({ dir });
  assert.deepEqual(reopened.get(runId), done);
  assert.deepEqual(reopened.get(runId)!.steps, done.steps);
  assert.equal(reopened.bySession('mm-sess-0001')!.id, runId);
  assert.equal(reopened.byCapture('CAP0001')!.id, runId);
  assert.equal(reopened.bySession('mm-sess-9999'), null);
});

test('recover marks running and awaiting_approval runs interrupted, closes their sessions through the admin client, and runs no tool even if the buyer approves later', async (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mm = fakeMeterMcp();
  const waiting = mm.seed(`run-${'cd'.repeat(16)}`, 'pending_approval');
  crashed(dir, {
    id: `run-${'cd'.repeat(16)}`,
    state: 'awaiting_approval',
    sessionId: waiting.id,
    orderId: `ORDER-${waiting.id}`,
    approvalUrl: 'https://paypal.example/checkoutnow?token=X',
    steps: [step(1, { state: 'pending' })],
  });
  const free = crashed(dir, { id: `run-${'ef'.repeat(16)}`, state: 'running', steps: [step(1, { kind: 'free', tool: 'price_list', arguments: {} })] });
  const store = new RunStore({ dir });
  const { svc, logs } = service({ store, mm });
  await svc.recover();

  const a = store.get(`run-${'cd'.repeat(16)}`)!;
  assert.equal(a.state, 'interrupted');
  assert.equal(a.approvalUrl, null);
  assert.ok(a.finishedAt);
  assert.deepEqual(a.steps.map((s) => [s.state, s.summary]), [['uncertain', RECOVERED_SUMMARY]]);
  assert.deepEqual(mm.admin.closes, [waiting.id]);
  assert.equal(waiting.status, 'cancelled');
  assert.equal(a.settlement, 'not_approved');
  assert.equal(onDisk(dir, a.id).state, 'interrupted');

  // No budget was opened: interrupted, nothing to close, settlement stays none.
  const b = store.get(free.id)!;
  assert.deepEqual([b.state, b.settlement], ['interrupted', 'none']);
  assert.deepEqual(b.steps.map((s) => s.state), ['done']);

  // The buyer approves in PayPal after the restart: nothing is listening, no tool runs.
  waiting.status = 'active';
  await tick();
  await svc.reconcile();
  assert.deepEqual(mm.paid, []);
  assert.deepEqual(mm.mcp, []);
  assert.deepEqual(mm.connects, []);
  assert.ok(logs.some((l) => l.includes(a.id) && l.includes('interrupted')));
  await svc.stop();
});

test('restart after a paid call ran but before its result was recorded: the step becomes uncertain, is never repeated, and the settlement comes from the re-read receipt', async (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mm = fakeMeterMcp();
  const run = `run-${'12'.repeat(16)}`;
  // MeterMCP charged quote_lookup; the process died before the step's answer was written.
  const s = mm.seed(run, 'active', 5);
  crashed(dir, { id: run, state: 'running', sessionId: s.id, orderId: `ORDER-${s.id}`, steps: [step(1, { kind: 'free', tool: 'price_list' }), step(2, { state: 'pending' })] });
  const store = new RunStore({ dir });
  const { svc } = service({ store, mm });
  await svc.recover();

  const r = store.get(run)!;
  assert.equal(r.state, 'interrupted');
  assert.deepEqual(r.steps.map((x) => [x.n, x.state]), [[1, 'done'], [2, 'uncertain']]);
  assert.equal(r.steps[1]!.summary, RECOVERED_SUMMARY);
  assert.equal(r.steps[1]!.metering, null);
  assert.deepEqual(mm.admin.closes, [s.id]);
  assert.deepEqual([r.settlement, r.captureId, r.receiptSha256], ['captured', s.captureId, '1'.repeat(64)]);
  assert.deepEqual(mm.paid, []);
  assert.deepEqual(mm.connects, []);
  assert.deepEqual(onDisk(dir, run).steps[1]!.state, 'uncertain');
  await svc.stop();
});

test('recover leaves settlement unverified when the receipt cannot be read, and reconcile later sets it from the receipt', async (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mm = fakeMeterMcp();
  const run = `run-${'34'.repeat(16)}`;
  const s = mm.seed(run, 'active', 5);
  crashed(dir, { id: run, sessionId: s.id, steps: [step(1, { state: 'pending' })] });
  // A budget whose open_budget answer was never recorded: the session id is unknown, so it cannot be claimed none.
  const lost = crashed(dir, { id: `run-${'56'.repeat(16)}`, steps: [step(1, { state: 'pending' })] });
  const store = new RunStore({ dir });
  const { svc } = service({ store, mm });
  mm.admin.receiptFails = true;
  await svc.recover();
  assert.deepEqual([store.get(run)!.state, store.get(run)!.settlement, store.get(run)!.captureId], ['interrupted', 'unverified', null]);
  assert.equal(store.get(lost.id)!.settlement, 'unverified');
  assert.deepEqual(mm.admin.closes, [s.id]);

  mm.admin.receiptFails = false;
  await svc.reconcile();
  const r = store.get(run)!;
  assert.deepEqual([r.settlement, r.captureId], ['captured', s.captureId]);
  assert.equal(onDisk(dir, run).settlement, 'captured');
  // Closed again by the sweep (idempotent in MeterMCP); the run without a session id has nothing to close.
  assert.deepEqual(mm.admin.closes, [s.id, s.id]);
  assert.equal(store.get(lost.id)!.settlement, 'unverified');

  // Settled for good: the next sweep leaves it alone.
  await svc.reconcile();
  assert.deepEqual(mm.admin.closes, [s.id, s.id]);
  await svc.stop();
});

test('reconcile never closes a session twice: the admin close is called once per record while it is in flight', async (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mm = fakeMeterMcp();
  const run = `run-${'78'.repeat(16)}`;
  const s = mm.seed(run, 'active', 5);
  crashed(dir, { id: run, state: 'interrupted', finishedAt: new Date(T0).toISOString(), sessionId: s.id, settlement: 'open' });
  const pendingRun = `run-${'9a'.repeat(16)}`;
  const p = mm.seed(pendingRun, 'capture_pending', 5);
  crashed(dir, { id: pendingRun, state: 'done', finishedAt: new Date(T0).toISOString(), sessionId: p.id, settlement: 'capture_pending' });
  const store = new RunStore({ dir });
  const { svc } = service({ store, mm });
  const gate = deferred();
  mm.admin.closeGate = gate.promise;
  const first = svc.reconcile();
  const second = svc.reconcile();
  await tick();
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(mm.admin.closes, [s.id]);
  // A pending capture is re-read (reconcile), not closed.
  assert.deepEqual(mm.admin.reconciles, [p.id]);
  assert.equal(store.get(run)!.settlement, 'captured');
  assert.equal(store.get(pendingRun)!.settlement, 'captured');
  await svc.stop();
});

test('start refuses a second running run of the same person (RUN_IN_PROGRESS) and a fourth on the server (BUSY)', async () => {
  assert.equal(MAX_RUNNING_PER_PERSON, 1);
  assert.equal(MAX_RUNNING, 3);
  const mm = fakeMeterMcp();
  const store = new RunStore({ dir: null });
  const gate = deferred();
  const held = async () => (await gate.promise, finish());
  // One model for the server: each run asks once and waits on the gate; Ana's later run finishes at once.
  const model = scripted([held, held, held, finish()]);
  const { svc } = service({ store, mm, models: { primary: model, fallback: null } });
  const a = svc.start(BY, INPUT);
  assert.ok(a.ok);
  assert.deepEqual(svc.start(BY, INPUT), { ok: false, error: 'RUN_IN_PROGRESS' });
  const b = svc.start({ ...BY, personId: 'p-bea' }, INPUT);
  const c = svc.start({ ...BY, personId: 'p-cris' }, INPUT);
  assert.ok(b.ok && c.ok);
  assert.deepEqual(svc.start({ ...BY, personId: 'p-dani' }, INPUT), { ok: false, error: 'BUSY' });
  assert.equal(store.list({ workspaceId: 'ws-1' }).length, 3);
  gate.resolve();
  for (const r of [a, b, c]) if (r.ok) await finished(store, r.run.id);
  // Once her run ended, Ana may start another.
  const again = svc.start(BY, INPUT);
  assert.ok(again.ok);
  await finished(store, again.run.id);
  await svc.stop();

  const none = new AgentService({ store, models: null, meterUrl: 'x', meterHeaders: () => ({}), meterAdmin: null, limits: DEFAULT_LIMITS, returnTo: () => undefined, log: () => {}, connect: mm.connect });
  assert.deepEqual(none.start(BY, INPUT), { ok: false, error: 'MODEL_UNAVAILABLE' });
});

test('persistence failure: the run stops (stopped/persistence) with no further tool call, close is attempted, the state is kept in memory and the sweep writes it', async (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let failing = false;
  const store = new RunStore({
    dir,
    write: (file, data) => {
      if (failing) throw new Error('ENOSPC: no space left on device');
      writeFileSync(file, data);
    },
  });
  // The disk fills while MeterMCP runs the first paid call: its answer cannot be written.
  const mm = fakeMeterMcp({ autoApprove: true, duringCall: () => void (failing = true) });
  const model = scripted([turn(act('quote_lookup', { symbol: 'ACME' })), turn(act('deep_report', { topic: 'ACME' })), finish()]);
  const { svc, logs } = service({ store, mm, models: { primary: model, fallback: null } });
  const r = svc.start(BY, INPUT);
  assert.ok(r.ok);
  const mem = await finished(store, r.run.id);

  assert.deepEqual([mem.state, mem.stopReason], ['stopped', 'persistence']);
  assert.deepEqual(mm.paid, ['quote_lookup']);
  assert.equal(model.asked, 1);
  assert.ok(mm.mcp.some((c) => c.name === 'close_session'));
  assert.equal(mem.settlement, 'captured');
  assert.deepEqual(mem.steps.map((s) => [s.tool, s.state]), [['quote_lookup', 'done']]);
  // On disk: the last state that could be written (the call announced, pending).
  const disk = onDisk(dir, r.run.id);
  assert.equal(disk.state, 'running');
  assert.deepEqual(disk.steps.map((s) => [s.tool, s.state]), [['quote_lookup', 'pending']]);
  assert.ok(logs.some((l) => l.includes(r.run.id) && /not saved/.test(l)));
  assert.deepEqual(store.unsaved(), [r.run.id]);

  failing = false;
  await svc.reconcile();
  assert.deepEqual(store.unsaved(), []);
  assert.deepEqual(onDisk(dir, r.run.id), store.get(r.run.id));
  await svc.stop();
});

test('cancellation during a call: stop() while a paid call is in flight records that call, ends the run interrupted and closes the session', async () => {
  const gate = deferred();
  let inCall = false;
  const mm = fakeMeterMcp({
    autoApprove: true,
    duringCall: async () => {
      inCall = true;
      await gate.promise;
    },
  });
  const store = new RunStore({ dir: null });
  const model = scripted([turn(act('quote_lookup', { symbol: 'ACME' })), turn(act('deep_report', { topic: 'ACME' })), finish()]);
  const { svc } = service({ store, mm, models: { primary: model, fallback: null } });
  const r = svc.start(BY, INPUT);
  assert.ok(r.ok);
  await until(() => inCall, 'the paid call');
  const stopping = svc.stop();
  await tick();
  gate.resolve();
  await stopping;

  const rec = store.get(r.run.id)!;
  assert.equal(rec.state, 'interrupted');
  assert.deepEqual(rec.steps.map((s) => [s.tool, s.state, s.metering?.status]), [['quote_lookup', 'done', 'OK']]);
  assert.deepEqual(mm.paid, ['quote_lookup']);
  assert.equal(model.asked, 1);
  assert.ok(mm.mcp.some((c) => c.name === 'close_session'));
  assert.equal(rec.settlement, 'captured');
});

test('list filters by person, by workspace only when asked, newest first', () => {
  let now = T0;
  const store = new RunStore({ dir: null, now: () => new Date(now) });
  const base = { finishedAt: null, goal: 'g', cap: '1.00', failFirst: [], state: 'done' as const, stopReason: null, answer: null, steps: [], approvalUrl: null, provider: null, model: null, usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, reported: false }, sessionId: null, orderId: null, captureId: null, settlement: 'none' as const, receiptSha256: null, kept: false };
  const a1 = store.create({ ...base, by: BY });
  now += 1000;
  const b1 = store.create({ ...base, by: { ...BY, personId: 'p-bea', label: 'Bea' } });
  now += 1000;
  const a2 = store.create({ ...base, by: BY });
  store.create({ ...base, by: { personId: 'p-ana', label: 'Ana', workspaceId: 'ws-2' } });
  assert.deepEqual(store.list({ personId: 'p-ana', workspaceId: 'ws-1' }).map((r) => r.id), [a2.id, a1.id]);
  assert.deepEqual(store.list({ workspaceId: 'ws-1' }).map((r) => r.id), [a2.id, b1.id, a1.id]);
  assert.equal(store.list({ personId: 'p-ana' }).length, 3);
  assert.throws(() => store.list({}), /personId or workspaceId/);
  assert.equal(store.get('run-../../etc'), null);
  assert.throws(() => store.update('../x', { kept: true }), /run id/);
});

test('sweep deletes unkept records older than 30 days and keeps kept ones', (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = T0;
  const store = new RunStore({ dir, now: () => new Date(now) });
  const base = { finishedAt: null, goal: 'g', cap: '1.00', failFirst: [], state: 'done' as const, stopReason: null, answer: null, steps: [], approvalUrl: null, provider: null, model: null, usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, reported: false }, sessionId: null, orderId: null, captureId: null, settlement: 'none' as const, receiptSha256: null, by: BY };
  const old = store.create({ ...base, kept: false });
  const kept = store.create({ ...base, kept: false });
  store.update(kept.id, { kept: true });
  now += 20 * 86_400_000;
  const recent = store.create({ ...base, kept: false });
  now = T0 + 30 * 86_400_000 - 1;
  assert.deepEqual(store.sweep(), []);
  now = T0 + 30 * 86_400_000 + 1;
  assert.deepEqual(store.sweep(), [old.id]);
  assert.equal(store.get(old.id), null);
  assert.deepEqual(readdirSync(dir).sort(), [`${kept.id}.json`, `${recent.id}.json`].sort());
  assert.deepEqual(new RunStore({ dir }).list({ personId: BY.personId }).map((r) => r.id).sort(), [kept.id, recent.id].sort());
});

test('no record, log line or error contains the admin token or the API keys', async (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logs: string[] = [];
  const store = new RunStore({ dir });
  // Real model adapters with recognisable keys, whose provider refuses; a real admin client whose MeterMCP fails.
  const models = agentModelsFromEnv({ GEMINI_API_KEY: GEMINI_KEY, GROQ_API_KEY: GROQ_KEY }, { fetch: (async () => new Response(`{"error":"bad key"}`, { status: 401 })) as typeof fetch });
  const admin = new MeterMcpClient({ base: 'http://m', token: ADMIN_TOKEN, fetch: (async () => new Response('{}', { status: 500 })) as typeof fetch });
  const mm = fakeMeterMcp({ autoApprove: true });
  const { svc } = service({ store, mm, models, admin, logs });
  const r = svc.start(BY, INPUT);
  assert.ok(r.ok);
  await finished(store, r.run.id);

  // A MeterMCP connection that fails with a message echoing its headers is logged without them.
  const leaky = new AgentService({
    store,
    models,
    meterUrl: 'http://m/agent/mcp',
    meterHeaders: (runId) => ({ 'x-metermcp-token': ADMIN_TOKEN, 'x-agent-run': runId }),
    meterAdmin: admin,
    limits: DEFAULT_LIMITS,
    returnTo: () => undefined,
    log: (l) => logs.push(l),
    connect: async (c) => {
      throw new Error(`401 with ${JSON.stringify(c.headers)}`);
    },
  });
  const l = leaky.start({ ...BY, personId: 'p-bea' }, INPUT);
  assert.ok(l.ok);
  const lr = await finished(store, l.run.id);
  assert.equal(lr.state, 'stopped');

  // A crashed record with a session whose receipt cannot be read: recovery and the sweep log the admin failures.
  crashed(dir, { id: `run-${'0f'.repeat(16)}`, sessionId: 'mm-sess-0999', steps: [step(1, { state: 'pending' })] });
  const again = new AgentService({ store: new RunStore({ dir }), models, meterUrl: 'x', meterHeaders: () => ({}), meterAdmin: admin, limits: DEFAULT_LIMITS, returnTo: () => undefined, log: (x) => logs.push(x) });
  await again.recover();
  await again.reconcile();
  await svc.stop();
  await leaky.stop();

  assert.ok(logs.length >= 3);
  const files = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8'));
  for (const secret of [ADMIN_TOKEN, GEMINI_KEY, GROQ_KEY]) {
    for (const f of files) assert.ok(!f.includes(secret), 'a record contains a secret');
    for (const line of logs) assert.ok(!line.includes(secret), `a log line contains a secret: ${line}`);
  }
});

test('MeterMcpClient close and reconcile POST JSON to the admin routes; a busy close is an answer, not an error', async () => {
  const seen: Array<{ url: string; method: string; type: string | null; token: string | null; body: unknown }> = [];
  let status = 200;
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const h = new Headers(init.headers);
    seen.push({ url: String(url), method: init.method ?? 'GET', type: h.get('content-type'), token: h.get('x-metermcp-token'), body: init.body });
    return new Response(JSON.stringify({ status: status === 409 ? 'busy' : 'settled', session_id: 'mm-sess-1' }), { status });
  }) as typeof globalThis.fetch;
  const c = new MeterMcpClient({ base: 'http://m:8790/', token: ADMIN_TOKEN, fetch });
  assert.equal(c.agentMcpUrl, 'http://m:8790/agent/mcp');
  assert.deepEqual(await c.close('mm-sess-1'), { status: 'settled', session_id: 'mm-sess-1' });
  status = 409;
  assert.deepEqual(await c.close('mm-sess-1'), { status: 'busy', session_id: 'mm-sess-1' });
  status = 200;
  await c.reconcile('mm-sess-1');
  assert.deepEqual(
    seen.map((s) => [s.url, s.method, s.type, s.token, s.body]),
    [
      ['http://m:8790/sessions/mm-sess-1/close', 'POST', 'application/json', ADMIN_TOKEN, '{}'],
      ['http://m:8790/sessions/mm-sess-1/close', 'POST', 'application/json', ADMIN_TOKEN, '{}'],
      ['http://m:8790/sessions/mm-sess-1/reconcile', 'POST', 'application/json', ADMIN_TOKEN, '{}'],
    ],
  );
  status = 404;
  await assert.rejects(c.close('mm-sess-1'), /MeterMCP answered 404/);
});
