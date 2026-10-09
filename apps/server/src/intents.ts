/**
 * Submission intents and the approval/audit trail, on the server.
 *
 * An intent is exactly what will go to PayPal for one case (see apps/web/src/domain/intent.ts), composed here from the
 * server's own documents and analysis. Its life: proposed → approved (by the merchant, with the content hash they saw)
 * → sending → sent | failed. A newer intent for the same case, an edit, or a change of documents or bindings
 * invalidates it. Every transition is synchronous (check and set in one step, no await in between), so two
 * confirmations of the same intent can never both start a send.
 *
 * Persisted on the data dir when given files: intents as one JSON file (the latest {@link MAX_INTENTS}), events as an
 * append-only JSON-lines log. No document text and no secrets go into either: notes are the merchant's own response.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { IntentRequest, IntentStatus, SubmissionIntent } from '../../web/src/domain/intent.ts';
import type { Recheck } from '../../web/src/domain/draft.ts';

export const MAX_INTENTS = 500;
export const MAX_EVENTS_IN_MEMORY = 5000;
export const INTENT_TTL_MS = 30 * 60_000;

/** What the server keeps about an intent besides what it shows: how to compose it again, and who asked. */
export interface StoredIntent extends SubmissionIntent {
  request: IntentRequest;
  /** The verifier's verdicts on the edits, valid for {@link SubmissionIntent.analysisKey}. */
  rechecks: Record<string, Recheck>;
  createdBy: string;
}

export type AuditKind =
  | 'intent_created'
  | 'intent_approved'
  | 'intent_invalidated'
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

export type Transition = { ok: true; intent: StoredIntent; previous: IntentStatus } | { ok: false; status: number; error: string; detail: string; intent?: StoredIntent };

const OPEN: readonly IntentStatus[] = ['proposed', 'approved', 'failed'];

export function newIntentId(): string {
  return `int-${randomBytes(12).toString('hex')}`;
}

export class IntentStore {
  private readonly intents = new Map<string, StoredIntent>();
  private readonly log: AuditEvent[] = [];
  private readonly file: string | null;
  private readonly eventsFile: string | null;
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(o: { file?: string | null; eventsFile?: string | null; now?: () => Date; ttlMs?: number } = {}) {
    this.file = o.file ?? null;
    this.eventsFile = o.eventsFile ?? null;
    this.now = o.now ?? (() => new Date());
    this.ttlMs = o.ttlMs ?? INTENT_TTL_MS;
    if (this.file) {
      try {
        const saved = JSON.parse(readFileSync(this.file, 'utf8')) as StoredIntent[];
        for (const i of saved) {
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
        const lines = readFileSync(this.eventsFile, 'utf8').split('\n').filter(Boolean).slice(-MAX_EVENTS_IN_MEMORY);
        for (const l of lines) {
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
        appendFileSync(this.eventsFile, JSON.stringify(ev) + '\n');
      } catch {
        /* the in-memory log still has it */
      }
    }
    return ev;
  }

  events(caseId: string): AuditEvent[] {
    return this.log.filter((e) => e.caseId === caseId);
  }

  /** Expire a proposed/approved intent past its deadline (in place). */
  private fresh(i: StoredIntent): StoredIntent {
    if ((i.status === 'proposed' || i.status === 'approved') && Date.parse(i.expiresAt) <= this.now().getTime()) {
      i.status = 'expired';
      i.reason = 'not sent within 30 minutes of being composed';
      this.save();
    }
    return i;
  }

  get(id: string): StoredIntent | null {
    const i = this.intents.get(id);
    return i ? this.fresh(i) : null;
  }

  /** Store a new intent. Any open intent of the same case is invalidated: only the latest content can be sent. */
  create(i: Omit<StoredIntent, 'id' | 'status' | 'createdAt' | 'expiresAt' | 'approvedBy' | 'approvedAt' | 'sentAt' | 'reason' | 'requestId'>): StoredIntent {
    this.invalidateCase(i.caseId, 'replaced by a newer intent for this case', i.createdBy);
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
    // Keep the newest intents only.
    if (this.intents.size > MAX_INTENTS) {
      const old = [...this.intents.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, this.intents.size - MAX_INTENTS);
      for (const o of old) this.intents.delete(o.id);
    }
    this.save();
    this.record({ caseId: i.caseId, kind: 'intent_created', actor: i.createdBy, disputeId: i.disputeId, intentId: id, contentHash: i.contentHash, requestId: stored.requestId });
    return stored;
  }

  /** proposed → approved, only with the content hash the merchant saw. */
  approve(id: string, caseId: string, contentHash: string, actor: string): Transition {
    const i = this.get(id);
    if (!i || i.caseId !== caseId) return { ok: false, status: 404, error: 'UNKNOWN_INTENT', detail: 'No such submission intent for this case' };
    if (i.status !== 'proposed') return { ok: false, status: 409, error: `INTENT_${i.status.toUpperCase()}`, detail: `This intent is ${i.status}${i.reason ? ` (${i.reason})` : ''}; review the response again`, intent: i };
    if (contentHash !== i.contentHash) return { ok: false, status: 409, error: 'CONTENT_HASH_MISMATCH', detail: 'The approved content is not the content of this intent', intent: i };
    i.status = 'approved';
    i.approvedBy = actor;
    i.approvedAt = this.iso();
    this.save();
    this.record({ caseId, kind: 'intent_approved', actor, disputeId: i.disputeId, intentId: id, contentHash: i.contentHash, requestId: i.requestId });
    return { ok: true, intent: i, previous: 'proposed' };
  }

  /** approved | failed → sending. Synchronous: of two concurrent confirmations, exactly one gets here. */
  beginSend(id: string, caseId: string): Transition {
    const i = this.get(id);
    if (!i || i.caseId !== caseId) return { ok: false, status: 404, error: 'UNKNOWN_INTENT', detail: 'No such submission intent for this case' };
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

  /** Invalidate every open intent of a case (an edit, a newer intent, changed documents). */
  invalidateCase(caseId: string, reason: string, actor = 'ResolveKit') {
    for (const i of this.intents.values()) if (i.caseId === caseId && OPEN.includes(this.fresh(i).status)) this.invalidate(i.id, reason, actor);
  }

  /** Invalidate every open intent (the bindings changed). */
  invalidateAll(reason: string) {
    for (const i of this.intents.values()) if (OPEN.includes(this.fresh(i).status)) this.invalidate(i.id, reason);
  }
}

/** The intent as the API shows it: the content and its state, not the server's bookkeeping. */
export function publicIntent(i: StoredIntent): SubmissionIntent {
  const { request: _r, rechecks: _c, createdBy: _b, ...pub } = i;
  return pub;
}
