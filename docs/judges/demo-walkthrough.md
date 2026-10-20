[English](demo-walkthrough.md) | [Español](../es/judges/demo-walkthrough.md)

# Demo walkthrough

Every step with the names the app shows. Control names are in **bold**, on-screen text in *italics*. Case ids such as
`PP-R-TVH-10190665` are fictional case names from the repository; the PayPal sandbox dispute id bound to a case is shown
in the app bar and changes as the reserve rotates. Short version: [review guide](review-guide.md).

Demo: [resolvekit-i3j2.onrender.com](https://resolvekit-i3j2.onrender.com). Video: Pending (coming with the
submission).

| Track | Needs | Time |
|---|---|---|
| [A. Explore demo](#a-explore-demo-no-account) | Nothing | 3 min |
| [B. Sandbox evaluation: answer a real sandbox dispute](#b-sandbox-evaluation-answer-a-real-sandbox-dispute) | The reviewer link from the submission form | 5 min |
| [C. Add and sanitise your own evidence](#c-add-and-sanitise-your-own-evidence) | Track B | 4 min |
| [D. The buying agent](#d-the-buying-agent) | Track B and the sandbox buyer account from the submission form | 4 min |
| [E. The agent-purchase case](#e-the-agent-purchase-case) | Track B | 2 min |
| [F. MeterMCP from your own MCP client](#f-optional-metermcp-from-your-own-mcp-client) | An MCP client and the demo code from the submission form | optional |
| [G. The merchant waiting screen](#g-optional-the-merchant-waiting-screen) | Any PayPal sandbox account other than Test Store's | optional |

## A. Explore demo (no account)

1. Open the demo URL. The landing page reads *Answer PayPal disputes with evidence, not guesses.* Press **Try the
   demo**.
2. The inbox (`/demo`, app bar *Explore demo · fictional cases, nothing is sent*) is an AG Grid: shift-click headers
   for multi-sort, type in the search box, use the **Saved filters** chips (*Needs my approval*, *Agent purchase*,
   *Processing by PayPal*, *Due in … h*), see the pinned *Totals at risk* row. Enter or a double click opens a case.
3. Open **PP-R-TVH-10190665** (*Buyer says the item was not received*). The **Analysis** strip lists the steps and
   *Analysis by gemini-3.8-flash · 9 Oct 2026 · cached*; **Replay analysis** replays them without a model call.
4. **Timeline** (left), **Evidence** (middle) with the checklist *What "not received" disputes need*, **Response
   draft** (right). Hover a citation chip such as `E3 · UPS tracking`: the quoted words light up in the document.
5. The contradiction card (*Contradiction: …*, **Needs review**): the order says "Apt 4", the carrier record "Apt 4B".
   Press **Explain in response** (adds a neutral sentence citing both) or **Mark resolved…** (records a note).
6. In the draft, each sentence is **Supported**, **Needs review** or *Removed: no supporting evidence* (struck, never
   sent). **Edit** a sentence to see it checked again (*Re-checking support…*).
7. Under **What to do**, the actions PayPal allows for this dispute are listed. The deployed commit (`5111b88`)
   includes the other dispute actions, but they have not yet been exercised on the hosted service: choosing **Send
   message**, **Accept claim**, **Make an offer** or **Escalate** opens its own composer, played on the simulator with
   the recorded PayPal transitions only; owner-only actions need the settlement case bound in the hosted
   `BINDINGS_JSON`, which it is not yet, and reviewers can send messages on a bound case's active dispute; variants
   that are not available say why ([review and submit](../user-guide/review-and-submit.md#other-dispute-actions)).
8. The button at the bottom reads **Review what will be sent →** once nothing is open (before that, *Resolve N item to
   continue*). Press it: the dialog shows *Exactly what goes to PayPal* (*Composed in this browser (simulator only)*),
   the claim ↔ proof list (*Number*, *Claim*, *Proof*) and *Not sent · removed by the analyst*.
9. **Continue to confirm →**, tick *I'm … and I approve submitting this evidence…*, **Submit evidence to PayPal**.
   On the demo this goes to the simulator: the steps end with *Recorded by the PayPal simulator* and a *Field / Sent /
   Recorded (simulator) / Match* table.
10. Other demo cases: **PP-R-BLW-10187733** and **PP-R-PLN-10189901** (not as described), **PP-R-KDA-10192258**
    (agent purchase, incorrect amount), **PP-R-QZE-10181290** (evidence already recorded, draft locked),
    **PP-R-HFA-10176021** (resolved in the seller's favour), **PP-R-NKQ-10194410** (*PayPal is processing this new
    dispute*).

Add `?dev` to the URL for the **Dev · simulator** panel (**PayPal re-read outcome**: waiting for buyer, under review,
timeout). It never appears on a case running on real PayPal.

## B. Sandbox evaluation: answer a real sandbox dispute

1. Open **the reviewer link from the submission form**. Type your name and press **Create a passkey and join** or
   **Join for this browser only**.
2. The app bar reads *Sandbox evaluation · Test Store · PayPal sandbox*; the inbox shows only the cases bound to sandbox
   disputes. Any other case id opens in the Explore demo.
3. Open **PP-R-TVH-10190665**. The app bar shows **PayPal sandbox · live** with the bound dispute id ("live" = a live
   read of a sandbox dispute). The header's amount, stage, status, due date and disputed transaction come from that
   read; the documents are the synthetic case documents.
4. Check the case is still open for evidence: if the button reads **Evidence recorded by PayPal**, this dispute was
   already answered. See [what to do](review-guide.md#if-a-dispute-was-used-the-reserve-is-empty-or-a-cap-is-reached).
5. Do steps 4–8 of track A. **Rephrase to what the evidence shows** on a **Needs review** sentence applies the
   verifier's rewrite and checks it live. **Re-run with AI** runs the whole analysis live (30–60 s).
6. **Review what will be sent →**: now *Composed by the ResolveKit server · intent … · content sha256 …*. The server
   built it from its own copy of the documents and its own analysis; your browser sent only your choices.
7. **Continue to confirm →**. The step says *This sends test documents to a PayPal sandbox dispute. No real money
   moves.* Tick the approval (it names you, your role and *Test Store*), then **Submit evidence to PayPal**.
8. Progress: *Approved by …*, *Sending evidence to PayPal*, *Sent. Waiting for PayPal to confirm*, *Re-reading the
   dispute from PayPal*, then **Recorded by PayPal** with the *Field / Sent / Recorded by PayPal / Match* table. If
   PayPal shows something that does not match, the page says so (*New seller evidence that doesn't match what we
   sent*); if nothing new is recorded, it says *no new evidence from you is recorded*.
9. **Audit log** lists the approval (with your name and the content hash) and the send (PayPal-Request-Id and PayPal's
   answer). Editing a sentence after approving voids the approval.

## C. Add and sanitise your own evidence

1. In a Test Store case press **+ Add evidence**. The panel says *It is read on this server only…*.
2. Pick a file in *A screenshot (PNG or JPEG, up to 5 MiB) or a PDF (up to 10 MiB and 30 pages)*, or paste into **Or
   paste text (an email thread, a chat)**, give it a name and press **Add pasted text**.
3. **Image**: *Drag over what must not be shared*, then **Read again from the covered image**. The text panel switches
   to *Text read from the covered file*. Correct a line if the reading got it wrong.
4. **Pasted text**: under *Select what must not be shared*, select passages; **Remove and read again**. Removed
   passages become “[redacted]”.
5. **PDF**: up to 5 pages are taken whole; for a longer one tick up to 5 thumbnails and press **Add N pages**. For each
   page: drag covers, **Cover this page and read it again** (also when nothing needs covering), fix lines, add *Lines
   you transcribe* for text the reading missed (mark the area outside any cover). **Show it for this page** shows the
   PDF's own text as a hint, never stored. The page warns: *Covering the text next to a barcode or QR code doesn't
   hide what the code contains. Cover the code too if it carries data you don't want to share.*
6. **Confirm as evidence** (or **Discard**). The upload becomes the next evidence number (E7…). Press **Re-run with AI**
   to let the analysis read it.
7. If a supported sentence rests on a line you corrected or transcribed, it waits for **Confirm it reads … correctly**
   or **Confirm … is what the file shows (transcribed manually by …)**.
8. In the review, *Attachments to send* lists your confirmed uploads. PayPal receives `E7-upload.png`
   (`E7-upload.jpg` for a covered photo), `E7-upload.pdf` or `E7-pasted.pdf`, never your file name.

## D. The buying agent

1. From the inbox press **Try the buying agent** (or open `/agent`). Heading: **Buying agent**.
2. In **New run**: **Goal** (pick one of the *Examples*, e.g. *Get the current quote for ACME-42 and a short report on
   its supplier risk, spending as little as possible.*), **Budget cap (USD, 0.50 to 5.00)** (default 2.00), and
   optionally *Simulate an outage: the first call to Deep report fails (marked as injected)*. Press **Start the run**.
3. The run shows *Running*, then *Waiting for approval in PayPal* with *The agent wants to spend up to … USD.* Press
   **Approve in PayPal**, sign in with the sandbox buyer account from the submission form and approve. You return to
   `/agent?run=…`.
4. **Steps**: each tool call with price and *OK, charged* or *FAILED, not charged*, the result summary and the model's
   short stated reason (not its internal reasoning). An injected failure is marked injected.
5. **Answer** and the outcome pill: *Done*, *The tools cannot meet this goal*, *Out of budget*, *Stopped: …*,
   *Interrupted (stopped or server restart)*, *Model unavailable*, *Not approved in PayPal*.
6. **Budget and receipt**: *Captured … USD · … released* (or *Voided: nothing charged*, *Capture pending at PayPal (not
   final)*, *Not verified yet*), always from MeterMCP's receipt. Below it, the model usage line, apart from the budget.
7. **Your runs**: tick two and press **Compare** (*Two runs side by side*). **Stop** ends a running run. **Keep**
   (owner only) exempts a run from the 30-day deletion.

## E. The agent-purchase case

1. Open **PP-R-MMC-10190702** in Test Store: a buyer disputes a payment an agent made through MeterMCP.
2. The mandate, the per-call receipt (AG Grid) and the settlement are labelled *From MeterMCP · session …*. As of
   19/10/2026 the bound session is one made by the earlier scripted client, not by a model-driven run; a run record
   (*E5 Agent run record*, *From ResolveKit · run …*) appears only when the case's binding names that run (Pending).
3. *How this goes to PayPal as digital delivery*: `PROOF_OF_FULFILLMENT`, carrier `OTHER`, the session id as reference,
   the receipt PDF attached. Sending it follows track B (agent-case send to PayPal: Pending, no recorded evidence).
4. In the Explore demo the same case id opens the synthetic example (four calls, one failure not charged, 1.37 of
   5.00 USD), labelled *Demo data*.

## F. Optional: MeterMCP from your own MCP client

1. Connect a Streamable HTTP MCP client (for example MCP Inspector) to MeterMCP's `/mcp` endpoint
   (`https://resolvekit-metermcp.onrender.com/mcp`) with the HTTP header `x-demo-code` set to the demo code from the
   submission form.
2. `price_list` and `get_balance` work without the code. Call `quote_lookup`: it answers `payment_required` with an
   `approval_url`. Approve with the sandbox buyer account.
3. `get_balance` (status `active`), then the paid tools, then `close_session`: only successful calls are captured.
   `get_receipt` lists each call with its request hash. Without the header a paid tool answers `demo_code_required`.

Status: Implemented · Tested locally · Deployed; a run from an external client against the hosted endpoint has no
recorded evidence (Pending). Reference: [MCP tools](../technical/mcp-tools.md).

## G. Optional: the merchant waiting screen

**Sign in** → **Continue with PayPal** with any PayPal sandbox account other than Test Store's. You approve a
no-charge request (*No money moves and no agreement is created.*) and land on *You're signed in with PayPal. Access to
your disputes isn't available yet.* with **Explore demo**. This is the real status: merchant connection is Pending.
