[English](mcp-tools.md) | [Español](../es/technical/mcp-tools.md)

# MeterMCP: endpoints and MCP tools

> **Internal interface, not a stable public API.** MeterMCP is a demo gateway: its tools return **synthetic** data,
> and its routes and tool shapes change with the code. Public `/mcp` is open so that reviewers can try their own
> MCP clients against the sandbox.

`apps/metermcp` is a minimal metered MCP server. An MCP client calls paid tools; the user approves a budget once in
PayPal; MeterMCP charges only the calls that succeed and releases the rest. One seller (the PayPal sandbox app in its
environment), no marketplace, no payouts. Source: `apps/metermcp/src/` at commit `f1b7236`.

What is real and what is synthetic: the PayPal money flow (sandbox order, authorization, partial capture or void),
the ledger, the request and response hashes and the receipts are real records. The tools' outputs are deterministic
demo data and each result says `synthetic: true`.

## HTTP routes

| Method | Path | Exposure | Auth | Purpose |
|---|---|---|---|---|
| GET | `/healthz` | hosted, any Host | none | Render health check |
| GET | `/health` | public host | none | `{ok, paypal, mcpSessions, mcpRejected, mcpExpired}` |
| POST, GET, DELETE | `/mcp` | public | none; hosted: `x-demo-code` grants budget creation | MCP endpoint (Streamable HTTP, stateful, JSON responses) |
| GET | `/approved`, `/cancelled` | public | none (the order is re-read from PayPal; the query string proves nothing) | Buyer return pages; 303 to an allowed `return_to` once the budget is active |
| POST, GET, DELETE | `/agent/mcp` | **internal**: hosted only when not reached through the public proxy | `x-metermcp-token` (hosted) + `x-agent-run: run-<32 hex>` | ResolveKit's agent runs |
| GET | `/sessions?capture=<id>` | **internal** | admin token | The session whose PayPal capture is `<id>` |
| GET | `/sessions/:id/receipt.json`, `/sessions/:id/receipt.pdf` | **internal** | admin token | Receipt |
| POST | `/sessions/:id/close` | **internal** | admin token | Close and settle, or retry a failed settlement (409 while busy) |
| POST | `/sessions/:id/reconcile` | **internal** | admin token | Read a `PENDING` capture back from PayPal now |

Guards: local mode listens on `127.0.0.1` and requires Host `127.0.0.1:<port>` or `localhost:<port>`; any Origin
present must be in `METERMCP_ALLOWED_ORIGINS`; POST takes JSON only; HTTP body ≤ 256 KiB. Hosted: admin paths answer
404 when `X-Forwarded-For` is present or the Host is public, and need the admin token. `close_session` does not hand
MCP clients those routes: its answer says to call `get_receipt` (`receipt_tool: "get_receipt"`).

## Tools

| Tool | Kind | Price (USD per successful call) | Arguments | Offered to the agent's model |
|---|---|---|---|---|
| `quote_lookup` | paid | 0.05 | `symbol` (1–32) | yes |
| `deep_report` | paid | 0.40 | `topic` (1–200) | yes |
| `bulk_export` | paid | 0.92 | `dataset` (1–64), `rows` (1–1000, default 100) | yes |
| `price_list` | free | — | — | yes |
| `get_balance` | free | — | — (polling it also picks up the buyer's approval) | yes |
| `open_budget` | free (creates a PayPal order) | — | `cap` (e.g. `"2.50"`, within the cap range), `fail_first?` (≤ 3 paid tools), `return_to?` (≤ 2048, allowed origins only) | no: code only |
| `close_session` | free | — | — | no: code only |
| `get_receipt` | free | — | — | no: code only |

Prices appear in each paid tool's title, description and `_meta["metermcp/price"]`. Each paid result carries
`limits`, the things it does not contain (for example «Qualitative findings only: no row-level figures»), so a
caller can judge whether another tool is worth buying. `price_list`'s `free` field lists `price_list`,
`get_balance`, `close_session` and `get_receipt`; none of them is ever metered or charged.

Tool answers are MCP tool results whose text content is JSON; errors set `isError: true` with an `error` code:

| `error` | When |
|---|---|
| `payment_required` | Paid call without an active budget: includes the price, the budget proposal and an `approval_url` |
| `budget_exceeded` | Price above the remaining budget: refused before the tool runs (remaining, price, top-up hint) |
| `demo_code_required` | Hosted: creating a budget without a valid `x-demo-code` |
| `daily_cap`, `caps_unavailable` | Hosted daily budget cap reached, or its store unreadable |
| `invalid_cap`, `invalid_fail_first` | `open_budget` arguments out of range or format (`^\d{1,2}(\.\d{1,2})?$`) |
| `budget_exists` | A budget is already open (or closing, failed settlement, pending capture) for this MCP session |
| `payment_declined` | PayPal declined the funding source or the authorization; the session ends |
| `authorization_expired` | The authorization behind the session is missing or expired; no paid call can run; call `close_session` |
| `upstream_failed` | The tool failed (an injected failure included); released, never charged |
| `session_closed` | The payment session is closing, awaiting settlement or no longer active |
| `no_session` | This MCP session has no payment session yet (`get_receipt`, `close_session`) |
| `no_mcp_session` | The request did not use a stateful MCP session (`Mcp-Session-Id`) |
| `unknown_tool` | Not a paid tool (also when `fail_first` names one) |
| `price_unavailable` | The tool has no valid price; the call was not made |
| `paypal_unconfigured`, `paypal_unavailable`, `ledger_unavailable` | Infrastructure not available |

## Flow

1. A paid call without a budget answers `payment_required`, or the client calls `open_budget` with its own cap.
   MeterMCP creates a PayPal Orders v2 `AUTHORIZE` order for the cap: one `DIGITAL_GOODS` item, `custom_id` = the
   session id (`mm-sess-<32 hex>`), `NO_SHIPPING`, return and cancel URLs on MeterMCP.
2. The buyer approves in PayPal, logged in with a buyer (personal) account; in our 19/10/2026 sandbox run PayPal
   refused the seller's business account («Estás entrando en la cuenta del vendedor…» (PayPal's page was in Spanish; roughly «you are signing in to the seller's account»; recorded truncated)):
   observed, not documented. On the return page or a `get_balance` poll, MeterMCP re-reads the order, authorizes
   it and opens the session **only if** PayPal reports exactly one `CREATED` authorization for exactly the cap, for
   this session's order, with a future expiry (fail closed). `INSTRUMENT_DECLINED` or `DENIED` end the session;
   `PENDING` waits; an authorization that arrives late is voided, and so is any authorization not yet final
   (`PENDING`, or `CREATED` but refused by these checks) when the session is closed before it opened.
3. Each paid call reserves its price in one SQLite transaction before the tool runs; concurrent calls cannot both
   take the last of the budget. Success is charged (`OK`), failure released (`FAILED`). Each call records the
   `sha256` of canonical `{session, n, tool, args}` and of the response.
4. `close_session` (or the admin close, or idle timeout) captures exactly the sum of the OK calls with
   `final_capture: true` (`invoice_id <session>-settle`, `note_to_payer` ≤ 255 chars listing the calls), or voids
   the authorization when nothing was used. A failed settlement stays `settlement_failed` and is retried with the
   same `PayPal-Request-Id`. A capture PayPal answers `PENDING` makes the session `capture_pending`: the receipt
   says it is not a final charge, ResolveKit will not use it as evidence, and MeterMCP reads it back every 30 s, on
   demand and on close (`COMPLETED` → settled; `DECLINED`/`FAILED` → `capture_declined`).
5. The receipt (JSON and PDF) holds the mandate (order, authorization, cap, approval time), every call (time, tool,
   price, status, hashes, injected flag), totals, settlement and `receipt_sha256`.

Injected failures: per budget with `fail_first` (≤ 3 paid tools), or, for sessions opened from a
`payment_required` proposal only, with the local test switch `METERMCP_FAIL_FIRST`; a session opened by
`open_budget` follows only its own `fail_first` (none when empty), never the switch. The first call of each named
tool fails, is never charged and is marked injected in the result and the receipt.

## Limits

| Limit | Value |
|---|---|
| Budget cap range | 0.50–5.00 USD (`METERMCP_MIN_BUDGET`, `METERMCP_BUDGET`) |
| Live MCP sessions | 200 in all, 20 per client IP; 15 min idle → transport freed and payment session closed |
| `/agent/mcp` sessions | 10 in all, 10 per run; a session must be used by the run key that opened it (else 404) |
| Requests | `/mcp` 600 / 5 min per IP; `/agent/mcp` 600 / 5 min per run; wrong demo codes 5 / 15 min per IP |
| Budgets per day (hosted) | `DAILY_BUDGETS` (20), reserved atomically, refunded if no order was created |
| Payment session idle close | `METERMCP_IDLE_MINUTES` (15) |
| PayPal timeout | 30 s |

## Status

| Capability | Status |
|---|---|
| Public `/mcp` | Implemented · Tested locally · Verified in sandbox (scripted client, 09/10/2026) · Deployed. The CLI agent against hosted `/mcp`: Pending |
| Tools and prices through `/agent/mcp` | Implemented · Tested locally · Verified in sandbox (model-driven agent, 19/10/2026) · Deployed |
| Fail-closed approval check | Implemented · Tested locally |
| Partial capture with `final_capture`, release of the remainder | Implemented · Tested locally · Verified in sandbox (09/10, 19/10). That the remainder is released is observed in sandbox, not quoted from PayPal |
| Void of an unused authorization | Implemented · Tested locally · Verified in sandbox (08/10) |
| `capture_pending` / `capture_declined` | Implemented · Tested locally; not observed in sandbox: Pending |
| Admin routes, `/agent/mcp` | Implemented · Tested locally · Deployed |

Known gaps: `budget_exists` also blocks while a previous budget is closing, failed or pending. See [known issues](../quality/known-issues.md).
