[English](review-guide.md) | [Español](../es/judges/review-guide.md)

# Review guide for judges

**Demo:** [resolvekit-i3j2.onrender.com](https://resolvekit-i3j2.onrender.com) · **Video:** Pending (coming with the
submission) · **Code:** [github.com/hvaler/resolvekit](https://github.com/hvaler/resolvekit) · **Evidence:**
[verification matrix](verification-matrix.md) · [evaluations](../quality/evaluations.md) ·
[PayPal integration and sandbox findings](../technical/paypal-integration.md)

Exact control names, click by click: [demo walkthrough](demo-walkthrough.md).

## What ResolveKit is

- **Problem.** A PayPal dispute is a deadline plus scattered proof. Small merchants answer late, or with claims they
  cannot prove. Agent purchases (an AI paying for tools) add disputes with no shipping label to show.
- **Audience.** A small merchant answering PayPal disputes without a disputes team.
- **Value.** A case file and a draft response where every sentence cites the exact words it rests on, unsupported
  sentences are struck and never sent, the merchant approves the exact content, and the result is read back from
  PayPal. For agent purchases, the evidence is MeterMCP's per-call receipt of a budget the buyer approved in PayPal.

## The 5-minute path

| Minute | Do | Look for |
|---|---|---|
| 1 | Open the reviewer link from the submission form and join (**Join for this browser only** is fastest) | The app bar: *Sandbox evaluation · Test Store · PayPal sandbox*; the inbox with the bound cases |
| 2 | Open **PP-R-TVH-10190665** | **PayPal sandbox · live** with a dispute id in the app bar; the timeline; hover a citation to light up its words; a struck sentence |
| 3 | Resolve the address contradiction ("Apt 4" vs "Apt 4B") with **Explain in response** | The button changes from *Resolve 1 item to continue* to **Review what will be sent →** |
| 4 | **Review what will be sent →** → **Continue to confirm →** → tick the approval → **Submit evidence to PayPal** (only while the case has a fresh dispute; the standard case's reserve was empty on 19/10/2026) | The server-composed content with intent id and content hash; then **Recorded by PayPal** with a field-by-field comparison |
| 5 | Open `/agent` (**Try the buying agent** in the inbox) and start a run with an example goal | Steps with the model's short reasons, the approval link, the receipt from MeterMCP |

If the standard case was already used (see [below](#if-a-dispute-was-used-the-reserve-is-empty-or-a-cap-is-reached)),
do minutes 2–4 on the same case in the **Explore demo** (`/demo/cases/PP-R-TVH-10190665`): identical flow, sent to the
in-browser simulator instead of PayPal.

## What PayPal, AI and MeterMCP contribute

| Part | Contribution | Status |
|---|---|---|
| PayPal Customer Disputes API v1 | Reads the bound dispute (status, stage, reason, requested evidence, allowed actions, due date); sends `provide-evidence` with notes and files; reads the dispute back | Verified in sandbox (two reviewers sent evidence, «Recorded by PayPal · 6 of 6 fields», 17/10/2026) · Deployed |
| PayPal webhooks | `CUSTOMER.DISPUTE.*` events verified with PayPal's documented postback method; the event is only a hint and the dispute is re-read | Verified in sandbox (17/10/2026) · Deployed |
| PayPal Orders v2 / Payments v2 | MeterMCP's budget: an `AUTHORIZE` order for exactly the cap; on close, a final partial capture of the successful calls (the remainder was no longer held in our sandbox runs) or a void | Verified in sandbox (09/10 and 19/10/2026) · Deployed |
| **Continue with PayPal** | Identifies a merchant's PayPal account with a no-charge Billing Agreements v1 agreement token (deprecated API family). It is not Log in with PayPal and gives no access to disputes | Verified in sandbox (10/10/2026) · Deployed |
| AI analyst (Gemini `gemini-3.8-flash`, Groq `openai/gpt-oss-120b` fallback) | Extracts facts with verbatim quotes, builds the timeline, finds contradictions, drafts; a separate call verifies each sentence against its own quotes | Deployed; evaluated on synthetic sets only ([evaluations](../quality/evaluations.md)) |
| Deterministic code | Drops non-verbatim quotes; caps sentences with unquoted numbers or flagged documents; rules choose action and evidence type | Implemented · Tested locally · Deployed |
| Buying agent (same models, function calling) | Picks one MeterMCP tool per turn; code validates tool, arguments, price and limits before each call | Verified in sandbox (two runs, 19/10/2026, examples) · Deployed |
| MeterMCP | A metered MCP gateway: paid tools (`quote_lookup` 0.05, `deep_report` 0.40, `bulk_export` 0.92 USD), failed calls never charged, receipts with request hashes | Verified in sandbox · Deployed |

Only `provide-evidence` is sent end to end. The case file lists every action PayPal allows (for example **Send
message**, **Accept claim**, **Escalate**), but choosing one other than **Provide evidence** keeps the send blocked
with *only "Provide evidence" can be sent from this screen for now*. No refunds, offers, messages or claim acceptance
are sent by the product.

## What is real, synthetic, simulated or stored

| Item | Kind | Notes |
|---|---|---|
| The bound PayPal disputes in the sandbox evaluation | **Real (sandbox)** | Real sandbox payments and buyer disputes; reads and sends really call PayPal. No real money |
| «PayPal sandbox · live `PP-R-…`» in the app bar | **Real (sandbox)** | "live" means a live read of a sandbox dispute, not PayPal's live environment |
| Order, label, carrier record, buyer message of each case | **Synthetic** | Invented documents; the PDFs sent to PayPal are headed as synthetic test documents |
| Your uploads | **Real input** | Read on the server, covered, cited and, once confirmed, sent to the sandbox dispute |
| AI analysis and re-checks | **Real model output** | "cached" = stored result of an earlier model run; "live" = just run |
| Buying-agent decisions on `/agent` | **Real model output** | A model's choices, checked by code; one run is an example, not a guarantee |
| MeterMCP budget, capture, void, receipt | **Real (sandbox)** | Real Orders v2 / Payments v2 records |
| MeterMCP tool outputs | **Synthetic** | Deterministic demo data; each result says so |
| An injected failure | **Simulated on purpose** | Only when *Simulate an outage* is ticked; labelled *injected*, never charged |
| Every case in the Explore demo | **Simulated** | In-browser simulator, stored ("golden") analyses; nothing reaches PayPal |
| The 1.37 USD agent case as it opens in the demo | **Synthetic demo data** | Invented demo data whose figures match a sandbox session made by a scripted client on 09/10/2026; tests the analyst, not the agent |
| The bound agent case **PP-R-MMC-10190702** | **Real (sandbox)**, scripted client | Its receipt is from a session made by the earlier scripted client, not a model-driven run (as of 19/10/2026) |

## Access and recommended environment

- **Recommended:** the **Sandbox evaluation** (Test Store), entered with **the reviewer link from the submission
  form**. Open it, type your name, then **Create a passkey and join** or **Join for this browser only**. Your name
  appears in the audit trail of what you approve. The reviewer link sets when your access ends.
- **No account needed:** the **Explore demo** at `/demo`, open to everyone. Same screens on fictional cases; nothing is
  sent; **+ Add evidence** is disabled there.
- **Do not expect** your own PayPal account to work: **Continue with PayPal** leads a merchant to a waiting screen
  (*Connecting disputes for new merchants is being validated and isn't available yet…*). That is the real status
  (Pending), not an error.
- To approve an agent budget, use **the PayPal sandbox buyer (personal) account from the submission form**. In our
  19/10/2026 sandbox run PayPal refused the approval when it was made with the seller's business account («Estás entrando en la cuenta del vendedor…» (PayPal's page was in Spanish; roughly «you are signing in to the seller's account»; recorded truncated)); this is an observation, not a documented PayPal rule.

## Main path: answer a dispute

1. In the Test Store inbox open **PP-R-TVH-10190665** ("item not received", inquiry stage).
2. Read the case header (all PayPal fields come from the latest PayPal read), the **Timeline**, the **Evidence** column
   and the **Response draft**. Hover a citation chip (for example `E3 · UPS tracking`): the quoted words light up.
3. Sentence states: **Supported**, **Needs review** (with the reason; **Rephrase to what the evidence shows** applies
   the verifier's rewrite and checks it again) and **Removed: no supporting evidence** (struck, never sent). **Edit**
   any sentence: the server checks the new text against the case file.
4. Resolve the contradiction card (**Explain in response**, or **Mark resolved…** with a note).
5. **Review what will be sent →** shows *Exactly what goes to PayPal*, composed by the ResolveKit server (intent id,
   content sha256), next to the claim ↔ proof list. **Continue to confirm →**, tick *I'm … and I approve submitting this
   evidence…*, then **Submit evidence to PayPal**. The confirm step says *This sends test documents to a PayPal sandbox
   dispute. No real money moves.*
6. The server checks again on a fresh PayPal read, sends, and the page reads the dispute back. **Recorded by PayPal**
   appears only when PayPal lists new seller evidence that matches what was sent (evidence type, notes, carrier,
   tracking, file names); otherwise it says what differs or that nothing new is recorded.

Accepted by PayPal ≠ dispute won: PayPal then decides. Optional: **Re-run with AI** runs the analyst live (about
30–60 s; 35 s observed on 17/10/2026).

## Optional: the buying agent

1. Open `/agent` (inbox: **Try the buying agent**).
2. Pick an example goal or write one (up to 300 characters); set **Budget cap (USD, 0.50 to 5.00)**; optionally tick
   *Simulate an outage: the first call to Deep report fails (marked as injected)*; **Start the run**.
3. On the first paid call that fits, **Approve in PayPal** appears: approve with the sandbox buyer account from the
   submission form. The run continues after the approval.
4. Watch **Steps** (tool, price, OK or FAILED, result, the model's short stated reason), **Answer**, **Budget and
   receipt** (captured and released, as MeterMCP's receipt says) and the model usage line (never charged to PayPal).
5. Tick two runs in **Your runs** and press **Compare**. **Stop** ends a running run (Stop in the sandbox: Pending).

Observed on 19/10/2026 (examples): with an injected failure the run ended *The tools cannot meet this goal* (captured
0.05, released 1.95 of 2.00 USD); another goal ended *Done* (captured 0.92, released 1.08). Limits: one running run
per person, 5 per person per day, 20 per day in total.

Optional for MCP users: MeterMCP's public `/mcp` endpoint works from your own MCP client with the demo code from the
submission form; see [MCP tools](../technical/mcp-tools.md).

## Upload and sanitise a document

In a Test Store case press **+ Add evidence**:

1. Choose a PNG/JPEG screenshot (up to 5 MiB, 4096 px a side, 8,294,400 pixels) or a PDF (up to 10 MiB and 30 pages),
   or paste text into **Or paste text (an email thread, a chat)** and press **Add pasted text** (Latin-1 only, up to
   20,000 characters).
2. Cover what must not be shared: drag rectangles on an image or a PDF page; on pasted text select the passages to
   remove. Then **Read again from the covered image** (image), **Cover this page and read it again** (PDF page) or
   **Remove and read again** (text). The text shown is read from the covered file by local OCR on the server.
3. Correct a misread line if needed (it is marked *corrected by* you). On a PDF you can transcribe a missed line by
   marking its area outside any cover. **Show it for this page** shows the PDF's own text as a hint only.
4. **Confirm as evidence** (or **Discard**; an unconfirmed upload is removed after 24 hours). It becomes the next
   evidence number (E7, E8…). Press **Re-run with AI** so the analysis can cite it.
5. A sentence resting on a corrected or transcribed line asks for your explicit confirmation before it can be sent.

PayPal receives only the sanitised file, named `E<n>-upload.png`, `E<n>-upload.pdf` or `E<n>-pasted.pdf`. A longer PDF
asks you to choose up to 5 pages. Covering the text next to a barcode or QR code does not hide what the code holds.
Do not upload personal data you care about. Status: image upload sent to PayPal and recorded (18/10/2026); PDF and
pasted-text sends to PayPal Pending. Details: [PDF review](../user-guide/pdf-review.md).

## If a dispute was used, the reserve is empty or a cap is reached

| You see | Why | What to do |
|---|---|---|
| The send button reads **Evidence recorded by PayPal** and the draft is read-only | Someone already sent evidence to this sandbox dispute; in our sandbox tests PayPal's `provide_evidence` action disappeared after one submission (observed, not a documented rule) | Read the read-back, then come back later: about 15 minutes after a send, the next read moves the case to its next reserve dispute, **if the reserve has one**. Or walk the same flow in the Explore demo |
| The case stays on a used dispute | The reserve of fresh sandbox disputes is empty (the standard case's was empty on 19/10/2026; the operator refills it) | Use the Explore demo for the send step; everything else in Test Store still works |
| *PayPal is processing this new dispute. Actions appear shortly.* | A new sandbox dispute first shows `UNDER_REVIEW` with no seller actions; it opened after a few minutes in our tests | Wait a few minutes and open the case again |
| A message with a reset time (for example *The demo's daily agent runs are used up; they reset at …*) | Shared caps: per day 60 live analyses, 200 re-checks, 20 evidence sends, 40 uploads, 20 agent runs (5 per person), 20 MeterMCP budgets; per hour 6 live analyses and 30 re-checks; per-address request limits | Wait for the stated time, or use the stored analysis and the Explore demo |
| *Seller workspace only* / *Sign in required* on **Re-run with AI** | You are not in the Test Store workspace | Open the reviewer link again |
| One to two minutes of errors (502) right after a deploy (observed, private evidence) | Each service has a disk, so a deploy restarts it with no zero-downtime switch | Reload after two minutes |

## Links

- Demo: [resolvekit-i3j2.onrender.com](https://resolvekit-i3j2.onrender.com) (Explore demo at `/demo`)
- Video: Pending (coming with the submission)
- Code: [github.com/hvaler/resolvekit](https://github.com/hvaler/resolvekit) · [README](../../README.md)
- Evidence: [verification matrix](verification-matrix.md) · [evaluations](../quality/evaluations.md) ·
  [testing](../quality/testing.md) · [limitations](../product/limitations.md)
