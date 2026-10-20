[English](runbook.md) | [Español](../es/operations/runbook.md)

# Runbook

Day-to-day operation of the hosted demo: checking it, reading its signals, handling refusals, background work,
dispute rotation and the reserve. Deploying is in [Deployment](deployment.md); data copies in
[Backup and recovery](backup-and-recovery.md).

## Availability is not functional readiness

| Signal | What it proves | What it does not prove |
|---|---|---|
| `GET /healthz` 200 (either service) | The process is up and answering. Render's health check uses it; it needs no Host match and costs nothing | That PayPal, the models, the bindings or the disk work |
| `GET /api/health` (ResolveKit) | PayPal state as the server last saw it; bound cases only for the seller's workspace | Health says `unconfigured` until the first PayPal call succeeds (lazy check, retried) |
| `GET /health` (MeterMCP) | `{ok, paypal, mcpSessions, mcpRejected, mcpExpired}` | That a budget can be approved or captured now |
| `npm run demo:check` → `READY` | Every line below passed at that moment | Which commit is live; that the next send will be accepted by PayPal; that a reviewer's browser or PayPal account works |
| A reviewer's evidence shown **Recorded by PayPal** | PayPal returned new matching seller evidence on read-back | That the dispute is resolved or won |

## The operator's check: `npm run demo:check`

```bash
npm run demo:check                    # needs RESOLVEKIT_OPS_TOKEN in .env (exit 2 without it)
npm run demo:check -- --no-models     # skip the model probes
npm run demo:check -- --app https://<resolvekit host> --metermcp https://<metermcp host>
```

What it does (`apps/server/scripts/demo-check.ts`, `demo-check-lib.ts`, `apps/server/src/hosted.ts`):

- Sends the token only over https or to this machine; otherwise exit 2. Defaults to the public demo hosts.
- In parallel: `GET <app>/healthz`, `GET <app>/` (must contain "ResolveKit"), `GET <metermcp>/healthz`, and
  `GET <app>/api/ops/status?probe=models` with `Authorization: Bearer <token>` (120 s timeout). Without the token on
  the server, or with a different one, the ops route answers 404.
- Prints one `PASS`, `WARN` or `FAIL` line per item, then `READY` or `NOT READY`. Exit 0 only when every line passed;
  `WARN` (fewer than 2 disputes left in a case's reserve) still passes.

**It is not side-effect free.** "Read-only" is true for what the script sends, not for the server's state:

| Effect | Why | How to avoid |
|---|---|---|
| **One model call per configured provider** (Gemini and/or Groq), each alone, no retry or fallback, 20 s provider timeout, 30 s overall, 256 max output tokens | `?probe=models` is on by default | `--no-models` |
| **Fresh PayPal reads of every bound dispute** | The ops report verifies each binding on a fresh read | — |
| **A used case may rotate to its next reserve dispute, and the case is then analysed again live** (a warm-up: model calls, counted in the hourly limit and daily cap) | Those reads go through the same code as any case read, which rotates a used dispute (see [Dispute rotation](#dispute-rotation-and-the-reserve)) | Expect it after a review session; check the reserve first |
| Counts against the ops/auth rate limit (40 per address per 15 min) | Shared bucket with `POST /api/auth/*` | Do not loop it |

The output contains sandbox dispute and capture ids: do not paste it into public places.

Run it after every deploy and daily during judging. Interpreting `FAIL` lines: the server's own wording follows
`server reports` (for example `binding … is used … and no dispute is left in reserve`, `the PayPal webhook is off`,
`AI model …: …`, `warm-up · case … · failed`).

## Monitoring

There is no alerting in the code. What exists:

| Area | Where to look | What to watch |
|---|---|---|
| Memory | Render's service metrics (512 MB per instance) | The image/PDF/OCR path is the heavy one. One image or PDF job runs at a time server-wide; the PDF child is capped at 160 MB heap and, on Linux, killed above 200 MiB RSS; the OCR worker is stopped after 60 s idle and never resident together with a PDF child. Observed earlier: ~250 MB resident after an 8 MP image reading, peak ~395 MB of 512 (P1 follow-up, 17/10/2026, `docs/superpowers/plans/2026-10-17-merchant-evidence-phase1-followups.md`). **Memory with a 5-page PDF on Render: Pending.** If memory grows, the follow-ups suggest trying `MALLOC_ARENA_MAX=2` (not tried) |
| CPU | Render's service metrics (0.5 CPU) | PDF thumbnails have 3 s each, page renders 20 s, a PDF session 90 s in all; on 0.5 CPU real PDFs may hit the thumbnail deadline (follow-up, not measured) |
| Storage | Render disk usage (1 GB each) | Uploads are capped at 300 MiB in all (`507 STORAGE_FULL` beyond). The analysis cache (unused 30 days, 100 MiB) and the analyst usage log (90 days, 10 MiB) are swept at start and hourly (`ANALYSIS_CACHE_MAX_*`, `ANALYST_USAGE_MAX_*`). The audit sends log and the MeterMCP ledger are audit and money records and **never expire**; they grow, and nothing alerts on disk use |
| Providers | ResolveKit log lines `analyst call · <stage> · <provider>/<model> · in … out … thinking … · <ms> ms` and `analyst fallback · <why>`; `<data>/analyst-usage.jsonl` (token counts and timings only); `demo:check` model lines | Groq's free tier answers `429` when its quota is used (observed in the evaluations); the analyst then falls back, the agent picks its provider at the first answer and keeps it |
| PayPal | `demo:check` lines; the log at start (`… → <dispute> · capture …`, `checkBindings` results); webhook lines | `PayPal unconfigured`, bindings not `verified` |
| Agent runs | Log lines `agent runs · reconcile failed`, `agent run <id>: not saved …`, `agent runs · sweep · …` | Runs with settlement `open`, `capture_pending`, `failed` or `unverified` are retried every 5 min |
| MeterMCP | Log lines `idle sweep failed`, `capture reconciliation failed`, `mcp sessions: closed … idle`; `/health` counters | Sessions stuck in `capture_pending` |

Useful log lines (ResolveKit unless noted). Logs never carry document text, keys or tokens.

| Line starts with | Meaning |
|---|---|
| `Hosted mode · …` | Start-up summary: origins, PayPal sign-in on/OFF, webhook on/OFF, ops check on/OFF, data dir |
| `WARNING: …` | A degraded start (missing session secret, identity app, MeterMCP admin token; on MeterMCP: no `DEMO_CODE`, min budget above max) |
| `warm-up · case …` | Background analysis of a bound case after start, a binding change or a rotation: `done`, `cached`, `skipped` or `failed`, with why |
| `reserve · case …` | A case moved to its next reserve dispute; how many are left; uploads archived |
| `bindings changed · …` / `bindings file changed but is invalid…` | The watched bindings file (only without `BINDINGS_JSON`) |
| `uploads · sweep …` | Expired uploads discarded and leftovers removed (counts only) |
| `AUDIT NOT DURABLE` | PayPal accepted a send but its outcome could not be written to the audit log |
| `TEST SWITCH: …` (MeterMCP) | `METERMCP_FAIL_FIRST` is set: must not appear on the hosted service |
| `ledger migration failed, rolled back …` (MeterMCP) | MeterMCP did not start; see [Deployment](deployment.md#metermcp-ledger-migration) |

## Quotas, limits and persistence errors

| What the user or the log sees | Cause | What to do |
|---|---|---|
| `429 DAILY_CAP` (live analyses 60, re-checks 200, evidence sends 20, uploads 40, agent runs 20 per UTC day; in the code, not yet deployed: message sends 20 `DAILY_MESSAGE_SENDS`, settling actions 20 `DAILY_SETTLE_SENDS`) | The global daily cap of that action was reached | Wait for the UTC day to change (`GET /api/demo` shows `resetsAt`), or raise the `DAILY_*` value on Render (restarts the service; counts are kept on disk) |
| `429 PERSON_CAP` | 5 agent runs per person per UTC day (not configurable) | Wait for UTC midnight |
| MeterMCP `DAILY_BUDGETS` (20) reached | Budgets opened today | Wait for the UTC day, or raise `DAILY_BUDGETS` on MeterMCP |
| `429 RATE_LIMITED` with `Retry-After` | Per-address or hourly limit (e.g. 6 live analyses or 30 re-checks per hour server-wide; uploads, redactions and PDF page reads 20 per 10 min per address) | Wait. Per-address limits are a courtesy, not the security boundary |
| `503 CAPS_UNAVAILABLE` (sends, live runs, re-checks, uploads, agent runs refused) | `daily-caps.json` (or `agent-run-caps.json`) unreadable at start, or the last save failed: the caps fail closed | Fix or remove the file on the disk; it is read again on the next reservation, no restart needed. Removing it resets today's counts |
| `503 AUDIT_UNAVAILABLE` on send | The `sending` state and `send_started` event could not reach the disk: nothing was sent | Check the disk (space, permissions); the person can send again |
| `AUDIT NOT DURABLE` in the log | PayPal accepted, the outcome write failed | The PayPal read-back is the truth; check the disk |
| `action outcome unknown · case … · intent … · request …` in the log; `409 DISPUTE_UNCERTAIN` (with `holder`: the intent and case holding the dispute) to the person | A dispute action timed out or got an unclear answer, or PayPal accepted it and no read-back has proven it yet: the dispute is held | Nothing to force, never resend by hand. Anyone in the seller's workspace presses **Check again** on the case page (it finds the hold after a reload and reads back *that* send). The operator: `GET /api/ops/status` lists every hold (`holds`): a hold under 5 min old is a line in `notices` (demo:check prints it as a WARN «held dispute», still ready), an older one or one whose intent is gone a line in `problems`; `POST /api/ops/readback/<intent>` with the ops Bearer reads it back (never a send). The hold ends when PayPal proves the action recorded, or absent while still offered (log `read-back · case … · intent …: recorded\|absent`) |
| A hold with `intentKnown: false` (ops status: «its intent is gone»); the read-back stays «Outcome pending confirmation: this server no longer has the approved content…» | `intents.json` was lost or unreadable at start; the hold was rebuilt from the send log, which keeps only hashes, so no read-back can prove the send recorded or absent | 1. If the old file was preserved (`intents.json.corrupt-<time>`, named in the log) or a backup exists, put it back as `intents.json`, restart, and read back. 2. Otherwise the dispute stays held by design (ResolveKit never releases an unproven send): look at the dispute in the PayPal sandbox by hand, never resend, and remove that dispute from `BINDINGS_JSON` so the case moves to its next dispute; the held one takes no write again |
| `… could not be read …; every action interrupted by the restart is held until a read-back settles it` | The send log was unreadable at start | Fix the file; held disputes are released by their read-backs |
| `503 ACCOUNTS_UNAVAILABLE` | A change to `accounts.json` could not be written (it is undone) | Check the disk |
| `503` with `STORAGE` (uploads), `507 STORAGE_FULL` | An upload write failed (undone), or the 300 MiB upload budget is used | Check the disk; delete unneeded uploads; expired ones go within the hour |
| `503 STORAGE` on agent start | The run record could not be written: nothing started | Check the disk |
| Agent `stopped` / `persistence` | A write-ahead record failed during a run: no further tool call is made; the state stays in memory and the 5-min sweep writes it | Check the disk |
| `503 MODEL_UNAVAILABLE`, `ANALYST_UNCONFIGURED` | No model key | Set `GEMINI_API_KEY` and/or `GROQ_API_KEY` |
| Agent `meter_unavailable` | `METERMCP_ADMIN_TOKEN` missing on `resolvekit`, or MeterMCP down | Fix the env (from `fromService`) or MeterMCP |
| MeterMCP `demo_code_required` | No or wrong `x-demo-code`; or `DEMO_CODE` unset (then no budget can be created at all) | Give the right code; set `DEMO_CODE` |

## Background work, pending jobs and settlements

| Work | When it runs | What happens on a restart |
|---|---|---|
| **Agent run recovery** | At every start, in the background (a MeterMCP that is down does not delay listening) | Every unfinished run becomes `interrupted`; a MeterMCP call that was announced but never answered becomes `uncertain` and is never made again; the session is closed through MeterMCP's admin route and the receipt read again. **Restart recovery in the sandbox: Pending** |
| **Agent reconcile and sweep** | Every 5 min | Unsaved records are written; runs whose settlement is `open`, `capture_pending`, `failed` or `unverified` are closed or reconciled and their receipt re-read; runs older than 30 days are deleted unless kept, unsettled, unsaved or bound to a case |
| **MeterMCP sweep** | Every 30 s | Idle sessions closed (`METERMCP_IDLE_MINUTES`, 15) and settled; `capture_pending` captures read back until `COMPLETED` (→ `settled`) or `DECLINED`/`FAILED` (→ `capture_declined`); idle MCP transports freed. `settlement_failed` sessions are retried on close with the same `PayPal-Request-Id`. **`capture_pending` was not observed in the sandbox: Pending** |
| **PDF upload jobs** (thumbnails, renders, OCR) | In the background after the upload route answers, one upload at a time server-wide | A job cut by a restart is marked failed with *The server restarted while reading this PDF. Discard it and upload it again.* and its files are dropped |
| **Upload sweep** | At start and hourly | Pending/reviewing uploads older than 24 h discarded (record kept, files and text gone); leftovers of interrupted writes (`*.tmp`, directories nothing refers to) removed. The same sweep bounds the analysis cache and the analyst usage log (log lines `analysis cache · sweep …`, `analyst usage log · sweep …`, counts only) |
| **Evidence sends** | On request | A send cut by a restart (`sending`) comes back as `failed` (*the server restarted during the send*) and may be retried for 30 min with the same intent and `PayPal-Request-Id`; the evidence route reads PayPal first, and refuses if seller evidence is already there |
| **Warm-up analyses** | After start, after a binding change, after a rotation | Each bound case analysed once if its documents have no stored analysis (system runs, same hourly limit and daily cap) |
| **Bindings file watch** | Every 30 s, only when `BINDINGS_JSON` is not set | An invalid file is logged and ignored |

### Restarts and shutdown

On `SIGTERM`/`SIGINT` ResolveKit first gives agent runs up to 20 s to end as `interrupted` and settle, then flushes
intents, stops the upload sweep and the OCR worker, removes the local token file and closes. MeterMCP stops its sweep,
closes MCP sessions and the ledger. In-memory state is lost on restart: PDF text hints, remembered webhook event ids
(a repeated delivery is re-read, harmlessly), the last 50 webhook notices, WebAuthn challenges and rate-limiter windows.
The reserve position and the re-check verdicts are kept on the disk (see below). Without `RESOLVEKIT_SESSION_SECRET` (32+ characters) every restart signs
everybody out.

## Auxiliary processes and temporary files

| Process / file | Lifecycle |
|---|---|
| PDF reader child (`pdf-child.ts`, forked, `--max-old-space-size=160`) | One per PDF session. Killed with `SIGKILL` past its deadline (20 s a page, 3 s a thumbnail, 90 s a session) and, on Linux only, above 200 MiB RSS (read every 100 ms). A crash never takes the server down; the next session starts a fresh child. **Killing a real decompression bomb by RSS on Linux was not measured: Pending** |
| OCR worker (tesseract.js, local language data, no network) | Created on demand, one job at a time; stopped after 60 s idle and before any PDF child starts; a job that times out (45 s, start 30 s) terminates it. `closeOcr()` has no time limit of its own (known issue) |
| `*.tmp` files | Every store writes durably: `<file>.<pid>.<random>.tmp`, fsync, rename, then a best-effort fsync of the directory (`packages/hosting/src/durable.ts`); a failed write removes its temporary file. Leftovers of a crash: removed by the upload sweep (uploads), at start (the data dir of each service itself, only names of that pattern older than 10 min; analysis cache, agent runs) |
| `*.corrupt-<time>` files | A store file that exists but cannot be read at start (`intents.json`, `analysis-inputs.json`, `recheck-verdicts.json`, `reserve-position.json`) is renamed to `<file>.corrupt-<UTC time>` when its content is bad, logged as `ERROR …`, flagged in `/api/health` (`storage`: the store names locally, `true` in hosted mode) and listed by `demo:check` (`storage · …`); the store starts empty (`intents.json`: the disputes already sent to are rebuilt from the send log). Look at the file, then put it back (stopped service) or delete it. A read error (busy, permissions) or a rename that fails leaves the file in place, never written over (for `intents.json`: every send is refused); fix it and restart |
| `apps/server/.runtime-token`, `apps/metermcp/.runtime-token` | Local mode only: written at start (mode 600), removed at a clean stop |

## Dispute rotation and the reserve

The sandbox evaluation cases are bound to real PayPal sandbox disputes. In our sandbox tests the `provide_evidence`
action disappeared after one submission, so a case can be bound to a **reserve**: a list of `{dispute, capture}`
entries, the first one active.

**How rotation works** (`apps/server/src/app.ts`, verified in the sandbox on 17/10): on a read of the case, if the
active dispute is `RESOLVED`, or holds seller evidence older than 15 minutes (so whoever sent it can see the
read-back), the **next** read moves the case to the next entry. It logs `reserve · case …`, archives the old
dispute's uploads (records kept, files and text dropped), and triggers a warm-up analysis. An intent composed for the
previous dispute is refused (`BINDING_CHANGED`). With an empty reserve nothing moves: the case stays on its used
dispute and `demo:check` fails with `… is used … and no dispute is left in reserve`.

**The reserve position is kept on the disk** (`<data>/reserve-position.json`, `apps/server/src/reserve.ts`): each
dispute a case moved past is recorded there. At start, and when a bindings file changes, the server skips those
disputes at the front of the case's `BINDINGS_JSON` list and logs `reserve · case …: … used before
(reserve-position.json) → …`. `BINDINGS_JSON` stays the source of truth: only a dispute still listed for that case is
skipped, entries that no longer match the bindings are ignored, and the last listed dispute is never skipped. Trimming
used disputes from `BINDINGS_JSON` is still tidy but no longer needed. An unreadable file is preserved as
`reserve-position.json.corrupt-<time>` and the cases walk their lists as before (Tested locally,
`apps/server/test/reserve.test.ts`; not yet observed on the hosted service).

**A held dispute is never rotated away** (Tested locally, `reserve.test.ts`, `hosted.test.ts`): while a dispute action
on the active dispute is in flight, uncertain or awaiting its read-back, neither a read (`rotateIfUsed`), nor a start,
nor a bindings reload (`reserve.apply()`, including a wholesale reload that lists the dispute elsewhere) moves the case
off it, so whoever sent the action reads PayPal's answer on the same dispute. The log says `reserve · case …: … is held
by an action still settling → kept active`, and the ops report (`GET /api/ops/status`) shows each binding's `held`
(`{intentId, since}`, or `null`). A held dispute the new bindings no longer list is not kept: the configuration wins.

**The owner settlement case** `PP-R-STL-10190667` has its own reserve in `BINDINGS_JSON` and rotates like any case.
Each dispute may be listed once in the whole file (a duplicate stops the start). It has no stored analysis, so evidence
composed there answers `NO_ANALYSIS`; it is meant for the owner-only actions.

**State on 19/10/2026 (private evidence):** the standard case's active dispute is used and its reserve is empty, so new
sends to it are **Pending** until the reserve is refilled (planned 25–30/11). PayPal documents that the inquiry
stage lasts up to 20 days unless escalated
(https://developer.paypal.com/platforms/disputes/handle-disputes/use-disputes-api); check each dispute's
`seller_response_due_date` and prepare disputes for the dates they are needed.

### Preparing the reserve: `npm run demo:prepare`

Runs on the operator's machine against the PayPal **sandbox** only (refuses anything else). You act as the sandbox
buyer, logged in with the sandbox **personal (buyer)** account; nothing is faked. Needs `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` in `.env`.

```bash
npm run demo:prepare -- --dry-run                     # OAuth check, shows what it would create; creates nothing
npm run demo:prepare -- --standard --count 5          # five 7.00 USD CAPTURE orders for the standard case
npm run demo:prepare -- --agent --agent-count 3       # three model-driven agent sessions vs the hosted MeterMCP
npm run demo:prepare -- --agent-run run-<32 hex> --seller <merchant id>   # a run already made on /agent, read only
npm run demo:prepare -- --wait-disputes --captures <standard>,<agent>      # resume: wait, then print BINDINGS_JSON
```

| Mode | What it does | Needs |
|---|---|---|
| `--standard [--count N]` (1–20) | Orders v2 `CAPTURE` for the standard case's order (1 × "Linen tote, natural", 7.00 USD); prints the approval URL; captures after approval | PayPal sandbox app |
| `--agent [--agent-count N]` (1–10) | Runs the model-driven agent engine against MeterMCP (default the hosted one), with `--agent-goal`, `--agent-cap` (0.50–5.00), `--agent-fail-first`. Approve each budget with the sandbox **personal (buyer)** account: PayPal refused the business (seller) account in the 19/10/2026 run («Estás entrando en la cuenta del vendedor…» (PayPal's page was in Spanish; roughly «you are signing in to the seller's account»; recorded truncated); observed, not documented) | `METERMCP_DEMO_CODE` (same value as MeterMCP's `DEMO_CODE`), a model key (`GEMINI_API_KEY` / `GROQ_API_KEY`), `AGENT_*` optional. **Model calls and a sandbox budget** |
| `--agent-run <id>` (repeatable) | Reads a run already made on `/agent` (record and receipt through `GET /api/ops/agent-run/<id>`); never runs or pays again | `--seller <merchant id>`, the **current** `BINDINGS_JSON` in `.env` (so no capture is bound twice), `RESOLVEKIT_OPS_TOKEN` for the hosted app |
| `--wait-disputes --captures …` | Polls PayPal (every 30 s, up to `--dispute-minutes`, default 45) until each dispute appears and reaches `WAITING_FOR_SELLER_RESPONSE`, then prints `BINDINGS_JSON` | — |

An agent run joins the reserve only if it has ended, has at least one charged call, its settlement is `captured` with
PayPal's capture `COMPLETED`, and its session, capture and receipt hash match the receipt; a run that ended on a limit
or an interruption is noted as *not a goal achieved*. A run record kept on the server is swept after 30 days unless
**Keep** was pressed or it is bound: keep the runs you plan to use.

The script prints what the buyer clicks to open each dispute, logged in with the sandbox **personal (buyer)** account.
For the agent case the claim is what its evidence answers: item type «Service», «My AI agent paid for MeterMCP tool
calls and I didn't receive their results» (the receipt lists each call delivered; failed ones were not charged).

**Status:** Implemented · Tested locally (`apps/server/test/demo-prepare.test.ts`). Use of `--agent` / `--agent-run`
for the hosted reserve: **Pending** (planned 25–30/11). No binding names a model-driven run yet; the agent case's
current binding points at a session made by the earlier scripted client.

Then paste the printed `BINDINGS_JSON` into the `resolvekit` service on Render (it restarts), run `demo:check`, and
confirm the reserve count on the binding lines.
