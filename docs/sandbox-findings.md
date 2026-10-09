# PayPal sandbox findings

Verified by hand in the PayPal sandbox on 2026-10-08, with a sandbox app, a business test account and a personal
(buyer) test account. Each finding shaped a design decision.

| Finding | Design consequence |
|---|---|
| The plain dispute list does not include `disputed_transactions`; filter with `disputed_transaction_id={capture}` | Look disputes up by capture |
| A dispute opened by the buyer takes ~5 minutes to appear in the API | "Syncing with PayPal" state; demo disputes are created before recording |
| A new dispute first shows `UNDER_REVIEW` with no seller actions, then moves to `WAITING_FOR_SELLER_RESPONSE` | Design a "PayPal is processing this new dispute" state |
| Each dispute lists the evidence PayPal requests from the seller (`source: REQUESTED_FROM_SELLER`) | Show "PayPal is asking for…" and send that type |
| For "item or service not received", PayPal requests `PROOF_OF_FULFILLMENT` **even when the buyer declared a service**, and rejects `PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED` with `EVIDENCE_TYPE_IS_NOT_ALLOWED` | Evidence type follows PayPal's request; digital delivery goes as carrier `OTHER` with a reference |
| The item type (physical, digital download, service, booking) is chosen by the buyer in the dispute form, not taken from the order's item category | Show the buyer-declared item type in the case header |
| `provide-evidence` takes multipart: a JSON part `input` (`{"evidences":[…]}`) and file parts `evidence-file` (PDF/JPG/PNG/GIF) | Implemented in `packages/paypal` |
| After evidence is submitted, `provide_evidence` disappears from the dispute's actions; status moves to `WAITING_FOR_BUYER_RESPONSE` or `UNDER_REVIEW` | Irreversible-action confirmation; re-read and show the recorded state |
| In the inquiry stage the seller can `send_message`, `make_offer`, `accept_claim`, `provide_evidence`, `escalate` | Action selector driven by the dispute's links |
| Partial refunds on a capture complete immediately | Refund action |
| A real dispute always lists the buyer's own entry (`evidence_type: CREATE`, `source: SUBMITTED_BY_BUYER`) next to PayPal's request (`REQUESTED_FROM_SELLER`, no documents) | "Recorded" is only new `SUBMITTED_BY_SELLER` evidence compared with the dispute read before sending |

### End-to-end submission through ResolveKit (2026-10-09)

Sent `PROOF_OF_FULFILLMENT` (UPS tracking, 502-character notes, two generated PDFs) to a "not received" dispute in
`WAITING_FOR_SELLER_RESPONSE` through `apps/server`, with our own `PayPal-Request-Id`. The send took ~1.9 s
(read + multipart POST), PayPal accepted it, and the read-back ~2.5 s later already showed:

| Finding | Design consequence |
|---|---|
| The seller's entry comes back as `source: SUBMITTED_BY_SELLER`, `action_info.action: PROVIDE_EVIDENCE`, with the tracking info, the notes verbatim and `documents[]` holding each file name plus a download URL | The read-back compares type, carrier, tracking, file names and the full notes text; all six fields matched |
| Immediately after the submission the status is `UNDER_REVIEW` with **no** seller actions; about a minute later it is `WAITING_FOR_BUYER_RESPONSE` with `send_message`, `accept_claim`, `escalate` | Show the status PayPal returns at read-back time and keep polling; never infer the final state |
| Once seller evidence is in, the `REQUESTED_FROM_SELLER` entry disappears and `seller_response_due_date` is no longer returned | Do not treat "nothing requested" as "PayPal wants anything"; the due date leaves the case header |

