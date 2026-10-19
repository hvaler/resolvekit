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
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Tests only: make the next durable write (to a file matching `match`, when given) fail at this step, then reset;
 * `readError`: the next {@link readStoreFile} of a matching file fails with this code (EBUSY…), then resets; `renameBusy`:
 * the next N renames fail with EBUSY (the retry is tested).
 */
export const durableTestHooks: { failAt: 'write' | 'fsync' | 'rename' | null; match?: RegExp | null; readError?: { match: RegExp; code: string } | null; renameBusy?: number } = { failAt: null, match: null, readError: null, renameBusy: 0 };

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

/** The temporary files {@link writeFileDurable} makes: `<file>.<pid>.<8 hex>.tmp`. */
export const DURABLE_TMP = /\.\d+\.[0-9a-f]{8}\.tmp$/;

/**
 * Remove leftovers of interrupted durable writes in `dir` (not recursive): only names matching {@link DURABLE_TMP} and
 * older than `olderThanMs` (a write in progress in another process is never touched). Returns how many went.
 */
export function sweepDurableTmp(dir: string, olderThanMs = 10 * 60_000, now = Date.now()): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const f of names) {
    if (!DURABLE_TMP.test(f)) continue;
    try {
      const p = join(dir, f);
      if (now - statSync(p).mtimeMs <= olderThanMs) continue;
      rmSync(p, { force: true });
      n++;
    } catch {
      /* gone meanwhile, or not removable now: the next start retries */
    }
  }
  return n;
}

/** What a store finds on disk: no file, its text, or a read error (EBUSY, EPERM, EMFILE…: not proof the file is bad). */
export type StoreRead = { kind: 'missing' } | { kind: 'text'; text: string } | { kind: 'error'; code: string };

/**
 * Read a store file. A read error is reported as such, never as "corrupt": a store must not move a good file aside
 * because it was busy for a moment (it is left in place and not written over; see {@link preserveCorrupt}).
 */
export function readStoreFile(file: string): StoreRead {
  const inj = durableTestHooks.readError;
  if (inj && inj.match.test(file)) {
    durableTestHooks.readError = null;
    return { kind: 'error', code: inj.code };
  }
  try {
    return { kind: 'text', text: readFileSync(file, 'utf8') };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
    return code === 'ENOENT' ? { kind: 'missing' } : { kind: 'error', code };
  }
}

/**
 * Open a JSON store file: `parse` turns its text into the value or throws on bad content. A missing file gives
 * `value: null`. Bad content is moved aside ({@link preserveCorrupt}) and the store starts empty; a read error, or a
 * move that fails, leaves the file in place and `blocked` (the store must not write over it). `problem` says why, with
 * `ifEmpty` (what starting empty means for this store) when the file was moved aside.
 */
export function openStoreFile<T>(file: string, parse: (text: string) => T, o: { ifEmpty: string; now?: Date }): { value: T | null; problem: string | null; blocked: boolean } {
  const name = basename(file);
  const read = readStoreFile(file);
  if (read.kind === 'missing') return { value: null, problem: null, blocked: false };
  if (read.kind === 'error') return { value: null, problem: `${name} could not be read (${read.code}); left in place and not written over`, blocked: true };
  try {
    return { value: parse(read.text), problem: null, blocked: false };
  } catch {
    const to = preserveCorrupt(file, o.now ?? new Date());
    return to
      ? { value: null, problem: `${name} could not be read; preserved as ${to}. ${o.ifEmpty}`, blocked: false }
      : { value: null, problem: `${name} could not be read and could not be moved aside; left in place and not written over`, blocked: true };
  }
}

/** Sleep synchronously (the stores' writes are synchronous). */
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** rename, retried briefly on EPERM/EBUSY (Windows: an antivirus or indexer holding the target): 3 tries, ~20 ms apart. */
function renameRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      if ((durableTestHooks.renameBusy ?? 0) > 0) {
        durableTestHooks.renameBusy! -= 1;
        throw Object.assign(new Error('injected busy rename'), { code: 'EBUSY' });
      }
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 3 || (code !== 'EPERM' && code !== 'EBUSY')) throw e;
      pause(20);
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
    renameRetry(tmp, file);
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

/**
 * Append `data` to `file` (created if missing, then its directory synced too) and fsync it before returning. A file that
 * does not end in a newline (a torn last line) gets one first, so the torn line cannot swallow this one. Throws on failure.
 */
export function appendFileDurable(file: string, data: string | Uint8Array): void {
  const created = !existsSync(file);
  const fd = openSync(file, 'a+');
  try {
    const size = created ? 0 : statSync(file).size;
    let torn = false;
    if (size > 0) {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      torn = last[0] !== 0x0a;
    }
    injected('write', file);
    if (torn) writeAll(fd, '\n');
    writeAll(fd, data);
    injected('fsync', file);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (created) fsyncDir(dirname(file));
}
