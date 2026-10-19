[English](http-api.md) | [Español](../es/technical/http-api.md)

# HTTP API (apps/server)

> **Internal interface, not a stable public API.** These routes exist for ResolveKit's own web app, PayPal's webhook
> and the operator's scripts. They change with the code, without versioning or deprecation notice. Do not build on
> them.

Source: `apps/server/src/app.ts`, `hosted.ts`, `auth.ts`, `webhook.ts`, `uploads/routes.ts`, `agent/routes.ts` at
commit `fbe9621`. MeterMCP's routes are in [MCP tools](mcp-tools.md).

## Conventions

| Item | Rule |
|---|---|
| Base | Local `http://127.0.0.1:8787` (through the Vite proxy); hosted: the service's public origin, same origin as the web app |
| Bodies | `POST` takes `application/json` only (415 `UNSUPPORTED_MEDIA_TYPE`), except the upload route, which also takes raw `image/png`, `image/jpeg`, `application/pdf` with an `x-upload-name` header |
| Body size | 256 KiB default; 5 MiB image upload; 10 MiB PDF upload; at most 3 large bodies in flight, 30 s deadline |
| Errors | JSON `{ "error": "<CODE>", "detail": "<sentence>", … }`; some add `reasons`, `blockers`, `retryAfterSec`, `paypalIssue` |
| Rate limits | 429 `RATE_LIMITED` with `Retry-After`; daily caps 429 `DAILY_CAP`; caps store unreadable 503 `CAPS_UNAVAILABLE` |
| Caching | `cache-control: no-store` on API answers |
| Ids | Case `PP-R-TVH-10190665` is the standard demo case's id in the code; fictional examples: dispute `PP-D-EXAMPLE-0001`, run `run-<32 hex>`, upload `upl-<24 hex>`, invite `inv_…`, person `p_…` |

## Authentication

| Mode | How a request is authenticated |
|---|---|
| Local | Host must be `127.0.0.1:<port>` or `localhost:<port>` (403 `FORBIDDEN_HOST`); a present Origin must be allowed (403 `FORBIDDEN_ORIGIN`); header `x-resolvekit-token` with the per-launch token (401 `MISSING_OR_BAD_TOKEN`). The caller is the operator, an Owner; no caps |
| Hosted | Signed session cookie (see [trust boundaries](../architecture/trust-boundaries.md)); Host must be public (403); state-changing `/api` requests need the service's own Origin; per-IP limits; security headers |
| Ops | `Authorization: Bearer <RESOLVEKIT_OPS_TOKEN>`; without the variable, or with a wrong token, 404 |
| Webhook | Secret key in the path plus PayPal verification; no session |

**Seller gate (hosted).** Case routes answer only the seller's workspace for evaluation (bound) cases; anyone else
gets 404 `UNKNOWN_CASE` before any work. Unbound ids are demo cases and live only in the browser.

## Service and operations

| Method | Path | Mode | Auth | Answer | Main errors |
|---|---|---|---|---|---|
| GET, HEAD | `/healthz` | hosted | none | Render health check | 405 |
| GET | `/api/health` | both | none (bindings listed only for the seller's workspace) | `{paypal: "sandbox"\|"live"\|"unconfigured", error?, bound, bindings{status, reasons, checkedAt}, storage?}` (`storage`, only when a store file could not be read at start: the store names in local mode, `true` in hosted mode) | — |
| GET | `/api/demo` | both | none | hosted `{hosted:true, day, resetsAt, caps, reasons}`; local `{hosted:false}` | 405 |
| GET | `/api/ops/status[?probe=models]` | hosted | ops Bearer | PayPal state, webhook on/off, each binding verified on a fresh read (may rotate a used case), warm-up, caps, unreadable store files (`storage`, also in `problems`); with `probe=models` one tiny call per configured model | 404, 405, 429 |
| GET | `/api/ops/agent-run/<run-id>` | hosted | ops Bearer | Run record + receipt, for `demo:prepare --agent-run` | 400 `INVALID_RUN_ID`, 404 |
| GET | `/api/paypal/notices` | both | hosted: the disputes' seller only | Latest verified webhook notices (≤ 50) | 405 |
| POST | `/api/paypal/webhook/<key>` | hosted, with webhook env | key + PayPal verification | 200 (event acted on or ignored) | 404 wrong key, 405, 400 `BAD_TRANSMISSION`/`NOT_AN_EVENT`/`NOT_VERIFIED`, 408, 413, 429, 503 `BUSY`/`VERIFY_UNAVAILABLE` |
| GET | everything else | hosted | — | Built web app (unknown paths fall back to `index.html`; unknown files 404) | 404 |

## Accounts (hosted)

| Method | Path | Auth | Purpose | Main errors |
|---|---|---|---|---|
| GET | `/api/auth/me` | — | Session, sign-in methods, workspace connection (`evaluation`, `not_connected`, `checking`) | — |
| POST | `/api/auth/paypal/start` `{next?}` | — | `{approvalUrl}` and a pending sign-in cookie (it carries `next`, signed; an unsafe `next` is ignored) | 503 `PAYPAL_SIGNIN_OFF`, 502 `PAYPAL_UNAVAILABLE` |
| GET | `/api/auth/paypal/return/<k>?ba_token=…` | pending cookie + key | Sign in as Owner → 303 to `next` (a same-site path), else `/?signed-in=paypal` | 303 `/signin?error=session_mismatch\|not_approved\|paypal_unavailable\|full\|unavailable\|paypal_off` |
| GET | `/api/auth/paypal/cancel` | — | 303 `/signin?error=cancelled` | — |
| POST | `/api/auth/invite/inspect`, `/api/auth/invite/join` | invite token | Inspect an invite / join for this browser | 404 `INVITE_UNKNOWN`, 410 `INVITE_*`, 400 `INVALID_NAME`, 409, 503 `ACCOUNTS_UNAVAILABLE` |
| POST | `/api/auth/passkey/register/options`, `…/register/verify`, `/api/auth/passkey/login/options`, `…/login/verify` | invite (register) / passkey | WebAuthn | 400 `CHALLENGE_UNKNOWN`/`PASSKEY_REJECTED`, 401 `PASSKEY_UNKNOWN`, 403 `ACCESS_REVOKED`/`ACCESS_ENDED` |
| POST | `/api/auth/signout` `{everywhere?}` | session | Clear the cookie; `everywhere` ends every session | 503 |
| GET | `/api/workspace/members` | Owner | Members and invites | 401, 403 `OWNER_ONLY` |
| POST | `/api/workspace/invites` | Owner | Create an invite → `{invite, url: <origin>/join#<token>}` (shown once) | 400 `INVALID_LABEL\|USES\|TTL\|ACCESS_END`, 409 `TOO_MANY_INVITES` |
| POST | `/api/workspace/invites/<inv_…>/revoke`, `/api/workspace/members/<p_…>/revoke` | Owner | Revoke | 404 |

## Disputes, intents and evidence

| Method | Path | Auth / permission | Purpose | Main errors |
|---|---|---|---|---|
| GET | `/api/disputes/:case` | seller workspace; counts as a PayPal read | Fresh PayPal read, mapped (status, stage, reason, item type, allowed actions, requested evidence, evidence entries, due date); MeterMCP receipt for the agent case | 404 `UNKNOWN_CASE`/`NOT_BOUND`, 503 `PAYPAL_UNCONFIGURED`, 422/502/504 from PayPal |
| POST | `/api/disputes/:case/intent` | signed-in (hosted) | Compose a submission intent → 201. Body: `{evidenceType, edits?, resolutions?, confirmedCorrections?, attachments?}`; any other field (notes, files, tracking) is refused | 400 `INVALID_INTENT_REQUEST`, 401, 403 `NOT_THE_SELLER`, 409 `BINDING_UNAVAILABLE`/`BINDING_INVALID`/`NO_ANALYSIS`/`RECEIPT_NOT_FINAL`/`UPLOAD_CHANGED`, 422 `DRAFT_BLOCKED`/`EDIT_NOT_VERIFIED`/`UNKNOWN_UPLOAD`/`ATTACHMENTS_TOO_LARGE`, 429 `TOO_MANY_INTENTS` |
| GET | `/api/disputes/:case/intent/:id` | the intent's owner | Read the intent | 404 `UNKNOWN_INTENT` |
| POST | `/api/disputes/:case/intent/:id/approve` `{contentHash}` | the intent's owner | Approve that exact content | 400 `INVALID_APPROVAL`, 409 `CONTENT_HASH_MISMATCH`/`INTENT_<STATUS>` |
| POST | `/api/disputes/:case/intent/:id/cancel` | the intent's owner | Cancel | 409 |
| POST | `/api/disputes/:case/evidence` `{intentId}` | the intent's owner; one `evidence` cap unit | Send the approved intent → 202 `{sent:true}` | 400 `INVALID_SUBMISSION`, 404 `UNKNOWN_INTENT`, 409 `BINDING_CHANGED`/`DOCUMENTS_CHANGED`/`INTENT_STALE`/`UPLOAD_CHANGED`/`SELLER_EVIDENCE_EXISTS`/`DISPUTE_BUSY`/`NOT_BOUND`, 503 `AUDIT_UNAVAILABLE`, 422/502/504 from PayPal (with `paypalIssue`, e.g. `EVIDENCE_TYPE_IS_NOT_ALLOWED`) |
| GET | `/api/disputes/:case/audit` | hosted: the workspace's trail; local: the whole case | Audit events: intents composed, approvals (who, when, hash), sends (`PayPal-Request-Id`, PayPal's answer), refusals, notifications | 405 |

The send never reports "recorded". `202 {sent:true}` means PayPal accepted the request; the web app then reads the
dispute back and shows **Recorded by PayPal** only for new `SUBMITTED_BY_SELLER` evidence that matches what was
sent. Accepted ≠ recorded ≠ dispute resolved.

## Analysis

| Method | Path | Auth / permission | Purpose | Main errors |
|---|---|---|---|---|
| POST | `/api/cases/:id/analysis[?refresh=1]` | seller workspace (hosted); a live run takes a `live-analysis` unit | `{}` → stored analysis `200`, or live run `202` with `input` and `key`; `refresh=1` forces a live run | 404 `UNKNOWN_CASE`, 503 `ANALYST_UNAVAILABLE`/`ANALYST_UNCONFIGURED`, 429 `RATE_LIMITED`/`DAILY_CAP`, 409 `UPLOAD_CHANGED` |
| GET | `/api/cases/:id/analysis/progress?key=<64 hex>` | as above | Stages done so far, then the result | 400 `INVALID_KEY` |
| POST | `/api/cases/:id/analysis/verify` `{text}` | as above; a `recheck` unit | Re-check an edited sentence (1–600 chars, no line breaks or control characters) → verdict and citations | 400 `INVALID_TEXT`, 429, 502 `ANALYST_FAILED` |

## Uploads

Paths below are under `/api/cases/:id/uploads`. "Editors" = the uploader, Owners and full members (a reviewer edits
only their own uploads). Details: [evidence processing](evidence-processing.md).

| Method | Path | Permission | Purpose | Main errors |
|---|---|---|---|---|
| POST | `` (the collection) | signed-in person of the seller workspace; an `upload` unit | Add: raw PNG/JPEG/PDF with `x-upload-name`, or JSON `{text, name}` | 401 `SIGN_IN_REQUIRED`, 404, 409 `TOO_MANY_UPLOADS`, 413 `TOO_LARGE`/`TOO_LONG`, 415, 422 `TEXT_UNSUPPORTED`/`UNREADABLE`, 503 `PDF_READER_UNAVAILABLE`, 507 `STORAGE_FULL` |
| GET | `` (the collection) | workspace | List; uploads not yet confirmed appear as `restricted: true` to non-editors | — |
| GET | `/:u/image?v=original\|sanitised` | editors until confirmed | Image bytes | 404 |
| POST | `/:u/select` `{pages}` | editors | Choose 1–5 pages of a longer PDF (once) | 400 `BAD_SELECTION`, 409 `WRONG_STATUS`/`JOB_FAILED`/`UPLOAD_CHANGED` |
| GET | `/:u/page/:k?v=`, `/:u/page/:k/hint`, `/:u/thumb/:n` | editors | Page image, text-layer hint (review only, counted as a PayPal read), thumbnail | 400 `BAD_PAGE`, 404, 422/503 (hint) |
| POST | `/:u/redact` | editors | Add covers and re-read | 400 `BAD_REDACTION`, 403, 409 `TOO_MANY_REDACTS`/`UPLOAD_ARCHIVED`/`WRONG_STATUS`, 413 |
| POST | `/:u/confirm` | editors | Confirm the reviewed sanitised file (bound to its `sha256`) → becomes `E<n>` | 400 `BAD_CONFIRMATION`/`BAD_LINES`, 409 `UPLOAD_CHANGED`/`WRONG_STATUS`, 422 `BAD_TRANSCRIPTION`, 413 |
| POST | `/:u/discard` | editors | Discard a pending upload | 409 |
| DELETE | `/:u` | Owners and full members | Delete; purges analyses that quoted it; voids unsent intents | 403, 409 `SEND_IN_PROGRESS`, 500 `PURGE_FAILED` |

## Agent runs

| Method | Path | Permission | Purpose | Main errors |
|---|---|---|---|---|
| POST | `/api/agent/runs` `{goal, cap, failFirst?}` | signed-in (local: operator); hosted: seller workspace, `agent-run` daily and per-person units | Start a run in the background → 201 `{run}`. `goal` 1–300 chars; `cap` `"0.50"`–`"5.00"`; `failFirst` ≤ 3 tool names | 400 `INVALID_GOAL`/`INVALID_CAP`/`INVALID_FAIL_FIRST`/`INVALID_SCOPE` (a run is started for yourself), 401, 403 `SELLER_WORKSPACE_ONLY`, 409 `RUN_IN_PROGRESS`, 429 `DAILY_CAP`/`PERSON_CAP`, 503 `BUSY`/`MODEL_UNAVAILABLE`/`STORAGE`/`STOPPING`/`AGENT_UNAVAILABLE`/`CAPS_UNAVAILABLE` |
| GET | `/api/agent/runs[?scope=workspace]` | author; Owner with scope | List own runs, newest first; the workspace's runs for the Owner | 400 `INVALID_SCOPE`, 403 `OWNER_ONLY` |
| GET | `/api/agent/runs/:id[?scope=workspace]` | author; Owner with scope (logged) | One run. The approval link, order and session ids are shown to the author only | 404 for any run the caller may not see |
| POST | `/api/agent/runs/:id/stop` | author; Owner with scope | Abort → 202; the run ends `interrupted` and settles | 409 `NOT_RUNNING` |
| POST | `/api/agent/runs/:id/keep` `{kept}` | Owner | Exempt from the 30-day sweep | 400 `INVALID_KEPT`, 403, 503 |

Details: [buying agent](buying-agent.md).
