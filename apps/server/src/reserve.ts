/**
 * Where each case stands in its reserve (BINDINGS_JSON lists, see bindings.ts and app.ts `rotateIfUsed`), across
 * restarts: the disputes this server moved a case past because PayPal showed them used (seller evidence in, or
 * resolved). Persisted on the data dir (`reserve-position.json`, durable write) as `{ v: 1, used: { <case>: [ids] } }`.
 *
 * At start (and when the bindings file changes) {@link ReserveMemory.apply} drops those disputes from the front of each
 * case's configured list, so the case does not walk past them again (one read and one warm-up analysis each). The
 * configuration stays the source of truth: only a dispute that is still in the case's configured list and was seen used
 * for that same case is skipped, entries for other cases or disputes no longer configured are ignored, and the last
 * configured dispute is never skipped (a used last one stays active, as without this
 * file). A file that cannot be read is moved aside (`<file>.corrupt-<time>`) and reported; the case then walks its list
 * as before. A failed write keeps the position in memory (logged).
 */
import { mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { openStoreFile, writeFileDurable } from '@resolvekit/hosting';
import type { Binding, BindingPools } from './bindings.ts';

/** A case's reserve is short (a list in BINDINGS_JSON); this bounds what one case can hold in the file. */
const MAX_USED_PER_CASE = 200;

export class ReserveMemory {
  private used: Record<string, string[]> = {};
  private readonly file: string | null;
  private readonly log: (line: string) => void;
  private problem: string | null = null;
  private blocked = false;

  constructor(o: { file?: string | null; now?: () => Date; log?: (line: string) => void } = {}) {
    this.file = o.file ?? null;
    this.log = o.log ?? (() => {});
    if (!this.file) return;
    const opened = openStoreFile(
      this.file,
      (raw) => {
        const s = JSON.parse(raw) as { v?: unknown; used?: unknown };
        if (s?.v !== 1 || !s.used || typeof s.used !== 'object' || Array.isArray(s.used)) throw new Error('shape');
        const used: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(s.used)) {
          if (!Array.isArray(v) || !v.every((d) => typeof d === 'string')) throw new Error('shape');
          used[k] = v.slice(-MAX_USED_PER_CASE);
        }
        return used;
      },
      { ifEmpty: 'Each case starts again at the first dispute of its list', now: o.now?.() },
    );
    this.used = opened.value ?? {};
    this.blocked = opened.blocked;
    this.problem = opened.problem;
    if (this.problem) this.log(`ERROR reserve · ${this.problem}`);
  }

  /** The disputes this case was moved past (tests, logs). */
  usedOf(caseId: string): readonly string[] {
    return this.used[caseId] ?? [];
  }

  /** The case moved past `dispute` (app.ts rotation): remember it. */
  markUsed(caseId: string, dispute: string): void {
    const list = (this.used[caseId] ?? []).filter((d) => d !== dispute);
    list.push(dispute);
    this.used[caseId] = list.slice(-MAX_USED_PER_CASE);
    this.save();
  }

  /**
   * Move each case past the disputes remembered as used, in place: the active binding and the reserve are what the
   * configuration lists without them (never fewer than its last one). `held` (main.ts: the intent store's in-flight or
   * uncertain disputes) stops the walk at a dispute an action is still settling: it is never shifted past, whatever the
   * file says. Returns what was skipped, per case.
   */
  apply(pools: BindingPools, held?: (disputeId: string) => boolean): Array<{ caseId: string; skipped: string[]; active: string }> {
    const out: Array<{ caseId: string; skipped: string[]; active: string }> = [];
    for (const caseId of Object.keys(pools.bindings)) {
      const used = new Set(this.used[caseId] ?? []);
      if (!used.size) continue;
      const list: Binding[] = [pools.bindings[caseId]!, ...(pools.reserve[caseId] ?? [])];
      const skipped: string[] = [];
      while (list.length > 1 && used.has(list[0]!.dispute) && !held?.(list[0]!.dispute)) skipped.push(list.shift()!.dispute);
      if (!skipped.length) continue;
      (pools.bindings as Record<string, Binding>)[caseId] = list[0]!;
      pools.reserve[caseId] = list.slice(1);
      out.push({ caseId, skipped, active: list[0]!.dispute });
    }
    return out;
  }

  /** Why the saved position could not be read at start, or null. */
  storageProblem(): string | null {
    return this.problem;
  }

  private save() {
    if (!this.file || this.blocked) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileDurable(this.file, JSON.stringify({ v: 1, used: this.used }));
    } catch (e) {
      this.log(`reserve · cannot save ${basename(this.file)} · ${(e as NodeJS.ErrnoException).code ?? (e as Error).message} · position kept in memory only`);
    }
  }
}
