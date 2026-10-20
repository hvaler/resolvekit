[English](paypal-integration.md) | [Español](../es/technical/paypal-integration.md)

# PayPal integration

Which PayPal APIs ResolveKit calls, with which credential, what it relies on, and what was only observed in the
sandbox. Code at commit `fbe9621`, the dispute actions at commit `076c74f` (20/10/2026); PayPal documentation checked
on 19/10/2026 (developer.paypal.com).

Three kinds of statement are kept apart on this page:

- **Documented**: stated by PayPal, with a link.
- **Observed in sandbox**: seen in our own sandbox tests, with the date. Sandbox behaviour is not generalised to
  production.
- **Unknown**: not documented and not settled.

**Everything below ran against the PayPal sandbox. Nothing has run against live PayPal.** The UI label «PayPal
sandbox · live» followed by a dispute id means a live read of a **sandbox** dispute.

## Credentials

| Credential | Variables | Owned by | Used for |
|---|---|---|---|
| Seller app | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | The sandbox business account that is the seller on the bound disputes ("Test Store" in our sandbox) | Dispute reads, provide-evidence, the dispute actions (send-message, accept-claim, make-offer, escalate), webhook verification (server); budgets, captures, voids (MeterMCP, same app); test payments (`demo:prepare`) |
| Identity app | `PAYPAL_IDENTITY_CLIENT_ID`, `PAYPAL_IDENTITY_CLIENT_SECRET` | **Another** sandbox business account (the platform) | **Continue with PayPal**: the no-charge agreement token only. Must differ from the seller app |
| Platform (Partner) app | none | — | **No code.** Partner Referrals and `PayPal-Auth-Assertion` were tried only outside the app: see [merchant onboarding](merchant-onboarding.md) |

Every client authenticates with OAuth 2.0 client credentials (`POST /v1/oauth2/token`), caches the token and
refreshes it 60 s before expiry. Requests time out after 30 s (the servers' setting).

## Endpoints actually called

| Endpoint | Caller | Credential |
|---|---|---|
| `POST /v1/oauth2/token` | `packages/paypal/src/client.ts` | each app its own |
| `GET /v1/customer/disputes/{id}` | server: case read, compose, send, bindings check, webhook re-read; `demo:prepare` | seller app |
| `GET /v1/customer/disputes?disputed_transaction_id={capture}` | `demo:prepare` only | seller app |
| `POST /v1/customer/disputes/{id}/provide-evidence` (multipart) | server, `POST /api/disputes/:case/evidence` | seller app |
| `POST /v1/customer/disputes/{id}/send-message` (JSON; multipart `input` + `message_document` with a file), `…/accept-claim`, `…/make-offer`, `…/escalate` (JSON) | server, `POST /api/disputes/:case/send` (Tested locally with fakes; Verified in sandbox through the app on a local server, 20/10/2026; not deployed) | seller app |
| `GET /v2/payments/refunds/{id}` | `npm run contract:read -- --refund <id>` only (read-only contract reads) | seller app |
| `POST /v1/notifications/verify-webhook-signature` | server webhook handler | seller app (the webhook is registered on it) |
| `POST /v1/billing-agreements/agreement-tokens`, `GET /v1/billing-agreements/agreement-tokens/{id}` | server sign-in | identity app |
| `POST /v2/checkout/orders` (intent `AUTHORIZE`), `GET /v2/checkout/orders/{id}`, `POST /v2/checkout/orders/{id}/authorize` | MeterMCP budget | seller app (on the MeterMCP service) |
| `GET /v2/payments/authorizations/{id}`, `POST …/capture`, `POST …/void`, `GET /v2/payments/captures/{id}` | MeterMCP settlement and reconciliation | seller app |
| `POST /v2/checkout/orders` (intent `CAPTURE`), `GET …`, `POST …/capture` | `demo:prepare` (the standard case's 7.00 USD test payment) | seller app |

The dispute actions (message, accept, offer, escalate) are sent by the server's action route, only for the variants
whose contract is recorded ([below](#dispute-action-contracts)); per-variant status is in the
[functional specification](../product/functional-specification.md#56-dispute-actions-other-than-evidence). No code
creates or changes a refund.

## Client behaviour

| Behaviour | Detail |
|---|---|
| `PayPal-Request-Id` | On every POST: the caller's id or a random one; a dispute-action POST requires one. An intent keeps one id for all its sends. Observed: `send-message` does **not** deduplicate on it (W-2, 20/10/2026); on the other routes it is **not verified**. The code reads the dispute back before any retry |
| 429 | Retried up to 3 attempts with the same id and body, waiting `Retry-After` (≤ 5 s). Dispute-action POSTs are **never** retried automatically: a 429, 408, 5xx, timeout or unclear answer is an unknown outcome, settled by a read-back |
| Failed GET | 408, 500, 502, 503, 504 retried after 300 ms and 900 ms |
| Other errors | Returned to the caller as `PayPalError` with status, body and `paypal-debug-id`; the API answers `{error, paypalIssue}` (e.g. `EVIDENCE_TYPE_IS_NOT_ALLOWED`) |
| Webhook verification | No retry: a delivery PayPal cannot confirm now is answered 503 and PayPal delivers it again |

## Disputes

### Reading and mapping

The server reads the bound dispute fresh (reused for 60 s as analyst input) and maps status, stage, reason,
buyer-declared item type, allowed seller actions (from the dispute's `links`: `provide_evidence`, `send_message`,
`make_offer`, `accept_claim`, `escalate`), evidence PayPal requests (`source: REQUESTED_FROM_SELLER`), every evidence
entry with its source, the response due date and the seller's merchant id. Status: Implemented · Tested locally ·
Verified in sandbox (09/10, 17/10/2026) · Deployed.

**Bindings.** A case is bound to `{dispute, capture}`. On every fresh read before composing and before sending, the
dispute must be the bound one, with exactly one disputed transaction that is the bound capture, and the disputed and
gross amounts equal to the case's amount and currency; missing data fails. A case can have a **reserve** (a list,
first active): a used dispute (resolved, or with seller evidence for more than 15 minutes) moves the case to the
next one on its next read, if the reserve is not empty. The standard case's reserve was empty on 19/10/2026 (new
sends Pending until it is refilled).

### Sending evidence

`provide-evidence` is multipart: a JSON part `input` holding `{"evidences":[…]}` and one `evidence-file` part per
file. ResolveKit sends `evidence_type`, `notes` (the supported sentences, ≤ 2 000 characters, its own limit) and,
for proof of fulfillment, `evidence_info.tracking_info` with carrier and tracking (carrier `OTHER` with
`carrier_name_other: "Digital delivery"` for the agent case). Files: the case's synthetic PDFs (headed «SYNTHETIC
TEST DOCUMENT»), the real MeterMCP receipt PDF for the agent case when a session exists, and the selected confirmed
uploads as `E<n>-upload.png` (`.jpg` for a covered photo), `E<n>-upload.pdf` or `E<n>-pasted.pdf` (the original file name never leaves the
server). The bytes sent are exactly those whose `sha256` the approval covers.

Documented: provide-evidence takes `multipart/form-data` with `evidence-file` parts; «In case the link is not
present in the response, you can't provide evidence for the dispute»; files `.jpg`, `.jpeg`, `.gif`, `.png`,
`.pdf`, «Less than 10 MB per file», «Up to 50 MB per API call»
([Disputes API](https://developer.paypal.com/docs/api/customer-disputes/v1/),
[spec](https://developer.paypal.com/api/customer-disputes/v1/schema.yaml),
[file types and sizes](https://developer.paypal.com/platforms/disputes/reference/supported-file-types-sizes)).
ResolveKit keeps each stored file under 9.9 MB and all files of one response under 50 000 000 bytes. Evidence types
per reason: [reasons and evidence](https://developer.paypal.com/disputes/reasons-evidence/).

After a send the server answers `202 {sent:true}`; that means PayPal accepted the request, not that the evidence is
recorded or the dispute is won. The web app reads the dispute back and shows **Recorded by PayPal** only for new
`SUBMITTED_BY_SELLER` / `PROVIDE_EVIDENCE` evidence that was not there before and matches what was sent (evidence
type, full notes, carrier and tracking, file names). New seller evidence that does not match is shown as such and
stops any automatic retry. A timeout is neither success nor failure: the app reads back, and offers a safe retry only
if PayPal shows no seller evidence. Status: Implemented · Tested locally · Verified in sandbox («6 of 6 fields»,
17/10 and 18/10/2026, including an uploaded image) · Deployed. Timeout behaviour against PayPal: Pending.

### Dispute action contracts

A dispute action variant is offered only when three things agree: PayPal's documentation (the Disputes v1
[schema](https://developer.paypal.com/api/customer-disputes/v1/schema.json),
[use the Disputes API](https://developer.paypal.com/platforms/disputes/handle-disputes/use-disputes-api),
[test and go live](https://developer.paypal.com/platforms/disputes/test-go-live), accessed 19/10/2026); read-only
sandbox reads (`packages/paypal/contracts/reads/`, taken with `npm run contract:read`, which sends only GET); and one
write per variant that the owner approved request by request, recorded with its response and its read-backs at
+0 s, +30 s, +2 min and +10 min (`packages/paypal/contracts/*.json`). The registry is
`apps/web/src/domain/actionContracts.ts`.

**Observed in sandbox, contract level (20/10/2026).** These writes were sent outside the app's own flow (the runs
through the app come after this table). Single observations, not PayPal rules and not production.

| Write | Variant | Sandbox dispute | Observed |
|---|---|---|---|
| W-1 | `send_message` | PP-R-VQD-10193598 | Accepted (JSON). The seller message appeared about 3 s after the send started, its content byte-identical. A brief `UNDER_REVIEW` with no actions, then `WAITING_FOR_BUYER_RESPONSE` without `make_offer` |
| W-2 | `send_message`, the same request and `PayPal-Request-Id` | same | A second message was posted: no deduplication by request id |
| W-3 | `send_message:file` | same | Multipart `input` (the JSON message) and `message_document` (the file) accepted; the message with its exact text and one document about 3.5 s after |
| W-4 | `make_offer:REFUND`, 2.00 of 7.00 USD | PP-R-OZY-10193601 | `offer.history` gained a seller `PROPOSED` entry with the type and amount about 3.5 s after; the note echoed as a seller message; no money moved, nothing closed. PayPal then waited for the buyer, stopped offering `make_offer` and offered accept `REFUND` only |
| W-5 | `escalate` | PP-R-NDZ-10193597 | An `evidences[]` entry `SUBMITTED_BY_SELLER`, `action_info.action: ESCALATE`, with the note, about 3.9 s after. Stage `CHARGEBACK` about 2 min 46 s later; `UNDER_REVIEW` with flickering links in between |
| W-6 | `evidence:after_escalation` | same, in `CHARGEBACK` | Evidence accepted again in the claim stage; each `evidences[]` entry carries its `dispute_life_cycle_stage` |
| W-7 | the sandbox's adjudicate helper (set-up for an appeal) | same, `UNDER_REVIEW` | Refused: `400`, `ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE`; no appealable state could be produced |
| W-8 | `appeal` | — | Not sent (W-7 was refused) |
| W-9 | `accept_claim:PARTIAL_REFUND`, 2.00 of 7.00 USD | PP-R-KMJ-10193602 | `200`, recorded as an offer: an `offer.history` seller `PROPOSED` entry, type `REFUND`, 2.00 USD; no `evidences[]` entry; nothing closed, no money moved; the note echoed as a seller message |
| W-10 | `accept_claim:REFUND` | PP-R-PAU-10193600 | An attributable entry (`ACCEPT_CLAIM`, `response_option: REFUND`, the note) about 5 s after; a 7.00 USD refund at once; `RESOLVED` in the buyer's favour (`SELLER_ISSUED_REFUND`) by +2 min, after `UNDER_REVIEW` |
| W-11 | `evidence:PROOF_OF_REFUND` | — | Not sent (owner decision, 20/10/2026); a pending test |
| W-12 | `make_offer:REPLACEMENT_WITHOUT_REFUND` | PP-R-GCV-10193596 (not as described) | Not sent: PayPal offered only `REFUND` and `REFUND_WITH_RETURN` on that dispute |

What ResolveKit takes from them: the proof of each action is the entry the write left (the message; the offer entry,
also for a partial accept; the `ACCEPT_CLAIM` entry; the `ESCALATE` entry), never a state change alone; an action is
taken as absent only after 60 s without proof; every action is composed only in `INQUIRY`, on not-received disputes for
accept, offer and escalate, because that is all the writes covered.

**Verified in sandbox through the app (20/10/2026).** After the contract writes, six variants were sent through
ResolveKit's own flow: the server of the unmerged branch `feat/dispute-actions` (head `9f93ba0`) running locally
against the sandbox, each run approved by the owner beforehand, each going compose → approve by hash → second
confirmation (when the action has terms) → one send → attributable read-back. One POST to PayPal per run, with GET
reads before and after (private evidence, 20/10/2026). Not deployed. Single observations, not PayPal rules.

| Run | Variant | Sandbox dispute | Observed through the app |
|---|---|---|---|
| V-1 | `send_message` | PP-R-GCV-10193596 | «Recorded by PayPal» about 1.5 s after the send; one seller message with the exact text; then `WAITING_FOR_BUYER_RESPONSE` without `make_offer`. The brief `UNDER_REVIEW` with no actions right after the send was not taken as a closure |
| V-2 | `make_offer:REFUND`, 2.00 of 7.00 USD | PP-R-BBF-10193789 | The second confirmation bound to the approved terms; «Recorded by PayPal»; one `offer.history` seller `PROPOSED` entry, `REFUND`, 2.00 USD; the note echoed as a seller message; no money moved |
| V-3 | `accept_claim:PARTIAL_REFUND`, 2.00 of 7.00 USD | PP-R-MDW-10193788 | «Recorded by PayPal» as a pending offer (`offer.history` seller `PROPOSED`, 2.00 USD); no `ACCEPT_CLAIM` entry, no outcome, no refund: no money moved |
| V-4 | `accept_claim:REFUND` | PP-R-TYE-10193787 | «Recorded by PayPal» from the attributable `ACCEPT_CLAIM` entry (`response_option: REFUND`, the note), not from the state change; `UNDER_REVIEW`, then `RESOLVED` in the buyer's favour (`SELLER_ISSUED_REFUND`) by about +2 min; a 7.00 USD sandbox refund. The only run that moved money |
| V-5 | `escalate` | PP-R-JHY-10193786 | «Recorded by PayPal» from the `ESCALATE` entry (the note, stage `INQUIRY`) about 1.5 s after; `UNDER_REVIEW` for about 10 min with `provide_evidence` flickering, never shown as closed; then `CHARGEBACK` · `WAITING_FOR_SELLER_RESPONSE` |
| V-6 | `evidence:after_escalation` | same, in `CHARGEBACK` | After one live analysis of the bound case, an edited sentence re-checked and a contradiction resolved by the owner: one `provide-evidence`, recorded as a `PROVIDE_EVIDENCE` entry in stage `CHARGEBACK` with 2 documents, next to the inquiry-stage `ESCALATE` entry |

Not verified through the app: `send_message:file` (the web composer cannot attach an upload yet; Tested locally on the
server, contract write W-3) and every «Not available» variant.

**W-11, the pending proof-of-refund test.** A disputed payment showed as held in the sandbox on 19/10/2026, and the
seller's sandbox web pages offered no refund outside the case. The planned sequence is therefore: a new sandbox
payment; the owner refunds part of it **before** any dispute opens; the buyer opens a not-received dispute on it; a
read-only check that the refund is completed, belongs to the disputed capture, has the same currency and is partial;
the exact `PROOF_OF_REFUND` request approved by the owner and sent once; read-backs at +0 s, +30 s, +2 min and
+10 min. Until then the variant stays «Not available».

### Lifecycle (documented)

Stages `INQUIRY`, `CHARGEBACK` (a PayPal dispute stage, not a card chargeback), `PRE_ARBITRATION`, `ARBITRATION`;
statuses `OPEN`, `WAITING_FOR_BUYER_RESPONSE`, `WAITING_FOR_SELLER_RESPONSE`, `UNDER_REVIEW`, `RESOLVED`, `OTHER`.
«the `WAITING_FOR_SELLER_RESPONSE` status indicates that you need to provide evidence»; the inquiry stage «lasts up
to 20 days unless escalated». Send message and make offer need the `INQUIRY` stage
([disputes reference](https://developer.paypal.com/docs/disputes/disputes-reference/),
[use the Disputes API](https://developer.paypal.com/platforms/disputes/handle-disputes/use-disputes-api)).

## Webhooks

`POST /api/paypal/webhook/<key>` exists in hosted mode when `PAYPAL_WEBHOOK_ID` and `PAYPAL_WEBHOOK_KEY` are set.

1. The key in the path is compared in constant time (any other key: 404 before the body is read).
2. The five transmission headers must be present, with the certificate URL on a PayPal API host.
3. The body (≤ 64 KiB, read within 10 s) must be a JSON event with a `WH-` id. Only `CUSTOMER.DISPUTE.*` events with
   a `PP-…` dispute id are verified; others are answered 200 and ignored. A repeated event id is answered 200
   (memory, 2 000 ids, lost on restart: a harmless re-read).
4. Verification is capped across all callers (60 per minute, 4 at once; over it 503) and uses PayPal's documented
   **postback** method, `verify-webhook-signature`, with the raw body spliced in byte for byte.
5. Then 200, and the event is only a hint: the server re-reads the dispute (after 0, 2 and 10 s), drops its cached
   read, records `paypal_notified` in the seller workspace's audit and keeps the latest 50 notices for that seller.

Documented: events `CUSTOMER.DISPUTE.CREATED`, `.UPDATED`, `.RESOLVED`
([event names](https://developer.paypal.com/api/rest/webhooks/event-names/)); two verification methods, of which
PayPal calls self-verification «the preferred method»; the listener must answer 2xx and PayPal retries «up to 25
times over 3 days»; simulator mock events can only be self-verified, so they do not pass ResolveKit's postback check
([webhooks](https://developer.paypal.com/api/rest/webhooks/rest/)). Which events the registered webhook subscribes
to is a PayPal-side setting, not checked in code.

Status: Implemented · Tested locally · Verified in sandbox (resent events and an automatic delivery, 17/10/2026) ·
Deployed.

## Sign-in token (identity app)

**Continue with PayPal** creates a no-charge Billing Agreements v1 agreement token with the identity app, sends the
merchant to approve it, reads it back and takes `payer_info.payer_id`. It is not Log in with PayPal and not an
OpenID or OAuth sign-in for the merchant; no agreement is created and nothing is charged. Flow and browser binding:
[trust boundaries](../architecture/trust-boundaries.md#continue-with-paypal-owner-sign-in-hosted).

Documented: Log in with PayPal is PayPal's identity product («OAuth 2.0 and OpenID Connect»,
[Log in with PayPal](https://developer.paypal.com/docs/log-in-with-paypal/)); Billing Agreements v1 is listed under a
deprecated path ([Billing Agreements](https://developer.paypal.com/docs/api/payments.billing-agreements/v1/)); no
current reference page for agreement tokens was found (19/10/2026). Observed in sandbox (10/10/2026): an approved
token read back `APPROVED` with a `payer_id` that, for a business account, matched the seller's merchant id on its
disputes; Log in with PayPal userinfo answered 400; a seller could not approve a token of its own app. Status:
Implemented · Tested locally · Verified in sandbox · Deployed. This approach may stop working (deprecated family).

## Orders and payments (MeterMCP)

| Step | Call | Detail |
|---|---|---|
| Budget | `POST /v2/checkout/orders` `AUTHORIZE` | One `DIGITAL_GOODS` item, `custom_id` = session id, `NO_SHIPPING`, return/cancel on MeterMCP |
| Approval check | `GET` order, `POST …/authorize` | Opens the session only for exactly one `CREATED` authorization of exactly the cap, own order, future `expiration_time` |
| Settlement | `POST /v2/payments/authorizations/{id}/capture` with `final_capture: true` | Exactly the sum of OK calls; `invoice_id <session>-settle` |
| Nothing used | `POST …/void` | |
| Pending capture | `GET /v2/payments/captures/{id}` | Every 30 s, on demand, on close |

Documented: «An authorization places a hold on the funds and is valid for 29 days», with a 3-day honor period
([authorization](https://developer.paypal.com/docs/checkout/standard/customize/authorization/)); «You can capture
any amount up to the authorized total», «The remainder can be voided or left to expire»
([delay capture](https://developer.paypal.com/checkout/delay-capture/)); `final_capture` «Indicates whether you can
make additional captures against the authorized payment»
([Payments v2 spec](https://developer.paypal.com/api/payments/v2/schema.yaml)). Observed in sandbox (08/10, 09/10
and 19/10/2026): a partial capture with `final_capture: true` left the authorization `CAPTURED` and the remainder no
longer held; an unused authorization voided to `VOIDED`. That the remainder is released to the buyer is observed,
not quoted from PayPal. Capture `PENDING` outcomes: not observed, Pending.

## Sandbox findings

Moved here from the former `docs/sandbox-findings.md`. Verified by hand in the PayPal sandbox with a sandbox app, a
business test account and a personal (buyer) test account. Observations, not PayPal rules.

### 08/10/2026

| Finding | Design consequence |
|---|---|
| The plain dispute list does not include `disputed_transactions`; filter with `disputed_transaction_id={capture}` | Look disputes up by capture |
| A dispute opened by the buyer took about 5 minutes to appear in the API (PayPal: «wait a few minutes», [test and go live](https://developer.paypal.com/platforms/disputes/test-go-live)) | "Syncing with PayPal" state; demo disputes are created ahead of time |
| A new dispute first shows `UNDER_REVIEW` with no seller actions, then `WAITING_FOR_SELLER_RESPONSE` | "PayPal is processing this new dispute" state |
| Each dispute lists the evidence PayPal requests from the seller (`source: REQUESTED_FROM_SELLER`) | Show «PayPal is asking for…» and send that type |
| For "item or service not received", PayPal requested `PROOF_OF_FULFILLMENT` even when the buyer declared a service, and rejected `PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED` with `EVIDENCE_TYPE_IS_NOT_ALLOWED` (consistent with PayPal's reasons table, which does not list that type for this reason) | Evidence type follows PayPal's request; digital delivery goes as carrier `OTHER` with a reference |
| The item type (physical, digital download, service, booking) is the buyer's choice in the dispute form, not the order's item category | Show the buyer-declared item type in the case header |
| `provide-evidence` takes multipart: JSON part `input` (`{"evidences":[…]}`) and `evidence-file` parts (PDF/JPG/PNG/GIF) | Implemented in `packages/paypal` |
| After evidence was submitted, `provide_evidence` disappeared from the dispute's actions; status moved to `WAITING_FOR_BUYER_RESPONSE` or `UNDER_REVIEW` | Irreversible-action confirmation; re-read and show the recorded state. «Once per dispute» is this observation, not a documented rule |
| In the inquiry stage the seller had `send_message`, `make_offer`, `accept_claim`, `provide_evidence`, `escalate` | The review screen lists the allowed actions; then only provide-evidence was built (the other actions since: [dispute action contracts](#dispute-action-contracts)) |
| Partial refunds on a capture completed immediately (by hand) | None: ResolveKit has no refund code |
| A real dispute always lists the buyer's own entry (`evidence_type: CREATE`, `source: SUBMITTED_BY_BUYER`) next to PayPal's request (`REQUESTED_FROM_SELLER`, no documents) | «Recorded» is only new `SUBMITTED_BY_SELLER` evidence compared with the read before sending |

### 09/10/2026: end-to-end submission through ResolveKit

`PROOF_OF_FULFILLMENT` (UPS tracking, 502-character notes, two generated PDFs) was sent to a "not received" dispute
in `WAITING_FOR_SELLER_RESPONSE` through `apps/server`, with our own `PayPal-Request-Id`. The send took about 1.9 s
(read and multipart POST); PayPal accepted it, and the read-back about 2.5 s later already showed:

| Finding | Design consequence |
|---|---|
| The seller's entry came back as `source: SUBMITTED_BY_SELLER`, `action_info.action: PROVIDE_EVIDENCE`, with the tracking, the notes verbatim and `documents[]` (file name and download URL) | The read-back compares type, carrier, tracking, file names and the full notes; all six fields matched |
| Right after the submission the status was `UNDER_REVIEW` with no seller actions; about a minute later `WAITING_FOR_BUYER_RESPONSE` with `send_message`, `accept_claim`, `escalate` | Show the status PayPal returns at read-back time; never infer the final state. Timings vary |
| Once seller evidence was in, the `REQUESTED_FROM_SELLER` entry and `seller_response_due_date` were no longer returned | «Nothing requested» does not mean PayPal still wants something; the due date leaves the case header |

### 10/10 to 19/10/2026

| Date | Observation |
|---|---|
| 10/10 | Identity token approach works in the sandbox (see above) |
| 17/10 | Two reviewers sent evidence through the deployed service; read-back «Recorded by PayPal», 6 of 6 fields. Webhook deliveries verified |
| 18/10 | An uploaded, covered PNG was recorded by PayPal as `E7-upload.png`; PayPal's copy held only the PNG's image chunks, cover burned in |
| 18/10 | Platform / third-party access tests outside the app: [merchant onboarding](merchant-onboarding.md) |
| 19/10 | Two model-driven agent runs settled in the sandbox: [buying agent](buying-agent.md) |
| 19/10 | A payment with an open dispute showed as held; the seller's sandbox web pages offered no refund outside the case |
| 20/10 | Owner-approved contract writes W-1 to W-12: [dispute action contracts](#dispute-action-contracts) |
| 20/10 | Six variants sent once each through ResolveKit's own flow (local server of the unmerged branch) and read back, V-1 to V-6; only V-4 moved money (a 7.00 USD refund): [dispute action contracts](#dispute-action-contracts) |

## Unknown and not claimed

- Whether evidence can be provided more than once per dispute or stage in general.
- Whether the Disputes API deduplicates `PayPal-Request-Id` on routes other than `send-message`, which did not (W-2)
  (PayPal: «Not all APIs support this header»,
  [idempotency](https://developer.paypal.com/api/rest/reference/idempotency/)).
- What the buyer's answer to an offer looks like in the dispute (never recorded); the dispute actions on other reasons
  and stages; an appeal (the sandbox could not produce an appealable dispute); a replacement offer (never offered).
- Any notes length limit on PayPal's side; the 2 000-character cap is ResolveKit's.
- The maximum number of files per call.
- Live-environment behaviour of everything on this page.
