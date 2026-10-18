# Three environments: Explore demo, sandbox evaluation, merchant space (design)

Block B, part 2, first delivery. Status: draft for the owner's approval, 18/10/2026.

## Intent

The goal is for any merchant to defend **their own PayPal disputes with their own evidence** in ResolveKit. They would do it in a space of their own, without the owner preparing their cases, editing server identifiers or lending an account.

That needs PayPal's third-party permissions. The partner integration uses Partner Referrals with `THIRD_PARTY`, `READ_SELLER_DISPUTE`, `UPDATE_SELLER_DISPUTE` and `ACCESS_MERCHANT_INFORMATION`, and every call carries `PayPal-Auth-Assertion`. On 18/10/2026 the sandbox refused it: `POST /v2/customer/partner-referrals` → `403 NOT_AUTHORIZED`, debug id `ca4c6273b0ad5`. Our app is not enabled as a platform. We have asked PayPal (Discord, `#general-hackathon-question`).

This delivery is the part that does not depend on PayPal's answer. It must work and be verifiable today. It is honest about what does not work yet, and it leaves the minimum integration points so the real connection can be added later without rework.

## The three environments (decided by the owner)

| Environment | Who sees it | Data and documents | Sends to PayPal? |
|---|---|---|---|
| **Explore demo** | Everyone, signed in or not | Fictional cases on the in-browser simulator | **Never** |
| **Sandbox evaluation — Test Store** | Members of the seller workspace (the owner and people invited, e.g. judges) | Cases bound to real PayPal **sandbox** disputes; synthetic documents, identified as such, attachments included | Yes, **only to the sandbox** |
| **Merchant space** | Any other workspace (a merchant who signs in with PayPal) | Their own disputes and documents, once the connection is authorised | Yes, when the connection is authorised. **Today: not available; shown as pending** |

Every screen says which environment it is in, at all times.

## Goals

1. **Explore demo is a separate area.**
   - It is reachable from the landing page, the waiting screen and the account menu.
   - It is clearly marked as a demo, and its documents, analyses and actions never mix with real cases.
   - Nothing done there can reach the ResolveKit server's send path or PayPal. This is guaranteed by construction, not by a lock.
   - The person can go back to their own space in one click.
2. **Sandbox evaluation exists only in the seller workspace.**
   - The bound cases appear only for members of the workspace whose PayPal account is the seller of the bound disputes (today "Test Store").
   - No other workspace sees them in its inbox, nor reaches them through the API.
   - Judges enter with a Test Store invite (reviewer link), as today.
3. **Sandbox warning before submitting.** In the confirm step, right before «Submit evidence to PayPal», evaluation cases show this message (the owner's wording, translated):
   > «This sends test documents to a PayPal sandbox dispute. No real money moves.»
4. **Synthetic documents are identified in the attachments too.**
   - The PDFs already carry «SYNTHETIC TEST DOCUMENT» on every page and a line saying that names and identifiers are fictional.
   - The UI already labels them «Synthetic demo document».
   - This delivery keeps both and checks them with a test that reads the bytes actually sent.
5. **Waiting screen for a new merchant.** This is a merchant who signs in with PayPal and is not the seller workspace (see below).
6. **Minimum integration points** for the future connection (see below), without building onboarding, permissions or calls on their behalf.
7. **Tests** for permissions, isolation between workspaces and the absence of sends from the demo.

## Non-goals (for this delivery)

- No Partner Referrals onboarding, no `PayPal-Auth-Assertion` calls and no third-party permissions are built. Building them on assumptions would prove nothing. A fake PayPal would test our logic, not whether PayPal accepts the flow.
- No real merchant inbox. There is no list of disputes from a merchant's own account.
- No account switching inside one session (today: sign out and sign in again). Only an explicit «Sign out / use another account» is offered.
- No change to how bindings are configured (`BINDINGS_JSON`) or to the evaluation reserve.

## Anti-goals (a failure even if it "works")

- Presenting the merchant connection as working, or replacing it silently with a simulation.
- A demo action that can reach PayPal, or a demo document that ends up in a real or evaluation case.
- Another merchant seeing Test Store's evaluation cases, or acting on them.
- Promising a date, or suggesting the merchant can solve it by changing their settings.

## Merchant waiting screen (agreed with the owner)

This is what a workspace that is not the seller workspace sees in place of its inbox. The owner's text, in English for the interface:

1. **Account status.** «You're signed in with PayPal. Access to your disputes isn't available yet.» Signing in and connecting the disputes are kept apart, so nobody thinks we have already read their account.
2. **Short explanation.** «Connecting disputes for new merchants is being validated and isn't available yet. For now, ResolveKit can't read your disputes or send responses on your business's behalf.» (wording changed by the owner on 18/10: in validation) No date. Nothing implies that changing a setting would fix it.
3. **Main action.** An «Explore demo» button, with «Try the full flow on fictional cases. Nothing you do in the demo is sent to PayPal.»
4. **Secondary: the space.** Members and invites, with «Inviting someone doesn't connect your disputes to PayPal.» This is not shown as a required step.
5. **Exit and help.**
   - Which account they are using (merchant name and masked email, as in the account menu).
   - «Sign out» and «Use another PayPal account» (signs out and goes to sign-in).
   - A short explanation of the three environments.
   - Test Store is not mentioned as reachable: only people with an invite enter it.

**When PayPal enables it** (not in this delivery): block 1 becomes the «Connect my disputes» button. After authorising, and only after one correct read from PayPal, their disputes are shown or the screen confirms they have none.

## Minimum integration points (decided by the owner)

- **Workspace connection state.** The server exposes it on `/api/auth/me` with one of three values:
  - `evaluation`: the seller workspace.
  - `not_connected`: any other.
  - `checking`: the seller ids have not been confirmed with PayPal yet (see «My calls» 5).
  - `connected`: reserved for the future, never produced today.

  The web decides the environment from this field, not from inferences. Local mode (`npm run server`) is today's operator, always live, and stays as `evaluation`.
- **The merchant inbox and the evaluation cases are separate.**
  - The evaluation cases are a set of their own: the case ids in `BINDINGS_JSON`.
  - The demo cases are a different set.
  - A future connected inbox would be a third source, the merchant's disputes from PayPal, with no fixtures.
  - Code must not assume that «inbox = fixtures».

## Rules the design fixes

- **The demo never touches the send path.** Everything in Explore demo (signed in or not) uses the browser-only path: the simulator plus the local intent client. The server's intent, evidence, upload and analysis routes are never called for demo cases. A demo case is not a server case. The demo shows the replayed analyses (no live model calls), as a signed-out visitor sees today.
- **The server refuses evaluation cases to other workspaces.** Every case route (`/api/disputes/:case`, intents, evidence, uploads, analysis, `/progress`, re-check) answers a non-seller workspace as if the case did not exist (404) for evaluation case ids. It does not only lock the costly actions. `/api/health` keeps hiding the bindings from those viewers.
- **The environment is always visible.**
  - The app bar shows «Explore demo · fictional cases, nothing is sent» or «Sandbox evaluation · Test Store · PayPal sandbox» (or the merchant's state).
  - Approval and its records keep the target dispute visible, as today.
- **Evaluation keeps today's guarantees.** Seller check, binding verified against PayPal, re-reading of the dispute, approved content hash, caps, rotation. Nothing changes in the send path.

## Tests (required)

- **Isolation.**
  - A non-seller workspace gets 404 on every case route of an evaluation case. No model call, nothing sent, nothing stored.
  - Its `/api/auth/me` says `not_connected`.
- **Permissions.**
  - In the seller workspace, owner, member and reviewer keep today's permissions.
  - A reviewer invited to Test Store sees the evaluation cases.
  - A merchant who signs in with PayPal (another account) does not see them.
- **The demo never sends.** Web domain tests: the demo route builds its intents with the local client and has no server client. Server side, a demo case id is unknown to the case routes.
- **Synthetic attachments.** The bytes of every demo or evaluation PDF that is sent contain «SYNTHETIC TEST DOCUMENT» on every page.
- **Copy.** The sandbox warning appears in the confirm step only for sandbox evaluation cases. The waiting screen shows the agreed texts. Domain tests, as in the rest of the web.

## Documentation and the submission

- `docs/judges.md` and `README.md`: the three environments, how to enter Test Store with the invite, and the merchant connection marked **in validation, not yet available**, never as working.
- The form's testing instructions (`PayPalAI/entrega/formulario.md`): the same, with no claim that other merchants can connect today.
- If PayPal enables access before submission, this design is extended (onboarding, permissions, merchant inbox), validated with a second, independent sandbox seller account, and the documents are updated.

## Left to the builder

- Routes and component names (e.g. `/demo` and `/demo/cases/:id` for the demo; `/cases` for the workspace inbox).
- The look of the waiting screen and of the environment indicator, within the current design system.
- How the server marks a case id as «evaluation» (from the bindings) and where the 404 refusal is centralised. It must be one place, not per route.
- Where the confirmed seller ids are stored on disk (next to the other hosted data).

## My calls (to check while reading)

1. **Test Store's inbox shows only the cases bound to sandbox disputes** (today the standard one and the agent one). Explore demo has **all 8 fictional cases**, including fictional copies of those two with the same ids. The same ids are safe because the demo never calls the server: it runs in the browser. Its drafts are stored under their own namespace (`demo:`), so they never mix with a Test Store draft of the same case. Cost if wrong: judges would see 2 cases in Test Store, and the other 6 are in the demo, one click away.
2. **The demo shows the replayed analyses, never live ones**, even for someone signed in. That keeps the demo out of the server and its quotas. Cost if wrong: the demo does not show a live model call (Test Store does).
3. **"Add evidence" in the demo is shown disabled, with its reason.** The reason: «Adding your own evidence reads it on the ResolveKit server; it's available in the sandbox evaluation, not in the demo». Uploads and OCR live on the server, and simulating them in the browser would be an invented flow. Cost if wrong: the demo does not show uploads.
4. **Local mode stays as it is** (`npm run server`: the operator in `evaluation`, all cases through the server). The guarantee that «a demo case is unknown to the server» and the 404 to other workspaces apply in **hosted** mode, and the tests say so.
5. **The seller workspace does not depend on PayPal answering at that moment.** Today it is worked out by reading the bound disputes, and an unreadable one is skipped. If the sandbox fails, Test Store would appear as `not_connected`, and its judges would see the waiting screen and 404s: a false message. So:
   - the server keeps on disk the last seller merchant ids confirmed by PayPal, and uses them while it cannot read again;
   - if it has never managed to confirm any, `/api/auth/me` answers `checking` («Checking your PayPal connection…»), never `not_connected`.
   Cost if wrong: if a binding changed to another seller while PayPal was failing, the old seller would keep access until the next successful read. The send stays protected, because it re-reads the dispute and checks the seller.
6. **Signed out**, the visitor lands on the landing page and Explore demo. `/cases` sends them to sign in. A signed-out visitor counts as «non-seller» for the 404.
7. **A member invited to a merchant workspace** (not the owner) sees the same waiting screen, with the first line adapted: «This workspace isn't connected to its PayPal disputes yet.» The owner keeps «You're signed in with PayPal…».
8. **The texts go in English**, faithful to the owner's Spanish wording.
