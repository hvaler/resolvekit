[English](configuration.md) | [Español](../es/technical/configuration.md)

# Configuration

Every environment variable the code reads, from `apps/server/src/main.ts`, `apps/metermcp/src/main.ts`,
`packages/*` and the scripts at commit `fbe9621`. A template with safe placeholders is in
[`.env.example`](../../.env.example). The server and MeterMCP load the repository-root `.env` with
`node --env-file-if-exists`; on Render the values come from the service settings and `render.yaml`.

Legend: **R** required, **O** optional; **Secret** = never commit, never log. "Hosted" means
`RESOLVEKIT_MODE=hosted` (server) or `METERMCP_MODE=hosted` (MeterMCP).

## ResolveKit server (`apps/server`)

### Mode, network and storage

| Variable | R/O | Secret | Default | Effect |
|---|---|---|---|---|
| `RESOLVEKIT_MODE` | O | — | local | `hosted`: public mode (0.0.0.0, sign-in, caps, static site) |
| `PORT` | O | — | 10000 hosted, 8787 local | Listen port (Render sets it) |
| `RENDER_EXTERNAL_URL` | R hosted | — | — | Public origin; start fails if missing or not `https` (except `localhost`) |
| `RESOLVEKIT_CUSTOM_DOMAINS` | O | — | — | Extra public origins (comma list, https) |
| `RESOLVEKIT_PUBLIC_URL` | O | — | `RENDER_EXTERNAL_URL` | Where PayPal returns a run's buyer: `<url>/agent?run=<id>`; neither set → MeterMCP's own approval page |
| `RESOLVEKIT_DATA_DIR` | O | — | `apps/server/data/` | Data directory (Render: `/var/data`) |
| `RESOLVEKIT_WEB_DIST` | O | — | `apps/web/dist/` | Built web app; hosted start fails without its `index.html` |
| `RESOLVEKIT_TOKEN_FILE` | O, local | — | `apps/server/.runtime-token` | Where the per-launch API token is written (also read by the Vite proxy) |
| `RESOLVEKIT_ALLOWED_ORIGINS` | O, local | — | `http://localhost:5173`, `http://127.0.0.1:5173`, `:4173` variants | Local Origin allowlist (comma list) |
| `TRUSTED_PROXY_HOPS` | O | — | 1 (Render blueprint: 2) | `X-Forwarded-For` entries to walk back |
| `TRUSTED_PROXY_PEERS` | O | — | `private` | `private`, `any` or `none`: which peers may set `X-Forwarded-For` |
| `ANALYSIS_CACHE_MAX_DAYS`, `ANALYSIS_CACHE_MAX_MB` | O | — | 30 / 100 | Analysis cache retention: an analysis not written or read for this many days is removed, and past this size the least recently used go first (swept at start and hourly; golden analyses never) |
| `ANALYST_USAGE_MAX_DAYS`, `ANALYST_USAGE_MAX_MB` | O | — | 90 / 10 | `analyst-usage.jsonl` retention: lines older than this many days are dropped, then the oldest until it fits this size. The audit and send logs have no such setting: they never expire |

### PayPal

| Variable | R/O | Secret | Default | Effect |
|---|---|---|---|---|
| `PAYPAL_ENV` | R hosted | — | sandbox (local) | Hosted: must be `sandbox`, or `live` with the opt-in below, else the service refuses to start. Local: `live` only if set so |
| `RESOLVEKIT_ALLOW_LIVE_PAYPAL` | O | — | — | Must be `yes-real-money` for hosted `live`. Never set in `render.yaml`. Nothing has run against live PayPal |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | O | **Secret** | — | The seller's sandbox app: dispute reads, evidence, webhook verification. Absent → PayPal "unconfigured", every case on the simulator |
| `PAYPAL_IDENTITY_CLIENT_ID`, `PAYPAL_IDENTITY_CLIENT_SECRET` | O hosted | **Secret** | — | The platform's identity app (another sandbox business account) for **Continue with PayPal**. Must differ from `PAYPAL_CLIENT_ID` (start fails). Absent → PayPal sign-in off; invites still work |
| `PAYPAL_WEBHOOK_ID` | O hosted | — | — | Id of the `CUSTOMER.DISPUTE.*` webhook registered on the seller's app; must match `^[A-Z0-9]{10,40}$` |
| `PAYPAL_WEBHOOK_KEY` | R with the id | **Secret** | — | 32–128 URL-safe characters: the secret last segment of `/api/paypal/webhook/<key>`. Without id and key the route does not exist |

### Bindings

| Variable | R/O | Secret | Default | Effect |
|---|---|---|---|---|
| `BINDINGS_JSON` | O hosted | sensitive | — | Case → `{dispute, capture[, session, run]}` (or a list: reserve, first active). Wins over the file in hosted mode; bad JSON stops the start |
| `RESOLVEKIT_BINDINGS` | O | — | hosted `<data>/bindings.json`, local `apps/server/bindings.json` | Bindings file; hosted without `BINDINGS_JSON` it is re-read every 30 s |

### Accounts and operations

| Variable | R/O | Secret | Default | Effect |
|---|---|---|---|---|
| `RESOLVEKIT_SESSION_SECRET` | O hosted | **Secret** | random per launch (warning if < 32 chars) | HMAC key of session and sign-in cookies; without it sign-ins end on restart (Render generates it) |
| `RESOLVEKIT_OPS_TOKEN` | O hosted | **Secret** | — | 32–128 URL-safe characters; enables `/api/ops/*` (Bearer). Also read by `demo:check` and `demo:prepare --agent-run` |

### MeterMCP link

| Variable | R/O | Secret | Default | Effect |
|---|---|---|---|---|
| `METERMCP_URL` | O | — | `http://127.0.0.1:8790` | MeterMCP base; a bare `host:port` gets `http://` (Render passes the private `hostport`) |
| `METERMCP_ADMIN_TOKEN` | R hosted for the agent and receipts | **Secret** | — | MeterMCP's admin token; missing → warning, agent runs stop `meter_unavailable`, receipts fail |
| `METERMCP_TOKEN_FILE` | O, local | — | `apps/metermcp/.runtime-token` | Local admin token file written by MeterMCP |

### Models (analyst and agent)

| Variable | R/O | Secret | Default | Effect |
|---|---|---|---|---|
| `GEMINI_API_KEY` | O | **Secret** | — | Gemini for the analyst and the agent |
| `GROQ_API_KEY` | O | **Secret** | — | Groq for the analyst and the agent. With no key at all: stored analyses only, agent `MODEL_UNAVAILABLE` |
| `ANALYST_PROVIDER` | O | — | `gemini` | `gemini` or `groq`: the **primary** for both the analyst and the agent; the other provider, if its key is set, is the fallback |
| `GEMINI_MODEL`, `GROQ_MODEL` | O | — | `gemini-3.8-flash`, `openai/gpt-oss-120b` | Analyst model ids (a different id changes the cache key) |
| `AGENT_GEMINI_MODEL`, `AGENT_GROQ_MODEL` | O | — | same constants | Agent model ids |
| `GROQ_TPM` | O | — | 8000 | Groq tokens per minute; a request (prompt + max output) must fit |
| `LIVE_ANALYSES_PER_HOUR` | O | — | 6 | Server-wide hourly limit of live analyses |
| `RECHECKS_PER_HOUR` | O | — | 30 | Server-wide hourly limit of sentence re-checks |

### Daily caps (hosted, per UTC day, persisted)

| Variable | Default | Counts |
|---|---|---|
| `DAILY_LIVE_ANALYSES` | 60 | Live analyses, warm-ups included |
| `DAILY_RECHECKS` | 200 | Sentence re-checks |
| `DAILY_EVIDENCE_SENDS` | 20 | Evidence sends to PayPal |
| `DAILY_UPLOADS` | 40 | Uploads (not in `render.yaml`: the default applies) |
| `DAILY_AGENT_RUNS` | 20 | Agent runs started (plus 5 per person per day, not configurable) |

### Agent run limits (both modes)

A missing or malformed value (not a positive integer) keeps the default.

| Variable | Default | Limit |
|---|---|---|
| `AGENT_MAX_ACTIONS` | 8 | Actions per run |
| `AGENT_MAX_MS` | 180000 | Agent time, not counting the wait for PayPal approval |
| `AGENT_APPROVAL_TIMEOUT_MS` | 900000 | Wait for the buyer's approval |
| `AGENT_MAX_MODEL_CALLS` | 12 | Model calls per run |
| `AGENT_MAX_INPUT_TOKENS` | 8000 | Estimated input tokens per call |
| `AGENT_MAX_OUTPUT_TOKENS` | 1024 | Requested output tokens per call |
| `AGENT_RUN_TOKEN_BUDGET` | 60000 | Input + output tokens per run, every attempt counted |

## MeterMCP (`apps/metermcp`)

| Variable | R/O | Secret | Default | Effect |
|---|---|---|---|---|
| `METERMCP_MODE` | O | — | local | `hosted`: 0.0.0.0, demo code, daily budgets |
| `PORT` (hosted) / `METERMCP_PORT` (local) | O | — | 10000 / 8790 | Listen port |
| `METERMCP_PUBLIC_URL` | O | — | hosted `RENDER_EXTERNAL_URL`; local `http://127.0.0.1:<port>` | Return/cancel URLs of the budget order; must be `https` hosted (except `localhost`). Wins over `RENDER_EXTERNAL_URL` |
| `RENDER_EXTERNAL_URL` | hosted | — | — | Fallback public URL |
| `METERMCP_CUSTOM_DOMAINS` | O | — | — | Extra public hosts |
| `PAYPAL_ENV`, `RESOLVEKIT_ALLOW_LIVE_PAYPAL` | as the server | — | | Same guard |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | O | **Secret** | — | The seller app MeterMCP charges into; absent → `paypal_unconfigured` |
| `METERMCP_ADMIN_TOKEN` | R hosted (≥ 32 chars) | **Secret** | local: random per launch, written to the token file | Admin routes and `/agent/mcp` |
| `METERMCP_TOKEN_FILE` | O, local | — | `apps/metermcp/.runtime-token` | |
| `DEMO_CODE` | O hosted | **Secret** | — | Value MCP clients send in `x-demo-code` to create a budget; absent → no budget can be created. No minimum length is enforced (≤ 200 chars) |
| `METERMCP_BUDGET`, `METERMCP_MIN_BUDGET` | O | — | 5.00 / 0.50 | Largest and smallest budget cap; min above max (or an amount that is not money) stops the start |
| `METERMCP_RETURN_ORIGINS` | O | — | none | Origins an `open_budget` `return_to` may point at (comma list); invalid stops the start. On Render: ResolveKit's public origin, set by hand |
| `METERMCP_IDLE_MINUTES` | O | — | 15 | Idle payment-session close |
| `METERMCP_FAIL_FIRST` | O (test switch) | — | none | Comma list of tools whose first call per `payment_required` session fails (never charged, marked injected). Must be absent on the hosted service |
| `METERMCP_DATA_DIR`, `METERMCP_DB` | O | — | `apps/metermcp/data/`, `<data>/metermcp.sqlite` | Ledger location |
| `METERMCP_ALLOWED_ORIGINS` | O | — | none | Browser Origins allowed (comma list) |
| `DAILY_BUDGETS` | O hosted | — | 20 | Budgets created per UTC day |
| `TRUSTED_PROXY_HOPS`, `TRUSTED_PROXY_PEERS` | O | — | 1 / `private` | As the server |

## Web build (`apps/web`)

| Variable | Read by | Effect |
|---|---|---|
| `RESOLVEKIT_API` | `vite.config.ts` | Proxy target for `/api` (default `http://127.0.0.1:8787`) |
| `RESOLVEKIT_TOKEN_FILE` | `vite.config.ts` | Token the proxy injects (default `apps/server/.runtime-token`) |
| `import.meta.env.DEV` | Vite | Dev controls |

No `VITE_*` variable is read: nothing from the environment is bundled.

## Scripts

| Script | Variables |
|---|---|
| `demo:check` | `RESOLVEKIT_OPS_TOKEN` (R; exit 2 without it) |
| `demo:prepare` | `PAYPAL_CLIENT_ID/SECRET` (R), `PAYPAL_ENV` (must be sandbox), `RESOLVEKIT_DATA_DIR`, `METERMCP_DEMO_CODE` (R with `--agent` against the hosted MeterMCP), `BINDINGS_JSON` (R with `--agent-run`), `RESOLVEKIT_OPS_TOKEN` (R with `--agent-run` hosted), `METERMCP_TOKEN_FILE` (local), model keys, `ANALYST_PROVIDER` and `AGENT_*` (with `--agent`) |
| `demo-agent` | `METERMCP_URL` (here the **public MCP endpoint**, default `http://127.0.0.1:8790/mcp`; `http://` and `/mcp` added when missing), `METERMCP_DEMO_CODE`, model keys, `ANALYST_PROVIDER`, `AGENT_*` |
| `evals`, `evals:heldout` | `GEMINI_API_KEY`, `GROQ_API_KEY`, `GROQ_TPM` |
| `golden` | Analyst variables (`modelFromEnv`) |

Two names to watch: `METERMCP_URL` is MeterMCP's base for the server (its private `/agent/mcp` and admin routes) but
the public MCP endpoint for `demo-agent`, which adds `http://` and `/mcp` when they are missing. Both read the same
root `.env`, so a value set there for the server also points `demo-agent` at that MeterMCP: override it on the
command line when they differ.
`DEMO_CODE` (MeterMCP) and `METERMCP_DEMO_CODE` (scripts) carry the same value under two names.

## `render.yaml` values

Set in the blueprint: `NODE_VERSION=24.19.0`; server `RESOLVEKIT_MODE=hosted`, `RESOLVEKIT_DATA_DIR=/var/data`,
`PAYPAL_ENV=sandbox`, `DAILY_LIVE_ANALYSES=60`, `DAILY_RECHECKS=200`, `DAILY_EVIDENCE_SENDS=20`,
`DAILY_AGENT_RUNS=20`, the seven `AGENT_*` defaults, `TRUSTED_PROXY_HOPS=2`, `RESOLVEKIT_SESSION_SECRET` generated,
`METERMCP_URL` and `METERMCP_ADMIN_TOKEN` from the MeterMCP service; MeterMCP `METERMCP_MODE=hosted`,
`METERMCP_DATA_DIR=/var/data`, `PAYPAL_ENV=sandbox`, `METERMCP_BUDGET=5.00`, `METERMCP_MIN_BUDGET=0.50`,
`DAILY_BUDGETS=20`, `TRUSTED_PROXY_HOPS=2`, `METERMCP_ADMIN_TOKEN` generated. Entered by hand (`sync: false`): PayPal
credentials (both services), identity app, webhook id and key, `BINDINGS_JSON`, `RESOLVEKIT_OPS_TOKEN`, model keys,
`DEMO_CODE`, `METERMCP_RETURN_ORIGINS`. Not in the blueprint (defaults apply; listed there as YAML comments with their
defaults): `DAILY_UPLOADS`, `RESOLVEKIT_PUBLIC_URL`, `RESOLVEKIT_CUSTOM_DOMAINS`, `RESOLVEKIT_BINDINGS`,
`TRUSTED_PROXY_PEERS`, the model choices (`ANALYST_PROVIDER`, `GEMINI_MODEL`, `GROQ_MODEL`, `AGENT_*_MODEL`,
`GROQ_TPM`), `LIVE_ANALYSES_PER_HOUR`, `RECHECKS_PER_HOUR`, the retention settings (`ANALYSIS_CACHE_MAX_*`,
`ANALYST_USAGE_MAX_*`); MeterMCP `METERMCP_PUBLIC_URL`, `METERMCP_CUSTOM_DOMAINS`, `METERMCP_IDLE_MINUTES`,
`METERMCP_ALLOWED_ORIGINS`, `METERMCP_DB`, `TRUSTED_PROXY_PEERS`. Procedure: [deployment](../operations/deployment.md).
