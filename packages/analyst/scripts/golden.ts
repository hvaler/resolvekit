/**
 * Run the real analyst on the demo cases and save the result. With --golden the result is written to
 * packages/analyst/golden/<case>.json (committed: the demo works without a model key or quota); otherwise to the
 * directory given by --out (default: the git-ignored server cache).
 *
 *   npm run golden --workspace @resolvekit/analyst -- [--case PP-R-TVH-10190665] [--golden] [--out dir]
 *
 * Prints counts and token usage only.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASE_FILES } from '../../cases/src/index.ts';
import { GOLDEN_DIR } from '../src/cache.ts';
import { caseInput } from '../../cases/src/input.ts';
import { analysisKey } from '../src/key.ts';
import { analyzeCase } from '../src/pipeline.ts';
import { modelFromEnv } from '../src/providers.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const golden = args.includes('--golden');
const only = opt('--case');
const out = golden ? GOLDEN_DIR : (opt('--out') ?? fileURLToPath(new URL('../../../apps/server/data/analysis-cache/', import.meta.url)));

const cfg = modelFromEnv(process.env, { onFallback: (why) => console.log(`  fallback: ${why}`) });
if (!cfg) {
  console.error('Set GEMINI_API_KEY or GROQ_API_KEY');
  process.exit(1);
}

for (const c of Object.values(CASE_FILES)) {
  if (only && c.summary.id !== only) continue;
  // The case as the app shows it unbound (simulated PayPal; for the agent case, the demo MeterMCP session).
  const input = caseInput(c, { kind: 'simulated' });
  const key = await analysisKey(input, cfg.primary.model);
  console.log(`${c.summary.id} · key ${key.slice(0, 12)} · ${cfg.primary.provider}/${cfg.primary.model}`);
  const a = await analyzeCase(input, {
    model: cfg.model,
    requestedModel: cfg.primary.model,
    key,
    onProgress: (p) => console.log(`  ${p.stage}: ${p.label}`),
    onUsage: (u) => console.log(`  call ${u.stage} · ${u.provider}/${u.model} · in ${u.inputTokens} out ${u.outputTokens} thinking ${u.thinkingTokens} · ${u.ms} ms`),
  });
  mkdirSync(out, { recursive: true });
  const file = join(out, golden ? `${c.summary.id}.json` : `${key}.json`);
  writeFileSync(file, JSON.stringify(a, null, 2) + '\n');
  const v = (x: string) => a.sentences.filter((s) => s.verdict === x).length;
  console.log(
    `  → ${a.facts.length} facts (${a.droppedFacts} dropped) · ${a.timeline.length} events · ${a.contradictions.length} contradictions · sentences ${v('supported')} supported / ${v('needs_review')} review / ${v('rejected')} rejected · flags ${a.injections.map((f) => `${f.doc}(${f.by.join('+')})`).join(' ') || 'none'} · ${a.recommendation?.action ?? 'no recommendation'}`,
  );
  console.log(`  → ${file}`);
}
