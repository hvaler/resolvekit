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
| `GET /api/disputes/{case}` | Reads the real dispute bound to the case and maps it: status, stage, reason, buyer-declared item type, allowed seller actions, evidence PayPal requests, every evidence entry with its source, response due date |
| `POST /api/disputes/{case}/evidence` | Reads the dispute first, then checks: `provide_evidence` is offered now, the type is the one PayPal requests, notes ≤ 2,000 characters, tracking for proof of fulfillment. Builds the PDFs on the server from the case's synthetic documents (headed "SYNTHETIC TEST DOCUMENT") and sends them. Answers `202 { sent: true }` or `{ error, paypalIssue }` (e.g. `EVIDENCE_TYPE_IS_NOT_ALLOWED`) |

The send never reports "recorded". The web app reads the dispute back and only shows **Recorded by PayPal** when PayPal
lists new evidence `SUBMITTED_BY_SELLER` (`PROVIDE_EVIDENCE`) that was not there before sending. The buyer's own entry
and PayPal's request never count.

**Real or simulated, per case.** A case runs on real PayPal only when it is bound to a real dispute in
`apps/server/bindings.json` *and* `/api/health` reports the sandbox (or live) connected. Every other case runs on the
in-browser simulator and is never sent to PayPal. The app bar says which: **PayPal sandbox · live `PP-R-…`** or
**Simulated PayPal**. Simulated read-backs say *Recorded by the PayPal simulator*.

On a bound case every PayPal field (amount, reason, buyer-declared item type, stage, status, due date, disputed
transaction, requested evidence, allowed actions) comes from the latest PayPal read, in the case header and the inbox
row alike; only the merchant side (order, documents, timeline, the analyst's draft) comes from the demo case. Before
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
npm test               # packages/paypal + apps/server (node --test, no network) + apps/web (vitest)
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
npm test           # packages/paypal + apps/server (node --test) + apps/web (vitest)
```

In development a small **Dev · simulator** control (bottom left; hidden on cases running on real PayPal) picks what the simulated PayPal does after evidence is
submitted: *Waiting for buyer*, *Under review*, or *Timeout* (read back, then safe retry). It can also make PayPal
open the new dispute now (otherwise it opens after ~75 s) or simulate PayPal being unreachable. In other builds add
`?dev` to the URL, or `?outcome=under_review|timeout` to preselect it.

## AI tools

To be documented as the analyst is built: model, what it does, and how its output is checked.

## License

[MIT](LICENSE)
