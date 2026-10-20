[English](review-and-submit.md) | [Español](../es/user-guide/review-and-submit.md)

# Review and submit

Sending evidence to a PayPal dispute cannot be undone. ResolveKit therefore lets you send only content the **server**
composed from its own copy of the documents and analysis, that **you** approved exactly, and that is still the same on
a fresh PayPal read at the moment of sending. Afterwards it reads the dispute back and reports what PayPal recorded.

Status of evidence: Implemented · Tested locally · Verified in sandbox (two reviewers' submissions recorded by PayPal,
17/10/2026; an image upload, 18/10/2026) · Deployed. The other dispute actions (message, accept, offer, escalate) are
**Verified in sandbox** through the app (20/10/2026); the code is deployed but these actions have not yet been exercised on the hosted service: see [Other dispute actions](#other-dispute-actions) and
[Limitations](../product/limitations.md).

Three things are different and the app keeps them apart: **the submission was accepted** (PayPal answered the send),
**the evidence was recorded** (it appears in PayPal's dispute on read-back), and **the dispute's resolution** (PayPal
decides later).

## Before you start

**Review what will be sent →** stays disabled until nothing is open. The bar above it lists what is left, for
example: «sentence 3 needs review», «the address contradiction is open», «PayPal does not allow this action right
now», «PayPal won't accept "<type>" here», «"Proof of refund" is not available: Not verified with PayPal: pending
sandbox test (W-11)», «the case file lacks what "<type>" needs», «the notes exceed ResolveKit's 2,000-character limit» (a cap of ResolveKit's own; we
found no PayPal documentation of a notes limit), «evidence was already submitted to PayPal». When it is clear: «All claims are supported or removed. You review everything before it is sent.»

- Choose the **Evidence type** («PayPal is asking for: …» shows what PayPal requested; a type PayPal will not accept
  for this reason is refused).
- A sentence resting on a line you corrected or transcribed shows a button such as «Confirm it reads line 2 of E7
  correctly» or «Confirm line 4 of page 8 of E7 is what the file shows (transcribed manually by <name>)». The
  confirmation is part of what you approve.
- You must be signed in to the seller workspace (in the Explore demo the flow runs on the simulator).

## Step 1 · Review

Choose **Review what will be sent →**. «The ResolveKit server is composing exactly what will be sent, from its own copy
of the documents and the analysis…», then the review shows:

- «Composed by the ResolveKit server» (in the demo: «Composed in this browser (simulator only)»).
- **Exactly what goes to PayPal**: the action (Provide evidence · <type>), carrier and tracking or reference,
  «Notes text, as PayPal will receive it», and the files.
- **Claims to be sent**: each supported sentence next to its proof, «Quoted from the source».
- «Not sent · removed by the analyst»: the removed sentences.
- **Attachments**: the case's documents, and your confirmed uploads as checkboxes. «Your uploads go to PayPal as the
  covered files you confirmed; changing this list composes the response again.»
- «Nothing has been sent. Next you confirm.»

If the server refuses to compose, the window says «Nothing can be sent yet» (or «Only the seller's workspace can send
this») with the reasons; **← Back to edit** or **Try again**.

## Step 2 · Confirm

**Continue to confirm →** shows a summary (Action, Notes «N supported sentences · N characters», Files, Not sent), «This
can't be undone», and in the sandbox evaluation: «This sends test documents to a PayPal sandbox dispute. No real money
moves.»

Tick «I'm <your name> (<role>, <workspace>) and I approve submitting this evidence for the <dispute>.» and choose
**Submit evidence to PayPal**.

What happens on the server, in order:
1. Your approval of that exact content is recorded with its content hash («Approved intent … · content sha256 …»).
   If this fails: «The approval was not recorded, so nothing was sent».
2. The server reads the dispute from PayPal again, checks it is still this case's payment and that you are the seller's
   workspace, composes the content again and compares. Any difference refuses the send.
3. The start of the send is written to disk; if it cannot be, nothing is sent (`AUDIT_UNAVAILABLE`).
4. `provide-evidence` is sent once, with one request id.

An approval stops counting if you edit a sentence, compose again, the case's binding changes, or 30 minutes pass.

## Step 3 · Send and read back

Progress: «Approved by <name> · <time> UTC» → «Sending evidence to PayPal» → «Sent. Waiting for PayPal to confirm» →
«Re-reading the dispute from PayPal». «Live PayPal sandbox: we only show "Recorded" after reading the dispute back from
PayPal.»

| Result | What it means |
|---|---|
| **Recorded by PayPal** | PayPal lists new seller evidence that was not there before and matches what was sent (evidence type, notes, carrier and tracking, file names). «Sent versus recorded» shows each field with **Sent**, **Recorded**, **Match**; «Read back from PayPal sandbox (dispute …) at … This is what PayPal stored, not what we expect it stored.» |
| «New seller evidence that doesn't match what we sent» | Someone or something else recorded evidence. It is never reported as yours and nothing is retried automatically |
| **Submission not confirmed** · «PayPal didn't confirm the submission» | PayPal refused, or the read-back shows nothing recorded. **Try again**: «We read the dispute back before any retry. Evidence is only re-sent if PayPal shows none recorded.» A failed send can be retried for 30 minutes with the same approval |
| «The request timed out.» | Not a success and not a failure: ResolveKit reads back first. If PayPal shows nothing: «PayPal showed nothing recorded, so the evidence was sent once more.» (Tested with fakes; not observed against PayPal) |
| «Your evidence was not sent» | The server held it back (`DISPUTE_UNCERTAIN`): an earlier send on this dispute (yours, or a colleague's) is not confirmed by PayPal yet, and none of your evidence reached PayPal. On a retry after an earlier attempt that may have reached PayPal (its answer was lost: a timeout, no answer, a server error), it says «This attempt was held back» instead, and new seller evidence is still compared with what you sent, against the dispute as read before your first attempt. The window shows the same notice as the case page, with **Check again** on that earlier send (a read-back only). Once nothing holds the dispute, **Send it now** reads the dispute again and sends your evidence with every server check: if the earlier send put seller evidence on the dispute, yours is refused (`SELLER_EVIDENCE_EXISTS`), and that evidence is never shown as yours. If the server cannot say what holds the dispute, the window shows the error with **Try again**, which asks again and never sends (Tested locally; not observed against PayPal) |

After recording, «Actions PayPal allows now» explains what changed, for example «Removed by PayPal: evidence already
submitted» or «Not offered while PayPal reviews». The case becomes **Evidence recorded by PayPal**, «Sent ·
read-only»; the timeline and the audit trail (who approved, when, the content hash, PayPal's answer) show the send.

In our sandbox tests PayPal stopped offering `provide_evidence` after one submission (an observation, not a documented
rule). In the sandbox evaluation a used case moves to its next reserve dispute about 15 minutes later, on its next
read, **only if** one is left (as of 19/10/2026 the standard case has none).

## Other dispute actions

Status: **Tested locally** (with fakes built from recorded PayPal responses) · **Verified in sandbox** through the
app (20/10/2026, one send each on a local server; the message with a file excepted). The code is Deployed (`5111b88`, 20/10/2026) but these actions have not yet been exercised on the hosted service; the owner-only ones need the settlement case bound in the hosted `BINDINGS_JSON`, which it is not yet, and reviewers can send messages on a bound case's active dispute. Per-variant status and rules:
[Functional specification](../product/functional-specification.md#56-dispute-actions-other-than-evidence).

Choose the action in **What to do**. Only what PayPal offers on the dispute right now can be composed, and each variant
shows its status («Verified in sandbox», «Tested locally», or «Not available: <reason>»).

| Action | Who | What you write | What PayPal does |
|---|---|---|---|
| Send message | Owner, members, reviewers | **Message to the buyer** (up to 2,000 characters). «The buyer sees exactly this text in PayPal.» Optionally, under **Attach a file (optional, at most one)**, one of the case's confirmed uploads, listed by evidence number and title («Message with a file · Tested locally») | Adds the message, with the file if you chose one, to the thread. It does not merge repeats |
| Accept claim · full refund | Owner | **Note to PayPal** | «PayPal refunds <amount> to the buyer and closes the dispute in the buyer’s favour. This cannot be undone.» |
| Accept claim · partial refund offer | Owner | Amount and **Note to PayPal** | «PayPal offers the buyer a partial refund of <amount>. The buyer has to agree to it: unless they accept, no money moves and the dispute stays open.» |
| Make offer · refund offer | Owner | Amount (below the dispute amount) and **Note to PayPal** | «The buyer is offered <amount>; no money moves unless the buyer accepts.» |
| Escalate | Owner | **Note to PayPal** | «The inquiry becomes a claim decided by PayPal. Inquiry actions end; what you can do next is what PayPal offers on the claim.» |

Members and reviewers see the owner-only actions as a preview with their consequence; they cannot compose or send them.

Steps: **Review the message →** (or **Review the accept →**, **Review the offer →**, **Review the escalation →**) asks
the server to compose exactly what will be sent; the review quotes it. **Approve and send** records your approval of
that content. For an owner-only action, **Confirm before sending** then shows the consequence and amount, bound to that
intent; **Confirm and send** sends it. A message that repeats one PayPal already shows on the dispute asks for the same
confirmation («PayPal already shows this exact message on this dispute…»).

**A message with a file.** Only confirmed uploads of the case are offered (no new upload here: add evidence first), one
at most; «No confirmed upload of this case to attach» when there is none. The review and the confirmation show it as
PayPal receives it, «Attached file: E8-pasted.pdf · 2 KB · E8 <title>, uploaded by <name>». The server attaches it only
if it is still a confirmed upload of the case's active dispute in your workspace (otherwise `UNKNOWN_UPLOAD`).
«Recorded by PayPal» proves the message text; the file itself is not checked. This variant is Tested locally: it has not
been sent to PayPal through the app. Without the ResolveKit server it reads «Not available: attaching a file needs the
ResolveKit server». It is offered only while PayPal waits for the buyer, the status the recorded write was sent from;
while PayPal waits for you it reads «Not available: not verified with PayPal from this dispute status», and the text
message alone is still offered. On the simulator, a state the sandbox write was not recorded from reads «Not
available: the simulator plays this only from a state PayPal’s sandbox recorded it from».

If the buyer wrote after you approved a message, an accept or an offer, the window says «The buyer wrote since you
approved this» and shows the new message: **Send it anyway** sends the same content, **Edit** composes a new one.

| Result | What it means |
|---|---|
| **Recorded by PayPal** (with «claim accepted», «offer waiting for the buyer» or «inquiry escalated») | A fresh read shows the entry this send made |
| **Outcome pending confirmation** | PayPal has not yet shown proof either way. The dispute is held: nothing else can be sent on it until **Check again** (a read-back only, never a send) settles it. If another send holds the dispute (yours from before, or a colleague's), yours was not sent, and **Check again** reads back *that* send; once it is settled, **Send it now** sends yours with every check again |
| Not recorded by PayPal | PayPal shows no trace of the send while still offering the action |
| Not sent | PayPal refused; nothing was done |

**A held dispute after a reload.** The case page asks the server what holds its dispute: if a send is still
unproven, it shows «Outcome pending confirmation» with that send (yours, or «an earlier send by someone in your
workspace») and **Check again** on it. Anyone in the seller's workspace (Owner, members, reviewers) can press it; it
only reads PayPal. Recorded, or proven absent while PayPal still offers the action, frees the dispute. If the notice
says the server no longer has that send's approved content, a read-back cannot settle it: ask the operator (see the
[Runbook](../operations/runbook.md)).

Each action is offered only from the dispute status its recorded sandbox write was sent from: accept, offer and
escalate only while PayPal is waiting for your response (`WAITING_FOR_SELLER_RESPONSE`); a message also while PayPal
is waiting for the buyer; a message with a file only while PayPal is waiting for the buyer
(`WAITING_FOR_BUYER_RESPONSE`). From any other status the action reads «Not available: not verified with PayPal from this
dispute status».

After an escalation the case shows «PayPal is reviewing; the claim stage can take a few minutes» until the claim opens.
Nothing is retried automatically. Proof of refund evidence is not available in this delivery; if PayPal asks only for
it, no evidence can be sent on that dispute.

## What is shared, and with whom

| Recipient | What | When |
|---|---|---|
| AI model provider (Gemini, or Groq as fallback) | The case's documents as the server assembles them (synthetic case documents, fields read from the PayPal dispute, for the agent case the MeterMCP receipt), your confirmed uploads' text; edited sentences for re-checks | Each live analysis and re-check |
| PayPal (sandbox), other actions | The exact message text (and the covered upload you attached to it, named like evidence files), or the type, amount and note of an accept, offer or escalation | Only when the action is sent |
| PayPal (sandbox) | Evidence type; notes (supported sentences only); carrier and tracking or reference; PDFs built on the server from the case documents (headed «SYNTHETIC TEST DOCUMENT»); for the agent case the receipt PDF; the covered uploads you attached, named `E<n>-upload.png` (`.jpg` for a covered photo), `E<n>-upload.pdf`, `E<n>-pasted.pdf` | Only on **Submit evidence to PayPal** |
| The ResolveKit server's audit | Who approved, when, content hash, request id, PayPal's answer; no document text; a message only by its hash | On approval and send |
| The ResolveKit server's intents | The approved message text, like approved evidence notes (the thread itself is not stored and not given to the AI) | While the intent's record is kept |

Your PayPal credentials and the server's never reach the browser.

## What can be undone

Nothing that reached PayPal. **PayPal keeps the submitted evidence**; deleting an upload in ResolveKit afterwards does
not remove it from PayPal. Before sending, you can close the window, edit, or let the approval expire. Model
providers retain what they received according to their own policies.

## Errors while sending

| Code / message | What to do |
|---|---|
| `INTENT_STALE` «What would be sent now differs from what you approved…» | Review again and approve the new content |
| `UPLOAD_CHANGED`, `DOCUMENTS_CHANGED`, `BINDING_CHANGED` | Something changed since you approved: review again |
| `SELLER_EVIDENCE_EXISTS` «PayPal already has seller evidence for this dispute; nothing more can be sent» | Read the recorded evidence |
| `DISPUTE_BUSY` | Another send for this dispute is in progress: wait, then read back |
| `NOT_THE_SELLER` | Only the seller's workspace can respond |
| `DAILY_CAP` | The demo's evidence sends (or message sends, or settling actions) for today are used up; the message says when it resets |
| `OWNER_ONLY` | Only the Owner can accept, offer or escalate |
| `DISPUTE_UNCERTAIN` | An earlier send to this dispute (named in the answer) is not confirmed yet, and yours was not sent: **Check again** reads back that send; when it is settled, **Send it now**. The evidence window shows the same notice inline. After a reload, the case page shows the same hold with **Check again** |
| `VARIANT_NOT_AVAILABLE` «Not available: not verified with PayPal from this dispute status» | The action was never recorded from the dispute's current status: wait for PayPal's status to change, or use another action |
| `NEEDS_REVIEW` | The buyer wrote since your approval: read it, then send the same content or edit |
| «The PayPal connection changed while you were reviewing. Close this and open the case again.» | Close and reopen the case |

More in [Troubleshooting](troubleshooting.md). How it is enforced: [Trust boundaries](../architecture/trust-boundaries.md).
