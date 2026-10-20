[English](evidence-processing.md) | [Español](../es/technical/evidence-processing.md)

# Evidence processing (merchant uploads)

How ResolveKit turns a merchant's screenshot, PDF or pasted text into evidence the analyst can cite and PayPal can
receive, without anything leaving the server before the merchant has covered what they want and confirmed. Code in
`apps/server/src/uploads/` at commit `5111b88`. How to use it: [cases and evidence](../user-guide/cases-and-evidence.md),
[PDF review](../user-guide/pdf-review.md).

## Principles

- **Read on our server.** Images and PDF pages are read by local OCR; no upload, byte or text, goes to a model
  provider or to PayPal until it is covered where needed, read again and confirmed.
- **The merchant decides what to cover.** Nothing is covered automatically.
- **One sanitised version** serves the analyst and the PayPal attachment.
- **Logs carry ids and codes only**, never file names, upload text or bytes. The file name never leaves the server:
  PayPal receives `E<n>-upload.png` (`.jpg` for a covered photo), `E<n>-upload.pdf` or `E<n>-pasted.pdf`; the model sees the titles «Uploaded
  screenshot», «Uploaded PDF», «Pasted text».

## Dependencies and compatibility

| Dependency | Version | Use | Notes |
|---|---|---|---|
| `pdfjs-dist` | 6.4.299 (legacy Node build) | Count, render and read the text-layer hint of PDF pages, in the child | Fake worker on the child's main thread; no eval path in 6.x |
| `@napi-rs/canvas` | 1.0.10 | Canvas for pdf.js rendering | Native prebuilt binary per platform |
| `tesseract.js` | 7.0.0 | OCR (WASM) | Worker created lazily, one job at a time, stopped after 60 s idle |
| `@tesseract.js-data/eng` | 1.0.0 | English language data from disk | `cacheMethod: 'none'`; nothing is downloaded at runtime |
| `pngjs` | 7.0.0 | PNG decode and encode | |
| `jpeg-js` | 0.4.4 | JPEG decode | |
| `@resolvekit/pdf` | workspace | Write the pasted-text PDF and the image-only rebuilt PDF | |

Runs on Node 24. The suite passed on Windows on 19/10/2026; the service runs on Render's Linux. The PDF child's
memory kill reads `/proc/<pid>/statm` and therefore works on Linux only; on Windows and macOS (development) only the
deadline applies. Linux test runs and a memory measurement on Render with a 5-page PDF: Pending.

## Pipelines

### Image (PNG or JPEG)

1. `POST /api/cases/:id/uploads` with the raw bytes and `x-upload-name`. The type is told by magic bytes only; the
   size is read from the header and checked before any pixel is decoded.
2. Decoded one image at a time server-wide. A JPEG is first turned upright by its EXIF Orientation, as the browser
   shows it, so covers and OCR boxes land where the person saw them (a portrait phone photo is stored landscape). A
   sanitised file is encoded from the decoded pixels: no metadata, no ancillary chunks or segments, none of the
   original bytes.
3. OCR reads the sanitised image (downscaled for OCR only above 4 MP).
4. The merchant covers rectangles (`POST …/redact`, at most 5 passes); covers are burned in as opaque black and the
   image is read again.
5. The merchant reviews the lines, corrects any, and confirms (`POST …/confirm`) with the `sha256` of the sanitised
   file reviewed; a mismatch refuses (`UPLOAD_CHANGED`). The original is dropped.

A covered PNG is stored as a fresh PNG (lossless, for screenshots). A covered JPEG photo is stored as a fresh baseline
JPEG at quality 90 (JFIF header only: no EXIF or other segments), so it stays about the size of the photo and under
the 9.9 MB limit; as a lossless PNG a camera photo can grow three to five times. The covers are burned in before
encoding, so nothing under them reaches the file. OCR reads that stored file. Sending a covered JPEG to PayPal is
tested locally only (**Pending** in the sandbox).

### PDF

1. Upload ≤ 10 MiB and ≤ 30 pages (otherwise «This PDF is larger than 10 MiB or has more than 30 pages. Prepare a
   smaller extract and upload it again.»). Password-protected or encrypted PDFs are refused.
2. A background job (polled through `GET /uploads`) runs in stages: `selecting` (thumbnails at 36 dpi, 3 s each, for
   PDFs over 5 pages), `rendering` (the selected pages), `reading` (OCR of each render), `reviewing`, or `failed`
   with a fixed message (everything of the upload is freed).
3. A PDF of up to 5 pages is taken whole; a longer one needs a selection of 1–5 pages, once (`POST …/select`). The
   other pages are never analysed or sent.
4. Each chosen page is rendered at 170 dpi (a larger page at a lower dpi, to stay within 4 MP), passed through the
   same sanitising path as an image, then covered and OCR'd. **The OCR reads the covered image, never the text
   layer** (which can hold invisible text).
5. The PDF's own text layer may be shown as a **hint** during review only (once per page per review, in memory,
   never stored or logged; each hint counts as a PayPal read for the per-address limit).
6. The merchant may **transcribe** a line the OCR missed, bound to a visible area (≥ 2×2 px, inside the page, not
   overlapping any cover: «A transcribed line cannot come from a covered area.»).
7. On confirm the server builds `sanitised.pdf`, a new image-only PDF of the covered page images (no text layer,
   fonts, annotations, attachments, metadata or scripts), checks it fits 9.9 MB, and deletes the original and its
   uncovered renders. The original PDF never leaves the server.

Limits per session: 20 s per page render, 90 s for a whole pdf.js session («This PDF takes too long to read.»);
one PDF or image job at a time server-wide; PDF page reads count against the per-address **upload** limit (20 per
10 min, hosted).

### Pasted text

1. JSON `{text, name}`, at most 20 000 characters, Latin-1 only (text with another character is refused naming it,
   because the PDF sent to PayPal cannot show it); control characters are replaced.
2. Removals by character offsets become `[redacted]` (overlapping spans merge).
3. Stored and hashed as a PDF made by ResolveKit (lines wrapped at 300 characters).

## The PDF child (hostile input)

pdf.js runs in a forked child (`pdf-child.ts`), never in the server: `--max-old-space-size=160`, advanced
serialization over IPC (page pixels travel as binary strips), stdio closed. Options: `isEvalSupported: false`,
`enableXfa: false`, `disableFontFace: true`, `useSystemFonts: false`, `disableAutoFetch: true`, `verbosity: 0`; data
only, never a URL; `fetch` and `XMLHttpRequest` replaced by throwing functions and attempts counted in every reply.
The parent kills the child with `SIGKILL` at an operation's deadline and, on Linux, when its resident memory passes
200 MiB (checked every 100 ms). The OCR worker is closed before a child starts, as the hosted instance has room for
only one large heap. A crashed or killed child never throws in the parent.

`apps/server/test/uploads-pdf-recovery.test.ts` tries to recover a covered line, white text, metadata, an
annotation and an attachment from everything that leaves an upload. Status: Implemented · Tested locally. The RSS
kill has not been measured on Linux against a real decompression bomb (follow-up).

## From upload to evidence

| Step | Rule |
|---|---|
| Numbering | A confirmed upload becomes `E<n>`, after the case's documents (E7, E8…) |
| Citations | `E7.l<n>` for an image or text; `E7.p<page>.l<n>` for a PDF, with the **original** page number; a citation stays within one page |
| Attribution | The upload record keeps the person's label on each corrected line (`correctedBy`) and transcribed line (`by`); the web app shows «corrected by <label>» and «transcribed manually by <label>». The analyst sees fixed markers outside the document text: «↳ corrected by the merchant» and «↳ transcribed manually by the merchant» |
| Confirmation of dependent sentences | A sentence resting on a corrected or transcribed line needs the person's explicit confirmation (`confirmedCorrections`, ≤ 50 `S1@E7.l2` pairs) before it can be sent |
| Merchant notes | An explanation not in the document is a merchant note, never documentary evidence |
| Attachments | Only confirmed uploads of this workspace, case and active dispute; ≤ 10; in evidence order; bytes re-hashed at send |
| What PayPal receives | The sanitised file: covers burned into the PNG (or JPEG, for a photo), the rebuilt image-only PDF, or the pasted-text PDF |

## Visibility, lifetime and deletion

| Rule | Detail |
|---|---|
| Before confirmation | Files and text visible only to those who can edit the upload (uploader, Owners, full members); others see `restricted: true` metadata; files 404 |
| Permissions | Owners and members edit any upload; a reviewer edits only their own; delete: Owners and full members only |
| Pending lifetime | 24 h, then discarded when met and by the hourly sweep |
| Discard | Before confirmation, by an editor |
| Delete | Removes files, purges analyses, verdicts and pins that quoted it, voids unsent intents; refused while a send using it is in flight (`SEND_IN_PROGRESS`) |
| Rotation | When the case moves to its next dispute, its uploads are archived (record kept, files and text removed) |
| Barcode / QR warning | Covering the text next to a code does not hide what the code encodes; the PDF review says so |

## Limits (from `uploads/limits.ts`)

| Limit | Value |
|---|---|
| Image file | 5 MiB |
| Image size | 4096 px a side and 8 294 400 px in all (3840 × 2160 is one fit; 4096 × 2025 is another) |
| OCR | 4 000 000 px read; 45 s per reading, 30 s to start the worker |
| PDF | 10 MiB, 30 pages, 5 selected, 170 dpi, 4 MP per page |
| Covering passes | 5 per image or text upload; 5 per page for a PDF |
| Stored sanitised file | 9 900 000 bytes |
| All files of one PayPal response | 50 000 000 bytes |
| Pasted text, and a PDF's read + transcribed text | 20 000 characters |
| Uploads per case | 10 (pending, reviewing and confirmed) |
| Uploads per day (hosted) | 40 (`DAILY_UPLOADS`) |
| All upload files | 300 MiB (`STORAGE_FULL`, 507) |
| Per request | 200 rectangles or removals, 1 000-character lines, 120-character names |

## Status

| Capability | Status |
|---|---|
| Image upload, cover, OCR, confirm, send | Implemented · Tested locally · Verified in sandbox (a covered PNG recorded by PayPal, 18/10/2026; PayPal's copy held only the image's pixel data, cover burned in) · Deployed |
| PDF upload, selection, rebuild | Implemented · Tested locally · Deployed; sent to the PayPal sandbox: Pending |
| Pasted text | Implemented · Tested locally · Deployed; sent to the PayPal sandbox: Pending |

Open follow-ups (archive failure never retried, `closeOcr()` without a time limit, PDF UI test gaps): see
[known issues](../quality/known-issues.md).
