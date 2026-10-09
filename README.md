# ResolveKit

**Evidence-first PayPal dispute workspace for small merchants.** For each PayPal dispute, ResolveKit builds a
case file (timeline + evidence), an AI analyst drafts a response in which every sentence cites its evidence,
unsupported sentences are rejected, and the merchant approves before anything is sent to PayPal. After sending,
ResolveKit re-reads the dispute and shows what PayPal actually recorded.

> Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) (October–November 2026).
> **Status: early development.** This README grows with the project.

## How PayPal is used

ResolveKit runs on the PayPal **Customer Disputes API (v1)** against the free sandbox:

| Capability | Endpoint | Why |
|---|---|---|
| Find the dispute for a payment | `GET /v1/customer/disputes?disputed_transaction_id={capture}` | Link the dispute to the order and its evidence |
| Read the dispute | `GET /v1/customer/disputes/{id}` | Reason, stage, status, **evidence PayPal requests from the seller**, allowed actions |
| Submit evidence | `POST /v1/customer/disputes/{id}/provide-evidence` (multipart: JSON + files) | Send the approved response with its documents |
| Message the buyer | `POST /v1/customer/disputes/{id}/send-message` | Answer in the inquiry stage |
| Accept the claim | `POST /v1/customer/disputes/{id}/accept-claim` | When the evidence does not support a defence |
| Refunds | `POST /v2/payments/captures/{id}/refund` | Partial or full refunds |

Every behaviour above was verified in the sandbox before building on it. See
[`docs/sandbox-findings.md`](docs/sandbox-findings.md).

The browser never talks to PayPal. `apps/server` (Node 24, no framework) holds the credentials and uses the typed
client in `packages/paypal`:

| Route | What it does |
|---|---|
| `GET /api/health` | `{ paypal: "sandbox" \| "live" \| "unconfigured", bound: [case ids] }` after a lazy OAuth check |
| `GET /api/disputes/{case}` | Reads the real dispute bound to the case and maps it: status, stage, reason, buyer-declared item type, allowed seller actions, evidence PayPal requests, every evidence entry with its source, response due date. For the agent case, also the MeterMCP session of the disputed capture (see [MeterMCP](#metermcp)) |
| `POST /api/disputes/{case}/evidence` | Reads the dispute first, then checks: `provide_evidence` is offered now, the type is the one PayPal requests, notes ≤ 2,000 characters, tracking for proof of fulfillment. Builds the PDFs on the server from the case's synthetic documents (headed "SYNTHETIC TEST DOCUMENT") and sends them; for the agent case with a MeterMCP session, the PDF of the real session receipt instead. Answers `202 { sent: true }` or `{ error, paypalIssue }` (e.g. `EVIDENCE_TYPE_IS_NOT_ALLOWED`) |

The send never reports "recorded". The web app reads the dispute back and only shows **Recorded by PayPal** when PayPal
lists new evidence `SUBMITTED_BY_SELLER` (`PROVIDE_EVIDENCE`) that was not there before sending. The buyer's own entry
and PayPal's request never count.

**Real or simulated, per case.** A case runs on real PayPal only when it is bound to a real dispute in
`apps/server/bindings.json` *and* `/api/health` reports the sandbox (or live) connected. Every other case runs on the
in-browser simulator and is never sent to PayPal. The app bar says which: **PayPal sandbox · live `PP-R-…`** or
**Simulated PayPal**. Simulated read-backs say *Recorded by the PayPal simulator*.

On a bound case every PayPal field (amount, reason, buyer-declared item type, stage, status, due date, disputed
transaction, requested evidence, allowed actions) comes from the latest PayPal read, in the case header and the inbox
row alike; only the merchant side (order and documents) comes from the demo case, and the analyst reads the documents as shown, PayPal's capture included. Before
the first read, or if PayPal cannot be reached, those fields show "—" with the reason, never demo values. If the bound
dispute's amount differs from the demo case's order, the case header says so, and the server logs it at startup.

The API only answers the local web app. It listens on `127.0.0.1`, refuses other `Host` headers (DNS rebinding) and
foreign `Origin`s, needs a per-launch token that the Vite proxy adds on the server side (the browser never sees it),
and takes JSON only for writes. The Vite dev/preview proxy also refuses cross-site requests before adding the token.

## Principles

1. **Nothing is claimed without evidence.** Every sentence links to its source; unsupported sentences are not sent.
2. **The merchant has the final say.** Submitting evidence is irreversible in PayPal, so nothing is sent without
   explicit approval.
3. **What you see is what PayPal recorded.** After any action the dispute is re-read from PayPal.

## Run

Requires Node.js 24+ (TypeScript runs natively, no build step).

```bash
cp .env.example .env   # PayPal sandbox app credentials (never committed)
npm install
npm test               # packages/* (incl. the analyst, fake model) + apps/server + apps/metermcp (node --test, no network) + apps/web (vitest)
```

To use real sandbox disputes, bind cases to them and run the server next to the web app:

```bash
cp apps/server/bindings.example.json apps/server/bindings.json   # git-ignored: { "<web case id>": "<PayPal dispute id>" }
npm run server         # http://127.0.0.1:8787, loads .env, logs no secrets
npm run dev            # or: npm run build && (cd apps/web && npx vite preview --port 4173)
```

Without the server, or without credentials, every case runs on the simulator.

## Web app

`apps/web` is the merchant workspace (Vite + React 18 + TypeScript + Tailwind CSS): inbox, case file
(timeline · evidence · response draft), approve-and-send with the PayPal re-read, the agent-purchase case and the
"PayPal is still processing" state. Case documents are synthetic. Cases bound to a real sandbox dispute read and write
PayPal through `apps/server` (`HttpDisputeGateway`); the others use the simulated `DisputeGateway`.

The inbox and the agent case's per-call receipt are built on **[AG Grid](https://www.ag-grid.com/) Community**
(hackathon sponsor tool; `ag-grid-community` + `ag-grid-react` 33.3.2, no Enterprise modules). The inbox grid does the
work: multi-sort (shift-click), quick-filter search, saved filter chips written to the grid's filter model, a pinned
"Totals at risk" row recalculated from the filtered rows, keyboard navigation (Enter opens a case), column layout
saved on the device, and in-place row updates (`applyTransaction`) when PayPal opens a new dispute or records
evidence. The Quartz theme points at the ResolveKit CSS tokens, so light/dark and teal/indigo restyle it live. Design
tokens live in `src/theme/resolvekit-tokens.css` with the Tailwind preset `tailwind.resolvekit.cjs`.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-checks, then builds apps/web/dist
npm run typecheck
npm test           # packages/* + apps/server + apps/metermcp (node --test) + apps/web (vitest)
npm run evals -- --provider gemini   # the analyst against the real model (see docs/evals.md)
```

In development a small **Dev · simulator** control (bottom left; hidden on cases running on real PayPal) picks what the simulated PayPal does after evidence is
submitted: *Waiting for buyer*, *Under review*, or *Timeout* (read back, then safe retry). It can also make PayPal
open the new dispute now (otherwise it opens after ~75 s) or simulate PayPal being unreachable. In other builds add
`?dev` to the URL, or `?outcome=under_review|timeout` to preselect it.

## MeterMCP

`apps/metermcp` is a minimal, **real** metered MCP gateway: the seller behind the agent-purchase case. An AI agent
calls paid tools over MCP; the user approves a budget once in PayPal; MeterMCP charges only the calls that succeed and
releases the rest. It is a single seller (the PayPal sandbox app in `.env` is paid directly); no marketplace, no payouts.

**What is real and what is synthetic.** The PayPal side is real sandbox money flow: the budget is a PayPal Orders v2
`AUTHORIZE` order the buyer approves, its authorization is the hard cap, and closing the session is a real partial
capture with `final_capture` (or a void). The ledger, the request hashes and the receipts are real records of what
happened. The **tools' outputs are synthetic** (deterministic demo data), and the failed `deep_report` call in the
demo is injected by a test switch; the receipt says both.

**Flow**

1. A paid call without an approved budget answers an MCP tool error `payment_required` with the price, the budget
   proposal (default 5.00 USD) and an `approval_url`. Behind it MeterMCP created an `AUTHORIZE` order for the budget
   with one `DIGITAL_GOODS` item ("MeterMCP agent session (metered tool calls)"), `custom_id` = session id,
   `NO_SHIPPING`, and return/cancel URLs on MeterMCP itself (`/approved`, `/cancelled`).
2. The user approves in PayPal. MeterMCP notices (browser return to `/approved`, or the agent polling `get_balance`),
   re-reads the order, authorizes it, and opens the session only if PayPal reports exactly one authorization in status
   `CREATED` for exactly the cap, for this session's order, with a future expiry.
3. Each paid call (`quote_lookup` 0.05, `deep_report` 0.40, `bulk_export` 0.92 USD; prices in the tool description,
   title and `_meta["metermcp/price"]`) reserves its price in one SQLite transaction before the tool runs. A call that
   would exceed the cap is refused before forwarding (`budget_exceeded`, with remaining, price and a top-up hint);
   concurrent calls cannot both take the last of the budget. A successful call is committed (charged); a failed one is
   released and never charged. Each call records `sha256` of canonical `{session, n, tool, args}` and of the response.
4. `close_session` (or the admin endpoint, or 15 idle minutes) re-reads the authorization and captures exactly the
   sum of the OK calls with `final_capture: true` (`invoice_id` `<session>-settle`, a `note_to_payer` listing the
   calls); the rest of the authorization is released. Nothing used: the authorization is voided. If PayPal fails or
   answers anything unexpected the session stays `settlement_failed`, never charged; closing again retries with the
   same `PayPal-Request-Id`.

**Endpoints** (127.0.0.1:8790 only; `Host` must be this server, a browser `Origin` is refused, POST takes JSON only)

| Route | Who | What |
|---|---|---|
| `POST/GET/DELETE /mcp` | MCP clients | Streamable HTTP. Tools: the three paid ones, `price_list`, `get_balance`, `close_session`, `get_receipt`. Each MCP session reaches only its own payment session. |
| `GET /approved`, `GET /cancelled` | the buyer's browser, from PayPal | Re-read the order from PayPal; the query string proves nothing |
| `GET /sessions?capture=<id>` | apps/server | The session whose PayPal capture is `<id>` |
| `GET /sessions/<id>/receipt.json`, `.pdf` | apps/server | Mandate (order, authorization, cap, approval time), every call (time, tool, price, status, request hash), totals, capture id, remainder released |
| `POST /sessions/<id>/close` | admin | Close and settle (or retry a failed settlement) |

The `/sessions` routes need the per-launch admin token (`x-metermcp-token`, written to `apps/metermcp/.runtime-token`,
git-ignored); a session id (128 random bits) is never a credential. The ledger lives in `apps/metermcp/data/`
(git-ignored).

**ResolveKit uses the real receipt.** For the agent case bound to a real dispute, `apps/server` asks MeterMCP for the
session of the dispute's disputed capture and adds it to the case. The web app then shows the real mandate, per-call
receipt (AG Grid), settlement and timeline, each card labelled **From MeterMCP · session …**; without a session the
cards say **Demo data** and the case says why. The evidence goes as `PROOF_OF_FULFILLMENT`, carrier `OTHER`
("Digital delivery"), tracking = session id, with the PDF MeterMCP builds from the real receipt.

**Run the demo agent** (`apps/metermcp/scripts/demo-agent.ts`, scripted MCP client; the planner is pluggable):

```bash
METERMCP_FAIL_FIRST=deep_report npm run metermcp   # PowerShell: $env:METERMCP_FAIL_FIRST='deep_report'; npm run metermcp
npm run demo-agent                                  # prints the approval URL, waits, makes the calls, closes
npm run demo-agent -- --no-wait                     # stop after printing the approval URL
```

Approve with the sandbox **personal** (buyer) account. The agent then calls `quote_lookup`, `deep_report` (fails
once: test switch, not charged), `deep_report` again, `bulk_export`, closes the session (captures 1.37 of 5.00 USD)
and prints the PayPal capture id. `METERMCP_FAIL_FIRST` makes the first call of the named tools in each session fail;
leave it unset for normal operation. Other settings: `METERMCP_PORT` (8790), `METERMCP_BUDGET` (5.00),
`METERMCP_IDLE_MINUTES` (15), `METERMCP_PUBLIC_URL`. Stop MeterMCP with Ctrl+C (it removes its token file).

## AI tools

**Models.** The analyst (`packages/analyst`, called by `apps/server`) uses **Google Gemini `gemini-3.8-flash`** through
the Gemini API (`generateContent`, JSON-schema output, `thinkingLevel: low`, temperature 0) as the primary model, and
**`openai/gpt-oss-120b` on Groq** (OpenAI-compatible API, strict `json_schema`) as the automatic fallback when Gemini
errors or rate-limits. `ANALYST_PROVIDER=gemini|groq` picks the primary; keys come from `GEMINI_API_KEY` /
`GROQ_API_KEY` in the server's environment and never reach the browser. Every call has a timeout, retries with
backoff (honouring `Retry-After`), an output-token cap, and a usage log with token counts and timings only — never
prompt or document text. No SDK: plain `fetch`.

**What the AI does, step by step** (and what it does not):

| Step | Model | Deterministic code |
|---|---|---|
| Read | — | Builds the input from the documents exactly as shown (PayPal's capture when bound, MeterMCP's real receipt for the agent case); pattern scan for instructions |
| 1. Extract | Lists the facts in every document, each with a **verbatim quote**; flags instruction-bearing passages. A separate small **classifier** call screens the documents for instructions | Drops every quote that is not an exact substring of its document (whitespace-normalised only) |
| 2. Timeline, contradictions, checklist, draft | From the extracted facts only: orders events, finds documents that disagree (with a neutral explanation, never a fraud accusation), assesses each requirement, drafts English sentences citing facts; the merchant's own notes are drafted with the facts that bear on them | Checklist requirements per dispute reason; amounts and addresses listed side by side for comparison; contradictions need two different documents and verbatim values; timeline sorted by time |
| 3. Verify | Each sentence in **its own call**, judged only against its own cited quotes: *supported* / *needs review* (with the reason and a rewrite) / *rejected* | No valid citation → **rejected without asking the model**. A "supported" sentence stating a number none of its quotes contain → *needs review*. A sentence resting on a flagged document → at most *needs review* |
| 4. Recommendation | Explains the chosen action in two sentences, from supported sentences only | **Rules choose the action** from what PayPal allows now and the evidence PayPal requests; the model never picks the action or the evidence type |

Only *supported* sentences go into what can be sent; rejected ones stay visible, struck through, with the reason.
Editing a sentence sends it back to the model (it re-chooses citations from the facts, then the same checks apply).
Nothing is sent to PayPal without the merchant's approval.

**Documents are content, never instructions.** Documents are wrapped in delimiters with a random per-call tag, and
every prompt says their text is data. Instructions are flagged by three signals (pattern scan on normalised text —
NFKC, zero-width/bidi characters removed, homoglyphs and leetspeak mapped, EN/ES/FR/DE/PT, fake role lines and
markup, base64/hex payloads — plus the extraction model and the classifier call); the flag is shown on the document
(E6 in the demo). Detection is a warning, not the defence: the analysis is built so that an undetected injection
cannot change the action, the evidence type or what counts as supported
(see [docs/evals.md](docs/evals.md#prompt-injection-detection-vs-safety)).

**Caching and golden analyses.** Results are keyed by sha256 of (documents + notes + dispute data, prompt version,
model). Live runs are cached in `apps/server/data/analysis-cache/` (git-ignored). The two demo cases also have
**golden analyses** made by `gemini-3.8-flash` and committed with their model id, date, prompt version and token usage
(`packages/analyst/golden/`), so the demo works without a key or quota; the app uses one only when its key matches
the documents on screen. The analysis bar always says which: **"Analysis by gemini-3.8-flash · 9 Oct 2026 · cached"**
or **"… · live"** (hover for prompt version and token counts). *Replay analysis* replays the steps; *Re-run with AI*
runs the model again (6 live runs per hour per server, re-checks 30 per hour), showing the pipeline's real stages as
they finish.

| Route | What it does |
|---|---|
| `POST /api/cases/{case}/analysis` | `{ input }` → the stored analysis for these documents (`200`), or a live run (`202`, then poll); `?refresh=1` forces a live run; `429` with the reset time when rate-limited |
| `GET /api/cases/{case}/analysis/progress?key=` | Stages done so far, then the result |
| `POST /api/cases/{case}/analysis/verify` | `{ input, text }` → the verifier's verdict and citations for an edited sentence |

Same guards as the rest of the API (Host, Origin, per-launch token, JSON only); the input is validated and rebuilt
field by field.

**Evals** ([docs/evals.md](docs/evals.md), raw results committed): 18 synthetic cases — normal delivery, missing
tracking, address/postcode/amount contradictions, fabricated-claim bait, 10 prompt-injection styles, agent receipts.
`gemini-3.8-flash`, final prompt: citation validity **100%** (374/374), unsupported claims kept out of what can be
sent **100%** (17/17; 16 removed, 1 sent to review), false rejection **0%** (0/15), contradiction recall **100%** (13/13),
injection detected **10/10** (pattern scan alone 8/10), outcome unchanged **10/10** — and still 10/10 with detection
ignored. The first full run missed an amount contradiction (86% recall). Groq `gpt-oss-120b` (13 of 18 cases before
its free-tier quota ran out) was weaker — 92% of bait kept out, 10% false rejection, outcome unchanged 6/7 — and its two
failures led to two new deterministic checks. Earlier versions, Groq details and the remaining misses are in the doc.
`npm run evals -- --provider gemini|groq` reruns them (not part of `npm test`, which uses a fake model).

**Data.** Only the synthetic demo documents (fictional names, addresses and identifiers) and, for bound cases, PayPal
sandbox data are sent to the model. No real customer data.

## License

[MIT](LICENSE)
