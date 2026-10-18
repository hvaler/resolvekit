/**
 * Which PayPal merchant is the seller of each bound dispute (hosted mode). A sandbox that cannot be read right now
 * must not demote the seller's workspace, so a seller confirmed by a read is remembered (on the data dir) for the
 * binding it was confirmed on: the case and the dispute id. A changed binding never inherits it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** How a workspace relates to the bound disputes: the evaluation seller, a verified other account, or not known yet. */
export type Connection = 'evaluation' | 'not_connected' | 'checking';

/** A seller as read on one binding. */
export interface SellerEntry {
  caseId: string;
  dispute: string;
  merchant: string;
}

const isEntry = (e: unknown): e is SellerEntry => {
  const x = e as Record<string, unknown> | null;
  return !!x && typeof x.caseId === 'string' && typeof x.dispute === 'string' && typeof x.merchant === 'string';
};

export class SellerMemory {
  private entries: SellerEntry[] = [];
  private readonly file: string | null;
  private readonly log: ((line: string) => void) | undefined;

  /**
   * `file: null` keeps the memory in this process. A missing file is empty; one that exists but cannot be read as
   * entries stops the start (like the accounts file).
   */
  constructor(o: { file: string | null; log?: (line: string) => void }) {
    this.file = o.file;
    this.log = o.log;
    if (!o.file) return;
    let raw: string;
    try {
      raw = readFileSync(o.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    const s = JSON.parse(raw) as { entries?: unknown };
    if (!Array.isArray(s.entries) || !s.entries.every(isEntry)) throw new Error('not a list of seller entries');
    this.entries = s.entries.map((e) => ({ caseId: e.caseId, dispute: e.dispute, merchant: e.merchant }));
  }

  /** The sellers confirmed on a binding, from now or an earlier run. */
  remembered(): readonly SellerEntry[] {
    return this.entries;
  }

  /**
   * Replace what is remembered with the sellers of the current bindings (a complete read): entries of cases no longer
   * bound, or bound to another dispute, are dropped. A failed write keeps the value in memory and is logged.
   */
  confirm(current: readonly SellerEntry[]): void {
    if (current.length === 0) return;
    const same = current.length === this.entries.length && current.every((c) => this.entries.some((e) => e.caseId === c.caseId && e.dispute === c.dispute && e.merchant === c.merchant));
    if (same) return;
    this.entries = current.map((c) => ({ caseId: c.caseId, dispute: c.dispute, merchant: c.merchant }));
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ entries: this.entries }));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (e) {
      this.log?.(`sellers · cannot save ${this.file} · ${(e as Error).message} · kept in memory only`);
    }
  }
}
