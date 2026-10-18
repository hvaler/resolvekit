/** Limits for merchant evidence uploads, in one place. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_SIDE = 4096;
/** 3840 x 2160: a 4K screenshot. Decoding is held to this so one image fits the hosted instance's memory. */
export const MAX_PIXELS = 8_294_400;
export const MAX_UPLOADS_PER_CASE = 10;
/** Daily cap key `upload`. */
export const DAILY_UPLOADS = 40;
/** Reading one image, counted from when the worker is ready: measured, an 8 MP reading needs more than 20 s on the 0.5 CPU instance. */
export const OCR_TIMEOUT_MS = 45_000;
/** Starting the OCR worker (cold: WASM core and language data), its own budget apart from OCR_TIMEOUT_MS. */
export const OCR_START_TIMEOUT_MS = 30_000;
/** OCR reads at most this many pixels (larger images are downscaled for OCR only): measured on Render, an 8 MP OCR peaked ~490 MB of the 512 MB. */
export const OCR_MAX_PIXELS = 4_000_000;
/** The OCR worker is terminated after this long without a job: measured, its WASM heap never shrinks (~430 MB resident after an 8 MP OCR, ~275 MB after a small one, ~80 MB idle without it). */
export const OCR_IDLE_MS = 60_000;
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_STORAGE_BYTES = 300 * 1024 * 1024;
/**
 * One stored (sanitised) file, checked at redact time. PayPal takes each file under 10 MB; 9,900,000 is below that
 * in either the decimal or the binary reading.
 */
export const MAX_STORED_BYTES = 9_900_000;
/** All the files of one provide-evidence call (demo PDFs, selected uploads, receipt): PayPal accepts up to 50 MB. */
export const PAYPAL_MAX_SEND_BYTES = 50_000_000;
export const MAX_TEXT_CHARS = 20_000;

// ---- PDF uploads ----
export const PDF_MAX_BYTES = 10 * 1024 * 1024;
export const PDF_MAX_PAGES = 30;
/** Pages of one PDF the merchant can add as evidence. */
export const PDF_MAX_SELECTED = 5;
/** Stored page images (legible for review and OCR). */
export const PDF_RENDER_DPI = 170;
/** Page thumbnails for choosing the selection. */
export const PDF_THUMB_DPI = 36;
/**
 * One rendered page holds at most this many pixels (the OCR limit): a larger page is rendered at a lower dpi so it
 * fits. Measured on Windows, an 8.3 MP render peaked at ~187 MB in the reader child, too close to its 200 MB ceiling.
 */
export const PDF_MAX_PAGE_PIXELS = OCR_MAX_PIXELS;
/** Reading the PDF and rendering one page. */
export const PDF_PAGE_TIMEOUT_MS = 20_000;
/** Rendering one thumbnail (PDF_THUMB_DPI): a real one takes well under a second, so a slow page cannot hold the image slot for long. */
export const PDF_THUMB_TIMEOUT_MS = 3_000;
/**
 * One PDF session in all (open, every render and hint), as it holds the server-wide image slot: past it the reader is
 * killed and the job fails, so one file cannot stall every other upload, cover and confirm for minutes.
 */
export const PDF_SESSION_BUDGET_MS = 90_000;
export const MAX_REDACTS_PER_PAGE = 5;
/**
 * The PDF reader child is killed above this resident size (Linux only, where it can be read): the hosted instance
 * has 512 MB for the server and the child together.
 */
export const PDF_CHILD_MAX_RSS_BYTES = 200 * 1024 * 1024;
