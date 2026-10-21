[English](data-and-storage.md) | [Español](../es/architecture/data-and-storage.md)

# Data and storage

Each service keeps its state in files on one data directory: on Render a 1 GB persistent disk mounted at
`/var/data`, locally `apps/server/data/` and `apps/metermcp/data/` (both git-ignored). There is no database server.
Code at commit `c12faea`.

## ResolveKit server data directory

`RESOLVEKIT_DATA_DIR` (hosted `/var/data`; local default `apps/server/data/`).

| Path | Format | Content | Written by |
|---|---|---|---|
| `analysis-cache/<sha256 key>.json` | JSON, durable write; unused 30 days or past 100 MiB swept | Live analyses (quotes from the documents, verdicts, draft) | `FileAnalysisStore` (`packages/analyst/src/cache.ts`) |
| `analyst-usage.jsonl` | append JSONL; 90 days, 10 MiB | Token counts and timings per model call; no prompt or document text | `usage-log.ts` |
| `analysis-inputs.json` | JSON map case → input, durable write | The input a case was analysed with before seller evidence went in (`InputPins`) | `analysis.ts` |
| `recheck-verdicts.json` | JSON `{v, verdicts}`, durable write, 2 000 kept | The verifier's verdicts on edited sentences, by analysis key and SHA-256 of the text (not the text): a re-check survives a restart | `verdicts.ts` |
| `reserve-position.json` | JSON `{v, used: {case: [dispute ids]}}`, durable write | The disputes each case moved past in its reserve, skipped again at start | `reserve.ts` |
| `intents.json` | JSON `{intents, sentDisputes}`, durable write | Submission intents, including the approved notes text | `intents.ts` |
| `audit-events.jsonl` | append JSONL (fsynced), compacted above 4 MiB | Audit events: codes, hashes, ids, who and when; no document text | `intents.ts` |
| `audit-events-sends.jsonl` | append JSONL (fsynced), never compacted or expired | Send events (started, sent, failed) | `intents.ts` |
| `uploads/<workspaceId>/<uploadId>/` | `record.json`, `original.bin`, `sanitised.png`, `sanitised.jpg` (a covered photo) or `sanitised.pdf`, `page-<k>.png`, `page-<k>.orig.png`, `thumb-<n>.png` | Merchant uploads; the record is written last | `uploads/store.ts` |
| `agent-runs/<run-id>.json` | JSON per run, durable write | Agent run record: goal, steps with stated reasons, usage, settlement, receipt hash | `agent/runs.ts` |
| `accounts.json` (hosted) | JSON | Workspaces, people (PayPal payer ids, display names, masked emails), passkey public keys, invite token **hashes** | `accounts.ts` |
| `sellers.json` (hosted) | JSON | Seller merchant ids last confirmed for the bound disputes | `sellers.ts` |
| `daily-caps.json` (hosted) | JSON `{day, counts}` | Global daily counters | `packages/hosting` |
| `agent-run-caps.json` (hosted) | JSON `{day, counts{person:n}}` | Agent runs per person per UTC day | `agent/person-caps.ts` |
| `bindings.json` (hosted, only without `BINDINGS_JSON`) | JSON | Case → dispute bindings and reserves; watched every 30 s | operator |

Local only: `apps/server/.runtime-token` (per-launch API token, removed on stop) and `apps/server/bindings.json`.
The operator's `demo:prepare` writes `demo-prepare-runs/<run>.json` on the machine it runs on.

Unreadable `accounts.json` or `sellers.json` stops a hosted start (it would otherwise drop memberships). An
unreadable `daily-caps.json` or a failed save makes capped actions refuse (`CAPS_UNAVAILABLE`, 503). An unreadable
`intents.json`, `analysis-inputs.json`, `recheck-verdicts.json` or `reserve-position.json` is moved aside as
`<file>.corrupt-<time>` and reported (`/api/health` `storage`, the operator's check); the store starts empty. Durable
write: temporary file in the same directory, fsync, rename, best-effort fsync of the directory
(`packages/hosting/src/durable.ts`).

## MeterMCP data directory

`METERMCP_DATA_DIR` (hosted `/var/data`; local `apps/metermcp/data/`).

| Path | Format | Content |
|---|---|---|
| `metermcp.sqlite` (or `METERMCP_DB`) | SQLite through Node's built-in `node:sqlite` | Tables `sessions` (one PayPal budget each: order, authorization, cap, status, capture) and `calls` (tool, price, status, request and response hashes) |
| `daily-caps.json` (hosted) | JSON | Daily budget counter (`DAILY_BUDGETS`) |
| `.runtime-token` (local, in `apps/metermcp/`) | text | Per-launch admin token, removed on stop |

The schema migration runs in one transaction; a failed migration leaves the file untouched and MeterMCP does not
start.

## Memory-only state (lost on restart)

| State | Bound |
|---|---|
| PDF text-layer hints shown during review | once per page per review |
| Verdicts of re-checked (edited) sentences | 2 000, oldest first out (an intent keeps the verdicts it was composed with) |
| Webhook event ids already seen | 2 000 |
| PayPal notices shown to the seller | 50 |
| WebAuthn challenges, pending PayPal sign-ins | 5 min / 15 min |
| Used sign-in tokens | 5 000 |
| Rate-limiter windows | 20 000 keys |
| Live MCP sessions and transports | 200 (public), 10 (`/agent/mcp`) |
| PayPal OAuth tokens | refreshed 60 s before expiry |

## Retention

| Data | Kept | Where in code |
|---|---|---|
| Pending or reviewing upload | 24 h, then discarded (record kept, files and text removed); hourly sweep | `uploads/limits.ts`, `uploads/store.ts` |
| Upload original | Until confirm, discard, delete, expiry or archive | `uploads/store.ts`, `uploads/routes.ts` |
| Discarded, deleted, archived upload | Record (metadata) only | `uploads/store.ts` |
| Intent | 30 min to approve and send; failed retry 30 min; sent 24 h | `intents.ts` |
| Audit events | 200 per owner (2 000 owners); sends log never evicted | `intents.ts` |
| Agent runs | 30 days, unless kept, unsettled, unsaved or their capture is bound | `agent/runs.ts` |
| Analysis cache, usage log, input pins | No expiry in code (an upload delete purges the analyses that quoted it) | `cache.ts`, `main.ts` |
| MeterMCP ledger | No expiry in code | `ledger.ts` |
| Session cookie | 12 h | `accounts.ts` |

Operational procedures: [retention and deletion](../operations/retention-and-deletion.md).

## Backups

There is no backup code. The Render disk is the only copy of each service's state. Backup and restore are
**Pending** (manual): see [backup and recovery](../operations/backup-and-recovery.md).

## Consistency, concurrency and idempotency

| Concern | Mechanism | Status |
|---|---|---|
| Atomic file writes | Write to `<file>.tmp`, then rename; JSONL logs append. No `fsync` call | Implemented · Tested locally |
| Two confirmations of one intent | `approved → sending` is checked and set in one synchronous step | Implemented · Tested locally |
| Two intents for one dispute | Per-dispute lock taken in the same step (`DISPUTE_BUSY`); once a send is accepted and persisted, every other intent for that dispute is refused (`SELLER_EVIDENCE_EXISTS`) | Implemented · Tested locally |
| Send durability | The `sending` state and `send_started` must be written before anything goes to PayPal, otherwise 503 `AUDIT_UNAVAILABLE`; an outcome that cannot be written after PayPal accepted is logged `AUDIT NOT DURABLE` | Implemented · Tested locally |
| Repeated sends to PayPal | One `PayPal-Request-Id` per intent, reused on every retry. Whether the Disputes API deduplicates on it is **not verified** | Implemented · Tested locally; PayPal behaviour Pending |
| Uncertain send (timeout) | Neither success nor failure: the web app reads the dispute back; a safe retry is offered only if PayPal shows no seller evidence | Implemented · Tested locally (simulator); not observed against PayPal: Pending |
| MeterMCP budget reservations | SQLite `BEGIN IMMEDIATE`; a call is reserved only if OK + PENDING + price ≤ cap; failed calls released, never charged | Implemented · Tested locally |
| MeterMCP settlement | One final capture of the OK total (`invoice_id <session>-settle`) or a void; `settlement_failed` retried with the same `PayPal-Request-Id`; `PENDING` capture reconciled every 30 s | Implemented · Tested locally; partial capture Verified in sandbox; `capture_pending` not observed: Pending |
| Daily caps | Reserved atomically before the work and refunded when it did not happen; fail closed | Implemented · Tested locally |
| Agent steps | Write-ahead step before each MeterMCP call; on restart a pending paid step becomes `uncertain` and is never repeated | Implemented · Tested locally; restart recovery in sandbox: Pending |

## Recovery after a restart

| What was in flight | What happens |
|---|---|
| An intent in `sending` | Marked `failed` («the server restarted during the send»); the web app reads PayPal back before any retry |
| An agent run | Marked `interrupted`; its MeterMCP session is closed through the admin route and the receipt re-read (`agent.recover()`, not awaited at start) |
| Agent settlement not final | Reconciled every 5 min |
| MeterMCP `capture_pending` | Read back every 30 s, on demand and on close |
| Pending uploads, interrupted writes | Removed by the sweep at start and hourly |
| Bindings | Re-read from `BINDINGS_JSON` or the file; each verified on a fresh PayPal read in the background |
| Hosted analyses | Warm-up: each bound case analysed once after boot or a bindings change (system runs, same limits and caps) |

Shutdown (`SIGINT`/`SIGTERM`): agent loops get 20 s to end and settle, then intents are flushed, the OCR worker
closed and token files removed.

## Scale limits

One instance per service, state on a local disk: no horizontal scaling, no zero-downtime deploy. The bounds above
(intents, accounts, sessions, storage of 300 MiB for uploads) are sized for a demo. See
[known issues](../quality/known-issues.md).
