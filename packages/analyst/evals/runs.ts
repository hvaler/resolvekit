/**
 * Repeated runs of the frozen held-out set against ONE real provider (no fallback). Every attempt is a file of its
 * own, results/heldout/<provider>/<case>/<run>.json, opened exclusively: an attempt is never written over, never
 * replaced, never picked. Runs are run-major (every case for run 1, then run 2, …); a later batch skips the attempt
 * files that exist, so a stopped batch resumes where it stopped. Each attempt calls analyzeCase afresh.
 *
 *   npm run evals:heldout -- --provider gemini|groq [--runs 3] [--budget 1.00] [--case name] [--from-run n]
 *
 * It refuses to start unless the tree under packages/analyst is committed, the frozen files are those of the freeze
 * commit, and PROMPT_VERSION, the model and the limits are the frozen config's (heldout/config.json). The budget
 * guard (budget.ts) checks every HTTP attempt; its ledger is results/heldout/<provider>/budget.json. Gemini: a
 * provider error is stored and the batch goes on. Groq: a 429 the retries cannot clear is stored and the batch stops
 * (its free quota is spent). Either: a refused call stops the batch.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelError, withRetries, type AnalystModel, type RetryOptions } from '../src/model.ts';
import { analyzeCase } from '../src/pipeline.ts';
import { PROMPT_VERSION } from '../src/prompts.ts';
import { GeminiModel, GroqModel } from '../src/providers.ts';
import type { CaseAnalysis } from '../src/types.ts';
import { BUDGET_NOTE, BudgetExceeded, LIST_PRICE, budgetGuard, committedUsd, newLedger, type GuardEvent, type Ledger } from './budget.ts';
import { HELD_OUT_CASES } from './heldout/cases.ts';
import type { HeldOutCase } from './heldout/schema.ts';

export type Provider = 'gemini' | 'groq';

export interface HeldOutConfig {
  promptVersion: string;
  models: Record<Provider, string>;
  runs: number;
  budgetUsd: number;
  listPrice: { inputPerM: number; outputPerM: number };
  thinkingReserveTokens: Record<Provider, number>;
  negationWindowWords: number;
}

export const CONFIG_FILE = fileURLToPath(new URL('./heldout/config.json', import.meta.url));
export const loadConfig = (): HeldOutConfig => JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as HeldOutConfig;

/** Repo-relative: the files that must be byte-identical to the freeze commit for the batch to start. */
export const FROZEN_PATHS = [
  'packages/analyst/evals/heldout/cases.ts',
  'packages/analyst/evals/heldout/schema.ts',
  'packages/analyst/evals/heldout/config.json',
  'packages/analyst/evals/strict.ts',
  'packages/analyst/evals/metrics.ts',
];
const HELDOUT_DIR = 'packages/analyst/evals/heldout';
const RESULTS_REL = 'packages/analyst/evals/results/heldout';
export const RESULTS_DIR = fileURLToPath(new URL('./results/heldout/', import.meta.url));

/** git in the repository root; throws on a non-zero exit. */
export type Git = (args: string[]) => string;
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
export const realGit: Git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export interface Attempt {
  provider: Provider;
  case: string;
  run: number;
  status: 'ok' | 'provider_error' | 'product_error' | 'budget_stopped';
  startedAt: string;
  finishedAt: string;
  error?: string;
  stamp: { codeCommit: string; freezeCommit: string; promptVersion: string; requestedModel: string; returnedModels: string[] };
  /**
   * This attempt's HTTP attempts (retries included) at list price, apart: observed (reported usage), unknown (failed
   * after being sent, no usage: the whole reservation) and estimated (never settled; 0 once the attempt ends).
   * `calls` counts the answered ones, `httpAttempts` every one sent, `refused` the guard's refusals (never sent).
   */
  usage: {
    calls: number;
    httpAttempts: number;
    refused: number;
    inputTokens: number;
    outputTokens: number;
    thinkingTokens: number;
    observedUsd: number;
    unknownUsd: number;
    estimatedUsd: number;
    costUsdAtListPrice: number;
    note: string;
  };
  /** Only on status ok: the analysis that is scored. */
  analysis?: CaseAnalysis;
  /** An analysis that completed although the guard refused one of its calls (one the pipeline tolerates, e.g. the screen): kept, never scored. */
  degradedAnalysis?: CaseAnalysis;
}

export interface BatchOptions {
  provider: Provider;
  /** The raw provider model; the runner puts the budget guard on it, then the retries. */
  raw: AnalystModel;
  cases: readonly HeldOutCase[];
  config: HeldOutConfig;
  runs: number;
  budgetUsd: number;
  only?: string;
  fromRun?: number;
  resultsDir?: string;
  git?: Git;
  retry?: RetryOptions;
  log?: (line: string) => void;
}

export interface BatchResult {
  written: string[];
  skipped: string[];
  stopped: null | 'budget' | 'quota';
  ledger: Ledger;
}

/** The start conditions; throws with the reason. Returns the stamp's commits. */
export function preflight(o: Pick<BatchOptions, 'provider' | 'raw' | 'cases' | 'config' | 'runs' | 'budgetUsd'>, git: Git): { codeCommit: string; freezeCommit: string } {
  const c = o.config;
  if (PROMPT_VERSION !== c.promptVersion) throw new Error(`PROMPT_VERSION is ${PROMPT_VERSION}; the frozen config says ${c.promptVersion}`);
  if (LIST_PRICE.inputPerM !== c.listPrice.inputPerM || LIST_PRICE.outputPerM !== c.listPrice.outputPerM) throw new Error('the list price in budget.ts differs from the frozen config');
  if (o.raw.provider !== o.provider || o.raw.model !== c.models[o.provider]) throw new Error(`the model is ${o.raw.provider}/${o.raw.model}; the pinned model is ${o.provider}/${c.models[o.provider]}`);
  if (!(o.runs >= 1 && o.runs <= c.runs && Number.isInteger(o.runs))) throw new Error(`runs must be 1..${c.runs} (frozen config)`);
  if (!(o.budgetUsd > 0 && o.budgetUsd <= c.budgetUsd)) throw new Error(`the budget must be above 0 and at most ${c.budgetUsd.toFixed(2)} USD (frozen config)`);
  if (o.cases.length === 0) throw new Error('no held-out cases: heldout/cases.ts is empty');
  // The batch's own attempt files are the only thing allowed to change under packages/analyst while it runs.
  const dirty = git(['status', '--porcelain', '--', 'packages/analyst', `:(exclude)${RESULTS_REL}`]);
  if (dirty) throw new Error(`uncommitted changes under packages/analyst:\n${dirty}`);
  const codeCommit = git(['rev-parse', 'HEAD']);
  const freezeCommit = git(['log', '-1', '--format=%H', '--', HELDOUT_DIR]);
  if (!freezeCommit) throw new Error(`no freeze commit: ${HELDOUT_DIR} has never been committed`);
  try {
    git(['diff', '--quiet', freezeCommit, 'HEAD', '--', ...FROZEN_PATHS]);
  } catch {
    throw new Error(`the frozen files differ from the freeze commit ${freezeCommit}: ${FROZEN_PATHS.join(', ')}`);
  }
  return { codeCommit, freezeCommit };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runHeldOut(o: BatchOptions): Promise<BatchResult> {
  const log = o.log ?? console.log;
  const { codeCommit, freezeCommit } = preflight(o, o.git ?? realGit);
  const dir = join(o.resultsDir ?? RESULTS_DIR, o.provider);
  mkdirSync(dir, { recursive: true });

  // One ledger per provider for the whole batch, carried over from a stopped batch (what it counted stays counted).
  const ledgerFile = join(dir, 'budget.json');
  const ledger: Ledger = existsSync(ledgerFile) ? { ...newLedger(o.provider, o.budgetUsd), ...JSON.parse(readFileSync(ledgerFile, 'utf8')) } : newLedger(o.provider, o.budgetUsd);
  ledger.limitUsd = o.budgetUsd;
  ledger.note = BUDGET_NOTE;
  const persist = () => writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2) + '\n');
  persist();

  let events: GuardEvent[] = [];
  /** Errors the provider itself threw: an analyzeCase failure that is one of them is a provider error. */
  const providerErrors = new WeakSet<object>();
  const guarded = budgetGuard(o.raw, {
    ledger,
    thinkingReserveTokens: o.config.thinkingReserveTokens[o.provider],
    onChange: persist,
    onEvent: (e) => {
      events.push(e);
      if (e.kind === 'unknown' && e.error && typeof e.error === 'object') providerErrors.add(e.error);
    },
  });
  // Same retries as the development runner (evals/run.ts): Groq waits out its per-minute token budget.
  const retryDefaults: RetryOptions = o.provider === 'groq' ? { retries: 3, maxDelayMs: 65_000 } : { retries: 2 };
  const model = withRetries(guarded, { ...retryDefaults, ...o.retry });

  const result: BatchResult = { written: [], skipped: [], stopped: null, ledger };
  const cases = o.only ? o.cases.filter((c) => c.name === o.only) : o.cases;
  if (o.only && cases.length === 0) throw new Error(`no held-out case named ${o.only}`);
  log(`${o.provider}/${o.config.models[o.provider]} · ${PROMPT_VERSION} · freeze ${freezeCommit.slice(0, 12)} · code ${codeCommit.slice(0, 12)} · limit ${o.budgetUsd.toFixed(2)} USD. ${BUDGET_NOTE}`);

  batch: for (let run = o.fromRun ?? 1; run <= o.runs; run++) {
    for (const c of cases) {
      const file = join(dir, c.name, `${run}.json`);
      if (existsSync(file)) {
        result.skipped.push(file);
        continue;
      }
      if (ledger.stopped) {
        result.stopped = 'budget';
        break batch;
      }
      events = [];
      const startedAt = new Date().toISOString();
      let status: Attempt['status'];
      let analysis: CaseAnalysis | undefined;
      let error: string | undefined;
      let quota = false;
      try {
        analysis = await analyzeCase(c.input, { model, requestedModel: o.config.models[o.provider] });
        status = 'ok';
      } catch (e) {
        error = message(e);
        if (e instanceof BudgetExceeded) status = 'budget_stopped';
        else if (e && typeof e === 'object' && providerErrors.has(e)) {
          status = 'provider_error';
          quota = o.provider === 'groq' && e instanceof ModelError && e.status === 429;
        } else status = 'product_error';
      }
      const refused = events.filter((e) => e.kind === 'refused');
      // A refusal the pipeline tolerated (a call whose failure it absorbs) still means the attempt is not whole.
      if (refused.length > 0 && status !== 'budget_stopped') {
        error = error ?? `budget: ${refused.length} call(s) refused during the attempt. ${BUDGET_NOTE}`;
        status = 'budget_stopped';
      }
      const observed = events.flatMap((e) => (e.kind === 'observed' ? [e] : []));
      const unknownUsd = events.reduce((a, e) => a + (e.kind === 'unknown' ? e.usd : 0), 0);
      const observedUsd = observed.reduce((a, e) => a + e.usd, 0);
      const a: Attempt = {
        provider: o.provider,
        case: c.name,
        run,
        status,
        startedAt,
        finishedAt: new Date().toISOString(),
        ...(error !== undefined ? { error } : {}),
        stamp: { codeCommit, freezeCommit, promptVersion: PROMPT_VERSION, requestedModel: o.config.models[o.provider], returnedModels: [...new Set(observed.map((e) => e.usage.model))].sort() },
        usage: {
          calls: observed.length,
          httpAttempts: events.filter((e) => e.kind !== 'refused').length,
          refused: refused.length,
          inputTokens: observed.reduce((s, e) => s + e.usage.inputTokens, 0),
          outputTokens: observed.reduce((s, e) => s + e.usage.outputTokens, 0),
          thinkingTokens: observed.reduce((s, e) => s + e.usage.thinkingTokens, 0),
          observedUsd,
          unknownUsd,
          // The attempt has ended, so every reservation it made has settled.
          estimatedUsd: 0,
          costUsdAtListPrice: observedUsd + unknownUsd,
          note: BUDGET_NOTE,
        },
        ...(analysis && status === 'ok' ? { analysis } : {}),
        ...(analysis && status !== 'ok' ? { degradedAnalysis: analysis } : {}),
      };
      mkdirSync(join(dir, c.name), { recursive: true });
      try {
        writeFileSync(file, JSON.stringify(a, null, 2) + '\n', { flag: 'wx' });
      } catch (e) {
        // Another process wrote this attempt meanwhile: keep its file, report it, stop.
        throw new Error(`${file} exists; attempts are never written over (${message(e)})`);
      }
      result.written.push(file);
      log(`${c.name} run ${run}: ${status}${error ? ` · ${error}` : ''} · ${a.usage.httpAttempts} HTTP attempts · ${a.usage.costUsdAtListPrice.toFixed(4)} USD at list price · batch ${committedUsd(ledger).toFixed(4)} of ${o.budgetUsd.toFixed(2)} USD`);
      if (status === 'budget_stopped') {
        result.stopped = 'budget';
        break batch;
      }
      if (quota) {
        result.stopped = 'quota';
        break batch;
      }
    }
  }
  persist();
  log(
    `${result.written.length} attempts written, ${result.skipped.length} existing kept${result.stopped ? ` · stopped (${result.stopped})` : ''} · ledger: observed ${ledger.observedUsd.toFixed(4)}, estimated ${ledger.estimatedUsd.toFixed(4)}, unknown ${ledger.unknownUsd.toFixed(4)} USD at list price. ${BUDGET_NOTE}`,
  );
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const provider = (opt('--provider') ?? 'gemini') as Provider;
  if (provider !== 'gemini' && provider !== 'groq') throw new Error('--provider gemini|groq');
  const config = loadConfig();
  let raw: AnalystModel;
  if (provider === 'groq') {
    if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');
    raw = new GroqModel({ apiKey: process.env.GROQ_API_KEY, model: config.models.groq, tpm: Number(process.env.GROQ_TPM) || 8_000 });
  } else {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
    raw = new GeminiModel({ apiKey: process.env.GEMINI_API_KEY, model: config.models.gemini });
  }
  const r = await runHeldOut({
    provider,
    raw,
    cases: HELD_OUT_CASES,
    config,
    runs: Number(opt('--runs') ?? config.runs),
    budgetUsd: Number(opt('--budget') ?? config.budgetUsd),
    only: opt('--case'),
    fromRun: opt('--from-run') ? Number(opt('--from-run')) : undefined,
  });
  if (r.stopped) process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(message(e));
    process.exitCode = 1;
  });
}
