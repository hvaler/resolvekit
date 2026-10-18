/**
 * The buying agent's runs as persisted state machines: one JSON file per run, `<dir>/<run id>.json`, rewritten
 * (tmp + rename, like uploads/store.ts) at every event of the run, so a restart finds each run as it last was.
 *
 * Memory is the latest state. A write that fails throws `RunStoreError` but keeps the new state in memory and the
 * run in `unsaved()`; `retryUnsaved()` writes it later (the service's reconcile sweep). `dir: null` keeps everything
 * in memory (tests). Ids are checked against `run-<32 hex>` before any path is built.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Outcome, Settlement, Step, StopReason } from '@resolvekit/agent';

export type RunState = 'running' | 'awaiting_approval' | Outcome;

export interface RunRecord {
  /** `run-<32 hex>`, also the run key MeterMCP binds the run's session to (x-agent-run). */
  id: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  by: { personId: string; label: string; workspaceId: string };
  goal: string;
  cap: string;
  failFirst: string[];
  state: RunState;
  stopReason: StopReason | null;
  answer: string | null;
  steps: Step[];
  approvalUrl: string | null;
  provider: string | null;
  model: string | null;
  usage: { modelCalls: number; inputTokens: number; outputTokens: number; reported: boolean };
  sessionId: string | null;
  orderId: string | null;
  captureId: string | null;
  /** Only ever written from a MeterMCP receipt that was read; `unverified` when it could not be. */
  settlement: Settlement;
  receiptSha256: string | null;
  /**
   * The amounts the read receipt's settlement states (Ruling A11): copied from it, never computed from the steps;
   * null when no receipt stated them, and cleared when the settlement becomes unverified.
   */
  captured: string | null;
  released: string | null;
  /** Kept by the owner: never swept. */
  kept: boolean;
}

export type NewRun = Omit<RunRecord, 'id' | 'createdAt' | 'updatedAt'>;

export const RUN_ID = /^run-[0-9a-f]{32}$/;
/** Unkept records older than this are deleted by `sweep()`. */
export const RUN_RETENTION_MS = 30 * 86_400_000;
/** Settlements the reconcile sweep may still change; a record holding one (with a session) is never swept. */
export const UNSETTLED: ReadonlySet<Settlement> = new Set(['open', 'capture_pending', 'failed', 'unverified']);

export class RunStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RunStoreError';
  }
}

/** Write `data` to `file` so a reader sees the old or the new content, never half of it. */
function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
}

export class RunStore {
  private readonly dir: string | null;
  private readonly now: () => Date;
  private readonly write: (file: string, data: string) => void;
  private readonly records = new Map<string, RunRecord>();
  private readonly pending = new Set<string>();

  /** `write`: the file writer (tests inject a failing one); defaults to tmp + rename. */
  constructor(o: { dir: string | null; now?: () => Date; write?: (file: string, data: string) => void }) {
    this.dir = o.dir;
    this.now = o.now ?? (() => new Date());
    this.write = o.write ?? atomicWrite;
    if (this.dir) this.load(this.dir);
  }

  /** A new record, written before it is returned; nothing is kept when that write fails. */
  create(r: NewRun): RunRecord {
    const at = this.now().toISOString();
    const rec: RunRecord = { ...structuredClone(r), id: `run-${randomBytes(16).toString('hex')}`, createdAt: at, updatedAt: at };
    this.persist(rec);
    this.records.set(rec.id, rec);
    return structuredClone(rec);
  }

  /** Merge `patch` (id and createdAt stay). The new state is kept in memory even when the write throws. */
  update(id: string, patch: Partial<RunRecord>): RunRecord {
    const cur = this.live(id);
    const { id: _id, createdAt: _c, ...rest } = structuredClone(patch);
    const rec: RunRecord = { ...cur, ...rest, updatedAt: this.now().toISOString() };
    this.records.set(id, rec);
    this.save(rec);
    return structuredClone(rec);
  }

  get(id: string): RunRecord | null {
    const r = RUN_ID.test(id) ? this.records.get(id) : undefined;
    return r ? structuredClone(r) : null;
  }

  /** Newest first. A person's runs, or a workspace's only when asked for explicitly; both narrow together. */
  list(filter: { personId?: string; workspaceId?: string }): RunRecord[] {
    if (!filter.personId && !filter.workspaceId) throw new Error('RunStore.list needs a personId or workspaceId');
    return [...this.records.values()]
      .filter((r) => (!filter.personId || r.by.personId === filter.personId) && (!filter.workspaceId || r.by.workspaceId === filter.workspaceId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .map((r) => structuredClone(r));
  }

  /** Every record, for recovery and the reconcile sweep (not for routes). */
  all(): RunRecord[] {
    return [...this.records.values()].map((r) => structuredClone(r));
  }

  bySession(sessionId: string): RunRecord | null {
    const r = [...this.records.values()].find((x) => x.sessionId === sessionId);
    return r ? structuredClone(r) : null;
  }

  byCapture(captureId: string): RunRecord | null {
    const r = [...this.records.values()].find((x) => x.captureId === captureId);
    return r ? structuredClone(r) : null;
  }

  /** Runs whose latest state is only in memory (a write failed). */
  unsaved(): string[] {
    return [...this.pending];
  }

  /** Write the unsaved runs again; the ids written. A run still failing stays unsaved. */
  retryUnsaved(): string[] {
    const written: string[] = [];
    for (const id of [...this.pending]) {
      try {
        this.save(this.records.get(id)!);
        written.push(id);
      } catch {
        /* still unsaved; the next sweep tries again */
      }
    }
    return written;
  }

  /**
   * Delete unkept records created more than 30 days ago; the ids deleted. Never a run still going, one whose
   * settlement is not final (the state reconcile works from), one whose latest state is not written yet, or one whose
   * capture is bound now (`boundCaptures`: every case's active and reserve captures, upper case; Ruling A13), since
   * the agent case shows that run's record.
   */
  sweep(boundCaptures: ReadonlySet<string> = new Set()): string[] {
    const before = new Date(this.now().getTime() - RUN_RETENTION_MS).toISOString();
    const gone: string[] = [];
    for (const r of this.records.values()) {
      if (r.kept || r.createdAt >= before || r.state === 'running' || r.state === 'awaiting_approval') continue;
      if (r.captureId && boundCaptures.has(r.captureId.toUpperCase())) continue;
      if ((r.sessionId && UNSETTLED.has(r.settlement)) || this.pending.has(r.id)) continue;
      if (this.dir) {
        try {
          unlinkSync(join(this.dir, `${r.id}.json`));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') continue;
        }
      }
      this.records.delete(r.id);
      gone.push(r.id);
    }
    return gone;
  }

  private live(id: string): RunRecord {
    if (!RUN_ID.test(id)) throw new RunStoreError('invalid run id');
    const r = this.records.get(id);
    if (!r) throw new RunStoreError(`unknown run ${id}`);
    return r;
  }

  private persist(r: RunRecord): void {
    if (!this.dir) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      this.write(join(this.dir, `${r.id}.json`), JSON.stringify(r, null, 2));
    } catch (e) {
      throw new RunStoreError(`run ${r.id} could not be saved: ${(e as Error).message}`, { cause: e });
    }
  }

  private save(r: RunRecord): void {
    try {
      this.persist(r);
    } catch (e) {
      this.pending.add(r.id);
      throw e;
    }
    this.pending.delete(r.id);
  }

  private load(dir: string): void {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return; // no runs yet
    }
    for (const name of names) {
      if (name.endsWith('.tmp')) {
        try { unlinkSync(join(dir, name)); } catch { /* left for the next start */ }
        continue;
      }
      const id = name.replace(/\.json$/, '');
      if (!RUN_ID.test(id) || name !== `${id}.json`) continue;
      try {
        const r = JSON.parse(readFileSync(join(dir, name), 'utf8')) as RunRecord;
        // A record from before the amounts existed has none (null): unknown, not zero.
        if (r?.id === id && Array.isArray(r.steps) && r.by) this.records.set(id, { ...r, captured: r.captured ?? null, released: r.released ?? null });
      } catch {
        /* unreadable: left on disk, not served */
      }
    }
  }
}
