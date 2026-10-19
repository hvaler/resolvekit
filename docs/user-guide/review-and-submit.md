[English](review-and-submit.md) | [Español](../es/user-guide/review-and-submit.md)

# Review and submit

Sending evidence to a PayPal dispute cannot be undone. ResolveKit therefore lets you send only content the **server**
composed from its own copy of the documents and analysis, that **you** approved exactly, and that is still the same on
a fresh PayPal read at the moment of sending. Afterwards it reads the dispute back and reports what PayPal recorded.

Status: Implemented · Tested locally · Verified in sandbox (two reviewers' submissions recorded by PayPal,
17/10/2026; an image upload, 18/10/2026) · Deployed. Only **Provide evidence** is sent; see
[Limitations](../product/limitations.md).

Three things are different and the app keeps them apart: **the submission was accepted** (PayPal answered the send),
**the evidence was recorded** (it appears in PayPal's dispute on read-back), and **the dispute's resolution** (PayPal
decides later).

## Before you start

**Review what will be sent →** stays disabled until nothing is open. The bar above it lists what is left, for
example: «sentence 3 needs review», «the address contradiction is open», «PayPal does not allow this action right
now», «only "Provide evidence" can be sent from this screen for now», «PayPal won't accept "<type>" here», «the case
file lacks what "<type>" needs», «the notes exceed PayPal's 2,000-character limit» (despite this wording, the 2,000-character cap is ResolveKit's
own; we found no PayPal documentation of a notes limit), «evidence was already submitted to
PayPal». When it is clear: «All claims are supported or removed. You review everything before it is sent.»

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

After recording, «Actions PayPal allows now» explains what changed, for example «Removed by PayPal: evidence already
submitted» or «Not offered while PayPal reviews». The case becomes **Evidence recorded by PayPal**, «Sent ·
read-only»; the timeline and the audit trail (who approved, when, the content hash, PayPal's answer) show the send.

In our sandbox tests PayPal stopped offering `provide_evidence` after one submission (an observation, not a documented
rule). In the sandbox evaluation a used case moves to its next reserve dispute about 15 minutes later, on its next
read, **only if** one is left (as of 19/10/2026 the standard case has none).

## What is shared, and with whom

| Recipient | What | When |
|---|---|---|
| AI model provider (Gemini, or Groq as fallback) | The case's documents as the server assembles them (synthetic case documents, fields read from the PayPal dispute, for the agent case the MeterMCP receipt), your confirmed uploads' text; edited sentences for re-checks | Each live analysis and re-check |
| PayPal (sandbox) | Evidence type; notes (supported sentences only); carrier and tracking or reference; PDFs built on the server from the case documents (headed «SYNTHETIC TEST DOCUMENT»); for the agent case the receipt PDF; the covered uploads you attached, named `E<n>-upload.png`, `E<n>-upload.pdf`, `E<n>-pasted.pdf` | Only on **Submit evidence to PayPal** |
| The ResolveKit server's audit | Who approved, when, content hash, request id, PayPal's answer; no document text | On approval and send |

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
| `DAILY_CAP` | The demo's evidence sends for today are used up; the message says when it resets |
| «The PayPal connection changed while you were reviewing. Close this and open the case again.» | Close and reopen the case |

More in [Troubleshooting](troubleshooting.md). How it is enforced: [Trust boundaries](../architecture/trust-boundaries.md).
