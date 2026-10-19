[English](testing.md) | [Español](../es/quality/testing.md)

# Testing

What is tested, how, with which result, and what is not. Three kinds of evidence are kept apart:

| Kind | What it is | Where it lives |
|---|---|---|
| **Automated tests (simulated)** | `node --test` and `vitest` suites with a fake PayPal, a fake model and in-memory or temporary stores. No network, no keys, no cost | The repository (`npm test`) |
| **Sandbox observations** | Things done by hand, or by the deployed app, against the real PayPal sandbox and real models, and recorded at the time | The owner's private evidence notes (dates below). Not reproducible by readers; ids and screenshots are withheld |
| **Browser checks** | Manual walk-throughs in a browser | Plan follow-ups (`docs/superpowers/`) and private evidence. There are **no automated browser tests** |

The **analyst evaluations** (model quality on synthetic cases) are a fourth thing, with their own page:
[Analyst evaluations](evaluations.md). They are not part of `npm test`.

## Run the suites

```bash
npm ci
npm test            # all suites below, chained with && (stops at the first failing suite)
npm run typecheck   # tsc for the 7 workspaces
npm run test:server # one suite: test:paypal | test:hosting | test:cases | test:analyst | test:agent | test:server | test:metermcp | test:web
```

Requires Node 24+ (TypeScript runs natively). `npm test` makes no network call and needs no `.env`.

## Latest recorded run

**2026-10-19 12:35Z · commit `fbe9621` · Node v24.19.0 · Windows (MINGW64_NT-10.0-26220).**

| Suite | Command | Tests | Pass | Fail |
|---|---|---|---|---|
| `packages/paypal` | `npm run test:paypal` | 31 | 31 | 0 |
| `packages/hosting` | `npm run test:hosting` | 19 | 19 | 0 |
| `packages/cases` | `npm run test:cases` | 11 | 11 | 0 |
| `packages/analyst` | `npm run test:analyst` | 152 | 152 | 0 |
| `packages/agent` | `npm run test:agent` | 52 | 52 | 0 |
| `apps/server` | `npm run test:server` | 486 | 485 | **1** |
| `apps/metermcp` | `npm run test:metermcp` | 71 | 71 | 0 |
| `apps/web` (vitest, 26 files) | `npm run test:web` | 309 | 309 | 0 |
| Type check | `npm run typecheck` | — | exit 0 | — |

`npm test` exited 1 at `test:server`, so `test:metermcp` and `test:web` were run on their own (both exit 0).

**The intermittent test.** In `apps/server/test/uploads-pdf-recovery.test.ts`, *size: five dense A4 pages rebuild under
MAX_STORED_BYTES, and with the demo PDFs stay under PAYPAL_MAX_SEND_BYTES* failed under full-suite load with
`429 RATE_LIMITED` in its cover-and-confirm step (the run took 39 s). Run alone, twice, the file passed 3/3 both
times. Cause (found 19/10): while the PDF job ran slowly under load, the test's polling of `GET /uploads` every 100 ms
used up the hosted API limit (300 requests per 5 min) and the next request got `429`. The test kit now raises that
limit for these tests, and the polling (`settled()`, `waitFor()`) checks for `200` and asks every 300 ms.

**Not run:** the suites on Linux (the hosted platform) and on Render. Linux-only behaviour, such as killing the PDF
child above 200 MiB RSS, is exercised only where the test can read `/proc` (**Pending** on Linux). Earlier test counts
quoted in private notes belong to earlier commits and are not reused here.

## What the suites cover

| Area | Main test files | Notes |
|---|---|---|
| PayPal client | `packages/paypal/test/{client,disputes,orders,webhooks}.test.ts` | Retries (429 with the same `PayPal-Request-Id`, GET 408/5xx), OAuth caching, multipart provide-evidence, webhook verification request |
| Hosting | `packages/hosting/test/hosting.test.ts` | Daily caps (fail closed), rate limiter, client address behind proxies, security headers, sandbox-only start |
| Analyst pipeline | `packages/analyst/test/{pipeline,deterministic,injection,prompts,providers}.test.ts` | Verbatim check, number guard, citation rules, injection scan, provider fallback, all with a fake model |
| Evals tooling | `packages/analyst/test/evals-*.test.ts` | Scoring, strict metric, held-out freeze, recompute (no model) |
| Agent engine | `packages/agent/test/{engine,meter,models}.test.ts` | See [below](#buying-agent-unit-tests-and-observed-sandbox-runs) |
| Server API | `apps/server/test/{app,hosted,auth,environments,sellers,mapping,bindings,reserve,webhook,ops}.test.ts` | Guards, sign-in, workspaces, binding checks, rotation, webhooks, ops report |
| Submission | `intent.test.ts`, `intent-sessions.test.ts`, `review-fixes.test.ts`, `analysis.test.ts` | Composition, approval by hash, invalidation, per-dispute lock, durable audit, re-checks |
| Uploads | `uploads-{image,text,ocr,store,routes,documents,pdf-input,pdf-routes,pdf-recovery}.test.ts`, `pdf-image.test.ts` | See [Security and privacy](security-and-privacy.md#untrusted-files) |
| Agent on the server | `agent-routes.test.ts`, `agent-runs.test.ts`, `agent.test.ts` | Caps, visibility, recovery, settlement from the receipt, E5 binding rule |
| Scripts | `demo-check.test.ts`, `demo-prepare.test.ts` | Argument parsing, reserve checks, readiness evaluation |
| MeterMCP | `apps/metermcp/test/{app,meter,failclosed,hosted,limits,demo-agent}.test.ts` | Metering, atomic reservations, fail-closed approval, settlement, admin guards, ledger migration (a forced failure leaves schema and rows unchanged; reopening a migrated ledger is a no-op) |
| Web | `apps/web/src/**/*.test.ts` (vitest, `environment: 'node'`) | Pure domain logic: environments, intent building, read-back comparison, drafts, PDF review decisions, agent run view. **No DOM rendering tests** for the upload and PDF UI (known gap) |

## Sandbox observations

All in the PayPal **sandbox**; nothing has run against live PayPal. Dates are when they were recorded (private
evidence). An observation is one example, not a guarantee.

| Observed | Date |
|---|---|
| Disputes read and mapped from the Customer Disputes API | 09/10, 17/10 |
| MeterMCP budget authorized, partial capture with the remainder no longer held, failed call not charged (scripted MCP client) | 09/10 |
| An unused authorization voided | 08/10 |
| «Continue with PayPal» identity check (hosted mode on localhost) | 10/10 |
| Two reviewers sent evidence; read-back «Recorded by PayPal», 6 of 6 fields | 17/10 |
| Live re-checks of edited sentences; a re-analysis of about 35 s; reserve rotation; webhook deliveries verified | 17/10 |
| A covered PNG upload sent and recorded by PayPal (PayPal's copy held only IHDR/IDAT/IEND, the cover burned in) | 18/10 |
| Two model-driven agent runs on `/agent` | 19/10 (below) |
| `demo:check` READY except the empty standard reserve | 19/10 |

**Not observed in the sandbox (Pending):** a PayPal timeout or uncertain send; MeterMCP `capture_pending`; agent
restart recovery; **Stop** on a real run; the Groq fallback for the agent; pasted-text and PDF uploads sent to PayPal;
passkey creation on the deployed service; the E5 run record on a bound case; `npm run demo-agent` against the hosted
MeterMCP.

## Browser checks

No automated browser tests exist. Recorded manual checks: the PDF upload flow walked through in a browser
(follow-up notes, 18/10); the `/agent` page smoke test in a local browser with no model key and no external calls
(follow-up notes); reviewers using the deployed app in their own browsers (17/10, 18/10); Compare, Keep and the return
from PayPal to `/agent?run=` (19/10).

## Buying agent: unit tests and observed sandbox runs

The analyst evaluations do not measure the agent. The agent's evidence is:

1. **Unit and integration tests (simulated).** `packages/agent/test/engine.test.ts`, `meter.test.ts`,
   `models.test.ts` (52 tests on 19/10) with scripted fake models and a fake MeterMCP: one action per turn, two invalid
   turns stop the run, refusal of unknown or not-offered tools and bad arguments, `insufficient_balance`, budget
   opened for exactly the cap, provider fallback fixed after the first answer, limits, injected failures never
   charged, settlement taken only from the receipt. Server side: `agent-routes.test.ts`, `agent-runs.test.ts`,
   `agent.test.ts` (caps, visibility, write-ahead, restart recovery, reconcile). MeterMCP side:
   `apps/metermcp/test/hosted.test.ts` for the private `/agent/mcp`.
2. **Two observed runs in the sandbox (19/10/2026)**, on the deployed `/agent` page, Gemini `gemini-3.8-flash`, each
   budget 2.00 USD approved with a sandbox personal (buyer) account (approving with the seller's business account
   was refused by PayPal: «Estás entrando en la cuenta del vendedor…» (PayPal's page was in Spanish; roughly «you are signing in to the seller's account»; recorded truncated); observed on 19/10, not
   documented by PayPal):
   - A goal the tools could not fully meet, with **Simulate an outage**: the model called `quote_lookup` (0.05,
     charged), then `deep_report` failed by the injected outage (labelled, not charged), and it finished `cannot_do`,
     saying what was missing. Receipt: captured 0.05, released 1.95.
   - A goal one tool met: `bulk_export` (0.92, charged), then `done`. Receipt: captured 0.92, released 1.08.
   Model usage was shown apart from the budget. These are two examples, not a general autonomy guarantee.
3. **The record.** Both runs are written up in the owner's private evidence notes of 19/10/2026 (order, session and
   capture ids withheld here).

Not evidence about the agent: the synthetic agent case (1.37 of 5.00 USD, four calls) and the evals EV-11/EV-12 are
demo data that test the **analyst**; the 1.37 USD sandbox session of 09/10 was made by the earlier scripted client,
not by the model-driven agent.

## Test gaps

- No DOM tests for the upload and PDF review UI (`useUploads`, `PdfSelect`, `PdfReview`, `CasePage` wiring).
- Linux-only paths (RSS kill of the PDF child) not run on Linux; memory of a 5-page PDF on Render not measured.
- Behaviour against live PayPal: none.

The full list, with sources, is in [Known issues](known-issues.md).
