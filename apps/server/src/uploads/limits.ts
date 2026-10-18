/** Limits for merchant evidence uploads, in one place. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_SIDE = 4096;
/** 3840 x 2160: a 4K screenshot. Decoding is held to this so one image fits the hosted instance's memory. */
export const MAX_PIXELS = 8_294_400;
export const MAX_UPLOADS_PER_CASE = 10;
/** Daily cap key `upload`. */
export const DAILY_UPLOADS = 40;
export const OCR_TIMEOUT_MS = 20_000;
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_STORAGE_BYTES = 300 * 1024 * 1024;
/** One stored (sanitised) file, checked at redact time. */
export const MAX_STORED_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_CHARS = 20_000;
