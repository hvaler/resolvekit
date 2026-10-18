import { test } from 'node:test';
import assert from 'node:assert/strict';
import { standardCase } from '@resolvekit/cases';
import {
  AGENT_CASE_ID,
  DEFAULT_METERMCP_URL,
  STANDARD_CASE_ID,
  DEFAULT_AGENT_CAP,
  DEFAULT_AGENT_GOAL,
  agentEntries,
  agentReserveNote,
  agentReserveProblems,
  bindingsJson,
  boundCaptures,
  buyerInstructions,
  disputeReadiness,
  parseArgs,
  disputeSellerProblems,
  localRunReader,
  receiptShapeProblems,
  opsRunReader,
  parseCaptures,
  reserveFromRuns,
  standardOrder,
  type AgentRunRead,
  type PrepareOptions,
} from '../scripts/demo-prepare-lib.ts';
import { parseBindingPools, parseBindings } from '../src/bindings.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunRecord } from '../src/agent/runs.ts';
import type { Receipt } from '../src/metermcp.ts';

const ok = (argv: string[]) => {
  const o = parseArgs(argv);
  if ('error' in o) throw new Error(o.error);
  return o as PrepareOptions;
};

test('demo:prepare args: all steps by default against the hosted MeterMCP; steps run separately; resume with captures', () => {
  const all = ok([]);
  assert.deepEqual([all.standard, all.agent, all.waitDisputes, all.dryRun, all.meterUrl], [true, true, true, false, DEFAULT_METERMCP_URL]);
  assert.deepEqual([ok(['--standard']).standard, ok(['--standard']).agent, ok(['--standard']).waitDisputes], [true, false, false]);
  assert.deepEqual([ok(['--agent']).standard, ok(['--agent']).agent], [false, true]);
  const resume = ok(['--wait-disputes', '--captures', '1AB23456CD789012E,9XY87654ZW321098Q']);
  assert.deepEqual([resume.standard, resume.agent, resume.waitDisputes], [false, false, true]);
  assert.deepEqual(resume.captures, { standard: ['1AB23456CD789012E'], agent: ['9XY87654ZW321098Q'] });
  assert.equal(ok(['--dry-run']).dryRun, true);
  assert.equal(ok(['--agent', '--metermcp', 'http://127.0.0.1:8790/mcp']).meterUrl, 'http://127.0.0.1:8790/mcp');
  assert.equal(ok(['--approval-minutes', '5']).approvalMinutes, 5);
  for (const bad of [['--wait-disputes'], ['--captures', 'X'], ['--nope'], ['--metermcp', 'ftp://x'], ['--metermcp'], ['--dispute-minutes', '0'], ['--captures', '1AB23456CD789012E']]) {
    assert.ok('error' in parseArgs(bad), bad.join(' '));
  }
});

test('demo:prepare captures: positional (either may be empty or "-") or labelled', () => {
  assert.deepEqual(parseCaptures(',9XY87654ZW321098Q'), { agent: ['9XY87654ZW321098Q'] });
  assert.deepEqual(parseCaptures('1AB23456CD789012E,-'), { standard: ['1AB23456CD789012E'] });
  assert.deepEqual(parseCaptures('agent=9XY87654ZW321098Q'), { agent: ['9XY87654ZW321098Q'] });
  assert.ok('error' in parseCaptures('a,b,c'));
  assert.ok('error' in parseCaptures('not a capture'));
  assert.ok('error' in parseCaptures(','));
});

test('demo:prepare standard order: exactly the fixture’s order (1 × Linen tote, natural · 7.00 USD · physical goods)', () => {
  const b = standardOrder(standardCase, 'https://resolvekit-i3j2.onrender.com');
  assert.deepEqual(b.amount, { currency_code: 'USD', value: '7.00' });
  assert.deepEqual(b.items, [{ name: 'Linen tote, natural', quantity: '1', unit_amount: { currency_code: 'USD', value: '7.00' }, category: 'PHYSICAL_GOODS' }]);
  assert.equal(b.shipping, 'GET_FROM_FILE');
  assert.equal(b.returnUrl, 'https://resolvekit-i3j2.onrender.com/?demo=approved');
  assert.equal(standardCase.summary.amount, '7.00');
});

test('demo:prepare buyer instructions: not received; physical product for the standard case, service + the exact reason for the agent case', () => {
  const s = buyerInstructions('standard', 'CAP1', '7.00 USD');
  assert.match(s, /didn't receive an item/);
  assert.match(s, /"Physical product"/);
  assert.match(s, /CAP1/);
  const a = buyerInstructions('agent', 'CAP2', '1.37 USD');
  assert.match(a, /"Service"/);
  assert.match(a, /"I didn't receive any confirmation of the service"/);
  assert.match(a, /1\.37 USD/);
});

test('demo:prepare dispute readiness', () => {
  assert.deepEqual(disputeReadiness(null), { state: 'missing' });
  assert.deepEqual(disputeReadiness({ dispute_id: 'PP-R-D0001', status: 'UNDER_REVIEW' }), { state: 'processing', disputeId: 'PP-R-D0001', status: 'UNDER_REVIEW' });
  assert.deepEqual(disputeReadiness({ dispute_id: 'PP-R-D0001', status: 'WAITING_FOR_SELLER_RESPONSE' }), { state: 'ready', disputeId: 'PP-R-D0001', status: 'WAITING_FOR_SELLER_RESPONSE' });
});

test('demo:prepare BINDINGS_JSON: what is known, and what is missing', () => {
  const both = bindingsJson({ standard: { dispute: 'PP-R-D0001', capture: 'CAP1AAAAAAAA' }, agent: { dispute: 'PP-R-D0002', capture: 'CAP2BBBBBBBB' } });
  assert.deepEqual(JSON.parse(both.json), { [STANDARD_CASE_ID]: { dispute: 'PP-R-D0001', capture: 'CAP1AAAAAAAA' }, [AGENT_CASE_ID]: { dispute: 'PP-R-D0002', capture: 'CAP2BBBBBBBB' } });
  assert.deepEqual(both.missing, []);
  const one = bindingsJson({ agent: { dispute: 'PP-R-D0002', capture: 'CAP2BBBBBBBB' } });
  assert.deepEqual([JSON.parse(one.json), one.missing], [{ [AGENT_CASE_ID]: { dispute: 'PP-R-D0002', capture: 'CAP2BBBBBBBB' } }, [STANDARD_CASE_ID]]);
  // The server reads exactly this format.
  assert.deepEqual(parseBindings(JSON.parse(both.json))[STANDARD_CASE_ID], { dispute: 'PP-R-D0001', capture: 'CAP1AAAAAAAA' });
});

test('demo:prepare --count N: N standard payments for the reserve (1 by default, at most 20)', () => {
  assert.equal(ok([]).count, 1);
  assert.equal(ok(['--standard', '--count', '5']).count, 5);
  for (const bad of [['--count', '0'], ['--count', '21'], ['--count', 'x'], ['--count'], ['--agent', '--count', '3']]) assert.ok('error' in parseArgs(bad), bad.join(' '));
});

test('demo:prepare captures: several standard ones joined with +, to wait for a whole reserve', () => {
  assert.deepEqual(parseCaptures('1AB23456CD789012E+2AB23456CD789012E,9XY87654ZW321098Q'), { standard: ['1AB23456CD789012E', '2AB23456CD789012E'], agent: ['9XY87654ZW321098Q'] });
  assert.deepEqual(parseCaptures('standard=1AB23456CD789012E+2AB23456CD789012E'), { standard: ['1AB23456CD789012E', '2AB23456CD789012E'] });
  assert.ok('error' in parseCaptures('1AB23456CD789012E+1AB23456CD789012E'));
});

test('demo:prepare BINDINGS_JSON: several standard disputes become the case’s list (first active, the rest in reserve)', () => {
  const pool = bindingsJson({ standard: [{ dispute: 'PP-R-D0001', capture: 'CAP1AAAAAAAA' }, { dispute: 'PP-R-D0003', capture: 'CAP3CCCCCCCC' }] });
  assert.deepEqual(JSON.parse(pool.json)[STANDARD_CASE_ID], [{ dispute: 'PP-R-D0001', capture: 'CAP1AAAAAAAA' }, { dispute: 'PP-R-D0003', capture: 'CAP3CCCCCCCC' }]);
  const p = parseBindingPools(JSON.parse(pool.json));
  assert.deepEqual([p.bindings[STANDARD_CASE_ID]!.dispute, p.reserve[STANDARD_CASE_ID]!.map((b) => b.dispute)], ['PP-R-D0001', ['PP-R-D0003']]);
});

test('demo:prepare --agent-count N: N agent sessions for the agent case’s reserve (1 by default, at most 10, needs the agent step)', () => {
  assert.equal(ok([]).agentCount, 1);
  assert.equal(ok(['--agent', '--agent-count', '4']).agentCount, 4);
  assert.equal(ok(['--agent-count', '2']).agentCount, 2); // all steps by default include the agent
  for (const bad of [['--agent-count', '0'], ['--agent-count', '11'], ['--agent-count', 'x'], ['--agent-count'], ['--standard', '--agent-count', '2']]) {
    assert.ok('error' in parseArgs(bad), bad.join(' '));
  }
});

test('demo:prepare captures: several agent ones joined with +, and no capture listed twice across both cases', () => {
  assert.deepEqual(parseCaptures(',9XY87654ZW321098Q+8XY87654ZW321098Q'), { agent: ['9XY87654ZW321098Q', '8XY87654ZW321098Q'] });
  assert.deepEqual(parseCaptures('agent=9XY87654ZW321098Q+8XY87654ZW321098Q'), { agent: ['9XY87654ZW321098Q', '8XY87654ZW321098Q'] });
  assert.ok('error' in parseCaptures(',9XY87654ZW321098Q+9XY87654ZW321098Q'));
  assert.ok('error' in parseCaptures('1AB23456CD789012E,1AB23456CD789012E'));
  assert.match((parseCaptures('standard=1AB23456CD789012E,standard=2AB23456CD789012E') as { error: string }).error, /twice: join its captures with +/);
});

test('demo:prepare BINDINGS_JSON: several agent disputes become the agent case’s list (first active, the rest in reserve)', () => {
  const pool = bindingsJson({
    standard: { dispute: 'PP-R-D0001', capture: 'CAP1AAAAAAAA' },
    agent: [{ dispute: 'PP-R-D0002', capture: 'CAP2BBBBBBBB' }, { dispute: 'PP-R-D0004', capture: 'CAP4DDDDDDDD' }],
  });
  assert.deepEqual(JSON.parse(pool.json)[AGENT_CASE_ID], [{ dispute: 'PP-R-D0002', capture: 'CAP2BBBBBBBB' }, { dispute: 'PP-R-D0004', capture: 'CAP4DDDDDDDD' }]);
  const p = parseBindingPools(JSON.parse(pool.json));
  assert.deepEqual([p.bindings[AGENT_CASE_ID]!.dispute, p.reserve[AGENT_CASE_ID]!.map((b) => b.dispute)], ['PP-R-D0002', ['PP-R-D0004']]);
  // One agent dispute stays a single object, as before.
  assert.deepEqual(JSON.parse(bindingsJson({ agent: [{ dispute: 'PP-R-D0002', capture: 'CAP2BBBBBBBB' }] }).json)[AGENT_CASE_ID], { dispute: 'PP-R-D0002', capture: 'CAP2BBBBBBBB' });
});

// ---------------------------------------------------------------------------------------------
// The agent case's reserve from real runs (--agent-run, --agent-count on the engine).

const RUN = `run-${'a'.repeat(32)}`;
const RUN2 = `run-${'d'.repeat(32)}`;
const SESSION = `mm-sess-${'b'.repeat(32)}`;
const CAPTURE = '7AG12345BC678901D';
const SHA = 'c'.repeat(64);
const SELLER = 'SELLERMERCHANT01';

function receiptOf(o: { settlement?: Partial<Receipt['settlement']>; calls?: Array<{ status: 'OK' | 'FAILED'; price: string }>; session?: string; capture?: string; sha?: string } = {}): Receipt {
  const calls = (o.calls ?? [{ status: 'OK', price: '0.05' }, { status: 'FAILED', price: '0.40' }]).map((c, i) => ({
    n: i + 1, time: '2026-10-18T10:00:00.000Z', tool: 'quote_lookup', price: c.price, status: c.status, request_hash: 'h'.repeat(64), response_hash: null, error: null,
  }));
  return {
    kind: 'metermcp.session_receipt',
    version: 1,
    paypal_env: 'sandbox',
    session: { id: o.session ?? SESSION, status: 'settled', currency: 'USD', created_at: '2026-10-18T10:00:00.000Z', closed_at: '2026-10-18T10:05:00.000Z' },
    mandate: { item: 'MeterMCP session', category: 'DIGITAL_GOODS', cap: '2.00', order_id: 'ORDER1', authorization_id: 'AUTH1', authorization_status: 'CAPTURED', authorization_expires_at: null, approved_at: null, authorized_at: null },
    calls,
    totals: { calls: calls.length, ok: calls.filter((c) => c.status === 'OK').length, failed: calls.filter((c) => c.status === 'FAILED').length, pending: 0, charged: '0.05', cap: '2.00' },
    settlement: { status: 'captured', capture_id: o.capture ?? CAPTURE, capture_status: 'COMPLETED', invoice_id: `${SESSION}-settle`, captured: '0.05', released: '1.95', remainder_released: true, settled_at: '2026-10-18T10:05:00.000Z', error: null, ...o.settlement },
    note: 'synthetic',
    receipt_sha256: o.sha ?? SHA,
  } as Receipt;
}

function runOf(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: RUN, createdAt: '2026-10-18T10:00:00.000Z', updatedAt: '2026-10-18T10:05:00.000Z', finishedAt: '2026-10-18T10:05:00.000Z',
    by: { personId: 'p1', label: 'Ana', workspaceId: 'w1' }, goal: 'Quote for ACME-42', cap: '2.00', failFirst: [], state: 'done', stopReason: null, answer: '412.37 USD',
    steps: [], approvalUrl: null, provider: 'gemini', model: 'gemini-test', usage: { modelCalls: 2, inputTokens: 10, outputTokens: 2, reported: true },
    sessionId: SESSION, orderId: 'ORDER1', captureId: CAPTURE, settlement: 'captured', receiptSha256: SHA, captured: '0.05', released: '1.95', kept: true,
    ...over,
  };
}

test('agentReserveProblems accepts a captured run with one OK call', () => {
  assert.deepEqual(agentReserveProblems(runOf(), receiptOf(), new Set()), []);
  assert.equal(agentReserveNote(runOf()), null);
});

test('agentReserveProblems refuses a pending capture', () => {
  const pending = agentReserveProblems(runOf({ settlement: 'capture_pending' }), receiptOf({ settlement: { status: 'capture_pending', capture_status: 'PENDING', captured: null, released: null } }), new Set());
  assert.equal(pending.length, 1);
  assert.match(pending[0]!, /capture_pending.*pending capture does not count yet/);
  // Captured on the record but PayPal's capture is not COMPLETED: still refused.
  const notCompleted = agentReserveProblems(runOf(), receiptOf({ settlement: { capture_status: 'PENDING' } }), new Set());
  assert.equal(notCompleted.length, 1);
  assert.match(notCompleted[0]!, /PENDING.*not COMPLETED/);
});

test('agentReserveProblems refuses mismatched session, capture or receipt hash', () => {
  const session = agentReserveProblems(runOf(), receiptOf({ session: `mm-sess-${'e'.repeat(32)}` }), new Set());
  assert.equal(session.length, 1);
  assert.match(session[0]!, /session/);
  const capture = agentReserveProblems(runOf(), receiptOf({ capture: '9ZZ12345BC678901D' }), new Set());
  assert.equal(capture.length, 1);
  assert.match(capture[0]!, /capture 9ZZ12345BC678901D/);
  const sha = agentReserveProblems(runOf(), receiptOf({ sha: 'f'.repeat(64) }), new Set());
  assert.equal(sha.length, 1);
  assert.match(sha[0]!, /sha256/);
});

test('agentReserveProblems refuses a capture already used by another entry', () => {
  for (const used of [new Set([CAPTURE]), new Set([CAPTURE.toLowerCase()])]) {
    const p = agentReserveProblems(runOf(), receiptOf(), used);
    assert.equal(p.length, 1);
    assert.match(p[0]!, /already used by another reserve entry/);
  }
});

test('agentReserveProblems refuses a run with no charged call', () => {
  const p = agentReserveProblems(runOf(), receiptOf({ calls: [{ status: 'FAILED', price: '0.40' }] }), new Set());
  assert.equal(p.length, 1);
  assert.match(p[0]!, /no call completed and charged/);
  // An unfinished run is not taken either.
  assert.match(agentReserveProblems(runOf({ state: 'awaiting_approval' }), receiptOf(), new Set()).join(' '), /has not ended/);
});

test('agentReserveProblems: a stopped run is accepted with the not-a-goal note', () => {
  const stopped = runOf({ state: 'stopped', stopReason: 'max_actions', answer: null });
  assert.deepEqual(agentReserveProblems(stopped, receiptOf(), new Set()), []);
  assert.equal(agentReserveNote(stopped), 'ended on max_actions; not a goal achieved');
  assert.equal(agentReserveNote(runOf({ state: 'interrupted' })), 'ended on interrupted; not a goal achieved');
});

test('disputeSellerProblems: once the dispute is known, its seller must be the configured seller (the one seller check)', () => {
  assert.deepEqual(disputeSellerProblems({ disputed_transactions: [{ seller: { merchant_id: SELLER } }] }, SELLER), []);
  const other = disputeSellerProblems({ disputed_transactions: [{ seller: { merchant_id: 'OTHERMERCHANT9' } }] }, SELLER);
  assert.equal(other.length, 1);
  assert.match(other[0]!, /seller OTHERMERCHANT9.*not the configured seller SELLERMERCHANT01/);
  assert.match(disputeSellerProblems({ disputed_transactions: [{}] }, SELLER).join(' '), /no seller/);
  assert.match(disputeSellerProblems({}, SELLER).join(' '), /no seller/);
});

test('receiptShapeProblems: a receipt without its calls, settlement or session id is refused, not trusted', () => {
  assert.deepEqual(receiptShapeProblems(receiptOf()), []);
  for (const bad of [null, 'x', {}, { ...receiptOf(), calls: 'none' }, { ...receiptOf(), settlement: null }, { ...receiptOf(), session: {} }, { ...receiptOf(), session: { id: 7 } }]) {
    assert.ok(receiptShapeProblems(bad).length > 0, JSON.stringify(bad)?.slice(0, 60));
  }
});

test('a malformed receipt from the engine or a reader is a refusal message, not a crash', async () => {
  const malformed = { session: { id: SESSION }, settlement: 'captured' } as unknown as Receipt;
  const eng = await agentEntries(ok(['--agent']), { runEngine: async () => ({ record: runOf(), receipt: malformed }), read: null, used: new Set(), say: () => {} });
  assert.deepEqual(eng.entries, []);
  assert.match(eng.refused[0]!.problems.join(' '), /receipt is malformed/);
  const src = source({ [RUN]: { run: runOf(), receipt: { calls: [] } as unknown as Receipt } });
  const r = await reserveFromRuns([RUN], { read: src.read, used: new Set() });
  assert.deepEqual(r.entries, []);
  assert.match(r.refused[0]!.problems.join(' '), /receipt is malformed/);
});

test('parseBindings keeps working with run and session keys on agent entries', () => {
  const b = bindingsJson({ agent: [{ dispute: 'PP-R-D0002', capture: CAPTURE, run: RUN, session: SESSION }, { dispute: 'PP-R-D0004', capture: 'CAP4DDDDDDDD' }] });
  assert.deepEqual(JSON.parse(b.json)[AGENT_CASE_ID], [{ dispute: 'PP-R-D0002', capture: CAPTURE, run: RUN, session: SESSION }, { dispute: 'PP-R-D0004', capture: 'CAP4DDDDDDDD' }]);
  const p = parseBindingPools(JSON.parse(b.json));
  // The run and session are kept: the server shows a run's record (E5) only for the run its binding names.
  assert.deepEqual(p.bindings[AGENT_CASE_ID], { dispute: 'PP-R-D0002', capture: CAPTURE, run: RUN, session: SESSION });
  assert.deepEqual(p.reserve[AGENT_CASE_ID], [{ dispute: 'PP-R-D0004', capture: 'CAP4DDDDDDDD' }]);
  assert.deepEqual(parseBindings({ [AGENT_CASE_ID]: { dispute: 'PP-R-D0002', capture: CAPTURE, run: RUN, session: SESSION } })[AGENT_CASE_ID], { dispute: 'PP-R-D0002', capture: CAPTURE, run: RUN, session: SESSION });
  // Any other key is still a mistake.
  assert.throws(() => parseBindings({ [AGENT_CASE_ID]: { dispute: 'PP-R-D0002', capture: CAPTURE, note: 'x' } }), /PayPal dispute id/);
  assert.throws(() => parseBindings({ [AGENT_CASE_ID]: { dispute: 'PP-R-D0002', capture: CAPTURE, run: 'not-a-run' } }), /PayPal dispute id/);
});

test('demo:prepare --agent-run: repeatable, needs --seller, waits for its disputes; engine flags with their defaults', () => {
  const o = ok(['--agent-run', RUN, '--agent-run', RUN2, '--seller', SELLER]);
  assert.deepEqual([o.agentRuns, o.standard, o.agent, o.waitDisputes, o.seller], [[RUN, RUN2], false, false, true, SELLER]);
  const all = ok([]);
  assert.deepEqual([all.agentRuns, all.agentGoal, all.agentCap, all.agentFailFirst], [[], DEFAULT_AGENT_GOAL, DEFAULT_AGENT_CAP, []]);
  assert.equal(DEFAULT_AGENT_GOAL, 'Find the current quote for ACME-42 and whether there is any supplier risk.');
  assert.equal(DEFAULT_AGENT_CAP, '2.00');
  const eng = ok(['--agent', '--agent-goal', 'Price ACME-42', '--agent-cap', '1.50', '--agent-fail-first', 'deep_report,bulk_export']);
  assert.deepEqual([eng.agentGoal, eng.agentCap, eng.agentFailFirst], ['Price ACME-42', '1.50', ['deep_report', 'bulk_export']]);
  // The demo budget range, 0.50 to 5.00 USD, ends included.
  assert.deepEqual(['0.50', '5.00', '5'].map((c) => ok(['--agent', '--agent-cap', c]).agentCap), ['0.50', '5.00', '5']);
  assert.match((parseArgs(['--agent', '--agent-cap', '7.00']) as { error: string }).error, /0\.50 to 5\.00 USD/);
  for (const bad of [
    ['--agent-run', RUN],
    ['--agent-run', 'run-123', '--seller', SELLER],
    ['--agent-run', '--seller', SELLER],
    ['--agent-cap', '9.999'],
    ['--agent-cap', '100'],
    ['--agent-cap', '0.49'],
    ['--agent-cap', '5.01'],
    ['--agent-cap', '10'],
    ['--agent-goal', '   '],
    ['--agent-goal', 'x'.repeat(301)],
    ['--agent-fail-first', 'Not A Tool'],
    ['--standard', '--agent-goal', 'x'],
    ['--seller', 'bad id!', '--agent-run', RUN],
  ]) {
    assert.ok('error' in parseArgs(bad), bad.join(' '));
  }
});

test('boundCaptures: every capture of the current BINDINGS_JSON, active and reserve, standard and agent', () => {
  const raw = {
    _comment: 'x',
    [STANDARD_CASE_ID]: [{ dispute: 'PP-R-D0001', capture: 'CAP1AAAAAAAA' }, { dispute: 'PP-R-D0003', capture: 'CAP3CCCCCCCC' }],
    [AGENT_CASE_ID]: [{ dispute: 'PP-R-D0002', capture: 'CAP2BBBBBBBB', run: RUN, session: SESSION }, { dispute: 'PP-R-D0004', capture: 'CAP4DDDDDDDD' }],
    'OTHER-CASE': 'PP-R-D0005',
  };
  assert.deepEqual([...boundCaptures(raw)].sort(), ['CAP1AAAAAAAA', 'CAP2BBBBBBBB', 'CAP3CCCCCCCC', 'CAP4DDDDDDDD']);
});

/** A fake run source: what each id reads back, and every read. */
function source(runs: Record<string, AgentRunRead>) {
  const reads: string[] = [];
  const read = async (id: string) => {
    reads.push(id);
    const r = runs[id];
    if (!r) throw new Error(`no such run ${id}`);
    return structuredClone(r);
  };
  return { reads, read };
}

test('--agent-run never runs the engine, never opens a budget: it only reads the run and its receipt', async () => {
  const engine = { calls: 0 };
  const src = source({ [RUN]: { run: runOf(), receipt: receiptOf() } });
  const o = ok(['--agent-run', RUN, '--seller', SELLER]);
  const r = await agentEntries(o, { runEngine: async () => (engine.calls++, null), read: src.read, used: new Set(), say: () => {} });
  assert.equal(engine.calls, 0);
  assert.deepEqual(src.reads, [RUN]);
  assert.deepEqual(r.entries, [{ capture: CAPTURE, run: RUN, session: SESSION, amount: '0.05 USD', note: null }]);
  assert.deepEqual(r.refused, []);
});

test('the ops reader asks only GET /api/ops/agent-run/<id> with the ops token: no MCP, no open_budget', async () => {
  const seen: string[] = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    seen.push(`${init.method ?? 'GET'} ${new URL(String(url)).pathname} ${(init.headers as Record<string, string>).authorization === 'Bearer T0KEN' ? 'token' : 'no token'}`);
    return new Response(JSON.stringify({ run: runOf(), receipt: receiptOf(), receiptError: null }), { status: 200 });
  }) as typeof globalThis.fetch;
  const read = opsRunReader({ appUrl: 'https://rk.example.com/', token: 'T0KEN', fetch });
  const got = await read(RUN);
  assert.equal(got.run.id, RUN);
  assert.equal(got.receipt?.receipt_sha256, SHA);
  assert.deepEqual(seen, [`GET /api/ops/agent-run/${RUN} token`]);
  // A run id that is not one is not even asked for; a refusal is an error, not a run.
  await assert.rejects(read('run-../../x'), /not a run id/);
  assert.equal(seen.length, 1);
  const refused = opsRunReader({ appUrl: 'https://rk.example.com', token: 'T0KEN', fetch: (async () => new Response('{"error":"MISSING_OR_BAD_TOKEN"}', { status: 401 })) as typeof globalThis.fetch });
  await assert.rejects(refused(RUN), /401/);
  const other = opsRunReader({ appUrl: 'https://rk.example.com', token: 'T0KEN', fetch: (async () => new Response(JSON.stringify({ run: runOf({ id: RUN2 }), receipt: null }), { status: 200 })) as typeof globalThis.fetch });
  await assert.rejects(other(RUN), /another run/);
});

test('the local reader reads <data dir>/agent-runs/<id>.json and only the receipt from MeterMCP’s admin route', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-runs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${RUN}.json`), JSON.stringify(runOf()));
  const calls: string[] = [];
  const meter = { receipt: async (id: string) => (calls.push(`receipt ${id}`), receiptOf()) };
  const read = localRunReader({ dir, meter });
  const got = await read(RUN);
  assert.equal(got.run.id, RUN);
  assert.deepEqual(calls, [`receipt ${SESSION}`]);
  await assert.rejects(read(RUN2), /no run/);
});

test('--agent-run refuses a capture already in BINDINGS_JSON (active or reserve, any case) and the same run twice', async () => {
  const caps = { active: '1AA11111AA111111A', reserve: '2BB22222BB222222B', std: '3CC33333CC333333C' };
  const ids = [RUN, RUN2, `run-${'1'.repeat(32)}`, `run-${'2'.repeat(32)}`];
  const capsOf = [CAPTURE, caps.active, caps.reserve, caps.std];
  const runs: Record<string, AgentRunRead> = {};
  ids.forEach((id, i) => (runs[id] = { run: runOf({ id, captureId: capsOf[i]! }), receipt: receiptOf({ capture: capsOf[i]! }) }));
  const used = boundCaptures({
    [AGENT_CASE_ID]: [{ dispute: 'PP-R-D0002', capture: caps.active }, { dispute: 'PP-R-D0004', capture: caps.reserve }],
    [STANDARD_CASE_ID]: { dispute: 'PP-R-D0001', capture: caps.std },
  });
  const src = source(runs);
  const r = await reserveFromRuns([RUN, ids[1]!, ids[2]!, ids[3]!, RUN], { read: src.read, used });
  assert.deepEqual(r.entries.map((e) => e.run), [RUN]);
  assert.deepEqual(r.refused.map((x) => x.run), [ids[1], ids[2], ids[3], RUN]);
  for (const x of r.refused.slice(0, 3)) assert.match(x.problems.join(' '), /already used by another reserve entry/);
  assert.match(r.refused[3]!.problems.join(' '), /listed twice/);
  // The run listed twice is read once; its capture joined `used` for the rest of the command.
  assert.deepEqual(src.reads.filter((id) => id === RUN), [RUN]);
  assert.ok(used.has(CAPTURE));
});

test('--agent-run refuses a pending capture, a mismatched receipt, and a run it cannot read; a stopped run passes with its note', async () => {
  const pendingId = `run-${'3'.repeat(32)}`;
  const shaId = `run-${'4'.repeat(32)}`;
  const stoppedId = `run-${'5'.repeat(32)}`;
  const noReceiptId = `run-${'6'.repeat(32)}`;
  const src = source({
    [pendingId]: { run: runOf({ id: pendingId, settlement: 'capture_pending', captureId: '4DD44444DD444444D' }), receipt: receiptOf({ capture: '4DD44444DD444444D', settlement: { status: 'capture_pending', capture_status: 'PENDING' } }) },
    [shaId]: { run: runOf({ id: shaId, captureId: '5EE55555EE555555E' }), receipt: receiptOf({ capture: '5EE55555EE555555E', sha: 'f'.repeat(64) }) },
    [stoppedId]: { run: runOf({ id: stoppedId, state: 'stopped', stopReason: 'max_time', captureId: '6FF66666FF666666F' }), receipt: receiptOf({ capture: '6FF66666FF666666F' }) },
    [noReceiptId]: { run: runOf({ id: noReceiptId }), receipt: null, receiptError: 'MeterMCP unreachable' },
  });
  const r = await reserveFromRuns([pendingId, shaId, stoppedId, noReceiptId, RUN2], { read: src.read, used: new Set() });
  assert.deepEqual(r.entries, [{ capture: '6FF66666FF666666F', run: stoppedId, session: SESSION, amount: '0.05 USD', note: 'ended on max_time; not a goal achieved' }]);
  const why = Object.fromEntries(r.refused.map((x) => [x.run, x.problems.join(' ')]));
  assert.match(why[pendingId]!, /pending capture does not count yet/);
  assert.match(why[shaId]!, /sha256/);
  assert.match(why[noReceiptId]!, /receipt could not be read \(MeterMCP unreachable\)/);
  assert.match(why[RUN2]!, /no such run/);
});

test('--agent-count runs the engine and checks each run like a page run before it joins the reserve', async () => {
  const o = ok(['--agent', '--agent-count', '3']);
  let k = 0;
  const made = [
    { record: runOf({ id: RUN, captureId: CAPTURE }), receipt: receiptOf() },
    { record: runOf({ id: RUN2, captureId: '9ZZ12345BC678901D', settlement: 'capture_pending' }), receipt: receiptOf({ capture: '9ZZ12345BC678901D', settlement: { status: 'capture_pending', capture_status: 'PENDING' } }) },
  ];
  const used = new Set<string>();
  const r = await agentEntries(o, { runEngine: async () => made[k++] ?? null, read: null, used, say: () => {} });
  // The second is refused and stops the loop: the third run never starts.
  assert.equal(k, 2);
  assert.deepEqual(r.entries.map((e) => e.capture), [CAPTURE]);
  assert.deepEqual(r.refused.map((x) => x.run), [RUN2]);
  assert.ok(used.has(CAPTURE));
});

test('M-1: an engine run (--agent-count) is bound by its session only; a page run (--agent-run) keeps its run id', async () => {
  const o = ok(['--agent', '--agent-run', RUN2, '--seller', SELLER]);
  const said: string[] = [];
  const src = source({ [RUN2]: { run: runOf({ id: RUN2, captureId: '9ZZ12345BC678901D' }), receipt: receiptOf({ capture: '9ZZ12345BC678901D' }) } });
  const r = await agentEntries(o, { runEngine: async () => ({ record: runOf(), receipt: receiptOf() }), read: src.read, used: new Set(), say: (l) => said.push(l) });
  // The engine's run record lives only in this machine's demo-prepare-runs/: the server has no such run to name.
  assert.deepEqual(r.entries, [
    { capture: CAPTURE, session: SESSION, amount: '0.05 USD', note: null },
    { capture: '9ZZ12345BC678901D', run: RUN2, session: SESSION, amount: '0.05 USD', note: null },
  ]);
  assert.equal(said.filter((l) => /session only/.test(l) && /demo-prepare-runs/.test(l)).length, 1, said.join('\n'));
  const b = JSON.parse(bindingsJson({ agent: r.entries.map((e, i) => ({ dispute: `PP-R-D000${i + 1}`, ...e })) }).json)[AGENT_CASE_ID];
  assert.equal(b[0].run, undefined);
  assert.equal(b[0].session, SESSION);
  assert.equal(b[1].run, RUN2);
});
