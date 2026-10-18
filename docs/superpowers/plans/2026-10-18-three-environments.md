# Three Environments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split ResolveKit into Explore demo (browser-only, never sends), Sandbox evaluation (Test Store, the seller workspace, bound sandbox disputes only) and the merchant space (a waiting screen while the dispute connection is in validation and not yet available), with the server refusing everything else.

**Architecture:**
- The server decides one connection state per workspace (`evaluation | not_connected | checking`). It remembers the last seller ids PayPal confirmed, so a slow sandbox never demotes Test Store.
- In hosted mode the server answers case routes only for bound cases and only to the seller workspace; everything else gets 404 `UNKNOWN_CASE`.
- The web mounts the demo under `/demo` with a services provider forced to the simulator (no server gateway, no analysis client, local intents), and routes `/cases` by the connection state.

**Tech Stack:** TypeScript monorepo (npm workspaces), Node 24 running `.ts` directly; server and package tests use `node:test` + `node:assert/strict`; the web is React with vitest, domain-only tests (no DOM).

**Spec:** `docs/superpowers/specs/2026-10-18-three-environments-design.md` (approved 18/10/2026; its «My calls» are binding).

## Global Constraints

- Hosted mode only for the new refusals; **local mode (`npm run server`, no gate) behaves exactly as today**. Tests name the mode.
- **Connection values:**
  - `'evaluation'` (the workspace's payer id is a seller of a bound dispute);
  - `'not_connected'`;
  - `'checking'` (no seller id ever confirmed and the last read was incomplete);
  - `'connected'` is reserved and never produced.
- Refusal to non-seller viewers and for unbound case ids, hosted: `404 { error: 'UNKNOWN_CASE' }`. The same body everywhere, decided in one function.
- The demo never calls `/api/disputes/*`, `/api/cases/*` or the upload routes. Its drafts are stored under scope `demo`.
- Copy (verbatim, English):
  - Owner waiting line: `You're signed in with PayPal. Access to your disputes isn't available yet.`
  - Member waiting line: `This workspace isn't connected to its PayPal disputes yet.`
  - Explanation: `Connecting disputes for new merchants is being validated and isn't available yet. For now, ResolveKit can't read your disputes or send responses on your business's behalf.`
  - Demo button: `Explore demo`, with `Try the full flow on fictional cases. Nothing you do in the demo is sent to PayPal.`
  - Invites note: `Inviting someone doesn't connect your disputes to PayPal.`
  - Account actions: `Sign out` and `Use another PayPal account` (signs out, then goes to `/signin`).
  - Checking state: `Checking your PayPal connection…`
  - Sandbox warning (confirm step, evaluation cases on `env === 'sandbox'`): `This sends test documents to a PayPal sandbox dispute. No real money moves.`
  - Demo upload reason: `Adding your own evidence reads it on the ResolveKit server; it's available in the sandbox evaluation, not in the demo.`
  - App bar indicators:
    - demo: `Explore demo · fictional cases, nothing is sent`;
    - evaluation: `Sandbox evaluation · <workspace name> · PayPal sandbox`.
- Environments help (three lines, shown on the waiting screen and from the account menu):
  - `Explore demo: fictional cases on a simulator. Nothing is sent to PayPal.`
  - `Sandbox evaluation: invited people only. Test documents go to PayPal sandbox disputes; no real money moves.`
  - `Your merchant space: your own disputes and evidence, once the dispute connection is validated and available.`
- No new dependencies. The send path (binding verification, seller check, content hash, caps, rotation) is not changed.

## Review Focus

1. **The sandbox is unreadable when a judge signs in to Test Store.** They must get `evaluation` (remembered sellers) or `checking`, never the merchant waiting screen. Pinned in Task 1.
2. **An old link to an unbound case under `/cases/...`** (docs, bookmarks), e.g. `/cases/PP-R-PLN-10189901`, opened in the seller workspace. It must go to `/demo/cases/PP-R-PLN-10189901`, never a blank page or an error. Pinned in Task 4.
3. **`BINDINGS_JSON` has no bound case at the moment** (rotation, misconfiguration). Test Store's inbox must say `No sandbox disputes are bound right now.` with the demo link, not show an empty grid. Pinned in Task 4.
4. **Drafts saved before this change under scope `local`** (signed-out visitors) must not appear in the demo or crash it. The demo reads scope `demo` only. Pinned in Task 3.
5. **A signed-out visitor opening a Test Store case link** must reach `/signin?next=/cases/<id>` and come back to it after joining or signing in. Pinned in Task 4.

---

### Task 1: Connection state and remembered sellers (server)

**Files:**
- Create: `apps/server/src/sellers.ts`
- Modify: `apps/server/src/app.ts` (`sellerIds`, around lines 365-384), `apps/server/src/hosted.ts` (`refreshSellers`, `isConnected`, `gate.live`, `gate.reserve`, around lines 152-215), `apps/server/src/auth.ts` (`me`, line 175; the `isConnected` option type), `apps/server/src/main.ts` (wire the file `join(dataDir, 'sellers.json')`)
- Test: `apps/server/test/sellers.test.ts` (new), `apps/server/test/auth.test.ts`

**Interfaces:**
- Produces:
  - `type Connection = 'evaluation' | 'not_connected' | 'checking'` (exported from `sellers.ts`).
  - `class SellerMemory { constructor(o: { file: string | null }); remembered(): ReadonlySet<string>; confirm(ids: ReadonlySet<string>): void }`. `file: null` keeps it in memory; writes are atomic, like the other stores.
  - `api.sellerRead(): Promise<{ ids: Set<string>; complete: boolean }>`. `complete` is false when any bound dispute could not be read. `sellerIds()` stays and returns `ids`.
  - In hosted, `connectionOf(payerId): Promise<Connection>` is used by `auth.me` and by `gate.live` (live ⇔ `evaluation`).
  - `/api/auth/me` returns `workspace: { id, name, connection, connected }`, with `connected = connection === 'evaluation'`, kept for compatibility.
- Rule: `effective = complete ? read.ids : union(read.ids, memory.remembered())`. Then `confirm(read.ids)` when `complete && read.ids.size > 0`. The connection is `'evaluation'` if `effective.has(payerId)`; otherwise `'checking'` if `effective.size === 0 && !complete`; otherwise `'not_connected'`.

- [ ] **Step 1: Write the failing tests** in `sellers.test.ts`:
  - `remembers confirmed sellers across instances (file)`: confirm `{'M1'}`, then a new `SellerMemory` on the same file has `remembered()` equal to `{'M1'}`.
  - `an unreadable sandbox keeps Test Store in evaluation`: a hosted app with a stub PayPal; the first read succeeds with seller `M1`; then `disputes.get` throws. `/api/auth/me` for a `M1` workspace says `connection: 'evaluation'`.
  - `never confirmed and unreadable → checking, never not_connected`: `disputes.get` always throws; `/api/auth/me` for any workspace returns `'checking'`.
  - `another PayPal account is not_connected when the read is complete`.
  - `a reviewer invited to the seller workspace gets evaluation` (join by invite, then `/api/auth/me`).

  Reuse the hosted test helpers from `apps/server/test/hosted.test.ts` and `auth.test.ts` for sign-in.
- [ ] **Step 2: Run** `cd apps/server && node --test test/sellers.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `sellers.ts`, `sellerRead`, `connectionOf`, the `me` field and the wiring in `main.ts`.
- [ ] **Step 4: Run** `node --test test/sellers.test.ts test/auth.test.ts test/hosted.test.ts`. Expected: PASS. Update `auth.test.ts:165`/`:186` to assert `connection` too.
- [ ] **Step 5: Commit** `feat(server): workspace connection state, remembered sellers so a slow sandbox never demotes Test Store`.

### Task 2: Hosted case gate (server)

**Files:**
- Modify: `apps/server/src/app.ts`: one `caseVisible(req, caseId): Promise<boolean>` used at the top of `analysisRoute`, `uploadRoutes` dispatch and the `/api/disputes/...` branch of `route` (lines ~1120-1172).
- Test: `apps/server/test/environments.test.ts` (new); adjust `apps/server/test/hosted.test.ts` and `auth.test.ts` where they expected simulated server intents in hosted mode.

**Interfaces:**
- Consumes: Task 1 (`gate.live` ⇔ `evaluation`).
- Produces: `caseVisible`. In local mode (no `opts.gate`) it is `!!CASE_FILES[caseId]` (today's behaviour). In hosted it is `!!bindingOf(caseId) && await viewerLive(req)`. A refusal is `json(404, { error: 'UNKNOWN_CASE' })`, before any model call, PayPal call, store write or cap reservation.

- [ ] **Step 1: Write the failing tests** in `environments.test.ts` (hosted app with stub PayPal and a stub analyst that counts calls). For each of these routes:
  - `GET /api/disputes/:id`
  - `POST /api/disputes/:id/intent`
  - `GET /api/disputes/:id/audit`
  - `POST /api/disputes/:id/evidence`
  - `GET /api/cases/:id/analysis`
  - `POST /api/cases/:id/analysis`
  - `GET /api/cases/:id/analysis/progress`
  - `POST /api/cases/:id/analysis/verify`
  - `GET /api/cases/:id/uploads`
  - `POST /api/cases/:id/uploads`

  …assert:
  - `bound case, another workspace → 404 UNKNOWN_CASE, analyst calls 0, PayPal writes 0`
  - `bound case, signed out → 404 UNKNOWN_CASE`
  - `unbound demo case (PP-R-PLN-10189901), seller workspace → 404 UNKNOWN_CASE`
  - `bound case, seller workspace → not 404` (status as today for each route)
  - `local mode: unbound case still has intents and analysis` (one route is enough)
- [ ] **Step 2: Run** `cd apps/server && node --test test/environments.test.ts`. Expected: FAIL (today's statuses differ).
- [ ] **Step 3: Implement** `caseVisible` and call it in the three entry points; remove the now-dead per-route `NOT_BOUND … runs on the simulator` branch for hosted.
- [ ] **Step 4: Run** `npm run test:server`. Expected: PASS after updating the hosted tests that relied on server intents for simulated cases. Each changed assertion gets a one-line comment naming this plan.
- [ ] **Step 5: Commit** `feat(server): hosted case routes answer only bound cases to the seller workspace (UNKNOWN_CASE otherwise)`.

### Task 3: Demo area services and environment model (web)

**Files:**
- Create: `apps/web/src/domain/environment.ts`, `apps/web/src/domain/environment.test.ts`
- Modify:
  - `apps/web/src/app/services.tsx`: a prop `area?: 'demo' | 'workspace'`, default `'workspace'`. With `'demo'`:
    - the gateway is the simulator only, with no `HttpDisputeGateway`;
    - `analysis` is null, so the bundled golden analyses replay;
    - `intents` is a `LocalIntentClient`;
    - the account (`demo`, `signOut`) still comes from the server.
    The context exposes `area`.
  - `apps/web/src/domain/demoClient.ts`: `DemoState.workspace.connection`.
  - `apps/web/src/pages/CasePage.tsx`: draft scope `'demo'` in the demo area.

**Interfaces:**
- Produces:
  - `type Environment = { kind: 'demo' } | { kind: 'evaluation'; workspace: string } | { kind: 'merchant'; owner: boolean } | { kind: 'checking' } | { kind: 'signed-out' } | { kind: 'local' }`
  - `environmentOf(area: 'demo' | 'workspace', demo: DemoState | null): Environment`. `demo === null` means local mode, so `local`. In the `demo` area the result is always `demo`.
  - `casesBase(area): '/demo/cases' | '/cases'`
  - `draftScope(area, personId: string | null): string`, which returns `'demo'` in the demo area and otherwise `personId ?? 'local'`.
  - `useServices().area`.

- [ ] **Step 1: Write the failing tests** (`environment.test.ts`):
  - `the demo area is demo whoever is signed in`
  - `evaluation / not_connected / checking map to evaluation / merchant / checking`
  - `merchant owner vs member` (person role `owner` → `owner: true`)
  - `local mode (no account state) is local`
  - `casesBase`
  - `draftScope: demo always 'demo'; a draft saved under 'local' is not the demo's` (the keys differ, via `draftKey` from `domain/draftStore.ts`)
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/domain/environment.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the module, the `area` prop and the scope.
- [ ] **Step 4: Run** `npx vitest run` and `npm run typecheck` (root). Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): Explore demo services (simulator only, local intents, demo drafts) and the environment model`.

### Task 4: Routes and inboxes (web)

**Files:**
- Modify:
  - `apps/web/src/App.tsx`:
    - routes `/demo` and `/demo/cases` (demo inbox), `/demo/cases/:id/*` (demo case), all under `<ServicesProvider area="demo">`, nested so the outer account state is reused;
    - `/cases` and `/cases/:id/*` choose by `environmentOf`;
    - `Home` sends a signed-out visitor to the landing page and a signed-in one to `/cases`.
  - `apps/web/src/pages/InboxPage.tsx`: demo area shows all `inbox` fixtures; evaluation shows only `health.bound` cases, plus a link `Explore demo · <n> more fictional cases`.
  - `apps/web/src/pages/LandingPage.tsx`: `try-demo` links to `/demo`.
  - Internal case links use `casesBase(area)`.
- Test: `apps/web/src/domain/environment.test.ts` (pure routing functions), `apps/web/src/domain/inbox.test.ts`.

**Interfaces:**
- Consumes: Task 3.
- Produces:
  - `workspaceRoute(env: Environment, path: { caseId: string | null }, bound: readonly string[]): { kind: 'inbox' } | { kind: 'case'; id: string } | { kind: 'redirect'; to: string } | { kind: 'waiting' } | { kind: 'checking' }`
  - `evaluationRows(all: InboxDispute[], bound: readonly string[]): InboxDispute[]`

- [ ] **Step 1: Write the failing tests:**
  - `signed-out /cases/PP-R-TVH-10190665 → redirect /signin?next=%2Fcases%2FPP-R-TVH-10190665`
  - `evaluation, unbound id → redirect /demo/cases/PP-R-PLN-10189901`
  - `evaluation, bound id → case`
  - `merchant → waiting` (inbox and any case id)
  - `checking → checking`
  - `local → inbox/case as today`
  - `evaluationRows keeps bound cases only, in the inbox order`
  - `no bound case → empty rows`: InboxPage shows `No sandbox disputes are bound right now.` (the copy is exported as a constant, and the test asserts it is used for 0 rows)
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/domain`. Expected: FAIL.
- [ ] **Step 3: Implement** the functions and the routes.
- [ ] **Step 4: Run** `npx vitest run`, `npm run typecheck`, `npm run build` (root). Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): /demo for everyone, /cases by environment (evaluation inbox of bound cases, waiting, checking)`.

### Task 5: Waiting screen, environment indicator and copy (web)

**Files:**
- Create: `apps/web/src/pages/WaitingPage.tsx`, `apps/web/src/components/EnvironmentsHelp.tsx`, `apps/web/src/domain/copy.ts` (the Global Constraints strings as named exports), `apps/web/src/domain/copy.test.ts`
- Modify:
  - `apps/web/src/components/AppBar.tsx`: indicator per `Environment`.
  - `apps/web/src/components/AccountMenu.tsx`:
    - the `ws.connected` panel becomes per `connection`;
    - add `Use another PayPal account`;
    - add a link to the environments help;
    - add `Explore demo`.
  - `apps/web/src/components/ApproveFlow.tsx`: the sandbox warning in the confirm step, above the checkbox, when the case is evaluation and `mode.env === 'sandbox'`.
  - `apps/web/src/pages/CasePage.tsx`: in the demo area, `+ Add evidence` is disabled with the demo upload reason as its title and visible note.

**Interfaces:**
- Consumes: Tasks 3-4.
- Produces:
  - `waitingCopy(env: { kind: 'merchant'; owner: boolean }): { status: string; explanation: string; demoButton: string; demoNote: string; invitesNote: string }`
  - `sandboxNotice(kind: Environment['kind'], payPalEnv: string | null): string | null`
  - `environmentLabel(env: Environment, workspaceName: string | null): string | null`

- [ ] **Step 1: Write the failing tests** (`copy.test.ts`):
  - `owner and member waiting lines (verbatim)`
  - `sandboxNotice only for evaluation on sandbox`: `null` for demo, local, live env and merchant
  - `environmentLabel for demo and evaluation (verbatim), null for local`
  - `demo upload reason (verbatim)`
  - `environments help has the three lines (verbatim)`
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/domain/copy.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The screen layout follows the design: status, explanation, primary `Explore demo`, secondary members and invites with the note, account and exit, help. Use the existing `ui` components.
- [ ] **Step 4: Run** `npx vitest run`, `npm run typecheck`, `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): merchant waiting screen, environment indicator, sandbox warning before submit, demo upload note`.

### Task 6: Synthetic attachments as sent (server test)

**Files:**
- Test: `apps/server/test/environments.test.ts` (add)

**Interfaces:**
- Consumes: Task 2 (seller workspace on a bound case).

- [ ] **Step 1: Write the test** `every PDF composed for a bound standard case says SYNTHETIC TEST DOCUMENT on every page`. Compose an intent through the API as the seller workspace, then take the files the stub PayPal receives on send. For each `application/pdf` file, the count of `SYNTHETIC TEST DOCUMENT` in the bytes must equal the count of `/Type /Page` objects (excluding `/Pages`). Uploads are excluded: they are the merchant's own files.
- [ ] **Step 2: Run** `cd apps/server && node --test test/environments.test.ts`. Expected: PASS if today's PDFs are right. If it fails, fix `apps/server/src/documents.ts` / `packages/pdf/src/pdf.ts` so the header is on every page.
- [ ] **Step 3: Commit** `test(server): the synthetic header is on every page of every PDF actually sent`.

### Task 7: Documentation

**Files:**
- Modify: `docs/judges.md`, `README.md`

- [ ] **Step 1:** Describe the three environments with the help lines from Global Constraints:
  - Explore demo at `/demo`, open to everyone, with nothing sent.
  - Test Store by invite, where a judge enters with the reviewer link and gets the bound sandbox cases and the sandbox warning.
  - The merchant connection **in validation, not yet available**, with the waiting screen described, never claimed as working.
- [ ] **Step 2:** Update every `/cases/<id>` link to an unbound case so it points to `/demo/cases/<id>`. Bound case links stay under `/cases/`.
- [ ] **Step 3: Run** `npm test` and `npm run typecheck`. Expected: PASS. Run `grep -n "/cases/PP-R-" docs/judges.md README.md` and check that each hit is a bound case or under `/demo/`.
- [ ] **Step 4: Commit** `docs: three environments; merchant connection in validation`.
