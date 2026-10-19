# More dispute actions (B): design

Status: approved by the owner on 19/10/2026, revised the same day with the owner's seven adjustments (sections marked **[A1]–[A7]**). Builder's calls are marked *(builder's call)*.

## Intent

Today ResolveKit can answer a PayPal dispute in one way: provide evidence. PayPal offers more: send the buyer a message, accept the claim, make an offer, escalate an inquiry to a claim, appeal. A merchant who has to leave ResolveKit for those loses the core promise: **nothing goes to PayPal that the merchant did not approve exactly, and ResolveKit says «Recorded by PayPal» only when PayPal's read-back proves it.** B extends that promise to the other actions without weakening it for any of them.

For the hackathon this can make true the form's claim about sending messages and accepting claims (F12), and replace the unsupported «Refunds use Payments v2» (F15) with refunds through dispute actions, **only for what is actually verified**.

## Goals

1. One generalised intent: compose on the server → approve the exact content hash → synchronous claim → fresh PayPal read with send-time re-checks → durable `send_started` → POST → read-back with per-action proof. Same chain for every action (today: `apps/server/src/app.ts` `sendIntent`, `apps/server/src/intents.ts` `IntentStore`, `apps/web/src/domain/intent.ts`, `apps/web/src/domain/recorded.ts`).
2. Candidate actions, in this order: send_message; accept_claim; escalate; make_offer; appeal; PROOF_OF_REFUND evidence. **Each ships only for the variants its verified contract supports [A2].**
3. Available actions are always **rebuilt from a fresh PayPal read** (HATEOAS links, `allowed_response_options`, stage, status) — before compose, at send time, and after every action **[A1]**.
4. Read-back per action with a specific proof, and an honest «Outcome pending confirmation» when the proof is not there **[A4]**.

## Non-goals

- **No Payments v2 refund creation** (risk of paying twice; undocumented interaction with an open dispute). PROOF_OF_REFUND only *reads* an existing refund **[A6, A7]**.
- No live PayPal. Sandbox only.
- No automatic AI decisions. The analyst may suggest text; rules decide what is offered; the merchant edits and approves the final text. The hash covers the approved text, never raw model output.
- **No variant built on assumption [A2]:** partial accept, offer withdrawal, return-address types, and anything else not confirmed by PayPal's documentation **and** a recorded sandbox contract is shown as «Not available» with the reason.
- No change to existing provide-evidence intent hashes.

## Decided by the owner (19/10/2026)

- **Order:** B before A.
- **Judges on Test Store:** may send **messages only**; other actions are a non-sendable preview with their consequence.
- **Owner only** for money-moving or stage-changing actions (accept_claim, make_offer, escalate, appeal), with a second confirmation bound to the intent **[A3]**.
- **Explore demo:** the new actions are simulated, but **only the states defined by recorded contracts [A7]**; the simulator never invents behaviour to complete the demo.
- **Message thread:** shown to the merchant from each PayPal read, not persisted, not passed to the analyst (see retention **[A5]**).
- Work on a branch; final whole-branch review presented to the owner before integrating **[A7]**.

## [A2] Contracts before flows

Before any action's end-to-end flow is built, its **contract** is established and recorded under `PayPalAI/evidencia/` (no ids that identify real people; sandbox ids are fine):

1. **Documentation:** PayPal's reference and schema for the route (URLs, required fields, allowed types per reason/stage, field limits, body format JSON vs multipart).
2. **Read-only sandbox reads** (allowed without asking: GET only) on existing owner sandbox disputes in the relevant states: the fields that show allowed options, the message thread, offer history, stage/status/outcome, and the shape of entries that could prove the action (actor, time, type, amount).
3. **One prepared write per action variant**, presented to the owner as the exact request (route, headers except credentials, body, target sandbox dispute, expected result) and run **only after the owner's specific approval of that request**. Its response and the following read-back are recorded.

A variant enters the product only if 1–3 agree. Otherwise it is «Not available» with the reason, in product, simulator and docs.

## [A1] Locks: duplicates and conflicts, not inferred closure

Local state only prevents duplicates and conflicting concurrent writes. **PayPal's fresh read decides what is possible next.**

- **In-flight:** one send at a time per dispute, across all actions.
- **Uncertain:** a send whose outcome is not proven (POST timed out or errored ambiguously, restart between `send_started` and an outcome, read-back without proof) puts the dispute in `uncertain`: no new write on that dispute until it is reconciled by a read-back that proves the action recorded **or** proves it absent while the action is still available. Uncertain is **never** turned into «closed».
- **Duplicate guard:** the same action with the same content on the same dispute and stage is refused once recorded (e.g. the same message text sent twice in a row must be a new, explicitly re-approved intent; the same offer while one is pending is refused).
- **provide_evidence:** keeps its existing behaviour within a stage; after a stage change PayPal may allow evidence again (e.g. after escalation), and then a new evidence intent is allowed if the fresh read offers `provide_evidence` and shows no seller evidence **in the current stage**. The existing sent memory becomes keyed by (dispute, stage); entries without a stage keep blocking the whole dispute (backward compatible).
- **escalate** changes the stage; it does not create a closed-dispute lock.
- **Full-refund offer:** no assumption that it closes; its behaviour comes from its contract.
- All lock state is seeded on start from the durable send log (`audit-events-sends.jsonl`), as lote2 does for the sent memory, and every send event records action, stage and lock scope.

## [A3] Exact approval, also for the second confirmation

- The owner's second confirmation is a server-issued step **bound to the same intent**: it covers `intentId`, `contentHash`, action, canonical amount, currency, and a consequence code (e.g. `REFUNDS_BUYER`, `MOVES_TO_CLAIM`). Changing any of them requires a new intent.
- The server checks the role **at compose, approve, confirm and send**; hidden buttons are not a control.
- **Amounts:** exact decimal strings, never floats. Canonical form per currency (minor-unit exponent from a table: USD/EUR/GBP 2, JPY 0, …; unknown currency → refused). Input must match `^\d+(\.\d{1,e})?$` for the currency's exponent `e`; commas, spaces, signs, exponents, leading `+`, too many decimals, or empty → refused with a clear message (no guessing). Stored and hashed as the canonical string: `7` is unambiguous and becomes `7.00`; `7,00` is refused. Compared as integer minor units. Amount must be > 0 and ≤ the dispute amount, same currency.

## [A4] Read-back proof per action

«Recorded by PayPal» requires a proof attributable to **this** send. A state change alone can come from another actor (buyer, PayPal) and is not proof.

| Action | Proof required (fields confirmed by the contract) | Otherwise |
|---|---|---|
| send_message | a new `messages[]` entry `posted_by: SELLER`, posted after `send_started`, absent from the pre-send read, whose content equals the approved text under the normalisation the contract shows PayPal applies | «Outcome pending confirmation» |
| make_offer | a new offer-history entry by the seller, after `send_started`, with the approved type and amount | pending |
| accept_claim | an entry attributable to the seller's acceptance (field from the contract), not just `RESOLVED` | pending |
| escalate | an attributable escalation record by the seller, or a stage change **plus** an attribution field from the contract; a bare stage change is not enough | pending |
| appeal | an attributable seller appeal entry from the contract | pending |
| PROOF_OF_REFUND | as provide-evidence today | as today |

- «Outcome pending confirmation» keeps the dispute `uncertain` (no new writes, no blind resend) and offers «Check again».
- **Idempotency:** `PayPal-Request-Id` is sent, but not assumed to deduplicate on any route unless its contract shows it. A retry is allowed only after a read-back proves the action absent and still available.

## [A5] Message retention and changes after approval

- The **thread** read from PayPal is shown, cached like other reads, never persisted, never given to the analyst.
- The **approved message** (the merchant's own text, ≤ 2,000 characters, plus optional confirmed-upload reference) **is stored in the intent** — like the approved notes of evidence today — because it is needed to send, to retry after proven absence, and to reconcile the read-back. It lives as long as the intent's record (same retention as evidence notes in `intents.json`); audit and send logs keep only its hash. Docs say exactly this; «not stored» applies to the thread only.
- **A new buyer message after approval:** for send_message, make_offer and accept_claim it is relevant (the merchant may be answering an outdated message), so the send is held with `409 NEEDS_REVIEW` showing the new message; the merchant re-confirms the same content (one step) or edits (new intent). For escalate and appeal it is shown but does not block. **Irrelevant changes never invalidate an approval:** read time, link order, the merchant's own recorded messages, fields not in the hash.

## [A6] PROOF_OF_REFUND reads, never refunds

- The merchant types the refund id(s). The server reads each with a read-only `GET /v2/payments/refunds/{id}` and requires: status `COMPLETED`; the refund belongs to the **disputed capture** (via its links/capture id); same currency; amount > 0.
- If the refunded total is less than the dispute amount, it is presented as a **partial refund** («Partial refund of X of Y USD») in the evidence notes and UI; never as full resolution. Full refund only when equal.
- No call that creates or changes a refund.

## [A7] Implementation vs availability

- Each action/variant carries one of: Not available (with reason) · Implemented · Tested locally · Verified in sandbox · Deployed. Docs and the form use these; a variant is never described beyond its status.
- The simulator reproduces only the contract-recorded states and transitions, including «Outcome pending confirmation».

## Earlier calls kept *(builder's call, owner-approved 19/10)*

- **Owner end to end** for money-moving/stage-changing actions; members and reviewers get a preview; compose refused with `403` for them; reviewers can compose/approve/send messages.
- **Owner-only settlement case** bound through `BINDINGS_JSON` with its own reserve; read-back targets the dispute id pinned in the intent; rotation (`rotateIfUsed` and `reserve.apply()`, including a wholesale bindings reload) never moves a case off a dispute that is in flight, uncertain, or awaiting read-back.
- **Return-address types:** not available in this delivery.
- **Read-back location:** server-side for the new actions; provide-evidence keeps its web matcher.
- **Hosted caps:** `message` and `settle` daily caps next to the existing ones.

## Failure modes to handle

Link gone or stage changed between compose and send; type no longer allowed; amount ambiguous, above the dispute amount, or wrong currency; new buyer message after approval; PayPal 4xx with a known code (shown plainly, intent not marked sent, dispute not uncertain if the error proves nothing was done); ambiguous error or timeout (→ uncertain); persistence failure before the POST (no POST); restart between `send_started` and outcome (→ uncertain → reconcile); a state change made by another actor (not taken as proof).

## Tests

Hash per action; cross-action replay refused; existing provide-evidence hashes unchanged (golden: `63fe9916…83b9c8` plain, `ee7919f7…58d12dec` with corrections); second-confirmation binding (any field change refused); role checks at every step; amount parser matrix (`7`→`7.00`, `7.5`→`7.50`, refused: `7,00`, `7.001`, `-1`, `1e2`, ` 7`, `+7`, `0`, empty, unknown currency); lock matrix incl. uncertain and evidence-after-escalation; read-back matchers incl. identical earlier message, other-actor state change, normalisation; new-buyer-message hold; restart and send-log seeding; rotation guard; simulator states only from contracts; no PayPal calls in the suite (fakes built from recorded contract responses).

## Left to the builder

File layout, naming, exact cap values, UI layout within the existing design system, task split.
