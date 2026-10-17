/**
 * Store of merchant evidence uploads, one directory per upload:
 * `<dir>/<workspaceId>/<uploadId>/{record.json, original.bin, sanitised.png|pdf}`.
 *
 * The original exists only while the upload is pending or reviewing. Writes are synchronous tmp + rename like
 * `AccountStore.commit`, the record is written last, and a failure throws `UploadError('STORAGE')` after undoing what
 * it had written. `dir: null` keeps everything in memory (tests). Nothing here logs bytes or text.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UploadError, type Rect } from './image.ts';
import { PENDING_TTL_MS } from './limits.ts';
import type { TextRemoval } from './text.ts';

export type UploadStatus = 'pending' | 'reviewing' | 'confirmed' | 'discarded' | 'deleted' | 'archived';

export interface UploadRecord {
  /** `upl-<24 hex>` */
  id: string;
  workspaceId: string;
  caseId: string;
  boundDisputeId: string | null;
  /** E7… id, set at confirmation */
  evidenceId: string | null;
  kind: 'image' | 'text';
  name: string;
  uploadedBy: { id: string; label: string; name: string };
  status: UploadStatus;
  rects: Rect[];
  removals: TextRemoval[];
  /** re-read from the sanitised file */
  readLines: string[];
  lines: { text: string; correctedBy: string | null; original: string | null }[];
  /** of the stored sanitised file */
  sha256: string | null;
  size: number | null;
  mime: 'image/png' | 'application/pdf' | null;
  createdAt: string;
  expiresAt: string;
  confirmedAt: string | null;
  analysisKeys: string[];
}

/** What the caller knows when an upload starts; the store fills in the rest. */
export type NewUpload = Pick<UploadRecord, 'workspaceId' | 'caseId' | 'boundDisputeId' | 'kind' | 'name' | 'uploadedBy'>;

const ID = /^upl-[0-9a-f]{24}$/;
const WORKSPACE = /^[A-Za-z0-9_-]{1,64}$/;
const LIVE: UploadStatus[] = ['pending', 'reviewing'];
const DEAD: UploadStatus[] = ['discarded', 'deleted'];
const FILES = ['original.bin', 'sanitised.png', 'sanitised.pdf'];

/** Fields an update can never change: who the upload is and what it is bound to. */
type Pinned = 'id' | 'workspaceId' | 'caseId' | 'boundDisputeId' | 'kind' | 'uploadedBy';
export type UploadPatch = Partial<Omit<UploadRecord, Pinned>>;
const PINNED: string[] = ['id', 'workspaceId', 'caseId', 'boundDisputeId', 'kind', 'uploadedBy'];

/** A discarded or deleted upload keeps its record for the audit but none of its content. */
const purged = (r: UploadRecord): UploadRecord => ({ ...r, rects: [], removals: [], readLines: [], lines: [] });

const storage = (what: string, cause?: unknown) => new UploadError('STORAGE', `Upload storage failed: ${what}`, { cause });

export class UploadStore {
  private readonly dir: string | null;
  private readonly now: () => Date;
  private readonly records = new Map<string, UploadRecord>();
  private readonly mem = new Map<string, Uint8Array>();

  constructor(o: { dir: string | null; now?: () => Date }) {
    this.dir = o.dir;
    this.now = o.now ?? (() => new Date());
    if (this.dir) this.load();
  }

  create(r: NewUpload, original: Uint8Array): UploadRecord {
    if (!WORKSPACE.test(r.workspaceId)) throw storage('invalid workspace id');
    const now = this.now();
    const rec: UploadRecord = {
      ...structuredClone(r),
      id: `upl-${randomBytes(12).toString('hex')}`,
      evidenceId: null,
      status: 'pending',
      rects: [], removals: [], readLines: [], lines: [],
      sha256: null, size: null, mime: null,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + PENDING_TTL_MS).toISOString(),
      confirmedAt: null,
      analysisKeys: [],
    };
    try {
      this.writeFile(rec, 'original.bin', original);
      this.writeRecord(rec);
    } catch (e) {
      this.dropFiles(rec, true);
      throw e instanceof UploadError ? e : storage('create', e);
    }
    this.records.set(rec.id, rec);
    return structuredClone(rec);
  }

  get(id: string): UploadRecord | null {
    const r = ID.test(id) ? this.records.get(id) : undefined;
    return r ? structuredClone(r) : null;
  }

  list(q: { workspaceId: string; caseId: string; boundDisputeId: string | null; statuses?: UploadStatus[] }): UploadRecord[] {
    return [...this.records.values()]
      .filter((r) => r.workspaceId === q.workspaceId && r.caseId === q.caseId && r.boundDisputeId === q.boundDisputeId && (!q.statuses || q.statuses.includes(r.status)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((r) => structuredClone(r));
  }

  original(id: string): Uint8Array | null {
    const r = this.live(id);
    return r ? this.readFile(r, 'original.bin') : null;
  }

  sanitised(id: string): Uint8Array | null {
    const r = this.live(id);
    return r?.mime ? this.readFile(r, this.sanitisedName(r.mime)) : null;
  }

  /** Merge `patch` into the record; `files.original: null` deletes the original, `files.sanitised` is stored per `mime`. */
  update(id: string, patch: UploadPatch, files: { original?: Uint8Array | null; sanitised?: Uint8Array | null } = {}): UploadRecord {
    const cur = this.live(id);
    if (!cur) throw new UploadError('NOT_FOUND', 'Upload not found');
    const clean = Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== undefined && !PINNED.includes(k)));
    let next: UploadRecord = { ...cur, ...structuredClone(clean) };
    const dead = DEAD.includes(next.status);
    if (dead) next = purged(next);
    let restore: (() => void) | null = null;
    try {
      if (files.sanitised && !dead) {
        if (!next.mime) throw storage('sanitised file without a mime type');
        const name = this.sanitisedName(next.mime);
        const before = this.readFile(next, name);
        this.writeFile(next, name, files.sanitised);
        restore = () => (before ? this.writeFile(next, name, before) : this.removeFile(next, name));
      }
      this.writeRecord(next);
    } catch (e) {
      try { restore?.(); } catch { /* best effort: the record is unchanged either way */ }
      throw e instanceof UploadError ? e : storage('update', e);
    }
    this.records.set(next.id, next);
    if (dead) this.dropFiles(next, false);
    else if (files.original === null) this.removeFile(next, 'original.bin');
    else if (files.original) this.writeFile(next, 'original.bin', files.original);
    return structuredClone(next);
  }

  /** Archive every pending, reviewing or confirmed upload of the case and dispute; returns how many moved. */
  archiveCase(caseId: string, boundDisputeId: string | null): number {
    let n = 0;
    for (const r of [...this.records.values()]) {
      if (r.caseId !== caseId || r.boundDisputeId !== boundDisputeId) continue;
      if (r.status !== 'pending' && r.status !== 'reviewing' && r.status !== 'confirmed') continue;
      this.update(r.id, { status: 'archived' }, { original: null });
      n++;
    }
    return n;
  }

  /** Remember that these uploads fed the analysis with `key`. */
  noteAnalysisKey(ids: string[], key: string): void {
    for (const id of ids) {
      const r = this.records.get(id);
      if (r && !r.analysisKeys.includes(key)) this.update(id, { analysisKeys: [...r.analysisKeys, key] });
    }
  }

  /** Discard expired pending/reviewing uploads (record kept), and remove directories and files nothing refers to. */
  sweep(): { expired: number; orphans: number } {
    const nowIso = this.now().toISOString();
    let expired = 0, orphans = 0;
    for (const r of [...this.records.values()]) {
      if (LIVE.includes(r.status) && r.expiresAt <= nowIso) {
        const d = purged({ ...r, status: 'discarded' });
        this.records.set(r.id, d);
        try { this.writeRecord(d); } catch { /* the in-memory state is already discarded; the next sweep retries */ }
        this.dropFiles(d, false);
        expired++;
      } else if (DEAD.includes(r.status)) {
        const leftover = FILES.some((f) => this.sizeOf(r, f) > 0 || this.readFile(r, f));
        const text = r.lines.length + r.readLines.length + r.removals.length + r.rects.length > 0;
        if (leftover || text) {
          const d = purged(r);
          this.records.set(r.id, d);
          try { this.writeRecord(d); } catch { /* retried next sweep */ }
          this.dropFiles(d, false);
          orphans++;
        }
      } else if (!LIVE.includes(r.status) && this.readFile(r, 'original.bin')) {
        this.removeFile(r, 'original.bin');
        orphans++;
      }
    }
    if (this.dir) orphans += this.sweepDisk();
    return { expired, orphans };
  }

  usedBytes(): number {
    let n = 0;
    for (const r of this.records.values()) {
      for (const name of FILES) n += this.sizeOf(r, name);
    }
    return n;
  }

  // -- internals --------------------------------------------------------------------------------------------

  private live(id: string): UploadRecord | null {
    return ID.test(id) ? this.records.get(id) ?? null : null;
  }

  private sanitisedName(mime: 'image/png' | 'application/pdf'): string {
    return mime === 'application/pdf' ? 'sanitised.pdf' : 'sanitised.png';
  }

  private path(r: Pick<UploadRecord, 'id' | 'workspaceId'>, name?: string): string {
    if (!this.dir || !ID.test(r.id) || !WORKSPACE.test(r.workspaceId)) throw storage('invalid id');
    return name ? join(this.dir, r.workspaceId, r.id, name) : join(this.dir, r.workspaceId, r.id);
  }

  private memKey = (r: Pick<UploadRecord, 'id'>, name: string) => `${r.id}/${name}`;

  private writeFile(r: UploadRecord, name: string, bytes: Uint8Array): void {
    if (!this.dir) { this.mem.set(this.memKey(r, name), bytes.slice()); return; }
    this.atomicWrite(r, name, bytes);
  }

  private atomicWrite(r: UploadRecord, name: string, data: Uint8Array | string): void {
    const file = this.path(r, name);
    const tmp = `${file}.tmp`;
    try {
      mkdirSync(this.path(r), { recursive: true });
      writeFileSync(tmp, data);
      renameSync(tmp, file);
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* nothing to clean */ }
      throw storage(name, e);
    }
  }

  private writeRecord(r: UploadRecord): void {
    if (!this.dir) {
      if (!WORKSPACE.test(r.workspaceId)) throw storage('invalid workspace id');
      return;
    }
    this.atomicWrite(r, 'record.json', JSON.stringify(r));
  }

  private readFile(r: UploadRecord, name: string): Uint8Array | null {
    if (!this.dir) return this.mem.get(this.memKey(r, name))?.slice() ?? null;
    try {
      return new Uint8Array(readFileSync(this.path(r, name)));
    } catch {
      return null;
    }
  }

  private removeFile(r: UploadRecord, name: string): void {
    if (!this.dir) { this.mem.delete(this.memKey(r, name)); return; }
    try { unlinkSync(this.path(r, name)); } catch { /* already gone */ }
  }

  private sizeOf(r: UploadRecord, name: string): number {
    if (!this.dir) return this.mem.get(this.memKey(r, name))?.length ?? 0;
    try { return statSync(this.path(r, name)).size; } catch { return 0; }
  }

  /** Remove every file of an upload; with `all` also its record and directory. */
  private dropFiles(r: UploadRecord, all: boolean): void {
    if (!this.dir) {
      for (const name of FILES) this.mem.delete(this.memKey(r, name));
      return;
    }
    try {
      if (all) rmSync(this.path(r), { recursive: true, force: true });
      else for (const name of FILES) this.removeFile(r, name);
    } catch { /* invalid ids never reach the disk */ }
  }

  private load(): void {
    for (const ws of this.subdirs(this.dir!)) {
      if (!WORKSPACE.test(ws)) continue;
      for (const id of this.subdirs(join(this.dir!, ws))) {
        const r = this.readRecord(ws, id);
        if (r) this.records.set(r.id, r);
      }
    }
  }

  private subdirs(p: string): string[] {
    try { return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  }

  private readRecord(ws: string, id: string): UploadRecord | null {
    if (!ID.test(id)) return null;
    try {
      const r = JSON.parse(readFileSync(join(this.dir!, ws, id, 'record.json'), 'utf8')) as UploadRecord;
      return r && r.id === id && r.workspaceId === ws ? r : null;
    } catch {
      return null;
    }
  }

  /** Directories without a readable record, and stray tmp files in the others. */
  private sweepDisk(): number {
    let n = 0;
    for (const ws of this.subdirs(this.dir!)) {
      if (!WORKSPACE.test(ws)) continue;
      for (const id of this.subdirs(join(this.dir!, ws))) {
        const known = this.records.get(id);
        const d = join(this.dir!, ws, id);
        try {
          if (!known || known.workspaceId !== ws) { rmSync(d, { recursive: true, force: true }); n++; continue; }
          for (const f of readdirSync(d)) if (f.endsWith('.tmp')) rmSync(join(d, f), { recursive: true, force: true });
        } catch { /* leave it for the next sweep */ }
      }
    }
    return n;
  }
}
