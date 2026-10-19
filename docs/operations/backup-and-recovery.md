[English](backup-and-recovery.md) | [Español](../es/operations/backup-and-recovery.md)

# Backup and recovery

**There is no backup code in ResolveKit or MeterMCP.** Nothing copies, exports or snapshots the data on a schedule,
and no restore has been tested. Each service keeps its state on its own Render persistent disk (1 GB at
`/var/data`). Render describes snapshots of persistent disks in its own documentation; we have not checked or used
them for this project (**Pending**). This page says what to copy, which copies are consistent, and what the code
already does to recover from a crash.

## What each service keeps

### `resolvekit` (`RESOLVEKIT_DATA_DIR`, `/var/data` on Render; `apps/server/data/` locally)

| Path | Format, how written | If lost |
|---|---|---|
| `accounts.json` | JSON, tmp + rename, whole file | Every workspace, person, passkey and invite is gone: the Owner signs in again with PayPal and re-invites everyone. Unreadable at start: the service does not start |
| `sellers.json` | JSON | Sellers seen on bound disputes are learnt again on the next PayPal read. Unreadable at start: the service does not start |
| `intents.json` | JSON `{intents, sentDisputes}`, debounced write (200 ms), synchronous for `sending`; holds the notes text the merchant approved | Open intents are lost (people compose again). The "already sent for this dispute" memory is lost; PayPal's fresh read before every send still refuses when seller evidence exists. **Unreadable at start is treated as empty**, and the next write replaces it |
| `audit-events.jsonl`, `audit-events-sends.jsonl` | Append-only JSONL (codes, hashes, ids; no document text). The first is compacted above 4 MiB; the sends log is never compacted | The approval and send trail. A torn last line is skipped on read |
| `analysis-cache/<sha256>.json` | JSON, tmp + rename | Live analyses are recomputed (model calls, within the caps). Golden analyses ship with the code |
| `analysis-inputs.json` | JSON, tmp + rename | The input a case was analysed with before the seller's evidence went in; without it a case whose evidence is in may need a new analysis |
| `analyst-usage.jsonl` | Append JSONL, token counts and timings only (best effort) | Usage history only |
| `uploads/<workspace>/<upload>/…` | `record.json` written last, files tmp + rename | Merchant uploads (sanitised files, records); confirmed evidence can no longer be attached |
| `agent-runs/<run-id>.json` | JSON per run, tmp + rename | Run records; a case bound to a run can no longer show its run record (E5). The MeterMCP receipt is separate |
| `daily-caps.json`, `agent-run-caps.json` | `{day, counts}` | Today's counts restart at zero (more quota today) |
| `bindings.json` | JSON, only used when `BINDINGS_JSON` is not set | The bindings, unless they are in `BINDINGS_JSON` |

Outside the disk: `BINDINGS_JSON` and every secret live in Render's environment settings; keep the bindings you paste
(they are printed by `demo:prepare`) in a private place of your own. `demo-prepare-runs/<run>.json` is written on the
operator's machine, not on Render.

### `resolvekit-metermcp` (`METERMCP_DATA_DIR`, `/var/data` on Render)

| Path | Format | If lost |
|---|---|---|
| `metermcp.sqlite` (+ `metermcp.sqlite-wal`, `metermcp.sqlite-shm` while open) | SQLite in WAL mode; tables `sessions`, `calls`; every money decision is one transaction | Every session, call, hash and settlement: receipts cannot be produced again, and the agent case can no longer show its receipt. The PayPal orders, authorizations and captures stay at PayPal |
| `daily-caps.json` | `{day, counts}` (`budget`) | Today's budget count restarts at zero |

## Consistent copies

The code writes each JSON file atomically (tmp + rename), so a file copied on its own is either the old or the new
version, never half. It does **not** keep files consistent with each other: a copy taken while the service runs may
hold an intent without its audit event, an upload record without the analysis that quotes it, or a run record ahead
of its MeterMCP receipt.

| Copy | Consistent? |
|---|---|
| Both disks with both services **stopped** (suspended on Render) | Yes: the reference copy |
| One service stopped | That service's files are consistent with each other; they may be ahead of or behind the other service (a run record vs its MeterMCP session) |
| `metermcp.sqlite` alone while MeterMCP runs | **No**: committed transactions may still be in `metermcp.sqlite-wal`. Copy the three files together with MeterMCP stopped, or use SQLite's own online backup (`VACUUM INTO` or the backup API; not scripted here, not tested) |
| One JSON file while running | That file is internally consistent |
| JSONL logs while running | All complete lines are valid; a torn last line is skipped on read |

Suggested manual procedure (not scripted, not tested: **Pending**):

1. Tell reviewers; make sure no agent run or evidence send is in progress.
2. Suspend `resolvekit`, then `resolvekit-metermcp` (agent runs get 20 s to end as `interrupted` and settle).
3. Copy `/var/data` of each service with a tool you trust (Render's shell or SSH, where your plan offers it). Keep
   the copies private: `accounts.json`, `intents.json` and uploads hold personal data and approved texts.
4. Resume MeterMCP first, then ResolveKit, and run `npm run demo:check`.

## Restore

1. Suspend both services.
2. Put the files back in each `/var/data`, MeterMCP's three SQLite files together.
3. Start MeterMCP (it migrates the ledger if the copy is older; a failed migration changes nothing and stops the
   start), then ResolveKit.
4. Check: `demo:check`; sign in as the Owner; open a bound case and the audit trail.

Restoring an older copy has consequences outside ResolveKit. PayPal keeps everything that was sent and every capture;
the restored state may not know about them. The server reads PayPal before every send, so a dispute that already
holds seller evidence is refused (`SELLER_EVIDENCE_EXISTS`), but agent runs and MeterMCP sessions made after the copy
are gone from ResolveKit's view. A restore was never rehearsed (**Pending**).

## What the code recovers by itself

| Situation | Behaviour (code) |
|---|---|
| Crash mid-write of any JSON store | tmp + rename: the old file survives. Leftover `*.tmp` files are removed at start (analysis cache) or by the hourly upload sweep (uploads) |
| Crash during an evidence send | The send's `sending` state and `send_started` event were on disk before PayPal was called (else `503 AUDIT_UNAVAILABLE`, nothing sent). At start it becomes `failed` (*the server restarted during the send*), retryable for 30 min with the same intent and `PayPal-Request-Id`; PayPal is read first |
| PayPal accepted, outcome not written | Logged `AUDIT NOT DURABLE`; the read-back from PayPal is the truth |
| Crash during an agent run | At start the run becomes `interrupted`; an announced call without an answer becomes `uncertain`, never repeated; the session is closed and the receipt re-read (restart recovery in the sandbox: **Pending**) |
| Crash during a PDF job | The upload is marked failed (*The server restarted while reading this PDF…*) and its files dropped |
| Crash during a MeterMCP capture | The session stays `closing` / `settlement_failed` / `capture_pending`; the 30 s sweep, a close or a reconcile retries with the same `PayPal-Request-Id` |
| Ledger migration fails | Rolled back in one transaction; MeterMCP does not start |
| `daily-caps.json` unreadable | Kept as it is (not overwritten); the caps refuse everything (`503 CAPS_UNAVAILABLE`) until it is fixed or removed; it is re-read without a restart |
| `accounts.json`, `sellers.json`, bindings unreadable | The service does not start (rather than run with no memberships) |
| `intents.json` unreadable | Treated as empty (a known gap: see [Known issues](../quality/known-issues.md)) |
| An upload archive write fails at rotation | The upload stays `confirmed` but bound to the old dispute (so in no input); its files keep counting toward the 300 MiB; **not retried** (known issue) |

See also [Retention and deletion](retention-and-deletion.md) for what is removed on purpose and when.
