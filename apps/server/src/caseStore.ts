/**
 * The cases this server discovered from a merchant's disputes (webhook or owner scan): one record per dispute, kept on
 * the data dir (`cases.json`, durable write) as `{ v: 1, cases: DiscoveredCase[] }`. A case id and a dispute id each
 * appear once. A file that cannot be read is moved aside (`<file>.corrupt-<time>`) or left in place and reported
 * ({@link CaseStore.storageProblem}); while there is a problem nothing is added or written, so nothing is lost or
 * overwritten. A failed write keeps the record in memory (logged).
 */
import { mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { openStoreFile, writeFileDurable } from '@resolvekit/hosting';
import type { CaseTemplate } from '@resolvekit/cases';

export interface DiscoveredCase {
  caseId: string;
  merchantId: string;
  disputeId: string;
  captureId: string;
  template: CaseTemplate;
  orderRef: string;
  source: 'webhook' | 'scan';
  createdAt: string;
  endedAt?: string;
}

const TEMPLATES: readonly string[] = ['standard', 'settlement', 'agent'];
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function parseCase(c: unknown): DiscoveredCase {
  const r = c as Partial<Record<keyof DiscoveredCase, unknown>> | null;
  if (!r || typeof r !== 'object') throw new Error('shape');
  if (!str(r.caseId) || !str(r.merchantId) || !str(r.disputeId) || !str(r.captureId) || !str(r.orderRef) || !str(r.createdAt)) throw new Error('shape');
  if (typeof r.template !== 'string' || !TEMPLATES.includes(r.template)) throw new Error('shape');
  if (r.source !== 'webhook' && r.source !== 'scan') throw new Error('shape');
  if (r.endedAt !== undefined && !str(r.endedAt)) throw new Error('shape');
  return {
    caseId: r.caseId,
    merchantId: r.merchantId,
    disputeId: r.disputeId,
    captureId: r.captureId,
    template: r.template as CaseTemplate,
    orderRef: r.orderRef,
    source: r.source,
    createdAt: r.createdAt,
    ...(r.endedAt !== undefined ? { endedAt: r.endedAt } : {}),
  };
}

export class CaseStore {
  private cases: DiscoveredCase[] = [];
  private readonly file: string;
  private readonly log: (line: string) => void;
  private problem: string | null = null;
  private blocked = false;

  constructor(o: { file: string; log?: (s: string) => void; now?: () => Date }) {
    this.file = o.file;
    this.log = o.log ?? (() => {});
    const opened = openStoreFile(
      this.file,
      (raw) => {
        const s = JSON.parse(raw) as { v?: unknown; cases?: unknown };
        if (s?.v !== 1 || !Array.isArray(s.cases)) throw new Error('shape');
        const list = s.cases.map(parseCase);
        if (new Set(list.map((c) => c.caseId)).size !== list.length || new Set(list.map((c) => c.disputeId)).size !== list.length) throw new Error('shape');
        return list;
      },
      { ifEmpty: 'Discovered cases start empty until the next webhook or scan finds them again', now: o.now?.() },
    );
    this.cases = opened.value ?? [];
    this.blocked = opened.blocked;
    this.problem = opened.problem;
    if (this.problem) this.log(`ERROR cases · ${this.problem}`);
  }

  all(): DiscoveredCase[] {
    return this.cases.map((c) => ({ ...c }));
  }

  get(caseId: string): DiscoveredCase | null {
    const c = this.cases.find((x) => x.caseId === caseId);
    return c ? { ...c } : null;
  }

  byDispute(disputeId: string): DiscoveredCase | null {
    const c = this.cases.find((x) => x.disputeId === disputeId);
    return c ? { ...c } : null;
  }

  /** Add a case. False (nothing written) when the case id or the dispute is already there, or the file has a problem. */
  add(c: DiscoveredCase): boolean {
    if (this.problem) return false;
    if (this.cases.some((x) => x.caseId === c.caseId || x.disputeId === c.disputeId)) return false;
    this.cases.push({ ...c });
    this.save();
    return true;
  }

  markEnded(caseId: string, at: string): void {
    const c = this.cases.find((x) => x.caseId === caseId);
    if (!c || this.problem) return;
    c.endedAt = at;
    this.save();
  }

  templateOf(caseId: string): CaseTemplate | null {
    return this.cases.find((x) => x.caseId === caseId)?.template ?? null;
  }

  /** Why the saved cases could not be read at start, or null. */
  storageProblem(): string | null {
    return this.problem;
  }

  private save() {
    if (this.blocked) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileDurable(this.file, JSON.stringify({ v: 1, cases: this.cases }));
    } catch (e) {
      this.log(`cases · cannot save ${basename(this.file)} · ${(e as NodeJS.ErrnoException).code ?? (e as Error).message} · cases kept in memory only`);
    }
  }
}
