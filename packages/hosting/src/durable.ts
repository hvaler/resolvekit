/**
 * Durable file writes for the stores on the data dir (apps/server, packages/analyst): a crash or a power cut leaves the
 * old content or the new one, never half a file, and once the call returns the new content is on the disk.
 *
 * - {@link writeFileDurable}: temporary file in the same directory → write → fsync the file → rename over the target →
 *   best-effort fsync of the directory (so the rename itself survives a power cut). A failure at any step removes the
 *   temporary file and throws; the old file is untouched.
 * - {@link appendFileDurable}: append a line and fsync it (append-only logs whose lines must not be lost).
 * - {@link preserveCorrupt}: move a store file that cannot be read aside (`<file>.corrupt-<time>`) instead of letting
 *   the store treat it as empty and overwrite it.
 *
 * Temporary files end in `.tmp` (`<file>.<pid>.<random>.tmp`): the stores that sweep leftovers of interrupted writes
 * already remove `*.tmp` in their directories.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** Tests only: make the next durable write (to a file matching `match`, when given) fail at this step, then reset. */
export const durableTestHooks: { failAt: 'write' | 'fsync' | 'rename' | null; match?: RegExp | null } = { failAt: null, match: null };

function injected(step: 'write' | 'fsync' | 'rename', file: string): void {
  if (durableTestHooks.failAt !== step || (durableTestHooks.match && !durableTestHooks.match.test(file))) return;
  durableTestHooks.failAt = null;
  durableTestHooks.match = null;
  throw Object.assign(new Error(`injected ${step} failure`), { code: 'EIO' });
}

function writeAll(fd: number, data: string | Uint8Array): void {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
}

/**
 * fsync a directory so a rename in it is durable. Best effort: Windows cannot open a directory for fsync (EISDIR,
 * EPERM) and some file systems refuse it (EINVAL, ENOTSUP); the rename has already happened either way.
 */
export function fsyncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    /* best effort, see above */
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/** Replace `file` with `data` durably (see the module comment). The directory must exist. Throws on failure. */
export function writeFileDurable(file: string, data: string | Uint8Array, o: { mode?: number } = {}): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const fd = openSync(tmp, 'w', o.mode ?? 0o666);
    try {
      injected('write', file);
      writeAll(fd, data);
      injected('fsync', file);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    injected('rename', file);
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    throw e;
  }
  fsyncDir(dirname(file));
}

/**
 * Move a store file that exists but cannot be read aside, as `<file>.corrupt-<UTC time>`, so the store can start
 * empty and write a new one without destroying it (an operator can look at it, or put it back). Returns the new path,
 * or null when it could not be moved (the caller must then not overwrite it).
 */
export function preserveCorrupt(file: string, now: Date = new Date()): string | null {
  const to = `${file}.corrupt-${now.toISOString().replace(/:/g, '-')}`;
  try {
    injected('rename', file);
    renameSync(file, to);
  } catch {
    return null;
  }
  fsyncDir(dirname(file));
  return to;
}

/** Append `data` to `file` (created if missing, then its directory synced too) and fsync it before returning. Throws on failure. */
export function appendFileDurable(file: string, data: string | Uint8Array): void {
  const created = !existsSync(file);
  const fd = openSync(file, 'a');
  try {
    injected('write', file);
    writeAll(fd, data);
    injected('fsync', file);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (created) fsyncDir(dirname(file));
}
