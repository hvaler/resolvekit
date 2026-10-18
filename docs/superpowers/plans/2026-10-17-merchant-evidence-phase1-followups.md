# Merchant evidence, phase 1: what was left for later

Phase 1 (images and pasted text) is on `main`, from the design commits to `7cf6f7a`, and was verified in the PayPal sandbox on 18/10/2026: a covered upload was recorded by PayPal. Each item below was reviewed and judged not to weaken a guarantee.

## Open, worth doing

- **Photos and the 9.9 MB cap.** A 3.4 MB camera JPEG becomes an ~11.5 MB lossless PNG once covered, so it is refused. Candidate fix: keep JPEG as JPEG (re-encoded from the covered pixels) for photos.
- **Failed archive is never retried.** If writing an archived record fails, its files and text stay on disk and keep counting toward the 300 MB. Retry in the hourly sweep.
- **Evidence header count.** «Evidence · N documents» does not count uploads, although they are listed.
- **Evals.** They still title uploads by file name (the server now uses "Uploaded screenshot" / "Pasted text"). A decoy-twin eval and Groq's weak support are tracked as H-04.
- **Memory.** Render shows ~250 MB resident after an 8 MP reading (peak ~395 MB of 512). Node keeps the memory it reserved, but it is reused rather than accumulated. If it grows, try `MALLOC_ARENA_MAX=2` on Render.
- **PNG validation inflates twice** (pngjs accepts short data silently). Reads are one at a time; a 16-bit 8 MP PNG may peak ~150 MB.

## Small, deferred on purpose

- OCR: the "never fetches" test stubs only the main-thread fetch (the local `langPath` check is the real guarantee). The covered-number test covers the whole line box. tesseract.js brings an install script and unused transitive dependencies (node-fetch, idb-keyval).
- Text: a literal "[redacted]" typed by the person reads like a removal.
- Store: the original is written after the record commit. `readRecord` does a light shape check. `update()` can revive a dead record (no caller does).
- Routes:
  - The cleaned file name (≤120 characters) appears in workspace-scoped audit details.
  - A record that expired during OCR reaches «reviewing»; confirm catches it.
  - `readBody` does not listen for close/aborted (the slot is still freed).
  - The decode queue has no bound (bodies are already capped at 3 large at once).
- Intents and pins:
  - The type `confirmedCorrections` is required but missing on old stored intents.
  - The send-time hash check is untested when the record and the bytes change together.
  - `evidenceNumber` is duplicated in three files.
  - The receipt is fetched on every intent.
  - `InputPins.write` can leave a `.tmp` file behind.
  - `/verify` answers an error on a disk-write failure; it fails closed.
- Web (local mode only): the audit may name the client's local merchant next to "local operator". `fileProvenance` matches by name prefix.
- Web (attachments and session):
  - Toggling an attachment reloads the review.
  - Untyped files are labelled PNG.
  - A reviewer's own confirmed upload hides Delete without saying why.
  - State is not reset on sign-in.

## Decisions taken during the build (rulings)

- A–J: in the plan's execution ledger (summarised to the user on 18/10).
- K: 8.3 MP images at most, decoded one at a time.
- L: stored files capped (now 9.9 MB, PayPal's limit); archiving drops files and text.
- M: a quoted upload is "in use" like an attached one.
- N: the original file name never leaves the server.
- O: pasted text must be Latin-1.
- P: OCR reads at most 4 MP, and the worker stops after 60 s idle.
- Q: OCR has 30 s to start and 45 s to read, counted from when the worker is ready.

The full reviews (`final-review.md`, `final-rereview.md`) were in the plan workspace, which was deleted after the merge.
