[English](known-issues.md) | [Español](../es/quality/known-issues.md)

# Known issues

Open follow-ups, checked against the code at `fbe9621` on 19/10/2026. Each item names its source: the follow-up file
under [`docs/superpowers/plans/`](../superpowers/plans/) and, where relevant, the code location. Items marked
**by design** are kept on purpose but worth knowing. Product limits (what ResolveKit does not do) are in
[Limitations](../product/limitations.md).

Sources: **P1** `2026-10-17-merchant-evidence-phase1-followups.md` · **PDF** `2026-10-18-merchant-evidence-pdf-followups.md`
· **AG** `2026-10-18-model-driven-agent-followups.md` · **ENV** `2026-10-18-three-environments-followups.md` ·
**EV** `2026-10-19-analyst-evals-h04-followups.md` · **TR** the test run of 19/10 ([Testing](testing.md)).

## Uploads and PDFs

| Issue | Effect | Source |
|---|---|---|
| Covered photos become large PNGs | Every covered image is stored as a lossless PNG; a ~3.4 MB camera JPEG can become ~11.5 MB and be refused by the 9.9 MB stored-file cap. Candidate fix: keep JPEG for photos | P1; `apps/server/src/uploads/routes.ts` |
| A failed archive is never retried | If writing an archived record fails at rotation, the upload stays `confirmed` for the old dispute (in no input) and its files and text stay on disk, counting toward the 300 MiB; the hourly sweep does not retry it | P1; `uploads/store.ts` (`archiveCase`, `sweep`) |
| `closeOcr()` has no time limit | It is awaited inside the heavy slot before a PDF child starts; a worker start that never finished would hold the slot until a restart (the 30 s OCR start budget bounds it on the OCR side) | PDF; `uploads/pdf-input.ts` |
| Memory on Render with a 5-page PDF not measured | Peak memory on the 512 MB instance unknown for the PDF path; an earlier 8 MP image reading peaked ~395 MB (P1 follow-up, 17/10/2026). `MALLOC_ARENA_MAX=2` suggested, not tried | P1, PDF (ops) |
| Thumbnail deadline on 0.5 CPU | 3 s per thumbnail may be short for real PDFs | PDF (ops) |
| Rebuild size | Rebuilding 5 pages holds about 60 MB of RGB before writing | PDF (ops) |
| RSS kill on Linux not measured against a real bomb | The memory ceiling of the PDF child is tested with a fake reader; not measured on the hosted Linux | `uploads/pdf-input.ts`; `uploads-pdf-input.test.ts` |
| PDF hints share the PayPal-reads bucket | Text-layer hints count against the 60 reads / 5 min per-address limit | PDF (by design); `hosted.ts` |
| `evidenceNumber` duplicated | The same helper exists in 4 files (`app.ts`, `uploads/documents.ts`, `uploads/routes.ts`, `web/domain/uploads.ts`) | P1 |
| CRLF line endings in `apps/server/test/uploads-kit.ts` | Mixed line endings in one test helper | PDF |

## Buying agent and MeterMCP

| Issue | Effect | Source |
|---|---|---|
| A PENDING authorization is not voided on cancel | Closing a `pending_approval` session while PayPal reports the authorization `PENDING` does not void it (sandbox authorizations expire on their own; nothing is captured) | AG; `apps/metermcp/src/meter.ts` |
| `budget_exists` blocks while settling | A new budget on the same MCP session is refused while the previous one is `closing`, `settlement_failed` or `capture_pending` | AG; `ledger.ts`, `meter.ts` |
| `METERMCP_MIN_BUDGET` above `METERMCP_BUDGET` only warns | MeterMCP starts and `open_budget` refuses every cap | AG; `apps/metermcp/src/main.ts` |
| `PERSON_CAP` resets at UTC midnight | Not at local midnight | AG (by design); `agent/person-caps.ts` |
| E5 log line on every snapshot build | Noisy log for the agent case | AG; `apps/server/src/app.ts` |
| Buyer instructions ask for «confirmation of the service» | `demo:prepare` still prints that text for the agent case | AG; `scripts/demo-prepare-lib.ts` |
| Agent case bound to a scripted-client session | The hosted agent case's binding (18/10) points at a session made by the earlier scripted MCP client, not by the model-driven agent; no binding names a run yet | AG; runtime configuration |
| Agent-case binding expires around 07/11/2026 | The agent case's current binding (its sandbox dispute, bound 18/10/2026) ages out around 07/11/2026; before judging it must be rebound with `demo:prepare --agent-run <id>`, which prints a binding that names the run. Planned, not yet done: **Pending** | Owner's status notes of 19/10/2026 (private submission notes, not in this repository) |
| Closing steps not evidenced | **Stop** on a real run, the CLI `npm run demo-agent` against the hosted MeterMCP, and the removal of `METERMCP_FAIL_FIRST` from the hosted service are not recorded (the two `/agent` runs, Compare, Keep and the return were) | AG; private evidence 19/10 |
| No tests for MeterMCP's 503 session cap or local-mode `/agent/mcp` | Untested paths | AG |
| `get_receipt` listed inconsistently as free | `price_list`'s free list omits `get_receipt` while other text calls it free | `apps/metermcp/src/tools.ts`, `apps/metermcp/src/app.ts` |
| Receipt URL in `close_session` is unusable by MCP clients | The URL points at an admin route (404 on the public host, needs the admin token); `get_receipt` is the way | `apps/metermcp/src/meter.ts`, `app.ts` |

## Environments, sign-in and health

| Issue | Effect | Source |
|---|---|---|
| Health says `unconfigured` before the first PayPal reach | `/api/health` reports PayPal unconfigured until the lazy first check succeeds | ENV; `app.ts` |
| The checking screen re-reads every 5 s | Polling while the workspace connection is `checking` | ENV; `web/src/domain/environment.ts` |
| `joinUrl` used only by its test | Dead helper | ENV; `environment.ts` |
| Merchant connection not built | No PayPal Platform / Partner Referrals code; new merchants see the waiting screen (**Pending**) | ENV; no `partner-referrals` or `PayPal-Auth-Assertion` code in `apps/` or `packages/` |

## Operations

| Issue | Effect | Source |
|---|---|---|
| Auto-deploy still `commit` for both services | Deploy order MeterMCP → ResolveKit is not guaranteed on a push; the follow-up recommends turning it off for `resolvekit` | AG; `render.yaml` |
| Standard reserve empty | New sends on the standard case are **Pending** until the reserve is refilled (planned 25–30/11) | private evidence 19/10 |
| Reserve position is in memory | After a restart the case walks past used entries again, one warm-up analysis per step, unless `BINDINGS_JSON` is trimmed | `app.ts` (see [Runbook](../operations/runbook.md#dispute-rotation-and-the-reserve)) |
| Unreadable `intents.json` treated as empty | Open intents and the per-dispute "sent" memory are lost and overwritten on the next write (PayPal's fresh read still guards sends) | `apps/server/src/intents.ts` |
| No backup, export or account deletion | See [Backup and recovery](../operations/backup-and-recovery.md), [Retention and deletion](../operations/retention-and-deletion.md) | no backup code in the repository |
| Stores without expiry | Analysis cache, usage log, input pins, send log and MeterMCP ledger grow without limit on 1 GB disks | `packages/analyst/src/cache.ts`, `apps/server/src/main.ts`, `intents.ts`, `apps/metermcp/src/ledger.ts` |
| `.env.example` and `render.yaml` gaps | Many hosted variables are missing from `.env.example`; `render.yaml` omits `DAILY_UPLOADS`, `RESOLVEKIT_PUBLIC_URL`, `METERMCP_PUBLIC_URL` and others (defaults apply). See [Configuration](../technical/configuration.md) | `.env.example`, `render.yaml` |
| Code comment drift | `hosted.ts` header names `RENDER_EXTERNAL_HOSTNAME`, image-only uploads and one proxy hop; `metermcp/src/app.ts` admin list omits `reconcile`; `packages/paypal/src/webhooks.ts` says postback is what PayPal recommends (PayPal calls self-verification preferred) | code comments in the named files |

## Tests and evaluations

| Issue | Effect | Source |
|---|---|---|
| Intermittent server test | *size: five dense A4 pages…* in `uploads-pdf-recovery.test.ts` failed once with `429 RATE_LIMITED` under full-suite load; passes alone | TR 19/10 |
| No DOM tests for the upload and PDF UI | `useUploads`, `PdfSelect`, `PdfReview`, `CasePage` and draft-clear wiring are covered only as pure functions and by a manual browser walk-through | PDF |
| Suites not run on Linux / Render | Only Windows runs recorded | TR |
| Groq held-out batch not run | Stopped on quota at the first attempt; 35 case-runs not run; resume planned when the free quota renews | EV; `packages/analyst/evals/results/summary.md` |

## Not re-checked

Listed in the follow-ups but not verified against the code for this page: PNG validation inflating twice (P1);
the small P1 items (OCR test stub, literal "[redacted]", store order, routes, `confirmedCorrections` on old intents);
the web action limit shown on `/agent` (the page uses the run record's value when present) (AG); the EV scorer, runner
and test small items (EV).
