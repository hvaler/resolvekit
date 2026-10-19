# Analyst evaluations (H-04): what was left for later

The branch was built on 19/10/2026 and merged into local `main`. Every task was reviewed. The final whole-branch review ran **before** the paid batch, with one fix wave and one residual fix. The held-out set is frozen at `cefd171`, and the batch is committed in `cc53313`. `docs/evals.md` and the form's figures were updated after the owner saw the results.

## Planned: resume Groq on the held-out set when its free quota renews

**State.** Groq ran 1 of 36 case-runs. Its single attempt (`ho-a1-porch-delivery` run 1) hit a 429 that survived the retries, and the batch stopped on quota (`results/heldout/groq/budget.json`: `stopped: false`, one `quota` stop). That attempt is kept as `provider_error`; the other 35 were not run. `docs/evals.md` records Groq as **not run** on the held-out set.

**When.** After the free tier's daily limits reset, at the earliest about 24 h after 19/10 11:27 UTC. Check the remaining quota first: one small manual request that is not part of the batch, or the Groq console.

**How.** Same freeze, nothing re-frozen. From `packages/analyst` in a checkout of `main`, with a clean tree:

```
node --env-file=C:/nexus/dev/resolvekit/.env evals/runs.ts --provider groq --runs 3
```

- The runner checks the pinned freeze commit, the frozen hash and `casesHash`, and refuses if anything changed.
- It skips existing attempt files. The `provider_error` of `ho-a1` run 1 stays as it is and is never replaced.
- It runs run-major and stops again on quota. Groq is not USD-guarded; its figures are «estimated at Gemini list price, not a Groq price».
- It may take several days of quota. Each resume continues where the last one stopped.

**After each resume:**
1. Run `npm run evals:recompute`.
2. Commit the new attempt files and the summary.
3. Before changing `docs/evals.md` or the form, show the owner the Groq results, errors, not-evaluable counts and the comparison on the **common subset only**, which is still empty today.

**If the prompt or the analyst changes before the resume,** the set is no longer a held-out test for that version. Per the owner's condition it becomes a regression set, and must be labelled so.

## Parked

- A close that cancels a `pending_approval` MeterMCP session while PayPal still reports the authorization PENDING does not void it. This predates the branch; it is listed in the agent follow-ups and does not concern this branch.

## Small, deferred on purpose

- **Scorer:**
  - The currency allow-list strips ISO codes that are also English words («try», «all», «top»).
  - The currency list depends on ICU (full in Node 24).
  - The 4-word negation window can send unrelated clauses to manual review.
  - Forbidden detection is pattern-based, with two accepted gaps: the imperative «Issue a full refund…» and «There is no address discrepancy».
- **Runner:**
  - `frozenHash` reads working-tree bytes, so CRLF on another machine gives a false refusal, never a false pass.
  - Absorbed non-ModelErrors are recorded as `provider_error` (cosmetic).
  - `isOutage` recognises outages from the wording of the message.
  - A run of alternating outages and model-output errors never reaches the two-in-a-row stop.
- **Recompute:** `recompute.ts` is not frozen. It holds the aggregation glue; scoring lives in the frozen `strict.ts`/`metrics.ts`/`score.ts`.
- **Tests:**
  - The no-reuse test covers ids, not person or street names.
  - The probe test accepts at most 2 misses instead of exactly 2.
  - The B20 count test is not recursive.
- **Form:** `entrega/generado/` is stale until `/lz:formulario` runs.

## Decisions taken during the build (rulings)

1. **B1, budget.** Reserve before each raw HTTP attempt: input estimate, output, and thinking (Gemini 2048). Keep observed, estimated and unknown apart. The limit is a local guard, not an invoice guarantee.
2. **B2, recompute.** Every file goes in an explicit class. Unclassified, duplicate and incomplete files are reported and never aggregated. Recompute writes only the summary files.
3. **B3, scoring.**
   - Negative tests: right pair but wrong field, wrong value or wrong quote.
   - Coverage is reported apart from hits.
   - Forbidden detection is action, checklist or listed paraphrases, with negation sent to manual review.
4. **B4, separation.** Authors and reviewers work from staging folders, by instruction. This is separation, not isolation.
5. **B5, freeze.** Cases, labels, scorer, config and prompt version are frozen in one commit.
6. **B6.** Task 8 waited until the owner had seen the results.
7. **B7.** A wrong quote is not evaluable, never correct.
8. **B8.** A failed attempt's conflicts count as `no_analysis`.
9. **B9.** The field comes from the word before «contradiction», document names are not field words, and a postcode accepts an address.
10. **B10.** A case absent from a development file adds nothing.
11. **B11.** Task 4 before Task 3.
12. **B12.** A call over its reservation stops the batch.
13. **B13.** An attempt with a failed sub-call is never scored as ok.
14. **B14.** The freeze is pinned by commit and hash across batches.
15. **B15.** A budget stop is sticky. The freeze commit is the last commit touching any frozen path.
16. **B16.** Summary shape. Comparisons use the common subset of case and run pairs. The order is Gemini, then Groq, then recompute.
17. **B17.** Manual judgements are recorded only after the batches. An empty `forbidden` is invalid.
18. **B18.** Negation is checked 4 words before and after the match, with an extended cue list.
19. **B19.** E3 also skips reported speech.
20. **B20.** The freeze covers the analyst's code and prompt and the batch code.
21. **B21.** The final review ran before the paid batch.
22. **B22.** Stop on configuration or outage errors. Per-provider budget: Gemini 1.00 USD, Groq quota only. `casesHash` is pinned, the server uploads builder is frozen, the input bound is checked, and recompute never crashes.
23. **B23.** The input margin is ×1.5. A Groq `json_validate_failed` and model-output errors do not stop the batch.
24. **Owner rulings during authoring:**
    - the reviewer's attack-pattern fixes were accepted twice;
    - E3's pasted-text upload is accepted;
    - the residual gaps are documented;
    - Groq is recorded as not run, with a resume planned.
