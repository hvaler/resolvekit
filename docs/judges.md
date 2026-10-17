# Testing instructions (for Devpost)

Ready to paste into Devpost's "Testing instructions" field. Replace the placeholders before submitting:
`<APP_URL>` (the `resolvekit` service), `<REVIEWER_LINK>` (the reviewer invite link the merchant creates under
**Members and invites**), `<METERMCP_URL>` (the `resolvekit-metermcp` service), `<DEMO_CODE>` (MeterMCP's, for MCP
clients), `<SANDBOX_BUYER_EMAIL>` / `<SANDBOX_BUYER_PASSWORD>` (a PayPal sandbox personal account). Never put real
values in this file; it is public.

---

**ResolveKit** is live at **<APP_URL>** (free to use until 15 Dec 2026). Browsing works for everyone, on the
simulator. Each merchant has its own workspace, and only the seller's workspace sees and answers its real PayPal
disputes. To review as a member of the demo merchant's workspace, open your **reviewer link: <REVIEWER_LINK>**, type
your name and choose **Create a passkey and join** (or **Join for this browser only**). It takes a few seconds, and
your name appears in the audit trail of what you approve. Access ends on 15 Dec 2026.

(Merchants sign in with **Continue with PayPal**: they approve a no-charge request in PayPal so ResolveKit knows which
account is theirs. Any other PayPal sandbox account gets its own workspace, with the cases on the simulator.)

PayPal sandbox buyer account (to approve an agent budget): **<SANDBOX_BUYER_EMAIL>** / **<SANDBOX_BUYER_PASSWORD>**.

**What is real and what is synthetic.** The PayPal side is real: once you joined, the two cases marked **PayPal
sandbox · live** in the top bar are bound to real disputes in the PayPal sandbox, read through the Customer Disputes API, and "Submit
evidence" really calls `provide-evidence`. The AI analysis is real (Google Gemini, Groq as fallback). MeterMCP's
budgets are real PayPal Orders v2 authorizations and captures in the sandbox. The merchant's documents (order,
tracking, notes) are synthetic, and so are MeterMCP's tool outputs; other inbox rows run on an in-browser
**Simulated PayPal**, and the app always says which.

**1. Inbox.** Open <APP_URL>. The grid (AG Grid) sorts (shift-click for multi-sort), filters (search box and saved
chips), keeps a pinned "Totals at risk" row, and opens a case with Enter or a double click.

**2. A standard case.** Open **PP-R-TVH-10190665** ("item not received"). The case file shows the timeline, every
document with its source, and the response draft. Every sentence cites its evidence: hover a citation to light up
the exact words in the document. Sentences without support are struck through and will not be sent. The analysis bar
says which model made the analysis and when ("cached" = stored; "live" = just run).

**3. The contradiction.** The order and the shipping label say "Apt 4"; the carrier's delivery record says "Apt 4B". ResolveKit
shows both values side by side, neutrally (no fraud accusation), marks the contradiction **Needs review** and
blocks the approval until you decide: **Explain in response** puts the analyst's neutral sentence (both values,
both sources) in the draft, or **Mark resolved…** records your note in the audit trail. Hover a value to see it in
its document. The verifier may also mark a sentence **Needs review** (it says why): **Rephrase to what the evidence
shows** rewrites it and checks it again, live. The bar above the send button lists what is still open.

**4. Add your own evidence.** In the seller's workspace (open as the reviewer through your link) the case file has
**+ Add evidence**. Upload a screenshot (PNG or JPEG, up to 5 MB) or paste text, for example an email thread. Nothing
you add leaves the ResolveKit server yet: the text is read on the server itself (local OCR for images), not by Google,
Groq or PayPal. **Cover what must not leave** (an account number, a balance, an unrelated line): on an image, drag
rectangles over it; on pasted text, select the passages to remove. The covered areas are burned into the sanitised
file and the text under them is dropped. **Read again**: the page shows the text read from the sanitised file; you
can **correct** a line the OCR misread (the correction is kept and shown with your name) and then **Confirm** (or
**Discard**: an unconfirmed upload is deleted by itself after 24 hours). A confirmed upload becomes the next
evidence number (E7, E8…). The case file says the analysis has not read it yet: press **Re-run with AI** (30–60 s), and the new analysis includes it and can cite it, in the same way as the demo documents:
hover a citation to see the exact words in the uploaded text. A sentence that rests on a line you corrected asks for
your explicit confirmation before it can be sent. When you send, PayPal receives the sanitised file (the PNG, or a
PDF made from pasted text) with the rest of the evidence on the bound case. Uploads belong to the workspace, so
they stay for the next person until the case moves to its next sandbox dispute (they are then archived), and a full
member can delete one at any time (a reviewer can only discard their own before confirming).

*Real vs synthetic.* What you upload is yours, and it is real in what it does: it is read, redacted, cited and sent
to the PayPal sandbox. The case around it (order, tracking, buyer message) is still synthetic, so a screenshot that
contradicts the demo documents will show as a contradiction. Please do not upload personal data you care about: the
PayPal side is a sandbox, and the app is a demo. *Limits:* up to 10 uploads per case, 5 MB and 4096 px (16 MP) per
image, 20,000 characters of pasted text, 5 redactions per upload, 40 uploads per day in total; the AI-read analysis
counts against the live-run limits below.

**5. Approve and send to real PayPal.** Click **Review what will be sent →** (signed in through your reviewer link:
the review is composed by the server for you, and the approval names you). The review shows exactly what the server
will send, composed on the server from its own copy of the documents and the analysis (supported sentences only,
with the intent id and content hash), next to the claim ↔ proof list. **Continue to confirm**, tick the approval box
and **Submit evidence to PayPal**: the server records your approval of that exact content, checks again on a fresh
PayPal read that the dispute is still this case's payment and that nothing changed, and only then sends it. Edit a
sentence afterwards and the approval no longer counts. ResolveKit reads the dispute back from PayPal and only says
**Recorded by PayPal** when PayPal lists new seller evidence that matches what was sent; it shows what PayPal stored
next to what was sent, and the audit log recorded by the server. PayPal accepts evidence once per dispute, so the
case has a reserve of fresh sandbox disputes: about 15 minutes after a judge's evidence is recorded, the case moves
to the next one (the top bar shows its id). If it still shows **Evidence recorded by PayPal**, another judge sent it
minutes ago: you can see the read-back, come back shortly, or walk the whole flow on the simulated cases.

**6. The agent-purchase case.** Open **PP-R-MMC-10190702**: a buyer disputes a payment an AI agent made through
MeterMCP. The mandate, the per-call receipt (one failed call, not charged) and the settlement come from MeterMCP's real
ledger ("From MeterMCP · session …"); the evidence goes to PayPal as digital delivery referenced by the session id,
with the receipt PDF.

**More cases.** Every inbox row opens a full case file on the simulator: two "not as described" claims
(PP-R-BLW-10187733, PP-R-PLN-10189901), an agent purchase disputed as "incorrect amount" (PP-R-KDA-10192258), an
"unauthorised" booking whose evidence is already recorded (PP-R-QZE-10181290: read-back, draft locked) and a closed
case resolved in the seller's favour (PP-R-HFA-10176021: outcome, what was sent, no actions).

**7. Optional: re-run the AI.** As a member of the workspace, **Re-run with AI** runs the analyst live (about 30–60 s) and shows
its stages; editing a sentence sends it to the AI verifier, which re-chooses its citations and judges it again.

**8. Optional: MeterMCP from your own MCP client.** MeterMCP is a metered MCP server at **<METERMCP_URL>/mcp**
(Streamable HTTP). MCP clients cannot sign in with a browser, so MeterMCP takes a code: add the HTTP header
**`x-demo-code: <DEMO_CODE>`** in your client (e.g. MCP Inspector:
Transport "Streamable HTTP", URL above, header under Authentication/Headers). Free tools (`price_list`,
`get_balance`, `get_receipt`, `close_session`) work without it. The first `deep_report` call of each session fails on purpose (a test switch, so the receipt shows an
uncharged failure; the receipt says it was injected). Call `quote_lookup`: it answers `payment_required`
with an `approval_url`; open it, log in with the sandbox buyer account and approve the 5.00 USD budget. Then call
`get_balance` (status `active`), use the paid tools, and `close_session`: MeterMCP captures only the successful calls
and releases the rest, and `get_receipt` shows each call with its request hash. (If PayPal reports the capture
`PENDING`, the session says `capture_pending` and claims no charge until PayPal completes it.) Without the header a paid tool answers
`demo_code_required`. Or from the repo: `METERMCP_URL=<METERMCP_URL>/mcp METERMCP_DEMO_CODE=<DEMO_CODE> npm run demo-agent`.

**Limits.** To keep the shared demo usable: per day, 60 live AI runs, 200 AI re-checks, 20 evidence sends and 20
MeterMCP budgets in total; per hour, 6 live runs and 30 re-checks; per IP, request rate limits. A limit answers with
the time it resets. The services may take a few seconds to answer right after a redeploy.

**Run it yourself** (optional): see the README, sections "Run" and "MeterMCP" (Node 24, a PayPal sandbox app, a
Gemini key).
