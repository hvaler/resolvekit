import { test } from 'node:test';
import assert from 'node:assert/strict';
import { standardCase } from '@resolvekit/cases';
import {
  AGENT_CASE_ID,
  DEFAULT_METERMCP_URL,
  STANDARD_CASE_ID,
  agentReceiptProblems,
  bindingsJson,
  buyerInstructions,
  disputeReadiness,
  parseArgs,
  parseCaptures,
  standardOrder,
  type PrepareOptions,
} from '../scripts/demo-prepare-lib.ts';
import { parseBindings } from '../src/bindings.ts';

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
  assert.deepEqual(resume.captures, { standard: '1AB23456CD789012E', agent: '9XY87654ZW321098Q' });
  assert.equal(ok(['--dry-run']).dryRun, true);
  assert.equal(ok(['--agent', '--metermcp', 'http://127.0.0.1:8790/mcp']).meterUrl, 'http://127.0.0.1:8790/mcp');
  assert.equal(ok(['--approval-minutes', '5']).approvalMinutes, 5);
  for (const bad of [['--wait-disputes'], ['--captures', 'X'], ['--nope'], ['--metermcp', 'ftp://x'], ['--metermcp'], ['--dispute-minutes', '0'], ['--captures', '1AB23456CD789012E']]) {
    assert.ok('error' in parseArgs(bad), bad.join(' '));
  }
});

test('demo:prepare captures: positional (either may be empty or "-") or labelled', () => {
  assert.deepEqual(parseCaptures(',9XY87654ZW321098Q'), { agent: '9XY87654ZW321098Q' });
  assert.deepEqual(parseCaptures('1AB23456CD789012E,-'), { standard: '1AB23456CD789012E' });
  assert.deepEqual(parseCaptures('agent=9XY87654ZW321098Q'), { agent: '9XY87654ZW321098Q' });
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

test('demo:prepare dispute readiness and receipt check', () => {
  assert.deepEqual(disputeReadiness(null), { state: 'missing' });
  assert.deepEqual(disputeReadiness({ dispute_id: 'PP-R-D0001', status: 'UNDER_REVIEW' }), { state: 'processing', disputeId: 'PP-R-D0001', status: 'UNDER_REVIEW' });
  assert.deepEqual(disputeReadiness({ dispute_id: 'PP-R-D0001', status: 'WAITING_FOR_SELLER_RESPONSE' }), { state: 'ready', disputeId: 'PP-R-D0001', status: 'WAITING_FOR_SELLER_RESPONSE' });
  const call = (status: string) => ({ status });
  const good = { calls: [call('OK'), call('FAILED'), call('OK'), call('OK')], settlement: { status: 'captured', capture_id: 'CAP2' } };
  assert.deepEqual(agentReceiptProblems(good), []);
  assert.match(agentReceiptProblems({ ...good, calls: [call('OK'), call('OK'), call('OK')] }).join(' '), /3 calls.*0 failed.*METERMCP_FAIL_FIRST/);
  assert.match(agentReceiptProblems(null)[0]!, /no receipt/);
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
