/**
 * The verifier's verdicts on edited sentences (POST /api/cases/:id/analysis/verify): only an edit with one of these can
 * go into an intent (app.ts `compose`). Kept by analysis key and the SHA-256 of the edited text, never the text itself.
 *
 * Persisted on the data dir when given a file (`recheck-verdicts.json`, durable write), so a restart does not undo a
 * re-check the merchant already made: the web app keeps showing the edit as re-checked (its draft is in the browser),
 * and without the verdict the server would refuse to compose it until the merchant re-checked it again (one more model
 * call, within the daily re-check cap). Bounded to {@link MAX_VERDICTS}, the oldest first. A file that exists but
 * cannot be read is moved aside (`<file>.corrupt-<time>`) and reported, never overwritten. A failed write keeps the
 * verdict in memory (best effort, logged).
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { openStoreFile, writeFileDurable } from '@resolvekit/hosting';
import type { Recheck } from '../../web/src/domain/draft.ts';

export const MAX_VERDICTS = 2000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const isRecheck = (r: unknown): r is Recheck => {
  const x = r as Record<string, unknown> | null;
  return !!x && (x.state === 'supported' || x.state === 'needs_review' || x.state === 'rejected') && typeof x.note === 'string';
};

export class RecheckVerdicts {
  /** `${analysisKey}\n${sha256(text)}` → verdict, oldest first. */
  private readonly verdicts = new Map<string, Recheck>();
  private readonly file: string | null;
  private readonly max: number;
  private readonly log: (line: string) => void;
  private problem: string | null = null;
  private blocked = false;

  constructor(o: { file?: string | null; max?: number; now?: () => Date; log?: (line: string) => void } = {}) {
    this.file = o.file ?? null;
    this.max = o.max ?? MAX_VERDICTS;
    this.log = o.log ?? (() => {});
    if (!this.file) return;
    const opened = openStoreFile(
      this.file,
      (raw) => {
        const saved = JSON.parse(raw) as { v?: unknown; verdicts?: unknown };
        if (saved?.v !== 1 || !Array.isArray(saved.verdicts)) throw new Error('not verdicts');
        for (const e of saved.verdicts as Array<[unknown, unknown]>) {
          if (!Array.isArray(e) || typeof e[0] !== 'string' || !isRecheck(e[1])) throw new Error('not a verdict');
        }
        return saved.verdicts as Array<[string, Recheck]>;
      },
      { ifEmpty: 'Edits re-checked before need a new re-check', now: o.now?.() },
    );
    for (const [k, r] of opened.value ?? []) this.verdicts.set(k, r);
    this.blocked = opened.blocked;
    this.problem = opened.problem;
    if (this.problem) this.log(`ERROR re-check verdicts · ${this.problem}`);
  }

  private static key(analysisKey: string, text: string) {
    return `${analysisKey}\n${sha256(text)}`;
  }

  get(analysisKey: string, text: string): Recheck | undefined {
    return this.verdicts.get(RecheckVerdicts.key(analysisKey, text));
  }

  set(analysisKey: string, text: string, r: Recheck): void {
    const k = RecheckVerdicts.key(analysisKey, text);
    this.verdicts.delete(k);
    this.verdicts.set(k, r);
    if (this.verdicts.size > this.max) this.verdicts.delete(this.verdicts.keys().next().value!);
    this.save();
  }

  /** Forget every verdict on these analyses (an upload they quoted was deleted). */
  forget(analysisKeys: readonly string[]): void {
    let changed = false;
    for (const k of [...this.verdicts.keys()]) {
      if (analysisKeys.some((key) => k.startsWith(`${key}\n`))) {
        this.verdicts.delete(k);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  size(): number {
    return this.verdicts.size;
  }

  /** Why the saved verdicts could not be read at start, or null. */
  storageProblem(): string | null {
    return this.problem;
  }

  private save() {
    if (!this.file || this.blocked) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileDurable(this.file, JSON.stringify({ v: 1, verdicts: [...this.verdicts] }));
    } catch (e) {
      this.log(`re-check verdicts · cannot save ${basename(this.file)} · ${(e as NodeJS.ErrnoException).code ?? (e as Error).message} · kept in memory only`);
    }
  }
}
