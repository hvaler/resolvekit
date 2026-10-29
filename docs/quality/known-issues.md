[English](known-issues.md) | [Español](../es/quality/known-issues.md)

# Known issues

Open follow-ups, updated for the code at `c12faea` (deployed 21/10/2026); first checked line by line at `fbe9621` (19/10/2026). Each item names its source (the maintainers' follow-up lists, keyed below) and, where relevant, the code location. Items marked
**by design** are kept on purpose but worth knowing. Product limits (what ResolveKit does not do) are in
[Limitations](../product/limitations.md).

Sources: **P1** follow-ups of the merchant-evidence work (17/10) · **PDF** follow-ups of the PDF work (18/10)
· **AG** follow-ups of the buying agent (18/10) · **ENV** follow-ups of the three environments (18/10) ·
**EV** follow-ups of the analyst evaluations (19/10) · **TR** the test run of 19/10 ([Testing](testing.md)) ·
**DA** the dispute-actions design (19/10) and the code at
`076c74f` (20/10/2026), now in `c12faea`.

## Uploads and PDFs

| Issue | Effect | Source |
|---|---|---|
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
| `budget_exists` blocks while settling | A new budget on the same MCP session is refused while the previous one is `closing`, `settlement_failed` or `capture_pending` | AG; `ledger.ts`, `meter.ts` |
| `PERSON_CAP` resets at UTC midnight | Not at local midnight | AG (by design); `agent/person-caps.ts` |
| Agent case bound to a scripted-client session | The hosted agent case's binding (18/10) points at a session made by the earlier scripted MCP client, not by the model-driven agent; no binding names a run yet | AG; runtime configuration |
| Agent-case binding expires around 07/11/2026 | The agent case's current binding (its sandbox dispute, bound 18/10/2026) ages out around 07/11/2026; before judging it must be rebound with `demo:prepare --agent-run <id>`, which prints a binding that names the run. Planned, not yet done: **Pending** | Owner's status notes of 19/10/2026 (private submission notes, not in this repository) |
| Closing steps not evidenced | **Stop** on a real run, the CLI `npm run demo-agent` against the hosted MeterMCP, and the removal of `METERMCP_FAIL_FIRST` from the hosted service are not recorded (the two `/agent` runs, Compare, Keep and the return were) | AG; private evidence 19/10 |

## Dispute actions

| Issue | Effect | Source |
|---|---|---|
| Refundable amount in another currency | If PayPal's refundable amount were in a currency other than the dispute's, an amount is refused with `AMOUNT_ABOVE_REFUNDABLE` («The amount must be below / at most what PayPal would refund, <amount>») quoting the other currency, without saying that the currencies differ. Never seen in the sandbox (every dispute was USD) | DA; `apps/web/src/domain/actions.ts` (amount checks in `composeActionWith`) |
| Contracts README out of date | `packages/paypal/contracts/README.md` still says no write was sent and every variant is «Not available»; the registry (`actionContracts.ts`) and the recorded files are the current state | DA; `packages/paypal/contracts/README.md` |
| Message with a file: one observation | The composer attaches one confirmed upload (`send_message:file`); it was sent once through the app in the sandbox (V-7, 21/10/2026, a local run) and read back «Recorded by PayPal» with 1 document; the read-back proves the text and the document's presence, not its content; a single observation; the registry status is deployed (`c12faea`) | DA; `apps/web/src/components/ActionComposer.tsx` |
| The buyer's answer to an offer was never recorded | A pending offer is judged by PayPal's live `make_offer` link and, as a backstop, any later offer entry ends it; the buyer's event names are unknown | DA; `actions.ts` (`pendingSellerOffer`) |
| Rules cover one reason, one stage and the recorded statuses | Accept, offer and escalate are composed only for not-received disputes waiting for the seller, a message also while PayPal waits for the buyer, and every action only in `INQUIRY`, because the recorded writes covered nothing else; others are refused, not guessed (**by design**) | DA; `actions.ts` (`RECORDED_STAGES`, `RECORDED_STATUSES`, `ACTION_RULES`) |
| «Absent» after 60 s is a residual risk | A read-back proves a send absent when PayPal shows no new seller entry 60 s after `send_started` and still offers the action (`absentAfterMs`, twice the lag the sandbox showed). If PayPal ever recorded an entry later than that, a retry after «absent» could post the action twice; never observed in the sandbox | DA; `actionContracts.ts` (`absentAfterMs`), `actionReadback.ts` (`proveSend`) |
| A hold whose intent is lost cannot be read back | If `intents.json` is lost, a held dispute is rebuilt from the send log (hashes only) and stays held: no read-back can prove it; the operator restores the file or rebinds the case (Runbook) (**by design**) | DA; `intents.ts` (`seedFromSendLog`), `actions/routes.ts` |
| Appeal not testable in the sandbox | The sandbox refused to produce an appealable dispute (W-7), so appeal stays «Not available» | DA; `packages/paypal/contracts/appeal-setup-adjudicate.json` |
| `provide_supporting_info` not supported | Offered by PayPal after evidence in a claim; ResolveKit shows nothing to send | DA; `apps/web/src/domain/simulatedActions.ts` |
| Proof of refund not sent | If PayPal asks only for it, no evidence can be sent on that dispute in this delivery; W-11 is a pending sandbox test | DA; `actionContracts.ts` |
| The app's flow verified once per variant, not exercised on the hosted service | Each verified variant was sent once through the app on a local server (20/10/2026, V-1 to V-6; the message with a file on 21/10/2026, V-7): single observations. The Not-available variants were not run through the app; the code is deployed (`c12faea`) but nothing was sent from the hosted service (**Pending**); the settlement case is not yet bound in the hosted `BINDINGS_JSON` | DA |

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
| No backup, export or account deletion | See [Backup and recovery](../operations/backup-and-recovery.md), [Retention and deletion](../operations/retention-and-deletion.md) | no backup code in the repository |
| Audit and money records never expire | The send log (`audit-events-sends.jsonl`) and the MeterMCP ledger grow without limit on 1 GB disks (**by design**: they are the audit and money records; the analysis cache and the usage log are bounded) | `intents.ts`, `apps/metermcp/src/ledger.ts` |
| A corrupt upload record is swept | An upload directory whose `record.json` cannot be read is removed by the hourly sweep as a leftover (its files go too); not preserved like the other stores. Durable writes make this unlikely | `uploads/store.ts` (`readRecord`, `sweepDisk`) |

## Tests and evaluations

| Issue | Effect | Source |
|---|---|---|
| No DOM tests for the upload and PDF UI | `useUploads`, `PdfSelect`, `PdfReview`, `CasePage` and draft-clear wiring are covered only as pure functions and by a manual browser walk-through | PDF |
| Suites not run on Linux / Render | Only Windows runs recorded | TR |
| Groq held-out batch not run | Stopped on quota at the first attempt; 35 case-runs not run; resume planned when the free quota renews | EV; `packages/analyst/evals/results/summary.md` |

## Not re-checked

Listed in the follow-ups but not verified against the code for this page: PNG validation inflating twice (P1);
the small P1 items (OCR test stub, literal "[redacted]", store order, routes, `confirmedCorrections` on old intents);
the web action limit shown on `/agent` (the page uses the run record's value when present) (AG); the EV scorer, runner
and test small items (EV).
