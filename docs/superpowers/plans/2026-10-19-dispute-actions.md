# More Dispute Actions (B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend ResolveKit's evidence chain to the other dispute actions (send message, accept claim, escalate, make offer, appeal, PROOF_OF_REFUND). Each action ships only for the variants whose PayPal contract is recorded, and is reported «Recorded by PayPal» only on a proof attributable to that send.

**Architecture:**
- **Contracts first.** Every action variant gets a recorded contract before its flow is built: PayPal's documentation, read-only sandbox reads, and one write the owner approved. Each contract is a committed JSON file under `packages/paypal/contracts/`, listed in `apps/web/src/domain/actionContracts.ts`. That registry says which variants are available, which body format each one uses, and which read-back fields prove it.
- **Shared rules.** Pure modules in `apps/web/src/domain/` (`actions.ts`, `amounts.ts`, `actionReadback.ts`) hold the rules. The server (`apps/server/src/actions/`) and the in-browser simulator both use them.
- **Local state never decides what is possible next.** The intent store only prevents duplicates and conflicts: in-flight, uncertain, the duplicate guard, and the evidence sent memory keyed by (dispute, stage). What can be done next always comes from a fresh PayPal read.
- **Provide-evidence keeps its route, hash and web matcher.**

**Tech Stack:** TypeScript on Node ≥ 24 (type stripping, `node:test`) for `apps/server` and `packages/*`. React + Vitest 5 (`renderToString`) for `apps/web`. PayPal Disputes API v1 and the read-only Payments v2 call `GET /v2/payments/refunds/{id}`. Bilingual Markdown docs.

**Spec:** `docs/superpowers/specs/2026-10-19-dispute-actions-design.md` (approved 19/10/2026, revised with the owner's adjustments [A1]–[A7]). Executors read the spec and this plan.

## Global Constraints

- Sandbox only. Implementers **never** send a sandbox write. Only GET reads are allowed without asking (Task 2). Every write is a prepared request that the controller runs after the owner's specific approval of that request (Tasks 3 and 15).
- No PayPal and no paid calls in the test suite. Fakes are built from the recorded contract responses in `packages/paypal/contracts/`.
- **No variant built on assumption [A2].** A variant whose contract is not recorded is «Not available» with its reason, in the product, the simulator and the docs. This covers partial accept, offer withdrawal, return-address types, evidence after escalation, and any other variant without a contract.
- **No Payments v2 refund creation.** PROOF_OF_REFUND only reads (`GET /v2/payments/refunds/{id}`).
- **Hash compatibility.** `action` and the per-action payload are hashed only when the action is not `provide_evidence`. Golden: `63fe9916f41178e78070ee0d030a3e7d7791adeb9a61e925ecb352daab83b9c8` (plain) and `ee7919f7a34f78f2d314d1f400d6b856226c51167bdc952c4e5048bd58d12dec` (with corrections). `apps/web/src/domain/intent.ts` is unchanged between `dcd74c6` and main `6e4b40e`.
- **No replay across actions.** The hash covers the dispute id, seller, stage, status, dispute amount and currency at compose time. Drift at send time → `409 INTENT_STALE`.
- **Locks [A1].**
  - In-flight: one send at a time per dispute, across all actions.
  - Uncertain: an unproven outcome blocks every write on the dispute until a read-back proves the action recorded, or proves it absent while still available. Uncertain is never turned into «closed».
  - Duplicate guard.
  - Evidence sent memory is keyed by (dispute, stage). Entries without a stage block the whole dispute.
  - Escalate creates no closure lock.
  - Nothing is assumed about a full-refund offer.
  - All lock state is seeded from `audit-events-sends.jsonl`.
- **Roles.** accept_claim, make_offer, escalate and appeal are owner only. The server checks the role at compose, approve, confirm and send, and refuses with `403 OWNER_ONLY`. Reviewers and members send evidence and messages.
- **Second confirmation [A3].** It is server-issued and bound to `intentId`, `contentHash`, action, canonical amount, currency and consequence code. Any difference means a new intent.
- **Amounts [A3].** Amounts are exact decimal strings, never floats, with the minor-unit exponent taken from a table (USD/EUR/GBP 2, JPY 0; an unknown currency is refused). Input must match `^\d+(\.\d{1,e})?$`. Values are compared as integer minor units and must be > 0, ≤ the dispute amount and in the same currency.
- **Read-back proof [A4].** «Recorded by PayPal» needs a proof attributable to this send. Otherwise the result is «Outcome pending confirmation»: the dispute stays uncertain, the UI offers «Check again», and nothing is resent blindly. `PayPal-Request-Id` is sent but not assumed to dedupe, unless the contract shows that it does.
- **Messages [A5].** The approved message text is stored in the intent, like evidence notes. Audit and send logs keep only its hash. The thread is shown, never persisted and never given to the analyst. A new buyer message after approval holds send_message, make_offer and accept_claim with `409 NEEDS_REVIEW`. It does not hold escalate or appeal. Irrelevant changes never invalidate an approval.
- **PROOF_OF_REFUND [A6].** The refund must be COMPLETED, on the disputed capture, in the same currency and with amount > 0. A total below the dispute amount is presented as «Partial refund of X of Y USD».
- **Status [A7].** Every variant carries one of: Not available (reason) · Implemented · Tested locally · Verified in sandbox · Deployed. The simulator reproduces only contract-recorded states, including «Outcome pending confirmation».
- **Hosted caps.** `message` and `settle` (`DAILY_MESSAGE_SENDS`, `DAILY_SETTLE_SENDS`, default 20 each).
- **Rotation.** Neither `rotateIfUsed` nor `ReserveMemory.apply()` (at start, or on a bindings reload that replaces the bindings wholesale) ever moves a case off a dispute that is in flight, uncertain or awaiting read-back.
- **Language and docs.** UI text is in English. Docs are EN (`docs/`) and ES (`docs/es/`) with matching heading counts. `node C:/nexus/dev/resolvekit-docs/.superpowers/docs-work/check-docs.mjs .` must report `0 problem(s)`.
- **Branch and base.** Work on a branch from main `6e4b40e` (lote1 + lote2 merged). A final whole-branch review goes to the owner before integration.

## Review Focus

1. **A dispute stuck in `uncertain`** (the POST timed out, PayPal never shows an attributable entry). Expected: the merchant sees «Outcome pending confirmation» with «Check again». The operator report (`/api/ops/status`) names the dispute as held, with its intent. A reviewer on the standard case is told why nothing can be sent, rather than seeing a silent failure. Rotation does not skip the dispute. Test: Task 13 `ops report names a held dispute`.
2. **The same message text sent twice on purpose.** Expected: the second send needs a new intent with the explicit repeat confirmation `REPEATS_MESSAGE`. The earlier identical entry never counts as its proof. Test: Task 6 `an earlier identical message is not this one` and Task 7 `a repeated message needs REPEATS_MESSAGE`.
3. **PayPal normalising stored text** (trailing spaces, CRLF, Unicode composition). Expected: the entry still matches under exactly the normalisation the contract shows, and nothing looser. Test: Task 6 `normalisation from the contract`.
4. **Another actor's state change** (the buyer closes the dispute, or PayPal moves the stage, while our accept or escalate is pending). Expected: no «Recorded by PayPal» and the dispute stays uncertain. The UI shows the new state and «Outcome pending confirmation». Test: Task 6 `a bare state change is not proof` and Tasks 9 and 10.
5. **Restart with lost `intents.json`** between `send_started` and an outcome. Expected: on start, the send log alone re-creates `uncertain` for that dispute and keeps it held for rotation. No write is allowed until the dispute is reconciled. Test: Task 5 `send log seeds uncertain without intents.json`.

---

## File map

| File | Responsibility | Tasks |
|---|---|---|
| `apps/server/scripts/contract-read.ts` (new) | GET-only sandbox reads for contracts | 2 |
| `packages/paypal/contracts/*.json` (new) | Recorded, redacted contract cases (request, response, before/after reads) | 2, 3, 15 |
| `apps/web/src/domain/actionContracts.ts` (new) | Variant registry: availability, reason, status, body format, proof fields | 2, 3, 7–12 |
| `apps/web/src/domain/amounts.ts` (new) | Exponent table, exact parser, minor units | 1 |
| `apps/web/src/domain/actions.ts` (new) | Types, request parsing, availability, compose, confirmation, lock keys | 1, 6, 8–12 |
| `apps/web/src/domain/actionReadback.ts` (new) | Baseline and proof matchers | 6, 8–12 |
| `apps/web/src/domain/intent.ts` | Conditional hashed fields, request parsing | 1, 12 |
| `packages/paypal/src/disputes.ts`, `orders.ts`; `apps/server/src/mapping.ts`; `packages/cases/src/input.ts` | Shapes, calls, snapshot; analyst input unchanged | 4 |
| `apps/server/src/intents.ts` | In-flight, uncertain, duplicate keys, evidence memory by stage, send-log seeding, confirmation | 5 |
| `apps/server/src/actions/routes.ts`, `calls.ts` (new) | Compose/approve/confirm/acknowledge/send/read-back | 7–12 |
| `apps/server/src/refunds.ts` (new) | PROOF_OF_REFUND checks | 12 |
| `apps/server/src/app.ts`, `hosted.ts`, `main.ts`, `reserve.ts` | Wiring, roles, caps, visibility, rotation guard | 7, 13 |
| `apps/web/src/domain/gateway.ts`, `intentClient.ts`, `actionSend.ts` (new) | Contract-driven simulator, client calls, send + read-back | 8–12 |
| `apps/web/src/components/ActionComposer.tsx`, `ActionFlow.tsx`, `MessageThread.tsx` (new) | Compose, approval + confirmation, result, thread | 8–12 |
| `packages/cases/src/fixtures/settlementCase.ts` (new) | Owner-only settlement case | 13 |

---

### Task 1: Intent union, exact amounts and hash compatibility (B0)

**Files:**
- Create: `apps/web/src/domain/amounts.ts`, `apps/web/src/domain/amounts.test.ts`, `apps/web/src/domain/actions.ts`, `apps/web/src/domain/actions.test.ts`
- Modify: `apps/web/src/domain/intent.ts`, `apps/web/src/domain/types.ts:20` (`ActionCode` + `'appeal'`), `apps/web/src/domain/status.ts` (`ACTION_LABEL.appeal = 'Appeal'`), `apps/server/src/intents.ts` (`StoredIntent.request` type only)
- Test: `apps/web/src/domain/intent.test.ts`, `amounts.test.ts`, `actions.test.ts`

**Interfaces:**
- Produces (`amounts.ts`):
  - `const CURRENCY_EXPONENT: Readonly<Record<string, number>> = { USD: 2, EUR: 2, GBP: 2, CAD: 2, AUD: 2, JPY: 0 }`
  - `type AmountResult = { ok: true; value: string; minor: bigint } | { ok: false; error: 'UNKNOWN_CURRENCY' | 'INVALID_AMOUNT'; detail: string }`
  - `function parseAmount(input: string, currency: string): AmountResult`. The canonical value has the leading zeros stripped and is padded to `e` decimals.
  - `function minorUnits(value: string, currency: string): bigint`; `function formatMoney(m: Money): string` (`'7.00 USD'`)
  - Detail texts: `'Unknown currency XYZ: ResolveKit cannot check amounts in it'` and `'Type the amount as digits with at most 2 decimals and a dot, e.g. 7.50'` (the number is the exponent; for an exponent of 0, `'Type a whole amount, e.g. 700'`). A zero amount gives `'The amount must be more than 0'`.
- Produces (`actions.ts`):
  - `type SimpleAction = 'send_message' | 'accept_claim' | 'escalate' | 'make_offer'`; `type IntentAction = 'provide_evidence' | 'appeal' | SimpleAction`; `interface Money { value: string; currency: string }`
  - `const ACTION_TEXT_LIMIT = 2000`
  - `type ActionRequest = { action: 'send_message'; text: string; attachments: string[] } | { action: 'accept_claim'; acceptType: string; note: string; amount: Money | null; attachments: [] } | { action: 'escalate'; note: string; attachments: [] } | { action: 'make_offer'; offerType: string; note: string; amount: Money | null; attachments: [] }`. Types stay strings here; the contract registry decides which are available (Task 6).
  - `type ActionPayload = { kind: 'send_message'; text: string } | { kind: 'accept_claim'; acceptType: string; note: string; amount: Money | null } | { kind: 'escalate'; note: string } | { kind: 'make_offer'; offerType: string; note: string; amount: Money | null }`
  - `interface DisputePin { disputeId: string | null; seller: string | null; stage: string | null; status: string; amount: Money | null }`
  - `const ACTION_EVIDENCE_BLANK` = `{ documentsHash: '', analysisKey: '', evidenceType: 'OTHER', carrier: '', tracking: '', notes: '', sentences: [], resolutionNotes: [] }`
  - `function isSimpleAction(a: unknown): a is SimpleAction`, `function intentAction(c: IntentContent): IntentAction`, `function isActionRequest(r: IntentRequest | ActionRequest): r is ActionRequest`, `function parseActionRequest(body: unknown): ActionRequest | ComposeProblem`. `parseActionRequest` parses amount strings with `parseAmount` against the currency in the request; the dispute currency is checked at compose.
- Produces (`intent.ts`):
  - `IntentContent` gains optional `action?`, `payload?`, `pin?` and `refundIds?: string[]`. `intentContent()` adds `action`, `payload` and `pin` only when `action` is set, and `refundIds` only when it is non-empty, after `confirmedCorrections`.
  - `IntentRequest` gains `action?: 'appeal'` and `refundIds?: string[]`.
  - `parseAnyIntentRequest(body: unknown): IntentRequest | ActionRequest | ComposeProblem`

- [ ] **Step 0: Re-read main `6e4b40e`.** Read in full `apps/server/src/intents.ts` (send-log seeding of `sentDisputes`, `loadIntents`, `storageProblem`, `writeFileDurable`), `apps/server/src/reserve.ts` (`ReserveMemory.markUsed`, `apply`), and in `apps/server/src/app.ts` `rotateIfUsed`, `usedSince` and `reserveMemory`. Also read `apps/server/src/main.ts` lines 86–160: `apply()` runs at line 97, before `new IntentStore` at line 153. Then run Step 1's golden assertions before changing anything. They must pass; if not, stop and report.
- [ ] **Step 1: Write the failing tests**

```ts
// intent.test.ts — GOLDEN content as below (unchanged since dcd74c6)
const GOLDEN: IntentContent = { caseId: 'PP-R-TVH-10190665', disputeId: 'PP-R-GOLDEN-1', documentsHash: 'a'.repeat(64), analysisKey: 'b'.repeat(64),
  evidenceType: 'PROOF_OF_FULFILLMENT', carrier: 'UPS', tracking: '1Z999AA10123456784', notes: 'Delivered on 8 Oct 2026.',
  files: [{ name: 'E3-ups-tracking.pdf', size: '2 KB', sha256: 'c'.repeat(64), source: 'demo' }],
  sentences: [{ id: 'S1', text: 'Delivered on 8 Oct 2026.', edited: false }], resolutionNotes: [{ contradictionId: 'C1', note: 'Same building.' }] };
it('existing provide-evidence hashes are unchanged (golden)', async () => {
  expect(await contentHash(GOLDEN)).toBe('63fe9916f41178e78070ee0d030a3e7d7791adeb9a61e925ecb352daab83b9c8');
  expect(await contentHash({ ...GOLDEN, confirmedCorrections: ['S1@E7.l2'] })).toBe('ee7919f7a34f78f2d314d1f400d6b856226c51167bdc952c4e5048bd58d12dec');
  expect(await contentHash({ ...GOLDEN, refundIds: [] })).toBe('63fe9916f41178e78070ee0d030a3e7d7791adeb9a61e925ecb352daab83b9c8');
});
it('each action hashes its action, payload and pin; one action never hashes as another', /* send_message vs escalate with same text → different; pin.status change → different; refundIds present → different from golden */);
// amounts.test.ts — the spec's matrix
it('canonical amounts', () => {
  expect(parseAmount('7', 'USD')).toMatchObject({ ok: true, value: '7.00', minor: 700n });
  expect(parseAmount('7.5', 'USD')).toMatchObject({ ok: true, value: '7.50' });
  expect(parseAmount('07.00', 'USD')).toMatchObject({ ok: true, value: '7.00' });
  expect(parseAmount('700', 'JPY')).toMatchObject({ ok: true, value: '700', minor: 700n });
  for (const bad of ['7,00', '7.001', '-1', '1e2', ' 7', '7 ', '+7', '0', '0.00', '', '.5', '7.']) expect(parseAmount(bad, 'USD')).toMatchObject({ ok: false, error: 'INVALID_AMOUNT' });
  expect(parseAmount('7.5', 'JPY')).toMatchObject({ ok: false, error: 'INVALID_AMOUNT' });
  expect(parseAmount('7', 'XYZ')).toMatchObject({ ok: false, error: 'UNKNOWN_CURRENCY' });
});
// actions.test.ts
it('parses action requests; refuses everything else', /* text trimmed, ≤2000 (TEXT_TOO_LONG 422), empty (TEXT_REQUIRED 422), bidi/control (400 INVALID_ACTION_REQUEST), extra keys (400), >1 attachment (400), amount '7,00' (422 INVALID_AMOUNT) */);
it('parseIntentRequest takes action "appeal" and refundIds; provide_evidence stays absent', /* as before; refundIds sorted unique, /^[A-Z0-9]{8,32}$/, 1–5 */);
```

- [ ] **Step 2: Run the tests and check they fail.** Run `cd apps/web && npx vitest run src/domain/intent.test.ts src/domain/amounts.test.ts src/domain/actions.test.ts`. Expected: golden PASS, the rest FAIL.
- [ ] **Step 3: Implement.** Use `BigInt` on the digit string for minor units, and never `Number`/`parseFloat` on an amount. Text rules use the `CONTROL_CHARS` set from `apps/server/src/app.ts` (line breaks and tabs allowed).
- [ ] **Step 4: Run the tests and check they pass.** Run the same command and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Intents: action union, exact amounts, hash-compatible content (B0)"`

---

### Task 2: Contracts, read-only: documentation, GET reads, prepared writes

Implementer-runnable. **GET only.** No write of any kind reaches PayPal.

**Files:**
- Create: `apps/server/scripts/contract-read.ts`, `apps/server/test/contract-read.test.ts`, `packages/paypal/contracts/README.md`, `packages/paypal/contracts/reads/*.json` (redacted GET responses), `apps/web/src/domain/actionContracts.ts`, `apps/web/src/domain/actionContracts.test.ts`
- Create (outside the repo, PayPalAI evidence): `C:/nexus/dev/PayPalAI/evidencia/contrato-<action>-2026-10-DD.md` for `send-message`, `accept-claim`, `escalate`, `make-offer`, `appeal` and `proof-of-refund`, plus `C:/nexus/dev/PayPalAI/evidencia/escrituras-preparadas-acciones-2026-10-DD.md`
- Modify: root `package.json` (script `"contract:read": "node --env-file-if-exists=.env apps/server/scripts/contract-read.ts"`)

**Interfaces:**
- Produces (`contract-read.ts`): CLI `npm run contract:read -- --list | --dispute <PP-…> | --refund <id> [--out <file>]`.
  - It wraps the client's `fetch` with `getOnly(fetch)`. That wrapper lets through only `GET` and the OAuth token `POST /v1/oauth2/token`, and throws `Error('contract-read: only GET reads are allowed')` for anything else, before any network call.
  - It redacts with `redact(d: unknown): unknown`, which removes every `email`, `email_address`, `name`, `given_name`, `surname`, `payer_id` other than the seller's, and every address, and replaces buyer message content with `'<buyer message, N chars>'`. Sandbox dispute, capture and refund ids are kept.
  - The implementer runs it; the script loads `.env` itself. **Never print or open `.env`.**
- Produces (`actionContracts.ts`):
  - `type VariantId = 'send_message' | 'send_message:file' | 'accept_claim:REFUND' | 'accept_claim:PARTIAL_REFUND' | 'escalate' | 'make_offer:REFUND' | 'make_offer:REPLACEMENT_WITHOUT_REFUND' | 'make_offer:withdraw' | 'appeal' | 'evidence:PROOF_OF_REFUND' | 'evidence:after_escalation' | 'return_address'`
  - `type VariantStatus = 'not_available' | 'implemented' | 'tested_locally' | 'verified_in_sandbox' | 'deployed'`
  - `interface ProofFields { list: 'messages' | 'offerHistory' | 'evidences' | 'adjudications' | null; actorField: string | null; actorValue: string | null; timeField: string | null; matchFields: string[]; normalise: Array<'trim' | 'crlf' | 'nfc'> }`
  - `interface VariantContract { id: VariantId; status: VariantStatus; reason: string | null; docUrl: string | null; body: 'json' | 'multipart' | null; route: string | null; proof: ProofFields | null; absentAfterMs: number | null; requestIdDedupes: boolean | null; recorded: string | null /* packages/paypal/contracts/<file>.json */; evidence: string | null /* evidencia file name */ }`
  - `const CONTRACTS: Readonly<Record<VariantId, VariantContract>>`. After this task every entry is `status: 'not_available'`, `reason: 'Contract not recorded yet'`, with `docUrl`, `route` and `body` (as documented) filled in from the documentation. `proof` is filled in only where the GET reads showed the fields.
  - `function variantOf(action: IntentAction, type?: string | null): VariantId | null`; `function available(v: VariantId): boolean` (status ≠ `not_available`)

- [ ] **Step 1: Write the failing tests**

```ts
// contract-read.test.ts
test('getOnly refuses every write before the network', async () => {
  const seen: string[] = []; const f = getOnly((async (u: string | URL, i: RequestInit = {}) => { seen.push(`${i.method ?? 'GET'} ${u}`); return new Response('{}'); }) as typeof fetch);
  await f('https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-1', { method: 'GET' });
  await f('https://api-m.sandbox.paypal.com/v1/oauth2/token', { method: 'POST' });
  await assert.rejects(f('https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-1/send-message', { method: 'POST' }), /only GET reads are allowed/);
  assert.equal(seen.length, 2);
});
test('redact drops names, emails, addresses and buyer message text; keeps sandbox ids', /* … */);
// actionContracts.test.ts
it('every variant is Not available until its contract is recorded', () => {
  for (const c of Object.values(CONTRACTS)) if (!c.recorded) expect(c).toMatchObject({ status: 'not_available' });
  expect(Object.values(CONTRACTS).every((c) => c.status === 'not_available' || (c.recorded && c.evidence))).toBe(true);
});
```

- [ ] **Step 2: Run the tests and check they fail.** Run `cd apps/server && node --test test/contract-read.test.ts` and `cd apps/web && npx vitest run src/domain/actionContracts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the script and the registry.
- [ ] **Step 4: Research and read (GET only).**
  - Record PayPal's reference for each route: URL, required fields, types per reason and stage, limits, JSON vs multipart, and anything about `PayPal-Request-Id`.
  - Run `npm run contract:read -- --list`, then `--dispute` on the owner's existing sandbox disputes in each available state: inquiry waiting for the seller, after evidence, claim stage, resolved, and an adverse outcome if one exists. Save the redacted output to `packages/paypal/contracts/reads/<state>.json`.
  - Record which fields show the allowed options, the thread, the offer history, stage, status and outcome, and which entries could carry a proof (actor, time, type, amount, attribution).
  - Write one `contrato-<action>-…md` per action: documentation links, the observed fields, what is still unknown, and the proposed proof fields.
- [ ] **Step 5: Prepare the writes.** In `escrituras-preparadas-acciones-…md`, write one entry per variant `W-<n>`:
  - exact method and route, headers without credentials (`Content-Type`, `PayPal-Request-Id: rk-contract-<n>`), and the exact body (JSON, or the multipart part list);
  - target sandbox dispute id and its state from the last GET;
  - expected response and expected read-back fields;
  - consequence in plain words, and what it consumes (e.g. «closes this sandbox dispute; refunds 7.00 USD sandbox money»);
  - the follow-up reads to run at +0 s, +30 s, +2 min and +10 min.
  Include a duplicate-Request-Id probe (the same `W` sent twice) only for send_message, and only as its own entry. Target only owner disputes outside the reviewer reserve, in the settlement case's own reserve. **Run none of them.**
- [ ] **Step 6: Run the tests and check they pass, then commit.** Run the Step 2 commands (expected PASS) and `git add apps/server/scripts packages/paypal/contracts apps/web/src/domain/actionContracts* package.json && git commit -m "Contracts: GET-only reads, registry (all Not available), prepared writes"`.

---

### Task 3: Owner-approved contract writes (controller only, not an implementer task)

> **Implementers do not run this task.** The controller presents each prepared write `W-<n>` from Task 2 to the owner, exactly as written, and runs it only after the owner approves **that** request. Writes the owner declines leave their variant «Not available» with reason «Not verified with PayPal».

**Files:**
- Modify: `C:/nexus/dev/PayPalAI/evidencia/contrato-<action>-…md` (append response and read-backs), `packages/paypal/contracts/<variant>.json` (new per run), `apps/web/src/domain/actionContracts.ts`

**Interfaces:**
- Produces: `packages/paypal/contracts/<variant>.json` = `{ variant: VariantId; request: { method: 'POST'; route: string; body: unknown; requestId: string }; response: { status: number; body: unknown; debugId: string | null }; before: Dispute; after: Array<{ atMs: number; dispute: Dispute }>; notes: string }` (redacted with `redact`).
- For each recorded variant, `CONTRACTS[v]` gets: `status: 'implemented'` (only once its flow task lands; until then it stays `not_available`, reason `'Contract recorded; flow not built yet'`), `body`, `proof`, `absentAfterMs` (the longest observed time to visible, rounded up, ×2), `requestIdDedupes`, `recorded`, `evidence`.

- [ ] **Step 1:** For each `W-<n>` in order (send_message first), show the owner the entry verbatim and wait for an explicit «approved W-<n>».
- [ ] **Step 2:** Run it from the repo's PayPal client, through a one-off script that reads `.env` and takes the approved body as data. Then run the listed follow-up reads with `contract:read`.
- [ ] **Step 3:** Save the redacted contract JSON and append the response and read-backs to the evidence file. Fill in the registry entry, or mark it «Not available» with the observed reason (e.g. PayPal refused the variant, or there is no attributable proof field).
- [ ] **Step 4: Commit** `git commit -am "Contracts: recorded <variant> (owner-approved W-<n>)"`. Do one commit per variant, so each action task can start as soon as its variant is in.

**Gate:** Tasks 8–12 each start only when the contracts they name are recorded, or are explicitly declined (and then build the «Not available» preview only).

---

### Task 4: PayPal shapes, action calls and the snapshot (B0 mapping)

**Files:**
- Modify: `packages/paypal/src/disputes.ts`, `packages/paypal/src/orders.ts`, `apps/server/src/mapping.ts`, `apps/web/src/domain/types.ts` (`DisputeSnapshot`), `packages/cases/src/input.ts`
- Test: `packages/paypal/test/disputes.test.ts`, `packages/paypal/test/orders.test.ts`, `apps/server/test/mapping.test.ts`

**Interfaces:**
- Produces (`disputes.ts`):
  - `Dispute` gains `messages?`, `offer?.history?`, `allowed_response_options?`, `dispute_outcome?`, `update_time?`, plus any proof-carrying field Task 2 found (typed as found).
  - `SELLER_ACTIONS` gains `'appeal'`.
  - Methods, each taking `opts: { requestId: string }` and building its body format from `CONTRACTS[...].body` (passed in by the caller as `format: 'json' | 'multipart'`, so the package does not import the web registry): `sendMessage(disputeId: string, message: string, file: EvidenceFile | null, opts: { requestId: string; format: 'json' | 'multipart' })`, `acceptClaim(disputeId, body: Record<string, unknown>, opts)`, `makeOffer(disputeId, body: Record<string, unknown>, opts)`, `escalate(disputeId, note: string, opts)` and `appeal(disputeId, evidence: EvidenceInput, files: EvidenceFile[], opts)`. They replace the old caller-less `sendMessage` and `acceptClaim`.
- Produces (`orders.ts`): `interface Refund { id?: string; status?: string; amount?: Money; links?: Array<{ rel: string; href: string }> }`; `PaymentsApi.getRefund(refundId: string): Promise<Refund>`.
- Produces (`types.ts`):
  - `interface DisputeMessage { postedBy: string; time: string | null; content: string; files: string[] }`
  - `interface OfferEvent { time: string | null; actor: string; event: string; type: string | null; amount: { value: string; currency: string } | null }`
  - `DisputeSnapshot` gains `messages?`, `offerHistory?`, `responseOptions?: { acceptClaimTypes: string[]; offerTypes: string[] }`, and `proofEntries?: unknown[]`. `proofEntries` holds the raw entries of `proof.list` when that list is not one of the mapped ones; it is shaped only from the contract.
- Produces (`mapping.ts`): `toSnapshot` maps the fields above and `outcome`. Update the header comment: messages are shown to the seller's workspace, never persisted and never given to the analyst.
- `caseInput` filters `'appeal'` out of `allowedActions`, so analysis keys stay stable.

- [ ] **Step 1: Write the failing tests.** Build the fakes from `packages/paypal/contracts/reads/*.json`.

```ts
test('send-message honours the contract’s format and the intent’s Request-Id', /* format json → body JSON {"message":"Hello"}; multipart → FormData 'input' part; header PayPal-Request-Id === 'rk-int-1' */);
test('accept/offer/escalate/appeal post to their routes with the bodies given', /* … */);
test('getRefund is a GET to /v2/payments/refunds/{id}', /* … */);
test('the thread, offers, options and outcome are mapped from a recorded read; the analyst input does not change', () => {
  const d = readContract('reads/inquiry-waiting-seller.json');
  const s = toSnapshot(d, CASE, 'sandbox', NOW);
  assert.ok(Array.isArray(s.messages));
  assert.deepEqual(caseInput(standardCase, live(s)), caseInput(standardCase, live({ ...s, messages: [], offerHistory: [], responseOptions: undefined, allowedActions: s.allowedActions.filter((a) => a !== 'appeal') })));
});
```

- [ ] **Step 2: Run the tests and check they fail.** Run `node --test packages/paypal/test/*.test.ts` and `cd apps/server && node --test test/mapping.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and check they pass.** Run the same commands and `npm run test:cases && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "PayPal: action calls by contract format, refund read, thread/offers/options in the snapshot (B0)"`

---

### Task 5: Locks: in-flight, uncertain, duplicates, evidence by stage, send-log seeding (B0 store)

**Files:**
- Modify: `apps/web/src/domain/actions.ts` (lock keys), `apps/server/src/intents.ts`
- Test: `apps/server/test/intent-locks.test.ts` (new), `apps/server/test/intent.test.ts`

**Interfaces:**
- Produces (`actions.ts`):
  - `function duplicateKey(c: IntentContent): string | null`: `${action}|${pin.stage}|${canonicalJson(payload)}` for simple actions; null for evidence and appeal.
  - `const CONSEQUENCE: Record<Exclude<IntentAction, 'provide_evidence'>, string>` = `{ send_message: 'BUYER_SEES_MESSAGE', accept_claim: 'REFUNDS_BUYER', escalate: 'MOVES_TO_CLAIM', make_offer: 'OFFERS_SETTLEMENT', appeal: 'APPEALS_DECISION' }`, plus `'REPEATS_MESSAGE'` for a repeated message.
- Produces (`intents.ts`):
  - `AuditEvent` gains `action?: IntentAction`, `stage?: string | null`, `scope?: 'evidence' | 'action'`, `textSha256?: string`. They are set on `send_started`, `sent`, `send_failed` and the new send-log kinds `send_uncertain` and `read_back` (`detail` = `recorded` | `absent` | `pending`). The message text is never written, only its hash.
  - `SEND_KINDS` adds `'send_uncertain'` and `'read_back'`.
  - Evidence memory is keyed by `` `${disputeId}|${stage}` ``. Legacy entries (key without `|`, or a `sent` event without `stage`) block the whole dispute. `sentFor(disputeId, stage?: string | null)` returns the blocking entry.
  - `beginSend(id, caseId, actor)` refuses with:
    - 409 `DISPUTE_UNCERTAIN` («The last send to this dispute is not confirmed by PayPal yet; check it again before anything else is sent») while the dispute is uncertain from another intent;
    - 409 `DISPUTE_BUSY` (in-flight, existing);
    - for provide_evidence, the legacy whole-dispute check only. The per-stage check is `evidenceSentIn(disputeId, stage)`, called after the fresh read.
  - `markUncertain(id: string, why: string): boolean` (durable; send-log `send_uncertain`); `isUncertain(disputeId: string): { intentId: string; since: string } | null`
  - `recordReadBack(id: string, r: { state: 'recorded' | 'absent' | 'pending'; detail: string }): boolean`:
    - `recorded` → intent `sent`, readBack `recorded`, `duplicateKey` added to `recordedKeys[disputeId]`, uncertain cleared;
    - `absent` → intent `failed` (retryable with the same requestId), uncertain cleared;
    - `pending` → stays uncertain.
    All three are durable in the send log.
  - `recordedDuplicate(disputeId: string, key: string): boolean`
  - `held(disputeId: string): boolean` = in-flight or uncertain (used by rotation, Task 13)
  - Seeding on start, from the send log alone, after `loadIntents`:
    - a `sent` with `scope: 'evidence'` → evidence memory (`stage` when present);
    - `send_started` for an action with no later `read_back` `recorded` or `absent` for the same intent → uncertain;
    - `read_back recorded` → `recordedKeys`.
    A legacy `sent` without `action` counts as evidence for the whole dispute, as main does today.
  - Restart: an intent loaded as `sending` becomes `failed` (as today), and for actions it is also marked uncertain.
  - Confirmation state on `StoredIntent`: `confirmation?: { code: string; amount: Money | null; at: string; by: string } | null` (Task 7 uses it). Also `threadKeysAtApproval?: string[]` (buyer message keys, no text).

- [ ] **Step 1: Write the failing tests**

```ts
test('lock matrix', () => {
  // message A sending → beginSend(message B, same dispute) → 409 DISPUTE_BUSY
  // message A markUncertain → beginSend(offer B) → 409 DISPUTE_UNCERTAIN; recordReadBack(A,'pending') → still 409; recordReadBack(A,'recorded') → B allowed
  // escalate recorded → beginSend(message) allowed by the store (no closure lock; PayPal's read decides)
  // accept recorded → beginSend(anything) allowed by the store (the fresh read refuses it, Task 9)
  // uncertain never becomes closed: after 'pending' ×3 the dispute is still isUncertain, not in any closed set
});
test('evidence after escalation: memory keyed by (dispute, stage); legacy entries block the whole dispute', () => {
  // sent evidence with stage INQUIRY → evidenceSentIn(d,'INQUIRY') true, evidenceSentIn(d,'CHARGEBACK') false
  // legacy sentDisputes {'PP-R-1': …} (no stage) → evidenceSentIn('PP-R-1','CHARGEBACK') true
});
test('duplicate guard: the same recorded message on the same dispute and stage', /* recordedDuplicate true after read_back recorded; false for another stage */);
test('send log seeds uncertain without intents.json', () => {
  // file-backed store: message send_started (durable), then process "dies" (no outcome); delete intents.json (second run: corrupt it)
  // new IntentStore → isUncertain('PP-R-1') set, held('PP-R-1') true; a legacy sent without action → evidence whole-dispute
});
test('message text never reaches the audit or send log', /* JSON of every event after a message send lacks the text; has textSha256 */);
```

- [ ] **Step 2: Run the tests and check they fail.** Run `cd apps/server && node --test test/intent-locks.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, keeping main's durability helpers and refusal texts.
- [ ] **Step 4: Run the tests and check they pass.** Run `node --test test/intent-locks.test.ts test/intent.test.ts test/intent-sessions.test.ts`. Expected: PASS, provide-evidence behaviour unchanged.
- [ ] **Step 5: Commit** `git commit -am "Intents: in-flight, uncertain, duplicate guard, evidence by stage, seeded from the send log (B0)"`

---

### Task 6: Pure rules: availability, compose, confirmation binding, proof matchers (B0)

**Files:**
- Create: `apps/web/src/domain/actionReadback.ts`, `apps/web/src/domain/actionReadback.test.ts`
- Modify: `apps/web/src/domain/actions.ts`, `apps/web/src/domain/recorded.ts` (export `evidenceKey`)
- Test: `apps/web/src/domain/actions.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 4 and 5.
- Produces (`actions.ts`):
  - `const OWNER_ACTIONS: readonly IntentAction[] = ['accept_claim', 'make_offer', 'escalate', 'appeal']`; `interface Viewer { role: 'owner' | 'member'; reviewer: boolean }`
  - `interface ActionAvailability { action: IntentAction; offered: boolean; sendable: boolean; why: string | null; variants: Array<{ variant: VariantId; type: string | null; available: boolean; why: string | null }> }`
  - `function actionAvailability(snap: DisputeSnapshot, action: IntentAction, who: Viewer): ActionAvailability`. It is built only from the fresh snapshot and `CONTRACTS`:
    - link absent → `'PayPal does not offer this action on this dispute right now'`;
    - variant not available → its `CONTRACTS` reason;
    - owner-only for a non-owner → `'Only the workspace owner can send this action'`.
  - `function disputePin(snap: DisputeSnapshot, disputeId: string | null, seller: string | null): DisputePin`
  - `function composeAction(x: { caseId: string; req: ActionRequest; snap: DisputeSnapshot; disputeId: string | null; seller: string | null; files: SubmissionFile[] }): IntentContent | ComposeProblem`. Checks run in this order:
    1. availability (409 `ACTION_NOT_OFFERED`, 409 `VARIANT_NOT_AVAILABLE` with the reason);
    2. stage rules from the contract (409 `ACTION_STAGE`);
    3. currency (422 `CURRENCY_MISMATCH`, 422 `UNKNOWN_CURRENCY`);
    4. amount (`minorUnits` > 0 and ≤ dispute amount, else 422 `AMOUNT_ABOVE_DISPUTE`; 422 `AMOUNT_NOT_ALLOWED`, 422 `AMOUNT_REQUIRED` per variant);
    5. text (422 `TEXT_REQUIRED` / `TEXT_TOO_LONG`).
    The result is `{ caseId, disputeId, ...ACTION_EVIDENCE_BLANK, files, action, payload, pin }`. Each action's rules land in its own task (8–12). Before that, the action returns 409 `VARIANT_NOT_AVAILABLE`.
  - `interface ConfirmationTerms { intentId: string; contentHash: string; action: IntentAction; amount: string | null; currency: string | null; consequence: string }`
  - `function confirmationTerms(i: SubmissionIntent, repeat: boolean): ConfirmationTerms | null` (null for a first-time message); `function sameTerms(a: ConfirmationTerms, b: unknown): boolean` (every field equal; amount compared as a canonical string)
  - `function consequenceText(c: IntentContent): string` (per action; send_message: `'The buyer sees this message in PayPal.'`)
  - `function relevantNewBuyerMessages(action: IntentAction, keysAtApproval: readonly string[], fresh: DisputeSnapshot): DisputeMessage[]`: empty for escalate and appeal (shown, not blocking); for send_message, make_offer and accept_claim, the BUYER messages whose key is not in `keysAtApproval`. The message key is `${postedBy}|${time ?? ''}|${content.length}`. The merchant's own messages, read time, link order and fields outside the hash never count.
- Produces (`actionReadback.ts`):
  - `interface ReadBackBase { entryKeys: string[]; stage: string | null; status: string; sentStartedAt: string }`; `function readBackBase(s: DisputeSnapshot, proof: ProofFields, sentStartedAt: string): ReadBackBase`
  - `type ProofState = 'recorded' | 'absent' | 'pending'`; `interface ReadBackRecord { state: ProofState; detail: string; at: string }`
  - `function proveSend(c: IntentContent, base: ReadBackBase, after: DisputeSnapshot, contract: VariantContract, nowMs: number): { state: ProofState; detail: string }`:
    - `recorded` only when there is an entry in `contract.proof.list` that (a) is absent from `base.entryKeys`, (b) has `actorField` = `actorValue`, (c) has `timeField` ≥ `sentStartedAt`, and (d) has every `matchFields` value equal to the approved content under `contract.proof.normalise`. Detail: `'Recorded by PayPal'`.
    - `absent` only when no new seller entry exists, the action is still offered by `after`, and `nowMs - sentStartedAt ≥ contract.absentAfterMs`. Detail: `'PayPal shows no trace of this send and still offers the action'`.
    - otherwise `pending`, detail `'Outcome pending confirmation'`. This covers a contract without `proof`, a bare state change, and a different seller entry. A different seller entry adds `': PayPal shows a different seller entry'`.

- [ ] **Step 1: Write the failing tests.** They use a test-only `VariantContract` built from `packages/paypal/contracts/reads` field names.

```ts
it('availability is rebuilt from the fresh read and the registry', /* link absent → offered false; registry not_available → variant why = reason; reviewer + accept → sendable false 'Only the workspace owner can send this action' */);
it('second-confirmation terms cover id, hash, action, amount, currency and consequence', () => {
  const t = confirmationTerms(acceptIntent, false)!;
  expect(t).toEqual({ intentId: acceptIntent.id, contentHash: acceptIntent.contentHash, action: 'accept_claim', amount: '7.00', currency: 'USD', consequence: 'REFUNDS_BUYER' });
  for (const k of Object.keys(t)) expect(sameTerms(t, { ...t, [k]: k === 'amount' ? '7.01' : 'x' })).toBe(false);
  expect(sameTerms(t, { ...t, amount: '7' })).toBe(false); // the client must echo the canonical string
});
it('a new buyer message after approval matters for message/offer/accept, not for escalate/appeal; own messages never', /* … */);
it('proof: an earlier identical message is not this one', /* base has SELLER 'Hello'; after unchanged → pending; after adds new SELLER 'Hello' at ≥ sentStartedAt → recorded */);
it('proof: normalisation from the contract', /* normalise ['trim','crlf'] → 'a\r\nb ' matches 'a\nb'; NFC not listed → 'é' (decomposed) does not */);
it('proof: a bare state change is not proof', /* after status RESOLVED, no attributable entry → pending */);
it('proof: absent only after absentAfterMs and while still offered', /* nowMs before → pending; after + still offered → absent; after + not offered → pending */);
it('proof: a contract without proof fields never records', /* proof null → pending always */);
```

- [ ] **Step 2: Run the tests and check they fail.** Run `cd apps/web && npx vitest run src/domain/actions.test.ts src/domain/actionReadback.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and check they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Actions: availability from the fresh read, bound confirmation, attributable proof (B0)"`

---

### Task 7: Generic action route on the server (B0 route + re-checks)

**Files:**
- Create: `apps/server/src/actions/routes.ts`, `apps/server/src/actions/calls.ts`, `apps/server/test/actions-kit.ts`, `apps/server/test/actions.test.ts`
- Modify: `apps/server/src/app.ts` (regex, dispatch, export `CaseState`, `CostlyAction` + `'message' | 'settle'`, `/evidence` restriction, `approveIntent` role check), `apps/server/src/hosted.ts` (`LOCKED_REASON`, `CAP_NAME`, read-back counted as a PayPal read), `apps/server/src/main.ts` (caps `DAILY_MESSAGE_SENDS`, `DAILY_SETTLE_SENDS`, default 20), `.env.example`
- Test: `apps/server/test/actions.test.ts`, `apps/server/test/hosted.test.ts`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces:
  - Routes:
    - `POST /api/disputes/:case/intent` with a simple-action body → 201.
    - `POST …/intent/:id/approve {contentHash}` → 200; the response carries `confirmation: ConfirmationTerms | null`.
    - `POST …/intent/:id/confirm {terms: ConfirmationTerms}` → 200 when `sameTerms(confirmationTerms(i, repeat), terms)`; else 409 `CONFIRMATION_MISMATCH` («These terms are not the ones of this intent; compose it again»).
    - `POST …/intent/:id/acknowledge {contentHash}` → 200 after a fresh read; it updates `threadKeysAtApproval`.
    - `POST /api/disputes/:case/send {intentId}` → 202 `{ sent: true, intent }`, or 200 `{ reconciled: true, intent }`.
    - `GET …/intent/:id/readback` → 200 `{ readBack: ReadBackRecord, snapshot }`.
  - `createActionRoutes(deps: ActionRouteDeps)` (deps as in the earlier draft: `intents`, `caseState`, `sellerRefusal`, `actorOf`, `personOf`, `uploadFiles`, `recomposeEvidence`, `reserve`, `snapshotOf`, `paypal`, `log`, `now`)
  - `callPayPal(paypal, disputeId, c: IntentContent, files: EvidenceFile[], requestId: string): Promise<unknown>` (by action, with `CONTRACTS` format); `capOf(a: IntentAction): CostlyAction`
  - `isAmbiguous(e: unknown): boolean`: true for timeouts, network errors, 5xx, `NON_JSON_RESPONSE`, and 4xx without a PayPal issue code; false for 4xx with a known issue code.
- Role is checked at compose, approve, confirm and send (`OWNER_ACTIONS` → 403 `OWNER_ONLY`). Other refusals: 409 `WRONG_SEND_ROUTE`, 409 `SIMULATED_CASE`, 409 `NEEDS_REVIEW` (body carries `messages: DisputeMessage[]` from the fresh read, not stored), 409 `CONFIRMATION_REQUIRED`, 409 `DUPLICATE_ACTION`, 409 `INTENT_NOT_SENT`.

Send order, fixed:
1. Body, ownership, action family and role checks, then binding check (`BINDING_CHANGED`).
2. `beginSend`: in-flight and uncertain locks.
3. Cap, then fresh `caseState` and seller check.
4. If this intent is the uncertain one, **reconcile first**, with `proveSend` on the fresh read:
   - `recorded` → 200 reconciled;
   - `pending` → refuse 409 `DISPUTE_UNCERTAIN`, no POST;
   - `absent` → go on with the same `requestId`.
5. Re-check: `composeAction` (or `recomposeEvidence` for appeal) on the fresh read. A problem → refuse; a different hash → 409 `INTENT_STALE`.
6. `recordedDuplicate(duplicateKey)` → 409 `DUPLICATE_ACTION`, unless the intent was confirmed with `REPEATS_MESSAGE`.
7. `relevantNewBuyerMessages` non-empty → 409 `NEEDS_REVIEW`.
8. `confirmationTerms` non-null and not confirmed → 409 `CONFIRMATION_REQUIRED`.
9. `setReadBackBase` durable, then `send_started` durable. Either fails → 503, no POST.
10. `callPayPal`:
    - a 4xx with a known code → `intents.failed`, 422 with `paypalIssue`; not uncertain;
    - ambiguous → `markUncertain`, 202 `{ sent: 'unknown', intent }`, shown as «Outcome pending confirmation»;
    - success → `intents.sent` and `markUncertain(…, 'awaiting proof')`. Every unproven outcome is uncertain until the read-back.

`readBack`: reads the **pinned** `intent.disputeId`, runs `proveSend`, calls `recordReadBack`, and returns the snapshot including `messages`.

- [ ] **Step 1: Write the failing tests.** `actions-kit.ts` gives `actionPayPal({ dispute, actionReply })`, whose replies come from `packages/paypal/contracts/*.json` (or from `reads/` plus a synthetic reply marked `// synthetic: no contract yet` for route-level tests). It also gives `setupActions()` and the helpers `compose`, `approve`, `confirm`, `send`, `readBack`. Route tests use send_message with a test-only contract injected through `deps`, because the real registry may still say «Not available».

```ts
test('happy path: compose → approve → send once with the intent’s Request-Id → pending until an attributable entry → recorded', /* posts 1; readBack pending; then dispute gains SELLER entry after sentStartedAt → recorded; isUncertain cleared */);
test('a bare state change after the send is not proof', /* status changes, no entry → readback pending, dispute still uncertain, a new intent's send → 409 DISPUTE_UNCERTAIN */);
test('ambiguous error → uncertain; known 4xx → failed, not uncertain', /* timeout → 202 sent 'unknown', isUncertain; 422 {details:[{issue:'X'}]} → 422 paypalIssue X, not uncertain */);
test('retry reconciles: recorded → no POST; pending → refused; absent (after absentAfterMs, still offered) → POST with the same Request-Id', /* posts counts 1/1/2, requestIds equal */);
test('re-check matrix', /* link gone → ACTION_NOT_OFFERED (invalidated); stage changed → ACTION_STAGE; status changed → INTENT_STALE; amount changed → BINDING_INVALID; unreadable → BINDING_UNAVAILABLE (still approved); posts 0 */);
test('NEEDS_REVIEW: a new buyer message after approval holds a message; acknowledge re-arms it; the merchant’s own message never holds it', /* 409 with messages[0].content; acknowledge → send 202 */);
test('irrelevant changes never invalidate', /* readAt, link order, update_time change → 202 */);
test('persistence failure before the POST: nothing is sent', /* unwritable file → 503 AUDIT_UNAVAILABLE, posts 0 */);
test('duplicate submission', /* two concurrent sends → [202, 409 INTENT_SENDING], posts 1 */);
test('cross-route replay refused', /* message via /evidence, evidence via /send → 409 WRONG_SEND_ROUTE */);
// hosted.test.ts
test('roles at every step', /* reviewer: message compose/approve/send OK; reviewer & fullMember: owner-action compose → 403; owner composes, then (simulated role change by a second, member session reusing the intent id) approve/confirm/send by non-owner → 404/403, never sent */);
test('caps message and settle', /* limits {message:1} → second message send 429 DAILY_CAP action 'message', posts 1 */);
test('read-back counts as a PayPal read', /* paypalReads limit 1 → second readback 429 */);
```

- [ ] **Step 2: Run the tests and check they fail.** Run `cd apps/server && node --test test/actions.test.ts test/hosted.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Copy and cap texts:
  - `LOCKED_REASON.message`: «Sending a message to a real PayPal dispute is seen by the buyer, so only the seller’s workspace can do it.»
  - `LOCKED_REASON.settle`: «Accepting, offering, escalating or appealing moves money or changes the dispute at PayPal, so only the seller’s workspace owner can do it.»
  - `CAP_NAME`: `message: 'message sends'`, `settle: 'settling actions'`.
- [ ] **Step 4: Run the tests and check they pass.** Run `cd apps/server && node --test "test/*.test.ts"` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Server: generic action route with bound confirmation, uncertain reconcile, NEEDS_REVIEW"`

---

### Task 8: send_message end to end (server rules, web, simulator, thread)

**Precondition:** contract `send_message` recorded (Task 3), and `send_message:file` recorded or declined.

**Files:**
- Create: `apps/web/src/domain/actionSend.ts` (+ test), `apps/web/src/components/ActionComposer.tsx`, `ActionFlow.tsx`, `MessageThread.tsx`, `ActionFlow.test.tsx`
- Modify: `apps/web/src/domain/actions.ts`, `actionContracts.ts` (`send_message` → `implemented`), `gateway.ts`, `httpGateway.ts`, `intentClient.ts`, `draft.ts:280-284`, `components/ResponseComposer.tsx`, `pages/CasePage.tsx`, `packages/cases/src/fixtures/standardCase.ts` (`simulatedPayPal.messages`: one buyer message taken from the recorded read's shape), `apps/server/src/actions/calls.ts`
- Test: `apps/web/src/domain/*.test.ts`, `apps/server/test/actions.test.ts`, `apps/web/src/App.test.tsx`

**Interfaces:**
- Produces:
  - `composeAction` send_message rules. The stage rule comes from the contract; if the contract records only INQUIRY, the stage must be `'INQUIRY'` (409 `ACTION_STAGE`). The text must be ≤ 2,000. At most one confirmed upload is attached, only if `send_message:file` is available.
  - Repeat: if `recordedDuplicate`, compose answers 201 with `repeat: true`, and `confirmationTerms(i, true)` gives consequence `'REPEATS_MESSAGE'`.
  - `SimulatedDisputeGateway.sendAction(intent, opts)`. It applies **only** the transitions in the recorded contract `after` reads: the new entry template (actor/time/fields), the status, stage and links as recorded, and the time to visible as `actionLagReads`. A variant with no contract → `Error('NOT_AUTHORIZED: not available in the simulator')`. It also reproduces «Outcome pending confirmation» when the contract shows lag.
  - `sendActionWithReadBack(o)` → `ActionResult = { kind: ProofState | 'not_sent'; detail: string; snapshot: DisputeSnapshot | null }` (server read-back in PayPal mode; `proveSend` in the simulator)
  - `IntentSource.createAction`, `approve`, `confirm(intent, terms)`, `acknowledge(intent)` and `readBack(intent)`. `HttpDisputeGateway.sendAction(intent)` → `POST /send`.
  - `draftBlockers`: the «only "Provide evidence"» blocker is removed.
  - UI:
    - `ActionComposer` shows the text with its `n / 2,000` count and the availability reasons (including the registry status label, e.g. «Not available: Contract not recorded yet»).
    - `ActionFlow` goes Review → (Confirm when terms) → Send → result. Result titles: «Recorded by PayPal» / «Recorded by the simulator», «Outcome pending confirmation» (with «Check again»), «Not sent».
    - `NEEDS_REVIEW` shows the new buyer messages with «Send it anyway» (acknowledge) and «Edit the message».
    - `MessageThread` shows «Buyer» / «You», the UTC time and the text. With no messages it says «No messages on this dispute yet.»

- [ ] **Step 1: Write the failing tests**

```ts
it('a repeated message needs REPEATS_MESSAGE', /* server: second identical message → 201 repeat true; send without confirm → 409 CONFIRMATION_REQUIRED; confirm with REPEATS_MESSAGE terms → 202 */);
it('the simulator only plays recorded transitions', /* sendAction matches contract after[last] fields; with lag recorded, first read pending; a not-recorded variant → NOT_AUTHORIZED */);
it('ActionFlow: pending shows "Outcome pending confirmation" and "Check again", never "Recorded by PayPal"', /* renderToString */);
it('NEEDS_REVIEW shows the new buyer message and both choices', /* … */);
it('the case page shows the thread from the snapshot', /* App render contains 'Messages' and the simulated buyer message */);
test('server: send_message through the real registry entry, body format from the contract', /* posts body equals contract request body shape */);
```

- [ ] **Step 2: Run the tests and check they fail.** Run `cd apps/web && npx vitest run` and `cd apps/server && node --test test/actions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and check they pass.** Run the same commands and `npm run typecheck`. Expected: PASS. Set `CONTRACTS.send_message.status = 'tested_locally'` once all of this passes.
- [ ] **Step 5: Commit** `git commit -am "send_message end to end (contract-driven simulator, thread, pending state)"`

---

### Task 9: accept_claim

**Precondition:** `accept_claim:REFUND` recorded. `accept_claim:PARTIAL_REFUND` recorded or declined (declined → «Not available»).

**Files:** `apps/web/src/domain/actions.ts`, `actionReadback.ts` (proof from the contract), `actionContracts.ts`, `apps/server/src/actions/calls.ts`, `gateway.ts`, `ActionComposer.tsx`, `ActionFlow.tsx`, and their tests.

**Interfaces:**
- Produces:
  - Compose: the `accept_claim` link; type in `responseOptions.acceptClaimTypes` **and** an available variant (others → 409 `VARIANT_NOT_AVAILABLE`, with the reason «Not available: needs a return address» for return-address types).
  - REFUND passes no amount. For `MERCHANDISE_OR_SERVICE_NOT_RECEIVED` no amount is ever passed (`AMOUNT_SHOULD_NOT_BE_PASSED`; an amount given → 422 `AMOUNT_NOT_ALLOWED`).
  - PARTIAL_REFUND, if available: amount required, < dispute amount in minor units.
  - Terms: amount = the refund amount (REFUND: `pin.amount`), consequence `REFUNDS_BUYER`.
  - `consequenceText`: «PayPal refunds {amount} to the buyer and closes the dispute in the buyer’s favour. This cannot be undone.»
  - The body comes from the contract's recorded request shape.
  - Proof: the contract's attributable acceptance entry. `RESOLVED` alone → `pending`.
  - After an accept, availability is rebuilt from the next fresh read. There is no local closure lock.

- [ ] **Step 1: Write the failing tests**

```ts
it('accept variants: REFUND available; PARTIAL_REFUND and return-address types follow the registry', /* … */);
it('no amount for not-received', /* reason NOT_RECEIVED + amount → AMOUNT_NOT_ALLOWED; REFUND body has no amount field */);
test('owner accept: confirm terms must match exactly; the PayPal body matches the recorded request; RESOLVED alone is pending; the attributable entry records', /* confirm with currency 'EUR' → 409 CONFIRMATION_MISMATCH */);
test('after accept, the next fresh read decides: no links → a message intent is refused ACTION_NOT_OFFERED', /* not by a local lock */);
it('the simulator plays the recorded accept transition', /* … */);
```

- [ ] **Steps 2–5:** run the tests and check they fail, implement, run them and check they pass (`npx vitest run`, `node --test test/actions.test.ts`, `npm run typecheck`), set the registry status to `tested_locally`, then commit `git commit -am "accept_claim (owner only, bound confirmation, contract proof)"`.

---

### Task 10: escalate

**Precondition:** `escalate` recorded, with an attribution field. Without one, its proof is never `recorded`: the variant ships as «Not available: PayPal shows no record attributable to the seller's escalation» unless the owner explicitly accepts pending-only, which is not in this plan.

**Files:** as Task 9.

**Interfaces:**
- Produces:
  - Compose: the `escalate` link, stage `INQUIRY`, a note ≤ 2,000. Terms: consequence `MOVES_TO_CLAIM`, no amount.
  - `consequenceText`: «The inquiry becomes a claim decided by PayPal. Inquiry actions end; what you can do next is what PayPal offers on the claim.»
  - Proof: the contract's attributable escalation entry, or a stage change **plus** the attribution field. A bare stage change → `pending`.
  - No closure lock. Evidence after escalation is allowed only if `evidence:after_escalation` is recorded: then `evidenceSentIn(d, newStage)` is false and the fresh read offers `provide_evidence` with no seller evidence in the current stage, decided by the field from the contract. Otherwise the existing whole-dispute behaviour stays.
  - New buyer messages are shown, not blocking.

- [ ] **Step 1: Write the failing tests**

```ts
test('escalate: a stage change by PayPal without attribution is pending; with the contract’s attribution it records', /* … */);
test('evidence after escalation follows the registry', /* not recorded → SELLER_EVIDENCE_EXISTS as today; recorded variant + fresh read offering provide_evidence + no evidence in CHARGEBACK → evidence intent allowed */);
test('a new buyer message does not hold escalate', /* send 202 */);
```

- [ ] **Steps 2–5:** as Task 9; commit `git commit -am "escalate (owner only, attributable proof, evidence by stage)"`.

---

### Task 11: make_offer

**Precondition:** `make_offer:REFUND` recorded. `make_offer:REPLACEMENT_WITHOUT_REFUND` and `make_offer:withdraw` recorded or declined.

**Files:** as Task 9.

**Interfaces:**
- Produces:
  - Compose: the `make_offer` link; type in `responseOptions.offerTypes` and an available variant. Amount rules follow the contract (REFUND: required, > 0, ≤ dispute amount). Note ≤ 2,000.
  - Duplicate guard: an offer while the fresh read shows a pending seller offer (the contract's offer-history fields) → 409 `DUPLICATE_ACTION` («An offer of yours is pending with the buyer»).
  - Terms: amount, currency, consequence `OFFERS_SETTLEMENT`. `consequenceText` is taken only from the contract's observed outcome: «The buyer is offered {amount}; no money moves unless the buyer accepts.» if the contract shows a pending offer; any closing behaviour only if recorded.
  - Proof: a new seller offer-history entry after `send_started` with the approved type and amount (minor units). Otherwise `pending`.
  - Withdraw: «Not available» unless recorded.

- [ ] **Step 1: Write the failing tests**

```ts
it('a full-refund offer is not assumed to close the dispute', /* proof requires offer entry; RESOLVED alone pending; consequence text from contract */);
it('an offer while one is pending is refused', /* DUPLICATE_ACTION */);
it('amount by minor units: 7 equals 7.00; 7.001 refused at parse', /* … */);
test('server: owner offer, body from the recorded request, proof by offer history', /* … */);
```

- [ ] **Steps 2–5:** as Task 9; commit `git commit -am "make_offer (owner only, pending-offer guard, contract proof)"`.

---

### Task 12: appeal and PROOF_OF_REFUND

**Precondition:** `appeal` recorded or declined (declined → preview only). `evidence:PROOF_OF_REFUND` needs only GET reads of a refund (Task 2) and the provide-evidence contract already in use, plus one prepared write, recorded or declined.

**Files:**
- Create: `apps/server/src/refunds.ts`, `apps/server/test/refunds.test.ts`
- Modify: `apps/web/src/domain/intent.ts` (`composeSubmission`: appeal, `refundsChecked`, partial wording), `apps/web/src/domain/evidenceTypes.ts`, `apps/web/src/domain/types.ts` (`EvidenceSubmission.action: 'provide_evidence' | 'appeal'`), `apps/server/src/validate.ts`, `apps/server/src/app.ts`, `apps/server/src/actions/calls.ts`, `apps/web/src/domain/actionReadback.ts`, `apps/web/src/components/ApproveFlow.tsx` (appeal sends through `sendActionWithReadBack`), `apps/web/src/components/ResponseComposer.tsx` (refund ids field), `apps/web/src/domain/gateway.ts`
- Test: `refunds.test.ts`, `apps/server/test/intent.test.ts`, `apps/server/test/actions.test.ts`, `apps/web/src/domain/intent.test.ts`, `evidenceTypes.test.ts`

**Interfaces:**
- Produces:
  - `checkRefunds(payments: Pick<PaymentsApi, 'getRefund'>, ids: readonly string[], d: Dispute): Promise<{ ok: true; total: Money; partial: boolean } | Problem>`. Each refund must be `COMPLETED` (else 422 `REFUND_NOT_COMPLETED`), belong to the disputed capture (its `up` link capture id; else 422 `REFUND_OTHER_CAPTURE`), be in the same currency (422 `REFUND_CURRENCY`) and have amount > 0. The total must be ≤ the dispute amount, compared in minor units (422 `REFUND_ABOVE_DISPUTE`). 404 → 422 `REFUND_NOT_FOUND`; other failures → 502 `REFUND_UNREADABLE` (never invalidates).
  - The check runs at compose and again on the send-time read. A partial total adds the sentence «Partial refund of {total} of {dispute amount}.» to the notes ahead of the supported sentences (hashed as notes) and to the UI. It is never described as a full resolution. `evidence_info.refund_ids` is sent.
  - `evidenceTypeOptions(…, { refundIds })`: PROOF_OF_REFUND is satisfied when the ids are given.
  - Appeal is evidence-shaped (`action: 'appeal'` and `pin` hashed). It is composed through `/intent` and sent through `/send`. It is owner-only at compose, approve, confirm and send, with consequence `APPEALS_DECISION`. `checkAgainstDispute` requires the `appeal` link (409 `APPEAL_NOT_ALLOWED`). Proof: the contract's attributable appeal entry. New buyer messages do not block it.
  - Simulator: a Dev control «PayPal rules for the buyer», only if the contract recorded such a state.

- [ ] **Step 1: Write the failing tests**

```ts
test('refund checks', /* COMPLETED on capture → ok partial false when equal; 4.00 of 7.00 → ok partial true; PENDING → REFUND_NOT_COMPLETED; other capture → REFUND_OTHER_CAPTURE; EUR → REFUND_CURRENCY; 4+4 of 7 → REFUND_ABOVE_DISPUTE; 404 → REFUND_NOT_FOUND; 500 → 502 */);
test('PROOF_OF_REFUND: checked at compose and send; partial wording in the notes; no Payments write', /* notes start 'Partial refund of 4.00 USD of 7.00 USD.'; fake fetch saw no POST to /v2/payments */);
test('appeal: owner only at every step, link required, proof attributable', /* … */);
it('appeal hashes action and pin; golden unchanged', /* … */);
```

- [ ] **Steps 2–5:** run the tests and check they fail, implement, run them and check they pass (all server and web suites plus typecheck), set the registry statuses, then commit `git commit -am "appeal and PROOF_OF_REFUND (refunds read only; partial shown as partial)"`.

---

### Task 13: Owner-only settlement case and rotation guard

**Files:**
- Create: `packages/cases/src/fixtures/settlementCase.ts`
- Modify: `packages/cases/src/index.ts`, `apps/web/src/domain/types.ts` (`CaseFile.audience?: 'owner'`), `apps/server/src/app.ts` (`caseVisible`, `/api/health`, `rotateIfUsed`, `opsReport`), `apps/server/src/reserve.ts` (`apply`), `apps/server/src/main.ts` (create `IntentStore` before the first `apply`; pass the guard on start and on the bindings reload), `apps/server/src/hosted.ts` (warm-up skips owner-only cases), `apps/web/src/fixtures/inbox.ts`, `apps/web/src/pages/InboxPage.tsx`, `apps/server/bindings.example.json`
- Test: `apps/server/test/reserve.test.ts`, `apps/server/test/reserve-memory.test.ts` (the lote2 file, or its actual name on main), `apps/server/test/hosted.test.ts`, `apps/web/src/App.test.tsx`

**Interfaces:**
- Produces:
  - `SETTLEMENT_CASE_ID = 'PP-R-STL-10190667'`. `settlementCase` is the standard case (same 7.00 USD order) with that id, `audience: 'owner'`, and the summary title «Owner settlement case (sandbox)».
  - Hosted `caseVisible` for an owner-only case requires `role === 'owner'`; anyone else gets 404 `UNKNOWN_CASE`. `/api/health` hides the case from non-owners.
  - `ReserveMemory.apply(pools: BindingPools, held?: (disputeId: string) => boolean)`. It never shifts past a dispute for which `held(dispute)` is true (it stops there). lote2's last-dispute rule and behaviour without `held` are unchanged.
  - `rotateIfUsed` returns without moving and without `markUsed` while `intents.held(binding.dispute)`.
  - `opsReport` bindings gain `held: { intentId: string; since: string } | null`.
  - Warm-up never analyses an owner-only case.

- [ ] **Step 1: Write the failing tests**

```ts
test('settlement case invisible to members and reviewers', /* 404 for reviewer/fullMember GET and compose; owner 200; health bound */);
test('rotateIfUsed holds a dispute that is in flight, uncertain or awaiting read-back; read-back reads the pinned dispute', /* owner accept on A → A RESOLVED, uncertain → binding stays A; readback recorded → next read moves to B; readback again reads A */);
test('ReserveMemory.apply on start honours held', /* reserve-position.json lists A used; send log has an unreconciled send_started on A → new app → active A */);
test('a bindings reload that replaces bindings wholesale keeps a held dispute active', /* main-style reload with new object [A,B,C] → apply(next, held) keeps A; nothing held → lote2 behaviour (A used → B) */);
test('ops report names a held dispute', /* bindings[case].held.intentId === the uncertain intent */);
test('warm-up skips the owner-only case', /* … */);
it('the inbox count is unchanged without an owner seeing the settlement case', /* '8 disputes · …' */);
```

- [ ] **Steps 2–5:** run the tests and check they fail, implement, run them and check they pass (server, cases and web suites plus typecheck), then commit `git commit -am "Settlement case (owner only) and rotation guard in rotateIfUsed and reserve.apply"`.

---

### Task 14: Docs EN/ES with per-variant status

**Files:** each in `docs/` and `docs/es/`: `product/functional-specification.md`, `product/limitations.md`, `user-guide/review-and-submit.md`, `user-guide/accounts-and-permissions.md`, `technical/http-api.md`, `technical/paypal-integration.md`, `technical/configuration.md`, `operations/runbook.md`, `judges/review-guide.md`, `judges/verification-matrix.md`, `quality/testing.md`, `quality/security-and-privacy.md`.

**Interfaces:** consumes the merged code and `CONTRACTS` as they are (the source of truth, not this plan). Follow `C:/nexus/dev/resolvekit-docs/.superpowers/docs-work/RULES.md`.

- [ ] **Step 1:** Run the checker (expected `0 problem(s)`). Build a status table **from `CONTRACTS`** with one row per variant: Not available (reason) · Implemented · Tested locally · Verified in sandbox · Deployed.
- [ ] **Step 2: Write EN.** Cover:
  - the per-variant status table;
  - roles: reviewers send messages only; owner-only actions with the bound second confirmation; previews for others;
  - «Recorded by PayPal» vs «Outcome pending confirmation» and «Check again»;
  - uncertain and its effect (no writes until reconciled), the duplicate guard, and evidence by stage;
  - retention: the approved message is stored in the intent like evidence notes, logs keep only its hash, and the thread is not stored and not given to the analyst;
  - `NEEDS_REVIEW`;
  - PROOF_OF_REFUND reads only, and partial is shown as partial; no refund creation;
  - the settlement case binding in `BINDINGS_JSON` (each dispute appears once) and the rotation guard, with the ops report's `held`;
  - the caps env vars;
  - the routes `/send`, `/confirm`, `/acknowledge`, `/readback`.
  Never describe a variant beyond its status.
- [ ] **Step 3: Write ES** with the same file names, heading counts and content.
- [ ] **Step 4: Run the checker.** Run `node C:/nexus/dev/resolvekit-docs/.superpowers/docs-work/check-docs.mjs .`. Expected: `0 problem(s)`.
- [ ] **Step 5: Commit** `git commit -am "Docs (EN/ES): dispute actions with per-variant status"`

---

### Task 15: Sandbox verification of the built flows (controller only, owner-approved)

> **Implementers do not run this task.** Same rule as Task 3: each run is a prepared request the owner approves individually. Here the request is a run through the **app's own flow** (compose → approve → confirm → send → read-back) on a settlement-case dispute outside the reviewer reserve.

**Files:** `C:/nexus/dev/PayPalAI/evidencia/acciones-verificacion-2026-10-DD.md`; `actionContracts.ts` (`verified_in_sandbox` only for what was observed); the sandbox-findings section of `docs/technical/paypal-integration.md` and its ES twin; the Task 14 status table.

- [ ] **Step 1:** Prepare one run per implemented variant (intent target, expected proof) and present each to the owner.
- [ ] **Step 2:** For each approved run, run it from the app and record the intent id, request id, PayPal status and debug id, the read-back proof and the time to visible.
- [ ] **Step 3:** Update the registry statuses and add fake-based tests for any newly observed response. Run `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 4:** Update the docs status (EN/ES) and run the checker. Expected: `0 problem(s)`.
- [ ] **Step 5:** Commit `git commit -am "Sandbox verification: dispute actions"`. Then hand the whole-branch review to the owner. The form texts (F12/F15) stay the owner's, in `PayPalAI/entrega/formulario.md`, regenerated with `/lz:formulario`, and claim only what is verified.

---

## Self-review notes (remaining spec gaps)

- **Absence proof timing:** [A1]/[A4] allow a retry when a read-back "proves it absent while still available", but they do not say how long after `send_started` an absence counts. The plan takes `absentAfterMs` from the contract (twice the longest observed lag). A variant without a recorded lag never proves absence and stays pending.
- **Evidence «in the current stage»:** the spec does not say how a seller evidence entry is tied to a stage. The plan makes `evidence:after_escalation` a contract variant, decided by the field Task 2/3 finds. Until then the existing whole-dispute block stays.
- **Escalate without an attribution field:** if PayPal shows only a stage change, [A4] makes escalate never «Recorded». The plan ships it as «Not available» in that case. The owner may prefer «available, pending-only».
- **Re-confirm after NEEDS_REVIEW:** [A5] says «re-confirms the same content (one step)». The plan's `/acknowledge` re-arms the approval against a new fresh read. For actions with a second confirmation it does not repeat the amount confirmation, because the terms are unchanged.
- **Message attachment:** «optional confirmed-upload reference» needs its own contract (`send_message:file`). Without one, messages are text only.
- **Settlement case documents:** the plan clones the standard case's 7.00 USD order so `demo:prepare` disputes pass `verifyBinding`. It has no golden analysis, so provide-evidence there answers `NO_ANALYSIS` (documented).
