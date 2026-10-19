/**
 * Repeated runs of the frozen held-out set against ONE real provider (no fallback). Every attempt is a file of its
 * own, results/heldout/<provider>/<case>/<run>.json, opened exclusively: an attempt is never written over, never
 * replaced, never picked. Runs are run-major (every case for run 1, then run 2, …); a later batch skips the attempt
 * files that exist, so a stopped batch resumes where it stopped. Each attempt calls analyzeCase afresh.
 *
 *   npm run evals:heldout -- --provider gemini|groq [--runs 3] [--budget 1.00, gemini only] [--case name] [--from-run n]
 *
 * It refuses to start unless the tree under packages/analyst (and the server files the held-out inputs are built
 * with) is committed, the frozen files are those of the freeze commit, and PROMPT_VERSION, the model and the limits
 * are the frozen config's (heldout/config.json). The budget guard (budget.ts) checks every HTTP attempt; its ledger
 * is results/heldout/<provider>/budget.json. The limit is per provider (ruling B22): Gemini has a hard USD limit;
 * Groq has none (its figures are recorded at Gemini list price, labelled not a Groq price) and runs within its free
 * quota. Every failed attempt is stored; the batch then stops (B22), so no held-out slot is burnt on a fault that
 * would fail every later one, when: a call ends in a non-retryable 4xx other than 429 (a key, billing or model id
 * problem); a 429 survives the retries (either provider); 2 attempts in a row end in provider_error; the guard
 * refuses a call; or a call reported more than its reservation (Gemini). Every stop is recorded with its reason in
 * the ledger's `stops` and printed. An analysis made while any model call failed for good (the pipeline absorbs
 * screen, verify and explain failures) is never `ok`: it is kept as `degradedAnalysis`. The first batch pins the
 * freeze commit, a hash of the frozen files and a hash of the built held-out cases in budget.json; a later batch on
 * another freeze, other bytes, other cases, or attempts stamped otherwise refuses.
 * Exit codes: 3 the batch stopped (budget, quota or provider), 2 a usage error, 1 a refusal to start or another failure.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelError, withRetries, type AnalystModel, type RetryOptions } from '../src/model.ts';
import { analyzeCase } from '../src/pipeline.ts';
import { PROMPT_VERSION } from '../src/prompts.ts';
import { GeminiModel, GroqModel } from '../src/providers.ts';
import type { CaseAnalysis } from '../src/types.ts';
import { BudgetExceeded, LIST_PRICE, NOT_A_GROQ_PRICE, RESERVATION_EXCEEDED, budgetGuard, budgetNote, committedUsd, newLedger, type GuardEvent, type Ledger, type StopRecord } from './budget.ts';
import { HELD_OUT_CASES } from './heldout/cases.ts';
import type { HeldOutCase } from './heldout/schema.ts';

export type Provider = 'gemini' | 'groq';

export interface HeldOutConfig {
  promptVersion: string;
  models: Record<Provider, string>;
  runs: number;
  /** Per provider (ruling B22): a hard USD limit, or null for no USD guard (Groq: free quota only). */
  budgetUsd: Record<Provider, number | null>;
  listPrice: { inputPerM: number; outputPerM: number };
  thinkingReserveTokens: Record<Provider, number>;
  negationWindowWords: number;
}

export const CONFIG_FILE = fileURLToPath(new URL('./heldout/config.json', import.meta.url));
export const loadConfig = (): HeldOutConfig => JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as HeldOutConfig;

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const FROZEN_STATIC = [
  'packages/analyst/evals/heldout/cases.ts',
  'packages/analyst/evals/heldout/schema.ts',
  'packages/analyst/evals/heldout/config.json',
  'packages/analyst/evals/strict.ts',
  'packages/analyst/evals/metrics.ts',
  'packages/analyst/evals/heldout/score.ts',
  'packages/analyst/evals/heldout/manual-judgements.json',
  // The held-out upload inputs are built with the server's uploadDocuments and typed by its UploadRecord (B22).
  'apps/server/src/uploads/documents.ts',
  'apps/server/src/uploads/store.ts',
];
/** Outside packages/analyst, checked for uncommitted changes with it. */
const FROZEN_OUTSIDE = FROZEN_STATIC.filter((p) => !p.startsWith('packages/analyst/'));
const FROZEN_SRC_DIR = 'packages/analyst/src';
/** The batch code is part of what is measured too (ruling B20), next to the system under test in src. */
const FROZEN_BATCH = ['packages/analyst/evals/runs.ts', 'packages/analyst/evals/budget.ts'];

/**
 * Repo-relative: the files that must be byte-identical to the freeze commit for the batch to start, and whose hash the
 * first batch pins in budget.json (ruling B14). The freeze commit is the last commit touching any of them (B15). The
 * system under test is frozen with the set (B20): every .ts file under packages/analyst/src, found by listing the
 * directory (sorted, so a new src file is frozen too), plus the batch code runs.ts and budget.ts. The server files the
 * held-out upload inputs are built with are frozen too (B22). A listed file that does not exist refuses the start.
 */
export function listFrozenPaths(root = REPO): string[] {
  const src = readdirSync(join(root, FROZEN_SRC_DIR), { recursive: true, encoding: 'utf8' })
    .map((f) => f.replaceAll('\\', '/'))
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => `${FROZEN_SRC_DIR}/${f}`);
  return [...FROZEN_STATIC, ...src, ...FROZEN_BATCH];
}
export const FROZEN_PATHS: readonly string[] = listFrozenPaths();
const RESULTS_REL = 'packages/analyst/evals/results/heldout';
export const RESULTS_DIR = fileURLToPath(new URL('./results/heldout/', import.meta.url));

/** git in the repository root; throws on a non-zero exit. */
export type Git = (args: string[]) => string;
export const realGit: Git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** sha256 over each frozen file's path and bytes, in FROZEN_PATHS order. */
export function frozenHash(paths: readonly string[] = FROZEN_PATHS, root = REPO): string {
  const h = createHash('sha256');
  for (const p of paths) {
    const file = join(root, p);
    if (!existsSync(file)) throw new Error(`frozen file missing: ${p}`);
    h.update(`${p}\0`).update(readFileSync(file)).update('\0');
  }
  return h.digest('hex');
}

/**
 * sha256 of JSON.stringify of the built held-out cases (inputs as built, uploads included, labels, forbidden outcomes):
 * what the batch actually sends and scores against, pinned with the freeze (ruling B22).
 */
export const casesHash = (cases: readonly HeldOutCase[] = HELD_OUT_CASES): string => createHash('sha256').update(JSON.stringify(cases)).digest('hex');

export interface Attempt {
  provider: Provider;
  case: string;
  run: number;
  status: 'ok' | 'provider_error' | 'product_error' | 'budget_stopped';
  startedAt: string;
  finishedAt: string;
  error?: string;
  stamp: { codeCommit: string; freezeCommit: string; casesHash: string; promptVersion: string; requestedModel: string; returnedModels: string[] };
  /**
   * This attempt's HTTP attempts (retries included) at list price, apart: observed (reported usage), unknown (failed
   * after being sent, no usage: the whole reservation) and estimated (never settled; 0 once the attempt ends).
   * `calls` counts the answered ones, `httpAttempts` every one sent, `refused` the guard's refusals (never sent).
   * For Groq the USD figures are estimated at Gemini list price, not a Groq price (`note` says so).
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
  /** The USD limit, at most the frozen config's; null where the config gives none (Groq). */
  budgetUsd: number | null;
  only?: string;
  fromRun?: number;
  resultsDir?: string;
  /** The hash of the frozen files (default: frozenHash() of the working tree, which preflight requires clean). */
  hash?: string;
  git?: Git;
  retry?: RetryOptions;
  log?: (line: string) => void;
}

export interface BatchResult {
  written: string[];
  skipped: string[];
  stopped: null | StopRecord['kind'];
  /** Why the batch stopped, as recorded in the ledger's `stops`. */
  stopReason: string | null;
  ledger: Ledger;
}

/**
 * Why a call that failed for good stops the batch (ruling B22), or null: a 429 that survived the retries (quota or
 * rate limit, either provider), or a non-retryable 4xx other than 429 (bad key, billing, model id: every later call
 * would fail the same way). A budget refusal is handled apart.
 */
export function stopFor(e: unknown): { kind: 'quota' | 'provider'; reason: string } | null {
  if (!(e instanceof ModelError) || e instanceof BudgetExceeded || e.status === null) return null;
  if (e.status === 429) return { kind: 'quota', reason: `a 429 survived the retries (quota or rate limit): ${e.message}` };
  if (e.status >= 400 && e.status < 500 && !e.retryable) return { kind: 'provider', reason: `the provider refused a call with HTTP ${e.status} (a key, billing or model id problem; retrying cannot help): ${e.message}` };
  return null;
}
/** Consecutive provider_error attempts that stop the batch (ruling B22). */
export const MAX_CONSECUTIVE_PROVIDER_ERRORS = 2;

/** The start conditions; throws with the reason. Returns the stamp's commits. */
export function preflight(o: Pick<BatchOptions, 'provider' | 'raw' | 'cases' | 'config' | 'runs' | 'budgetUsd'>, git: Git): { codeCommit: string; freezeCommit: string } {
  const c = o.config;
  if (PROMPT_VERSION !== c.promptVersion) throw new Error(`PROMPT_VERSION is ${PROMPT_VERSION}; the frozen config says ${c.promptVersion}`);
  if (LIST_PRICE.inputPerM !== c.listPrice.inputPerM || LIST_PRICE.outputPerM !== c.listPrice.outputPerM) throw new Error('the list price in budget.ts differs from the frozen config');
  if (o.raw.provider !== o.provider || o.raw.model !== c.models[o.provider]) throw new Error(`the model is ${o.raw.provider}/${o.raw.model}; the pinned model is ${o.provider}/${c.models[o.provider]}`);
  if (!(o.runs >= 1 && o.runs <= c.runs && Number.isInteger(o.runs))) throw new Error(`runs must be 1..${c.runs} (frozen config)`);
  const limit = c.budgetUsd[o.provider];
  if (limit === null) {
    if (o.budgetUsd !== null) throw new Error(`${o.provider} is not USD-guarded in the frozen config (budgetUsd.${o.provider} is null): no budget can be given`);
  } else if (!(o.budgetUsd !== null && o.budgetUsd > 0 && o.budgetUsd <= limit)) throw new Error(`the budget must be above 0 and at most ${limit.toFixed(2)} USD (frozen config)`);
  if (o.cases.length === 0) throw new Error('no held-out cases: heldout/cases.ts is empty');
  // The batch's own attempt files are the only thing allowed to change under packages/analyst while it runs.
  const dirty = git(['status', '--porcelain', '--', 'packages/analyst', ...FROZEN_OUTSIDE, `:(exclude)${RESULTS_REL}`]);
  if (dirty) throw new Error(`uncommitted changes under packages/analyst or in the frozen server files:\n${dirty}`);
  const codeCommit = git(['rev-parse', 'HEAD']);
  const frozen = listFrozenPaths();
  const freezeCommit = git(['log', '-1', '--format=%H', '--', ...frozen]);
  if (!freezeCommit) throw new Error('no freeze commit: none of the frozen files has ever been committed');
  try {
    git(['diff', '--quiet', freezeCommit, 'HEAD', '--', ...frozen]);
  } catch {
    throw new Error(`the frozen files differ from the freeze commit ${freezeCommit}: ${frozen.join(', ')}`);
  }
  return { codeCommit, freezeCommit };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Every <case>/<run>.json under a provider's results directory. */
function existingAttempts(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => readdirSync(join(dir, d.name)).filter((f) => f.endsWith('.json')).map((f) => join(dir, d.name, f)))
    .sort();
}

export async function runHeldOut(o: BatchOptions): Promise<BatchResult> {
  const log = o.log ?? console.log;
  if (o.fromRun !== undefined && !(Number.isInteger(o.fromRun) && o.fromRun >= 1 && o.fromRun <= o.runs)) throw new Error(`--from-run must be an integer from 1 to ${o.runs}`);
  const { codeCommit, freezeCommit } = preflight(o, o.git ?? realGit);
  const hash = o.hash ?? frozenHash(listFrozenPaths());
  const cHash = casesHash(o.cases);
  const dir = join(o.resultsDir ?? RESULTS_DIR, o.provider);

  // One ledger per provider for the whole batch, carried over from a stopped batch (what it counted stays counted).
  const ledgerFile = join(dir, 'budget.json');
  const ledger: Ledger = existsSync(ledgerFile) ? { ...newLedger(o.provider, o.budgetUsd), ...JSON.parse(readFileSync(ledgerFile, 'utf8')) } : newLedger(o.provider, o.budgetUsd);
  // The freeze is pinned by the first batch (B14): every later batch runs on the same freeze commit and the same
  // frozen bytes, and every attempt already stored carries that freeze in its stamp.
  const stored = existingAttempts(dir);
  if (ledger.freeze) {
    if (ledger.freeze.commit !== freezeCommit) throw new Error(`the freeze commit is ${freezeCommit}; this batch began on ${ledger.freeze.commit}`);
    if (ledger.freeze.hash !== hash) throw new Error(`the frozen files' hash differs from the one this batch began on (${ledger.freeze.hash.slice(0, 12)})`);
    if (ledger.freeze.casesHash !== cHash) throw new Error(`the held-out cases hash ${cHash.slice(0, 12)} differs from the one this batch began on (${String(ledger.freeze.casesHash).slice(0, 12)})`);
  } else if (stored.length > 0) throw new Error(`${stored.length} attempt file(s) exist but no ledger pins their freeze`);
  for (const f of stored) {
    let stamp: Partial<Attempt['stamp']> | undefined;
    try {
      stamp = (JSON.parse(readFileSync(f, 'utf8')) as Attempt).stamp;
    } catch {
      throw new Error(`${f} is unreadable; nothing starts until it has been looked at`);
    }
    if (stamp?.freezeCommit !== freezeCommit) throw new Error(`${f} is stamped with freeze ${stamp?.freezeCommit}; the current freeze is ${freezeCommit}`);
    if (stamp.casesHash !== cHash) throw new Error(`${f} is stamped with cases hash ${stamp.casesHash}; the current cases hash is ${cHash}`);
  }
  mkdirSync(dir, { recursive: true });
  ledger.freeze = { commit: freezeCommit, hash, casesHash: cHash };
  ledger.limitUsd = o.budgetUsd;
  ledger.stops = ledger.stops ?? [];
  const note = budgetNote(o.budgetUsd);
  ledger.note = note;
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
  const retried = withRetries(guarded, { ...retryDefaults, ...o.retry });
  // Logical calls that failed for good (after their retries), those the pipeline absorbs included (screen, verify,
  // explain): an analysis made while one of them failed is not whole (B13).
  let failures: unknown[] = [];
  const model: AnalystModel = {
    provider: retried.provider,
    model: retried.model,
    generate: (req) =>
      retried.generate(req).catch((e: unknown) => {
        failures.push(e);
        throw e;
      }),
  };
  // Gemini: a hard USD limit. Groq: none (B22); its USD figures are recorded, labelled as not a Groq price.
  const usdGuarded = o.budgetUsd !== null;
  const usdLabel = usdGuarded ? 'USD at list price' : `USD ${NOT_A_GROQ_PRICE}`;
  const batchUsd = () => (o.budgetUsd !== null ? `batch ${committedUsd(ledger).toFixed(4)} of ${o.budgetUsd.toFixed(2)} USD` : `batch ${committedUsd(ledger).toFixed(4)} ${usdLabel} (not USD-guarded)`);

  const result: BatchResult = { written: [], skipped: [], stopped: null, stopReason: null, ledger };
  /** The batch stops here: the reason goes to the result and, with the attempt it came from, to the ledger (B22). */
  const stop = (kind: StopRecord['kind'], reason: string, kase: string, run: number) => {
    result.stopped = kind;
    result.stopReason = reason;
    ledger.stops.push({ kind, reason, case: kase, run, at: new Date().toISOString() });
    persist();
  };
  /** provider_error attempts in a row; MAX_CONSECUTIVE_PROVIDER_ERRORS of them stop the batch (B22). */
  let providerErrorsInARow = 0;
  const cases = o.only ? o.cases.filter((c) => c.name === o.only) : o.cases;
  if (o.only && cases.length === 0) throw new Error(`no held-out case named ${o.only}`);
  log(`${o.provider}/${o.config.models[o.provider]} · ${PROMPT_VERSION} · freeze ${freezeCommit.slice(0, 12)} · cases ${cHash.slice(0, 12)} · code ${codeCommit.slice(0, 12)} · limit ${o.budgetUsd !== null ? `${o.budgetUsd.toFixed(2)} USD` : 'none (not USD-guarded)'}. ${note}`);

  batch: for (let run = o.fromRun ?? 1; run <= o.runs; run++) {
    for (const c of cases) {
      const file = join(dir, c.name, `${run}.json`);
      if (existsSync(file)) {
        result.skipped.push(file);
        continue;
      }
      if (ledger.stopped) {
        // An earlier budget stop stays (B15): nothing more is started on this ledger.
        result.stopped = 'budget';
        result.stopReason = `the ledger was stopped by an earlier budget stop (${ledger.stops.findLast((s) => s.kind === 'budget')?.reason ?? 'no reason recorded'})`;
        break batch;
      }
      events = [];
      failures = [];
      const startedAt = new Date().toISOString();
      let status: Attempt['status'];
      let analysis: CaseAnalysis | undefined;
      let error: string | undefined;
      try {
        analysis = await analyzeCase(c.input, { model, requestedModel: o.config.models[o.provider] });
        status = 'ok';
      } catch (e) {
        error = message(e);
        if (e instanceof BudgetExceeded) status = 'budget_stopped';
        else if (e && typeof e === 'object' && providerErrors.has(e)) status = 'provider_error';
        else status = 'product_error';
      }
      // The analysis came back although a call failed for good: it is kept as degraded, never scored.
      const failed = failures.find((e) => !(e instanceof BudgetExceeded));
      if (status === 'ok' && failed !== undefined) {
        status = failed instanceof ModelError ? 'provider_error' : 'product_error';
        error = `a call failed and the pipeline went on without it: ${message(failed)}`;
      }
      const refused = events.filter((e) => e.kind === 'refused');
      const exceeded = events.flatMap((e) => (e.kind === 'exceeded' ? [e] : []));
      // A refusal the pipeline tolerated (a call whose failure it absorbs) still means the attempt is not whole.
      if (refused.length > 0 && status !== 'budget_stopped') {
        error = error ?? `budget: ${refused.length} call(s) refused during the attempt. ${note}`;
        status = 'budget_stopped';
      }
      // A call reported more input, or more output + thinking, than it reserved: its cost could not be bounded, so a
      // USD-guarded batch stops (B12, B22). Without a USD guard it is counted in the ledger and printed.
      const over = exceeded.flatMap((e) => [
        ...(e.reportedOutputTokens > e.reservedOutputTokens ? [`${e.reportedOutputTokens} > ${e.reservedOutputTokens} output tokens`] : []),
        ...(e.reportedInputTokens > e.reservedInputTokens ? [`${e.reportedInputTokens} > ${e.reservedInputTokens} input tokens`] : []),
      ]);
      if (over.length > 0 && usdGuarded) {
        error = `${RESERVATION_EXCEEDED} (${over.join('; ')}). ${note}`;
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
        stamp: { codeCommit, freezeCommit, casesHash: cHash, promptVersion: PROMPT_VERSION, requestedModel: o.config.models[o.provider], returnedModels: [...new Set(observed.map((e) => e.usage.model))].sort() },
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
          note,
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
      log(`${c.name} run ${run}: ${status}${error ? ` · ${error}` : ''} · ${a.usage.httpAttempts} HTTP attempts · ${a.usage.costUsdAtListPrice.toFixed(4)} ${usdLabel} · ${batchUsd()}`);
      if (over.length > 0 && !usdGuarded) log(`${c.name} run ${run}: ${RESERVATION_EXCEEDED} (${over.join('; ')}); counted, not a stop (not USD-guarded)`);
      // The stops (B22): the attempt is stored first, whatever stops the batch.
      providerErrorsInARow = status === 'provider_error' ? providerErrorsInARow + 1 : 0;
      const fatal = failures.map(stopFor).find((x) => x !== null);
      if (status === 'budget_stopped') {
        stop('budget', error ?? 'budget', c.name, run);
        break batch;
      }
      if (fatal) {
        stop(fatal.kind, fatal.reason, c.name, run);
        break batch;
      }
      if (providerErrorsInARow >= MAX_CONSECUTIVE_PROVIDER_ERRORS) {
        stop('provider', `${providerErrorsInARow} consecutive attempts ended in provider_error (the last: ${error}); stopped so an outage burns no more held-out attempts`, c.name, run);
        break batch;
      }
    }
  }
  persist();
  log(
    `${result.written.length} attempts written, ${result.skipped.length} existing kept${result.stopped ? ` · stopped (${result.stopped}): ${result.stopReason}` : ''} · ledger: observed ${ledger.observedUsd.toFixed(4)}, estimated ${ledger.estimatedUsd.toFixed(4)}, unknown ${ledger.unknownUsd.toFixed(4)} ${usdLabel}. ${note}`,
  );
  return result;
}

export const USAGE = 'usage: npm run evals:heldout -- --provider gemini|groq [--runs n] [--budget usd, gemini only] [--case name] [--from-run n]';
export class UsageError extends Error {}

/** The command line: every flag known and given with a value, numbers that are numbers. Throws UsageError. */
export function parseCli(args: readonly string[], config: HeldOutConfig): { provider: Provider; runs: number; budgetUsd: number | null; only?: string; fromRun?: number } {
  const known = new Set(['--provider', '--runs', '--budget', '--case', '--from-run']);
  const v: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!;
    const value = args[i + 1];
    if (!known.has(flag)) throw new UsageError(`unknown argument ${flag}`);
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    v[flag] = value;
  }
  const num = (flag: string, d: number) => {
    if (v[flag] === undefined) return d;
    const n = Number(v[flag]);
    if (!Number.isFinite(n)) throw new UsageError(`${flag} must be a number`);
    return n;
  };
  const provider = (v['--provider'] ?? 'gemini') as Provider;
  if (provider !== 'gemini' && provider !== 'groq') throw new UsageError('--provider must be gemini or groq');
  const runs = num('--runs', config.runs);
  const fromRun = v['--from-run'] === undefined ? undefined : num('--from-run', 1);
  if (fromRun !== undefined && !(Number.isInteger(fromRun) && fromRun >= 1 && fromRun <= runs)) throw new UsageError(`--from-run must be an integer from 1 to ${runs}`);
  const limit = config.budgetUsd[provider];
  // No USD guard for this provider in the frozen config (Groq, B22): a budget would mean nothing.
  if (limit === null && v['--budget'] !== undefined) throw new UsageError(`${provider} is not USD-guarded (frozen config): --budget is for gemini only`);
  return { provider, runs, budgetUsd: limit === null ? null : num('--budget', limit), ...(v['--case'] ? { only: v['--case'] } : {}), ...(fromRun !== undefined ? { fromRun } : {}) };
}

async function main() {
  const config = loadConfig();
  const { provider, ...cli } = parseCli(process.argv.slice(2), config);
  let raw: AnalystModel;
  if (provider === 'groq') {
    if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');
    raw = new GroqModel({ apiKey: process.env.GROQ_API_KEY, model: config.models.groq, tpm: Number(process.env.GROQ_TPM) || 8_000 });
  } else {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
    raw = new GeminiModel({ apiKey: process.env.GEMINI_API_KEY, model: config.models.gemini });
  }
  const r = await runHeldOut({ provider, raw, cases: HELD_OUT_CASES, config, ...cli });
  // 3: the batch stopped (budget or quota); 2: a usage error; 1: a refusal to start or any other failure.
  if (r.stopped) process.exitCode = 3;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(message(e));
    if (e instanceof UsageError) console.error(USAGE);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  });
}
