/**
 * Which PayPal merchant ids have been seen as the seller of a bound dispute (hosted mode). A sandbox that cannot be
 * read right now must not demote the seller's workspace, so confirmed sellers are remembered (on the data dir).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** How a workspace relates to the bound disputes: the evaluation seller, a verified other account, or not known yet. */
export type Connection = 'evaluation' | 'not_connected' | 'checking';

export class SellerMemory {
  private ids = new Set<string>();
  private readonly file: string | null;

  /** `file: null` keeps the memory in this process. An existing file that cannot be read stops the start. */
  constructor(o: { file: string | null }) {
    this.file = o.file;
    if (!o.file) return;
    let raw: string | null = null;
    try {
      raw = readFileSync(o.file, 'utf8');
    } catch {
      /* nothing remembered yet */
    }
    if (raw != null) {
      const s = JSON.parse(raw) as { sellers?: unknown };
      if (!Array.isArray(s.sellers) || !s.sellers.every((x) => typeof x === 'string')) throw new Error('not a list of seller ids');
      this.ids = new Set(s.sellers as string[]);
    }
  }

  /** The merchant ids confirmed as seller by a complete read, from now or an earlier run. */
  remembered(): ReadonlySet<string> {
    return this.ids;
  }

  /** Remember ids from a complete read of the bound disputes (a failed write keeps them in memory only). */
  confirm(ids: ReadonlySet<string>): void {
    const before = this.ids.size;
    for (const id of ids) this.ids.add(id);
    if (this.ids.size === before || !this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ sellers: [...this.ids] }));
      renameSync(`${this.file}.tmp`, this.file);
    } catch {
      /* kept in memory; written with the next new confirmation */
    }
  }
}
