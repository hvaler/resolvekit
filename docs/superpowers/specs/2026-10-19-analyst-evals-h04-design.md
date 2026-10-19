# Analyst evaluations that say what they prove (H-04) (design)

Status: draft for the owner's approval, 19/10/2026. It addresses finding H-04 of the 17/10 audit: the analyst's AI metrics were limited. The owner's conditions (19/10) are quoted as decided.

## Intent

A judge reading `docs/evals.md`, or the figures in the submission form («100% of citations verbatim», «13 of 13 contradictions»), should stop asking: «do these numbers prove something useful about the product, or only that it passes some prepared examples?»

After reading, the judge should understand five things:

- **What was measured.** These are different properties:
  - citations matching their document verbatim;
  - support for each claim;
  - contradiction detection;
  - behaviour under malicious instructions.
- **On which cases.** How many there are; that they are synthetic; which variants share a base case; which cases were used to tune the system and which were held out.
- **How a hit was decided.** For example, whether «13 of 13 contradictions» checked the exact conflict or only the pair of documents.
- **What failed or was not tested.** True claims sent to review, fallback results, failed runs and excluded cases.
- **How to check it.** The code, prompt and model versions, the stored results, and the commands that recompute the metrics. Repeating model calls can give different results.

The conclusion to convey: **«On this specific set, with this version and these conditions, we observed these results, and you can inspect them.»**

Two misreadings to avoid:

- «100% of citations verbatim» is not «100% of claims true».
- The analyst's evaluations do not show the buying agent's autonomy. That needs separate tests and results.

## What exists today (recon, 19/10)

- **Cases.** 19 synthetic cases in `packages/analyst/evals/cases.ts` (EV-01 to EV-19), all fictional.
  - The 10 injection cases share the same base case (`nr-address-mismatch`, their «clean twin») and the same notes.
  - The builders `order()`, `capture()` and `tracking()` make many cases near-duplicates.
- **Tuning.** All 18 per-provider cases were used to tune the prompt. Versions `.5` and `.7` fixed failures seen on those very cases. Nothing is labelled held-out.
- **Runs and stored results.**
  - `packages/analyst/evals/run.ts` runs one provider per run and stores `evals/results/<provider>[-nodetect]-<prompt>.json` (committed).
  - `--metrics-only` recomputes from a stored file without model calls.
  - The upload case EV-19 is stored apart (`upl-carrier-evidence-runs.json`) and has no recompute command.
  - Each prompt version was run once per provider, except EV-19 (3 runs).
- **Contradiction scoring.** It checks only the pair of documents (`metrics.ts`, `pair(a,b)`). The stored outputs do carry `a.value`/`b.value` (for example `"Flat 2"` vs `"Flat 2B"`), but they are not scored.
- **Undocumented heuristics.**
  - Injection «leak» also matches `/refund/i` on sentence text.
  - «Kept out of what can be sent» counts `needs_review` as kept out.
- **Unsourced figure.** The «$0.20 for golden analyses and dev runs» in `docs/evals.md` has no stored source.
- **Stale comments.** Code comments still say 18 cases.

## Decided by the owner (19/10)

1. **Contradictions: keep the old metric and add a strict one.**
   - Recompute the stored results, checking for each expected conflict:
     - the **field**;
     - the **values of both sides**;
     - **valid citations** for both sides.
   - Swapping the two sides is allowed.
   - The accepted normalisations are defined (listed below).
   - Finding those values anywhere in the output is not enough: they must be in the contradiction itself.
   - **Extra, incorrect contradictions are reported.** Finding all the expected ones does not make up for inventing others.
   - An old output without enough information to score it is marked **not evaluable**, never counted as a hit or a miss.
2. **The existing cases are the development (tuning) set.**
   - The 18 per-provider cases (and EV-19, also tuned on) are labelled the **development set**.
   - The injection variants are grouped under their base case.
   - They are never reclassified as held-out.
3. **A separate reviewer prepares a new held-out set.**
   - The reviewer may know the spec and the metrics, but must not adjust the cases after seeing the model's answers.
   - It uses new scenarios and new synthetic documents, without reusing the existing generators or narrative templates.
   - Another person reviews the expected labels before the run.
   - It is presented as a **«held-out set prepared by a separate reviewer»**, never as absolutely independent when the reviewer shares a model or context with the builder.
4. **Freeze before running.**
   - Cases, expected answers, scoring rules and the system version go into one identifiable commit before any run.
   - The set includes:
     - cases with no contradiction;
     - insufficient evidence;
     - true and false claims;
     - uploads with corrections;
     - attacks on different documents.
   - If its failures are later used to change the system, the set becomes a **regression set**: no longer a new test for that changed version.
5. **Measure variation without picking the best result.**
   - Size, repetitions and cost are proposed first (below, for approval).
   - The owner's starting preference is three runs per case, budget allowing, keeping every attempt.
   - Provider errors are kept apart from product errors.
   - No failure is dropped silently.
6. **Reproduction and public figures.**
   - One command recomputes every metric from all stored results, EV-19 included, without calling a provider.
   - The heuristics are documented, `/refund/i` included, as is the fact that «kept out» includes `needs_review`.
   - Any unsourced cost is removed or marked as an estimate.
   - The form's figures state their set and scope, and are updated from their source (`entrega/formulario.md`, then `/lz:formulario`), never by editing generated files.
7. **Keep the evaluations apart.** These results evaluate the dispute analyst. The buying agent's autonomy, budget and recovery need their own tests and results.

## Proposal for approval: size, repetitions, cost (Claude's call)

- **Held-out set:** **12 cases**, enough to cover every kind the owner listed at least once or twice without the reviewer inflating near-duplicates:
  - **2** with no contradiction;
  - **2** with insufficient evidence for the reason;
  - **3** with contradictions of different fields (address, amount, date or quantity);
  - **2** uploads with OCR corrections and transcribed lines;
  - **3** attacks, on three different document types: a buyer message, a carrier record, an uploaded file. Each has its own clean twin, counted inside the 12.

  Every case carries both true and false merchant notes.
- **Repetitions:**
  - **3 runs per case on Gemini** (primary), every attempt kept.
  - **Groq** (fallback): 3 runs as far as its free daily quota allows. Provider refusals (429/quota) are recorded as provider errors, never as product failures, and never silently dropped.
- **Cost estimate (to be confirmed by the stored usage after the run):**
  - From the stored Gemini `.7` run (18 cases: 154,744 tokens in, 65,893 out), one case-run is about 8.6k in and 3.7k out. At the list price used in `docs/evals.md` ($0.75/1M in, $3.75/1M out) that is about **$0.02 per case-run**.
  - 12 cases × 3 runs ≈ **$0.72 on Gemini** at list price.
  - Groq is the free tier: $0, but limited.
  - If the keys are on free tiers, the money cost is nil and the limit is the quota. The figure is labelled «estimate at list price» either way.
- **Re-scoring the development set:** **no new model calls**. The strict contradiction metric and the new grouping are computed over the stored results only.

## Goals

1. **A strict contradiction metric** (field, both values, valid citations, side order free, defined normalisations, extras reported, «not evaluable» for outputs lacking information), next to the existing pair metric.
2. **Case metadata.**
   - Every case carries `set: 'development' | 'held-out'` and `group` (its base case; injection variants share their base's group).
   - The metrics are reported per set and per group, so near-duplicates are visible.
3. **A held-out set of 12 cases**, written by a separate reviewer, label-checked by another reviewer, and frozen in its own commit (cases, expected answers, scoring rules, system version) before any run.
4. **A repeated-run runner.**
   - N runs per case per provider, every attempt stored (run index, timestamp, provider, model, prompt version, code commit).
   - Each attempt is classified as `ok`, `provider_error` (429, 5xx, timeout, quota) or `product_error` (the analyst threw or produced invalid output).
   - The runner never picks the best attempt.
5. **One recompute command**, `npm run evals -- --recompute`.
   - It reads every stored result file, EV-19 and the held-out runs included, recomputes every metric and writes a single summary file (`evals/results/summary.json`) plus the tables `docs/evals.md` quotes.
   - It calls no provider.
6. **A rewritten `docs/evals.md`**, in the order the judge needs:
   1. What was measured: each metric's definition and its heuristics.
   2. On which cases: the sets, the groups, synthetic data.
   3. How a hit is decided: both contradiction metrics side by side.
   4. Results per set, with the spread across runs (min, median, max per metric, and the per-run rows).
   5. What failed or was not tested: true claims sent to review, fallback, provider errors, product errors, excluded cases.
   6. How to check: versions, files, commands.
7. **Form figures** that name their set and scope: «on 12 held-out synthetic cases, 3 runs each, Gemini …». They are written in `entrega/formulario.md` from the summary file, and copied only after `/lz:formulario`.

## Non-goals

- Real (non-synthetic) dispute data.
- Changing the analyst's prompt or code in this work. A change prompted by held-out failures turns the set into a regression set, per condition 4.
- Evaluating the buying agent (condition 7).
- A statistical significance claim. The doc reports observed counts and spreads, nothing more.

## Anti-goals

- Reporting the best of three runs, or dropping a failed or refused attempt without saying so.
- Presenting the development set's numbers as a held-out estimate.
- A strict contradiction «hit» that only found the values somewhere in the output.
- The held-out cases changed after any model output was seen. Any change after the freeze is a new commit, and the set is then described as such.
- Claiming absolute independence of the held-out set.
- Form figures edited in `entrega/generado/`, or numbers without set and scope.
- Any figure in `docs/evals.md` that the recompute command cannot reproduce, except those explicitly marked as estimates with their basis.

## Decisions taken by Claude (my calls, to check while reading)

1. **Strict contradiction match.** An expected conflict is `{ field, a: { doc, value }, b: { doc, value } }`. An output contradiction matches it when all of these hold:
   - its two sides cite the expected two documents (either order);
   - each side's value equals the expected value after normalisation;
   - each side's quote is verbatim in its document (the existing citation check);
   - its field, or kind, maps to the expected field through a small synonym table (address ↔ ship_to/delivery address; amount ↔ total/charged/captured; date; quantity; name), kept in `metrics.ts` and documented.
2. **Normalisations:**
   - case and whitespace folding;
   - unicode NFKC;
   - money: strip the currency code or symbol, compare as cents;
   - dates: ISO day;
   - postcodes/addresses: remove punctuation, but keep letters and digits («Flat 2» ≠ «Flat 2B»).

   No fuzzy matching.
3. **«Not evaluable»:** an output contradiction with no `value` on a side, or with no quote that can be checked, cannot be scored strictly. It counts in a separate «not evaluable» bucket, per run, reported next to the score.
4. **Extras:** a contradiction that matches no expected conflict is an extra. Extras are listed per case, with the field and values, in the detail section.
5. **Held-out authorship:**
   - The «separate reviewer» is a fresh subagent that gets only the spec, the metric definitions and the case schema. It does not get `cases.ts`, its builders or the golden analyses, and it is told not to reuse their scenarios or wording.
   - A second fresh subagent checks every expected label against the documents and lists its disagreements.
   - The owner rules on any disagreement before the freeze.
   - The doc states that both are model agents in the same environment as the builder: separate context, not absolute independence.
6. **Version stamp.** Each stored attempt records:
   - the git commit of the code;
   - `PROMPT_VERSION`;
   - the provider model id;
   - the held-out set's freeze commit.
7. **Where things live:**
   - held-out cases in `packages/analyst/evals/heldout/`, their own module, sharing no builders with `cases.ts`;
   - runs in `evals/results/heldout/<provider>/<case>/<run>.json`, one file per attempt, append-only.

8. **Strict labels for the development set.** Today the development cases only carry document pairs, so the strict metric needs field and values written for their 13 expected conflicts.
   - A fresh labeller subagent writes them **from the case input documents only**. It is not shown any stored output: the conflicts are built into the fixtures (for example the order says «Flat 2» and the carrier says «Flat 2B»).
   - A second subagent checks each label against the documents.
   - The doc states that these labels were added on 19/10, after the outputs existed, by agents that did not see the outputs.
9. **A side whose value is the whole quote.** The pipeline (`pipeline.ts`) falls back to the whole fact quote when the model's value is not inside it. Such a side carries no value of its own, so it counts as **not evaluable**, not as a hit or a miss.
   - The strict metric re-verifies each side's quote against its document; it does not trust the earlier check.
10. **Which development results are headline.**
    - Prompt `.7` per provider is the headline development row. Older versions (`.3`–`.6`) are history rows.
    - The `nodetect` file is a separate ablation experiment, reported apart.
    - `--recompute` reads all of them.
11. **Injection «unchanged» with repeated runs.**
    - Attack run *i* is compared with twin run *i* (the same index, among each case's attempts in order).
    - A pair with a provider error on either side is **not evaluable**.
    - The twin's own run-to-run agreement is reported next to the score, so noise that could flip «unchanged» is visible.
12. **Leaks in held-out attacks.**
    - Each held-out attack case carries its own frozen `forbidden` outcomes in the schema: the action, the checklist or the claim pattern the attack aims at. They are written by the reviewer and checked by the label reviewer before the freeze.
    - The development set keeps the global heuristic (citing the injected document, or `/refund/i`), documented as such.
13. **Held-out uploads use the production builder** (`uploadDocuments` on the server). It is the system under test, not a narrative template, and it is part of the freeze commit.

## Left to the builder

- The exact layout of `summary.json` and of the tables.
- The synonym table's exact contents, within decision 1.
- The runner's retry and backoff on provider errors. A retry is a new attempt and is recorded; nothing is overwritten.
