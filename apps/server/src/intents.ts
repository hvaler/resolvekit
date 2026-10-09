/**
 * Submission intents and the approval/audit trail, on the server.
 *
 * An intent is exactly what will go to PayPal for one case (see apps/web/src/domain/intent.ts), composed here from the
 * server's own documents and analysis. Its life: proposed → approved (by the merchant, with the content hash they saw)
 * → sending → sent | failed. Every transition is synchronous (check and set in one step, no await in between), so two
 * confirmations of the same intent can never both start a send.
 *
 * Each intent belongs to the session that created it (hosted: the demo session; local: the operator). Only that
 * session can read, approve, send or cancel it: for anyone else it does not exist (404). One session's actions (a new
 * intent, an edit) only ever invalidate that session's own intents. Ids carry 128 random bits.
 *
 * Bounded: at most {@link MAX_OPEN_PER_OWNER_CASE} open intents per session and case, {@link MAX_OPEN} open intents in
 * all (expired ones are dropped first), {@link MAX_INTENTS} stored, a {@link INTENT_TTL_MS} lifetime, and an audit
 * file that is compacted to its latest {@link MAX_EVENTS_IN_MEMORY} lines beyond {@link MAX_EVENTS_FILE_BYTES}.
 * Persisted on the data dir when given files. No document text and no secrets go into either file.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { IntentRequest, IntentStatus, SubmissionIntent } from '../../web/src/domain/intent.ts';
import type { Recheck } from '../../web/src/domain/draft.ts';

export const MAX_INTENTS = 500;
export const MAX_OPEN = 200;
export const MAX_OPEN_PER_OWNER_CASE = 5;
export const MAX_EVENTS_IN_MEMORY = 5000;
export const MAX_EVENTS_FILE_BYTES = 4 * 1024 * 1024;
export const INTENT_TTL_MS = 30 * 60_000;
export const INTENT_ID = /^int-[0-9a-f]{32}$/;

/** What the server keeps about an intent besides what it shows: how to compose it again, and whose it is. */
export interface StoredIntent extends SubmissionIntent {
  request: IntentRequest;
  /** The verifier's verdicts on the edits, valid for {@link SubmissionIntent.analysisKey}. */
  rechecks: Record<string, Recheck>;
  /** The owner: the session that created it. Only it can read, approve, send or cancel the intent. */
  createdBy: string;
}

export type AuditKind =
  | 'intent_created'
  | 'intent_approved'
  | 'intent_invalidated'
  | 'intent_cancelled'
  | 'send_started'
  | 'send_refused'
  | 'sent'
  | 'send_failed'
  | 'edit_rechecked'
  | 'binding_checked';

/** One line of the server's audit log: the source of truth the web app shows. */
export interface AuditEvent {
  at: string;
  caseId: string;
  kind: AuditKind;
  actor: string;
  disputeId?: string | null;
  intentId?: string;
  contentHash?: string;
  requestId?: string;
  /** PayPal's answer or the reason, in a few words (codes, never document text). */
  detail?: string;
}

export interface Refused {
  ok: false;
  status: number;
  error: string;
  detail: string;
  intent?: StoredIntent;
}
export type Transition = { ok: true; intent: StoredIntent; previous: IntentStatus } | Refused;

const OPEN: readonly IntentStatus[] = ['proposed', 'approved', 'failed'];
const NOT_FOUND: Refused = { ok: false, status: 404, error: 'UNKNOWN_INTENT', detail: 'No such submission intent for this case and session' };

export function newIntentId(): string {
  return `int-${randomBytes(16).toString('hex')}`;
}

export class IntentStore {
  private readonly intents = new Map<string, StoredIntent>();
  private readonly log: AuditEvent[] = [];
  private readonly file: string | null;
  private readonly eventsFile: string | null;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private eventsBytes = 0;

  constructor(o: { file?: string | null; eventsFile?: string | null; now?: () => Date; ttlMs?: number } = {}) {
    this.file = o.file ?? null;
    this.eventsFile = o.eventsFile ?? null;
    this.now = o.now ?? (() => new Date());
    this.ttlMs = o.ttlMs ?? INTENT_TTL_MS;
    if (this.file) {
      try {
        const saved = JSON.parse(readFileSync(this.file, 'utf8')) as StoredIntent[];
        for (const i of saved.slice(-MAX_INTENTS)) {
          // A send cut short by a restart is unknown, not sent: it may be retried with the same PayPal-Request-Id,
          // and the evidence route reads PayPal first (provide_evidence disappears once evidence is in).
          if (i.status === 'sending') Object.assign(i, { status: 'failed', reason: 'the server restarted during the send' });
          this.intents.set(i.id, i);
        }
      } catch {
        /* no intents yet */
      }
    }
    if (this.eventsFile) {
      try {
        const text = readFileSync(this.eventsFile, 'utf8');
        this.eventsBytes = Buffer.byteLength(text);
        for (const l of text.split('\n').filter(Boolean).slice(-MAX_EVENTS_IN_MEMORY)) {
          try {
            this.log.push(JSON.parse(l) as AuditEvent);
          } catch {
            /* a torn last line */
          }
        }
      } catch {
        /* no events yet */
      }
    }
  }

  private iso() {
    return this.now().toISOString();
  }

  private save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.intents.values()]));
      renameSync(tmp, this.file);
    } catch {
      /* best effort: the in-memory state still holds */
    }
  }

  record(e: Omit<AuditEvent, 'at'> & { at?: string }): AuditEvent {
    const ev: AuditEvent = { at: e.at ?? this.iso(), ...e } as AuditEvent;
    this.log.push(ev);
    if (this.log.length > MAX_EVENTS_IN_MEMORY) this.log.splice(0, this.log.length - MAX_EVENTS_IN_MEMORY);
    if (this.eventsFile) {
      try {
        mkdirSync(dirname(this.eventsFile), { recursive: true });
        const line = JSON.stringify(ev) + '\n';
        if (this.eventsBytes + line.length > MAX_EVENTS_FILE_BYTES) {
          // Compact: keep the latest events that fit in half the budget, so the disk use stays bounded.
          const tmp = `${this.eventsFile}.tmp`;
          const kept: string[] = [];
          let bytes = 0;
          for (let k = this.log.length - 1; k >= 0; k--) {
            const l = JSON.stringify(this.log[k]) + '\n';
            if (bytes + Buffer.byteLength(l) > MAX_EVENTS_FILE_BYTES / 2) break;
            kept.push(l);
            bytes += Buffer.byteLength(l);
          }
          const text = kept.reverse().join('');
          writeFileSync(tmp, text);
          renameSync(tmp, this.eventsFile);
          this.eventsBytes = Buffer.byteLength(text);
        } else {
          appendFileSync(this.eventsFile, line);
          this.eventsBytes += Buffer.byteLength(line);
        }
      } catch {
        /* the in-memory log still has it */
      }
    }
    return ev;
  }

  /** The case's events; with `actor`, only that session's own (hosted visitors see their own trail). */
  events(caseId: string, actor?: string): AuditEvent[] {
    return this.log.filter((e) => e.caseId === caseId && (actor === undefined || e.actor === actor));
  }

  /** The audit file's size on disk (tests). */
  eventsFileBytes(): number {
    if (!this.eventsFile) return 0;
    try {
      return statSync(this.eventsFile).size;
    } catch {
      return 0;
    }
  }

  /** Expire a proposed/approved intent past its deadline (in place). */
  private fresh(i: StoredIntent): StoredIntent {
    if ((i.status === 'proposed' || i.status === 'approved') && Date.parse(i.expiresAt) <= this.now().getTime()) {
      i.status = 'expired';
      i.reason = 'not sent within 30 minutes of being composed';
    }
    return i;
  }

  private sweep() {
    for (const i of this.intents.values()) this.fresh(i);
  }

  /** The intent, only for its owner (anyone else: null, as if it did not exist). */
  get(id: string, owner: string): StoredIntent | null {
    const i = this.intents.get(id);
    return i && i.createdBy === owner ? this.fresh(i) : null;
  }

  /** The intent whoever owns it (server-internal: bindings, tests). */
  peek(id: string): StoredIntent | null {
    const i = this.intents.get(id);
    return i ? this.fresh(i) : null;
  }

  private open(): StoredIntent[] {
    return [...this.intents.values()].filter((i) => OPEN.includes(i.status) || i.status === 'sending');
  }

  /**
   * Store a new intent for its owner. The owner's own open intents for the case are invalidated (only the latest
   * content can be sent); nobody else's are touched. Refused when the server holds too many open intents.
   */
  create(i: Omit<StoredIntent, 'id' | 'status' | 'createdAt' | 'expiresAt' | 'approvedBy' | 'approvedAt' | 'sentAt' | 'reason' | 'requestId'>): StoredIntent | Refused {
    this.sweep();
    this.invalidateCase(i.caseId, 'replaced by a newer intent for this case', i.createdBy);
    const mine = this.open().filter((x) => x.caseId === i.caseId && x.createdBy === i.createdBy);
    if (mine.length >= MAX_OPEN_PER_OWNER_CASE) return { ok: false, status: 429, error: 'TOO_MANY_INTENTS', detail: 'This session has too many open intents for this case' };
    if (this.open().length >= MAX_OPEN) return { ok: false, status: 429, error: 'TOO_MANY_INTENTS', detail: 'The server holds too many open submission intents; try again in a few minutes' };
    // Make room: drop the oldest closed (sent, invalidated, expired, cancelled) intents first; open ones are never dropped.
    if (this.intents.size >= MAX_INTENTS) {
      const closed = [...this.intents.values()].filter((x) => !(OPEN.includes(x.status) || x.status === 'sending')).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const o of closed.slice(0, this.intents.size - MAX_INTENTS + 1)) this.intents.delete(o.id);
    }
    const id = newIntentId();
    const now = this.now();
    const stored: StoredIntent = {
      ...i,
      id,
      requestId: `rk-${id}`,
      status: 'proposed',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      approvedBy: null,
      approvedAt: null,
      sentAt: null,
      reason: null,
    };
    this.intents.set(id, stored);
    this.save();
    this.record({ caseId: i.caseId, kind: 'intent_created', actor: i.createdBy, disputeId: i.disputeId, intentId: id, contentHash: i.contentHash, requestId: stored.requestId });
    return stored;
  }

  /** proposed → approved, by its owner only, with the content hash the merchant saw. */
  approve(id: string, caseId: string, contentHash: string, actor: string): Transition {
    const i = this.get(id, actor);
    if (!i || i.caseId !== caseId) return NOT_FOUND;
    if (i.status !== 'proposed') return { ok: false, status: 409, error: `INTENT_${i.status.toUpperCase()}`, detail: `This intent is ${i.status}${i.reason ? ` (${i.reason})` : ''}; review the response again`, intent: i };
    if (contentHash !== i.contentHash) return { ok: false, status: 409, error: 'CONTENT_HASH_MISMATCH', detail: 'The approved content is not the content of this intent', intent: i };
    i.status = 'approved';
    i.approvedBy = actor;
    i.approvedAt = this.iso();
    this.save();
    this.record({ caseId, kind: 'intent_approved', actor, disputeId: i.disputeId, intentId: id, contentHash: i.contentHash, requestId: i.requestId });
    return { ok: true, intent: i, previous: 'proposed' };
  }

  /** approved | failed → sending, by its owner only. Synchronous: of two concurrent confirmations, exactly one gets here. */
  beginSend(id: string, caseId: string, actor: string): Transition {
    const i = this.get(id, actor);
    if (!i || i.caseId !== caseId) return NOT_FOUND;
    if (i.status !== 'approved' && i.status !== 'failed') {
      const detail =
        i.status === 'proposed'
          ? 'This intent has not been approved'
          : i.status === 'sending'
            ? 'This intent is being sent right now'
            : i.status === 'sent'
              ? 'This intent was already sent; read the dispute back'
              : `This intent is ${i.status}${i.reason ? ` (${i.reason})` : ''}`;
      return { ok: false, status: 409, error: `INTENT_${i.status.toUpperCase()}`, detail, intent: i };
    }
    const previous = i.status;
    i.status = 'sending';
    this.save();
    return { ok: true, intent: i, previous };
  }

  /** proposed | approved | failed → cancelled, by its owner only. */
  cancel(id: string, caseId: string, actor: string): Transition {
    const i = this.get(id, actor);
    if (!i || i.caseId !== caseId) return NOT_FOUND;
    if (!OPEN.includes(i.status)) return { ok: false, status: 409, error: `INTENT_${i.status.toUpperCase()}`, detail: `This intent is ${i.status}`, intent: i };
    const previous = i.status;
    i.status = 'invalidated';
    i.reason = 'cancelled by the merchant';
    this.save();
    this.record({ caseId, kind: 'intent_cancelled', actor, disputeId: i.disputeId, intentId: id, contentHash: i.contentHash });
    return { ok: true, intent: i, previous };
  }

  /** sending → back to where it was (the send did not happen: PayPal unreadable, daily cap…). */
  revert(id: string, previous: IntentStatus) {
    const i = this.intents.get(id);
    if (i?.status !== 'sending') return;
    i.status = previous;
    this.save();
  }

  sent(id: string, actor: string, detail: string) {
    const i = this.intents.get(id);
    if (!i) return;
    i.status = 'sent';
    i.sentAt = this.iso();
    i.reason = null;
    this.save();
    this.record({ caseId: i.caseId, kind: 'sent', actor, disputeId: i.disputeId, intentId: id, contentHash: i.contentHash, requestId: i.requestId, detail });
  }

  failed(id: string, actor: string, reason: string) {
    const i = this.intents.get(id);
    if (!i) return;
    i.status = 'failed';
    i.reason = reason;
    this.save();
    this.record({ caseId: i.caseId, kind: 'send_failed', actor, disputeId: i.disputeId, intentId: id, contentHash: i.contentHash, requestId: i.requestId, detail: reason });
  }

  invalidate(id: string, reason: string, actor = 'ResolveKit') {
    const i = this.intents.get(id);
    if (!i || !(OPEN.includes(i.status) || i.status === 'sending')) return;
    i.status = 'invalidated';
    i.reason = reason;
    this.save();
    this.record({ caseId: i.caseId, kind: 'intent_invalidated', actor, disputeId: i.disputeId, intentId: id, contentHash: i.contentHash, detail: reason });
  }

  /** Invalidate the open intents one session holds for a case (its edit, its newer intent). Never anyone else's. */
  invalidateCase(caseId: string, reason: string, owner: string) {
    for (const i of this.intents.values()) {
      if (i.caseId === caseId && i.createdBy === owner && OPEN.includes(this.fresh(i).status)) this.invalidate(i.id, reason, owner);
    }
  }

  /** Invalidate every open intent (the operator changed the bindings). */
  invalidateAll(reason: string) {
    for (const i of this.intents.values()) if (OPEN.includes(this.fresh(i).status)) this.invalidate(i.id, reason);
  }

  /** Number of stored intents (tests, health). */
  size(): number {
    return this.intents.size;
  }
}

/** The intent as the API shows it: the content and its state, not the server's bookkeeping. */
export function publicIntent(i: StoredIntent): SubmissionIntent {
  const { request: _r, rechecks: _c, createdBy: _b, ...pub } = i;
  return pub;
}
