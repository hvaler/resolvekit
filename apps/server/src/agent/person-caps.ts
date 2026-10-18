/**
 * Agent runs started per person per UTC day (hosted: 5), persisted next to the daily caps so a restart does not give
 * anyone a fresh allowance: `{ day, counts: { <person id>: n } }`, rewritten whole (tmp + rename) on every change.
 *
 * Fails closed like DailyCounters: a file that exists but cannot be read, or a count that cannot be saved, refuses the
 * run (`storage`) instead of counting it only in memory. `file: null` keeps the counts in memory (tests).
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type PersonTake = { ok: true; day: string } | { ok: false; reason: 'cap'; retryAfterSec: number } | { ok: false; reason: 'storage'; detail: string };

export class PersonRunCaps {
  readonly limit: number;
  private readonly file: string | null;
  private readonly now: () => Date;
  private day = '';
  private counts: Record<string, number> = {};
  private unreadable: string | null = null;

  constructor(o: { file: string | null; limit: number; now?: () => Date }) {
    this.file = o.file;
    this.limit = o.limit;
    this.now = o.now ?? (() => new Date());
    this.load();
  }

  /** Count one run for `personId` today, on disk before it is granted; refused at the limit or when it cannot be saved. */
  take(personId: string): PersonTake {
    if (this.unreadable) this.load();
    if (this.unreadable) return { ok: false, reason: 'storage', detail: this.unreadable };
    this.roll();
    const used = this.counts[personId] ?? 0;
    if (used >= this.limit) return { ok: false, reason: 'cap', retryAfterSec: this.untilTomorrowSec() };
    this.counts[personId] = used + 1;
    const saved = this.save();
    if (saved) {
      this.counts[personId] = used;
      return { ok: false, reason: 'storage', detail: saved };
    }
    return { ok: true, day: this.day };
  }

  /** Give back one run taken on `day` (it did not start). One from an earlier day is dropped: that day was reset. */
  release(personId: string, day: string): void {
    this.roll();
    if (day !== this.day || !this.counts[personId]) return;
    this.counts[personId] -= 1;
    if (!this.counts[personId]) delete this.counts[personId];
    this.save();
  }

  /** Runs `personId` started today. */
  used(personId: string): number {
    this.roll();
    return this.counts[personId] ?? 0;
  }

  private roll(): void {
    const today = this.now().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.counts = {};
    }
  }

  private untilTomorrowSec(): number {
    const next = new Date(`${this.day}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return Math.max(1, Math.ceil((next.getTime() - this.now().getTime()) / 1000));
  }

  private load(): void {
    if (!this.file) return;
    this.unreadable = null;
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.unreadable = `the agent-run caps file is unreadable (${(e as Error).message})`;
      return;
    }
    try {
      const saved = JSON.parse(text) as { day?: unknown; counts?: unknown };
      if (typeof saved.day !== 'string' || !saved.counts || typeof saved.counts !== 'object') throw new Error('shape');
      this.day = saved.day;
      this.counts = {};
      for (const [k, v] of Object.entries(saved.counts)) if (Number.isSafeInteger(v) && (v as number) > 0) this.counts[k] = v as number;
    } catch {
      this.unreadable = 'the agent-run caps file is unreadable (not JSON): fix or remove it';
    }
  }

  /** null when written (or in memory); else why not. Never overwrites an unreadable file. */
  private save(): string | null {
    if (!this.file) return null;
    const tmp = `${this.file}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(tmp, JSON.stringify({ day: this.day, counts: this.counts }));
      renameSync(tmp, this.file);
      return null;
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* nothing to clean */ }
      return `the agent-run caps cannot be saved (${(e as Error).message})`;
    }
  }
}
