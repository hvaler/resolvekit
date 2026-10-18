# Merchant evidence, phase 2 (PDFs): what was left for later

This shipped on `main` at `f40a610` on 18/10/2026. Every task was reviewed, the whole branch had a final review with one fix wave, and the PDF flow was walked through in a real browser before the merge: select pages, cover, read again, refuse a transcription over a cover, add a transcribed line, review the pages included, confirm.

## To check on Render after the deploy

- **Memory.** Upload a 5-page PDF and read the Metrics graph. On Windows the confirm peaks at about 374 MB in the parent with OCR loaded, and the render child at 155 MB. The child's 200 MB RSS ceiling (`/proc` polling, 100 ms) has not been measured on Linux against a real bomb.
- **Thumbnail deadline.** `PDF_THUMB_TIMEOUT_MS` is 3 s per page on 0.5 CPU. If real PDFs fail there, raise it.
- **Build size.** Rebuilding 5 pages holds about 60 MB of RGB before writing.

## Parked: decide later

- **`closeOcr()` has no time limit.** It is awaited inside the heavy slot before the PDF child is forked. A worker start that never finishes would hold the slot until a restart. The OCR start budget (30 s) bounds this on the OCR side.

## Small, deferred on purpose

- **Limits and sizes.**
  - Noisy colour scans are about 1.9 MB per page, so 5 of them may exceed 9.9 MB. The confirm answers 413 and the upload stays reviewable.
  - A huge page (A3, a poster) renders at a lower dpi to stay under 4 MP.
  - A non-Standard encryption filter shows the generic «unreadable» message.
- **Child process.**
  - A child stuck in a sync loop can outlive a dead parent (a Render restart reaps it).
  - The child's stderr is not captured in the log.
  - `CANNOT_START` is detected by the message text.
- **Behaviour.**
  - A selection made while thumbnails render is lost if the next thumbnail fails.
  - When the same text is on two pages, a quote matches the first page.
  - Re-reading is disabled once a page is covered.
  - `hasRoom` ignores replaced or freed bytes (it errs safe).
  - Hints share the `paypalReads` limit bucket. A hint failure that is not an `UploadError` answers 503 without a log line.
  - The image slot is held for a whole thumbnail session.
- **Test coverage.**
  - There are no DOM tests for `useUploads`, `PdfSelect`, `PdfReview`, the `CasePage` wiring or the draft-clear wiring. The decisions are tested as pure functions, and the browser walk-through covered the flow.
  - No test checks that the file name is absent from logs and audit.
  - The fixture check for hidden structures is a raw substring check; only white text is proven through the hint.
  - Other gaps:
    - no concurrency test for a cover during a confirm;
    - the race test may not hit the race;
    - release paths are untested;
    - the budget test sleeps 5.2 s;
    - `writeImagePdf` has no test of the `cm` operands against the MediaBox, and no input validation.
- **Tidy-ups.**
  - There is a CRLF mix in `uploads-kit.ts`.
  - The plan's constraints still say `PDF_MAX_PAGE_PIXELS = MAX_PIXELS`; the code and the README say 4 MP.

## Decisions taken during the build (rulings)

1. pdf.js runs in a forked child process. It is killed at the deadline or above 200 MB RSS, and PDF metadata is never decoded. This came from the security review and a measured 64 KB Flate bomb that reached 685 MB.
2. `PDF_MAX_PAGE_PIXELS` is 4 MP, the same as OCR, so a page render stays well under the child ceiling.
3. A job renders all the selected pages first, closes the child, then runs OCR page by page. A render and an OCR never run at the same time.
4. The original PDF stays until confirm, not until rendering. The text hint needs it, and it is purged with the uncovered renders (`*.orig.png`) at confirm, discard, delete, expiry and archive. This amends spec call 14.
5. Until an upload is confirmed, its pages and text are served only to people who can edit it; the others see metadata only (`restricted: true`). This also applies to phase 1 images.
6. A PDF cover is metered once, by the existing cover limit.
7. Each page keeps its render dpi, so the rebuilt PDF keeps the physical page size.
8. The text hint is computed at most once per page, kept in memory only, and counts toward the per-address limit.
9. The verifier refuses quotes that cross a page boundary. Page marks stay outside the quotable text.
10. A citation shows the page label once («Pages 2 and 8 of the original document»), never once per line.
11. The OCR worker is closed before the PDF child is forked, so the two are never resident together.
12. Thumbnails take at most 3 s per page and each PDF session at most 90 s. Over budget, the job fails with «This PDF takes too long to read. Prepare a smaller extract and upload it again.» and everything is freed.
