import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LIST_PRICE, newLedger } from '../evals/budget.ts';
import { CASES } from '../evals/cases.ts';
import type { HeldOutCase } from '../evals/heldout/schema.ts';
import type { CaseResult } from '../evals/metrics.ts';
import { recompute, serializeSummary, summaryMarkdown, writeSummary } from '../evals/recompute.ts';
import type { Attempt } from '../evals/runs.ts';

const RESULTS = fileURLToPath(new URL('../evals/results/', import.meta.url));
const G7 = 'gemini-rk-analyst-2026-10-09.7.json';
const R7 = 'groq-rk-analyst-2026-10-09.7.json';
const G6 = 'gemini-rk-analyst-2026-10-09.6.json';
const NODETECT = 'gemini-nodetect-rk-analyst-2026-10-09.6.json';
const UPL = 'upl-carrier-evidence-runs.json';
const stored = (f: string) => JSON.parse(readFileSync(join(RESULTS, f), 'utf8'));

/** Two held-out fixture cases over development inputs, so a stored real analysis scores against them. */
const base = (n: string) => CASES.find((c) => c.name === n)!;
const ho = (name: string, from: string): HeldOutCase => ({ ...base(from), name, set: 'held-out', group: name, conflicts: base(from).conflicts ?? [] }) as HeldOutCase;
const HELD_OUT = [ho('HO-A', 'nr-delivered'), ho('HO-B', 'nr-address-mismatch')];
const analysisOf = (n: string) => (stored(G7).results as CaseResult[]).find((r) => r.name === n)!.analysis!;

function attempt(provider: 'gemini' | 'groq', kase: string, run: number, status: Attempt['status'], o: { usd?: number; unknownUsd?: number } = {}): Attempt {
  const from = kase === 'HO-A' ? 'nr-delivered' : 'nr-address-mismatch';
  const usd = o.usd ?? 0.01;
  return {
    provider,
    case: kase,
    run,
    status,
    startedAt: '2026-10-19T10:00:00.000Z',
    finishedAt: '2026-10-19T10:00:30.000Z',
    ...(status === 'ok' ? {} : { error: 'fixture' }),
    stamp: { codeCommit: 'c0de', freezeCommit: 'f00', promptVersion: 'rk-analyst-2026-10-09.7', requestedModel: 'm', returnedModels: ['m'] },
    usage: { calls: 3, httpAttempts: 3, refused: 0, inputTokens: 1000, outputTokens: 200, thinkingTokens: 10, observedUsd: usd, unknownUsd: o.unknownUsd ?? 0, estimatedUsd: 0, costUsdAtListPrice: usd + (o.unknownUsd ?? 0), note: 'n' },
    ...(status === 'ok' ? { analysis: analysisOf(from) } : {}),
  };
}

/** A results directory with copies of the real development files and a small held-out batch. */
function fixtureDir(o: { heldOut?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'rk-recompute-'));
  for (const f of [G7, R7, G6, NODETECT, UPL]) copyFileSync(join(RESULTS, f), join(dir, f));
  if (o.heldOut !== false) {
    const put = (a: Attempt, name = `${a.run}.json`) => {
      mkdirSync(join(dir, 'heldout', a.provider, a.case), { recursive: true });
      writeFileSync(join(dir, 'heldout', a.provider, a.case, name), JSON.stringify(a, null, 2) + '\n');
    };
    for (const run of [1, 2, 3]) {
      put(attempt('gemini', 'HO-A', run, 'ok'));
      put(attempt('gemini', 'HO-B', run, 'ok'));
      put(attempt('groq', 'HO-A', run, 'ok'));
      put(attempt('groq', 'HO-B', run, run === 2 ? 'provider_error' : 'ok', run === 2 ? { usd: 0, unknownUsd: 0.002 } : {}));
    }
    for (const p of ['gemini', 'groq'] as const) {
      const l = { ...newLedger(p, 1), observedUsd: 0.06, estimatedUsd: 0.001, unknownUsd: p === 'groq' ? 0.002 : 0, checks: 18, freeze: { commit: 'f00', hash: 'h' } };
      writeFileSync(join(dir, 'heldout', p, 'budget.json'), JSON.stringify(l, null, 2) + '\n');
    }
  }
  return dir;
}

/** Every file under a directory with the sha256 of its bytes, to show nothing was changed. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out[p] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

test('recompute reads every stored file, EV-19 runs included, and calls no provider', () => {
  const dir = fixtureDir();
  writeFileSync(join(dir, 'notes.txt'), 'a stray file\n');
  const keys = { g: process.env.GEMINI_API_KEY, q: process.env.GROQ_API_KEY };
  delete process.env.GEMINI_API_KEY;
  delete process.env.GROQ_API_KEY;
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    throw new Error('no network in recompute');
  }) as typeof fetch;
  try {
    const s = recompute(dir, { heldOutCases: HELD_OUT });
    assert.equal(fetched, 0);
    assert.deepEqual(s.filesSeen, [...s.filesSeen].sort());
    for (const f of [G7, R7, G6, NODETECT, UPL, 'heldout/gemini/HO-A/1.json', 'heldout/groq/budget.json', 'notes.txt']) assert.ok(s.filesSeen.includes(f), f);
    // an unclassified file is listed, never opened
    assert.deepEqual(s.filesRead, s.filesSeen.filter((f) => f !== 'notes.txt'));
    const cls = Object.fromEntries(s.files.map((f) => [f.file, f.class]));
    assert.equal(cls[G7], 'development-headline');
    assert.equal(cls[G6], 'development-history');
    assert.equal(cls[NODETECT], 'experiment-ablation');
    assert.equal(cls[UPL], 'experiment-upload-runs');
    assert.equal(cls['heldout/groq/HO-B/2.json'], 'heldout-attempt');
    assert.equal(cls['heldout/gemini/budget.json'], 'heldout-ledger');
    assert.equal(cls['notes.txt'], 'unclassified');
    assert.deepEqual(s.unclassified, ['notes.txt']);
    // EV-19: one row per run and one per provider over its three runs, under experiments (ruling B2)
    const up = s.experiments.uploadRuns;
    assert.equal(up.filter((r) => r.runs === 1).length, 6);
    const g = up.find((r) => r.provider === 'gemini' && r.runs === 3)!;
    assert.deepEqual(g.metrics.citationValidity, { n: 72, of: 72, rate: 1 });
    assert.equal(g.metrics.uploads!.requiredCited.n, 9);
    assert.equal(s.experiments.ablation.length, 1);
    assert.equal(s.development.history.length, 1);
    assert.equal(s.heldOut.gemini.attempts.ok, 6);
    assert.equal(s.heldOut.groq.attempts.provider_error, 1);
  } finally {
    globalThis.fetch = realFetch;
    if (keys.g !== undefined) process.env.GEMINI_API_KEY = keys.g;
    if (keys.q !== undefined) process.env.GROQ_API_KEY = keys.q;
  }
});

test('the headline development row for gemini equals the stored .7 metrics', () => {
  const s = recompute(RESULTS);
  const h = s.development.headline.gemini!;
  assert.equal(h.promptVersion, 'rk-analyst-2026-10-09.7');
  assert.equal(h.file, G7);
  assert.deepEqual(h.metrics.citationValidity, { n: 374, of: 374, rate: 1 });
  assert.deepEqual(h.metrics.contradictionRecall, { n: 13, of: 13, rate: 1 });
  assert.deepEqual(h.metrics.trueNotesSupported, { n: 12, of: 15, rate: 0.8 });
  assert.deepEqual(h.metrics.injection.unchanged, { n: 10, of: 10, rate: 1 });
  assert.equal(h.storedMetrics, 'match');
  // the strict result sits in every row, coverage and hits apart, not evaluable by reason
  for (const r of [...Object.values(s.development.headline), ...s.development.history, ...s.experiments.ablation, ...s.experiments.uploadRuns]) {
    if (!r) continue;
    assert.ok(r.strict.coverage && r.strict.hits && r.strict.notEvaluableByReason, r.label);
  }
  assert.deepEqual(s.unreadable, []);
  assert.deepEqual(s.unclassified, []);
  assert.equal(s.development.history.length, 6);
});

test('an unparseable or partial file is listed in unreadable, never skipped silently', () => {
  const dir = fixtureDir();
  // an attempt being written (truncated), an attempt without a status, a development file without results
  writeFileSync(join(dir, 'heldout', 'gemini', 'HO-A', '4.json'), '{"provider":"gemini","case":"HO-A","ru');
  const partial = attempt('gemini', 'HO-B', 4, 'ok') as Partial<Attempt>;
  delete partial.status;
  writeFileSync(join(dir, 'heldout', 'gemini', 'HO-B', '4.json'), JSON.stringify(partial));
  writeFileSync(join(dir, 'groq-rk-analyst-2026-10-09.4.json'), JSON.stringify({ provider: 'groq', promptVersion: 'rk-analyst-2026-10-09.4' }));
  const s = recompute(dir, { heldOutCases: HELD_OUT });
  const bad = Object.fromEntries(s.unreadable.map((u) => [u.file, u.reasons.join('; ')]));
  assert.match(bad['heldout/gemini/HO-A/4.json']!, /not valid JSON/);
  assert.match(bad['heldout/gemini/HO-B/4.json']!, /incomplete: status/);
  assert.match(bad['groq-rk-analyst-2026-10-09.4.json']!, /incomplete: results/);
  // excluded from the aggregates, with their count shown
  assert.equal(s.heldOut.gemini.attempts.ok, 6);
  assert.equal(s.heldOut.gemini.excluded, 2);
  assert.equal(s.development.history.length, 1);
  const md = summaryMarkdown(s);
  assert.match(md, /Unreadable files \(3\)/);
  assert.match(md, /heldout\/gemini\/HO-A\/4\.json/);
});

test('duplicate attempts are reported and excluded, never picked', () => {
  const dir = fixtureDir();
  // the same provider+case+run under a second name, and identical bytes under two names
  writeFileSync(join(dir, 'heldout', 'gemini', 'HO-A', '01.json'), JSON.stringify(attempt('gemini', 'HO-A', 1, 'provider_error')));
  copyFileSync(join(dir, G6), join(dir, 'gemini-rk-analyst-2026-10-09.5.json'));
  const s = recompute(dir, { heldOutCases: HELD_OUT });
  const key = s.duplicates.find((d) => d.reason === 'same attempt')!;
  assert.deepEqual(key.files, ['heldout/gemini/HO-A/01.json', 'heldout/gemini/HO-A/1.json']);
  const same = s.duplicates.find((d) => d.reason === 'same content')!;
  assert.deepEqual(same.files, ['gemini-rk-analyst-2026-10-09.5.json', G6]);
  assert.equal(s.heldOut.gemini.attempts.ok, 5);
  assert.equal(s.heldOut.gemini.attempts.provider_error, 0);
  assert.equal(s.development.history.length, 0);
  assert.match(summaryMarkdown(s), /Duplicates \(2\)/);
});

test('two recomputes give the same bytes, and no stored file is touched', () => {
  const dir = fixtureDir();
  const before = snapshot(dir);
  const a = serializeSummary(recompute(dir, { heldOutCases: HELD_OUT }));
  const b = serializeSummary(recompute(dir, { heldOutCases: HELD_OUT }));
  assert.equal(a, b);
  writeSummary(dir, { heldOutCases: HELD_OUT });
  const first = { json: readFileSync(join(dir, 'summary.json'), 'utf8'), md: readFileSync(join(dir, 'summary.md'), 'utf8') };
  writeSummary(dir, { heldOutCases: HELD_OUT });
  assert.equal(readFileSync(join(dir, 'summary.json'), 'utf8'), first.json);
  assert.equal(readFileSync(join(dir, 'summary.md'), 'utf8'), first.md);
  const after = snapshot(dir);
  // only the two summary files are new; every source file has the same bytes
  assert.deepEqual(Object.keys(after).filter((f) => !(f in before)).map((f) => f.slice(dir.length + 1)).sort(), ['summary.json', 'summary.md']);
  for (const [f, h] of Object.entries(before)) assert.equal(after[f], h, f);
  // the summary files are not inputs of the next recompute
  assert.ok(!recompute(dir, { heldOutCases: HELD_OUT }).filesSeen.includes('summary.json'));
});

test('the common subset compares providers only on cases both completed with ok attempts', () => {
  const s = recompute(fixtureDir(), { heldOutCases: HELD_OUT });
  const c = s.heldOut.commonSubset!;
  // groq's HO-B run 2 is a provider error: HO-B run 2 is out for both providers
  assert.deepEqual(c.pairs, ['HO-A#1', 'HO-A#2', 'HO-A#3', 'HO-B#1', 'HO-B#3']);
  assert.deepEqual(c.cases, ['HO-A', 'HO-B']);
  assert.equal(c.gemini.metrics.cases.ran, 5);
  assert.equal(c.groq.metrics.cases.ran, 5);
  assert.deepEqual(c.gemini.metrics.contradictionRecall, c.groq.metrics.contradictionRecall);
  assert.equal(c.gemini.metrics.contradictionRecall.of, 2);
  // with no ok attempt on one side there is nothing to compare
  const only = fixtureDir({ heldOut: false });
  assert.equal(recompute(only, { heldOutCases: HELD_OUT }).heldOut.commonSubset, null);
});

test('usage cost is computed from stored usage at 0.75 / 3.75 USD per 1M, and no figure without a stored source appears', () => {
  assert.deepEqual(LIST_PRICE, { inputPerM: 0.75, outputPerM: 3.75 });
  const dir = fixtureDir();
  const s = recompute(dir, { heldOutCases: HELD_OUT });
  const u = stored(G7).metrics.usage;
  const g7 = s.usage.find((x) => x.source === G7)!;
  assert.equal(g7.calls, u.calls);
  assert.equal(g7.inputTokens, u.inputTokens);
  assert.equal(g7.outputTokens, u.outputTokens);
  assert.equal(g7.thinkingTokens, u.thinkingTokens);
  // thinking is billed as output
  assert.equal(g7.costUsdAtListPrice, (u.inputTokens * 0.75 + (u.outputTokens + u.thinkingTokens) * 3.75) / 1e6);
  assert.equal(g7.observedUsd, g7.costUsdAtListPrice);
  assert.equal(g7.unknownUsd, null);
  // Groq development runs used the free tier: no list price is stored for them, so no cost is invented
  const r7 = s.usage.find((x) => x.source === R7)!;
  assert.equal(r7.costUsdAtListPrice, null);
  assert.equal(r7.unrecordedAttempts, 11);
  // held-out: the split stored by the runner, from the attempts and from the ledger, apart
  const att = s.usage.find((x) => x.source === 'heldout/groq attempts')!;
  assert.equal(att.unknownUsd, 0.002);
  assert.equal(Number(att.observedUsd!.toFixed(6)), 0.05);
  const led = s.usage.find((x) => x.source === 'heldout/groq/budget.json')!;
  assert.deepEqual([led.observedUsd, led.estimatedUsd, led.unknownUsd], [0.06, 0.001, 0.002]);
  // every cost comes from its own source: tokens the source stored (priced at list price), the attempts' stored
  // figures, or the ledger's stored figures; a row with a cost and no stored tokens is only ever a ledger
  const ledgerFile = (p: string) => JSON.parse(readFileSync(join(dir, 'heldout', p, 'budget.json'), 'utf8'));
  for (const x of s.usage) {
    if (x.costUsdAtListPrice === null) continue;
    if (x.kind === 'held-out ledger') {
      const l = ledgerFile(x.provider);
      assert.equal(x.costUsdAtListPrice, l.observedUsd + l.estimatedUsd + l.unknownUsd, x.source);
      continue;
    }
    assert.ok(x.inputTokens + x.outputTokens + x.thinkingTokens > 0, `${x.source}: a cost without stored tokens`);
    if (x.kind === 'development' || x.kind === 'experiment') assert.equal(x.costUsdAtListPrice, (x.inputTokens * 0.75 + (x.outputTokens + x.thinkingTokens) * 3.75) / 1e6, x.source);
    else assert.equal(x.costUsdAtListPrice, Number(x.observedUsd) + Number(x.unknownUsd) + Number(x.estimatedUsd), x.source);
  }
  // a Gemini development file whose results all failed stored no tokens: no figure for it
  const empty = fixtureDir({ heldOut: false });
  const g = stored(G6);
  writeFileSync(join(empty, G6), JSON.stringify({ provider: 'gemini', promptVersion: g.promptVersion, results: g.results.map((r: CaseResult) => ({ name: r.name, error: 'failed' })) }));
  assert.equal(recompute(empty).usage.find((x) => x.source === G6)!.costUsdAtListPrice, null);
  const md = summaryMarkdown(s);
  assert.doesNotMatch(md, /0\.20\b/);
  assert.doesNotMatch(serializeSummary(s), /"0\.2"|0\.20\b/);
});

test('a partially bad EV-19 file contributes no rows and no usage, with every reason on one entry', () => {
  const dir = fixtureDir({ heldOut: false });
  const j = stored(UPL);
  // two runs whose analysis cannot be scored (facts missing): the whole file is out, rows and usage included
  for (const i of [0, 3]) j.runs[i].result.analysis = { ...j.runs[i].result.analysis, facts: undefined };
  writeFileSync(join(dir, UPL), JSON.stringify(j));
  const s = recompute(dir);
  const bad = s.unreadable.filter((u) => u.file === UPL);
  assert.equal(bad.length, 1);
  assert.ok(bad[0]!.reasons.length >= 2, bad[0]!.reasons.join('; '));
  assert.ok(bad[0]!.reasons.every((r) => /could not be scored/.test(r)));
  assert.deepEqual(s.experiments.uploadRuns, []);
  assert.deepEqual(s.usage.filter((x) => x.source.startsWith(UPL)), []);
});

test('an EV-19 file repeating a provider+run entry is reported as a duplicate and left out', () => {
  const dir = fixtureDir({ heldOut: false });
  const j = stored(UPL);
  j.runs.push(j.runs[1]);
  writeFileSync(join(dir, UPL), JSON.stringify(j));
  const s = recompute(dir);
  assert.deepEqual(s.duplicates, [{ reason: 'same run entry', key: 'upl-carrier-evidence gemini run 2', files: [UPL] }]);
  assert.deepEqual(s.experiments.uploadRuns, []);
  assert.deepEqual(s.usage.filter((x) => x.source.startsWith(UPL)), []);
});

test('attempts for cases outside the held-out set are counted apart, with their own usage row', () => {
  const dir = fixtureDir();
  mkdirSync(join(dir, 'heldout', 'gemini', 'HO-Z'), { recursive: true });
  writeFileSync(join(dir, 'heldout', 'gemini', 'HO-Z', '1.json'), JSON.stringify(attempt('gemini', 'HO-Z', 1, 'ok', { usd: 0.5 })));
  const s = recompute(dir, { heldOutCases: HELD_OUT });
  const g = s.heldOut.gemini;
  assert.equal(g.attempts.ok, 6);
  assert.equal(g.files, 6);
  assert.deepEqual(g.byRun.map((r) => r.attempts.ok), [2, 2, 2]);
  assert.ok(!g.byCase.some((c) => c.case === 'HO-Z'));
  assert.deepEqual([g.unknownCaseAttempts.files, g.unknownCaseAttempts.cases, g.unknownCaseAttempts.attempts.ok], [1, ['HO-Z'], 1]);
  assert.equal(Number(g.usage.observedUsd.toFixed(6)), 0.06);
  const u = s.usage.find((x) => x.kind === 'held-out attempts, unknown cases')!;
  assert.equal(u.source, 'heldout/gemini attempts for cases not in the held-out set');
  assert.equal(u.observedUsd, 0.5);
  assert.match(summaryMarkdown(s), /counted apart and never scored: 1 \(HO-Z\)/);
});

test('attempts stamped with another prompt version or freeze commit are foreign and left out', () => {
  const put = (dir: string, a: Attempt) => writeFileSync(join(dir, 'heldout', a.provider, a.case, `${a.run}.json`), JSON.stringify(a));
  const old = attempt('gemini', 'HO-A', 4, 'ok');
  old.stamp = { ...old.stamp, promptVersion: 'rk-analyst-2026-10-09.6' };
  const other = attempt('gemini', 'HO-B', 4, 'ok');
  other.stamp = { ...other.stamp, freezeCommit: 'beef' };
  const dir = fixtureDir();
  put(dir, old);
  put(dir, other);
  const s = recompute(dir, { heldOutCases: HELD_OUT });
  assert.deepEqual(s.foreignStamp.map((f) => f.file), ['heldout/gemini/HO-A/4.json', 'heldout/gemini/HO-B/4.json']);
  assert.match(s.foreignStamp[0]!.reason, /prompt version rk-analyst-2026-10-09\.6/);
  assert.match(s.foreignStamp[1]!.reason, /freeze commit beef; the ledger pins f00/);
  assert.equal(s.heldOut.gemini.attempts.ok, 6);
  assert.equal(s.heldOut.gemini.excluded, 2);
  assert.deepEqual(s.heldOut.gemini.stamps.freezeCommits, ['f00']);
  assert.match(summaryMarkdown(s), /Foreign-stamped held-out attempts \(2\)/);
  // without a usable ledger, several freeze commits cannot be told apart: all of that provider's attempts are out
  const noLedger = fixtureDir();
  writeFileSync(join(noLedger, 'heldout', 'gemini', 'budget.json'), '');
  put(noLedger, other);
  const t = recompute(noLedger, { heldOutCases: HELD_OUT });
  assert.equal(t.heldOut.gemini.ledger, null);
  assert.equal(t.heldOut.gemini.files, 0);
  assert.equal(t.foreignStamp.length, 7);
  assert.match(t.foreignStamp[0]!.reason, /2 freeze commits among the gemini attempts \(beef, f00\) and no ledger pins one/);
});

test('a -nodetect file of a newer or other prompt version is unclassified', () => {
  const dir = fixtureDir({ heldOut: false });
  copyFileSync(join(RESULTS, NODETECT), join(dir, 'gemini-nodetect-rk-analyst-2026-10-09.8.json'));
  copyFileSync(join(RESULTS, NODETECT), join(dir, 'gemini-nodetect-rk-analyst-2026-11-01.1.json'));
  const s = recompute(dir);
  assert.deepEqual(s.unclassified, ['gemini-nodetect-rk-analyst-2026-10-09.8.json', 'gemini-nodetect-rk-analyst-2026-11-01.1.json']);
  assert.equal(s.experiments.ablation.length, 1);
});
