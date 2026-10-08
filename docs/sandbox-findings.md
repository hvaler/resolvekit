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
