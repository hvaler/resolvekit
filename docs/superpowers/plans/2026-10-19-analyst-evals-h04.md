# Analyst evaluations that say what they prove (H-04) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The analyst's evaluation says exactly what it measured:
- a strict contradiction metric next to the old one;
- cases labelled as development or held-out, grouped by base case;
- a frozen held-out set of 12 cases prepared by a separate reviewer;
- repeated runs under a hard budget;
- one recompute command over every stored result;
- a rewritten `docs/evals.md`.

**Architecture:**
- **Scoring** stays pure, in `packages/analyst/evals/metrics.ts` (plus `strict.ts`): every figure is recomputable from stored JSON.
- **Held-out cases** live in their own module (`evals/heldout/`), sharing no builders with `cases.ts`.
- **A new runner** (`evals/runs.ts`) makes N stamped attempts per case through a budget-guarded model wrapper and stores one file per attempt.
- **`evals/recompute.ts`** reads everything and writes `summary.json`/`summary.md`.

**Tech Stack:** TypeScript on Node 24 (runs `.ts` directly), `node:test` (`packages/analyst` tests: `npm test --workspace @resolvekit/analyst`). The analyst's own providers (`GeminiModel`, `GroqModel`, `withRetries`) and `analyzeCase` stay as they are.

**Spec:** `docs/superpowers/specs/2026-10-19-analyst-evals-h04-design.md` (approved with run conditions). Executors read both.

## Global Constraints

- **The prompt is not changed** (`PROMPT_VERSION` stays `rk-analyst-2026-10-09.7`). Nothing in `packages/analyst/src` changes behaviour; a provider may only expose fields it already receives.
- **The old pair metric is kept unchanged.** The strict metric is added next to it.
- **Strict match:**
  - expected conflict `{ field, a: { doc, value }, b: { doc, value } }`;
  - an output contradiction matches when its two sides cite the expected two documents (either order), each side's value equals the expected value after normalisation, each side's quote is verbatim in its document (re-verified), and its field maps to the expected field through the synonym table.
- **Normalisations:**
  - case and whitespace folding;
  - NFKC;
  - money: strip the currency code or symbol, compare cents;
  - dates: ISO day;
  - addresses and postcodes: remove punctuation, keep letters and digits («Flat 2» ≠ «Flat 2B»).

  No fuzzy matching.
- **Not evaluable** (count and reason always published; never counted as correct):
  - `no_value`: a side whose value is the whole quote (the pipeline's fallback);
  - `quote_unverifiable`: a quote that is not verbatim in its document or names a missing document;
  - `no_field`: no field could be mapped from title or shortName;
  - `provider_error`: a missing attempt;
  - `twin_missing`: an attack pair without both runs.
- **Extras:** a contradiction matching no expected conflict is an extra, listed with its field and values.
- **Sets:**
  - the existing 19 cases are `set: 'development'` (EV-19 included), never reclassified;
  - injection variants have `group` = their base case's name;
  - the new 12 are `set: 'held-out'`.
- **Budget:**
  - a hard limit of `1.00` USD per Gemini batch, retries and auxiliary calls included;
  - list price `0.75` USD / 1M input tokens and `3.75` USD / 1M output tokens (thinking counted as output);
  - the runner stops before a call that could exceed the limit, and keeps every result.
- **Pinned models:** Gemini `gemini-3.8-flash`, Groq `openai/gpt-oss-120b`. Each call records the model the provider returned (`CallUsage.model`).
- **Attempts:**
  - run indices 1..N, one file per attempt, append-only;
  - status `ok | provider_error | product_error | budget_stopped`;
  - no cache;
  - never pick the best attempt, never replace one.
- **Injection:**
  - «unchanged» pairs attack run *i* with twin run *i*; it measures stability, not correctness;
  - every result is also checked against its own frozen labels;
  - held-out attacks carry `forbidden` outcomes;
  - development keeps the global heuristic (citing the injected doc, or `/refund/i`), documented.
- **Kept out:** «kept out of what can be sent» counts `needs_review` as kept out. This is documented.
- **Groq** runs only within its free quota. Providers are compared only on the subset both completed.
- **Uploads** via `uploadDocuments` evaluate how the analyst's input is built. They are never presented as an evaluation of OCR, covering or the UI.
- **Scope:** these are analyst evaluations, not evaluations of the buying agent.

## Review Focus

1. **A model output with the right documents but the values swapped between sides, or a value from a third document.** Expected: a strict miss, not a hit. Test in Task 1.
2. **A stored result file from an older version with fields the scorer does not expect** (no `value`, no `shortName`). Expected: not evaluable with its reason, never a crash. Test in Task 1.
3. **A provider 429 or quota error mid-batch.** Expected: that attempt is stored as `provider_error`; the batch continues with the next case (Gemini) or stops cleanly (Groq quota); recompute reports it. Test in Task 4.
4. **The budget reached during a case's retries.** Expected: the guard refuses the next call before it is made; the attempt is stored as `budget_stopped` with its partial usage; the batch stops; no later case starts. Test in Task 4.
5. **Recompute run twice, or with a held-out attempt file being written.** Expected: same summary bytes (deterministic order); partial or unparseable files are reported as unreadable, never silently skipped. Test in Task 3.

---

### Task 1: Strict contradiction metric, sets and groups

**Files:**
- Create: `packages/analyst/evals/strict.ts`
- Modify: `packages/analyst/evals/cases.ts` (`EvalCase` gains `set`, `group`, `conflicts?`; every existing case gets `set: 'development'` and its `group`; fix the stale «18 cases» comment), `packages/analyst/evals/metrics.ts` (`Metrics` gains `strictContradictions`; `computeMetrics` calls `scoreStrict`)
- Test: `packages/analyst/test/evals-strict.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // cases.ts
  export type EvalSet = 'development' | 'held-out';
  export interface ExpectedConflict { field: ConflictField; a: { doc: string; value: string }; b: { doc: string; value: string } }
  export type ConflictField = 'address' | 'postcode' | 'amount' | 'date' | 'quantity' | 'name' | 'item' | 'tracking';
  // EvalCase gains: set: EvalSet; group: string; conflicts?: ExpectedConflict[]  (absent = not labelled strictly yet)
  // strict.ts
  export type NotEvaluableReason = 'no_value' | 'quote_unverifiable' | 'no_field' | 'not_labelled';
  export function normalise(field: ConflictField, value: string): string;
  export function fieldOf(c: Contradiction): ConflictField | null; // synonym table over title + shortName
  export interface StrictScore {
    expected: number; found: number; missed: number;
    extras: Array<{ case: string; field: ConflictField | null; a: string; b: string }>;
    notEvaluable: Array<{ case: string; contradiction: string; reason: NotEvaluableReason }>;
  }
  export function scoreStrict(c: EvalCase, a: CaseAnalysis): StrictScore;
  // metrics.ts: Metrics gains strictContradictions: StrictScore (summed over cases); bySet and byGroup counts on every Ratio-bearing metric
  ```
- The synonym table (exported `FIELD_SYNONYMS: Record<ConflictField, RegExp>`) is matched against `title` and `shortName`. Examples: address ↔ /address|ship|deliver|flat|apt/; amount ↔ /amount|total|charge|captur|price/.

- [ ] **Step 1: Write the failing tests** (handmade `CaseAnalysis` objects; the documents come from the case input):
  - `normalise: money compares cents ("42.00 USD" = "$42" = "42"), addresses keep letters and digits ("Flat 2" ≠ "Flat 2B"), dates to ISO day, case and NFKC folded`.
  - `a contradiction with the expected documents, values and field is found, in either side order`.
  - `the right documents with the values swapped between sides is a miss` (Review Focus 1).
  - `a value found elsewhere in the analysis but not in the contradiction is a miss`.
  - `a side whose value equals its whole quote is not evaluable (no_value)`, and a side quote not verbatim in its document is `quote_unverifiable` (Review Focus 2).
  - `a contradiction matching no expected conflict is an extra, listed with field and values`.
  - `a case without conflicts labels is not_labelled, not a hit or a miss`.
  - `the old pair metric is unchanged`: `computeMetrics` on a stored results file (`results/gemini-rk-analyst-2026-10-09.7.json`) still gives `contradictionRecall` 13/13 and the other existing figures (citation 374/374 …).
  - `every development case has set 'development' and a group; the 10 injection cases share the group of nr-address-mismatch`.
- [ ] **Step 2:** Run `npm test --workspace @resolvekit/analyst`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `strict.ts`, the case metadata and the `Metrics` additions.
- [ ] **Step 4:** Run the analyst tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(evals): strict contradiction scoring next to the pair metric; development set and groups`.

### Task 2: Strict labels for the development set (labeller, then label check)

This is authoring, not code. The controller dispatches it as two separate subagents.

**Files:**
- Create: `packages/analyst/evals/dev-labels.ts`, exporting `DEV_CONFLICTS: Record<string, ExpectedConflict[]>`, keyed by case name. Every case that has `contradictions` gets one entry per pair; cases without contradictions get `[]`.
- Modify: `packages/analyst/evals/cases.ts`, so `conflicts` is read from `DEV_CONFLICTS`.
- Create: `packages/analyst/evals/dev-labels.md`, recording who labelled, what they were shown (the case input documents only), the date (19/10/2026), the checker's disagreements and their resolution.

**Interfaces:**
- Consumes: `ExpectedConflict`, `ConflictField` (Task 1).

- [ ] **Step 1 (labeller subagent):**
  - Given `cases.ts` (its documents and contradiction pairs) and the Task 1 types only, never any file under `evals/results/` or `golden/`, write each expected conflict's field and both values verbatim from the documents.
- [ ] **Step 2 (checker subagent, fresh):**
  - Given `cases.ts` and `dev-labels.ts`, never the results, check each label against the documents and list its disagreements in `dev-labels.md`.
- [ ] **Step 3 (controller):** Rule on the disagreements and record the rulings in `dev-labels.md`.
- [ ] **Step 4:** Add a test in `evals-strict.test.ts`: `every development case with contradiction pairs has exactly one strict label per pair, naming the same two documents`.
- [ ] **Step 5:** Run the analyst tests. Expected: PASS.
- [ ] **Step 6:** Commit `evals: strict labels for the development set, written from the documents without seeing outputs`.

### Task 3: One recompute command over every stored result

**Files:**
- Create: `packages/analyst/evals/recompute.ts`
- Modify: `packages/analyst/evals/run.ts` (`--recompute` delegates to `recompute.ts`; fix the stale header), `packages/analyst/package.json` (`"evals:recompute": "node evals/recompute.ts"`), root `package.json` (`"evals:recompute"`)
- Test: `packages/analyst/test/evals-recompute.test.ts`

**Interfaces:**
- Consumes:
  - `computeMetrics`, `scoreStrict` (Task 1);
  - the stored files: `results/<provider>[-nodetect]-<prompt>.json`, `results/upl-carrier-evidence-runs.json` (`{ case, promptVersion, runs: [{ provider, run, result }] }`), and the Task 4 attempt files `results/heldout/<provider>/<case>/<run>.json`.
- Produces:
  ```ts
  export interface Summary {
    generatedFrom: string[];            // every file read, sorted
    unreadable: Array<{ file: string; reason: string }>;
    development: { headline: Record<'gemini' | 'groq', MetricsRow>; history: MetricsRow[]; ablation: MetricsRow[]; uploadRuns: MetricsRow[] };
    heldOut: Record<'gemini' | 'groq', HeldOutRow> & { commonSubset: { cases: string[]; gemini: MetricsRow; groq: MetricsRow } | null };
    usage: Array<{ source: string; calls: number; inputTokens: number; outputTokens: number; costUsdAtListPrice: number }>;
  }
  // MetricsRow = { label, promptVersion, provider, cases, runs, metrics: Metrics }
  // HeldOutRow = { attempts: { ok, provider_error, product_error, budget_stopped }, perRun: MetricsRow[], spread: Record<metric, { min, median, max }>, notEvaluable: count by reason, injectionPairs: …, labelChecks: … }
  export function recompute(resultsDir: string): Summary;   // pure over the files; no provider, no env keys
  export function summaryMarkdown(s: Summary): string;     // the tables docs/evals.md quotes
  ```
  - Writes `results/summary.json` and `results/summary.md` with a deterministic key and row order.
  - `headline` is prompt `.7` per provider; `history` holds `.3`–`.6`; `ablation` is the `nodetect` file.

- [ ] **Step 1: Write the failing tests** (a temporary results directory with fixture files):
  - `recompute reads every stored file, EV-19 runs included, and calls no provider`: run with `GEMINI_API_KEY`/`GROQ_API_KEY` unset.
  - `the headline development row for gemini equals the stored .7 metrics` (on the real `results/` directory: 374/374, 13/13 …).
  - `an unparseable or partial file is listed in unreadable, never skipped silently` (Review Focus 5).
  - `two recomputes give the same bytes` (Review Focus 5).
  - `the common subset compares providers only on cases both completed with ok attempts`.
  - `usage cost is computed from stored usage at 0.75 / 3.75 USD per 1M`, and no figure without a stored source appears.
- [ ] **Step 2:** Run the analyst tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests, then `npm run evals:recompute`. Expected: PASS; `summary.json` and `summary.md` written; the development headline matches `docs/evals.md`'s current Gemini `.7` figures.
- [ ] **Step 5:** Commit `feat(evals): one recompute command over every stored result, EV-19 included, without calling providers`.

### Task 4: Repeated-run runner with a budget guard and stamped attempts

**Files:**
- Create: `packages/analyst/evals/heldout/schema.ts`, `packages/analyst/evals/budget.ts`, `packages/analyst/evals/runs.ts`
- Modify: `packages/analyst/package.json` (`"evals:heldout": "node --env-file-if-exists=../../.env evals/runs.ts"`), root `package.json` (`"evals:heldout"`)
- Test: `packages/analyst/test/evals-runs.test.ts`

**Interfaces:**
- Consumes: `analyzeCase`, `GeminiModel`, `GroqModel`, `withRetries`, `ModelError` (analyst src); `EvalCase`, `ExpectedConflict` (Task 1).
- Produces:
  ```ts
  // heldout/schema.ts
  export interface Forbidden { action?: string; checklistChange?: boolean; claimPattern?: string /* regex source */ }
  export interface HeldOutCase extends EvalCase { set: 'held-out'; conflicts: ExpectedConflict[]; injection?: { doc: string; cleanTwin: string; forbidden: Forbidden } }
  // budget.ts
  export const LIST_PRICE = { inputPerM: 0.75, outputPerM: 3.75 };
  export class BudgetExceeded extends Error {}
  /** Wraps the RAW provider model (below withRetries), so each HTTP attempt is guarded and counted. */
  export function budgetGuard(model: AnalystModel, o: { limitUsd: number; ledger: { spentUsd: number } }): AnalystModel;
  // runs.ts CLI: --provider gemini|groq --runs 3 --budget 1.00 [--case name]
  export interface Attempt {
    case: string; run: number; status: 'ok' | 'provider_error' | 'product_error' | 'budget_stopped';
    startedAt: string; finishedAt: string; error?: string;
    stamp: { codeCommit: string; freezeCommit: string; promptVersion: string; requestedModel: string; returnedModels: string[] };
    usage: { calls: number; inputTokens: number; outputTokens: number; costUsdAtListPrice: number };
    analysis?: CaseAnalysis;
  }
  ```
- **The guard:**
  - Before each call it reserves the worst case: input tokens estimated as `ceil(chars/4)` of system + user, plus `req.maxOutputTokens`, at list price. It refuses with `BudgetExceeded` if the worst case does not fit in the remaining budget.
  - After the call it settles to the reported usage. A failed HTTP call settles to 0.
  - The ledger is shared across the whole batch and persisted as `results/heldout/<provider>/budget.json`.
- **The runner:**
  - It takes cases from `HELD_OUT_CASES` (Task 5), run by run (all cases for run 1, then all for run 2, …).
  - It writes `results/heldout/<provider>/<case>/<run>.json` and refuses to overwrite an existing attempt file.
  - It calls `analyzeCase` fresh each time: no `cache.ts` import, and a test asserts that.
  - `freezeCommit` comes from `git log -1 --format=%H -- evals/heldout` and `codeCommit` from `git rev-parse HEAD`. It refuses to run with uncommitted changes under `packages/analyst`.
  - **Gemini:** on `BudgetExceeded` it stores `budget_stopped` and stops the batch.
  - **Groq:** on a quota or 429 that the retries cannot clear, it stores `provider_error` and stops the batch («quota»).
  - A product exception becomes `product_error`, and the batch continues.

- [ ] **Step 1: Write the failing tests** (a fake raw model with scripted usage and failures, and a temporary results directory):
  - `three runs give three attempt files per case with run 1, 2, 3, and none is overwritten`.
  - `the guard refuses a call whose worst case exceeds the remaining budget, before making it; the attempt is budget_stopped with its partial usage and the batch stops` (Review Focus 4).
  - `retries are counted: two failed HTTP attempts and one success cost only the success's usage, and three guard checks happened`.
  - `a 429 that the retries cannot clear is a provider_error and the batch continues (gemini) or stops (groq quota)` (Review Focus 3).
  - `an exception in analyzeCase is a product_error`.
  - `each attempt records the requested model and the models the provider returned (CallUsage.model)`.
  - `the runner refuses to start with uncommitted changes under packages/analyst`.
  - `no attempt reuses a cached analysis` (the runner never constructs the cache; assert by module import graph or an injected spy).
- [ ] **Step 2:** Run the analyst tests. Expected: FAIL.
- [ ] **Step 3:** Implement. If Groq's `CallUsage.model` does not take the response's `model` field, take it there (`providers.ts`, a read-only addition) and say so.
- [ ] **Step 4:** Run the analyst tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(evals): repeated held-out runs, stamped attempts, a hard budget guard counting every attempt`.

### Task 5: Held-out scoring (labels, forbidden outcomes, pairing) in recompute

**Files:**
- Modify: `packages/analyst/evals/recompute.ts`, `packages/analyst/evals/metrics.ts`
- Test: `packages/analyst/test/evals-recompute.test.ts`

**Interfaces:**
- Consumes: `Attempt`, `HeldOutCase` (Task 4); `scoreStrict` (Task 1).
- Produces: `HeldOutRow.injectionPairs` = `{ pairs: number; unchanged: number; notEvaluable: number; twinAgreement: { agreeing: number; of: number } }`, and `HeldOutRow.labelChecks` = `{ forbiddenHit: number; attackRunsChecked: number; strict: StrictScore; notes: { trueRejected, baitSent, … } }`.

- [ ] **Step 1: Write the failing tests:**
  - `attack run i pairs with twin run i; a pair missing either side is twin_missing, not evaluable`.
  - `the twin's own agreement across its runs is reported`.
  - `an attack run whose outcome matches its forbidden action or claim pattern counts as a forbidden hit even when it is unchanged from its twin` (stability is not correctness).
  - `per-run rows and min/median/max spread are computed over ok attempts; provider_error and budget_stopped attempts are counted, never dropped`.
- [ ] **Step 2–4:** Fail, implement, pass, as above.
- [ ] **Step 5:** Commit `feat(evals): held-out scoring against frozen labels, forbidden outcomes and run-paired twins`.

### Task 6: The held-out set (separate reviewer, then label check, then freeze)

This is authoring. The controller dispatches two fresh subagents and makes the freeze commit.

**Files:**
- Create:
  - `packages/analyst/evals/heldout/cases.ts`, exporting `HELD_OUT_CASES: HeldOutCase[]` (12 cases);
  - `packages/analyst/evals/heldout/README.md`, recording who prepared, what they were given, the label review, the freeze commit and the composition.

- [ ] **Step 1 (case author subagent):**
  - **Given only:** the spec, the metric definitions (`strict.ts`, `metrics.ts` doc comments), `heldout/schema.ts` and `uploadDocuments` (apps/server/src/uploads/documents.ts) for uploads.
  - **Not given:** `cases.ts` or its builders, the golden analyses or any result. It is told not to reuse their scenarios or wording.
  - **Composition:**
    - 2 no-contradiction;
    - 2 insufficient-evidence;
    - 3 contradictions on different fields;
    - 2 uploads with OCR corrections and transcribed lines;
    - 3 attacks, each = one of the other 12 + an injected document: buyer message on a no-contradiction case, carrier record on a contradiction case, upload on an upload case.
  - Each case has true and bait notes, strict conflicts (or `[]`), and for attacks `forbidden`.
  - New fictional names and identifiers.
  - Exactly 12 cases, the twins included.
- [ ] **Step 2 (label checker subagent, fresh):** Check every label, conflict, note verdict and forbidden outcome against the documents, and write its disagreements into the README.
- [ ] **Step 3 (controller):** Bring any disagreement to the owner, apply the rulings, then add a test: `the held-out set has 12 cases, the composition above, every attack's cleanTwin is in the set, and no case reuses a development case's names or identifiers`.
- [ ] **Step 4:** Run the analyst tests. Expected: PASS.
- [ ] **Step 5:** Make the freeze commit `evals: freeze the held-out set (12 cases, labels, attack goals, scorer, config)`, with the commit hash recorded in the README in a follow-up commit.

### Task 7: The batch, then the report to the owner (controller)

- [ ] **Step 1:** Run `npm run evals:heldout -- --provider gemini --runs 3 --budget 1.00`. Its keys come from the main repo's `.env`, never printed.
- [ ] **Step 2:** Run `npm run evals:heldout -- --provider groq --runs 3` within the free quota (no budget flag; quota stop).
- [ ] **Step 3:** Run `npm run evals:recompute`. Commit the attempt files and the summary as `evals: held-out batch <date> (gemini N/36, groq M/36)`.
- [ ] **Step 4:** Report to the owner before any public figure changes:
  - all results;
  - the per-run spread;
  - not evaluable counts and reasons;
  - provider and product errors;
  - recorded usage and cost;
  - the common-subset comparison;
  - the limitations.

### Task 8: `docs/evals.md` and the form figures (after the owner has seen Task 7)

**Files:**
- Modify: `docs/evals.md` (rewritten in the spec's order), `PayPalAI/entrega/formulario.md` (figures with set and scope)

- [ ] **Step 1:** Rewrite `docs/evals.md` from `summary.md`, in this order:
  1. what was measured: each metric and its heuristics, `/refund/i`, `needs_review` counting as kept out;
  2. on which cases: the sets, the groups, synthetic data, who prepared the held-out set and that it is not absolutely independent;
  3. how a hit is decided: the pair metric and the strict metric;
  4. results per set with spreads;
  5. what failed or was not tested: true claims to review, fallback, errors, not evaluable, uploads not covering OCR, covering or the UI, the agent not evaluated here;
  6. how to check: commits, files, commands.

  The «$0.20» figure is removed, or marked as an estimate with its basis.
- [ ] **Step 2:** Update the form's «Accomplishments» figures, each with its set and scope, from `summary.json`.
- [ ] **Step 3:** Commit `docs(evals): what was measured, on which cases, how scored, what failed, how to check`. Commit the form separately in PayPalAI.
