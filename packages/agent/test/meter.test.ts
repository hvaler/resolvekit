import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../../apps/metermcp/src/app.ts';
import { Ledger } from '../../../apps/metermcp/src/ledger.ts';
import { Meter } from '../../../apps/metermcp/src/meter.ts';
import { toNodeListener } from '../../../apps/metermcp/src/node.ts';
import { fakePayPal } from '../../../apps/metermcp/test/fakePayPal.ts';
import { runAgent, type RunEvent } from '../src/engine.ts';
import { connectMeter } from '../src/meter.ts';
import { validate } from '../src/schema.ts';
import type { AgentModel, ModelCall, ModelTurn, TurnRequest } from '../src/types.ts';

/** A local MeterMCP (local mode, fake PayPal) on a real HTTP port, as apps/metermcp runs it. */
async function localMeterMcp() {
  const pp = fakePayPal();
  let handler: ((req: Request) => Promise<Response>) | null = null;
  let listener: ReturnType<typeof toNodeListener> | null = null;
  const server = createServer((req, res) => void listener!(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const meter = new Meter({ ledger: new Ledger(':memory:'), paypal: pp.client, env: 'sandbox', publicUrl: base });
  const app = createApp({ meter, env: 'sandbox', port, token: 'a'.repeat(64), allowedOrigins: [] });
  handler = app;
  listener = toNodeListener(handler, base);
  return {
    pp,
    url: `${base}/mcp`,
    stop: async () => {
      await app.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

const act = (name: string, args: Record<string, unknown> = {}, reason = 'because'): ModelCall => ({ name, arguments: { ...args, reason } });
const turn = (c: ModelCall): ModelTurn => ({ calls: [c], text: null, usage: { inputTokens: 100, outputTokens: 10, reported: true } });

function scripted(turns: ModelTurn[]): AgentModel & { requests: TurnRequest[] } {
  const requests: TurnRequest[] = [];
  return {
    provider: 'gemini',
    model: 'scripted',
    requests,
    async turn(req) {
      requests.push(req);
      const t = turns.shift();
      if (!t) throw new Error('script exhausted');
      return t;
    },
  };
}

test('connectMeter lists MeterMCP tools with prices, and a full run against a local MeterMCP with a fake PayPal captures only the OK calls', async () => {
  const mm = await localMeterMcp();
  const meter = await connectMeter({ url: mm.url });
  try {
    const tools = await meter.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.deepEqual(
      ['quote_lookup', 'deep_report', 'bulk_export', 'price_list', 'get_balance', 'open_budget', 'close_session', 'get_receipt'].map((n) => [n, byName[n]?.price]),
      [['quote_lookup', '0.05'], ['deep_report', '0.40'], ['bulk_export', '0.92'], ['price_list', null], ['get_balance', null], ['open_budget', null], ['close_session', null], ['get_receipt', null]],
    );
    assert.match(byName.deep_report!.title, /Deep report/);
    assert.match(byName.deep_report!.description, /Limits:/);

    const model = scripted([
      turn(act('quote_lookup', { symbol: 'ACME-42' }, 'Cheapest way to see the price.')),
      turn(act('deep_report', { topic: 'ACME-42 supplier risk' })),
      turn(act('deep_report', { topic: 'ACME-42 supplier risk' }, 'The first attempt failed and was not charged.')),
      turn(act('finish', { outcome: 'done', answer: 'Quote and report gathered.' })),
    ]);
    let orderId: string | null = null;
    const result = await runAgent({
      input: { goal: 'Price and supplier risk of ACME-42', cap: '1.50', failFirst: ['deep_report'] },
      meter,
      models: { primary: model, fallback: null },
      // The buyer approves in PayPal while the engine waits.
      sleep: async () => void (orderId && mm.pp.approve(orderId)),
      onEvent: (e: RunEvent) => void (e.type === 'awaiting_approval' && (orderId = e.orderId)),
    });
    assert.equal(result.outcome, 'done');
    assert.deepEqual(
      result.steps.map((s) => [s.tool, s.metering?.status, s.metering?.charged, s.metering?.injected]),
      [
        ['quote_lookup', 'OK', true, null],
        ['deep_report', 'FAILED', false, 'run'],
        ['deep_report', 'OK', true, null],
        [null, undefined, undefined, undefined],
      ],
    );
    assert.match(result.steps[0]!.summary, /limits/i);
    assert.equal(result.settlement, 'captured');
    assert.equal(result.receipt!.totals.charged, '0.45');
    assert.equal(result.receipt!.settlement.captured, '0.45');
    assert.equal(result.receipt!.mandate.cap, '1.50');
    assert.equal(result.captureId, result.receipt!.settlement.capture_id);
    assert.equal(result.receiptSha256, result.receipt!.receipt_sha256);
    assert.equal(result.orderId, orderId);
    assert.equal(mm.pp.count(/capture$/), 1);
  } finally {
    await meter.close();
    await mm.stop();
  }
});

test("the schema validator accepts and rejects inputs by MeterMCP's real published schemas", async () => {
  const mm = await localMeterMcp();
  const meter = await connectMeter({ url: mm.url });
  try {
    const s = Object.fromEntries((await meter.listTools()).map((t) => [t.name, t.inputSchema]));
    const ok = (name: string, v: unknown) => assert.deepEqual(validate(s[name]!, v), [], `${name} ${JSON.stringify(v)}`);
    const bad = (name: string, v: unknown, re: RegExp) => {
      const errors = validate(s[name]!, v);
      assert.ok(errors.some((e) => re.test(e)), `${name} ${JSON.stringify(v)}: ${errors.join('; ')}`);
    };
    ok('quote_lookup', { symbol: 'ACME-42' });
    bad('quote_lookup', {}, /symbol.*required/);
    bad('quote_lookup', { symbol: '' }, /symbol/);
    bad('quote_lookup', { symbol: 'x'.repeat(33) }, /symbol/);
    bad('quote_lookup', { symbol: 42 }, /symbol.*string/);
    bad('quote_lookup', { symbol: 'A', extra: 1 }, /extra/);
    ok('deep_report', { topic: 't' });
    bad('deep_report', { topic: 'x'.repeat(201) }, /topic/);
    ok('bulk_export', { dataset: 'q' });
    ok('bulk_export', { dataset: 'q', rows: 1000 });
    bad('bulk_export', { dataset: 'q', rows: 5000 }, /rows/);
    bad('bulk_export', { dataset: 'q', rows: 0 }, /rows/);
    bad('bulk_export', { dataset: 'q', rows: 2.5 }, /rows.*integer/);
    bad('bulk_export', { dataset: 'q', rows: '10' }, /rows/);
    ok('price_list', {});
    ok('get_balance', {});
    ok('open_budget', { cap: '1.00', fail_first: ['deep_report'] });
    bad('open_budget', { cap: '1.00', fail_first: ['a', 'b', 'c', 'd'] }, /fail_first/);
    bad('open_budget', { cap: '1.00', fail_first: [1] }, /fail_first\[0\]/);
    bad('quote_lookup', 'ACME', /object/);
    bad('quote_lookup', ['ACME'], /object/);
  } finally {
    await meter.close();
    await mm.stop();
  }
});

test('the validator covers enum, number bounds and nested arrays', () => {
  const schema = { type: 'object', properties: { o: { type: 'string', enum: ['a', 'b'] }, n: { type: 'number', minimum: 0, maximum: 1 }, l: { type: 'array', items: { type: 'integer' }, minItems: 1 } }, required: ['o'] };
  assert.deepEqual(validate(schema, { o: 'a', n: 0.5, l: [1] }), []);
  assert.ok(validate(schema, { o: 'c' }).some((e) => /o/.test(e)));
  assert.ok(validate(schema, { o: 'a', n: 2 }).some((e) => /n/.test(e)));
  assert.ok(validate(schema, { o: 'a', n: Number.NaN }).some((e) => /n/.test(e)));
  assert.ok(validate(schema, { o: 'a', l: [] }).some((e) => /l/.test(e)));
  assert.ok(validate(schema, { o: 'a', l: ['x'] }).some((e) => /l\[0\]/.test(e)));
  assert.deepEqual(validate(schema, { o: 'a', extra: true }), [], 'no additionalProperties: extra keys pass');
});
