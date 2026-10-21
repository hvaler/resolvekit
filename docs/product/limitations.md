[English](limitations.md) | [Español](../es/product/limitations.md)

# Limitations

What ResolveKit does not do, does not do yet, or has not been shown to do. Checked against the code at commit
`c12faea` (deployed 21/10/2026) and the follow-up lists in `docs/superpowers/plans/`; the dispute actions against commit
`076c74f` (20/10/2026). Code-level issues for contributors are in
[Known issues](../quality/known-issues.md); this page is what a user, merchant or judge needs to know.

## Not available

| Function | State today | Status |
|---|---|---|
| Connecting a merchant's own PayPal disputes | A merchant who signs in with **Continue with PayPal** gets the waiting screen. The app has no Partner Referrals, `merchant-integrations` or `PayPal-Auth-Assertion` code. Sandbox experiments were made outside the app (see [Merchant onboarding](../technical/merchant-onboarding.md)); they are not a feature | **Pending** (not implemented, not deployed, not available) |
| Send message, accept claim (full or partial), make a partial-refund offer, escalate, evidence after an escalation | Built on recorded contracts and run with fakes; on 20/10/2026 each was sent once through the app's own flow in the sandbox and read back (the branch's server run locally). The code is deployed (`c12faea`, 21/10/2026) but these actions have not yet been exercised on the hosted service; the owner-only ones need the settlement case bound in the hosted `BINDINGS_JSON`, which it is not yet. Per-variant status: [Functional specification](functional-specification.md#56-dispute-actions-other-than-evidence) | Verified in sandbox · Deployed (code); not yet exercised on the hosted service |
| A message with an attachment | The server path and the web composer are tested (one confirmed upload of the case); one message with a file was sent to PayPal through the app in the sandbox (V-7, 21/10/2026, a local run) | Verified in sandbox through the app (V-7); Deployed (`c12faea`, 21/10/2026), not yet exercised on the hosted service |
| Replacement offer | Not available: Not verified with PayPal: never offered on a sandbox dispute | Not available |
| Withdrawing an offer | Not available: PayPal documents no route to withdraw an offer | Not available |
| Appeal | Not available: Not verified with PayPal: the sandbox could not produce an appealable dispute | Not available |
| Proof of refund (evidence) | Not available: Not verified with PayPal: pending sandbox test (W-11). If PayPal asks only for it, no evidence can be sent on that dispute in this delivery | Not available |
| Return types (refund with return, return shipping label) | Not available: Not in this delivery (owner decision) | Not available |
| `provide_supporting_info` | PayPal offered it after evidence in a claim; ResolveKit does not support it | Not available |
| Creating refunds | No code creates or changes a refund. Money moves only through a full accept at PayPal, or when the buyer accepts an offer. In the sandbox a disputed payment was held and could not be refunded outside the case (observed 19/10/2026) | Not planned in this delivery |
| Live (production) PayPal | Nothing has run against live PayPal. Hosted mode refuses to start on `live` without an explicit opt-in. «PayPal sandbox · live» means a live read of a **sandbox** dispute | **Pending** |
| Deleting an account or a workspace | The Owner can revoke members and invites; there is no self-service deletion of people, workspaces or agent runs | **Pending** |
| Backups | No backup code; data lives on the service's disk | **Pending** (see [Backup and recovery](../operations/backup-and-recovery.md)) |

## Sandbox evaluation

- **Only the bound cases.** The evaluation workspace sees only the cases bound to real sandbox disputes (today a
  standard case and an agent-purchase case); every other case opens in the Explore demo.
- **One response per dispute, as observed.** In our sandbox tests PayPal stopped offering `provide_evidence` after
  one submission. This is an observation, not a documented PayPal rule. The case then shows **Evidence recorded by
  PayPal** and a read-only draft.
- **The standard case's reserve is empty** (19/10/2026): its dispute was used, so new sends on it are **Pending**
  until new sandbox disputes are added to its reserve. A case moves to its next reserve dispute only if one is left,
  on its next read, about 15 minutes after evidence is recorded.
- **Case documents are synthetic.** What you upload is real in what it does; the order, label, carrier record and
  buyer messages around it are invented, so a real screenshot can show up as a contradiction.
- **Shared daily caps** (UTC day, server-wide): 60 live analyses, 200 re-checks, 20 evidence sends, 40 uploads, 20
  agent runs (5 per person), 20 MeterMCP budgets; 20 message sends and 20 settling
  actions (accept, offer, escalate). Per hour: 6 live analyses and 30 re-checks. Per address: 300 API
  requests and 60 PayPal reads per 5 minutes, 20 uploads, redactions and PDF page reads per 10 minutes. A refusal
  says when it resets.
- **Redeploys** cause 1–2 minutes of errors (a service with a disk has no zero-downtime deploy).
- **Which commit is live** cannot be proven from outside: `c12faea` is treated as deployed on the owner's
  decision to push it and a `demo:check` on 21/10/2026 that passed apart from the known empty reserve of the standard
  case (`81c6242` earlier on 21/10/2026, `5111b88` on 20/10/2026 and `fbe9621` on 19/10/2026 were treated as deployed the same way).

## Dispute actions

- Only the Owner can accept, offer or escalate; members and reviewers send messages only and see a preview of the rest.
  The owner's settlement case (`PP-R-STL-10190667`) exists for these actions; only the Owner sees it.
- Every rule comes from one recorded sandbox write per variant (20/10/2026), all on «item not received» disputes in
  the inquiry stage, sent while PayPal waited for the seller (a message also while it waited for the buyer): other
  reasons, stages and statuses are refused, not guessed.
- A partial accept is an offer the buyer must agree to; it does not refund or close anything by itself.
- A send whose outcome PayPal does not yet prove holds the dispute («Outcome pending confirmation») until **Check
  again** settles it; nothing else can be sent on that dispute in the meantime.
- What the buyer does after an offer (accept, refuse, counter) was never recorded: ResolveKit follows the actions
  PayPal offers on each fresh read and, as a backstop, takes any later offer entry as ending the pending offer.

## Evidence uploads

| Limit | Value |
|---|---|
| Image | PNG or JPEG, 5 MiB, at most 4096 px a side and 8,294,400 pixels (3840×2160) |
| PDF | 10 MiB and 30 pages; at most 5 pages used; a PDF counts as one upload |
| Sanitised file stored and sent | under 9,900,000 bytes (PayPal takes files under 10 MB) |
| All files of one response | 50,000,000 bytes (PayPal: up to 50 MB per call) |
| Pasted text | 20,000 characters, **Latin-1 only** (a character such as € or curly quotes is refused) |
| Covers | 5 covering passes per image or text, per page for a PDF |
| Per case | 10 uploads (pending, in review and confirmed) |
| Pending | discarded after 24 hours if not confirmed |

Known gaps:
- A noisy multi-page PDF scan may not fit under 9.9 MB once rebuilt; choose fewer pages.
- Barcodes and QR codes keep their content unless you cover the code itself.
- Sending a PDF upload or pasted text to PayPal sandbox: **Pending** (only an image upload has been verified, 18/10/2026).
- Memory use of a 5-page PDF on the hosted service: **Pending** measurement.
- If archiving an old dispute's uploads fails, it is not retried automatically.

## AI analysis

- A verbatim quote proves that the words are in the document, not that the document is true or that the sentence
  follows from it. The verifier is a model; its verdicts can be wrong. You approve what is sent.
- Figures exist only for synthetic evaluation sets; see [Evaluations](../quality/evaluations.md). Do not compare
  rates across different sets. The held-out run on Groq stopped on quota and has not been resumed.
- Model providers process what is sent to them under their own policies; ResolveKit does not control their retention.

## Buying agent

- Two observed sandbox runs (19/10/2026) are examples, not a guarantee of how the model behaves. The model can choose
  badly within the limits; code only checks each action.
- Not yet shown in the sandbox: **Stop** on a running run, the Groq fallback, recovery after a restart during a run,
  a capture that PayPal reports `PENDING`, and the command-line `demo-agent` against the hosted MeterMCP: **Pending**.
- The agent case's run record (evidence «From ResolveKit · run …») appears only when the case's binding names the run;
  no binding does yet, and the agent case's binding points at a session made by the earlier scripted client:
  **Pending**.
- Per-person agent runs reset at UTC midnight, not 24 hours after the first run.
- Tool outputs are synthetic; budgets are 0.50–5.00 USD in the sandbox.

## Sign-in and accounts

- **Continue with PayPal** is an identity check built on a no-charge Billing Agreements v1 agreement token (a PayPal
  API family listed under a deprecated path), not Log in with PayPal or OpenID Connect. It does not give ResolveKit
  access to your disputes.
- «Join for this browser only» lasts one session (12 hours). After that, open an invite link that still has uses
  (this creates a new member entry) or ask the Owner.
- While a new workspace's PayPal connection is being checked, the screen asks again every 5 seconds.

## PayPal behaviour we rely on but do not control

- Timings (a new dispute appearing, status changes after a submission) are what the sandbox showed, not promises.
- An empty list of disputes does not mean there are none when access is uncertain.
- A timeout on a send is treated as unknown: ResolveKit reads back before any retry. This path is tested with fakes;
  it has not been observed against PayPal (**Pending**).
- Webhook event ids are remembered in memory only (2,000): after a restart a repeated event causes a harmless re-read.

See also: [Troubleshooting](../user-guide/troubleshooting.md), [Known issues](../quality/known-issues.md),
[Functional specification](functional-specification.md).
