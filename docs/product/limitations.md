[English](limitations.md) | [Español](../es/product/limitations.md)

# Limitations

What ResolveKit does not do, does not do yet, or has not been shown to do. Checked against the code at commit
`fbe9621` (19/10/2026) and the follow-up lists in `docs/superpowers/plans/`. Code-level issues for contributors are in
[Known issues](../quality/known-issues.md); this page is what a user, merchant or judge needs to know.

## Not available

| Function | State today | Status |
|---|---|---|
| Connecting a merchant's own PayPal disputes | A merchant who signs in with **Continue with PayPal** gets the waiting screen. The app has no Partner Referrals, `merchant-integrations` or `PayPal-Auth-Assertion` code. Sandbox experiments were made outside the app (see [Merchant onboarding](../technical/merchant-onboarding.md)); they are not a feature | **Pending** (not implemented, not deployed, not available) |
| Send message, accept claim, make offer, escalate | The case file lists the actions PayPal allows, but only **Provide evidence** can be sent: choosing another shows «only "Provide evidence" can be sent from this screen for now». `send-message` and `accept-claim` exist as client methods in `packages/paypal` with no route; make-offer and escalate have no code | **Pending** |
| Refunds | No refund code anywhere | **Pending** |
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
  agent runs (5 per person), 20 MeterMCP budgets. Per hour: 6 live analyses and 30 re-checks. Per address: 300 API
  requests and 60 PayPal reads per 5 minutes, 20 uploads, redactions and PDF page reads per 10 minutes. A refusal
  says when it resets.
- **Redeploys** cause 1–2 minutes of errors (a service with a disk has no zero-downtime deploy).
- **Which commit is live** cannot be proven from outside: `fbe9621` is treated as deployed on the owner's
  confirmation and a passing `demo:check` on 19/10/2026.

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
- A covered image is always re-encoded as PNG, so a large photo can exceed the 9.9 MB limit after covering even
  if the JPEG was small. Use a screenshot or a smaller image.
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
- If a session is cancelled while its PayPal authorization is still `PENDING`, MeterMCP does not void that
  authorization.
- Per-person agent runs reset at UTC midnight, not 24 hours after the first run.
- Tool outputs are synthetic; budgets are 0.50–5.00 USD in the sandbox.

## Sign-in and accounts

- **Continue with PayPal** is an identity check built on a no-charge Billing Agreements v1 agreement token (a PayPal
  API family listed under a deprecated path), not Log in with PayPal or OpenID Connect. It does not give ResolveKit
  access to your disputes.
- «Join for this browser only» lasts one session (12 hours). After that, open an invite link that still has uses
  (this creates a new member entry) or ask the Owner.
- On the sign-in page, «Explore without signing in» links to `/cases`, which sends a signed-out visitor back to
  sign-in; use **Try the demo** or `/demo` instead (seen in the code; browser check **Pending**).
- While a new workspace's PayPal connection is being checked, the screen asks again every 5 seconds.

## PayPal behaviour we rely on but do not control

- Timings (a new dispute appearing, status changes after a submission) are what the sandbox showed, not promises.
- An empty list of disputes does not mean there are none when access is uncertain.
- A timeout on a send is treated as unknown: ResolveKit reads back before any retry. This path is tested with fakes;
  it has not been observed against PayPal (**Pending**).
- Webhook event ids are remembered in memory only (2,000): after a restart a repeated event causes a harmless re-read.

See also: [Troubleshooting](../user-guide/troubleshooting.md), [Known issues](../quality/known-issues.md),
[Functional specification](functional-specification.md).
