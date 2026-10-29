[English](local-development.md) | [Español](../es/technical/local-development.md)

# Local development

How to install, run and test ResolveKit on your machine, and which commands reach PayPal, the model providers or
cost money. Code at commit `c12faea`.

## Requirements

| Item | Version | Notes |
|---|---|---|
| Node.js | `>=24` (root `package.json` `engines`); Render and the last full test run use 24.19.0 | TypeScript runs natively in Node (type stripping): no build step for the server, MeterMCP or packages |
| npm | the one shipped with Node 24 | npm workspaces (`packages/*`, `apps/*`) |
| OS | Windows, macOS, Linux | `@napi-rs/canvas` installs a prebuilt native binary per platform. The PDF child's memory kill works on Linux only. The full suite was last run on Windows (19/10/2026); Linux test runs: Pending |
| PayPal sandbox app | optional | developer.paypal.com → Apps & Credentials → Sandbox. Without it every case runs on the simulator |
| Gemini / Groq key | optional | Without a key the committed golden analyses of the demo cases still work; live analysis and the agent are off |

Pinned dependency versions are in each `package.json` (for example React 18.3.1, Vite 8.3.4, Vitest 5.0.5,
AG Grid 33.3.2, `@modelcontextprotocol/sdk` 1.32.1, `pdfjs-dist` 6.4.299, `tesseract.js` 7.0.0).

## Install

```bash
git clone <repository URL> resolvekit && cd resolvekit
cp .env.example .env      # fill in only what you need; .env is git-ignored
npm install
npm test                  # no network: fake PayPal and fake models
```

Every variable is described in [configuration](configuration.md) and in [`.env.example`](../../.env.example).

## Run

### Web app only (simulator)

```bash
npm run dev               # http://localhost:5173
```

Without the server, every case runs on the in-browser simulator with the golden analyses. In development a small
**Dev · simulator** control (bottom left, hidden on cases running on real PayPal) picks what the simulated PayPal
does after a submission (*Waiting for buyer*, *Under review*, *Timeout*), can open the new dispute now, or simulate
PayPal being unreachable. In other builds add `?dev` to the URL, or `?outcome=under_review|timeout`. `?record` turns
on **Recording mode** (slower analysis replay, Dev control hidden); `?record=0` turns it off.

### Server with real sandbox disputes

```bash
cp apps/server/bindings.example.json apps/server/bindings.json   # { "<case id>": { "dispute": "PP-D-EXAMPLE-0001", "capture": "<capture id>" } }
npm run server            # http://127.0.0.1:8787, loads ../../.env
npm run dev               # or: npm run build && npm run preview  (port 4173)
```

The Vite dev and preview servers proxy `/api` to `RESOLVEKIT_API` (default `http://127.0.0.1:8787`) and add the
per-launch token from `apps/server/.runtime-token` server-side; cross-site requests are refused before the token is
added. A case uses real PayPal only when it is bound in `bindings.json` **and** `/api/health` reports PayPal
connected; the app bar then says **PayPal sandbox · live** followed by the dispute id. «live» here means a live read
of a **sandbox** dispute, not the live PayPal environment.

At start the server reads and verifies each bound dispute once (PayPal sandbox calls). Local mode has no sign-in:
you are the operator and act as an Owner.

### MeterMCP and the agent

```bash
npm run metermcp          # http://127.0.0.1:8790/mcp; writes apps/metermcp/.runtime-token
npm run demo-agent -- --goal "Quote for ACME-42" --cap 2.00 [--fail-first deep_report] [--no-wait] [--out run.json]
```

The `/agent` page of the local server connects to MeterMCP's `/agent/mcp` on `METERMCP_URL` (default
`http://127.0.0.1:8790`). Local-mode `/agent/mcp` has no automated test (follow-up). `--no-wait` stops after
printing the approval URL and closes the session, so nothing stays authorized.

### Rehearse hosted mode locally

Build the web app, then start both services in hosted mode with stand-in Render variables. `localhost` may be
`http`; any other public origin must be `https`.

```bash
npm run build
# MeterMCP
METERMCP_MODE=hosted PORT=10001 RENDER_EXTERNAL_URL=http://localhost:10001 \
  METERMCP_ADMIN_TOKEN=<32+ random characters> METERMCP_DATA_DIR=<dir> DEMO_CODE=<code> \
  node --env-file-if-exists=.env apps/metermcp/src/main.ts
# Server
RESOLVEKIT_MODE=hosted PORT=10000 RENDER_EXTERNAL_URL=http://localhost:10000 RESOLVEKIT_DATA_DIR=<dir> \
  METERMCP_URL=127.0.0.1:10001 METERMCP_ADMIN_TOKEN=<same token> BINDINGS_JSON='<json>' \
  node --env-file-if-exists=.env apps/server/src/main.ts
```

`DEMO_CODE` is read by MeterMCP only; the server never reads it. Hosted mode needs `PAYPAL_ENV=sandbox`.

## Scripts

All from the repository root.

| Script | What it does | Network / cost |
|---|---|---|
| `npm test` | Every workspace suite (`node --test`; Vitest for the web) | None (fakes) |
| `npm run test:<paypal\|hosting\|cases\|analyst\|agent\|server\|metermcp\|web>` | One workspace | None |
| `npm run typecheck` | `tsc --noEmit` for seven workspaces | None |
| `npm run dev` / `build` / `preview` | Vite dev server / type-check and build `apps/web/dist` / preview | None |
| `npm run server` | ResolveKit server (local unless `RESOLVEKIT_MODE=hosted`) | PayPal sandbox reads at start when credentials and bindings exist; live analyses use model quota; hosted mode also warms up bound cases (model calls) |
| `npm run metermcp` | MeterMCP | PayPal sandbox orders and authorizations when budgets are used |
| `npm run evals -- --provider gemini\|groq` | Analyst evaluation on the dev set, one provider; `--metrics-only`, `--recompute` without a model | **Paid** Gemini calls; Groq free-tier quota |
| `npm run evals:heldout` | Held-out repeated runs; refuses unless frozen files match; Gemini spend guard | **Paid** Gemini; Groq quota |
| `npm run evals:recompute` | Rescore stored results into `summary.json` / `summary.md` | None |
| `npm run golden` | Run the analyst on the demo cases, write the cache or `packages/analyst/golden/` | **Paid** model calls |
| `npm run demo:prepare` | Create fresh sandbox payments and disputes for the evaluation cases; `--dry-run` checks the OAuth credentials only | PayPal **sandbox** only (refuses another `PAYPAL_ENV`; no real money); model calls and a MeterMCP budget with `--agent` |
| `npm run demo:check` | Checks the hosted demo: `/healthz`, landing page, MeterMCP `/healthz`, `GET /api/ops/status?probe=models` | One tiny call **per configured model** unless `--no-models`; the server's PayPal reads of bound disputes can rotate a used case to its next reserve dispute and trigger a live re-analysis |
| `npm run demo-agent` | CLI buying agent against MeterMCP `/mcp` | Model calls and a PayPal sandbox budget |

`demo:check` needs `RESOLVEKIT_OPS_TOKEN` (exit 2 without it) and sends it only over https or to localhost. Its
defaults are `https://resolvekit-i3j2.onrender.com` and `https://resolvekit-metermcp.onrender.com` (`--app`,
`--metermcp` to change them). Exit 0 only when every line passed. "Read-only" is true for what the script sends,
not strictly for server state.

`demo:prepare` flags (see `USAGE` in `apps/server/scripts/demo-prepare-lib.ts`): `--standard [--count N]`,
`--agent [--agent-count N]` with `--agent-goal`, `--agent-cap`, `--agent-fail-first`, `--metermcp URL`;
`--agent-run <run id>` (read a finished `/agent` run, never run or paid again); `--wait-disputes --captures …`;
`--approval-minutes`, `--dispute-minutes`; `--seller <merchant id>`. It prints the `BINDINGS_JSON` to paste.
Operational use: [runbook](../operations/runbook.md).

## Tests

Last full run: 29/10/2026, commit `be7491d` (branch `fix/pre-submission`), Node 24, Windows: 1,488 tests, all passed (node:test 1,017 + vitest 471); typecheck clean, web build OK (21/10/2026, `c12faea`: 1,479; 21/10/2026, `81c6242`: 1,479; 20/10/2026, `5111b88`: 1,453). Source: the run
log kept with the documentation work.

| Suite | Tests | Result |
|---|---|---|
| `test:paypal` | 36 | pass |
| `test:hosting` | 32 | pass |
| `test:cases` | 12 | pass |
| `test:analyst` | 159 | pass |
| `test:agent` | 52 | pass |
| `test:server` | 635 | pass |
| `test:metermcp` | 80 | pass |
| `test:web` | 447 | pass |
| `typecheck` | — | pass |

The previous full run (19/10/2026 12:35 UTC, commit `fbe9621`, Node 24.19.0, Windows) counted 1,131 tests with one
failure (`uploads-pdf-recovery.test.ts`, «size: five dense A4 pages…»), 429 `RATE_LIMITED` under full-suite load; run
alone it passed twice. It is intermittent and did not recur on 20/10/2026. Testing practices: [testing](../quality/testing.md).
