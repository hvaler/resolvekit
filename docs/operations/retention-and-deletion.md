[English](retention-and-deletion.md) | [Español](../es/operations/retention-and-deletion.md)

# Retention and deletion

What ResolveKit and MeterMCP keep, for how long, and what deletes it. Everything here is from the code at `5111b88`
(Implemented · Tested locally unless noted). There is no account-deletion feature and no data-export feature; a
request to erase someone's data is handled by the operator by hand on the disk (**Pending**: no procedure or tool).

**What PayPal keeps is outside ResolveKit.** Evidence sent with provide-evidence (notes, tracking, files named
`E<n>-upload.png` (`.jpg` for a covered photo), `E<n>-upload.pdf` or `E<n>-pasted.pdf`) stays in PayPal's dispute record, and MeterMCP's orders,
authorizations and captures stay at PayPal. Deleting anything in ResolveKit does not remove it from PayPal.

## Merchant uploads, by state

| State | What exists | How it ends |
|---|---|---|
| `pending`, `reviewing` | Original file, renders/thumbnails (PDF), the read text, the record. Only people who can edit see files and text; others see `restricted: true` metadata | **Confirm as evidence**, **Discard**, or expiry: 24 h after upload it is discarded when next touched and by the hourly sweep |
| `confirmed` (`E<n>`) | The sanitised file (re-encoded PNG, or JPEG for a covered photo, or a rebuilt image-only PDF of covered pages), its lines and the record. The original and uncovered renders are dropped at confirm | **Delete** (owners and full members), or archive when the case moves to the next dispute. No time limit otherwise |
| `discarded` | Record (metadata) only: no file, no text | Kept |
| `deleted` | Record (metadata) only | Kept |
| `archived` | Record only (the case rotated to another dispute) | Kept. If the archive write failed, files and text stay and the upload remains `confirmed` for the old dispute (not retried: known issue) |

**Delete** of a confirmed upload is refused while a send that attaches or quotes it is in flight
(`409 SEND_IN_PROGRESS`). Otherwise it first removes everything that quotes it: stored analyses that read it (and their
jobs, progress and re-check verdicts) and the case's input pin; then it voids every unsent intent that attaches or was
composed with it, and records `upload_deleted` in the audit. If the purge fails, the upload is not deleted
(`500 PURGE_FAILED`, retry).

File names never leave the server: PayPal receives `E<n>-…` names; the model sees titles only.

## Other data on the `resolvekit` disk

| Data | Kept | Deleted by |
|---|---|---|
| Submission intents (`intents.json`, incl. the approved notes text) | Open: 30 min TTL. Failed send: retryable 30 min. Sent: 24 h. At most 2 000 stored | Expiry, replacement, cancel, invalidation (they leave the store at once; a bounded tombstone of 2 000 keeps the last state for error messages, in memory) |
| "Already sent for this dispute" marks | With `intents.json` | Not expired in code |
| Audit events (`audit-events.jsonl`) | 200 per session owner, 2 000 owners; compacted above 4 MiB | Eviction of the oldest per owner |
| Send audit log (`audit-events-sends.jsonl`) | **Append-only, never evicted, compacted or expired** (an audit record, by design) | Nothing |
| Agent run records (`agent-runs/`) | 30 days | Swept every 5 min after 30 days, **unless** kept (**Keep**, owner), unsettled (`open`, `capture_pending`, `failed`, `unverified` with a session), not yet saved, or its capture is bound to a case (active or reserve) |
| Analysis cache (`analysis-cache/`) | An analysis not written or read for 30 days, and 100 MiB in all (least recently used first); `ANALYSIS_CACHE_MAX_DAYS`, `ANALYSIS_CACHE_MAX_MB` | The sweep at start and hourly; an upload delete purges the analyses that quote that upload. Golden analyses ship with the code and are never swept |
| Analyst usage log (`analyst-usage.jsonl`, token counts and timings only) | 90 days, 10 MiB (oldest lines first); `ANALYST_USAGE_MAX_DAYS`, `ANALYST_USAGE_MAX_MB` | The same sweep |
| Input pins (`analysis-inputs.json`) | One per case (bounded by the cases) | Replaced as cases are analysed; an upload delete drops the case's pin |
| Re-check verdicts (`recheck-verdicts.json`: analysis key, SHA-256 of the edited text, verdict and citations) | 2 000 kept, on the disk (a restart keeps them); an intent keeps the verdicts it was composed with | Oldest dropped; upload delete |
| Reserve position (`reserve-position.json`: dispute ids per case) | Up to 200 per case | Not expired; entries that no longer match the bindings are ignored |
| Accounts (`accounts.json`: payer ids, display names, masked emails, passkey public keys, invite token hashes) | Not expired | **No deletion.** Revoking a member or invite marks it `revokedAt` and ends its sessions; the record stays. Owners cannot be revoked |
| Sessions (cookies) | 12 h | Expiry; **Sign out of all devices**; revocation; end of reviewer access |
| Sellers seen (`sellers.json`) | Not expired | Updated as bindings change |
| Daily caps files | One UTC day of counts | Replaced each day |
| In memory only (lost on restart) | PDF text hints (once per page per review, never stored or logged), webhook event ids (2 000), webhook notices (50), WebAuthn challenges (5 min), pending PayPal sign-ins (15 min) | Restart, or their own limits |

## MeterMCP disk

| Data | Kept | Deleted by |
|---|---|---|
| Ledger (`metermcp.sqlite`: sessions, calls with request/response hashes, settlements) | **Never expired** (the money record, by design) | Nothing |
| Daily budget count | One UTC day | Replaced each day |
| MCP transports | 15 min idle | The 30 s sweep closes them (and their payment session) |

## Logs

Both services log to standard output (on Render, the service log). Log lines carry ids, codes, counts, timings and
token counts; never document text, file contents, keys or tokens (the first request logs, masked, how the client
address was derived). Their retention is Render's, not set by the code.

## Erasing data by hand (operator)

There is no tool. If someone asks for their data to be removed, the operator would, with both services suspended (see
[Backup and recovery](backup-and-recovery.md#consistent-copies)): delete their uploads through the app first (so the
analyses that quote them are purged), then edit `accounts.json` by hand. Hand edits are untested and can break a
start (an unreadable `accounts.json` stops the service). The append-only send log and PayPal's own records are not
erasable this way. **Pending:** a supported procedure.
