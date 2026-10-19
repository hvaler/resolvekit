import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ModelError, withRetries, type AnalystModel, type ModelRequest } from '../src/model.ts';
import { PROMPT_VERSION } from '../src/prompts.ts';
import { GroqModel } from '../src/providers.ts';
import { BudgetExceeded, LIST_PRICE, RESERVATION_EXCEEDED, budgetGuard, newLedger, reservationUsd, usageUsd } from '../evals/budget.ts';
import type { HeldOutCase } from '../evals/heldout/schema.ts';
import { HELD_OUT_CASES } from '../evals/heldout/cases.ts';
import { FROZEN_PATHS, UsageError, casesHash, frozenHash, listFrozenPaths, loadConfig, isOutage, parseCli, runHeldOut, stopFor, type Attempt, type Git, type HeldOutConfig } from '../evals/runs.ts';
import { fakeModel, input, standardScript } from './fake.ts';

const noSleep = async () => {};
const config: HeldOutConfig = loadConfig();
const USAGE = { inputTokens: 100, outputTokens: 50, thinkingTokens: 5 };
const callUsd = (USAGE.inputTokens * LIST_PRICE.inputPerM + (USAGE.outputTokens + USAGE.thinkingTokens) * LIST_PRICE.outputPerM) / 1e6;

/** A fixture held-out case over the standard input; its dispute id is in every prompt, so a fake can single it out. */
const kase = (name: string): HeldOutCase => {
  const i = input();
  return { name, set: 'held-out', group: name, what: 'fixture', input: { ...i, caseId: name, dispute: { ...i.dispute, id: name } }, trueNotes: [], baitNotes: [], contradictions: [], conflicts: [] };
};
const CASES = [kase('HO-A'), kase('HO-B')];

/**
 * The raw provider: answers from the standard script with fixed usage, the model id it "returns" in CallUsage.model,
 * and `fail` deciding which HTTP attempts throw (and what). Counts every call made. No network.
 */
function raw(provider: 'gemini' | 'groq', o: { fail?: (req: ModelRequest, n: number) => Error | null; returned?: string; usage?: (req: ModelRequest) => Partial<typeof USAGE> } = {}) {
  const { model: inner } = fakeModel(standardScript, { provider, model: config.models[provider] });
  const calls: ModelRequest[] = [];
  const model: AnalystModel = {
    provider,
    model: config.models[provider],
    async generate(req) {
      calls.push(req);
      const e = o.fail?.(req, calls.length);
      if (e) throw e;
      const r = await inner.generate(req);
      return { json: r.json, usage: { ...r.usage, ...USAGE, ...o.usage?.(req), model: o.returned ?? config.models[provider] } };
    },
  };
  return { model, calls };
}

/** git as the runner sees it: a clean tree, HEAD c0de, freeze commit f00; `over` replaces one answer (a thrown Error = non-zero exit). */
function fakeGit(over: { status?: string; diff?: Error; freeze?: string } = {}): Git & { seen: string[][] } {
  const seen: string[][] = [];
  const g = ((args: string[]) => {
    seen.push(args);
    if (args[0] === 'rev-parse') return 'c0de';
    if (args[0] === 'log') return over.freeze ?? 'f00';
    if (args[0] === 'status') return over.status ?? '';
    if (args[0] === 'diff') {
      if (over.diff) throw over.diff;
      return '';
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  }) as Git & { seen: string[][] };
  g.seen = seen;
  return g;
}

const tmp = () => mkdtempSync(join(tmpdir(), 'rk-heldout-'));
const attempt = (dir: string, provider: string, c: string, run: number): Attempt => JSON.parse(readFileSync(join(dir, provider, c, `${run}.json`), 'utf8'));
const files = (dir: string, provider: string, c: string) => (existsSync(join(dir, provider, c)) ? readdirSync(join(dir, provider, c)).sort() : []);
const base = (o: Partial<Parameters<typeof runHeldOut>[0]> & { raw: AnalystModel }) =>
  runHeldOut({ provider: o.raw.provider as 'gemini' | 'groq', cases: CASES, config, runs: 3, budgetUsd: config.budgetUsd[o.raw.provider as 'gemini' | 'groq'], resultsDir: tmp(), git: fakeGit(), retry: { sleep: noSleep }, log: () => {}, ...o });

test('config: the frozen values (models, runs, budget, list price, thinking reserve, negation window, prompt version)', () => {
  assert.deepEqual(config, {
    promptVersion: 'rk-analyst-2026-10-09.7',
    models: { gemini: 'gemini-3.8-flash', groq: 'openai/gpt-oss-120b' },
    runs: 3,
    budgetUsd: { gemini: 1.0, groq: null },
    listPrice: { inputPerM: 0.75, outputPerM: 3.75 },
    thinkingReserveTokens: { gemini: 2048, groq: 0 },
    negationWindowWords: 4,
  });
  assert.deepEqual(LIST_PRICE, config.listPrice);
  assert.equal(PROMPT_VERSION, config.promptVersion);
});

test('three runs give three attempt files per case with run 1, 2, 3, and none is overwritten', async () => {
  const dir = tmp();
  const { model } = raw('gemini');
  const r = await base({ raw: model, resultsDir: dir });
  assert.equal(r.stopped, null);
  for (const c of ['HO-A', 'HO-B']) {
    assert.deepEqual(files(dir, 'gemini', c), ['1.json', '2.json', '3.json']);
    for (const run of [1, 2, 3]) {
      const a = attempt(dir, 'gemini', c, run);
      assert.equal(a.case, c);
      assert.equal(a.run, run);
      assert.equal(a.status, 'ok');
      assert.ok(a.analysis);
      assert.deepEqual({ codeCommit: a.stamp.codeCommit, freezeCommit: a.stamp.freezeCommit, promptVersion: a.stamp.promptVersion }, { codeCommit: 'c0de', freezeCommit: 'f00', promptVersion: PROMPT_VERSION });
    }
  }
  // Run-major: all cases of run 1, then run 2, then run 3.
  assert.deepEqual(r.written.map((p) => p.split(/[\\/]/).slice(-2).join('/')), ['HO-A/1.json', 'HO-B/1.json', 'HO-A/2.json', 'HO-B/2.json', 'HO-A/3.json', 'HO-B/3.json']);

  // A second batch over the same directory skips every existing attempt and rewrites none.
  const before = readFileSync(join(dir, 'gemini', 'HO-A', '1.json'), 'utf8');
  const again = raw('gemini');
  const r2 = await base({ raw: again.model, resultsDir: dir });
  assert.equal(r2.written.length, 0);
  assert.equal(r2.skipped.length, 6);
  assert.equal(again.calls.length, 0);
  assert.equal(readFileSync(join(dir, 'gemini', 'HO-A', '1.json'), 'utf8'), before);
});

test('--from-run resumes: only the missing attempts of the later runs are made', async () => {
  const dir = tmp();
  const { model } = raw('gemini');
  await base({ raw: model, resultsDir: dir, runs: 1 });
  const r = await base({ raw: raw('gemini').model, resultsDir: dir, fromRun: 2 });
  assert.deepEqual(r.written.map((p) => p.split(/[\\/]/).slice(-2).join('/')), ['HO-A/2.json', 'HO-B/2.json', 'HO-A/3.json', 'HO-B/3.json']);
  assert.deepEqual(files(dir, 'gemini', 'HO-A'), ['1.json', '2.json', '3.json']);
});

test('an attempt file is opened exclusively: an existing one is never written over', async () => {
  const dir = tmp();
  const { model } = raw('gemini');
  await base({ raw: model, resultsDir: dir, runs: 1, cases: [CASES[0]!] });
  const file = join(dir, 'gemini', 'HO-A', '1.json');
  writeFileSync(file, 'sentinel');
  // An unreadable attempt (e.g. a half-written file) refuses the start; the file is kept as it is.
  const again = raw('gemini');
  await assert.rejects(base({ raw: again.model, resultsDir: dir, runs: 1, cases: [CASES[0]!] }), /unreadable/);
  assert.equal(again.calls.length, 0);
  assert.equal(readFileSync(file, 'utf8'), 'sentinel');
});

test('the guard reserves the worst case: ceil(chars/4) × 1.5 input, max output plus the thinking reserve, at list price', () => {
  const req: ModelRequest = { stage: 'x', system: 'a'.repeat(400), user: 'b'.repeat(399), schema: {}, maxOutputTokens: 1000 };
  const chars = 400 + 399 + JSON.stringify({}).length;
  const inTok = Math.ceil(Math.ceil(chars / 4) * 1.5);
  const r = reservationUsd(req, 2048);
  assert.equal(r.inputTokens, inTok);
  assert.equal(r.outputTokens, 1000 + 2048);
  assert.equal(r.usd, (inTok * 0.75 + 3048 * 3.75) / 1e6);
  assert.equal(usageUsd({ stage: 'x', provider: 'p', model: 'm', inputTokens: 1_000_000, outputTokens: 500_000, thinkingTokens: 500_000, ms: 0 }), 0.75 + 3.75);
});

test('the guard refuses a call whose worst case exceeds the remaining budget, before making it; the attempt is budget_stopped with its partial usage and the batch stops', async () => {
  const dir = tmp();
  const { model, calls } = raw('gemini');
  // Room for the extract call's reservation and little more: the parallel screen call, then analyze, are refused.
  const probe = raw('gemini');
  await base({ raw: probe.model, runs: 1, cases: [CASES[0]!] });
  const extract = reservationUsd(probe.calls.find((c) => c.stage === 'extract')!, 2048).usd;
  const r = await base({ raw: model, resultsDir: dir, budgetUsd: extract + 0.005 });
  assert.equal(r.stopped, 'budget');
  // Only the extract call reached the provider; the refused ones never did.
  assert.deepEqual(calls.map((c) => c.stage), ['extract']);
  const a = attempt(dir, 'gemini', 'HO-A', 1);
  assert.equal(a.status, 'budget_stopped');
  assert.equal(a.analysis, undefined);
  assert.equal(a.usage.calls, 1);
  assert.equal(a.usage.observedUsd, callUsd);
  assert.ok(a.usage.refused >= 1);
  assert.match(a.error ?? '', /local guard on list-price estimates, not a guarantee of the provider's invoice/);
  // No later case or run starts.
  assert.deepEqual(files(dir, 'gemini', 'HO-B'), []);
  assert.deepEqual(files(dir, 'gemini', 'HO-A'), ['1.json']);
  const ledger = JSON.parse(readFileSync(join(dir, 'gemini', 'budget.json'), 'utf8'));
  assert.equal(ledger.stopped, true);
  assert.equal(ledger.observedUsd, callUsd);
  assert.equal(ledger.estimatedUsd, 0);
  assert.equal(ledger.unknownUsd, 0);
  assert.match(ledger.note, /local guard on list-price estimates, not a guarantee of the provider's invoice/);
});

test('a refusal the pipeline swallows (the screen call) still makes the attempt budget_stopped: refusals are sticky', async () => {
  const ledger = newLedger('gemini', 1);
  const { model, calls } = raw('gemini');
  const g = budgetGuard(model, { ledger, thinkingReserveTokens: 0 });
  ledger.limitUsd = 0; // no room at all
  await assert.rejects(g.generate({ stage: 'screen', system: '', user: '', schema: {}, maxOutputTokens: 1 }), BudgetExceeded);
  ledger.limitUsd = 1; // even with room again, a stopped ledger refuses every later call
  await assert.rejects(g.generate({ stage: 'analyze', system: '', user: '', schema: {}, maxOutputTokens: 1 }), BudgetExceeded);
  assert.equal(calls.length, 0);
  assert.equal(ledger.refusals, 2);
  assert.equal(ledger.stopped, true);
});

test('retries are counted: two failed HTTP attempts and one success; three guard checks; the success is observed, the failures stay unknown at their full reservation', async () => {
  const ledger = newLedger('gemini', 1);
  const { model, calls } = raw('gemini', { fail: (_r, n) => (n <= 2 ? new ModelError('gemini answered 503', { status: 503, retryable: true }) : null) });
  const m = withRetries(budgetGuard(model, { ledger, thinkingReserveTokens: 2048 }), { retries: 2, sleep: noSleep });
  const req: ModelRequest = { stage: 'extract', system: 'sys', user: 'user', schema: {}, maxOutputTokens: 1000 };
  await m.generate(req);
  assert.equal(calls.length, 3);
  assert.equal(ledger.checks, 3);
  assert.equal(ledger.observedUsd, callUsd);
  assert.equal(ledger.unknownUsd, 2 * reservationUsd(req, 2048).usd);
  assert.equal(ledger.estimatedUsd, 0);
});

test('BudgetExceeded is not retried: withRetries rethrows it as is', async () => {
  const ledger = newLedger('gemini', 0);
  const { model, calls } = raw('gemini');
  let slept = 0;
  const m = withRetries(budgetGuard(model, { ledger, thinkingReserveTokens: 0 }), { retries: 2, sleep: async () => void slept++ });
  await assert.rejects(m.generate({ stage: 'x', system: '', user: '', schema: {}, maxOutputTokens: 1 }), BudgetExceeded);
  assert.equal(slept, 0);
  assert.equal(calls.length, 0);
});

test('an unsettled reservation stays estimated in the ledger (a call still in flight, or a crash)', async () => {
  const ledger = newLedger('gemini', 1);
  let release!: () => void;
  const hang: AnalystModel = { provider: 'gemini', model: 'm', generate: () => new Promise((res) => (release = () => res({ json: {}, usage: { stage: 'x', provider: 'gemini', model: 'm', ...USAGE, ms: 0 } }))) };
  const req: ModelRequest = { stage: 'x', system: '', user: '', schema: {}, maxOutputTokens: 10 };
  const p = budgetGuard(hang, { ledger, thinkingReserveTokens: 0 }).generate(req);
  assert.equal(ledger.estimatedUsd, reservationUsd(req, 0).usd);
  release();
  await p;
  assert.equal(ledger.estimatedUsd, 0);
  assert.equal(ledger.observedUsd, callUsd);
});

const always429 = (target: string) => (req: ModelRequest) => (req.user.includes(target) ? new ModelError('answered 429 RESOURCE_EXHAUSTED', { status: 429, retryable: true }) : null);

test('B22 I-1: a 429 that the retries cannot clear is a provider_error and stops the batch (gemini too)', async () => {
  const dir = tmp();
  const lines: string[] = [];
  const { model } = raw('gemini', { fail: always429('HO-A') });
  const r = await base({ raw: model, resultsDir: dir, runs: 1, log: (l) => lines.push(l) });
  assert.equal(r.stopped, 'quota');
  assert.match(r.stopReason ?? '', /429 survived the retries/);
  const a = attempt(dir, 'gemini', 'HO-A', 1);
  assert.equal(a.status, 'provider_error');
  assert.match(a.error ?? '', /429/);
  assert.ok(a.usage.unknownUsd > 0);
  assert.deepEqual(files(dir, 'gemini', 'HO-B'), []);
  const ledger = JSON.parse(readFileSync(join(dir, 'gemini', 'budget.json'), 'utf8'));
  assert.equal(ledger.stops.length, 1);
  assert.deepEqual([ledger.stops[0].kind, ledger.stops[0].case, ledger.stops[0].run], ['quota', 'HO-A', 1]);
  assert.match(ledger.stops[0].reason, /429 survived the retries/);
  // a quota stop is not a budget stop: a later batch may resume once the quota is back
  assert.equal(ledger.stopped, false);
  assert.ok(lines.some((l) => /stopped \(quota\): .*429 survived the retries/.test(l)), lines.join('\n'));
});

test('a 429 that the retries cannot clear is a provider_error and the batch stops (groq quota)', async () => {
  const dir = tmp();
  const { model } = raw('groq', { fail: always429('HO-A') });
  const r = await base({ raw: model, resultsDir: dir, runs: 1 });
  assert.equal(r.stopped, 'quota');
  assert.match(r.stopReason ?? '', /429 survived the retries/);
  assert.equal(attempt(dir, 'groq', 'HO-A', 1).status, 'provider_error');
  assert.deepEqual(files(dir, 'groq', 'HO-B'), []);
});

test('an exception in analyzeCase is a product_error, and the batch continues', async () => {
  const dir = tmp();
  // The model answers, but with no verifiable fact: the pipeline itself throws.
  const { model: inner } = raw('gemini');
  const model: AnalystModel = {
    ...inner,
    provider: 'gemini',
    model: inner.model,
    async generate(req) {
      const r = await inner.generate(req);
      return req.stage === 'extract' && req.user.includes('HO-A') ? { ...r, json: { facts: [], instructions: [] } } : r;
    },
  };
  const r = await base({ raw: model, resultsDir: dir, runs: 1 });
  assert.equal(r.stopped, null);
  const a = attempt(dir, 'gemini', 'HO-A', 1);
  assert.equal(a.status, 'product_error');
  assert.match(a.error ?? '', /no verifiable facts/);
  assert.equal(attempt(dir, 'gemini', 'HO-B', 1).status, 'ok');
});

test('each attempt records the requested model and the models the provider returned (CallUsage.model)', async () => {
  const dir = tmp();
  const { model } = raw('gemini', { returned: 'gemini-3.8-flash-001' });
  await base({ raw: model, resultsDir: dir, runs: 1, cases: [CASES[0]!] });
  const a = attempt(dir, 'gemini', 'HO-A', 1);
  assert.equal(a.stamp.requestedModel, 'gemini-3.8-flash');
  assert.deepEqual(a.stamp.returnedModels, ['gemini-3.8-flash-001']);
  assert.equal(a.provider, 'gemini');
});

test('GroqModel records the model the response names in CallUsage.model', async () => {
  const fetch = (async () =>
    new Response(JSON.stringify({ model: 'openai/gpt-oss-120b-2026-09', choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }), { status: 200 })) as unknown as typeof globalThis.fetch;
  const r = await new GroqModel({ apiKey: 'k', fetch }).generate({ stage: 'x', system: 's', user: 'u', schema: {}, maxOutputTokens: 100 });
  assert.equal(r.usage.model, 'openai/gpt-oss-120b-2026-09');
});

test('the runner refuses to start with uncommitted changes under packages/analyst', async () => {
  const { model, calls } = raw('gemini');
  const git = fakeGit({ status: ' M packages/analyst/src/prompts.ts' });
  await assert.rejects(base({ raw: model, git }), /uncommitted changes under packages\/analyst/);
  assert.equal(calls.length, 0);
  // The batch's own results directory is excluded from the check (a resume must not refuse on its own attempts).
  const status = git.seen.find((a) => a[0] === 'status')!;
  assert.ok(status.includes('packages/analyst'));
  assert.ok(status.some((a) => a.includes('exclude') && a.includes('packages/analyst/evals/results/heldout')));
  // B22 I-3: the server files the held-out inputs are built with are checked too
  assert.ok(status.includes('apps/server/src/uploads/documents.ts'));
  assert.ok(status.includes('apps/server/src/uploads/store.ts'));
});

test('the runner refuses to start when a frozen file differs from the freeze commit', async () => {
  const { model, calls } = raw('gemini');
  const git = fakeGit({ diff: new Error('exit 1') });
  await assert.rejects(base({ raw: model, git }), /differ from the freeze commit f00/);
  assert.equal(calls.length, 0);
  const diff = git.seen.find((a) => a[0] === 'diff')!;
  assert.deepEqual(diff, ['diff', '--quiet', 'f00', 'HEAD', '--', ...FROZEN_PATHS]);
  assert.deepEqual(FROZEN_PATHS.slice(0, 9), [
    'packages/analyst/evals/heldout/cases.ts',
    'packages/analyst/evals/heldout/schema.ts',
    'packages/analyst/evals/heldout/config.json',
    'packages/analyst/evals/strict.ts',
    'packages/analyst/evals/metrics.ts',
    'packages/analyst/evals/heldout/score.ts',
    'packages/analyst/evals/heldout/manual-judgements.json',
    // B22 I-3: the held-out inputs are built with the server's uploadDocuments (and its UploadRecord type)
    'apps/server/src/uploads/documents.ts',
    'apps/server/src/uploads/store.ts',
  ]);
  // B15: the freeze commit is the last commit touching any frozen file, not only the heldout folder
  assert.deepEqual(git.seen.find((a) => a[0] === 'log'), ['log', '-1', '--format=%H', '--', ...FROZEN_PATHS]);
});

test('the runner refuses to start on a prompt version, model or budget other than the frozen config, or on no cases', async () => {
  const { model, calls } = raw('gemini');
  await assert.rejects(base({ raw: model, config: { ...config, promptVersion: 'rk-analyst-other' } }), /PROMPT_VERSION/);
  await assert.rejects(base({ raw: { ...model, model: 'gemini-other', generate: model.generate } }), /pinned model/);
  await assert.rejects(base({ raw: model, budgetUsd: 1.5 }), /budget/);
  await assert.rejects(base({ raw: model, budgetUsd: null }), /budget/);
  await assert.rejects(base({ raw: model, runs: 4 }), /runs/);
  await assert.rejects(base({ raw: model, cases: [] }), /no held-out cases/);
  assert.equal(calls.length, 0);
});

test('no attempt reuses a cached analysis: nothing runs.ts imports, directly or transitively, is src/cache.ts', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const spec = m[1] ?? m[2]!;
      const next = resolve(dirname(file), spec);
      if (next.endsWith('.ts')) walk(next);
    }
  };
  walk(join(root, 'evals', 'runs.ts'));
  assert.ok(seen.has(join(root, 'src', 'pipeline.ts')), 'the walk reaches the pipeline');
  assert.ok(!seen.has(join(root, 'src', 'cache.ts')), 'cache.ts is never imported');
  assert.ok(!/cache/i.test(readFileSync(join(root, 'evals', 'runs.ts'), 'utf8').replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')));
});

// ---- fix round 1: B13 (absorbed failures), B12 (reservation exceeded), B14 (pinned freeze), CLI and Groq floor

test('a screen call that fails for good (gemini 503) leaves a degraded analysis: provider_error, never scored, and the batch continues', async () => {
  const dir = tmp();
  // The screen prompt does not name the dispute: fail every screen call made while the first case (one extract) runs.
  let extracts = 0;
  const fail = (req: ModelRequest) => {
    if (req.stage === 'extract') extracts++;
    return req.stage === 'screen' && extracts === 1 ? new ModelError('gemini answered 503', { status: 503, retryable: true }) : null;
  };
  const { model, calls } = raw('gemini', { fail });
  const r = await base({ raw: model, resultsDir: dir, runs: 1 });
  assert.equal(r.stopped, null);
  const a = attempt(dir, 'gemini', 'HO-A', 1);
  assert.equal(a.status, 'provider_error');
  assert.equal(a.analysis, undefined);
  assert.ok(a.degradedAnalysis);
  assert.match(a.error ?? '', /went on without it: gemini answered 503/);
  assert.equal(calls.filter((c) => c.stage === 'screen').length, 3 + 1, 'three failed screen attempts for HO-A, one for HO-B');
  assert.equal(attempt(dir, 'gemini', 'HO-B', 1).status, 'ok');
});

test('a verify call that hits the quota for good (groq 429) is a provider_error and stops the batch', async () => {
  const dir = tmp();
  const { model } = raw('groq', { fail: (req) => (req.stage === 'verify' ? new ModelError('groq answered 429', { status: 429, retryable: true }) : null) });
  const r = await base({ raw: model, resultsDir: dir, runs: 1 });
  assert.equal(r.stopped, 'quota');
  const a = attempt(dir, 'groq', 'HO-A', 1);
  assert.equal(a.status, 'provider_error');
  assert.ok(a.degradedAnalysis);
  assert.equal(a.analysis, undefined);
  assert.deepEqual(files(dir, 'groq', 'HO-B'), []);
});

test('a call that reports more output + thinking than it reserved stops the batch: budget_stopped, reservation exceeded', async () => {
  const dir = tmp();
  const { model, calls } = raw('gemini', { usage: (req) => (req.stage === 'extract' ? { outputTokens: 20_000 } : {}) });
  const r = await base({ raw: model, resultsDir: dir });
  assert.equal(r.stopped, 'budget');
  const a = attempt(dir, 'gemini', 'HO-A', 1);
  assert.equal(a.status, 'budget_stopped');
  assert.equal(a.analysis, undefined);
  assert.ok(a.error?.includes(RESERVATION_EXCEEDED));
  assert.match(a.error ?? '', /20005 > 14048 output tokens/);
  // Nothing after the extract call (and the parallel screen) was started.
  assert.ok(calls.every((c) => c.stage === 'extract' || c.stage === 'screen'));
  assert.deepEqual(files(dir, 'gemini', 'HO-B'), []);
  const ledger = JSON.parse(readFileSync(join(dir, 'gemini', 'budget.json'), 'utf8'));
  assert.equal(ledger.exceeded, 1);
  assert.equal(ledger.stopped, true);
});

test('groq: a cap below 1024 output tokens is reserved as 1024 (GroqModel floors max_completion_tokens there)', async () => {
  const req: ModelRequest = { stage: 'x', system: '', user: '', schema: {}, maxOutputTokens: 100 };
  assert.equal(reservationUsd(req, 0, 1024).outputTokens, 1024);
  assert.equal(reservationUsd({ ...req, maxOutputTokens: 2000 }, 0, 1024).outputTokens, 2000);
  const ledger = newLedger('groq', 1);
  let reserved = 0;
  const m: AnalystModel = {
    provider: 'groq',
    model: 'm',
    generate: async () => {
      reserved = ledger.estimatedUsd;
      return { json: {}, usage: { stage: 'x', provider: 'groq', model: 'm', ...USAGE, ms: 0 } };
    },
  };
  await budgetGuard(m, { ledger, thinkingReserveTokens: 0 }).generate(req);
  assert.equal(reserved, reservationUsd(req, 0, 1024).usd);
});

test('the first batch pins the freeze commit and the frozen files hash in budget.json', async () => {
  const dir = tmp();
  await base({ raw: raw('gemini').model, resultsDir: dir, runs: 1, cases: [CASES[0]!] });
  const ledger = JSON.parse(readFileSync(join(dir, 'gemini', 'budget.json'), 'utf8'));
  assert.deepEqual(ledger.freeze, { commit: 'f00', hash: frozenHash(), casesHash: casesHash([CASES[0]!]) });
  assert.match(ledger.freeze.hash, /^[0-9a-f]{64}$/);
});

test('a later batch refuses when the freeze commit moved since the first batch', async () => {
  const dir = tmp();
  await base({ raw: raw('gemini').model, resultsDir: dir, runs: 1, cases: [CASES[0]!] });
  const again = raw('gemini');
  await assert.rejects(base({ raw: again.model, resultsDir: dir, git: fakeGit({ freeze: 'f01' }) }), /freeze commit is f01; this batch began on f00/);
  assert.equal(again.calls.length, 0);
});

test('a later batch refuses when the frozen files hash differs from the pinned one', async () => {
  const dir = tmp();
  await base({ raw: raw('gemini').model, resultsDir: dir, runs: 1, cases: [CASES[0]!] });
  const again = raw('gemini');
  await assert.rejects(base({ raw: again.model, resultsDir: dir, hash: 'other' }), /hash differs/);
  assert.equal(again.calls.length, 0);
});

test('a later batch refuses when a stored attempt carries another freeze, or attempts exist with no pinned freeze', async () => {
  const dir = tmp();
  await base({ raw: raw('gemini').model, resultsDir: dir, runs: 1, cases: [CASES[0]!] });
  const file = join(dir, 'gemini', 'HO-A', '1.json');
  const a = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...a, stamp: { ...a.stamp, freezeCommit: 'zzz' } }));
  // the same case set as the first batch (another set is refused on its cases hash, B22)
  await assert.rejects(base({ raw: raw('gemini').model, resultsDir: dir, cases: [CASES[0]!] }), /stamped with freeze zzz; the current freeze is f00/);
  const ledgerFile = join(dir, 'gemini', 'budget.json');
  const { freeze: _f, ...unpinned } = JSON.parse(readFileSync(ledgerFile, 'utf8'));
  writeFileSync(ledgerFile, JSON.stringify(unpinned));
  await assert.rejects(base({ raw: raw('gemini').model, resultsDir: dir }), /no ledger pins their freeze/);
});

test('frozenHash refuses a listed file that does not exist (FROZEN_PATHS grows only with real files)', () => {
  assert.throws(() => frozenHash([...FROZEN_PATHS, 'packages/analyst/evals/heldout/not-there.json']), /frozen file missing/);
});

test('--from-run outside 1..runs, or not an integer, refuses the start', async () => {
  for (const fromRun of [0, 4, 1.5]) await assert.rejects(base({ raw: raw('gemini').model, fromRun }), /--from-run must be an integer from 1 to 3/);
});

test('the command line: flags without a value, unknown flags, bad numbers and a bad --from-run are usage errors', () => {
  assert.deepEqual(parseCli(['--provider', 'groq', '--from-run', '2'], config), { provider: 'groq', runs: 3, budgetUsd: null, fromRun: 2 });
  assert.deepEqual(parseCli(['--provider', 'gemini'], config), { provider: 'gemini', runs: 3, budgetUsd: 1 });
  assert.deepEqual(parseCli(['--case', 'HO-A', '--budget', '0.5'], config), { provider: 'gemini', runs: 3, budgetUsd: 0.5, only: 'HO-A' });
  for (const args of [['--provider'], ['--provider', '--runs', '3'], ['--from-run'], ['--nope', 'x'], ['--budget', 'lots'], ['--from-run', '0'], ['--from-run', '4'], ['--from-run', '1.5'], ['--provider', 'openai'], ['--provider', 'groq', '--budget', '1']])
    assert.throws(() => parseCli(args, config), UsageError, args.join(' '));
});

test('B20: the frozen set covers the analyst src (listed at runtime, sorted) and the batch code', () => {
  for (const p of ['packages/analyst/src/prompts.ts', 'packages/analyst/src/pipeline.ts', 'packages/analyst/evals/runs.ts', 'packages/analyst/evals/budget.ts']) {
    assert.ok(FROZEN_PATHS.includes(p), p);
  }
  const src = FROZEN_PATHS.filter((p) => p.startsWith('packages/analyst/src/'));
  assert.deepEqual(src, [...src].sort());
  assert.equal(src.length, readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.ts')).length);
});

test('B20: a new or changed src file changes the frozen set and frozenHash', () => {
  const root = mkdtempSync(join(tmpdir(), 'frozen-'));
  try {
    for (const p of listFrozenPaths()) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      copyFileSync(join(fileURLToPath(new URL('../../../', import.meta.url)), p), join(root, p));
    }
    const before = frozenHash(listFrozenPaths(root), root);
    appendFileSync(join(root, 'packages/analyst/src/prompts.ts'), '\n// changed\n');
    assert.notEqual(frozenHash(listFrozenPaths(root), root), before);
    const mid = frozenHash(listFrozenPaths(root), root);
    writeFileSync(join(root, 'packages/analyst/src/newfile.ts'), 'export {};\n');
    assert.ok(listFrozenPaths(root).includes('packages/analyst/src/newfile.ts'));
    assert.notEqual(frozenHash(listFrozenPaths(root), root), mid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- final fix wave (ruling B22): stops that keep held-out slots, per-provider budget, the cases hash, input bound

const rejectAt = (status: number, stage = 'extract', target = 'HO-A') => (req: ModelRequest) =>
  req.stage === stage && req.user.includes(target) ? new ModelError(`answered ${status}`, { status, retryable: false }) : null;

test('B22 I-1: a non-retryable 4xx other than 429 (400, 401, 403, 404) is stored as provider_error and stops the batch at once', async () => {
  for (const provider of ['gemini', 'groq'] as const) {
    for (const status of [400, 401, 403, 404]) {
      const dir = tmp();
      const lines: string[] = [];
      const { model, calls } = raw(provider, { fail: rejectAt(status) });
      const r = await base({ raw: model, resultsDir: dir, log: (l) => lines.push(l) });
      assert.equal(r.stopped, 'provider', `${provider} ${status}`);
      assert.match(r.stopReason ?? '', new RegExp(`HTTP ${status}`));
      const a = attempt(dir, provider, 'HO-A', 1);
      assert.equal(a.status, 'provider_error');
      // not retried: one extract call for the case
      assert.equal(calls.filter((c) => c.stage === 'extract').length, 1);
      assert.deepEqual(files(dir, provider, 'HO-B'), []);
      assert.deepEqual(files(dir, provider, 'HO-A'), ['1.json']);
      const ledger = JSON.parse(readFileSync(join(dir, provider, 'budget.json'), 'utf8'));
      assert.deepEqual(ledger.stops.map((s: { kind: string }) => s.kind), ['provider']);
      assert.match(ledger.stops[0].reason, new RegExp(`HTTP ${status}.*key, billing or model id`));
      assert.ok(lines.some((l) => new RegExp(`stopped \\(provider\\): .*HTTP ${status}`).test(l)), lines.join('\n'));
    }
  }
});

test('B22 I-1: a 403 on a call the pipeline absorbs (the screen) still stops the batch', async () => {
  const dir = tmp();
  const { model } = raw('gemini', { fail: (req) => (req.stage === 'screen' ? new ModelError('gemini answered 403', { status: 403, retryable: false }) : null) });
  const r = await base({ raw: model, resultsDir: dir });
  assert.equal(r.stopped, 'provider');
  const a = attempt(dir, 'gemini', 'HO-A', 1);
  assert.equal(a.status, 'provider_error');
  assert.ok(a.degradedAnalysis);
  assert.deepEqual(files(dir, 'gemini', 'HO-B'), []);
});

test('B22 I-1: two consecutive provider_error attempts stop the batch; provider errors with an ok attempt between do not', async () => {
  const dir = tmp();
  const outage = () => new ModelError('gemini answered 503', { status: 503, retryable: true });
  const r = await base({ raw: raw('gemini', { fail: outage }).model, resultsDir: dir });
  assert.equal(r.stopped, 'provider');
  assert.match(r.stopReason ?? '', /2 consecutive attempts ended in provider_error/);
  assert.equal(attempt(dir, 'gemini', 'HO-A', 1).status, 'provider_error');
  assert.equal(attempt(dir, 'gemini', 'HO-B', 1).status, 'provider_error');
  assert.equal(r.written.length, 2);
  const ledger = JSON.parse(readFileSync(join(dir, 'gemini', 'budget.json'), 'utf8'));
  assert.deepEqual([ledger.stops[0].kind, ledger.stops[0].case, ledger.stops[0].run], ['provider', 'HO-B', 1]);

  // HO-A fails in every run, HO-B answers: never two in a row, so every attempt is made
  const dir2 = tmp();
  const only = (req: ModelRequest) => (req.user.includes('HO-A') ? outage() : null);
  const r2 = await base({ raw: raw('gemini', { fail: only }).model, resultsDir: dir2 });
  assert.equal(r2.stopped, null);
  assert.equal(r2.written.length, 6);
});

test('B22 I-2: groq is not USD-guarded: no limit, a batch past 1.00 USD at Gemini list price goes on, every figure labelled not a Groq price', async () => {
  const dir = tmp();
  await base({ raw: raw('groq').model, resultsDir: dir, runs: 1 });
  const ledgerFile = join(dir, 'groq', 'budget.json');
  const l = JSON.parse(readFileSync(ledgerFile, 'utf8'));
  assert.equal(l.limitUsd, null);
  assert.match(l.note, /estimated at Gemini list price, not a Groq price/);
  writeFileSync(ledgerFile, JSON.stringify({ ...l, observedUsd: 50 }));
  const lines: string[] = [];
  const r = await base({ raw: raw('groq').model, resultsDir: dir, log: (x) => lines.push(x) });
  assert.equal(r.stopped, null);
  assert.equal(r.written.length, 4);
  const a = attempt(dir, 'groq', 'HO-A', 3);
  assert.equal(a.status, 'ok');
  assert.match(a.usage.note, /estimated at Gemini list price, not a Groq price/);
  // still recorded for accounting
  const after = JSON.parse(readFileSync(ledgerFile, 'utf8'));
  assert.ok(after.observedUsd > 50);
  assert.equal(after.refusals, 0);
  assert.ok(lines.every((x) => !/ of 1\.00 USD/.test(x)), lines.join('\n'));
  assert.ok(lines.some((x) => /not a Groq price/.test(x)));

  // gemini keeps its hard guard: the same ledger state refuses the next call
  const g = tmp();
  await base({ raw: raw('gemini').model, resultsDir: g, runs: 1 });
  const gl = join(g, 'gemini', 'budget.json');
  writeFileSync(gl, JSON.stringify({ ...JSON.parse(readFileSync(gl, 'utf8')), observedUsd: 50 }));
  const rg = await base({ raw: raw('gemini').model, resultsDir: g });
  assert.equal(rg.stopped, 'budget');
  assert.equal(attempt(g, 'gemini', 'HO-A', 2).status, 'budget_stopped');
});

test('B22 I-2: a groq budget is refused (preflight and CLI), and a groq call over its reservation is recorded without stopping', async () => {
  const { model, calls } = raw('groq');
  await assert.rejects(base({ raw: model, budgetUsd: 1 }), /groq is not USD-guarded/);
  assert.equal(calls.length, 0);
  assert.throws(() => parseCli(['--provider', 'groq', '--budget', '1'], config), /not USD-guarded/);
  const dir = tmp();
  const r = await base({ raw: raw('groq', { usage: (req) => (req.stage === 'extract' ? { outputTokens: 20_000 } : {}) }).model, resultsDir: dir, runs: 1 });
  assert.equal(r.stopped, null);
  assert.equal(attempt(dir, 'groq', 'HO-A', 1).status, 'ok');
  const ledger = JSON.parse(readFileSync(join(dir, 'groq', 'budget.json'), 'utf8'));
  assert.equal(ledger.exceeded, 2);
  assert.equal(ledger.stopped, false);
});

test('B22 I-3: casesHash is sha256 of JSON.stringify of the built cases, pinned in the ledger and in every attempt stamp', async () => {
  assert.equal(casesHash(), createHash('sha256').update(JSON.stringify(HELD_OUT_CASES)).digest('hex'));
  assert.equal(casesHash(), casesHash(HELD_OUT_CASES));
  assert.notEqual(casesHash(CASES), casesHash([CASES[1]!, CASES[0]!]));
  const dir = tmp();
  await base({ raw: raw('gemini').model, resultsDir: dir, runs: 1 });
  const ledger = JSON.parse(readFileSync(join(dir, 'gemini', 'budget.json'), 'utf8'));
  assert.equal(ledger.freeze.casesHash, casesHash(CASES));
  assert.equal(attempt(dir, 'gemini', 'HO-A', 1).stamp.casesHash, casesHash(CASES));
});

test('B22 I-3: a later batch refuses when the built cases differ from the pinned ones, or a stored attempt carries another cases hash', async () => {
  const dir = tmp();
  await base({ raw: raw('gemini').model, resultsDir: dir, runs: 1 });
  const changed = [{ ...CASES[0]!, trueNotes: ['n1'] }, CASES[1]!];
  const again = raw('gemini');
  await assert.rejects(base({ raw: again.model, resultsDir: dir, cases: changed }), /held-out cases hash .* differs from the one this batch began on/);
  assert.equal(again.calls.length, 0);
  const file = join(dir, 'gemini', 'HO-B', '1.json');
  const a = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...a, stamp: { ...a.stamp, casesHash: 'other' } }));
  await assert.rejects(base({ raw: raw('gemini').model, resultsDir: dir }), /stamped with cases hash other/);
});

test('B22 m1: a call that reports more input tokens than its reserved input estimate stops the batch like B12', async () => {
  const dir = tmp();
  const { model } = raw('gemini', { usage: (req) => (req.stage === 'extract' ? { inputTokens: 5_000_000 } : {}) });
  const r = await base({ raw: model, resultsDir: dir });
  assert.equal(r.stopped, 'budget');
  const a = attempt(dir, 'gemini', 'HO-A', 1);
  assert.equal(a.status, 'budget_stopped');
  assert.ok(a.error?.includes(RESERVATION_EXCEEDED));
  assert.match(a.error ?? '', /5000000 > \d+ input tokens/);
  assert.deepEqual(files(dir, 'gemini', 'HO-B'), []);
  const ledger = JSON.parse(readFileSync(join(dir, 'gemini', 'budget.json'), 'utf8'));
  assert.equal(ledger.exceeded, 1);
  assert.equal(ledger.stopped, true);
  assert.equal(ledger.stops[0].kind, 'budget');
});

test('B23: a reported input of 1.3 × chars/4 no longer stops the batch; 1.6 × still does', async () => {
  const est = (req: ModelRequest) => Math.ceil((req.system.length + req.user.length + JSON.stringify(req.schema).length) / 4);
  const ok = raw('gemini', { usage: (req) => (req.stage === 'extract' ? { inputTokens: Math.ceil(est(req) * 1.3) } : {}) });
  const r = await base({ raw: ok.model, resultsDir: tmp(), runs: 1 });
  assert.equal(r.stopped, null);
  assert.equal(r.ledger.exceeded, 0);
  const over = raw('gemini', { usage: (req) => (req.stage === 'extract' ? { inputTokens: Math.ceil(est(req) * 1.6) } : {}) });
  const r2 = await base({ raw: over.model, resultsDir: tmp(), runs: 1 });
  assert.equal(r2.stopped, 'budget');
  assert.equal(r2.ledger.exceeded, 1);
});

test('B23: a 400 json_validate_failed is a per-attempt provider_error, not a batch stop; any other 400 still stops', async () => {
  const dir = tmp();
  const bad = new ModelError('groq answered 400 json_validate_failed', { status: 400, retryable: false });
  const { model } = raw('groq', { fail: (req) => (req.stage === 'extract' && req.user.includes('HO-A') ? bad : null) });
  const r = await base({ raw: model, resultsDir: dir, runs: 1 });
  assert.equal(r.stopped, null);
  assert.equal(attempt(dir, 'groq', 'HO-A', 1).status, 'provider_error');
  assert.deepEqual(files(dir, 'groq', 'HO-B'), ['1.json']);
  assert.equal(stopFor(bad), null);
  assert.equal(stopFor(new ModelError('groq answered 400 invalid_request', { status: 400, retryable: false }))?.kind, 'provider');
});

test('B23: only outage-type provider errors (408, 5xx, timed out, unreachable) count toward the consecutive stop; model-output failures do not', async () => {
  const outageKinds = [new ModelError('gemini answered 408', { status: 408, retryable: true }), new ModelError('gemini timed out', { retryable: true }), new ModelError('gemini unreachable', { retryable: true })];
  for (const e of outageKinds) {
    const r = await base({ raw: raw('gemini', { fail: () => e }).model, resultsDir: tmp() });
    assert.equal(r.stopped, 'provider', e.message);
  }
  for (const e of [new ModelError('gemini returned invalid JSON'), new ModelError('gemini hit the max tokens'), new ModelError('gemini: no text (safety)')]) {
    const dir = tmp();
    const r = await base({ raw: raw('gemini', { fail: () => e }).model, resultsDir: dir });
    assert.equal(r.stopped, null, e.message);
    assert.equal(r.written.length, 6);
    assert.equal(attempt(dir, 'gemini', 'HO-A', 1).status, 'provider_error');
  }
  assert.deepEqual([isOutage(new ModelError('x', { status: 500 })), isOutage(new ModelError('x', { status: 400 })), isOutage(new ModelError('invalid JSON'))], [true, false, false]);
});
