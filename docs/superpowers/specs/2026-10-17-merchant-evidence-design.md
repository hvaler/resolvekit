# Merchant evidence: upload, redact, confirm, cite — design

Date: 2026-10-17 · Status: approved by the user (with the independent review's changes) · Block B, part 1 of the PayPal AI Hackathon work
(`C:\nexus\dev\PayPalAI\docs\08-EVALUACION-JURADO-2026-10-17.md`).

## Why

Today every document in a ResolveKit case is synthetic (`packages/cases` fixtures; `apps/server/src/documents.ts`
builds their PDFs). A judge or a real merchant cannot use their own records, which caps "Potential Impact" and makes
the product read as a demo. A small merchant with an "item not received" dispute has: screenshots of the carrier's
tracking page, the shipping label PDF, bank statement extracts, other PDFs, and the email thread with the buyer
(which they copy and paste). This feature lets them add those to a case, protect what must not leave, and have the
analyst cite them with their exact words, as it cites the demo documents today.

## Goals (in priority order)

1. **The analyst cites the merchant's new evidence** with exact words, under the same rules as today: every sentence
   cites verbatim text, unsupported sentences are removed, contradictions go to review (`packages/analyst`
   `verify.ts`, `capContested`, `settleVerdict`). This is the part that must be flawless (video and judges).
2. **Redaction before anything leaves the server.** The merchant covers what must not be shared (account numbers,
   balances, unrelated movements). Nothing of an upload reaches the AI model (Google Gemini / Groq) or PayPal before
   the merchant has redacted and confirmed it.
3. **The merchant reviews the extracted text** before it is used: confirm it, discard the upload, or correct it.
4. **PayPal receives the original file with the covered areas burned in black** (not an overlay that can be
   removed), as an attachment of the evidence submission.

## Non-goals

- Starting a case from the merchant's evidence alone. Uploads **add to** the case's demo documents.
- Merchants other than the demo seller seeing their own real disputes (Block B part 2, separate design).
- `.eml` / mailbox import, Word/Excel files, video, audio.
- AI-assisted redaction suggestions (could come later; not now).
- Keeping unredacted originals anywhere.

## Anti-goals (would make it a failure even if it works)

- Any byte of an unredacted upload sent to Google, Groq or PayPal.
- A citation that presents merchant-typed text as if it were the file's own words.
- A redaction that can be undone by the recipient (a black rectangle drawn over a PDF text layer that still
  contains the text, an image with the original in metadata or in another layer).
- One reviewer's upload silently changing or disappearing because another reviewer acted on it.
- A demo that a stranger can use to store arbitrary files or run up OCR/AI cost.

## Decided (by the user, in conversation)

- **Kinds of evidence:** images (screenshots: JPG, PNG), PDFs (text PDFs and scanned PDFs), and pasted text (email
  threads). Bank extracts arrive as PDF or image.
- **Extraction on our own server**: PDF text layer where there is one, OCR for images and scanned pages. No external
  service sees an upload before redaction and confirmation.
- **Redaction is done by the merchant before the AI sees the file**, by covering rectangles on the image or page. For
  pasted text, by selecting the passages to remove.
- **Review of the extracted text**: the merchant can confirm, discard, or **correct** it. A correction is allowed and
  **every citation of corrected text says so** ("corrected by the merchant", with who).
- **PayPal receives the original file with the covered areas blacked out.**
- **Uploads add to the demo documents**, numbered after them (E7, E8…), in simulated and bound cases alike. Only a
  bound case sends them to PayPal for real.
- **Uploads belong to the workspace** (every member of the workspace sees them). Permissions:

  | | See all | Upload | Redact, correct, confirm | Delete |
  |---|---|---|---|---|
  | Owner | yes | yes | any | any |
  | Member | yes | yes | any | any |
  | Reviewer | yes | yes | **own uploads only** | no |

## Decided after the builder check (user)

- **Shared, but tied to the active real dispute.** A case's confirmed uploads belong to the workspace **and to the
  bound dispute that was active when they were uploaded** (on simulated cases: to the case). Every member of the
  workspace sees them and they enter everyone's analysis of that case. When the case rotates to the next dispute of its
  reserve (`rotateIfUsed` in `apps/server/src/app.ts`), its uploads are **archived**: no longer in the input, still in
  the audit trail. The next judge starts clean. A clash between two people within the same window (B's approved intent
  refused with `DOCUMENTS_CHANGED` because A confirmed an upload) is accepted; the app must say why in plain words
  ("someone in your workspace added evidence E7 since you approved; review again").
- **A sentence citing merchant-corrected text can be supported and sent.** A correction fixes the reading of the
  file, whose pixels PayPal receives. The analyst is told which lines were corrected; the web citation says "corrected
  by <person>"; nothing extra is marked in what PayPal receives.

## Builder-check questions settled by the assistant (check while reading)

- **Uploads are for the seller's workspace only** in this part (where live analysis, re-checks and real sends
  already are). Other workspaces see no "+ Add evidence" (or see why). Block B part 2 extends uploads with their own
  disputes and caps.
- **PayPal receives every confirmed upload of the case**, as the demo PDFs today (`c.attachments`), not only the
  cited ones: the merchant confirmed it as evidence. The intent's content hash covers every attached file's SHA-256.
- **Pasted text is sent as a PDF generated by ResolveKit** (`packages/pdf`), with the removed passages replaced by a
  visible mark (e.g. "█ redacted") and a header naming it as pasted by <person>; there is no original file to keep.
- **Deleting an upload also purges** the stored analyses, pins and progress records whose input contained it (they
  quote its text); the audit trail keeps the event, not the text. A reviewer's uploads stay when their access ends
  (they are the workspace's).

## After the independent review (17/10) — supersedes the text above where they differ

Review: `Recomendacion_Merchant_Evidence_2026-10-17.md` (user's). Accepted by the user:

- **Corrections need an explicit confirmation of what depends on them.** A sentence whose support rests on a
  merchant-corrected line may be sent, but only after the person confirms it specifically ("depends on your
  correction of line N of E7: confirm"), one click; that confirmation is part of the approval. (Replaces "can be
  supported and sent" above.) During review the reference extraction and the corrected text are both kept, with the
  diff and its author; the reference never keeps text the person covered.
- **Provenance visible all the way.** Demo documents stay in the case with uploads (this part is the seller's demo),
  but every citation, the draft and the final review before sending show what each document is: "synthetic demo
  document" or "uploaded by <person>" (and "corrected by <person>" where it applies). Separating real cases from
  fixtures entirely is Block B part 2.
- **Phased, nothing cut.** Phase 1: images (PNG, JPG) and pasted text, the whole path implemented, tested and sent to
  the sandbox. Phase 2, right after, in the same block: PDFs (text and scanned, multi-page), with their own
  sanitisation guarantees.

Accepted by the assistant (no user decision changed):

- **One sanitised version is the source of truth.** Rectangles are applied to the image/pages and the sanitised file
  is generated first; the text the AI reads is **extracted again from that sanitised file** (then corrected), never
  derived by removing OCR words under boxes. A number the OCR never recognised is still covered in the pixels. PDFs
  are rebuilt from rasterised pages: no text layer, metadata, annotations or embedded files of the original survive.
  The files sent are exactly the approved ones, checked by SHA-256.
- **`boundDisputeId` in the data model**, plus an archived state. The binding is checked at confirmation, when
  composing the intent and at send: an upload pending before a rotation can never be confirmed as evidence of the new
  dispute; archived uploads never enter an analysis or a send.
- **Explicit attachment selection in the final review** (replaces "PayPal receives every confirmed upload"): proposed
  from the cited uploads, changeable by the person, within PayPal's file limits; the selection and its hashes are
  covered by the approval.
- **Pending originals are a bounded exception**: a maximum pending time; originals, page images, thumbnails, OCR text
  and temporary files are removed on discard, failure, expiry and after a restart (a sweep at start); nothing of an
  upload's content in logs.
- **Deletion wins over reuse**: deleting an upload purges stored analyses, pins and progress answers that contain its
  text; an approved-but-unsent intent using it is invalidated; while a send that uses it is in flight, deletion is
  refused until the outcome is known; after a send, the audit keeps the event (PayPal keeps its copy), not the text.
- **Operational limits** include pages, pixel dimensions, processing time per page, concurrent jobs and total
  storage, set after measuring on Render and checking PayPal's attachment rules in the sandbox.
- **Confirmed but not analysed**: if no live-analysis quota is left, the upload stays confirmed and the case says the
  analysis including it is pending; the previous analysis is never shown as if it included the new evidence.
- **Acceptance tests** of the review's section 5 are part of the plan, and the evals gain upload-based cases
  (imperfect OCR, corrections, redaction, contradictions), measuring verbatim match and semantic support separately.

## Assumptions stated by the assistant and accepted by the user

- Once confirmed, a redaction is permanent: the server keeps only the redacted file and discards the original.
- A Reviewer cannot delete, not even their own upload; before confirming they can **discard** it (which removes it).
  After confirmation only Owner/Member can remove it.
- Deleting an upload removes it from the case; the next analysis no longer cites it. If it was already sent to PayPal,
  PayPal keeps it and the case's audit trail shows it was sent.
- The audit trail records who uploaded, redacted, corrected, confirmed, discarded and deleted each upload.
- Demo abuse limits: file size and count per case and per day, accepted types PDF/JPG/PNG/pasted text only.
- The video shows: upload a screenshot, cover the account number, confirm, and the analyst citing that evidence with
  its exact words.

## The flow (what the person sees)

1. On a case, **+ Add evidence** (exists in `apps/web/src/pages/CasePage.tsx`, inert today) opens: drop or choose a
   file (PDF, JPG, PNG), or paste text. The upload appears in the evidence list as a new document **E7 · pending**,
   marked "Not used yet: review it first".
2. The server extracts the text locally. The review screen shows the file (image, or each PDF page as an image) with
   the extracted text beside it.
3. The person **covers areas** (drag rectangles) on the image/pages. Every word whose box falls under a rectangle is
   removed from the extracted text too, so one gesture redacts both. For pasted text they select passages to remove.
4. They read the remaining text and **correct** OCR mistakes where needed (each corrected line is marked).
5. **Confirm**: the server burns the rectangles into the stored file, discards the original, freezes the text, and
   the document becomes **E7 · confirmed** with its source, type, a SHA-256 of the stored (redacted) file, and who
   confirmed it. **Discard** removes the upload instead.
6. The case's analysis input now includes E7; the analysis is run again (the existing "Re-run with AI" path, behind
   the same seller-workspace gate and daily caps), and the draft cites E7 like any other document: hovering a citation
   highlights the exact words in E7's text; a citation of a corrected line carries "corrected by <person>".
7. When the response is sent (bound case), confirmed uploads used by the draft go to PayPal as attachments, the
   redacted files as stored, next to the demo PDFs.

## Constraints from the existing system (must hold)

- **Server composes everything** that is sent (`apps/server/src/app.ts` `compose`, `composeSubmission` in
  `apps/web/src/domain/intent.ts`, shared by client and server). The browser never supplies notes, files or tracking
  for a send. Confirmed uploads must enter the composition the same way: from server storage, by id, never as bytes in
  the send request.
- **Approval binds exact content**: the intent's content hash must cover the confirmed uploads it attaches (file
  hashes), so a change after approval invalidates it, as edits do today.
- **Documents are content, never instructions**: uploads go through the same injection scan
  (`packages/analyst/src/injection.ts`) and the same verbatim check (`isVerbatim`) as demo documents. Pasted email
  text is the most likely carrier of injected instructions.
- **Analysis cache keys** cover the input (`analysisKey`, `documentsSignature`): adding/removing/confirming an upload
  changes the input, hence the key; stored analyses of the old input stay valid for it.
- **Hosted protections**: Origin check, per-IP limits, signed-in person, seller-workspace gate, daily caps that fail
  closed (`DailyCounters.reserve`, `packages/hosting`). Request bodies are capped at 256 KB today
  (`apps/server/src/node.ts` `MAX_BODY`): uploads need their own route and limit.
- **Workspace isolation**: a workspace's uploads are never visible to another workspace (the outsider test pattern in
  `apps/server/test/webhook.test.ts`).
- **Simulated cases** run on the in-browser simulator for PayPal, but uploads are server-side in every case (they need
  server extraction and storage). Signed-out visitors cannot upload (no workspace, no person to attribute to).
- **PayPal's evidence file rules** (types, per-file size, total size, number of files) apply; verify them in the
  sandbox before relying on them (the project keeps such checks as gates in `C:\nexus\dev\PayPalAI\evidencia`).
- **Render free tier**: limited CPU and RAM, one instance, a persistent disk at `RESOLVEKIT_DATA_DIR`. OCR must run
  within that, with a time limit per page, and storage must be bounded.
- **Node 24, TypeScript, no build step on the server** (`node apps/server/src/main.ts`). Dependencies must work there.

## Data model (decided at this level; details left to the builder)

An **upload** belongs to `{ workspaceId, caseId }` and has: id, evidence id (E7…, assigned at confirmation or at
upload — builder's call, but stable once shown), kind (pdf | image | text), original file name, uploader person,
status (pending | confirmed | discarded | deleted), the stored file (pending: original; confirmed: redacted only),
per-page images for review, extracted words with boxes (for images/scans), the redaction rectangles, the final text
as lines, which lines were corrected and by whom, SHA-256 of the stored file, timestamps. Stored under the data dir,
outside any web-served path, with bounded total size.

In the analysis input each confirmed upload is an `AnalysisDocument` (`packages/analyst/src/types.ts`): `id` E7…,
`title` from the file name, `type` ("Merchant upload · PDF", "… · image", "… · pasted text"), `source` ("Uploaded by
<person>"), `tag` (a new tag, e.g. `UPL`), `lines` = final text lines. Corrected lines must be distinguishable in the
web citation view.

## Left to the builder

- OCR engine and PDF rendering/text libraries (candidates: tesseract.js, pdfjs-dist; must run on Node 24 on Render
  without native build tools, or be justified), and how to rasterise PDF pages for review and for burning in.
- How redaction is burned into a PDF so the text under it is really gone (e.g. rasterise redacted pages; keep text
  pages that have no rectangles as they are).
- Upload transport (multipart route with its own size limit, streaming to disk).
- Exact limits (sizes, counts, per-day caps), sized to Render and to PayPal's rules.
- Where in the case page the review happens (a full-page step like the approve flow, or a panel).
- How the analysis is re-run after a confirmation (automatically, or with a prompt to the person), within the existing
  caps.
- Whether an upload used by an approved-but-unsent intent can be deleted (it must at least invalidate the intent).
- How the simulated cases' simulator represents uploaded attachments in its read-back.

## Verification (what "done" means)

- Tests first for every rule above: permissions per role, workspace isolation, nothing external before confirmation,
  redaction burned in (the stored file contains no text/pixels from covered areas), corrected-line marking reaching the
  citation, intent hash covering upload hashes, caps failing closed.
- A sandbox gate: one bound-case send with a redacted upload, read back from PayPal (file listed), evidence saved in
  `C:\nexus\dev\PayPalAI\evidencia`.
- A run of the analyst evals (`docs/evals.md`) with at least one upload-based case, so goal 1 is measured, not assumed.
- `npm run demo:check` still READY after deploy.
