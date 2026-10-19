# Model-driven buying agent: what was left for later

This was merged into local `main` at `5da0e7e` on 19/10/2026 and is **not pushed**. Every task was reviewed, the whole branch had a final review and one fix wave, and the `/agent` page passed a local browser smoke test (no model key, no external calls).

## Closing (deploy and sandbox), in this order

1. **Before the push:** turn off auto-deploy for `resolvekit` on Render. Then push, so Render deploys `resolvekit-metermcp` first; deploy `resolvekit` by hand afterwards.
2. **Render settings on `resolvekit-metermcp`:**
   - delete `METERMCP_FAIL_FIRST` in the dashboard (Render may keep variables removed from the blueprint);
   - set `METERMCP_RETURN_ORIGINS` to the ResolveKit origin;
   - check that `METERMCP_MIN_BUDGET` is 0.50.
3. **Render settings on `resolvekit`:** check the `AGENT_*` variables, `DAILY_AGENT_RUNS` and `METERMCP_ADMIN_TOKEN`. Set `RESOLVEKIT_PUBLIC_URL` if `RENDER_EXTERNAL_URL` is not the public origin.
4. **Health check:** Render keeps the previous MeterMCP serving until `/healthz` passes, which matters if the ledger migration fails (Ruling A3).
5. **First runs:** one run on `/agent` with the sandbox buyer approving. Check the return to `/agent?run=`, then Stop, then Compare. Check the owner scope.
6. **Command-line run:** `demo-agent --no-wait` against the hosted MeterMCP, with keys.
7. **Before showing evidence:** show the owner the exact content before any evidence is sent to a dispute.

## Before submission (owner)

- **The form's «Accomplishments» section** still tells the 1.37 USD story as if it were real. The rest of the form, the README and judges.md call it the synthetic example. Reword it, or use a real run's figures.
- **The agent case binding** still points at a session from the scripted agent. Rebind it at the reserve step (25–30/11) with `demo:prepare --agent-run <id>`, using a run made from the page.

## Parked

- **A PENDING authorization is not voided.** A close that cancels a `pending_approval` session while PayPal still reports the authorization PENDING does not void it (`apps/metermcp/src/meter.ts`). This predates the branch. Sandbox authorizations expire on their own and nothing is captured.

## Small, deferred on purpose

- **MeterMCP:**
  - SCHEMA runs before migrate (commented).
  - The migration test seam throws before exec.
  - `budget_exists` also blocks while a session is closing, `settlement_failed` or `capture_pending`.
  - min > max only gives a warning.
  - A late void is recorded in the log only.
  - The limits text is duplicated between summary and run.
  - No tests for the 503 session cap or for local mode `/agent/mcp`.
- **Engine:**
  - `budget_exists` adopts the connection's session.
  - The post-approval branch for a failed save is untested.
  - The local price check is skipped when the remaining balance is unknown (MeterMCP still enforces the cap).
  - A run that reaches 8 actions cannot record a final answer.
  - A VOIDED order makes a later `get_balance` answer `none`, so the run is labelled `budget_unavailable`.
- **Server:**
  - `allSettled` discards rejections (each settle logs its own).
  - `PersonRunCaps.release` saves without checking that the file is readable.
  - No test for the caps file becoming unreadable after boot.
  - The `main.ts` wiring is untested.
  - `PERSON_CAP` resets at UTC midnight.
  - The E5 log line is written on every snapshot build.
- **Web:**
  - No component tests for the hook (selection clearing, gating, compare reset).
  - The action limit 8 is fixed on the page.
- **demo:prepare:**
  - The constants for goal, cap, tool and run id are duplicated.
  - The receipt shape check is partial (its reads cannot throw).
  - The buyer instructions still ask for the «confirmation of the service» text.
- **Docs:** one README line is too long.

## Decisions taken during the build (rulings)

1. **A1.** Each step is saved before its call (write-ahead).
   - After a restart, a pending step becomes `uncertain` and is never repeated.
   - Cancelling during a call waits for its answer.
   - A failed save stops the loop, with no more calls.
2. **A2.** Owner access to other people's runs is explicit (`?scope=workspace`) and logged. Stop is for the author (the owner only with scope). Keep is for the owner.
3. **A3.** The MeterMCP ledger migration runs in one transaction. On failure it rolls back and MeterMCP refuses to start.
4. **A4.** `--agent-run` checks every capture in BINDINGS_JSON and those added in the same command. It never runs the engine or pays.
5. **A5.** Unknown tools and tools that exist but were not offered get different refusals.
6. **A6.** Groq's `tool_use_failed` is an invalid action, not a model outage.
7. **A7.** A failed save stops the loop, and the loop still tries to close.
8. **A8.** If MeterMCP does not open the budget, the run ends `stopped`/`budget_unavailable`. `not_approved` is kept for real buyer or PayPal refusals.
9. **A9.** New stop reasons `meter_unavailable` and `internal_error`; a stopped run always has a reason.
10. **A10.** Owner views of other people's runs hide the approval link, the order id and the session id.
11. **A11.** Captured and released amounts come only from a receipt that was read (`captured`/`released` on the record); the page never derives them from the steps.
12. **A12.** The ops route answers 404 without the token.
13. **A13.** Runs whose capture is bound to a case are never swept.
14. **A14** (security review). E5, the run record, is attached to a case only when the binding names that run and its session matches.
15. **Other rulings:**
    - `/agent/mcp` sessions are bound to their run key.
    - Gemini uses a low thinking level.
    - The mixed-provider fallback cannot happen, because the provider is fixed before the first successful turn.
    - Runs whose budget opening had an unknown result stay `unverified`; MeterMCP's idle sweep settles them.
    - The wording «Interrupted (stopped or server restart)» and the `failed` settlement text.
    - The form sentence and the rebinding are the owner's.
    - The controller ran the browser smoke test; the full sandbox test is part of the closing.
