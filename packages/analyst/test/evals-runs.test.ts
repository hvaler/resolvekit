import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ModelError, withRetries, type AnalystModel, type ModelRequest } from '../src/model.ts';
import { PROMPT_VERSION } from '../src/prompts.ts';
import { GroqModel } from '../src/providers.ts';
import { BudgetExceeded, LIST_PRICE, budgetGuard, newLedger, reservationUsd, usageUsd } from '../evals/budget.ts';
import type { HeldOutCase } from '../evals/heldout/schema.ts';
import { FROZEN_PATHS, loadConfig, runHeldOut, type Attempt, type Git, type HeldOutConfig } from '../evals/runs.ts';
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
function raw(provider: 'gemini' | 'groq', o: { fail?: (req: ModelRequest, n: number) => Error | null; returned?: string } = {}) {
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
      return { json: r.json, usage: { ...r.usage, ...USAGE, model: o.returned ?? config.models[provider] } };
    },
  };
  return { model, calls };
}

/** git as the runner sees it: a clean tree, HEAD c0de, freeze commit f00; `over` replaces one answer (a thrown Error = non-zero exit). */
function fakeGit(over: { status?: string; diff?: Error } = {}): Git & { seen: string[][] } {
  const seen: string[][] = [];
  const g = ((args: string[]) => {
    seen.push(args);
    if (args[0] === 'rev-parse') return 'c0de';
    if (args[0] === 'log') return 'f00';
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
  runHeldOut({ provider: o.raw.provider as 'gemini' | 'groq', cases: CASES, config, runs: 3, budgetUsd: 1, resultsDir: tmp(), git: fakeGit(), retry: { sleep: noSleep }, log: () => {}, ...o });

test('config: the frozen values (models, runs, budget, list price, thinking reserve, negation window, prompt version)', () => {
  assert.deepEqual(config, {
    promptVersion: 'rk-analyst-2026-10-09.7',
    models: { gemini: 'gemini-3.8-flash', groq: 'openai/gpt-oss-120b' },
    runs: 3,
    budgetUsd: 1.0,
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
  // Even if the skip check were bypassed, the write would fail: the runner reports the existing file and keeps it.
  const r = await base({ raw: raw('gemini').model, resultsDir: dir, runs: 1, cases: [CASES[0]!] });
  assert.equal(r.written.length, 0);
  assert.equal(readFileSync(file, 'utf8'), 'sentinel');
});

test('the guard reserves the worst case: ceil(chars/4) × 1.25 input, max output plus the thinking reserve, at list price', () => {
  const req: ModelRequest = { stage: 'x', system: 'a'.repeat(400), user: 'b'.repeat(399), schema: {}, maxOutputTokens: 1000 };
  const chars = 400 + 399 + JSON.stringify({}).length;
  const inTok = Math.ceil(Math.ceil(chars / 4) * 1.25);
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

test('a 429 that the retries cannot clear is a provider_error and the batch continues (gemini)', async () => {
  const dir = tmp();
  const { model } = raw('gemini', { fail: always429('HO-A') });
  const r = await base({ raw: model, resultsDir: dir, runs: 1 });
  assert.equal(r.stopped, null);
  const a = attempt(dir, 'gemini', 'HO-A', 1);
  assert.equal(a.status, 'provider_error');
  assert.match(a.error ?? '', /429/);
  assert.ok(a.usage.unknownUsd > 0);
  assert.equal(attempt(dir, 'gemini', 'HO-B', 1).status, 'ok');
});

test('a 429 that the retries cannot clear is a provider_error and the batch stops (groq quota)', async () => {
  const dir = tmp();
  const { model } = raw('groq', { fail: always429('HO-A') });
  const r = await base({ raw: model, resultsDir: dir, runs: 1 });
  assert.equal(r.stopped, 'quota');
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
});

test('the runner refuses to start when a frozen file differs from the freeze commit', async () => {
  const { model, calls } = raw('gemini');
  const git = fakeGit({ diff: new Error('exit 1') });
  await assert.rejects(base({ raw: model, git }), /differ from the freeze commit f00/);
  assert.equal(calls.length, 0);
  const diff = git.seen.find((a) => a[0] === 'diff')!;
  assert.deepEqual(diff, ['diff', '--quiet', 'f00', 'HEAD', '--', ...FROZEN_PATHS]);
  assert.deepEqual(FROZEN_PATHS, [
    'packages/analyst/evals/heldout/cases.ts',
    'packages/analyst/evals/heldout/schema.ts',
    'packages/analyst/evals/heldout/config.json',
    'packages/analyst/evals/strict.ts',
    'packages/analyst/evals/metrics.ts',
  ]);
});

test('the runner refuses to start on a prompt version, model or budget other than the frozen config, or on no cases', async () => {
  const { model, calls } = raw('gemini');
  await assert.rejects(base({ raw: model, config: { ...config, promptVersion: 'rk-analyst-other' } }), /PROMPT_VERSION/);
  await assert.rejects(base({ raw: { ...model, model: 'gemini-other', generate: model.generate } }), /pinned model/);
  await assert.rejects(base({ raw: model, budgetUsd: 1.5 }), /budget/);
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
