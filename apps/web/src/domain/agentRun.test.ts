import { describe, expect, it } from 'vitest';
import {
  STOP_REASONS,
  agentErrorText,
  compareRows,
  canStart,
  outcomeText,
  pollDelay,
  runActions,
  runTotals,
  settlementText,
  stateText,
  stepBadges,
  stepLine,
  usageText,
  workspaceToggle,
  type AgentRun,
  type AgentStep,
} from './agentRun';

const step = (over: Partial<AgentStep> = {}): AgentStep => ({
  n: 1,
  at: '2026-10-18T10:00:00.000Z',
  state: 'done',
  kind: 'call',
  tool: 'quote_lookup',
  arguments: { symbol: 'ACME-42' },
  reason: 'Get the current quote first.',
  summary: 'Quote 412.37 USD · limits: current quote only',
  metering: { status: 'OK', price: '0.05', charged: true, remaining: '4.95', injected: null },
  ...over,
});

const run = (over: Partial<AgentRun> = {}): AgentRun => ({
  id: 'run-0123456789abcdef0123456789abcdef',
  createdAt: '2026-10-18T10:00:00.000Z',
  updatedAt: '2026-10-18T10:01:00.000Z',
  finishedAt: '2026-10-18T10:01:00.000Z',
  by: { label: 'Dana Ruiz', workspaceId: 'ws-1' },
  goal: 'Quote ACME-42',
  cap: '5.00',
  failFirst: [],
  state: 'done',
  stopReason: null,
  answer: 'ACME-42 is quoted at 412.37 USD.',
  steps: [step()],
  provider: 'gemini',
  model: 'gemini-2.5-flash',
  usage: { modelCalls: 3, inputTokens: 4200, outputTokens: 310, reported: true },
  captureId: 'CAP1',
  settlement: 'captured',
  receiptSha256: 'ab'.repeat(32),
  captured: '0.45',
  released: '4.55',
  kept: false,
  approvalUrl: null,
  orderId: 'ORDER1',
  sessionId: 'mm-sess-1',
  ...over,
});

describe('outcomeText', () => {
  it('names each outcome', () => {
    expect(outcomeText(run({ state: 'done' }))).toBe('Done');
    expect(outcomeText(run({ state: 'cannot_do' }))).toBe('The tools cannot meet this goal');
    expect(outcomeText(run({ state: 'out_of_budget' }))).toBe('Out of budget');
    expect(outcomeText(run({ state: 'stopped', stopReason: 'max_actions' }))).toBe('Stopped: action limit (8)');
    expect(outcomeText(run({ state: 'model_unavailable' }))).toBe('Model unavailable');
    expect(outcomeText(run({ state: 'not_approved' }))).toBe('Not approved in PayPal');
    expect(outcomeText(run({ state: 'interrupted' }))).toBe('Interrupted (stopped or server restart)');
  });

  it('gives every stop reason its own text', () => {
    const texts: Record<string, string> = {
      max_actions: 'Stopped: action limit (8)',
      max_time: 'Stopped: time limit',
      max_model_calls: 'Stopped: model call limit',
      model_budget: 'Stopped: model token budget',
      invalid_action: 'Stopped: the model gave invalid actions',
      approval_timeout: 'Stopped: PayPal approval timed out',
      persistence: 'Stopped: the run could not be saved',
      budget_unavailable: 'Stopped: MeterMCP did not open a budget',
      meter_unavailable: 'Stopped: MeterMCP unreachable',
      internal_error: 'Stopped: internal error',
    };
    for (const r of STOP_REASONS) expect(outcomeText(run({ state: 'stopped', stopReason: r }))).toBe(texts[r]);
    expect(Object.keys(texts).sort()).toEqual([...STOP_REASONS].sort());
  });

  it('never says done for a stopped or interrupted run', () => {
    for (const r of [...STOP_REASONS, null]) expect(outcomeText(run({ state: 'stopped', stopReason: r }))).not.toMatch(/done/i);
    expect(outcomeText(run({ state: 'interrupted' }))).not.toMatch(/done/i);
  });

  it('says the run is still going while it is', () => {
    expect(outcomeText(run({ state: 'running', finishedAt: null }))).toBe('Running');
    expect(outcomeText(run({ state: 'awaiting_approval', finishedAt: null }))).toBe('Waiting for approval in PayPal');
    expect(stateText('awaiting_approval')).toBe('Waiting for approval in PayPal');
  });
});

describe('settlementText', () => {
  it('captured: the amounts the receipt stated, never the steps’ sum (Ruling A11)', () => {
    expect(settlementText(run({ captured: '0.45', released: '4.55' }))).toBe('Captured 0.45 USD · 4.55 released');
    // The steps say 0.05 was charged; the settlement still shows only what the receipt said.
    expect(settlementText(run({ captured: '1.37', released: '3.63' }))).toBe('Captured 1.37 USD · 3.63 released');
  });

  it('captured without amounts from a receipt: no amount is claimed', () => {
    expect(settlementText(run({ captured: null, released: null }))).toBe('Captured (amount not read yet)');
    expect(settlementText(run({ captured: null, released: null, steps: [step(), step({ n: 2, state: 'uncertain', metering: null })] }))).toBe('Captured (amount not read yet)');
  });

  it('names the other settlements, never implying a charge that is not known', () => {
    expect(settlementText(run({ settlement: 'none' }))).toBe('Nothing opened in PayPal');
    // Not settled yet while the run goes on: an order may exist, so «nothing opened» would be wrong.
    expect(settlementText(run({ settlement: 'none', state: 'awaiting_approval' }))).toBe('Waiting for approval in PayPal: nothing charged yet');
    expect(settlementText(run({ settlement: 'none', state: 'running' }))).toBe('Not settled yet: the run is still going');
    expect(settlementText(run({ settlement: 'unverified' }))).toBe('Not verified yet');
    expect(settlementText(run({ settlement: 'unverified' }))).not.toMatch(/captur|releas/i);
    expect(settlementText(run({ settlement: 'open' }))).toBe('Budget open in PayPal (not settled yet)');
    expect(settlementText(run({ settlement: 'capture_pending' }))).toBe('Capture pending at PayPal (not final)');
    expect(settlementText(run({ settlement: 'capture_pending' }))).toContain('not final');
    expect(settlementText(run({ settlement: 'capture_declined' }))).toBe('Capture declined by PayPal: nothing charged');
    expect(settlementText(run({ settlement: 'voided' }))).toBe('Voided: nothing charged');
    expect(settlementText(run({ settlement: 'failed' }))).toBe('Settlement failed: nothing charged as far as MeterMCP knows; will be retried');
    expect(settlementText(run({ settlement: 'not_approved' }))).toBe('Not approved in PayPal: nothing charged');
  });
});

describe('runTotals', () => {
  it('adds up the charged calls in cents and counts the rest', () => {
    const steps = [
      step({ metering: { status: 'OK', price: '0.10', charged: true, remaining: '4.90', injected: null } }),
      step({ n: 2, metering: { status: 'OK', price: '0.20', charged: true, remaining: '4.70', injected: null } }),
      step({ n: 3, metering: { status: 'FAILED', price: '0.40', charged: false, remaining: '4.70', injected: 'run' } }),
      step({ n: 4, kind: 'free', tool: 'price_list', metering: null }),
      step({ n: 5, state: 'uncertain', metering: null }),
    ];
    expect(runTotals(run({ steps }))).toEqual({ charged: '0.30', okCalls: 2, notCharged: 1, uncertain: 1, cap: '5.00' });
  });
});

describe('stepLine and stepBadges', () => {
  it('a charged call: tool, price, status and the result', () => {
    expect(stepLine(step())).toBe('#1 quote_lookup · 0.05 USD · OK, charged · Quote 412.37 USD · limits: current quote only');
    expect(stepBadges(step())).toEqual([]);
  });

  it('an injected failure is marked injected and not charged, never an outage', () => {
    const s = step({ n: 2, tool: 'deep_report', summary: 'tool_failed: injected for this run', metering: { status: 'FAILED', price: '0.40', charged: false, remaining: '4.95', injected: 'run' } });
    expect(stepLine(s)).toBe('#2 deep_report · 0.40 USD · FAILED, not charged · tool_failed: injected for this run');
    expect(stepBadges(s)).toEqual(['injected', 'not charged']);
    expect(stepLine(s)).not.toMatch(/outage/i);
    expect(stepBadges(step({ metering: { status: 'FAILED', price: '0.40', charged: false, remaining: '4.95', injected: 'server' } }))).toEqual(['injected', 'not charged']);
  });

  it('a real failure is not charged, and not called injected', () => {
    expect(stepBadges(step({ metering: { status: 'FAILED', price: '0.40', charged: false, remaining: '4.95', injected: null } }))).toEqual(['not charged']);
  });

  it('pending and uncertain steps', () => {
    const p = step({ state: 'pending', metering: null, summary: '' });
    expect(stepLine(p)).toBe('#1 quote_lookup · in progress…');
    expect(stepBadges(p)).toEqual(['in progress']);
    const u = step({ state: 'uncertain', metering: null, summary: 'Result unknown: the server restarted during this call; the receipt shows whether it was charged' });
    expect(stepLine(u)).toBe('#1 quote_lookup · Result unknown: the server restarted during this call; the receipt shows whether it was charged');
    expect(stepBadges(u)).toEqual(['uncertain']);
  });

  it('free, invalid, insufficient balance and finish steps', () => {
    expect(stepLine(step({ kind: 'free', tool: 'price_list', metering: null, summary: 'Price list: quote_lookup 0.05 USD' }))).toBe('#1 price_list · free · Price list: quote_lookup 0.05 USD');
    expect(stepLine(step({ kind: 'invalid', tool: 'open_budget', metering: null, summary: 'not offered' }))).toBe('#1 open_budget · invalid action · not offered');
    expect(stepLine(step({ kind: 'invalid', tool: null, metering: null, summary: 'no action' }))).toBe('#1 invalid action · no action');
    expect(stepLine(step({ kind: 'insufficient_balance', tool: 'bulk_export', metering: null, summary: '0.92 > 0.50 left' }))).toBe('#1 bulk_export · not called: insufficient balance · 0.92 > 0.50 left');
    expect(stepLine(step({ kind: 'finish', tool: 'finish', metering: null, summary: 'done' }))).toBe('#1 finish · done');
  });
});

describe('usageText', () => {
  it('provider-reported and estimated tokens, apart from the PayPal budget', () => {
    expect(usageText(run())).toBe('Model: gemini gemini-2.5-flash · 3 calls · 4200 in / 310 out tokens (provider-reported) · not charged to the PayPal budget');
    expect(usageText(run({ provider: 'groq', model: 'llama-3.3-70b', usage: { modelCalls: 1, inputTokens: 900, outputTokens: 40, reported: false } }))).toBe(
      'Model: groq llama-3.3-70b · 1 call · 900 in / 40 out tokens (estimated) · not charged to the PayPal budget',
    );
  });

  it('no model answered yet', () => {
    expect(usageText(run({ provider: null, model: null, usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, reported: false } }))).toBe('Model: none used · not charged to the PayPal budget');
  });
});

describe('compareRows', () => {
  it('aligns two runs by step number, with gaps where one has none', () => {
    const a = run({ steps: [step({ n: 1 }), step({ n: 2 })] });
    const b = run({ steps: [step({ n: 1, tool: 'price_list' }), step({ n: 2 }), step({ n: 3, tool: 'finish' })] });
    const rows = compareRows(a, b);
    expect(rows.map((r) => r.n)).toEqual([1, 2, 3]);
    expect(rows[0]!.left?.tool).toBe('quote_lookup');
    expect(rows[0]!.right?.tool).toBe('price_list');
    expect(rows[2]!.left).toBeNull();
    expect(rows[2]!.right?.tool).toBe('finish');
  });

  it('two empty runs give no rows', () => {
    expect(compareRows(run({ steps: [] }), run({ steps: [] }))).toEqual([]);
  });
});

describe('pollDelay', () => {
  it('2 s while running, 4 s while awaiting approval', () => {
    expect(pollDelay({ state: 'running', settlement: 'none' }, 0)).toBe(2000);
    expect(pollDelay({ state: 'awaiting_approval', settlement: 'open' }, 0)).toBe(4000);
  });

  it('backs off on errors, up to 30 s', () => {
    expect(pollDelay({ state: 'running', settlement: 'none' }, 1)).toBe(4000);
    expect(pollDelay({ state: 'running', settlement: 'none' }, 2)).toBe(8000);
    expect(pollDelay({ state: 'running', settlement: 'none' }, 10)).toBe(30_000);
    expect(pollDelay({ state: 'awaiting_approval', settlement: 'open' }, 4)).toBe(30_000);
  });

  it('a final run whose settlement is not final: 15 s, 30 s, 60 s… up to 5 min', () => {
    for (const s of ['unverified', 'open', 'capture_pending', 'failed'] as const) expect(pollDelay({ state: 'done', settlement: s }, 0)).toBe(15_000);
    expect(pollDelay({ state: 'done', settlement: 'capture_pending' }, 1)).toBe(30_000);
    expect(pollDelay({ state: 'interrupted', settlement: 'unverified' }, 2)).toBe(60_000);
    expect(pollDelay({ state: 'done', settlement: 'failed' }, 5)).toBe(300_000);
    expect(pollDelay({ state: 'done', settlement: 'failed' }, 20)).toBe(300_000);
  });

  it('…and stops after 30 min without a change', () => {
    expect(pollDelay({ state: 'done', settlement: 'unverified' }, 3, 29 * 60_000)).toBe(120_000);
    expect(pollDelay({ state: 'done', settlement: 'unverified' }, 3, 30 * 60_000)).toBeNull();
    // A live run is never given up on by time alone.
    expect(pollDelay({ state: 'awaiting_approval', settlement: 'open' }, 0, 60 * 60_000)).toBe(4000);
  });

  it('null when the run and its settlement are final', () => {
    for (const s of ['none', 'captured', 'capture_declined', 'voided', 'not_approved'] as const) expect(pollDelay({ state: 'done', settlement: s }, 0)).toBeNull();
    expect(pollDelay({ state: 'stopped', settlement: 'voided' }, 5)).toBeNull();
  });
});

describe('runActions, workspaceToggle and canStart', () => {
  const URL_OK = 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1';
  const member = { owner: false, local: false };
  const waiting = (over: Partial<AgentRun> = {}) => run({ state: 'awaiting_approval', finishedAt: null, approvalUrl: URL_OK, ...over });

  it('the author awaiting approval gets the link and Stop; a member no Keep', () => {
    expect(runActions(waiting(), member)).toEqual({ stop: true, keep: false, approvalUrl: URL_OK });
  });

  it('the link only while awaiting approval, and only https', () => {
    expect(runActions(run({ state: 'running', finishedAt: null, approvalUrl: URL_OK }), member).approvalUrl).toBeNull();
    expect(runActions(run({ state: 'done', approvalUrl: URL_OK }), member).approvalUrl).toBeNull();
    expect(runActions(waiting({ approvalUrl: null }), member).approvalUrl).toBeNull();
    expect(runActions(waiting({ approvalUrl: undefined }), member).approvalUrl).toBeNull();
    expect(runActions(waiting({ approvalUrl: 'http://paypal.example/x' }), member).approvalUrl).toBeNull();
    expect(runActions(waiting({ approvalUrl: 'javascript:alert(1)' }), member).approvalUrl).toBeNull();
  });

  it('an owner view of someone else’s run: Keep, never the link nor Stop', () => {
    expect(runActions(waiting({ viewedAs: 'owner' }), { owner: true, local: false })).toEqual({ stop: false, keep: true, approvalUrl: null });
    expect(runActions(run({ viewedAs: 'owner' }), { owner: true, local: false })).toEqual({ stop: false, keep: true, approvalUrl: null });
  });

  it('Stop only for the author while the run is running or awaiting approval', () => {
    expect(runActions(run({ state: 'running', finishedAt: null }), member).stop).toBe(true);
    for (const state of ['done', 'stopped', 'interrupted', 'not_approved'] as const) expect(runActions(run({ state }), member).stop).toBe(false);
  });

  it('Keep for owners (their own runs too) and the local operator', () => {
    expect(runActions(run(), { owner: true, local: false }).keep).toBe(true);
    expect(runActions(run(), { owner: false, local: true }).keep).toBe(true);
    expect(runActions(run(), member).keep).toBe(false);
  });

  it('the workspace toggle: hosted owners only', () => {
    expect(workspaceToggle({ owner: true, local: false })).toBe(true);
    expect(workspaceToggle(member)).toBe(false);
    expect(workspaceToggle({ owner: true, local: true })).toBe(false);
  });

  it('canStart: a goal and a cap, not while starting, not while one of the caller’s own runs is live', () => {
    const idle = { goal: 'Quote ACME-42', cap: '2.00', starting: false, runs: [run()] };
    expect(canStart(idle)).toBe(true);
    expect(canStart({ ...idle, goal: '   ' })).toBe(false);
    expect(canStart({ ...idle, cap: '' })).toBe(false);
    expect(canStart({ ...idle, starting: true })).toBe(false);
    expect(canStart({ ...idle, runs: [run({ state: 'running', finishedAt: null })] })).toBe(false);
    // Someone else's live run, seen by the owner, does not block the owner's own.
    expect(canStart({ ...idle, runs: [run({ state: 'running', finishedAt: null, viewedAs: 'owner' })] })).toBe(true);
  });
});

describe('agentErrorText', () => {
  it('maps the routes’ codes to short messages', () => {
    expect(agentErrorText('RUN_IN_PROGRESS', {})).toBe('You already have a run going: wait for it to end, or stop it.');
    expect(agentErrorText('DAILY_CAP', { resetsAt: '2026-10-19T00:00:00.000Z' })).toBe('The demo’s daily agent runs are used up; they reset at 19 Oct 2026 00:00:00 UTC.');
    expect(agentErrorText('DAILY_CAP', {})).toBe('The demo’s daily agent runs are used up; try again tomorrow.');
    expect(agentErrorText('PERSON_CAP', { retryAfterSec: 7200 })).toBe('You have used your agent runs for today; try again in 2 h.');
    expect(agentErrorText('PERSON_CAP', {})).toBe('You have used your agent runs for today; try again tomorrow.');
    expect(agentErrorText('BUSY', {})).toBe('The server is running as many agent runs as it allows; try again in a few minutes.');
    expect(agentErrorText('MODEL_UNAVAILABLE', {})).toBe('No AI model is configured on this server, so the agent cannot run.');
    expect(agentErrorText('CAPS_UNAVAILABLE', {})).toBe('The demo cannot record this run’s use right now, so it was not started; try again later.');
    expect(agentErrorText('STOPPING', {})).toBe('The server is restarting; try again in a minute.');
    expect(agentErrorText('INVALID_GOAL', {})).toBe('The goal is 1 to 300 characters of plain text.');
    expect(agentErrorText('INVALID_CAP', {})).toBe('The cap is an amount in USD from 0.50 to 5.00, e.g. 2.50.');
    expect(agentErrorText('SIGN_IN_REQUIRED', {})).toBe('Sign in to run the buying agent.');
    expect(agentErrorText('SELLER_WORKSPACE_ONLY', {})).toBe('On this public demo only the seller’s workspace starts agent runs.');
  });

  it('an unknown code falls back to the server’s words, else the code', () => {
    expect(agentErrorText('NOT_RUNNING', { detail: 'This run is not going on this server.' })).toBe('This run is not going on this server.');
    expect(agentErrorText('WHATEVER', {})).toBe('The request was refused (WHATEVER).');
    expect(agentErrorText('SERVER_UNREACHABLE', {})).toBe('The ResolveKit server could not be reached; try again.');
  });
});
