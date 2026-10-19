/**
 * The analyst's usage log, `<data>/analyst-usage.jsonl`: one line per model call (stage, provider, model, token counts,
 * milliseconds; never prompt or document text). Appending is best effort.
 *
 * Bounded so it cannot fill the 1 GB disk: {@link UsageLog.sweep} (at start and hourly, main.ts) drops lines older than
 * {@link USAGE_MAX_AGE_MS} and then the oldest until the file fits {@link USAGE_MAX_BYTES}, rewriting it durably. It is
 * operational history, not an audit record: the audit log, the send log and MeterMCP's ledger are never expired.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeFileDurable } from '@resolvekit/hosting';

/** Default age limit (ANALYST_USAGE_MAX_DAYS). */
export const USAGE_MAX_AGE_MS = 90 * 86_400_000;
/** Default size limit (ANALYST_USAGE_MAX_MB). */
export const USAGE_MAX_BYTES = 10 * 1024 * 1024;

export class UsageLog {
  private readonly file: string;
  private readonly maxAgeMs: number;
  private readonly maxBytes: number;
  private readonly now: () => Date;

  constructor(o: { file: string; maxAgeMs?: number; maxBytes?: number; now?: () => Date }) {
    this.file = o.file;
    this.maxAgeMs = o.maxAgeMs ?? USAGE_MAX_AGE_MS;
    this.maxBytes = o.maxBytes ?? USAGE_MAX_BYTES;
    this.now = o.now ?? (() => new Date());
  }

  /** One line, stamped now. Best effort: a failed write is ignored (usage history only). */
  append(entry: Record<string, unknown>): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify({ at: this.now().toISOString(), ...entry }) + '\n');
    } catch {
      /* the usage log is best effort */
    }
  }

  /** Drop what is too old, then the oldest until it fits; lines that cannot be read or have no time go too. */
  sweep(): { dropped: number } {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      return { dropped: 0 };
    }
    const all = text.split('\n').filter(Boolean);
    const cutoff = this.now().getTime() - this.maxAgeMs;
    const fresh = all.filter((l) => {
      try {
        const at = Date.parse((JSON.parse(l) as { at?: string }).at ?? '');
        return Number.isFinite(at) && at >= cutoff;
      } catch {
        return false;
      }
    });
    let bytes = 0;
    let from = fresh.length;
    while (from > 0 && bytes + Buffer.byteLength(fresh[from - 1]!) + 1 <= this.maxBytes) bytes += Buffer.byteLength(fresh[--from]!) + 1;
    const kept = fresh.slice(from);
    const dropped = all.length - kept.length;
    // A torn last line (no newline) is dropped with the rest: rewrite whenever anything changes.
    if (dropped === 0 && text.endsWith('\n')) return { dropped: 0 };
    writeFileDurable(this.file, kept.map((l) => l + '\n').join(''));
    return { dropped };
  }
}
