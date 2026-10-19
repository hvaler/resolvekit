[English](cases-and-evidence.md) | [Español](../es/user-guide/cases-and-evidence.md)

# Cases and evidence

How to read a case file, what each label means, and how to add your own evidence (screenshots and pasted text; PDFs
have their own page: [PDF review](pdf-review.md)).

## The case file at a glance

| Area | What it shows |
|---|---|
| App bar | **Cases** / case id, the environment, **PayPal sandbox · live** + dispute id (a live read of a sandbox dispute) or **Simulated PayPal**, the sync status («Synced with PayPal · last checked …», «Couldn't reach PayPal. Showing saved data.») |
| Header | Amount and reason, «Buyer declared: <item type>» (the buyer's pick when opening the dispute), **Stage**, **PayPal status** with when it was read, **Respond by**, **Disputed transaction** |
| Analysis bar | The analyst's steps, who made the analysis and whether it is **cached** or **live**, **Replay analysis** (no model call), **Re-run with AI** |
| Timeline | Every event from the documents, in order; contradictions appear as cards on it |
| Evidence | One card per document (E1, E2…), with provenance, hash, and the cited fragments lit when you hover a citation |
| Response draft | «Drafted by the analyst · you approve»: **What to do**, the evidence type, the sentences, **Notes sent to PayPal**, **Attachments to send**, **Review what will be sent →** |

A bound case takes every PayPal field (amount, reason, status, requested evidence, deadline) from PayPal. If the
binding does not match the demo order, the header shows **Demo binding mismatch** and why.

## Provenance: where each document comes from

| Label on the card | Meaning |
|---|---|
| «From PayPal · …» | PayPal's record of the disputed payment, as read from PayPal |
| «PayPal · not read yet» | A bound case whose PayPal read has not arrived; never filled with demo data |
| «From MeterMCP · session …» | The agent case's mandate, receipt and settlement, from MeterMCP's real ledger |
| «From ResolveKit · run …» | The agent run record, shown only when the case's binding names that run (the agent's own account, not proof) |
| «Uploaded by <name>» | Evidence a person of the workspace added |
| «Synthetic demo document» / «Demo data» | Invented case data |

A line you corrected is marked «corrected by <name>»; a line typed by hand on a PDF page is marked «Transcribed
manually by <name>». Hover a value to see it in its document. «used in 2 claims» / «not used in any claim» says how
the draft uses the document.

## The analysis

- The label says who made it, e.g. `<model> · cached` or `· live`; hover it for the prompt version, model calls and
  tokens. «golden analysis committed with the code» means a stored real model output shipped with the app.
- **Re-run with AI** runs the analyst again on the server (it can take about a minute). It is refused with a reason:
  «Sign in required», «Seller workspace only», «Live-run limit reached (6/hour); next in N min», «No model key …».
- Each sentence is **Supported**, **Needs review** (with its reason) or **Removed: no supporting evidence** (struck
  through, never sent). Hover a citation to light up the exact words.
- **Edit** a sentence (up to 600 characters, one line) and **Save and re-check**: the server's model chooses its
  citations again and judges it. If it cannot be re-checked it stays **Needs review**.
- Where offered, **Rephrase to what the evidence shows** applies the analyst's rewrite and re-checks it.
- The checklist marks what PayPal's evidence type needs: **Present**, **Missing**, **Contradicts**, **Resolved**.

## Contradictions

When two documents disagree (for example an address on the label and on the carrier record), the timeline shows a
**Contradiction** card with both values side by side, neutrally, marked **Needs review**. Approval is blocked until
you choose:

- **Explain in response**: the analyst's neutral sentence, stating both values and their sources, goes into the
  draft. The card then says «Explained in sentence N of the response.»
- **Mark resolved…**: write a «Note (saved to the audit log)» and **Resolve with note**.

## What to do (PayPal's actions)

The **What to do** box lists the actions PayPal allows for this dispute now, read seconds ago, each «✓ allowed». Only
**Provide evidence** can be sent from ResolveKit. Choosing any other action (for example «Send message» or «Accept
claim») only shows «only "Provide evidence" can be sent from this screen for now»; nothing is sent to PayPal.
«PayPal is asking for:» shows the evidence PayPal requested.

## Add your own evidence

Available in the sandbox evaluation and in local mode with the server; disabled in the Explore demo. Anyone signed
in to the seller workspace can add evidence.

1. In **Evidence**, choose **+ Add evidence**. The panel says: «It is read on this server only. Nothing of it is used,
   sent to an AI model or to PayPal until you have covered what must not be shared and confirmed it.»
2. Either choose a file («A screenshot (PNG or JPEG, up to 5 MiB) or a PDF (up to 10 MiB and 30 pages)»), or paste text
   under «Or paste text (an email thread, a chat)», give it a name (e.g. «buyer email 9 Oct») and **Add pasted text**.
   A PDF continues in [PDF review](pdf-review.md).
3. The **Review new evidence** window opens on the original. Nothing is used yet.
4. Cover what must not be shared:
   - Image: drag rectangles over it (account numbers, addresses…); **×** removes a cover.
   - Pasted text: under «Select what must not be shared», select passages; they become «[redacted]» in the PDF that is
     stored and sent.
5. Choose **Read again from the covered image** (text: **Remove and read again**), even if nothing needs covering.
   The server blacks out the covers in a new file and reads that file again from scratch, so what was under a cover
   never reaches the analyst or PayPal. Switch between **Your covers** and **Covered file** («what is stored and
   sent»).
6. Check «Text read from the covered file». Correct a line the reading got wrong; it is marked with who corrected it,
   and **Undo** restores what was read.
7. **Confirm as evidence**. The upload becomes the next evidence number (E7, E8…) after the case's documents.
   Or **Discard**.
8. The case file says «Analysis pending: it does not include E7 yet … The draft is not based on it.» Press
   **Re-run with AI**: the new analysis can cite it like any document.

### States you will see

| On screen | Meaning | Who can act |
|---|---|---|
| «New · pending» · «Not used yet: review it first» · **Review** · **Discard** | Uploaded, not yet confirmed | The uploader, the Owner and Members |
| «pending · <name> · uploaded by <person>» | Someone else's pending upload you cannot open | — |
| Evidence card «Uploaded by <name>» with **Delete** | Confirmed evidence | Owner and Members (not Reviewers) |

An upload not confirmed within 24 hours is discarded by itself. Until it is confirmed, its files and text are shown
only to people who can edit it.

## What is shared, and with whom

| Recipient | What it gets | When |
|---|---|---|
| The ResolveKit server | The original file, while it is pending or in review; then only the covered (sanitised) file and its text | On upload |
| The AI model provider (Google Gemini or Groq) | The text of confirmed evidence (read from the covered file, with your corrections and who made them), under its evidence number, a generic title («Uploaded screenshot», «Pasted text», «Uploaded PDF») and «Uploaded by <name>». Never the file name, never the original | On the next analysis that includes it, and on re-checks |
| PayPal (sandbox) | The covered file you attach, named only by its evidence number: `E7-upload.png` (image; `E7-upload.jpg` for a covered photo), `E8-upload.pdf` (PDF), `E9-pasted.pdf` (pasted text) | Only when you send a response that attaches it |

Text is read on the server (local OCR), not by a model provider or PayPal. Do not upload personal data you care
about: the PayPal side is a sandbox and the app is a demo.

## Deleting and what stays

| Action | Effect | What stays |
|---|---|---|
| **Discard** (before confirming) or the 24 h expiry | Files and text removed | A record (name, who, when, status) for the audit |
| **Delete** (confirmed; Owner or Member) | Files and text removed; the analyses that read it are deleted too; unsent responses using it are voided. Refused while a send that uses it is in progress | The record |
| Case moves to its next sandbox dispute | Uploads of the old dispute are archived | The record |
| Already sent to PayPal | Not affected by any ResolveKit deletion | **PayPal keeps the submitted evidence** |
| Sent to a model provider | Not affected by any ResolveKit deletion | Retention is governed by that provider's policy |

## Errors

| Message (excerpt) | What to do |
|---|---|
| «Files up to 5 MiB» / «The image is larger than 4096 px on a side or 8,294,400 pixels» | Use a smaller screenshot |
| «The text has "€" …only Latin-1 characters…» | Replace the character (e.g. € with EUR, curly quotes with straight ones) |
| «Pasted text up to 20000 characters» | Shorten it |
| «A case takes at most 10 uploads; discard or delete one first» | Discard or delete one |
| «An upload can be redacted 5 times; discard it and upload it again» | Discard and start again |
| Sanitised file too large | Upload a screenshot or a smaller image (a covered screenshot is stored as PNG, a covered photo as JPEG) |
| «A reviewer edits only their own uploads» | Ask the uploader, the Owner or a Member |
| «The case moved to another PayPal dispute since this was uploaded…» | Upload it again for the current dispute |
| «The demo has no room for more uploads right now» | Try later |

More in [Troubleshooting](troubleshooting.md).
