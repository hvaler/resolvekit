# PayPal dispute-action contracts

What PayPal's documentation says and what the PayPal **sandbox** actually returned, for each dispute action
ResolveKit may send besides evidence (design: `docs/superpowers/specs/2026-10-19-dispute-actions-design.md`, [A2]).
Tests build their fakes from these files; no test calls PayPal.

A variant becomes available (`apps/web/src/domain/actionContracts.ts`) only when three things agree:

1. **Documentation**: route, fields, body format, limits.
2. **GET reads** of sandbox disputes in the relevant states (this folder, `reads/`).
3. **One write approved by the owner**, request by request, with its response and its read-back. None has been sent yet:
   every variant is «Not available»: «Contract not recorded yet», except offer withdrawal («PayPal documents no route to
   withdraw an offer») and the return-address types («Not in this delivery (owner decision)»).

## Reads (`reads/`)

Taken with `npm run contract:read` (`apps/server/scripts/contract-read.ts`) on 2026-10-19. The script sends only GET
(and the OAuth token request) and refuses anything else before the network. Each file is **redacted**: names, emails,
addresses, phone numbers and payer ids other than the seller's are removed, and text the buyer wrote is replaced by
`<buyer message, N chars>`. Sandbox dispute, transaction, capture and refund ids are kept. The seller's own text is kept,
because the read-back proof compares it.

| File | Dispute | State when read |
|---|---|---|
| `list.json` | the seller's 10 sandbox disputes | summaries (`GET /v1/customer/disputes?page_size=50`) |
| `inquiry-waiting-seller-KHH.json` | PP-R-KHH-10193360 | INQUIRY · WAITING_FOR_SELLER_RESPONSE · no seller response yet (bound to a hosted case) |
| `inquiry-waiting-seller-PFB.json` | PP-R-PFB-10190726 | INQUIRY · WAITING_FOR_SELLER_RESPONSE · no seller response yet |
| `inquiry-after-evidence-HOA.json` | PP-R-HOA-10193276 | INQUIRY · WAITING_FOR_BUYER_RESPONSE · after seller evidence (bound to a hosted case) |
| `inquiry-after-evidence-UVK.json` | PP-R-UVK-10193275 | INQUIRY · WAITING_FOR_BUYER_RESPONSE · after seller evidence |
| `inquiry-after-evidence-TVH.json` | PP-R-TVH-10190665 | INQUIRY · WAITING_FOR_BUYER_RESPONSE · after seller evidence **and a seller message** (sent 2026-10-08) |
| `inquiry-waiting-buyer-VIJ.json` | PP-R-VIJ-10190671 | INQUIRY · WAITING_FOR_BUYER_RESPONSE · after seller evidence (1.37 USD) |
| `inquiry-waiting-buyer-WRK.json` | PP-R-WRK-10190674 | INQUIRY · WAITING_FOR_BUYER_RESPONSE · after seller evidence (12.00 USD) |
| `resolved-GFC.json` | PP-R-GFC-10190664 | INQUIRY · RESOLVED · RESOLVED_BUYER_FAVOUR after a **seller accept-claim** (2026-10-08) |
| `refund-3H730369N6162525E.json` | refund of PP-R-GFC-10190664 | COMPLETED 8.00 USD, `up` link to capture 3B183641GA9842414 |

Every sandbox dispute seen is `MERCHANDISE_OR_SERVICE_NOT_RECEIVED` in the INQUIRY stage. No claim-stage
(CHARGEBACK), appeal-stage, not-as-described, offer or escalation state exists yet in this sandbox account.

## What the reads show

- **Allowed options**: HATEOAS `links[].rel` (`accept_claim`, `provide_evidence`, `send_message`, `escalate`,
  `make_offer`) and `allowed_response_options.accept_claim.accept_claim_types` / `.make_offer.offer_types`. Before
  seller evidence: accept `PARTIAL_REFUND`, `REFUND`; offer `REFUND` (not-received disputes offer no other type). After
  seller evidence (WAITING_FOR_BUYER_RESPONSE): `provide_evidence` and `make_offer` are gone, accept is `REFUND` only,
  `send_message` and `escalate` remain.
- **Thread**: `messages[]` with `posted_by` (BUYER, SELLER), `time_posted`, `content`. The buyer's opening message is
  also an `evidences[]` entry `evidence_type: CREATE`, `source: SUBMITTED_BY_BUYER`.
- **Offer**: `offer.buyer_requested_amount` only; no `offer.history` has been seen (no offer was ever made).
- **Stage, status, outcome**: `dispute_life_cycle_stage`, `status`, `dispute_state`, `dispute_outcome.outcome_code`,
  `.outcome_reason`, `.amount_refunded`, `refund_details.allowed_refund_amount` and `.transactions[]` (refund id, amount,
  time), `money_movements[]`, `fund_movements[]`. `adjudications[]` is absent in every read.
- **Possible proofs**: a seller message (`messages[]`, SELLER, `time_posted`, `content` stored as sent); an accepted
  claim (`evidences[]` entry SUBMITTED_BY_SELLER, `date`, `action_info.action: ACCEPT_CLAIM`, `action_info.response_option`,
  `notes` = the note) plus `refund_details.transactions[]`; seller evidence (`evidences[]` SUBMITTED_BY_SELLER, `date`,
  `action_info.action: PROVIDE_EVIDENCE`, stage).

The full per-action notes, with documentation links and what is still unknown, are in the evidence folder
(`PayPalAI/evidencia/contrato-<action>-2026-10-19.md`); the writes prepared for the owner are in
`escrituras-preparadas-acciones-2026-10-19.md`.
