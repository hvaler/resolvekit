/** Limits for merchant evidence uploads, in one place. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_SIDE = 4096;
export const MAX_PIXELS = 16 * 1024 * 1024;
export const MAX_UPLOADS_PER_CASE = 10;
/** Daily cap key `upload`. */
export const DAILY_UPLOADS = 40;
export const OCR_TIMEOUT_MS = 20_000;
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_STORAGE_BYTES = 300 * 1024 * 1024;
export const MAX_TEXT_CHARS = 20_000;
