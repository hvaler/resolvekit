# Merchant Evidence, Phase 2 (PDFs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merchants upload short PDFs (labels, invoices, bank extracts). They choose up to 5 pages, cover areas on each page, correct the OCR text or transcribe missed lines, and confirm. The analyst cites the pages, and PayPal receives a PDF rebuilt only from the covered page images.

**Architecture:**
- **Server side.** The server renders the selected pages with pdf.js onto a canvas. It burns the covers into one PNG per page; that same image is shown, OCR-read, cited and embedded. At confirm, ResolveKit's own PDF writer builds a fresh PDF from those images. Long work runs as a background job per upload, polled by the web.
- **Reuse of phase 1.** Phase 1's store, routes, caps, permissions, isolation and send path are reused. Documents gain page-scoped fragments and manually transcribed lines.

**Tech Stack:**
- Node 24 (`.ts` run directly) with `node:test`.
- `pdfjs-dist` (Apache-2.0) and `@napi-rs/canvas` (MIT, prebuilt binaries), plus phase 1's `pngjs`, `tesseract.js` and `zlib`.
- React and vitest (domain-only).

**Spec:** `docs/superpowers/specs/2026-10-18-merchant-evidence-pdf-design.md` (approved 18/10/2026). Its «Decided by the owner» and «Decisions taken by Claude» sections are binding. Phase 1's spec (`2026-10-17-merchant-evidence-design.md`) still holds where this one is silent.

## Global Constraints

- New dependencies only: `pdfjs-dist` and `@napi-rs/canvas`. Each version must be exact, a stable release published at least 2 weeks ago. Install both with `--workspace @resolvekit/server` and commit the lockfile.
- Limits (in `apps/server/src/uploads/limits.ts`):

  | Constant | Value |
  |---|---|
  | `PDF_MAX_BYTES` | `10 * 1024 * 1024` |
  | `PDF_MAX_PAGES` | `30` |
  | `PDF_MAX_SELECTED` | `5` |
  | `PDF_RENDER_DPI` | `170` (the legibility test in Task 9 may change it, and the plan's value moves with it) |
  | `PDF_THUMB_DPI` | `36` |
  | `PDF_MAX_PAGE_PIXELS` | `4_000_000` (`OCR_MAX_PIXELS`, by ruling: an 8.3 MP render came too close to the child's 200 MB ceiling); above it the page is rendered at a lower dpi so it fits |
  | `PDF_PAGE_TIMEOUT_MS` | `20_000` per page render |
  | `PDF_THUMB_TIMEOUT_MS` | `3_000` per thumbnail render (final review I-2) |
  | `PDF_SESSION_BUDGET_MS` | `90_000` per PDF session in all; past it the job fails with «This PDF takes too long to read. Prepare a smaller extract and upload it again.» (final review I-2) |
  | `MAX_REDACTS_PER_PAGE` | `5` |

- Kind and file names:
  - The kind is `'pdf'`, MIME `application/pdf`.
  - Stored page image: `page-<k>.png`, where k is the 1-based position in the selection.
  - Thumbnail: `thumb-<n>.png`, where n is the original page number. Thumbnails are deleted when the selection is made.
  - The sanitised PDF is `sanitised.pdf` (phase 1's name). The PayPal file name is `E<n>-upload.pdf`. The document title is `Uploaded PDF` and its type is `Merchant upload · PDF`.
- Fragments are `E<n>.p<orig>.l<i>`, where orig is the original page number and i the 1-based line within that page. Added lines continue the numbering after the OCR lines of their page.
- Analysis marks (`packages/analyst/src/prompts.ts`):
  - `TRANSCRIBED_MARK = '   ↳ transcribed manually by the merchant'`, on its own line outside the quotable text, like `CORRECTED_MARK`.
  - A rule saying such lines were typed by the merchant, not read from the document, is added only when such a line exists.
- Copy (verbatim, English):
  - selection: `This document has {n} pages. Choose up to 5 to add as evidence.`
  - page label: `Page {k} of the original document`
  - selection warning: `Keep the context the dispute needs: don't leave out pages with relevant or contradicting information.`
  - barcode warning: `Covering the text next to a barcode or QR code doesn't hide what the code contains. Cover the code too if it carries data you don't want to share.`
  - transcription label: `Transcribed manually by {person}`
  - hint label: `Text found in the PDF (a hint for your review; never stored or sent)`
  - no text: `No text was read on this page. Transcribe what matters, or the analyst can't use it.`
  - too big: `This PDF is larger than 10 MB or has more than 30 pages. Prepare a smaller extract and upload it again.`
  - encrypted: `This PDF is password-protected or encrypted. Upload a version without protection.`
  - unreadable: `This file could not be read as a PDF.`
- Caps:
  - A PDF counts as **one upload** (daily cap and `MAX_UPLOADS_PER_CASE`).
  - OCR metering (the per-address metering of redactions) counts **each page read**.
  - Redacts are capped at `MAX_REDACTS_PER_PAGE` per page.
- Privacy, as in phase 1, plus three PDF rules:
  - Nothing of a PDF goes to the AI or PayPal before confirm, and no upload text or file names appear in logs or audit details.
  - The original PDF, its text layer, fonts, embedded files, annotations and metadata never leave the server.
  - pdf.js runs with scripting and evaluation off, with no network, no external resources and no system fonts.
- One heavy job at a time server-wide. PDF rendering takes phase 1's `oneImageAtATime` slot, and OCR keeps its own queue.
- Hosted isolation (`caseVisible`), permissions (`canEditUpload`/`canDeleteUpload`), expiry, archive on rotation and purge on delete all apply unchanged to `pdf` uploads.

## Review Focus

1. **An encrypted, corrupt, zero-page or non-PDF file** sent as `application/pdf` gets a clear refusal (the encrypted or unreadable copy) and never a crash or a stuck job. Pinned in Task 2.
2. **A huge or landscape page** (A3, a poster, a 14400 pt page) is rendered within `PDF_MAX_PAGE_PIXELS` and stays legible, or is refused with a reason. Pinned in Task 2.
3. **A server restart while a job runs** must not leave the upload stuck in `reading` forever. On load it becomes `failed`, with a message and a way to discard and upload again. Pinned in Task 3.
4. **A transcription area that overlaps a cover, or a cover drawn after a transcription in the same area**, is refused at confirm with a reason. The text never reaches the AI. Pinned in Task 5.
5. **A selected page with no OCR text** shows the no-text copy. Confirm is allowed, and the analyst gets no lines for that page unless transcribed. Pinned in Tasks 5 and 8.

---

### Task 1: Image pages in ResolveKit's PDF writer

**Files:**
- Modify: `packages/pdf/src/pdf.ts`
- Test: `packages/pdf/test/pdf.test.ts` (create if absent; follow the package's test script)

**Interfaces:**
- Produces:
  - `export interface ImagePage { width: number; height: number; rgb: Uint8Array /* width*height*3 */ }`
  - `export function writeImagePdf(o: { title: string; pages: readonly ImagePage[]; dpi: number }): Uint8Array`
- Each page is one `/XObject /Image` with `/DeviceRGB`, 8 bits per component, `/FlateDecode` (data is `zlib.deflateSync` with fixed level 9) and nothing else. The page MediaBox is `width*72/dpi` × `height*72/dpi` points, drawn full-page.
- Catalog, Pages, one Info dictionary with `/Title` and `/Producer (ResolveKit)` only. No fonts, no annotations, no `/Names`, no `/EmbeddedFiles`, no JavaScript, no XMP. Same input bytes always give the same output bytes (no dates, no ids).

- [ ] **Step 1: Write the failing tests:**
  - `writeImagePdf: one XObject per page, sized from dpi`: 2 pages of 340×170 at dpi 170 give 2 `/Type /Page` with `MediaBox [0 0 144 72]`.
  - `writeImagePdf: deterministic`: same input → identical bytes.
  - `writeImagePdf: no fonts, annotations, embedded files, JavaScript or XMP`: none of `/Font`, `/Annots`, `/EmbeddedFile`, `/JavaScript`, `/JS`, `/Metadata` appear.
  - `writeImagePdf: the image stream inflates back to the exact pixels`: inflate the stream and compare.
  - `writeImagePdf: valid xref offsets`: reuse the existing offset check style of the text writer's test.
- [ ] **Step 2: Run** `npm test --workspace @resolvekit/pdf` (or the package's script). Expected: FAIL, because `writeImagePdf` is not exported.
- [ ] **Step 3: Implement** `writeImagePdf`. It works with binary stream bodies, so build the file as byte chunks with offsets counted in bytes, not string length. Keep `writePdf` unchanged.
- [ ] **Step 4: Run** the package tests and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pdf): image-only PDF pages (writeImagePdf), deterministic, nothing inherited`.

### Task 2: Reading uploaded PDFs safely (inspect, render, hint)

**Files:**
- Create: `apps/server/src/uploads/pdf-input.ts`
- Create: `apps/server/test/fixtures/make-pdfs.ts` (builds the test PDFs in code: text PDF, multi-page, landscape A3, encrypted marker, corrupt, a page with white hidden text plus metadata plus an attachment plus an annotation)
- Modify: `apps/server/src/uploads/limits.ts` (the PDF constants)
- Modify: `apps/server/package.json`
- Test: `apps/server/test/uploads-pdf-input.test.ts`

**Interfaces:**
- Consumes: `UploadError` and `oneImageAtATime` from `image.ts`.
- Produces:
  - `inspectPdf(bytes: Uint8Array): Promise<{ pages: number }>`. It throws `UploadError`:
    - `TOO_LARGE`: over `PDF_MAX_BYTES` or `PDF_MAX_PAGES`, with the too-big copy.
    - `UNREADABLE`: encrypted (encrypted copy) or not a PDF (unreadable copy). Zero pages also counts as unreadable.
  - `renderPage(bytes: Uint8Array, page: number, dpi: number): Promise<{ width: number; height: number; rgba: Uint8Array }>`. It is 1-based, capped to `PDF_MAX_PAGE_PIXELS` by lowering the dpi, and runs within `PDF_PAGE_TIMEOUT_MS` inside `oneImageAtATime`.
  - `pageTextHint(bytes: Uint8Array, page: number): Promise<string[]>`: the text layer lines, read-only.
- pdf.js options:
  - `isEvalSupported: false`, `enableXfa: false`, `disableFontFace: true`, `useSystemFonts: false`;
  - `standardFontDataUrl`: the package's local folder;
  - no `url`, data only; no worker fetch.

  A test asserts no network access, as phase 1's OCR does.

- [ ] **Step 1: Write the failing tests:**
  - inspect counts pages;
  - 31 pages → `TOO_LARGE` with the copy;
  - over 10 MB → `TOO_LARGE`;
  - encrypted → `UNREADABLE` with the encrypted copy;
  - corrupt, zero pages or a PNG sent as PDF → `UNREADABLE` with the unreadable copy;
  - render page 2 of a 3-page fixture at 170 dpi → A4 size ±2 px;
  - a landscape A3 / 14400 pt page stays ≤ `PDF_MAX_PAGE_PIXELS`;
  - a render over the timeout → `OCR_TIMEOUT`-style `UploadError` (reuse the code `UNREADABLE` with a timeout message), and the slot is freed for the next job;
  - `pageTextHint` returns the fixture's text lines;
  - no network (fetch stubbed to throw, as in `uploads-ocr.test.ts`).
- [ ] **Step 2: Run** `cd apps/server && node --test test/uploads-pdf-input.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Install the two dependencies and implement.** Use the legacy Node build of pdf.js; check what it needs and say so in the report.
- [ ] **Step 4: Run** the test, the full `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(uploads): read PDFs safely: inspect, render a page, text hint (pdf.js, no scripting, no network)`.

### Task 3: PDF uploads in the store, and the job state

**Files:**
- Modify: `apps/server/src/uploads/store.ts`
- Test: `apps/server/test/uploads-store.test.ts`

**Interfaces:**
- Produces, extending the phase 1 `UploadRecord`:
  - `kind: 'image' | 'text' | 'pdf'`
  - `pdf?: PdfState` on pdf records:
    ```ts
    interface PdfPage { original: number; rects: Rect[]; readLines: string[]; lines: { text: string; correctedBy: string | null; original: string | null }[]; added: { area: Rect; text: string; by: string }[]; sha256: string | null; redactions: number }
    interface PdfState { pageCount: number; selected: number[] | null; pages: PdfPage[]; job: { state: 'selecting' | 'rendering' | 'reading' | 'reviewing' | 'failed'; page?: number; of?: number; error?: string } }
    ```
  - Store methods:
    - `pageImage(id, k): Uint8Array | null`
    - `thumb(id, n): Uint8Array | null`
    - `update(id, patch, files: { …phase 1…, pages?: Record<number, Uint8Array | null>; thumbs?: Record<number, Uint8Array | null> })`

    Writes stay atomic.
- Purge covers all of a pdf upload's state: `pdf.pages`' rects, lines, added lines and readLines, plus every `page-*`, `thumb-*`, `original.bin` and `sanitised.pdf` file. This applies to discard, delete, expiry and archive.
- On load, a pdf record whose job is `rendering` or `reading` becomes `failed` with `error: 'The server restarted while reading this PDF. Discard it and upload it again.'`

- [ ] **Step 1: Write the failing tests:**
  - a pdf record round-trips its `pdf` state;
  - page and thumb files are stored, read back and purged on discard, delete, expiry and archive (assert the files are gone from disk);
  - reload with job `reading` → `failed` with that message (Review Focus 3);
  - setting `thumbs` to null deletes them.
- [ ] **Step 2: Run** `cd apps/server && node --test test/uploads-store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the store tests, the full suite and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(uploads): PDF upload state, per-page files, job state that survives a restart as failed`.

### Task 4: Upload, select and process a PDF (routes and background job)

**Files:**
- Modify: `apps/server/src/uploads/routes.ts`, `apps/server/src/node.ts` (`bodyLimit`), `apps/server/src/uploads/limits.ts`
- Create: `apps/server/src/uploads/pdf-job.ts`
- Test: `apps/server/test/uploads-pdf-routes.test.ts` (reuse the helpers of `uploads-routes.test.ts`)

**Interfaces:**
- Consumes: Task 2 (`inspectPdf`, `renderPage`), Task 3 (store), and phase 1's `sanitiseImage` (on the rendered RGBA re-encoded as PNG), `ocrPng`, caps, `reserve`, `caseVisible` and `REFUSED_EARLY`.
- Produces:
  - `POST /api/cases/:id/uploads` with `content-type: application/pdf` (header `x-upload-name`) → 201 `{ upload: view }`.
    - If there are ≤ 5 pages, all are selected and the job starts.
    - If there are more, the state is `selecting` and thumbnails are rendered by the job.
  - `POST /api/cases/:id/uploads/:u/select` with `{ pages: number[] }` → 200 `{ upload }`.
    - 1–5 unique original page numbers within `pageCount`; the order is ascending.
    - Only while `selecting`; the selection is final.
    - Thumbnails are deleted and the job starts rendering and OCR.
  - `GET /api/cases/:id/uploads/:u/page/:k?v=sanitised|original` → PNG.
    - `original` is the uncovered render. It is kept only while reviewing, as `page-<k>.orig.png`, and only for `canEditUpload`. It is deleted at confirm.
    - `sanitised` is the stored page image.
    - `/thumb/:n` serves thumbnails while selecting.
  - The view of a pdf upload adds `pdf: { pageCount, selected, pages: [{ original, rects, readLines, lines, added, sha256 }], job }`, with no hint text.
  - `createPdfJob(o: { store; log }): { start(uploadId: string): void }`. It processes one upload at a time, page by page, and records `job.page/of`. It updates the state after each page so the web can poll `GET /uploads`.
- Body limit:
  - `bodyLimit` gives `PDF_MAX_BYTES` for `POST /uploads` on an existing case with `application/pdf`.
  - Images keep `MAX_FILE_BYTES`.
  - The same large-body slots apply: at most 3 in flight, 1 per address, the 30 s deadline.
- Metering:
  - `reserve` is called once per PDF upload.
  - Each page read counts once toward the per-address OCR metering, as a redaction does in phase 1.

- [ ] **Step 1: Write the failing tests:**
  - a 3-page PDF → job reaches `reviewing` with 3 pages, each with `readLines` and a `sha256`;
  - a 12-page PDF → `selecting`, with thumbs served; select `[2,8]` → 2 pages with `original` 2 and 8, thumbs gone;
  - select 6 pages, page 0, page 13, duplicates or a second select → 400/409;
  - 11 MB body → 413 before reading;
  - encrypted → 422 with the encrypted copy;
  - another workspace, signed out, or an unbound case (hosted) → 404 `UNKNOWN_CASE`;
  - a reviewer can upload and select;
  - one PDF uses one daily `upload` unit;
  - `original` page view refused once confirmed;
  - the job never runs two uploads at once (two uploads → sequential, as in phase 1's queue test).
- [ ] **Step 2: Run** `cd apps/server && node --test test/uploads-pdf-routes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(uploads): upload a PDF, choose up to 5 pages, render and read them in a background job`.

### Task 5: Cover, correct, transcribe and confirm a PDF

**Files:**
- Modify: `apps/server/src/uploads/routes.ts`, `apps/server/src/uploads/pdf-job.ts`
- Test: `apps/server/test/uploads-pdf-routes.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `POST /uploads/:u/redact` with `{ page: k, rects }` on a pdf upload:
    - re-sanitises page k from its uncovered render and re-reads it with OCR;
    - updates that page's `rects`, `readLines` and `sha256`, and resets its `lines` and `added`;
    - refused (409 `TOO_MANY_REDACTS`) after `MAX_REDACTS_PER_PAGE` attempts on that page;
    - counts one OCR for metering.
  - `GET /uploads/:u/page/:k/hint` → `{ lines: string[] }` from `pageTextHint`. It works only while reviewing, only for `canEditUpload`, with `cache-control: no-store`. It is never stored, logged or audited.
  - `POST /uploads/:u/confirm` with `{ pages: [{ lines: string[], added: { area: Rect, text: string }[], sha256 }] }`, one entry per selected page in order.
    - Per page, `lines.length === readLines.length`, and `sha256` must match the stored page image (else 409 `UPLOAD_CHANGED`).
    - Each added line has non-empty text with phase 1's line rules, an area within the page that is at least 2×2, and an area **not overlapping any cover** of that page. Otherwise 422 `BAD_TRANSCRIPTION` with `A transcribed line cannot come from a covered area.`
    - The total text is ≤ `MAX_TEXT_CHARS`.
    - On success:
      - build `sanitised.pdf` with `writeImagePdf` from the stored page images, at their render dpi;
      - check the PDF against `MAX_STORED_BYTES` (413 `TOO_LARGE` if over);
      - set `sha256` and `size` of the PDF;
      - delete `original.bin` and every `page-*.orig.png`;
      - assign `E<n>` as phase 1 does, and record `added[].by` as the person label.

- [ ] **Step 1: Write the failing tests:**
  - covering page 2 changes only page 2;
  - a 6th redact of a page → 409;
  - the hint works while reviewing, is refused after confirm, and is refused for a reviewer who is not the uploader when `canEditUpload` says so;
  - confirm builds a PDF whose page count equals the selection;
  - the original and the uncovered renders are gone from disk after confirm;
  - a transcription overlapping a cover → 422 with the copy (Review Focus 4);
  - a stale page `sha256` → 409;
  - a page with zero `readLines` confirms with `lines: []` and an added line (Review Focus 5);
  - a confirmed PDF's `sanitised.pdf` bytes equal `writeImagePdf` of the stored page images (the "same version" invariant).
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(uploads): cover a PDF page, transcribe missed lines, confirm a PDF rebuilt from the covered pages`.

### Task 6: PDFs in the analysis, the approval and the send

**Files:**
- Modify:
  - `apps/server/src/uploads/documents.ts`
  - `packages/analyst/src/prompts.ts`, `packages/analyst/src/types.ts` (`DocLine.transcribed?: string`)
  - `apps/server/src/app.ts` (send attachments and content hash: already by upload, check the pdf kind)
  - `apps/web/src/domain/draft.ts`, `apps/web/src/domain/uploads.ts`, `apps/web/src/domain/intent.ts` (confirmation pairs for transcribed lines, shared by client and server)
- Test: `apps/server/test/uploads-documents.test.ts` (create or extend), `packages/analyst/test/prompts.test.ts`, `apps/web/src/domain/uploads.test.ts`

**Interfaces:**
- Produces:
  - `uploadDocuments` for a pdf record:
    - title `Uploaded PDF`, type `Merchant upload · PDF`;
    - lines in page order;
    - each OCR line `{ text, fragment: 'E<n>.p<orig>.l<i>', corrected? }`, each added line `{ text, fragment, transcribed: by }`;
    - a page with no lines contributes nothing.
  - `uploadFileName` for pdf → `E<n>-upload.pdf`.
  - `renderDocuments` prints `TRANSCRIBED_MARK` after a transcribed line. The rule is added only when one exists.
  - Web:
    - `transcriptionsOf(docs)` works like `correctionsOf`.
    - Sentences citing a transcribed fragment need a `sentenceId@fragment` confirmation, exactly like corrections (phase 1 Ruling G), in `composeSubmission` and on the server.
    - `provenanceOf`/`citedCorrections` show `Transcribed manually by {person}`, and the page label `Page {k} of the original document` for pdf fragments.

- [ ] **Step 1: Write the failing tests:**
  - fragments and order for a 2-page selection `[2,8]` (`E7.p2.l1`…, `E7.p8.l1`…);
  - the transcribed mark and rule appear only when needed;
  - the PayPal file name is `E7-upload.pdf`;
  - approval refused without the transcription pair (`DRAFT_BLOCKED`) and accepted with it;
  - the content hash changes when a transcription changes;
  - the send attaches exactly the stored `sanitised.pdf`;
  - the web provenance strings are verbatim.
- [ ] **Step 2: Run** the three test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(uploads): PDF pages in the analysis (page fragments, transcribed lines) and in the approval and send`.

### Task 7: Web, upload, selection and progress

**Files:**
- Modify: `apps/web/src/domain/uploads.ts` (client and view types), `apps/web/src/components/AddEvidence.tsx`
- Create: `apps/web/src/components/PdfSelect.tsx`, `apps/web/src/domain/pdfReview.ts` (pure helpers), `apps/web/src/domain/pdfReview.test.ts`

**Interfaces:**
- Consumes: Tasks 4–5 routes and view.
- Produces:
  - Client methods:
    - `uploadPdf(file: File): Promise<{ upload: UploadRecordView }>`
    - `select(id, pages: number[])`
    - `pageUrl(id, k, v: 'sanitised' | 'original', version)`
    - `thumbUrl(id, n)`
    - `hint(id, k): Promise<string[]>`
    - `redactPage(id, k, rects)`
    - `confirmPdf(id, pages)`
  - `AddEvidence` accepts `application/pdf` too (`accept="image/png,image/jpeg,application/pdf"`).
  - `PdfSelect` shows the thumbnails, the selection copy, at most 5 picks, the original numbers and the selection warning.
  - Progress: `jobLabel(job)` gives `Reading page {page} of {of}…`, `Preparing pages…` and `Failed: {error}`. Polling uses phase 1's backoff helper and stops at `reviewing` or `failed`.
  - Pure helpers: `canPick(selected, n)`, `pickedLabel(orig)`, `jobLabel(job)`, `pollDelay(attempt)`.
- [ ] **Step 1: Write the failing tests** for the helpers and the client (fetch stubbed): the verbatim copy, at most 5 picks, the labels, and the request shapes of `uploadPdf` and `select`.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/domain/pdfReview.test.ts src/domain/uploads.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run`, `npm run typecheck` and `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): add a PDF, choose its pages, follow its reading`.

### Task 8: Web, per-page review, transcription and confirm

**Files:**
- Modify: `apps/web/src/components/UploadReview.tsx` (pdf branch; reuse `ImageCover` with page URLs), `apps/web/src/domain/pdfReview.ts`, `apps/web/src/domain/pdfReview.test.ts`, `apps/web/src/components/EvidenceCard.tsx`, `apps/web/src/components/SentenceRow.tsx`, `apps/web/src/components/ApproveFlow.tsx` (labels)

**Interfaces:**
- Consumes: Task 6 (provenance, pairs) and Task 7 (client).
- Produces:
  - **Page navigation.** Each page shows `Page {k} of the original document`, the cover tool (`redactPage`), and its OCR lines with correction.
  - **Add a transcribed line.** The merchant marks an area on the page with the same rectangle tool in an «add text» mode, then types the text. `transcriptionArea(rect, covers)` refuses overlap with `A transcribed line cannot come from a covered area.`
  - **Copy.** The barcode warning shows always on PDF pages. The no-text copy shows when a page has 0 lines.
  - **Hint.** The hint panel has its label, is read-only and has no copy-into-line action.
  - **Confirm.** Before confirming, the list of included pages is shown with the selection warning, then `confirmPdf`.
  - **Evidence card and citations.** They show the page label and `Transcribed manually by {person}`.
- [ ] **Step 1: Write the failing tests** for `transcriptionArea` (overlap refused, inside accepted), `confirmPayload(pages)` (one entry per page in order with its sha256), and the verbatim copies.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/domain/pdfReview.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run`, `npm run typecheck` and `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): review PDF pages, cover, correct, transcribe and confirm`.

### Task 9: Recovery attempts, legibility, limits on the instance, and docs

**Files:**
- Test: `apps/server/test/uploads-pdf-recovery.test.ts`
- Modify: `docs/judges.md`, `README.md` («Merchant uploads»), `docs/evals.md` if the eval inputs mention upload kinds

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the tests.**
  - **Recovery attempts.** The fixture page holds:
    - a visible secret under a cover;
    - white hidden text with a second secret;
    - a metadata Title, Author and Subject with a third secret;
    - an annotation with a fourth secret;
    - an embedded file with a fifth secret.

    After upload, cover and confirm, none of the five secrets appears:
    - in `sanitised.pdf`'s bytes;
    - in its inflated streams;
    - in the stored page images' OCR;
    - in the analysis input;
    - in the PayPal multipart body (stub);
    - in logs or audit events.

    Also, in the covered area of the stored image every pixel is 0,0,0, and `sanitised.pdf` carries no `/Metadata`, `/Annots`, `/EmbeddedFile`, `/Font` or `/JavaScript`.
  - **Legibility.** A fixture with an 8 pt account number and tracking number, rendered at `PDF_RENDER_DPI`, is read by OCR exactly. If not, raise `PDF_RENDER_DPI` until it is (recording the value in the plan's constraints and in limits) while 5 A4 pages stay under `MAX_STORED_BYTES`.
  - **Size.** 5 dense A4 pages → `sanitised.pdf` under `MAX_STORED_BYTES`, and the total with the demo PDFs under `PAYPAL_MAX_SEND_BYTES`.
- [ ] **Step 2: Run** `cd apps/server && node --test test/uploads-pdf-recovery.test.ts`. Expected: PASS. Any failure is a defect to fix in the task that owns the code; report it.
- [ ] **Step 3: Docs.**
  - `judges.md`, step «Add your own evidence»: PDFs, up to 5 pages, covering, transcribing, and the barcode warning.
  - `README.md`: the PDF pipeline (rasterise, cover, OCR of the covered image, rebuilt image-only PDF), the limits, and that the original never leaves the server.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck` and `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `test(uploads): recovery attempts on covered PDF content, legibility and size; docs`.
