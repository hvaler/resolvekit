/**
 * Server-side store of analyses by key: the local cache of live runs (git-ignored) first, then the committed golden
 * analyses (packages/analyst/golden, made by the real model for the demo cases). Node only.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CaseAnalysis } from './types.ts';

export const GOLDEN_DIR = fileURLToPath(new URL('../golden/', import.meta.url));

export type AnalysisOrigin = 'golden' | 'cache' | 'live';

export interface AnalysisStore {
  get(key: string): { analysis: CaseAnalysis; origin: Exclude<AnalysisOrigin, 'live'> } | null;
  put(a: CaseAnalysis): void;
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
  constructor(o: { dir: string; goldenDir?: string; golden?: Map<string, CaseAnalysis> }) {
    this.dir = o.dir;
    this.golden = o.golden ?? loadGolden(o.goldenDir);
  }
  /** The latest live run of these documents wins over the committed golden one. */
  get(key: string) {
    if (!isKey(key)) return null;
    const m = this.memory.get(key) ?? readJson(join(this.dir, `${key}.json`));
    if (m) {
      this.memory.set(key, m);
      return { analysis: m, origin: 'cache' as const };
    }
    const g = this.golden.get(key);
    return g ? { analysis: g, origin: 'golden' as const } : null;
  }
  put(a: CaseAnalysis) {
    if (!isKey(a.key)) return;
    this.memory.set(a.key, a);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${a.key}.json`), JSON.stringify(a, null, 2));
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
}
