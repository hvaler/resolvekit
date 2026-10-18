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
| Dispute notifications | Webhook `CUSTOMER.DISPUTE.CREATED` / `.UPDATED` / `.RESOLVED` → `POST /v1/notifications/verify-webhook-signature` | Learn of new and changed disputes without waiting for the next read |

Every behaviour above was verified in the sandbox before building on it. See
[`docs/sandbox-findings.md`](docs/sandbox-findings.md).

The browser never talks to PayPal. `apps/server` (Node 24, no framework) holds the credentials and uses the typed
client in `packages/paypal`:

| Route | What it does |
|---|---|
| `GET /api/health` | `{ paypal: "sandbox" \| "live" \| "unconfigured", bound: [case ids], bindings: { case: { status, reasons } } }` after a lazy OAuth check; status is `verified`, `invalid`, `unavailable` or `unchecked` |
| `GET /api/disputes/{case}` | Reads the real dispute bound to the case and maps it: status, stage, reason, buyer-declared item type, allowed seller actions, evidence PayPal requests, every evidence entry with its source, response due date. For the agent case, also the MeterMCP session of the disputed capture (see [MeterMCP](#metermcp)) |
| `POST /api/disputes/{case}/intent` | Composes the **submission intent**: exactly what PayPal would receive, built on the server (see [How sending works](#how-sending-works-the-security-model)). Body: `{ evidenceType, edits, resolutions }` only |
| `POST /api/disputes/{case}/intent/{id}/approve` | The merchant approves that exact content: `{ contentHash }` |
| `POST /api/disputes/{case}/evidence` | `{ intentId }` and nothing else. Sends the approved intent after re-checking it on a fresh PayPal read. Builds the PDFs on the server from the case's synthetic documents (headed "SYNTHETIC TEST DOCUMENT"); for the agent case with a MeterMCP session, the PDF of the real session receipt instead. Answers `202 { sent: true }` or `{ error, paypalIssue }` (e.g. `EVIDENCE_TYPE_IS_NOT_ALLOWED`) |
| `GET /api/disputes/{case}/audit` | The server's audit trail of the case: intents composed, approvals (who, when, content hash), sends (PayPal-Request-Id, PayPal's answer and its debug_id), refusals, PayPal notifications |
| `POST /api/paypal/webhook/{key}` | Hosted, with `PAYPAL_WEBHOOK_ID` and `PAYPAL_WEBHOOK_KEY`: PayPal's dispute notifications. No session or Origin (PayPal is the caller), so nothing is believed until PayPal confirms the delivery. Each confirmation is a call under the seller's app, so strangers must not be able to cause one: the registered URL carries a secret key (any other key: `404` before the body is read), the five transmission headers are checked (certificate on a PayPal host), only dispute events are confirmed, and confirmations are capped across all callers (60/min, 4 at once; over it `503`). Then `verify-webhook-signature` gets the event **byte for byte as received** (never re-serialised). Then `200` at once, and the event is only a hint: the server reads the dispute again from PayPal and invalidates its cached read. Each event id is acted on once. `400` unusable or not confirmed, `408` body too slow, `413` over 64 KB, `503` PayPal could not confirm now (PayPal delivers again, up to 25 times in 3 days) |
| `GET /api/paypal/notices` | The latest notifications as re-read from PayPal, shown only to the dispute's seller (a signed-in workspace whose PayPal account is the seller), including disputes not linked to a case yet. The inbox shows them as **PayPal notified** |

The send never reports "recorded". The web app reads the dispute back and only shows **Recorded by PayPal** when PayPal
lists new evidence `SUBMITTED_BY_SELLER` (`PROVIDE_EVIDENCE`) that was not there before sending **and** that matches
what was sent (evidence type, full notes, carrier and tracking, file names). New seller evidence that does not match
(another operator, another process) is shown as such, is never reported as ours, and stops any automatic retry. The
buyer's own entry and PayPal's request never count.

### How sending works (the security model)

"Nothing unsupported reaches PayPal; nothing is sent without the merchant's approval" is enforced **on the server**,
not only in the browser:

1. **The server composes the intent.** `POST …/intent` reads the dispute fresh from PayPal, verifies the binding (below),
   rebuilds the case documents itself, takes *its own* stored analysis of exactly those documents and composes the notes
   from the **supported** sentences only, with the same rules as the review screen (every contradiction resolved, the
   evidence type allowed and satisfied, PayPal offering `provide_evidence`, ≤ 2,000 characters). A merchant edit counts
   only if *this server* re-checked that exact text with the analyst (`/analysis/verify`) and found it supported. The
   intent binds the case, the PayPal dispute, a hash of the documents, the analysis key, evidence type, carrier,
   tracking, file names and the exact notes, under a content hash. Notes, files or tracking in any request body are
   refused.
2. **The merchant approves that content.** The review screen shows the server's intent (its id and hash included);
   confirming sends `{ contentHash }`, and the server records the approver (the hosted demo session, or the local
   operator), the time and the hash, persisted on the data dir.
3. **Only the approved intent is sent.** `POST …/evidence { intentId }`: `approved → sending` is one synchronous
   transition (two confirmations send once); right before sending the dispute is read fresh, the binding verified again
   and the intent composed again: a different document hash or content hash refuses the send (409), as do a changed
   binding or PayPal no longer offering `provide_evidence`. Every send of an intent carries the same PayPal-Request-Id.
   A failed send can be retried with that same intent; a sent one cannot be sent again.
4. **Approvals are invalidated, not trusted forever.** Editing a sentence, composing a newer intent, changing the
   bindings, or 30 minutes passing ends an intent (an edit during a send voids the approval if that send fails). A
   failed send can be retried for 30 minutes. The intent keeps the exact analysis it was composed from, so someone
   else re-running the analysis does not change an approved response.
5. **Intents belong to the person who composed them.** In hosted mode composing, reading, approving, cancelling or
   sending an intent needs a signed-in person (see [Merchant accounts](#merchant-accounts-hosted-mode)); each intent
   belongs to the person who composed it and does not exist for anyone else, a teammate included (404). One person's
   actions never invalidate another's intents; the workspace's members share its audit trail, which names who
   composed, approved and sent. Only one intent per dispute can be sending at a
   time, and once PayPal accepted one (recorded on the disk), any other intent for that dispute is refused with
   "PayPal already has seller evidence for this dispute", without waiting for PayPal's read. The store is bounded:
   per session one open intent per case, 10 open, 30 stored and 30 compositions per 10 minutes (whatever its
   addresses); 20 open per client address (IPv6 per /64), 20 compositions per address per 10 minutes; 1,000 open /
   2,000 stored as a safety net (new ones are refused with the real time until one frees up; existing ones are never
   evicted). Replaced, cancelled and expired intents leave the store at once. Audit events are kept per session
   (one session cannot push out another's trail) and sends go to an append-only log that is never evicted. A send is
   recorded or it does not happen: if the approved intent and its `send_started` line cannot be written to the disk,
   nothing goes to PayPal (503 `AUDIT_UNAVAILABLE`); a write that fails after PayPal accepted is logged as
   `AUDIT NOT DURABLE`, and a restart finds the send unfinished and reads PayPal back. 128-bit ids. A refused
   creation changes nothing.

**Bindings are verified before any send, and fail closed.** A binding is
`{ "<case id>": { "dispute": "PP-R-…", "capture": "<capture id>" } }`; `npm run demo:prepare` prints it with the
capture it created. On a fresh read the dispute must be the bound one, with exactly one disputed transaction that is
the bound capture, and the disputed amount (and the transaction's gross amount) equal to the case's amount and
currency. Missing data fails. The old string form `"<case id>": "PP-R-…"` is still read and shown, but has no capture:
it passes only if the dispute is about the demo case's own capture record, which a real sandbox payment never is, so
it cannot send. An unreadable dispute answers `409 BINDING_UNAVAILABLE`, a mismatch `409 BINDING_INVALID` with the
reasons, which the review screen shows. `/api/health` reports each binding's status; changing the bindings forgets it.

**Real or simulated, per case.** A case runs on real PayPal only when it is bound to a real dispute in
`apps/server/bindings.json` *and* `/api/health` reports the sandbox (or live) connected. Every other case runs on the
in-browser simulator and is never sent to PayPal. The app bar says which: **PayPal sandbox · live `PP-R-…`** or
**Simulated PayPal**. Simulated read-backs say *Recorded by the PayPal simulator*.

On a bound case every PayPal field (amount, reason, buyer-declared item type, stage, status, due date, disputed
transaction, requested evidence, allowed actions) comes from the latest PayPal read, in the case header and the inbox
row alike; only the merchant side (order and documents) comes from the demo case, and the analyst reads the documents as shown, PayPal's capture included. Before
the first read, or if PayPal cannot be reached, those fields show "—" with the reason, never demo values. If the bound
dispute's amount differs from the demo case's order, the case header says so, the server logs it at startup, and
sending is blocked (see the binding check above).

The API only answers the local web app. It listens on `127.0.0.1`, refuses other `Host` headers (DNS rebinding) and
foreign `Origin`s, needs a per-launch token that the Vite proxy adds on the server side (the browser never sees it),
and takes JSON only for writes. The Vite dev/preview proxy also refuses cross-site requests before adding the token.
The public demo runs the same API in **hosted mode** instead (see [Deploy on Render](#deploy-on-render)).

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
npm test               # packages/* (incl. the analyst, fake model, hosting) + apps/server + apps/metermcp (node --test, no network) + apps/web (vitest)
```

To use real sandbox disputes, bind cases to them and run the server next to the web app:

```bash
cp apps/server/bindings.example.json apps/server/bindings.json   # git-ignored: { "<case id>": { "dispute": "PP-R-…", "capture": "…" } }
npm run server         # http://127.0.0.1:8787, loads .env, logs no secrets
npm run dev            # or: npm run build && (cd apps/web && npx vite preview --port 4173)
```

Without the server, or without credentials, every case runs on the simulator.

## Web app

`apps/web` is the merchant workspace (Vite + React 18 + TypeScript + Tailwind CSS): inbox, case file
(timeline · evidence · response draft), approve-and-send with the PayPal re-read, the agent-purchase case and the
"PayPal is still processing" state. Case documents are synthetic. Cases bound to a real sandbox dispute read and write
PayPal through `apps/server` (`HttpDisputeGateway`); the others use the simulated `DisputeGateway`.

Every inbox row opens a full case file (`packages/cases`, shared with the server), each in the state PayPal would show:

| Case | PayPal reason · stage | State | Evidence type |
|---|---|---|---|
| PP-R-TVH-10190665 | `MERCHANDISE_OR_SERVICE_NOT_RECEIVED` · inquiry | Waiting for the seller; address contradiction, injected buyer note | `PROOF_OF_FULFILLMENT` (UPS) |
| PP-R-MMC-10190702 | `MERCHANDISE_OR_SERVICE_NOT_RECEIVED` · inquiry, agent purchase | Waiting for the seller; MeterMCP session | `PROOF_OF_FULFILLMENT` (digital delivery) |
| PP-R-BLW-10187733 | `MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED` · claim | Waiting for the seller; listing says natural, buyer says navy, no packing photo | `OTHER` (listing, photos, return policy) |
| PP-R-PLN-10189901 | `MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED` · claim | Waiting for the seller; height 45 cm (with shade) vs 35 cm | `OTHER` (listing, dispatch check) |
| PP-R-KDA-10192258 | `INCORRECT_AMOUNT` · claim, agent purchase | Waiting for the seller; 3.20 of a 5.00 USD budget captured, hold released (demo MeterMCP data) | `OTHER` (mandate, receipt, settlement) |
| PP-R-QZE-10181290 | `UNAUTHORISED` · inquiry, booking | Evidence recorded 6 Oct, buyer's turn: read-back, draft locked | `OTHER` (booking, check-in, earlier order) |
| PP-R-HFA-10176021 | `MERCHANDISE_OR_SERVICE_NOT_RECEIVED` · inquiry | Resolved in the seller's favour 2 Oct: outcome, what was sent, no actions | `PROOF_OF_FULFILLMENT` (USPS) |
| PP-R-NKQ-10194410 | `MERCHANDISE_OR_SERVICE_NOT_RECEIVED` · new | PayPal still processing (`UNDER_REVIEW`, no seller actions) | — |

Evidence types follow PayPal's [dispute reasons and evidence](https://developer.paypal.com/disputes/reasons-evidence)
table (e.g. notes and documents, `OTHER`, for "not as described" and "incorrect amount"); in the claim stage the
seller gets no `send_message`, `make_offer` or `escalate` (inquiry-only in the Customer Disputes API).

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

**Recording mode** (for the demo video; off by default): add `?record` to the URL, or tick *Recording mode* in the
Dev control. The analysis replay then shows each step for ~1.2 s instead of 0.65 s, and the Dev control is hidden.
Nothing else changes: every label, provenance line ("cached" / "live", "Simulated PayPal" / "PayPal sandbox · live")
and status stays exactly as in normal use. It is kept for the browser tab while you navigate; `?record=0` turns it
off. The app is usable at phone width (390 px) too: the case file stacks timeline, evidence and draft, and the grids
scroll inside their own box.

## Merchant uploads

A seller can add their own evidence to a case: a screenshot (PNG or JPEG) or pasted text such as an email thread.
It is numbered after the case's documents (E7, E8…) and the analyst cites it with its exact words, under the same
rules as every other document.

- **Nothing leaves the server before the merchant confirms it.** Text is read on the server itself (local OCR for
  images); no upload, byte or text, goes to Google, Groq or PayPal until it is covered where needed, read again and
  confirmed. Logs and audit details carry ids and file names (so do not name a file with sensitive text), never upload text or bytes.
  The file name itself never leaves the server: PayPal receives `E7-upload.png` / `E8-pasted.pdf`, and the model
  reads the titles "Uploaded screenshot" / "Pasted text".
- **What PayPal receives is the sanitised file**: the merchant's covered areas are burned into the PNG (the original
  is dropped on confirmation), and pasted text is sent as a PDF made by ResolveKit with the removed passages marked.
  A line the merchant corrected after the OCR is kept as their reading, shown as "corrected by <name>", and a
  sentence that depends on it needs the person's explicit confirmation before it can be sent.
- **Limits**: 5 MB and 3840 x 2160 pixels (8,294,400, about 8 MP) per image, decoded one image at a time; under 10 MB per
  stored (sanitised) file and 50 MB per response (PayPal's limits); 20,000 characters of pasted text, Latin-1 only (the PDF sent to PayPal cannot show other
  characters, so text with one is refused naming it); 10 uploads per case, 5 covering passes per upload, 40 uploads a
  day on the hosted demo, 300 MB of storage.
- **Pending uploads last 24 hours**: one that is not confirmed or discarded in that time is discarded the first
  time it is met. **Deleting an upload** (owners and members) removes its files and purges the stored analyses that
  quoted it; the audit trail keeps the event, not the text. Uploads belong to the workspace and to the dispute that
  was active when they were added, and are archived when the case moves to its next dispute (the record stays for
  the audit; files and text are removed).

How well the analyst uses them is measured in [`docs/evals.md`](docs/evals.md) (case `upl-carrier-evidence`).

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
   same `PayPal-Request-Id`. If PayPal answers the capture **`PENDING`**, the session is `capture_pending`, not
   settled: the receipt says the capture is pending and not a final charge (no "captured", `remainder_released:
   false`), and ResolveKit will not use it as evidence. MeterMCP reads the capture back
   (`GET /v2/payments/captures/{id}`) every 30 s, on demand and on a close retry: `COMPLETED` settles it once,
   `DECLINED`/`FAILED` makes it `capture_declined` (the attempt stays on the receipt; nothing is claimed as charged).
5. **Live MCP sessions are capped**: 200 in all and 20 per client IP (each initialize reserves its slot before the
   session is set up), and a session idle for 15 minutes is closed (transport freed, its payment session closed like
   `close_session`). `/health` reports live, rejected and expired MCP sessions.

**Endpoints** (127.0.0.1:8790 only; `Host` must be this server, a browser `Origin` is refused, POST takes JSON only)

| Route | Who | What |
|---|---|---|
| `POST/GET/DELETE /mcp` | MCP clients | Streamable HTTP. Tools: the three paid ones, `price_list`, `get_balance`, `close_session`, `get_receipt`. Each MCP session reaches only its own payment session. |
| `GET /approved`, `GET /cancelled` | the buyer's browser, from PayPal | Re-read the order from PayPal; the query string proves nothing |
| `GET /sessions?capture=<id>` | apps/server | The session whose PayPal capture is `<id>` |
| `GET /sessions/<id>/receipt.json`, `.pdf` | apps/server | Mandate (order, authorization, cap, approval time), every call (time, tool, price, status, request hash), totals, capture id, remainder released |
| `POST /sessions/<id>/close` | admin | Close and settle (or retry a failed settlement; for a pending capture, reconcile it) |
| `POST /sessions/<id>/reconcile` | admin | Read a `PENDING` capture back from PayPal now |

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
model). Live runs are cached in `apps/server/data/analysis-cache/` (git-ignored). Every demo case also has a
**golden analysis** made by `gemini-3.8-flash` and committed with their model id, date, prompt version and token usage
(`packages/analyst/golden/`), so the demo works without a key or quota; the app uses one only when its key matches
the documents on screen. The analysis bar always says which: **"Analysis by gemini-3.8-flash · 9 Oct 2026 · cached"**
or **"… · live"** (hover for prompt version and token counts). *Replay analysis* replays the steps; *Re-run with AI*
runs the model again (6 live runs per hour per server, re-checks 30 per hour), showing the pipeline's real stages as
they finish.

| Route | What it does |
|---|---|
| `POST /api/cases/{case}/analysis` | `{}` → the stored analysis of the case's documents (`200`), or a live run (`202`, then poll), with the `input` the server analysed; `?refresh=1` forces a live run; `429` with the reset time when rate-limited |
| `GET /api/cases/{case}/analysis/progress?key=` | Stages done so far, then the result |
| `POST /api/cases/{case}/analysis/verify` | `{ text }` → the verifier's verdict and citations for an edited sentence |

Same guards as the rest of the API (Host, Origin, per-launch token, JSON only). **The server builds the analyst's
input itself**: the demo case from `packages/cases` (fixtures plus the assembly the web app uses to show them), its
own PayPal read of the bound dispute (reused for 60 s) and, for the agent case, its own MeterMCP read. The browser
sends only the case id, and for a re-check the edited sentence (validated, and delimited as untrusted data); any
document data in a request is ignored. Once PayPal shows the seller's evidence, the case keeps the input it was
analysed with before sending (same documents; only PayPal's allowed actions changed), so sending does not need a new
model run (`InputPins`, persisted in the data directory).

**Evals** ([docs/evals.md](docs/evals.md), raw results committed): 18 synthetic cases — normal delivery, missing
tracking, address/postcode/amount contradictions, fabricated-claim bait, 10 prompt-injection styles, agent receipts.
`gemini-3.8-flash`, final prompt: citation validity **100%** (374/374), unsupported claims kept out of what can be
sent **100%** (17/17; 16 removed, 1 sent to review), false rejection **0%** (0/15), contradiction recall **100%** (13/13),
injection detected **10/10** (pattern scan alone 8/10), outcome unchanged **10/10** — and still 10/10 with detection
ignored. The first full run missed an amount contradiction (86% recall). Groq `gpt-oss-120b` (13 of 18 cases before
its free-tier quota ran out) was weaker on the previous prompt — 92% of bait kept out, 10% false rejection, outcome
unchanged 6/7 — and its two failures led to two new deterministic checks; on the final prompt it ran 7 of 18 cases
before the daily quota ran out again, with no failure on those 7 (partial, in the doc). Earlier versions, Groq details and the remaining misses are in the doc.
`npm run evals -- --provider gemini|groq` reruns them (not part of `npm test`, which uses a fake model).

**Data.** Only the synthetic demo documents (fictional names, addresses and identifiers) and, for bound cases, PayPal
sandbox data are sent to the model. No real customer data.

## Deploy on Render

The public demo runs on [Render](https://render.com) from [`render.yaml`](render.yaml) (a Blueprint): two web
services in Oregon on the paid **Starter** plan (`0.5c-512mb`), each with a 1 GB persistent disk, Node 24.19.0.

| Service | Start | Disk (`/var/data`) | Public |
|---|---|---|---|
| `resolvekit` | `node apps/server/src/main.ts` with `RESOLVEKIT_MODE=hosted` | analysis cache, analyst usage log, daily caps | the web app and `/api`, one origin |
| `resolvekit-metermcp` | `node apps/metermcp/src/main.ts` with `METERMCP_MODE=hosted` | SQLite ledger, daily budget cap | `/mcp`, `/approved`, `/cancelled`, `/health` |

**Steps**

1. Push the repo to GitHub. In Render: **New → Blueprint**, pick the repo; Render reads `render.yaml`.
2. Render asks once for the `sync: false` secrets (both services ask for their own copy; use the same values):
   `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` (the PayPal **sandbox** app, developer.paypal.com → Apps & Credentials),
   `GEMINI_API_KEY` (Google AI Studio), `GROQ_API_KEY` (console.groq.com; optional fallback),
   `PAYPAL_IDENTITY_CLIENT_ID` / `PAYPAL_IDENTITY_CLIENT_SECRET` on `resolvekit` (a **second** sandbox app, created
   under **another** sandbox business account: merchants sign in by approving a no-charge request of it, and a seller
   cannot approve a request of its own app), `DEMO_CODE` on `resolvekit-metermcp` (12+ random characters; judges'
   MCP clients send it) and `BINDINGS_JSON`:
   `{"PP-R-TVH-10190665":{"dispute":"<sandbox dispute id>","capture":"<its capture id>"},"PP-R-MMC-10190702":{…}}`
   (exactly what `npm run demo:prepare` prints; see `apps/server/bindings.example.json`). Bindings are validated at
   start; a bad one stops the service. A binding without the capture (the old string form) is read and shown but
   cannot send. Without `BINDINGS_JSON` the server reads `/var/data/bindings.json`.
   `PAYPAL_ENV` is `sandbox` in `render.yaml`: in hosted mode both services **refuse to start** on anything else;
   `live` would additionally need `RESOLVEKIT_ALLOW_LIVE_PAYPAL=yes-real-money`, which the blueprint never sets.
3. Render generates `RESOLVEKIT_SESSION_SECRET` (signs the session cookies) and `METERMCP_ADMIN_TOKEN` (given to
   `resolvekit` with `fromService`), and passes MeterMCP's private-network `host:port` as `METERMCP_URL`.
   `RENDER_EXTERNAL_URL` / `PORT` come from Render. A custom domain goes in `RESOLVEKIT_CUSTOM_DOMAINS` /
   `METERMCP_CUSTOM_DOMAINS`.
4. Nothing to do for the analyses: a bound case's documents include PayPal's (and MeterMCP's) live data, so the
   committed golden analyses do not match them, and the server **warms up** instead. After boot, and whenever the
   bindings change (a new `BINDINGS_JSON` restarts the service; a changed `/var/data/bindings.json` is picked up within
   30 s), it analyses each bound case once in the background, skipping any whose documents already have a stored
   analysis. These are system runs: nobody signed in, but the same hourly limit and daily cap as a live run. The log
   says the outcome per case (`warm-up · case … · done | cached | skipped · why`), never document text or keys. The
   seller's workspace then finds the analysis ready.
   Then sign in once as the merchant (**Sign in → Continue with PayPal**, approve with the sandbox **business** account that
   is the seller on the bound disputes) and create the reviewer invite link for the judges under **Members and
   invites**. The link is shown once; it goes into the Devpost testing instructions.
5. Fresh disputes for the demo: `npm run demo:prepare` (below) creates the payments, tells the sandbox buyer what to
   click, waits for the disputes and prints the `BINDINGS_JSON` to paste.
6. The agent case shows the real MeterMCP receipt only if the hosted ledger has the session of the disputed capture:
   run the demo agent against the hosted MeterMCP
   (`METERMCP_URL=https://<metermcp host>/mcp METERMCP_DEMO_CODE=<code> npm run demo-agent`), approve with the sandbox
   buyer, open the dispute on its capture as the buyer, and bind it. (Or copy the local `metermcp.sqlite` onto the
   disk.)
7. PayPal accepts evidence once per dispute, so a case can be bound to a **reserve**: a list
   `{ "<case id>": [{ "dispute": …, "capture": … }, …] }`, first active. When PayPal shows the active dispute closed,
   or with the seller's evidence for more than 15 minutes (so whoever sent it sees the read-back), the next read moves
   the case to the next dispute of the list, logs it and analyses the case again; every send still verifies its own
   binding on a fresh read, and an intent composed for the previous dispute is refused (`BINDING_CHANGED`).
   `npm run demo:prepare -- --standard --count 5` makes five payments and prints the list. Sandbox disputes give the
   seller about 20 days: prepare them for the dates they are needed.
8. Check it: set the same `RESOLVEKIT_OPS_TOKEN` (32+ random URL-safe characters) on the `resolvekit` service and in
   your local `.env`, then `npm run demo:check` after every deploy. Read-only, it prints one PASS/FAIL line per item:
   both services up, the landing page, PayPal connected, the webhook on, each binding verified on a fresh PayPal read,
   each AI provider answering one tiny call (`--no-models` skips it), and the last warm-up of the bound cases. It
   exits 1 when anything failed. Without the token on the server, `GET /api/ops/status` does not exist.

**Prepare fresh demo disputes** (`apps/server/scripts/demo-prepare.ts`; you are the sandbox buyer, nothing is faked):

```bash
npm run demo:prepare -- --dry-run          # checks the PayPal credentials and shows what it would create; creates nothing
METERMCP_DEMO_CODE=<code> npm run demo:prepare   # PowerShell: $env:METERMCP_DEMO_CODE='<code>'; npm run demo:prepare
```

1. **Standard case**: an Orders v2 `CAPTURE` order for exactly the standard case's order (1 × "Linen tote, natural",
   7.00 USD, `PHYSICAL_GOODS`). It prints the approval URL; approve with the sandbox **personal** account; it
   captures and prints the capture id.
2. **Agent case**: the demo agent against the **hosted** MeterMCP (`--metermcp URL` for another one), so the session
   lives in the hosted ledger and the hosted agent case shows the real receipt. Approve the budget; it makes 4 calls
   (the first `deep_report` fails: `METERMCP_FAIL_FIRST=deep_report` on that service, never charged), closes and
   prints the capture id. `METERMCP_DEMO_CODE` is read from the environment and never printed.
3. It prints what the buyer clicks: "Report a problem" on each payment → *I didn't receive an item* → item type
   **Physical product** (standard) or **Service** with *"I didn't receive any confirmation of the service"* (agent).
4. It polls PayPal until each dispute appears (~5 min) and reaches `WAITING_FOR_SELLER_RESPONSE`, then prints the
   `BINDINGS_JSON` for Render.

Steps run separately and resume: `--standard`, `--agent`, `--wait-disputes --captures <standard>,<agent>` (either may
be empty), `--approval-minutes`, `--dispute-minutes`.

**Hosted mode** (`apps/server/src/hosted.ts`, `apps/metermcp/src/app.ts`, `packages/hosting`)

- Browsing is free: inbox, cases (on the simulator), stored analyses, health.
- People sign in ([Merchant accounts](#merchant-accounts-hosted-mode)). The real PayPal disputes, sending evidence to
  them, live AI runs (including a plain request whose documents have no stored analysis) and AI re-checks of edited
  sentences belong to the **seller's workspace**: the workspace whose PayPal account is the seller on the bound
  disputes (Owner, or a member who joined with its invite). Everyone else gets the same cases on the simulator; a
  locked action says why (**Sign in required** / **Seller workspace only**).
- Global **daily caps**, persisted on the disk and reserved atomically before the work starts (refunded when it did
  not happen): `DAILY_LIVE_ANALYSES` (60), `DAILY_RECHECKS` (200), `DAILY_EVIDENCE_SENDS` (20), on top of the
  hourly limits (`LIVE_ANALYSES_PER_HOUR` 6, `RECHECKS_PER_HOUR` 30). Live runs and re-checks only analyse inputs the server
  builds itself from its own fixtures and its own PayPal and MeterMCP reads; nothing a visitor sends reaches the
  model except an edited sentence of a re-check.
- Requests: `Host` must be the public host (`/healthz` excepted, for Render's health check); `/api` writes must
  carry the service's own `Origin`; POST is JSON only; per-IP limits (300 `/api` requests and 60 PayPal reads per 5
  min, 20 submission intents per 10 min). The client address comes from `X-Forwarded-For`, walking back from the entry Render's
  proxy appended and skipping it only while it is a Cloudflare edge (Cloudflare's published ranges), up to
  `TRUSTED_PROXY_HOPS` (2 on Render); so a request that bypasses Cloudflare is keyed on its own address and nothing
  a client writes in the header is believed. Per-IP limits are a courtesy, not the security boundary: anyone
  sending from many addresses (proxies, VPNs, Cloudflare Workers egress) can spread requests across keys; the
  boundary is the signed-in person and their workspace, the per-person caps and the global daily caps. The header is believed only when the connection comes from a private address (Render's proxy;
  `TRUSTED_PROXY_PEERS=private|any|none`), else the socket address; IPv6 is keyed per /64. The first request logs,
  masked, how the address was derived. Sign-in requests: 40 per address per 15 min, PayPal sign-ins started: 10.
  Submission intents, approvals and sends need a signed-in person and belong to the person who made them (see
  [How sending works](#how-sending-works-the-security-model)).
- Headers on every answer: CSP (own scripts only; Google Fonts; `frame-ancestors 'none'`), HSTS, `nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
- MeterMCP: `/mcp` is public for judges' own MCP clients. Free tools work for anyone; **creating a budget** (the
  PayPal order behind `payment_required`) needs the demo code in the `x-demo-code` HTTP header and stays within
  `DAILY_BUDGETS` (20) per day; without it a paid tool answers `demo_code_required`. Wrong codes: 5 per IP per 15
  min. Return/cancel URLs use `RENDER_EXTERNAL_URL`. Admin routes (`/sessions…`) answer only requests that did not
  come through Render's public proxy (no `X-Forwarded-For`, not the public host) and carry the admin token.
- Local mode is unchanged (127.0.0.1, per-launch tokens, Vite proxy): no sign-in, the operator is the merchant.

#### Merchant accounts (hosted mode)

`apps/server/src/accounts.ts`, `apps/server/src/auth.ts`, `packages/paypal/src/identity.ts`.

- **A workspace is a merchant**, identified by its PayPal account. **Continue with PayPal** asks PayPal for a
  no-charge Billing Agreements token of the *platform's* PayPal app (`PAYPAL_IDENTITY_*`); the merchant approves it on
  PayPal, and the token then names the approving account's `payer_id`, which for a business account is its merchant
  id (`seller.merchant_id` on its disputes). No agreement is created and no money moves. Verified in the sandbox on
  2026-10-10. Log in with PayPal (OpenID `userinfo`) answered 400 in the same sandbox, and a seller cannot approve a
  request of its own app, hence the second app.
- **Binding the sign-in to the browser that approved.** The return URL carries a key derived from a nonce kept in a
  short-lived signed cookie of the browser that started (SameSite=Lax, path `/api/auth/paypal`); a sign-in finishes
  only with both. Each token gets one attempt: an arrival without the cookie (the approver's browser coming back
  from a link it did not start) or before the approval burns it. A phished approval link therefore signs nobody in.
- **Roles.** The PayPal account's person is the **Owner**. Members join through **invite links** made by the Owner
  (one-time or multi-use, an expiry, and for reviewers an access end date; only the token's hash is stored, the token
  travels in the link's fragment), with a **passkey** (WebAuthn, `@simplewebauthn/server`) or for one browser only.
  The Owner lists and revokes members and invites; Owners cannot be revoked.
- **Sessions** are `HttpOnly; Secure; SameSite=Strict` cookies, HMAC-signed with `RESOLVEKIT_SESSION_SECRET`, valid
  12 h, naming the person and a session epoch: revoking a member, **Sign out of all devices** and the end of reviewer
  access end every session at once.
- **Only the seller answers.** `/api/health` lists the bound cases, and `/api/disputes/:case` reads them, only for
  the seller's workspace. On the fresh read before composing and before sending, the person's workspace merchant id
  must be the dispute's `seller.merchant_id` (403 `NOT_THE_SELLER` otherwise). The analysis of a real dispute is
  answered by `/progress` only to the seller's workspace.
- **Stored** in `<data>/accounts.json`: payer ids, display names, masked emails, passkey public keys, invite token
  hashes. A change that cannot be written is refused (503) and undone.

**Costs.** Two Starter instances plus 2 GB of disk (see render.com/pricing), PayPal sandbox (free), Gemini/Groq
usage within the daily caps. A disk rules out zero-downtime deploys (a few seconds of downtime per deploy) and
scaling beyond one instance. Judges' testing instructions: [`docs/judges.md`](docs/judges.md).

**Rehearse locally**: build the web app, then start both in hosted mode with fake Render variables, e.g. MeterMCP with
`METERMCP_MODE=hosted PORT=10001 RENDER_EXTERNAL_URL=http://localhost:10001 METERMCP_ADMIN_TOKEN=<32+ chars>
METERMCP_DATA_DIR=<dir>` and the server with `RESOLVEKIT_MODE=hosted PORT=10000 RENDER_EXTERNAL_URL=http://localhost:10000
RESOLVEKIT_DATA_DIR=<dir> METERMCP_URL=127.0.0.1:10001 METERMCP_ADMIN_TOKEN=<same> DEMO_CODE=<code>
BINDINGS_JSON=...` (both with `node --env-file-if-exists=.env …` for the PayPal and model keys), and open
http://localhost:10000.

## License

[MIT](LICENSE)
