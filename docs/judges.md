# Testing instructions (for Devpost)

Ready to paste into Devpost's "Testing instructions" field. Replace the placeholders before submitting:
`<APP_URL>` (the `resolvekit` service), `<METERMCP_URL>` (the `resolvekit-metermcp` service), `<DEMO_CODE>`,
`<SANDBOX_BUYER_EMAIL>` / `<SANDBOX_BUYER_PASSWORD>` (a PayPal sandbox personal account). Never put real values in
this file; it is public.

---

**ResolveKit** is live at **<APP_URL>** (free to use until 15 Dec 2026; no sign-up). Browsing works for everyone.
Actions that send data to real PayPal or call the AI live need this **demo code: `<DEMO_CODE>`** (click **Unlock demo
actions** in the top bar). It unlocks your browser for 12 hours.

PayPal sandbox buyer account (to approve an agent budget): **<SANDBOX_BUYER_EMAIL>** / **<SANDBOX_BUYER_PASSWORD>**.

**What is real and what is synthetic.** The PayPal side is real: the two cases marked **PayPal sandbox · live** in
the top bar are bound to real disputes in the PayPal sandbox, read through the Customer Disputes API, and "Submit
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
shows both values side by side, neutrally (no fraud accusation), and the affected sentences need your review.

**4. Approve and send to real PayPal.** Click **Review what will be sent →**, check the claim ↔ proof list, then
**Continue to confirm**. Unlock with the demo code if you have not yet, tick the approval box and **Submit evidence
to PayPal**. ResolveKit reads the dispute back from PayPal and only says **Recorded by PayPal** when PayPal lists the
new seller evidence; it shows what PayPal stored next to what was sent. PayPal accepts evidence once per dispute: if
the case already shows **Evidence recorded by PayPal**, another judge sent it first; you can still see the read-back,
and the simulated cases let you walk the whole flow.

**5. The agent-purchase case.** Open **PP-R-MMC-10190702**: a buyer disputes a payment an AI agent made through
MeterMCP. The mandate, the per-call receipt (one failed call, not charged) and the settlement come from MeterMCP's real
ledger ("From MeterMCP · session …"); the evidence goes to PayPal as digital delivery referenced by the session id,
with the receipt PDF.

**More cases.** Every inbox row opens a full case file on the simulator: two "not as described" claims
(PP-R-BLW-10187733, PP-R-PLN-10189901), an agent purchase disputed as "incorrect amount" (PP-R-KDA-10192258), an
"unauthorised" booking whose evidence is already recorded (PP-R-QZE-10181290: read-back, draft locked) and a closed
case resolved in the seller's favour (PP-R-HFA-10176021: outcome, what was sent, no actions).

**6. Optional: re-run the AI.** With the demo code, **Re-run with AI** runs the analyst live (about 30–60 s) and shows
its stages; editing a sentence sends it to the AI verifier, which re-chooses its citations and judges it again.

**7. Optional: MeterMCP from your own MCP client.** MeterMCP is a metered MCP server at **<METERMCP_URL>/mcp**
(Streamable HTTP). Add the HTTP header **`x-demo-code: <DEMO_CODE>`** in your client (e.g. MCP Inspector:
Transport "Streamable HTTP", URL above, header under Authentication/Headers). Free tools (`price_list`,
`get_balance`, `get_receipt`, `close_session`) work without it. The first `deep_report` call of each session fails on purpose (a test switch, so the receipt shows an
uncharged failure; the receipt says it was injected). Call `quote_lookup`: it answers `payment_required`
with an `approval_url`; open it, log in with the sandbox buyer account and approve the 5.00 USD budget. Then call
`get_balance` (status `active`), use the paid tools, and `close_session`: MeterMCP captures only the successful calls
and releases the rest, and `get_receipt` shows each call with its request hash. Without the header a paid tool answers
`demo_code_required`. Or from the repo: `METERMCP_URL=<METERMCP_URL>/mcp METERMCP_DEMO_CODE=<DEMO_CODE> npm run demo-agent`.

**Limits.** To keep the shared demo usable: per day, 60 live AI runs, 200 AI re-checks, 20 evidence sends and 20
MeterMCP budgets in total; per hour, 6 live runs and 30 re-checks; per IP, request rate limits. A limit answers with
the time it resets. The services may take a few seconds to answer right after a redeploy.

**Run it yourself** (optional): see the README, sections "Run" and "MeterMCP" (Node 24, a PayPal sandbox app, a
Gemini key).
