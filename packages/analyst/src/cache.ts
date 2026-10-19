/**
 * Server-side store of analyses by key: the local cache of live runs (git-ignored) first, then the committed golden
 * analyses (packages/analyst/golden, made by the real model for the demo cases). Node only.
 *
 * The cache is bounded ({@link FileAnalysisStore.sweep}, run by the server at start and hourly): an analysis not used
 * (written or read) for {@link CACHE_MAX_AGE_MS} goes, and past {@link CACHE_MAX_BYTES} in all the least recently used
 * go first. A swept analysis is only a cache entry: the next view of its documents runs the model again (within the
 * caps). Golden analyses are never swept.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileDurable } from '@resolvekit/hosting';
import type { CaseAnalysis } from './types.ts';

/** An analysis not written or read for this long is swept (default; ANALYSIS_CACHE_MAX_DAYS on the server). */
export const CACHE_MAX_AGE_MS = 30 * 86_400_000;
/** The cache's total size; past it the least recently used go first (default; ANALYSIS_CACHE_MAX_MB on the server). */
export const CACHE_MAX_BYTES = 100 * 1024 * 1024;
/** A read marks the file used (its modification time) at most this often. */
const TOUCH_EVERY_MS = 86_400_000;

export const GOLDEN_DIR = fileURLToPath(new URL('../golden/', import.meta.url));

export type AnalysisOrigin = 'golden' | 'cache' | 'live';

export interface AnalysisStore {
  get(key: string): { analysis: CaseAnalysis; origin: Exclude<AnalysisOrigin, 'live'> } | null;
  put(a: CaseAnalysis): void;
  /** Forget a live/cached analysis (the golden ones are committed and stay). */
  delete(key: string): void;
}

const isKey = (k: string) => /^[0-9a-f]{64}$/.test(k);

function readJson(file: string): CaseAnalysis | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as CaseAnalysis;
  } catch {
    return null;
  }
}

/** Golden analyses by key (read once). */
export function loadGolden(dir = GOLDEN_DIR): Map<string, CaseAnalysis> {
  const out = new Map<string, CaseAnalysis>();
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const f of files) {
    const a = readJson(join(dir, f));
    if (a && isKey(a.key)) out.set(a.key, a);
  }
  return out;
}

export class FileAnalysisStore implements AnalysisStore {
  private readonly dir: string;
  private readonly golden: Map<string, CaseAnalysis>;
  private readonly memory = new Map<string, CaseAnalysis>();
  /** When each key was last marked used on disk (reads touch the file at most once per {@link TOUCH_EVERY_MS}). */
  private readonly touched = new Map<string, number>();
  private readonly maxAgeMs: number;
  private readonly maxBytes: number;
  private readonly now: () => Date;
  constructor(o: { dir: string; goldenDir?: string; golden?: Map<string, CaseAnalysis>; maxAgeMs?: number; maxBytes?: number; now?: () => Date }) {
    this.dir = o.dir;
    this.golden = o.golden ?? loadGolden(o.goldenDir);
    this.maxAgeMs = o.maxAgeMs ?? CACHE_MAX_AGE_MS;
    this.maxBytes = o.maxBytes ?? CACHE_MAX_BYTES;
    this.now = o.now ?? (() => new Date());
    // A crash between write and rename leaves a temporary file: it may hold an analysis nothing refers to.
    try {
      for (const f of readdirSync(this.dir)) if (f.endsWith('.tmp')) rmSync(join(this.dir, f), { force: true });
    } catch {
      /* no directory yet */
    }
  }
  /** The latest live run of these documents wins over the committed golden one. */
  get(key: string) {
    if (!isKey(key)) return null;
    const m = this.memory.get(key) ?? readJson(join(this.dir, `${key}.json`));
    if (m) {
      this.memory.set(key, m);
      this.markUsed(key);
      return { analysis: m, origin: 'cache' as const };
    }
    const g = this.golden.get(key);
    return g ? { analysis: g, origin: 'golden' as const } : null;
  }
  put(a: CaseAnalysis) {
    if (!isKey(a.key)) return;
    this.memory.set(a.key, a);
    mkdirSync(this.dir, { recursive: true });
    // Durable write (tmp, fsync, rename): a reader (or a crash) never meets half a file
    writeFileDurable(join(this.dir, `${a.key}.json`), JSON.stringify(a, null, 2));
    this.touched.set(a.key, this.now().getTime());
  }
  /** Remove the live copy (memory and file). Throws if the file cannot be removed: deleting must not look done when it is not. */
  delete(key: string) {
    if (!isKey(key)) return;
    this.memory.delete(key);
    this.touched.delete(key);
    rmSync(join(this.dir, `${key}.json`), { force: true });
  }

  /** The file's modification time is when it was last used: written, or read (at most once a day). Best effort. */
  private markUsed(key: string) {
    const t = this.now().getTime();
    if (t - (this.touched.get(key) ?? -Infinity) < TOUCH_EVERY_MS) return;
    this.touched.set(key, t);
    try {
      utimesSync(join(this.dir, `${key}.json`), new Date(t), new Date(t));
    } catch {
      /* only in memory, or gone */
    }
  }

  /**
   * Remove the analyses unused for longer than the age limit, then the least recently used until the cache fits its
   * size limit (memory and file). Only `<64 hex>.json` files are considered. Returns what was removed.
   */
  sweep(): { removed: number; bytes: number } {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return { removed: 0, bytes: 0 };
    }
    const files: Array<{ key: string; usedAt: number; size: number }> = [];
    for (const n of names) {
      const k = n.endsWith('.json') ? n.slice(0, -5) : '';
      if (!isKey(k)) continue;
      try {
        const st = statSync(join(this.dir, n));
        files.push({ key: k, usedAt: st.mtimeMs, size: st.size });
      } catch {
        /* gone meanwhile */
      }
    }
    files.sort((x, y) => x.usedAt - y.usedAt);
    const cutoff = this.now().getTime() - this.maxAgeMs;
    let total = files.reduce((n, f) => n + f.size, 0);
    let removed = 0;
    let bytes = 0;
    for (const f of files) {
      if (f.usedAt >= cutoff && total <= this.maxBytes) break;
      try {
        this.delete(f.key);
      } catch {
        continue;
      }
      total -= f.size;
      bytes += f.size;
      removed++;
    }
    return { removed, bytes };
  }
}

export class MemoryAnalysisStore implements AnalysisStore {
  readonly golden = new Map<string, CaseAnalysis>();
  readonly cached = new Map<string, CaseAnalysis>();
  get(key: string) {
    const c = this.cached.get(key);
    if (c) return { analysis: c, origin: 'cache' as const };
    const g = this.golden.get(key);
    return g ? { analysis: g, origin: 'golden' as const } : null;
  }
  put(a: CaseAnalysis) {
    this.cached.set(a.key, a);
  }
  delete(key: string) {
    this.cached.delete(key);
  }
}
