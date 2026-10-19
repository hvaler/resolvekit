/**
 * The command-line front end of the buying agent (scripts/demo-agent.ts): its flags, and a run against a fake
 * MeterMCP and a fake model: the same steps as the page, the usage line, the settlement from the receipt, and
 * --no-wait closing the session right after the approval URL so nothing stays authorized.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentModel, MeterAnswer, MeterConnection, MeterTool, ModelTurn } from '@resolvekit/agent';
import { CLI_DEFAULT_CAP, parseCliArgs, runCli, toRunRecord } from '../scripts/demo-agent.ts';

const SESSION = `mm-sess-${'b'.repeat(32)}`;
const DEMO_CODE = 'secret-demo-code-123';

test('demo-agent flags: --goal is required; --cap 2.00, no injected failure and waiting by default', () => {
  const o = parseCliArgs(['--goal', '  Quote for ACME-42 ']);
  assert.deepEqual(o, { goal: 'Quote for ACME-42', cap: '2.00', failFirst: [], noWait: false, out: null });
  assert.equal(CLI_DEFAULT_CAP, '2.00');
  assert.deepEqual(parseCliArgs(['--goal', 'g', '--cap', '1.00', '--fail-first', 'deep_report,bulk_export', '--no-wait', '--out', 'run.json']), {
    goal: 'g', cap: '1.00', failFirst: ['deep_report', 'bulk_export'], noWait: true, out: 'run.json',
  });
  const missing = parseCliArgs([]);
  assert.ok('error' in missing && /--goal is required/.test(missing.error) && /Usage|npm run demo-agent/.test(missing.error));
  for (const bad of [['--goal'], ['--goal', '   '], ['--goal', 'x'.repeat(301)], ['--goal', 'g', '--cap', '2.005'], ['--goal', 'g', '--fail-first', 'Not a tool'], ['--goal', 'g', '--out'], ['--goal', 'g', '--what']]) {
    assert.ok('error' in parseCliArgs(bad), bad.join(' '));
  }
  // The demo budget range, 0.50 to 5.00 USD, ends included.
  assert.deepEqual(['0.50', '5.00'].map((c) => (parseCliArgs(['--goal', 'g', '--cap', c]) as { cap: string }).cap), ['0.50', '5.00']);
  for (const c of ['0.49', '5.01', '10', '0.10']) {
    const r = parseCliArgs(['--goal', 'g', '--cap', c]);
    assert.ok('error' in r && /0\.50 to 5\.00 USD/.test(r.error), c);
  }
});

const free = (name: string): MeterTool => ({ name, title: name, description: `${name} (free).`, price: null, inputSchema: { type: 'object', properties: {} } });
const TOOLS: MeterTool[] = [
  { name: 'quote_lookup', title: 'Quote', description: 'Look up a quote.', price: '0.05', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'], additionalProperties: false } },
  free('price_list'),
  free('get_balance'),
  free('open_budget'),
  free('close_session'),
  free('get_receipt'),
];

/** A MeterMCP whose budget is approved (or never, with `approve: false`); every call recorded. */
function fakeMeter(o: { approve: boolean }) {
  const calls: string[] = [];
  let status = 'none';
  const ok = (body: Record<string, any>): MeterAnswer => ({ isError: false, body });
  const settled = () => o.approve && status === 'closed';
  const meter: MeterConnection = {
    async listTools() {
      return TOOLS;
    },
    async call(name, args) {
      calls.push(name);
      if (name === 'open_budget') {
        status = o.approve ? 'active' : 'pending_approval';
        return ok({ session_id: SESSION, order_id: 'ORDER1', approval_url: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1', cap: args.cap, status: 'pending_approval' });
      }
      if (name === 'get_balance') return ok(status === 'none' ? { status: 'none' } : { status, cap: '1.00', remaining: '1.00' });
      if (name === 'quote_lookup') return ok({ result: { quote: '412.37', currency: 'USD', limits: ['current quote only'] }, metering: { status: 'OK', price: '0.05', remaining: '0.95', request_hash: 'h'.repeat(64) } });
      if (name === 'close_session') {
        status = 'closed';
        return ok({ status: o.approve ? 'settled' : 'cancelled', session_id: SESSION });
      }
      if (name === 'get_receipt') {
        return ok({
          session: { id: SESSION, currency: 'USD' },
          mandate: { order_id: 'ORDER1' },
          calls: settled() ? [{ n: 1, status: 'OK', price: '0.05' }] : [],
          totals: { ok: settled() ? 1 : 0, failed: 0, charged: settled() ? '0.05' : '0.00', cap: '1.00' },
          settlement: settled()
            ? { status: 'captured', capture_id: '7AG12345BC678901D', capture_status: 'COMPLETED', captured: '0.05', released: '0.95' }
            : { status: 'not_approved', capture_id: null, capture_status: null, captured: null, released: null },
          receipt_sha256: 'c'.repeat(64),
        });
      }
      return { isError: true, body: { error: 'unknown' } };
    },
    async close() {
      calls.push('(disconnect)');
    },
  };
  return { meter, calls };
}

const USAGE = { inputTokens: 120, outputTokens: 12, reported: true };
function model(turns: ModelTurn[]): AgentModel {
  let i = 0;
  return { provider: 'gemini', model: 'gemini-test', turn: async () => turns[Math.min(i++, turns.length - 1)]! };
}
const QUOTE: ModelTurn = { calls: [{ name: 'quote_lookup', arguments: { symbol: 'ACME-42', reason: 'the current quote' } }], text: null, usage: USAGE };
const FINISH: ModelTurn = { calls: [{ name: 'finish', arguments: { outcome: 'done', answer: 'ACME-42 is 412.37 USD', reason: 'goal met' } }], text: null, usage: USAGE };

test('demo-agent --no-wait: tools, the first decision and the approval URL, then the session is closed; no paid call, no demo code printed', async () => {
  const mm = fakeMeter({ approve: false });
  const lines: string[] = [];
  const { result, record } = await runCli({
    input: { goal: 'Quote for ACME-42', cap: '1.00', failFirst: [] },
    url: 'http://127.0.0.1:8790/mcp',
    demoCode: DEMO_CODE,
    noWait: true,
    models: { primary: model([QUOTE]), fallback: null },
    say: (l) => lines.push(l),
    connect: async () => mm.meter,
  });
  const out = lines.join('\n');
  assert.match(out, /tools: quote_lookup \(0\.05 USD\), price_list \(free\), get_balance \(free\)/);
  assert.match(out, /#1 quote_lookup · in progress · "the current quote"/);
  assert.match(out, /https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=ORDER1/);
  assert.match(out, /--no-wait/);
  assert.doesNotMatch(out, new RegExp(DEMO_CODE));
  // Closed (MeterMCP cancels a budget never approved), never paid.
  assert.deepEqual(mm.calls.filter((c) => c !== 'get_balance'), ['open_budget', 'close_session', 'get_receipt', '(disconnect)']);
  assert.equal(result.outcome, 'interrupted');
  assert.equal(result.settlement, 'not_approved');
  assert.equal(record.state, 'interrupted');
  assert.match(out, /settlement \(from the receipt\): not_approved/);
});

test('demo-agent full run: each step as the page shows it, the model usage line, the settlement from the receipt; --out is a RunRecord', async () => {
  const mm = fakeMeter({ approve: true });
  const lines: string[] = [];
  const { result, record } = await runCli({
    input: { goal: 'Quote for ACME-42', cap: '1.00', failFirst: [] },
    url: 'http://127.0.0.1:8790/mcp',
    models: { primary: model([QUOTE, FINISH]), fallback: null },
    say: (l) => lines.push(l),
    connect: async () => mm.meter,
  });
  const out = lines.join('\n');
  assert.match(out, /#1 quote_lookup · 0\.05 USD · OK \(charged\) · "the current quote"/);
  assert.match(out, /#2 finish · Finished: done/);
  assert.match(out, /model: gemini\/gemini-test · 2 model calls · tokens in 240 \/ out 24/);
  assert.match(out, /settlement \(from the receipt\): captured · capture 7AG12345BC678901D \(COMPLETED\) · captured 0\.05 · released 0\.95/);
  assert.equal(result.outcome, 'done');
  assert.match(record.id, /^run-[0-9a-f]{32}$/);
  assert.deepEqual(
    [record.state, record.goal, record.cap, record.sessionId, record.captureId, record.settlement, record.receiptSha256, record.captured, record.released, record.kept],
    ['done', 'Quote for ACME-42', '1.00', SESSION, '7AG12345BC678901D', 'captured', 'c'.repeat(64), '0.05', '0.95', false],
  );
  assert.equal(record.steps.length, 2);
  assert.equal(record.approvalUrl, 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1');
});

test('toRunRecord: amounts only from a receipt that was read', () => {
  const r = toRunRecord(
    {
      outcome: 'stopped', stopReason: 'max_actions', answer: null, steps: [], provider: 'groq', model: 'm', usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1, reported: false },
      sessionId: SESSION, orderId: null, captureId: null, settlement: 'unverified', receipt: null, receiptSha256: null,
    },
    { goal: 'g', cap: '1.00', failFirst: ['deep_report'] },
    { approvalUrl: null, startedAt: new Date('2026-10-18T10:00:00Z'), finishedAt: new Date('2026-10-18T10:01:00Z') },
  );
  assert.deepEqual([r.state, r.stopReason, r.captured, r.released, r.failFirst, r.createdAt, r.finishedAt], ['stopped', 'max_actions', null, null, ['deep_report'], '2026-10-18T10:00:00.000Z', '2026-10-18T10:01:00.000Z']);
});
