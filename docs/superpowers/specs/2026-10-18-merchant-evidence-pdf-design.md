# Merchant evidence, phase 2: PDFs (design)

Status: draft for the owner's approval, 18/10/2026. It builds on phase 1 (`2026-10-17-merchant-evidence-design.md`, on `main`): images and pasted text that are uploaded, covered, OCR-read, corrected, confirmed, cited by the analyst and sent to PayPal as covered files. Everything phase 1 decided still holds unless this document says otherwise.

## Intent

Merchants and judges want to add **short PDFs** from their own operation: a shipping label, an invoice, a bank-statement extract. These are the documents that actually settle a dispute. Today they must screenshot each page.

A PDF hides more than an image. It can carry a text layer under what you see, annotations, attachments, metadata and earlier revisions. So covering an area must remove the information **everywhere**, not just paint over it.

## Decided by the owner

- **Expected size**: 1–5 pages; text PDFs, scanned PDFs or a mix. This is a design assumption, to be validated with users.

  | Document | Usual content | What may need covering |
  |---|---|---|
  | Shipping label (1 page) | Sender, recipient, address, tracking, barcodes | Phone, email, internal references that do not help the dispute |
  | Invoice (1–3 pages) | Seller, buyer, items, dates, amounts, payment references | Tax or bank data that is not needed; data of other orders |
  | Bank-statement extract (1–5 pages) | Holder, account, movements, balances | The full account number, balances, movements unrelated to the disputed payment |

- **Every page can be reviewed**, even when text extraction recognises little or nothing on it.
- **Nothing is covered automatically.** The amount, date, payment reference, tracking or delivery address may be exactly what proves the case. When the dispute is about two different addresses, what is needed to compare them stays visible. **The merchant decides** what to cover, looking at the page and its extracted text.
- **On confirmation, covered content is gone from the pixels, from the text and from anything hidden in the file.**
- **One sanitised version** serves both the AI and the PayPal attachment (if it is selected at approval). The merchant knows exactly what they share. If a cover removes something needed to prove a claim, ResolveKit says evidence is missing. The merchant can then discard the document or prepare a new version.
- **Barcodes and QR codes**: a visible warning says that covering the text next to a code does not hide what the code encodes, so the code itself must be covered if it carries sensitive data.
- **The PDF sent to PayPal is rebuilt from the sanitised page images only.** There is one image per page and no selectable text. It is built **exclusively** from those images: no original content, attachments, annotations or inherited metadata. This is accepted for the first version, as the price of making sure covered content cannot survive. It is **not** described to anyone as an absolute guarantee.
- **The AI reads what is actually visible.** The final text of each page comes from **OCR of the sanitised page image**.
  - The PDF's own text layer may help during review, for example shown next to the page or used to suggest corrections.
  - It never becomes the final text by filtering it with the cover coordinates.
- **OCR corrections** keep their attribution and show in citations, as in phase 1.
- **Before confirming**, the merchant reviews every sanitised page and the exact text the AI will use.
- **Legibility and limits**: the resolution must keep the needed details readable (checked in tests with small print such as an account number or a tracking number). The final file must respect PayPal's limits: under 10 MB per file and 50 MB per response.
- **Manual transcription of text the OCR missed.** Besides correcting detected lines, the merchant can add a line.
  - To add one, they select the page and mark the area where the text appears on the sanitised page image.
  - The line is labelled «Transcribed manually by <person>». It keeps its page, its area and its author.
  - Citations keep that label. Claims that rest on a transcribed line need **explicit review before sending**, as corrections do in phase 1, with a confirmation bound to the sentence and the line.
  - **Transcribing from a covered area is not allowed**: an added line's area may not overlap any cover.
  - An explanation that does not appear in the document goes in a **merchant note**, separate from the transcription and never presented as documentary evidence. This is the draft's existing notes mechanism, «From your notes».
- **More than five pages**: a selection step comes first: «This document has 12 pages. Choose up to 5 to add as evidence.»
  - Only the selected pages go to review, covering and OCR. The others are never analysed or sent.
  - The original numbering is kept: «Page 8 of the original document», even when it is the second page of the attachment.
  - Before confirming, the screen lists the pages included and warns that the selection must keep the needed context, without leaving out relevant or contradicting information.
- **Input limits are independent of the selection.** There is a maximum size and a maximum page count for the uploaded PDF. Above them the upload is refused, and the merchant is asked to prepare a smaller extract.
- The **original and the temporary files are discarded** under phase 1's policy (expiry, discard, delete, archive on rotation).
- **Closing criterion**: the file shown, the text analysed and the attachment approved are **the same sanitised version**. Tests try to recover information from the covered areas: text, image data, metadata, and the content streams of the rebuilt PDF.

## Goals

1. Upload a PDF to a case: same entry point as images (`+ Add evidence`), same permissions, same caps and the same per-case limit.
2. A page selection step when the PDF has more than five pages.
3. Per-page review:
   - the page image, with the same rectangle covering tool as for images;
   - the OCR text of the covered page, with the same correction flow;
   - the original page number;
   - the barcode/QR warning.
4. A sanitised PDF, rebuilt from the covered page images. It becomes the stored document, is analysed through its OCR text, and is attached to PayPal when selected.
5. Processing that fits the hosted instance (512 MB, 0.5 CPU) with progress per page. A 5-page OCR can take more than a minute, so it cannot be a single blocking request.
6. The analyst cites PDF pages like any upload, by line fragments of page N. Citations show the original page number and any correction.
7. Tests covering:
   - recovery attempts on covered areas;
   - PDF hostile input;
   - limits and the selection step;
   - the "same version" invariant;
   - legibility of small print at the chosen resolution.

## Non-goals (first version)

- Keeping selectable text in the PDF sent to PayPal, or true in-place PDF redaction.
- Automatic detection or covering of sensitive data, barcodes or QR codes. The warning is static.
- Long documents beyond the input limits, office formats (DOCX and others), password-protected or encrypted PDFs (refused, with a reason).
- Digital signatures. The rebuilt file has none, and the original's signature does not carry over.

## Anti-goals

- Any content under a cover surviving in the stored file, in the text sent to the AI, in logs, in audit details, or in the PDF sent to PayPal.
- The original PDF, or any part of it (fonts, images, metadata, attachments, annotations, JavaScript), reaching the AI or PayPal.
- Text the merchant never saw reaching the AI. The AI gets exactly the reviewed OCR text of the sanitised pages.
- Pages left out at selection being analysed, stored past their temporary life, or sent.
- A PDF crashing or exhausting the hosted instance (memory, CPU time, disk).

## Decisions taken by Claude (my calls, to check while reading)

1. **Rendering in Node**: `pdfjs-dist` (Apache-2.0), rasterising onto `@napi-rs/canvas` (MIT).
   - The canvas package ships prebuilt binaries for Linux, so Render needs no native build tools (phase 1 asked for this or a justification).
   - MuPDF is rejected: its AGPL licence conflicts with a public MIT repository.
   - Cost if wrong: a different renderer later. The rest of the design does not depend on it.
2. **Resolution**: pages are rendered at about 150–200 dpi, capped by phase 1's pixel limits.
   - OCR reads at most 4 MP, as today.
   - The rebuilt PDF stores each page as an image sized to stay readable and under PayPal's 10 MB per file. The exact value is set by the legibility test.
3. **Input limits**: 10 MB and 30 pages for the uploaded PDF; at most 5 pages selected.
   - Bigger bodies than phase 1's 5 MB need the same guarded large-body slot; it is reused, not widened for every route.
   - Cost if wrong: some real PDFs are refused. The limits are one constant each.
4. **Hostile PDFs**:
   - no JavaScript, no embedded files and no external resources are ever executed or fetched (pdf.js run with scripting off and no network);
   - limits on page count, page dimensions and render time per page;
   - encrypted or broken files are refused with a reason;
   - one PDF job at a time on the server, like the OCR queue.
5. **Processing as a background job**:
   - the upload returns at once with a job state (selecting → rendering → reading page k of n → reviewing);
   - the review screen polls it;
   - covering a page re-reads only that page;
   - confirming builds the sanitised PDF once.
6. **Thumbnails for selection**: low-resolution renders of every page, kept only until the selection is made. They never reach the AI or PayPal.
7. **The PDF's own text layer**:
   - in the first version it is shown only as a read-only hint next to each page during review ("text found in the PDF"), so the merchant can spot OCR mistakes and correct them;
   - it is never stored after confirmation and never sent anywhere.
   - Cost if wrong: one hint panel less, if it proves confusing.
8. **Rebuilt PDF**:
   - written by ResolveKit's own minimal PDF writer, extended with image pages (`packages/pdf`), so we control every byte that goes out;
   - a fresh file with only page images, a synthetic-free neutral title (the original file name never leaves the server, as in phase 1) and no metadata beyond what the writer always emits.
9. **Document model**: a PDF upload is one evidence document E<n> with lines grouped by page; fragments look like `E<n>.p<page>.l<i>`. Citations show «page 8 of the original».

10. **One image per page, end to end** (follows from the owner's closing criterion).
    - Each covered page is encoded **once**. That same image is what the merchant reviews, what OCR reads (downscaled internally to its 4 MP limit, from that image), what citations show, and what goes into the rebuilt PDF.
    - Confirm checks the hash of every page image, as phase 1 checks the file hash.
    - The PDF is then built deterministically from those images, so the same images always give the same bytes.
    - Legibility and the 9.9 MB cap are met by choosing that one image's resolution and encoding, never by recompressing a separate copy for PayPal.
11. **The PDF's text layer as a hint** (refines call 7).
    - It is shown for the whole page, read-only, only during review. The merchant is looking at their own document, so it is not hidden from them.
    - It cannot be inserted into a correction. Corrections are typed by the merchant, as in phase 1.
    - It is never stored after confirmation, never logged and never sent.
    - Hidden text (white text, off-page text) can appear there, which is a reason to keep it a hint and never a source.
12. **After confirmation** the server keeps the sanitised page images (needed for citations and the final review) and the rebuilt PDF.
    - Both are the same version, both are covered by deletion, purging and archiving, and both are hashed into the approved content.
13. **Caps**:
    - a PDF counts as **one upload** for the daily cap and the per-case limit;
    - OCR metering counts **per page read**;
    - the redact cap is **5 per page**.
    - Cost if wrong: the abuse budget per PDF is up to five times an image's.
14. **The selection is final once review starts.** To change it, the merchant discards the upload and uploads it again. The original is dropped as soon as the selected pages are rendered.
    - Cost if wrong: re-uploading a document to change its pages.

## Left to the builder

- The UI layout of the selection step and the per-page review, within the current design system and phase 1's review screen.
- Job storage and polling details, the progress wording, and where the job lives (next to the upload store).
- The exact render dpi and image encoding of the rebuilt PDF (from the legibility test), and the exact name of each limit constant.
- How the analysis input groups a PDF's pages, as long as fragments are stable and the original page numbers are shown.
