/**
 * Run the development eval set (19 cases) against ONE real provider (no fallback, so each provider is measured on its
 * own) and save every analysis plus the metrics to evals/results/<provider>-<prompt version>.json.
 *
 *   npm run evals -- --provider gemini|groq [--case name] [--metrics-only] [--no-detection]
 *   npm run evals -- --recompute
 *
 * --metrics-only recomputes one provider's file from its saved results without calling a model.
 * --recompute calls no model and needs no key: it delegates to recompute.ts, which scores every stored result file
 * (development, history, experiments, held-out attempts) and writes results/summary.json and results/summary.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withRetries, type AnalystModel } from '../src/model.ts';
import { analyzeCase } from '../src/pipeline.ts';
import { PROMPT_VERSION } from '../src/prompts.ts';
import { GeminiModel, GroqModel } from '../src/providers.ts';
import { CASES } from './cases.ts';
import { computeMetrics, metricsTable, type CaseResult } from './metrics.ts';
import { main as recompute } from './recompute.ts';

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const provider = opt('--provider') ?? 'gemini';
const only = opt('--case');
const dir = fileURLToPath(new URL('./results/', import.meta.url));
// --no-detection: ablation over the injection cases (and their clean twin) with detection not fed to the analysis.
const noDetection = args.includes('--no-detection');
const file = `${dir}${provider}${noDetection ? '-nodetect' : ''}-${PROMPT_VERSION}.json`;
const selected = noDetection ? CASES.filter((c) => c.injection || CASES.some((x) => x.injection?.cleanTwin === c.name)) : CASES;

async function evalProvider() {
  const saved: { results: CaseResult[] } = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { results: [] };

  if (!args.includes('--metrics-only')) {
    let model: AnalystModel;
    if (provider === 'groq') {
      if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');
      model = withRetries(new GroqModel({ apiKey: process.env.GROQ_API_KEY, tpm: Number(process.env.GROQ_TPM) || 8_000 }), { retries: 3, maxDelayMs: 65_000 });
    } else {
      if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
      model = withRetries(new GeminiModel({ apiKey: process.env.GEMINI_API_KEY }), { retries: 2 });
    }
    for (const c of selected) {
      if (only && c.name !== only) continue;
      if (!only && saved.results.some((r) => r.name === c.name && r.analysis)) {
        console.log(`${c.name}: saved, skipped`);
        continue;
      }
      const t = Date.now();
      let r: CaseResult;
      try {
        r = { name: c.name, analysis: await analyzeCase(c.input, { model, ignoreDetection: noDetection }) };
        const a = r.analysis!;
        console.log(`${c.name}: ${a.facts.length} facts (${a.droppedFacts} dropped) · ${a.sentences.length} sentences · ${a.contradictions.length} contradictions · flags ${a.injections.map((f) => f.doc).join(',') || '-'} · ${a.recommendation?.action} · ${Date.now() - t} ms`);
      } catch (e) {
        r = { name: c.name, error: e instanceof Error ? e.message : String(e) };
        console.log(`${c.name}: FAILED ${r.error}`);
      }
      saved.results = [...saved.results.filter((x) => x.name !== c.name), r];
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify({ provider, promptVersion: PROMPT_VERSION, results: saved.results }, null, 2) + '\n');
    }
  }

  const m = computeMetrics(selected, saved.results);
  writeFileSync(file, JSON.stringify({ provider, promptVersion: PROMPT_VERSION, metrics: m, results: saved.results }, null, 2) + '\n');
  console.log(`\n${provider}${noDetection ? ' (detection ignored)' : ''} · ${PROMPT_VERSION} · ${m.cases.ran}/${selected.length} cases\n`);
  console.log(metricsTable(m));
  console.log('\nInjection cases:');
  for (const r of m.injection.rows) console.log(`  ${r.name}: flagged ${r.flagged} (pattern ${r.byPattern}, model ${r.byModel}, classifier ${r.byClassifier}) · unchanged ${r.unchanged}${r.detail.length ? ` · ${r.detail.join('; ')}` : ''}`);
  if (m.uploads) {
    console.log('\nUpload facts:');
    for (const r of m.uploads.rows) console.log(`  ${r.fact} (${r.doc}): extracted ${r.extracted} · cited from upload ${r.citedFromUpload} [${r.citedBy.join(', ')}] · other sentences cite ${r.docsCitedInstead.join(',') || '-'}`);
  }
  console.log(`\nFailures (${m.failures.length}):`);
  for (const f of m.failures) console.log(`  - ${f}`);
}

if (args.includes('--recompute')) recompute();
else await evalProvider();
