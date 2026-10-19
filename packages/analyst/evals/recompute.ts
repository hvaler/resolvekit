/**
 * One recompute over every stored result: reads the files under evals/results/, scores them with the current
 * metrics (metrics.ts, strict.ts) and writes results/summary.json and results/summary.md. Pure over the files: no
 * provider, no keys, no network; it never writes anything but the two summary files.
 *
 *   npm run evals:recompute
 *
 * Every file is classified explicitly (ruling B2): the development headline (prompt PROMPT_VERSION, one per provider),
 * history (earlier prompts), experiments (the `nodetect` ablation and the EV-19 multi-run file
 * upl-carrier-evidence-runs.json, which the brief called `development.uploadRuns`), held-out attempts
 * (heldout/<provider>/<case>/<run>.json) and held-out ledgers (heldout/<provider>/budget.json). Anything else is
 * `unclassified`: listed, never aggregated. A file that cannot be parsed or lacks what its class needs is `unreadable`;
 * two files with the same bytes, two attempts for the same provider+case+run, or one EV-19 file repeating a
 * provider+run entry, are `duplicates`. A held-out attempt stamped with another prompt version, or with a freeze
 * commit other than the one its ledger pins (or, without a ledger, among several freeze commits), is `foreignStamp`.
 * All of these are listed with their reason and left out of every aggregate (usage included), never silently and
 * never by picking one. Attempts for a case the held-out set does not define are counted apart, never scored.
 *
 * Usage per source: development files from the usage stored in their analyses (observed; a failed result stored no
 * usage, counted as unrecorded), at the list price for Gemini; Groq ran on its free tier, so no cost is given for it.
 * Held-out attempts and ledgers carry the runner's own observed / estimated / unknown split, reported as stored; for
 * Groq those figures are at Gemini list price (B22), so its rows in the usage table show tokens only and the held-out
 * section labels them «estimated at Gemini list price, not a Groq price». An ok attempt whose analysis lacks what the
 * scorer reads (sentences, checklist.items, contradictions) is unreadable; one stamped with a cases hash other than
 * the one its ledger pins is foreignStamp.
 *
 * Held-out scoring (labels, forbidden outcomes, twin pairing, per-run rows and spread) is heldout/score.ts, with the
 * frozen config's runs and negation window and the judgements in heldout/manual-judgements.json (malformed or
 * repeated entries are listed in `manualJudgements.invalid`, never used). The common subset compares providers only
 * on the case+run pairs where both have an ok attempt.
 *
 * Output is deterministic: rows sorted, object keys sorted, no timestamps, so two recomputes give the same bytes.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROMPT_VERSION } from '../src/prompts.ts';
import type { CaseAnalysis } from '../src/types.ts';
import { BUDGET_NOTE, LIST_PRICE, NOT_A_GROQ_PRICE, type Ledger } from './budget.ts';
import { CASES, type EvalCase } from './cases.ts';
import { HELD_OUT_CASES } from './heldout/cases.ts';
import type { HeldOutCase } from './heldout/schema.ts';
import { parseJudgements, scoreHeldOut, type HeldOutScoring, type ManualJudgement, type Tally } from './heldout/score.ts';
import { computeMetrics, metricsTable, type CaseResult, type Metrics, type Ratio } from './metrics.ts';
import { loadConfig, type Attempt, type Provider } from './runs.ts';
import type { NotEvaluableReason } from './strict.ts';

const PROVIDERS: Provider[] = ['gemini', 'groq'];
const STATUSES: Attempt['status'][] = ['ok', 'provider_error', 'product_error', 'budget_stopped'];
/** Written by recompute itself: never read as an input. */
const OUTPUTS = ['summary.json', 'summary.md'];
const UPLOAD_RUNS_FILE = 'upl-carrier-evidence-runs.json';

export type FileClass =
  | 'development-headline'
  | 'development-history'
  | 'experiment-ablation'
  | 'experiment-upload-runs'
  | 'heldout-attempt'
  | 'heldout-ledger'
  | 'unclassified';

export interface StrictSummary {
  coverage: Ratio;
  hits: Ratio;
  notEvaluableByReason: Partial<Record<NotEvaluableReason, number>>;
}

export interface MetricsRow {
  label: string;
  /** The stored file the row is computed from. */
  file: string;
  promptVersion: string;
  provider: string;
  /** Distinct cases in the row's results (ran or failed). */
  cases: number;
  runs: number;
  /** The strict contradiction result: coverage and hits apart, not evaluable by reason. */
  strict: StrictSummary;
  /** The file's own stored metrics against this recompute (the pair metric, notes, citations, usage): absent in older files. */
  storedMetrics: 'match' | 'differs' | 'absent';
  metrics: Metrics;
}

export type StatusCounts = Record<Attempt['status'], number>;

export interface HeldOutUsage {
  calls: number;
  httpAttempts: number;
  refused: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  observedUsd: number;
  estimatedUsd: number;
  unknownUsd: number;
  costUsdAtListPrice: number;
}

export interface HeldOutRow {
  /** Attempt files aggregated: readable, not duplicated, stamped with this freeze and prompt, of a known case. */
  files: number;
  /** Attempt files of this provider left out: unreadable, duplicated or foreign-stamped. */
  excluded: number;
  attempts: StatusCounts;
  byRun: Array<{ run: number; attempts: StatusCounts }>;
  byCase: Array<{ case: string; attempts: StatusCounts }>;
  /** Attempts for a case the held-out set does not define: counted here only, never in the rows above or scored. */
  unknownCaseAttempts: { files: number; cases: string[]; attempts: StatusCounts; usage: HeldOutUsage };
  stamps: { codeCommits: string[]; freezeCommits: string[]; promptVersions: string[]; requestedModels: string[]; returnedModels: string[] };
  usage: HeldOutUsage;
  /** What the USD figures in `usage` are: list price (Gemini), or, for Groq, estimated at Gemini list price, not a Groq price (B22). */
  usageBasis: string;
  ledger: Ledger | null;
  /** Labels, forbidden outcomes, twin pairing, per-run rows and spread (heldout/score.ts); null with no attempts. */
  scoring: HeldOutScoring | null;
}

export interface UsageRow {
  source: string;
  kind: 'development' | 'experiment' | 'held-out attempts' | 'held-out attempts, unknown cases' | 'held-out ledger';
  provider: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  /** Null where the source has no such split (development files store observed usage only). */
  observedUsd: number | null;
  estimatedUsd: number | null;
  unknownUsd: number | null;
  costUsdAtListPrice: number | null;
  /** Failed results that stored no usage (development files). */
  unrecordedAttempts: number;
  basis: string;
}

export interface Summary {
  /** Every file found under the results directory, sorted (relative paths); the two summary files are never inputs. */
  filesSeen: string[];
  /** The files whose bytes were read: every classified file (unclassified ones are listed, not opened). */
  filesRead: string[];
  files: Array<{ file: string; class: FileClass }>;
  unclassified: string[];
  /** One entry per file, every reason it could not be used. */
  unreadable: Array<{ file: string; reasons: string[] }>;
  duplicates: Array<{ reason: 'same attempt' | 'same content' | 'same run entry'; key: string; files: string[] }>;
  /** Held-out attempts stamped with another prompt version or freeze commit: left out of the held-out rows. */
  foreignStamp: Array<{ file: string; reason: string }>;
  development: { headline: Record<Provider, MetricsRow | null>; history: MetricsRow[] };
  /** The `nodetect` ablation and the EV-19 multi-run file (the brief's `development.uploadRuns`, placed here per B2). */
  experiments: { ablation: MetricsRow[]; uploadRuns: MetricsRow[] };
  heldOut: Record<Provider, HeldOutRow> & { commonSubset: { cases: string[]; pairs: string[]; gemini: MetricsRow; groq: MetricsRow } | null };
  /** The manual judgements file: entries that could not be used, with the reason. */
  manualJudgements: { invalid: Array<{ entry: unknown; reason: string }> };
  usage: UsageRow[];
}

export interface RecomputeOptions {
  devCases?: readonly EvalCase[];
  heldOutCases?: readonly HeldOutCase[];
  /** Default heldout/manual-judgements.json. */
  judgementsFile?: string;
  /** Planned held-out runs; default the frozen config's (or more, when attempts carry a higher run). */
  runs?: number;
}

export const JUDGEMENTS_FILE = fileURLToPath(new URL('./heldout/manual-judgements.json', import.meta.url));

const DEV_FILE = /^(gemini|groq)(-nodetect)?-(rk-analyst-[\d-]+\.\d+)\.json$/;
const ATTEMPT_FILE = /^heldout\/(gemini|groq)\/([^/]+)\/(\d+)\.json$/;
const LEDGER_FILE = /^heldout\/(gemini|groq)\/budget\.json$/;

/** The prompt's revision number (`rk-analyst-2026-10-09.7` → 7), to order versions. */
const revision = (v: string) => Number(/\.(\d+)$/.exec(v)?.[1] ?? NaN);
const datePart = (v: string) => v.replace(/\.\d+$/, '');

export function classify(file: string): FileClass {
  if (file === UPLOAD_RUNS_FILE) return 'experiment-upload-runs';
  const d = DEV_FILE.exec(file);
  if (d) {
    const v = d[3]!;
    // the same gate for every development-shaped file, -nodetect included: a newer or other version is unclassified
    const known = datePart(v) === datePart(PROMPT_VERSION) && revision(v) <= revision(PROMPT_VERSION);
    if (!known) return 'unclassified';
    if (d[2]) return 'experiment-ablation';
    return v === PROMPT_VERSION ? 'development-headline' : 'development-history';
  }
  if (ATTEMPT_FILE.test(file)) return 'heldout-attempt';
  if (LEDGER_FILE.test(file)) return 'heldout-ledger';
  return 'unclassified';
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(root, p).split(sep).join('/'));
    }
  };
  if (existsSync(root)) walk(root);
  return out.filter((f) => !OUTPUTS.includes(f)).sort();
}

class Unreadable extends Error {}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Throws Unreadable naming the first missing or malformed field. */
function need(ok: boolean, what: string) {
  if (!ok) throw new Unreadable(`incomplete: ${what}`);
}

const zeroCounts = (): StatusCounts => ({ ok: 0, provider_error: 0, product_error: 0, budget_stopped: 0 });
const uniq = (xs: string[]) => [...new Set(xs)].sort();

function strictOf(m: Metrics): StrictSummary {
  const by: Partial<Record<NotEvaluableReason, number>> = {};
  for (const x of m.strictContradictions.notEvaluable) by[x.reason] = (by[x.reason] ?? 0) + 1;
  return { coverage: m.strictContradictions.coverage, hits: m.strictContradictions.hits, notEvaluableByReason: by };
}

/** The fields an older metrics block also has, compared with this recompute. */
const COMPARED = ['citationValidity', 'baitRejected', 'baitNotSent', 'falseRejection', 'trueNotesSupported', 'contradictionRecall', 'usage'] as const;
function compareStored(storedMetrics: unknown, m: Metrics): MetricsRow['storedMetrics'] {
  if (!isObj(storedMetrics)) return 'absent';
  return COMPARED.every((k) => JSON.stringify(storedMetrics[k]) === JSON.stringify(m[k])) ? 'match' : 'differs';
}

function row(o: { label: string; file: string; promptVersion: string; provider: string; runs: number; cases: readonly EvalCase[]; results: CaseResult[]; stored?: unknown }): MetricsRow {
  const metrics = computeMetrics(o.cases, o.results);
  return {
    label: o.label,
    file: o.file,
    promptVersion: o.promptVersion,
    provider: o.provider,
    cases: new Set(o.results.map((r) => r.name.replace(/#\d+$/, ''))).size,
    runs: o.runs,
    strict: strictOf(metrics),
    storedMetrics: o.stored === undefined ? 'absent' : compareStored(o.stored, metrics),
    metrics,
  };
}

/** Each case once per run, renamed `<case>#<run>` (its clean twin too, so run i is paired with twin run i). */
function perRunCases<C extends EvalCase>(cases: readonly C[], runs: readonly number[]): C[] {
  return runs.flatMap((r) =>
    cases.map((c) => ({ ...c, name: `${c.name}#${r}`, ...(c.injection ? { injection: { ...c.injection, cleanTwin: `${c.injection.cleanTwin}#${r}` } } : {}) })),
  );
}

const usd = (inputTokens: number, outputTokens: number, thinkingTokens: number) => (inputTokens * LIST_PRICE.inputPerM + (outputTokens + thinkingTokens) * LIST_PRICE.outputPerM) / 1e6;

function devUsage(source: string, kind: UsageRow['kind'], provider: string, results: CaseResult[]): UsageRow {
  const u = { calls: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
  for (const r of results) {
    if (!r.analysis) continue;
    u.calls += r.analysis.usage.calls.length;
    u.inputTokens += r.analysis.usage.inputTokens;
    u.outputTokens += r.analysis.usage.outputTokens;
    u.thinkingTokens += r.analysis.usage.thinkingTokens;
  }
  // a cost only where the source stored tokens: no tokens, no figure
  const priced = provider === 'gemini' && u.inputTokens + u.outputTokens + u.thinkingTokens > 0;
  const cost = priced ? usd(u.inputTokens, u.outputTokens, u.thinkingTokens) : null;
  return {
    source,
    kind,
    provider,
    ...u,
    observedUsd: cost,
    estimatedUsd: null,
    unknownUsd: null,
    costUsdAtListPrice: cost,
    unrecordedAttempts: results.filter((r) => !r.analysis).length,
    basis: provider === 'gemini'
      ? `usage stored in the analyses (observed) at ${LIST_PRICE.inputPerM} / ${LIST_PRICE.outputPerM} USD per 1M input / output tokens, thinking billed as output; failed results stored no usage`
      : 'usage stored in the analyses (observed); Groq ran on its free tier, so no cost is stated; failed results stored no usage',
  };
}

function readDevFile(text: string, file: string, provider: string, version: string): { provider: string; promptVersion: string; results: CaseResult[]; metrics?: unknown } {
  const j: unknown = JSON.parse(text);
  need(isObj(j), 'not an object');
  const o = j as Record<string, unknown>;
  need(o.provider === provider, `provider (the name says ${provider})`);
  need(o.promptVersion === version, `promptVersion (the name says ${version})`);
  need(Array.isArray(o.results), 'results');
  for (const r of o.results as unknown[]) need(isObj(r) && typeof r.name === 'string' && (isObj(r.analysis) || typeof r.error === 'string'), `results entry in ${file}`);
  return o as never;
}

function readUploadRuns(text: string): { case: string; promptVersion: string; runs: Array<{ provider: string; run: number; result: CaseResult }> } {
  const j: unknown = JSON.parse(text);
  need(isObj(j) && typeof j.case === 'string' && typeof j.promptVersion === 'string' && Array.isArray(j.runs), 'case, promptVersion, runs');
  for (const r of (j as { runs: unknown[] }).runs)
    need(isObj(r) && PROVIDERS.includes(r.provider as Provider) && Number.isInteger(r.run) && isObj(r.result) && (r.result as { name?: unknown }).name === (j as { case: string }).case, 'runs entry');
  return j as never;
}

function readAttempt(text: string, m: RegExpExecArray): Attempt {
  const j: unknown = JSON.parse(text);
  need(isObj(j), 'not an object');
  const a = j as Record<string, unknown>;
  need(PROVIDERS.includes(a.provider as Provider), 'provider');
  need(typeof a.case === 'string', 'case');
  need(Number.isInteger(a.run) && (a.run as number) >= 1, 'run');
  need(STATUSES.includes(a.status as Attempt['status']), 'status');
  need(isObj(a.stamp) && typeof a.stamp.freezeCommit === 'string' && typeof a.stamp.promptVersion === 'string', 'stamp');
  const u = a.usage;
  need(isObj(u) && ['calls', 'httpAttempts', 'refused', 'inputTokens', 'outputTokens', 'thinkingTokens', 'observedUsd', 'unknownUsd', 'estimatedUsd', 'costUsdAtListPrice'].every((k) => isNum(u[k])), 'usage');
  need(a.status !== 'ok' || isObj(a.analysis), 'analysis (status ok)');
  // What the scorer reads of an ok analysis: missing, it would crash the recompute instead of being listed (B22).
  const an = a.analysis as Record<string, unknown> | undefined;
  need(a.status !== 'ok' || (Array.isArray(an!.sentences) && isObj(an!.checklist) && Array.isArray(an!.checklist.items) && Array.isArray(an!.contradictions)), 'analysis (status ok): sentences, checklist.items, contradictions');
  if (a.provider !== m[1] || a.case !== m[2] || a.run !== Number(m[3])) throw new Unreadable(`its content (${a.provider}/${a.case}/${a.run}) disagrees with its path`);
  return a as unknown as Attempt;
}

function readLedger(text: string, provider: string): Ledger {
  const j: unknown = JSON.parse(text);
  need(isObj(j), 'not an object');
  const l = j as Record<string, unknown>;
  need(l.provider === provider, `provider (the path says ${provider})`);
  // limitUsd null: not USD-guarded (Groq, B22)
  need((l.limitUsd === null || isNum(l.limitUsd)) && ['observedUsd', 'estimatedUsd', 'unknownUsd', 'checks', 'refusals'].every((k) => isNum(l[k])), 'limitUsd, observedUsd, estimatedUsd, unknownUsd, checks, refusals');
  return l as unknown as Ledger;
}

/** The attempts' stored usage, summed field by field. */
function sumUsage(attempts: readonly Attempt[]): HeldOutUsage {
  const usage: HeldOutUsage = { calls: 0, httpAttempts: 0, refused: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, observedUsd: 0, estimatedUsd: 0, unknownUsd: 0, costUsdAtListPrice: 0 };
  for (const a of attempts) for (const k of Object.keys(usage) as Array<keyof HeldOutUsage>) usage[k] += a.usage[k];
  return usage;
}

function statusCounts(attempts: readonly Attempt[]): StatusCounts {
  const counts = zeroCounts();
  for (const a of attempts) counts[a.status]++;
  return counts;
}

/** The runner's USD figures: list price for Gemini; for Groq, recorded at Gemini list price, so never a Groq cost (B22). */
const usdBasis = (p: Provider) => (p === 'groq' ? `USD ${NOT_A_GROQ_PRICE}` : 'USD at list price');

/** `attempts`: of the held-out set's cases only; `unknown`: attempts for any other case, accounted apart. */
function heldOutRow(attempts: Attempt[], unknown: Attempt[], excluded: number, ledger: Ledger | null, cases: readonly HeldOutCase[], score: { provider: Provider; runs: number; negationWindowWords: number; judgements: readonly ManualJudgement[] }): HeldOutRow {
  const runs = [...new Set(attempts.map((a) => a.run))].sort((x, y) => x - y);
  return {
    files: attempts.length,
    excluded,
    attempts: statusCounts(attempts),
    byRun: runs.map((run) => ({ run, attempts: statusCounts(attempts.filter((a) => a.run === run)) })),
    byCase: uniq(attempts.map((a) => a.case)).map((c) => ({ case: c, attempts: statusCounts(attempts.filter((a) => a.case === c)) })),
    unknownCaseAttempts: { files: unknown.length, cases: uniq(unknown.map((a) => a.case)), attempts: statusCounts(unknown), usage: sumUsage(unknown) },
    stamps: {
      codeCommits: uniq(attempts.map((a) => a.stamp.codeCommit)),
      freezeCommits: uniq(attempts.map((a) => a.stamp.freezeCommit)),
      promptVersions: uniq(attempts.map((a) => a.stamp.promptVersion)),
      requestedModels: uniq(attempts.map((a) => a.stamp.requestedModel)),
      returnedModels: uniq(attempts.flatMap((a) => a.stamp.returnedModels ?? [])),
    },
    usage: sumUsage(attempts),
    usageBasis: usdBasis(score.provider),
    ledger,
    scoring: scoreHeldOut(cases, attempts, { ...score, runs: Math.max(score.runs, ...attempts.map((a) => a.run)) }),
  };
}

/** The case+run pairs where both providers have an ok attempt of a case the held-out set defines; null when none. */
function commonSubset(attempts: Record<Provider, Attempt[]>, cases: readonly HeldOutCase[]): Summary['heldOut']['commonSubset'] {
  const known = new Map(cases.map((c) => [c.name, c]));
  const ok = (p: Provider) => new Map(attempts[p].filter((a) => a.status === 'ok' && known.has(a.case)).map((a) => [`${a.case}#${a.run}`, a]));
  const g = ok('gemini');
  const q = ok('groq');
  const pairs = [...g.keys()].filter((k) => q.has(k)).sort();
  if (!pairs.length) return null;
  const sub = pairs.map((k) => {
    const [name, run] = k.split('#') as [string, string];
    return { k, c: known.get(name)!, run: Number(run) };
  });
  const subCases = sub.map((s) => perRunCases([s.c], [s.run])[0]!);
  const side = (p: Provider, m: Map<string, Attempt>) =>
    row({
      label: `held-out common subset, ${p}`,
      file: `heldout/${p}`,
      promptVersion: uniq(pairs.map((k) => m.get(k)!.stamp.promptVersion)).join(', '),
      provider: p,
      runs: new Set(sub.map((s) => s.run)).size,
      cases: subCases,
      results: pairs.map((k) => ({ name: k, analysis: m.get(k)!.analysis as CaseAnalysis })),
    });
  return { cases: uniq(sub.map((s) => s.c.name)), pairs, gemini: side('gemini', g), groq: side('groq', q) };
}

export function recompute(resultsDir: string, o: RecomputeOptions = {}): Summary {
  const devCases = o.devCases ?? CASES;
  const heldOutCases = o.heldOutCases ?? HELD_OUT_CASES;
  const config = loadConfig();
  const judgementsFile = o.judgementsFile ?? JUDGEMENTS_FILE;
  const judgements = existsSync(judgementsFile) ? parseJudgements(readFileSync(judgementsFile, 'utf8')) : { entries: [], invalid: [{ entry: judgementsFile, reason: 'file missing' }] };
  const all = listFiles(resultsDir);
  const files = all.map((file) => ({ file, class: classify(file) }));
  const unreadable = new Map<string, string[]>();
  const duplicates: Summary['duplicates'] = [];
  const foreignStamp: Summary['foreignStamp'] = [];
  const excluded = new Set<string>();
  /** Lists a file as unreadable (every reason on its one entry) and leaves it out. */
  const fail = (file: string, reason: string) => {
    unreadable.set(file, [...(unreadable.get(file) ?? []), reason]);
    excluded.add(file);
  };

  // Same bytes under two names: every copy is left out (which one is right cannot be told from the files).
  const byHash = new Map<string, string[]>();
  const texts = new Map<string, string>();
  for (const { file, class: cls } of files) {
    if (cls === 'unclassified') continue;
    const bytes = readFileSync(join(resultsDir, file));
    texts.set(file, bytes.toString('utf8'));
    const h = createHash('sha256').update(bytes).digest('hex');
    byHash.set(h, [...(byHash.get(h) ?? []), file]);
  }
  for (const [h, fs] of [...byHash].sort(([x], [y]) => (x < y ? -1 : 1))) {
    if (fs.length < 2) continue;
    duplicates.push({ reason: 'same content', key: `sha256 ${h.slice(0, 16)}`, files: fs.sort() });
    fs.forEach((f) => excluded.add(f));
  }

  /** Parses a file with its reader; an unreadable one is listed with its reason and left out. */
  const parse = <T>(file: string, read: (text: string) => T): T | null => {
    if (excluded.has(file)) return null;
    try {
      return read(texts.get(file)!);
    } catch (e) {
      fail(file, e instanceof Unreadable ? e.message : e instanceof SyntaxError ? `not valid JSON (${e.message})` : `could not be read (${e instanceof Error ? e.message : String(e)})`);
      return null;
    }
  };
  /** A metrics row; a file whose analyses cannot be scored is unreadable, never a crash. */
  const scored = (file: string, make: () => MetricsRow): MetricsRow | null => {
    try {
      return make();
    } catch (e) {
      fail(file, `could not be scored (${e instanceof Error ? e.message : String(e)})`);
      return null;
    }
  };

  const headline: Record<Provider, MetricsRow | null> = { gemini: null, groq: null };
  const history: MetricsRow[] = [];
  const ablation: MetricsRow[] = [];
  const uploadRuns: MetricsRow[] = [];
  const usage: UsageRow[] = [];
  const attempts: Record<Provider, Array<{ file: string; a: Attempt }>> = { gemini: [], groq: [] };
  const ledgers: Record<Provider, Ledger | null> = { gemini: null, groq: null };

  for (const { file, class: cls } of files) {
    if (cls === 'development-headline' || cls === 'development-history' || cls === 'experiment-ablation') {
      const [, provider, nodetect, version] = DEV_FILE.exec(file)!;
      const d = parse(file, (t) => readDevFile(t, file, provider!, version!));
      if (!d) continue;
      const label = `${provider} ${version}${nodetect ? ' (detection ignored)' : ''}`;
      const r = scored(file, () => row({ label, file, promptVersion: version!, provider: provider!, runs: 1, cases: devCases, results: d.results, stored: d.metrics ?? undefined }));
      if (!r) continue;
      if (cls === 'development-headline') headline[provider as Provider] = r;
      else (cls === 'development-history' ? history : ablation).push(r);
      usage.push(devUsage(file, cls === 'experiment-ablation' ? 'experiment' : 'development', provider!, d.results));
    } else if (cls === 'experiment-upload-runs') {
      const d = parse(file, readUploadRuns);
      if (!d) continue;
      const kase = devCases.find((c) => c.name === d.case);
      if (!kase) {
        fail(file, `incomplete: case ${d.case} is not in the development set`);
        continue;
      }
      // A provider+run entry stored twice: which one is the run cannot be told, so the whole file is left out.
      const seen = new Map<string, number>();
      for (const r of d.runs) seen.set(`${r.provider} run ${r.run}`, (seen.get(`${r.provider} run ${r.run}`) ?? 0) + 1);
      const doubled = [...seen].filter(([, n]) => n > 1).map(([k]) => k).sort();
      if (doubled.length) {
        for (const k of doubled) duplicates.push({ reason: 'same run entry', key: `${d.case} ${k}`, files: [file] });
        excluded.add(file);
        continue;
      }
      // Rows and usage are kept only if every run of the file could be scored.
      const rows: MetricsRow[] = [];
      const fileUsage: UsageRow[] = [];
      for (const p of PROVIDERS) {
        const mine = d.runs.filter((r) => r.provider === p).sort((x, y) => x.run - y.run);
        if (!mine.length) continue;
        for (const r of mine)
          rows.push(...[scored(file, () => row({ label: `${d.case} ${p} run ${r.run}`, file, promptVersion: d.promptVersion, provider: p, runs: 1, cases: [kase], results: [r.result] }))].filter((x): x is MetricsRow => !!x));
        const runs = mine.map((r) => r.run);
        const all = scored(file, () =>
          row({ label: `${d.case} ${p}, runs ${runs.join(', ')}`, file, promptVersion: d.promptVersion, provider: p, runs: mine.length, cases: perRunCases([kase], runs), results: mine.map((r) => ({ ...r.result, name: `${r.result.name}#${r.run}` })) }),
        );
        if (all) rows.push(all);
        fileUsage.push(devUsage(`${file} (${p})`, 'experiment', p, mine.map((r) => r.result)));
      }
      if (!excluded.has(file)) {
        uploadRuns.push(...rows);
        usage.push(...fileUsage);
      }
    } else if (cls === 'heldout-attempt') {
      const m = ATTEMPT_FILE.exec(file)!;
      const a = parse(file, (t) => readAttempt(t, m));
      if (a) attempts[a.provider].push({ file, a });
    } else if (cls === 'heldout-ledger') {
      const p = LEDGER_FILE.exec(file)![1] as Provider;
      ledgers[p] = parse(file, (t) => readLedger(t, p));
    }
  }

  // The same provider+case+run in two files (e.g. 1.json and 01.json): every one of them is left out, none is picked.
  const heldOut = {} as Summary['heldOut'];
  const kept: Record<Provider, Attempt[]> = { gemini: [], groq: [] };
  for (const p of PROVIDERS) {
    const byKey = new Map<string, string[]>();
    for (const { file, a } of attempts[p]) byKey.set(`${a.provider}/${a.case}/${a.run}`, [...(byKey.get(`${a.provider}/${a.case}/${a.run}`) ?? []), file]);
    for (const [key, fs] of [...byKey].sort(([x], [y]) => (x < y ? -1 : 1))) {
      if (fs.length < 2) continue;
      duplicates.push({ reason: 'same attempt', key, files: fs.sort() });
      fs.forEach((f) => excluded.add(f));
    }
    // Stamps: the prompt version must be this one; the freeze commit the one the ledger pins, or, without a ledger,
    // the only one among the attempts (several, and none pinned: none can be told right, so all are left out).
    let rest = attempts[p].filter((x) => !excluded.has(x.file));
    const pinned = ledgers[p]?.freeze?.commit;
    // The built cases the ledger pins (B22): an attempt made on other inputs or labels is not this set's.
    const pinnedCases = ledgers[p]?.freeze?.casesHash;
    const freezes = uniq(rest.map((x) => x.a.stamp.freezeCommit));
    for (const { file, a } of rest) {
      const why =
        a.stamp.promptVersion !== PROMPT_VERSION
          ? `prompt version ${a.stamp.promptVersion}, not ${PROMPT_VERSION}`
          : pinned !== undefined && a.stamp.freezeCommit !== pinned
            ? `freeze commit ${a.stamp.freezeCommit}; the ledger pins ${pinned}`
            : pinnedCases !== undefined && a.stamp.casesHash !== pinnedCases
              ? `cases hash ${a.stamp.casesHash}; the ledger pins ${pinnedCases}`
              : pinned === undefined && freezes.length > 1
                ? `${freezes.length} freeze commits among the ${p} attempts (${freezes.join(', ')}) and no ledger pins one`
                : null;
      if (why) {
        foreignStamp.push({ file, reason: why });
        excluded.add(file);
      }
    }
    rest = rest.filter((x) => !excluded.has(x.file));
    const known = new Set(heldOutCases.map((c) => c.name));
    kept[p] = rest.filter((x) => known.has(x.a.case)).map((x) => x.a);
    const unknown = rest.filter((x) => !known.has(x.a.case)).map((x) => x.a);
    const out = [...excluded].filter((f) => ATTEMPT_FILE.exec(f)?.[1] === p).length;
    heldOut[p] = heldOutRow(kept[p], unknown, out, ledgers[p], heldOutCases, { provider: p, runs: o.runs ?? config.runs, negationWindowWords: config.negationWindowWords, judgements: judgements.entries });
    // Groq (B22): no cost is ever stated; the runner's figures are at Gemini list price, so the table shows tokens only.
    const priced = p !== 'groq';
    const groqBasis = `tokens only; the USD the runner recorded for Groq is ${NOT_A_GROQ_PRICE}, not shown as a cost (see the held-out section)`;
    const attemptUsage = (source: string, kind: UsageRow['kind'], u: HeldOutUsage, what: string): UsageRow => ({
      source,
      kind,
      provider: p,
      calls: u.calls,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      thinkingTokens: u.thinkingTokens,
      observedUsd: priced ? u.observedUsd : null,
      estimatedUsd: priced ? u.estimatedUsd : null,
      unknownUsd: priced ? u.unknownUsd : null,
      costUsdAtListPrice: priced ? u.costUsdAtListPrice : null,
      unrecordedAttempts: 0,
      basis: priced ? `the runner's per-attempt record${what} at list price (observed + unknown). ${BUDGET_NOTE}` : `the runner's per-attempt record${what}: ${groqBasis}`,
    });
    if (kept[p].length) usage.push(attemptUsage(`heldout/${p} attempts`, 'held-out attempts', heldOut[p].usage, ''));
    if (unknown.length) usage.push(attemptUsage(`heldout/${p} attempts for cases not in the held-out set`, 'held-out attempts, unknown cases', heldOut[p].unknownCaseAttempts.usage, ' (cases not in the held-out set, never scored)'));
    const l = ledgers[p];
    if (l)
      usage.push({
        source: `heldout/${p}/budget.json`,
        kind: 'held-out ledger',
        provider: p,
        calls: l.checks - l.refusals,
        inputTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        observedUsd: priced ? l.observedUsd : null,
        estimatedUsd: priced ? l.estimatedUsd : null,
        unknownUsd: priced ? l.unknownUsd : null,
        costUsdAtListPrice: priced ? l.observedUsd + l.estimatedUsd + l.unknownUsd : null,
        unrecordedAttempts: 0,
        basis: priced ? `the batch ledger: HTTP attempts checked by the guard (calls = checks − refusals), tokens not kept there. ${BUDGET_NOTE}` : `the batch ledger: HTTP attempts checked by the guard (calls = checks − refusals), ${groqBasis}`,
      });
  }
  heldOut.commonSubset = commonSubset(kept, heldOutCases);

  const byLabel = (x: MetricsRow, y: MetricsRow) => (x.label < y.label ? -1 : x.label > y.label ? 1 : 0);
  const byFileThenLabel = (x: MetricsRow, y: MetricsRow) => (x.provider < y.provider ? -1 : x.provider > y.provider ? 1 : revision(x.promptVersion) - revision(y.promptVersion) || byLabel(x, y));
  return {
    filesSeen: all,
    filesRead: [...texts.keys()].sort(),
    files,
    unclassified: files.filter((f) => f.class === 'unclassified').map((f) => f.file),
    unreadable: [...unreadable].sort(([x], [y]) => (x < y ? -1 : 1)).map(([file, reasons]) => ({ file, reasons })),
    duplicates: duplicates.sort((x, y) => (x.files[0]! < y.files[0]! ? -1 : x.files[0]! > y.files[0]! ? 1 : x.key < y.key ? -1 : 1)),
    foreignStamp: foreignStamp.sort((x, y) => (x.file < y.file ? -1 : 1)),
    development: { headline, history: history.sort(byFileThenLabel) },
    experiments: { ablation: ablation.sort(byFileThenLabel), uploadRuns: uploadRuns.sort((x, y) => (x.provider < y.provider ? -1 : x.provider > y.provider ? 1 : x.runs - y.runs || byLabel(x, y))) },
    heldOut,
    manualJudgements: { invalid: judgements.invalid },
    usage: usage.sort((x, y) => (x.source < y.source ? -1 : 1)),
  };
}

/** JSON with every object's keys sorted, so the bytes depend on the content only. */
export function serializeSummary(s: Summary): string {
  const sort = (v: unknown): unknown => (Array.isArray(v) ? v.map(sort) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
  return JSON.stringify(sort(s), null, 2) + '\n';
}

const pct = (r: Ratio) => (r.rate == null ? '—' : `${(r.rate * 100).toFixed(0)}% (${r.n}/${r.of})`);
const money = (v: number | null) => (v == null ? '—' : v.toFixed(4));
const reasons = (s: StrictSummary) =>
  Object.entries(s.notEvaluableByReason)
    .sort(([x], [y]) => (x < y ? -1 : 1))
    .map(([k, n]) => `${k} ${n}`)
    .join(', ') || 'none';
const strictLine = (s: StrictSummary) => `coverage ${pct(s.coverage)} · hits ${pct(s.hits)} · not evaluable: ${reasons(s)}`;
const counts = (c: StatusCounts) => STATUSES.map((k) => `${k} ${c[k]}`).join(' · ');

function rowsTable(rows: MetricsRow[], uploads = false): string[] {
  if (!rows.length) return ['None stored.'];
  const head = ['Row', 'Cases', 'Runs', 'Citation validity', 'Bait rejected', 'Kept out', 'False rejection', 'True notes supported', 'Contradiction recall (pair)', 'Strict coverage', 'Strict hits', 'Not evaluable', ...(uploads ? ['Upload citations valid', 'Required facts cited'] : []), 'Stored metrics'];
  return [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map((r) => {
      const m = r.metrics;
      const up = uploads ? [m.uploads ? pct(m.uploads.uploadCitationsValid) : '—', m.uploads ? pct(m.uploads.requiredCited) : '—'] : [];
      return `| ${[r.label, r.cases, r.runs, pct(m.citationValidity), pct(m.baitRejected), pct(m.baitNotSent), pct(m.falseRejection), pct(m.trueNotesSupported), pct(m.contradictionRecall), pct(r.strict.coverage), pct(r.strict.hits), reasons(r.strict), ...up, r.storedMetrics].join(' | ')} |`;
    }),
  ];
}

const tallyCell = (t: Tally) =>
  `${t.rate.rate == null ? '—' : `${(t.rate.rate * 100).toFixed(0)}% (${t.hits}/${t.evaluable})`} · coverage ${t.evaluable}/${t.planned}${Object.keys(t.notEvaluable).length ? ` · not evaluable: ${Object.entries(t.notEvaluable).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(', ')}` : ''}`;
const num = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`);

/** One provider's held-out scoring: per-run rows, spread, totals, attack rows. */
function scoringMarkdown(g: HeldOutScoring): string[] {
  const out: string[] = [];
  const notScored = Object.entries(g.notEvaluable).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
  out.push(`Planned runs: ${g.runs} · case × run attempts not scored: ${notScored}${g.notRun.length ? ` (not run: ${g.notRun.join(', ')})` : ''}`, '');
  const head = ['Run', 'Attempts', 'Strict conflicts found', 'True notes rejected', 'Bait notes sent', 'Forbidden hit', 'Unchanged vs twin'];
  out.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`);
  for (const r of g.perRun) out.push(`| ${[r.run, counts(r.attempts), tallyCell(r.strict), tallyCell(r.trueRejected), tallyCell(r.baitSent), tallyCell(r.forbiddenHit), tallyCell(r.unchangedVsTwin)].join(' | ')} |`);
  const l = g.labelChecks;
  const p = g.injectionPairs;
  out.push(`| all runs | ${g.perRun.reduce((n, r) => n + r.attempts.ok, 0)} ok | ${tallyCell(l.strictTally)} | ${tallyCell(l.notes.trueRejected)} | ${tallyCell(l.notes.baitSent)} | ${tallyCell(l.forbidden)}${l.forbidden.manual ? ` · ${l.forbidden.manual} «manual»` : ''} | ${p.unchanged}/${p.evaluable} · coverage ${p.evaluable}/${p.pairs} · twin self-agreement ${p.twinAgreement.agreeing}/${p.twinAgreement.of} |`, '');
  out.push('Spread over runs (rate per run; runs with nothing evaluable left out; no best-of):', '', '| Metric | Min | Median | Max | Runs | Per run |', '|---|---|---|---|---|---|');
  for (const [k, v] of Object.entries(g.spread)) out.push(`| ${k} | ${num(v.min)} | ${num(v.median)} | ${num(v.max)} | ${v.runs} | ${v.perRun.map(num).join(' / ')} |`);
  out.push('');
  if (p.twins.length) out.push(...p.twins.map((t) => `- twin ${t.twin}: ok runs ${t.okRuns.join(', ') || 'none'} · twin self-agreement ${t.agreeing}/${t.of}`), '');
  if (g.forbidden.length) {
    out.push('| Attack | Run | Forbidden outcome | Action | Checklist | Claims | Unchanged vs twin | Detail |', '|---|---|---|---|---|---|---|---|');
    for (const f of g.forbidden) {
      const pair = p.rows.find((x) => x.case === f.case && x.run === f.run);
      out.push(`| ${f.case} | ${f.run} | ${f.outcome}${f.manual ? ' «manual»' : ''} | ${f.action ?? '—'} | ${f.checklist ?? '—'} | ${f.claims ?? '—'}${f.needsManual.some((n) => n.moot) ? ' (moot)' : ''} | ${pair?.outcome ?? '—'} | ${[...f.detail, ...(pair?.detail ?? [])].join('; ').replace(/\|/g, '\\|') || '—'} |`);
    }
    out.push('');
  }
  const moot = g.forbidden.flatMap((f) => f.needsManual.filter((n) => n.moot).map((n) => `- ${f.case} run ${f.run} ${n.sentenceId} (match "${n.match}"): "${n.text}"`));
  if (moot.length) out.push('Negated matches left moot (the run is already a forbidden hit by an automatic check; no judgement needed):', '', ...moot, '');
  const pending = g.forbidden.flatMap((f) => f.needsManual.filter((n) => n.judgement === null && !n.moot).map((n) => `- ${f.case} run ${f.run} ${n.sentenceId} (pattern \`${n.pattern}\`, match "${n.match}"): "${n.text}"`));
  if (pending.length) out.push('Needs a manual judgement (negated match; not counted until recorded in heldout/manual-judgements.json):', '', ...pending, '');
  if (g.judgements.unused.length) out.push(`Judgements matching no negated match (not used): ${g.judgements.unused.join(', ')}`, '');
  return out;
}

/** The tables docs/evals.md quotes. */
export function summaryMarkdown(s: Summary): string {
  const out: string[] = ['# Eval summary', '', 'Generated by `npm run evals:recompute` from the stored results (no model called). Do not edit by hand.', ''];
  const byClass = new Map<FileClass, number>();
  for (const f of s.files) byClass.set(f.class, (byClass.get(f.class) ?? 0) + 1);
  out.push('## Files', '', '| Class | Files |', '|---|---|', ...[...byClass].sort(([x], [y]) => (x < y ? -1 : 1)).map(([c, n]) => `| ${c} | ${n} |`), '');
  out.push(`Unreadable files (${s.unreadable.length}), left out of every aggregate:`, '', ...(s.unreadable.length ? s.unreadable.map((u) => `- \`${u.file}\`: ${u.reasons.join('; ')}`) : ['- none']), '');
  out.push(`Duplicates (${s.duplicates.length}), every copy left out:`, '', ...(s.duplicates.length ? s.duplicates.map((d) => `- ${d.reason} (${d.key}): ${d.files.map((f) => `\`${f}\``).join(', ')}`) : ['- none']), '');
  out.push(`Foreign-stamped held-out attempts (${s.foreignStamp.length}), left out:`, '', ...(s.foreignStamp.length ? s.foreignStamp.map((f) => `- \`${f.file}\`: ${f.reason}`) : ['- none']), '');
  out.push(`Unclassified files (${s.unclassified.length}), never aggregated:`, '', ...(s.unclassified.length ? s.unclassified.map((f) => `- \`${f}\``) : ['- none']), '');

  out.push(`## Development headline (prompt \`${PROMPT_VERSION}\`)`, '');
  for (const p of PROVIDERS) {
    const r = s.development.headline[p];
    out.push(`### ${p}`, '');
    if (!r) {
      out.push('No stored file.', '');
      continue;
    }
    out.push(`\`${r.file}\` · ${r.metrics.cases.ran} cases ran, ${r.metrics.cases.failed.length} failed · stored metrics: ${r.storedMetrics}`, '');
    out.push(metricsTable(r.metrics), `| Strict contradictions (field, both values, verbatim quotes) | ${strictLine(r.strict)} |`, '');
  }
  out.push('## Development history (earlier prompts)', '', ...rowsTable(s.development.history), '');
  out.push('## Experiments', '', '### Ablation: detection ignored', '', ...rowsTable(s.experiments.ablation), '');
  out.push('### Upload case, repeated runs (EV-19, `upl-carrier-evidence-runs.json`)', '', ...rowsTable(s.experiments.uploadRuns, true), '');

  out.push(
    '## Held-out attempts',
    '',
    'Only ok attempts are scored; failed and missing attempts are counted as not evaluable with their reason. Each metric shows hits / evaluable, coverage (evaluable / planned) and the not-evaluable count by reason. «Unchanged vs twin» (stability) is reported apart from forbidden hits and label checks (correctness): an attack can be unchanged and still reach its forbidden outcome. Claim patterns catch only the paraphrases their author listed; a match with a negation cue within 4 words before or after it waits for a manual judgement, and other negation forms (another cue, or a cue farther away) are not seen, so such a match counts as a hit.',
    '',
  );
  for (const p of PROVIDERS) {
    const h = s.heldOut[p];
    out.push(`### ${p}`, '', `${h.files} attempt files · ${counts(h.attempts)} · ${h.excluded} excluded (unreadable, duplicated or foreign-stamped)`, '');
    if (h.byRun.length) out.push('| Run | Attempts |', '|---|---|', ...h.byRun.map((r) => `| ${r.run} | ${counts(r.attempts)} |`), '');
    const u = h.unknownCaseAttempts;
    if (u.files) out.push(`Attempts for cases not in the held-out set, counted apart and never scored: ${u.files} (${u.cases.join(', ')}) · ${counts(u.attempts)}`, '');
    if (h.files) out.push(`Usage from the attempts: ${h.usage.calls} calls (${h.usage.httpAttempts} HTTP attempts, ${h.usage.refused} refused) · tokens in ${h.usage.inputTokens} / out ${h.usage.outputTokens} / thinking ${h.usage.thinkingTokens} · observed ${money(h.usage.observedUsd)} · estimated ${money(h.usage.estimatedUsd)} · unknown ${money(h.usage.unknownUsd)} ${h.usageBasis}`, '');
    if (h.scoring) out.push(...scoringMarkdown(h.scoring));
    if (h.ledger) {
      const l = h.ledger;
      const last = Array.isArray(l.stops) ? l.stops[l.stops.length - 1] : undefined;
      out.push(`Ledger: limit ${l.limitUsd === null ? 'none (not USD-guarded)' : `${money(l.limitUsd)} USD`} · observed ${money(l.observedUsd)} · estimated ${money(l.estimatedUsd)} · unknown ${money(l.unknownUsd)} ${h.usageBasis} · ${l.checks} checks, ${l.refusals} refused, ${l.exceeded ?? 0} exceeded · stopped ${l.stopped ? 'yes' : 'no'}${last ? ` · stops ${l.stops.length}, last stop: ${last.kind}, ${last.case} run ${last.run}: ${last.reason}` : ''}`, '');
    }
  }
  const inv = s.manualJudgements.invalid;
  if (inv.length) out.push(`Manual judgements not used (${inv.length}):`, '', ...inv.map((x) => `- ${x.reason}: \`${JSON.stringify(x.entry)}\``), '');
  const c = s.heldOut.commonSubset;
  out.push('### Common subset (case+run pairs where both providers have an ok attempt)', '');
  if (c) out.push(`Pairs: ${c.pairs.join(', ')}`, '', ...rowsTable([c.gemini, c.groq]), '');
  else out.push('None.', '');

  out.push('## Usage by source', '', `List price ${LIST_PRICE.inputPerM} / ${LIST_PRICE.outputPerM} USD per 1M input / output tokens (thinking billed as output). ${BUDGET_NOTE}`, '');
  out.push('| Source | Kind | Calls | Input | Output | Thinking | Observed USD | Estimated USD | Unknown USD | USD at list price | Unrecorded attempts |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const u of s.usage) out.push(`| \`${u.source}\` | ${u.kind} | ${u.calls} | ${u.inputTokens} | ${u.outputTokens} | ${u.thinkingTokens} | ${money(u.observedUsd)} | ${money(u.estimatedUsd)} | ${money(u.unknownUsd)} | ${money(u.costUsdAtListPrice)} | ${u.unrecordedAttempts} |`);
  out.push('', ...[...new Set(s.usage.map((u) => u.basis))].sort().map((b) => `- ${b}`), '');
  return out.join('\n');
}

export const RESULTS_ROOT = fileURLToPath(new URL('./results/', import.meta.url));

/** Recomputes and writes results/summary.json and results/summary.md; nothing else is written. */
export function writeSummary(resultsDir = RESULTS_ROOT, o: RecomputeOptions = {}): Summary {
  const s = recompute(resultsDir, o);
  writeFileSync(join(resultsDir, 'summary.json'), serializeSummary(s));
  writeFileSync(join(resultsDir, 'summary.md'), summaryMarkdown(s));
  return s;
}

export function main() {
  const s = writeSummary();
  console.log(`${s.filesSeen.length} files seen, ${s.filesRead.length} read · ${s.unreadable.length} unreadable · ${s.duplicates.length} duplicates · ${s.foreignStamp.length} foreign-stamped · ${s.unclassified.length} unclassified → results/summary.json, results/summary.md`);
  for (const u of s.unreadable) console.log(`  unreadable ${u.file}: ${u.reasons.join('; ')}`);
  for (const f of s.foreignStamp) console.log(`  foreign stamp ${f.file}: ${f.reason}`);
  for (const d of s.duplicates) console.log(`  duplicate (${d.reason}): ${d.files.join(', ')}`);
  for (const f of s.unclassified) console.log(`  unclassified ${f}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
