/**
 * Submission intents and the approval/audit trail, on the server.
 *
 * An intent is exactly what will go to PayPal for one case (see apps/web/src/domain/intent.ts), composed here from the
 * server's own documents and analysis. Its life: proposed → approved (by the merchant, with the content hash they saw)
 * → sending → sent | failed. Every transition is synchronous (check and set in one step, no await in between), so two
 * confirmations of the same intent can never both start a send, and two intents for the same PayPal dispute can never
 * be sending at once: a per-dispute lock is taken in the same step, and once any intent for a dispute was accepted by
 * PayPal ("sent", persisted) no other intent for that dispute is sent.
 *
 * Each intent belongs to the session that created it (hosted: the demo session; local: the operator). Only that
 * session can read, approve, send or cancel it: for anyone else it does not exist (404). One session's actions (a new
 * intent, an edit) only ever invalidate that session's own intents; an edit during a send voids the approval if the
 * send does not go through.
 *
 * Bounded, without letting one client push out another's intents or audit trail:
 * - a session creates at most {@link MAX_CREATIONS_PER_OWNER} intents per {@link CREATION_WINDOW_MS} (whatever its
 *   addresses), holds one open intent per case and {@link MAX_OPEN_PER_OWNER} in all (its OWN oldest is replaced) and
 *   at most {@link MAX_STORED_PER_OWNER} stored;
 * - a client address (IPv6 keyed on /64 by the caller) holds at most {@link MAX_OPEN_PER_IP} open intents;
 * - as a safety net, at {@link MAX_OPEN} open or {@link MAX_INTENTS} stored, new intents are refused (429 with the time
 *   until one frees up); existing intents are never evicted.
 * Replaced, cancelled, invalidated and expired intents leave the store at once (a small, bounded tombstone keeps their
 * last state for their owner's error messages). A failed send may be retried for {@link FAILED_RETRY_MS}; sent intents
 * are kept {@link SENT_RETENTION_MS}. Audit events are kept per session ({@link MAX_EVENTS_PER_OWNER} each); events
 * about sends (started, sent, failed: bounded by the daily send cap) go to a separate append-only log that is never
 * evicted or compacted.
 *
 * Persisted on the data dir when given files. A send is durable or does not happen: the "sending" state (with the
 * approval it rests on) and the send_started event must reach the disk before anything goes to PayPal, or the send is
 * refused (503); other writes stay best effort, and a write that fails after PayPal accepted is reported to the caller.
 * Writes are durable (packages/hosting durable.ts: the intents file by tmp, fsync and rename; the audit and send logs
 * appended and fsynced). An intents file that exists but cannot be read is never treated as empty and overwritten: it
 * is moved aside as `intents.json.corrupt-<time>`, logged as an error and reported by {@link IntentStore.storageProblem}
 * (/api/health, the operator's check); if it cannot be moved, nothing is written over it and sends are refused.
 * What is written: the intents (including the notes text the merchant
 * approved, which is composed from the case's documents), the analysis hashes and the audit events (codes, hashes,
 * ids; no document text). No secrets.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { appendFileDurable, preserveCorrupt, readStoreFile, writeFileDurable } from '@resolvekit/hosting';
import type { CaseAnalysis } from '@resolvekit/analyst';
import type { IntentRequest, IntentStatus, SubmissionIntent } from '../../web/src/domain/intent.ts';
import type { Recheck } from '../../web/src/domain/draft.ts';

/** Safety nets only: the operative limits are per session and per client address. */
export const MAX_INTENTS = 2000;
export const MAX_OPEN = 1000;
/** Open intents per client address (IPv6: per /64), whatever the number of demo sessions it unlocked. */
export const MAX_OPEN_PER_IP = 20;
export const MAX_OPEN_PER_OWNER_CASE = 1;
export const MAX_OPEN_PER_OWNER = 10;
export const MAX_STORED_PER_OWNER = 30;
export const MAX_CREATIONS_PER_OWNER = 30;
export const CREATION_WINDOW_MS = 10 * 60_000;
export const INTENT_TTL_MS = 30 * 60_000;
export const FAILED_RETRY_MS = 30 * 60_000;
export const SENT_RETENTION_MS = 24 * 60 * 60_000;
export const MAX_TOMBSTONES = 2000;
export const MAX_EVENTS_PER_OWNER = 200;
export const MAX_EVENT_OWNERS = 2000;
export const MAX_EVENTS_FILE_BYTES = 4 * 1024 * 1024;
export const INTENT_ID = /^int-[0-9a-f]{32}$/;

/** What the server keeps about an intent besides what it shows: how to compose it again, and whose it is. */
export interface StoredIntent extends SubmissionIntent {
  request: IntentRequest;
  /** The verifier's verdicts on the edits, valid for {@link SubmissionIntent.analysisKey}. */
  rechecks: Record<string, Recheck>;
  /** The owner: the session that created it. Only it can read, approve, send or cancel the intent. */
  createdBy: string;
  /** The client it was composed from (hosted: the client address, IPv6 per /64; local: "local"). */
  createdFrom: string;
  /** Hosted: the merchant workspace the creator acts for; its members see the intent's audit events. */
  team?: string | null;
  /** sha256 of the exact analysis the sentences came from (pinned: someone else's re-run does not change it). */
  analysisHash?: string;
  /** When the last send failed (a failed intent may be retried until {@link FAILED_RETRY_MS} after that). */
  failedAt?: string | null;
  /** Set when the owner edited or replaced it while it was being sent: if the send does not go through, it is void. */
  voidReason?: string | null;
  /**
   * The confirmed uploads in the input it was composed from (ids): a send refused because the documents changed names
   * the uploads confirmed since. Absent on intents stored before uploads.
   */
  inputUploads?: string[];
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
  | 'binding_checked'
  /** A verified PayPal webhook about the case's dispute; the dispute was read again from PayPal. */
  | 'paypal_notified'
  /** Merchant evidence uploads (uploads/routes.ts): the detail is the upload id and evidence id, never the file name or text. */
  | 'upload_added'
  | 'upload_redacted'
  | 'upload_selected'
  | 'upload_confirmed'
  | 'upload_discarded'
  | 'upload_deleted';

/** One line of the server's audit log: the source of truth the web app shows. */
export interface AuditEvent {
  at: string;
  caseId: string;
  kind: AuditKind;
  actor: string;
  /** Whose trail it belongs to (the intent's owner; defaults to the actor). */
  owner?: string;
  /** Hosted: the merchant workspace whose trail it is (every member sees it). */
  team?: string;
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
  /** For 429: when to try again. */
  retryAfterSec?: number;
  intent?: StoredIntent;
}
export type Transition = { ok: true; intent: StoredIntent; previous: IntentStatus } | Refused;

const OPEN: readonly IntentStatus[] = ['proposed', 'approved', 'failed'];
const SEND_KINDS: readonly AuditKind[] = ['send_started', 'sent', 'send_failed'];
const NOT_FOUND: Refused = { ok: false, status: 404, error: 'UNKNOWN_INTENT', detail: 'No such submission intent for this case and session' };

export function newIntentId(): string {
  return `int-${randomBytes(16).toString('hex')}`;
}

type Draft = Omit<StoredIntent, 'id' | 'status' | 'createdAt' | 'expiresAt' | 'approvedBy' | 'approvedAt' | 'sentAt' | 'reason' | 'requestId'>;

export class IntentStore {
  private readonly intents = new Map<string, StoredIntent>();
  /** The last state of intents that left the store (their owner still gets "invalidated", not "unknown"). */
  private readonly tombstones = new Map<string, StoredIntent>();
  /** PayPal dispute → the intent PayPal accepted for it (persisted): no other intent is sent there. */
  private readonly sentDisputes = new Map<string, { intentId: string; at: string }>();
  /** PayPal dispute → the intent being sent to it right now. */
  private readonly inFlight = new Map<string, string>();
  /** Exact analyses intents were composed from, by hash (memory only; a restart falls back to the stored one). */
  private readonly pins = new Map<string, CaseAnalysis>();
  /** Recent creation times per owner (rate limit independent of the client address). */
  private readonly creations = new Map<string, number[]>();
  private readonly buckets = new Map<string, AuditEvent[]>();
  private readonly sendLog: AuditEvent[] = [];
  private readonly file: string | null;
  private readonly eventsFile: string | null;
  private readonly sendsFile: string | null;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private eventsBytes = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly log: (line: string) => void;
  /** Why the intents file could not be read at start (null: it could, or there was none). */
  private problem: string | null = null;
  /** The unreadable intents file could not be moved aside: nothing is written over it. */
  private blocked = false;

  constructor(o: { file?: string | null; eventsFile?: string | null; sendsFile?: string | null; now?: () => Date; ttlMs?: number; log?: (line: string) => void } = {}) {
    this.file = o.file ?? null;
    this.eventsFile = o.eventsFile ?? null;
    this.sendsFile = o.sendsFile ?? (this.eventsFile ? this.eventsFile.replace(/(\.jsonl)?$/, '-sends.jsonl') : null);
    this.now = o.now ?? (() => new Date());
    this.ttlMs = o.ttlMs ?? INTENT_TTL_MS;
    this.log = o.log ?? (() => {});
    const load = (file: string | null, into: (e: AuditEvent) => void) => {
      if (!file) return 0;
      try {
        const text = readFileSync(file, 'utf8');
        for (const l of text.split('\n').filter(Boolean)) {
          try {
            into(JSON.parse(l) as AuditEvent);
          } catch {
            /* a torn last line */
          }
        }
        return Buffer.byteLength(text);
      } catch {
        return 0;
      }
    };
    this.eventsBytes = load(this.eventsFile, (e) => this.bucketPush(e));
    // The send log first: it is durable and append-only, so even when intents.json is lost or unreadable every dispute
    // PayPal accepted an intent for is known again (no other intent is sent there).
    load(this.sendsFile, (e) => this.sendLog.push(e));
    if (this.file) this.loadIntents(this.file);
    for (const e of this.sendLog) {
      if (e.kind === 'sent' && e.disputeId && e.intentId && !this.sentDisputes.has(e.disputeId)) this.sentDisputes.set(e.disputeId, { intentId: e.intentId, at: e.at });
    }
  }

  private iso() {
    return this.now().toISOString();
  }

  // ---------------------------------------------------------------------------------------------------- persistence

  /** Read the saved intents. A missing file is an empty store; one that cannot be read is preserved, never overwritten. */
  private loadIntents(file: string) {
    const read = readStoreFile(file);
    if (read.kind === 'missing') return; // no intents yet
    if (read.kind === 'error') return this.unreadable(file, read.code, false);
    const raw = read.text;
    const intents = new Map<string, StoredIntent>();
    const sent = new Map<string, { intentId: string; at: string }>();
    try {
      const saved = JSON.parse(raw) as StoredIntent[] | { intents: StoredIntent[]; sentDisputes?: Record<string, { intentId: string; at: string }> };
      const list = Array.isArray(saved) ? saved : saved?.intents;
      if (!Array.isArray(list)) throw new Error('no list of intents');
      for (const i of list.slice(-MAX_INTENTS)) {
        if (!i || typeof i.id !== 'string' || typeof i.status !== 'string') throw new Error('an entry is not an intent');
        // A send cut short by a restart is unknown, not sent: it may be retried with the same PayPal-Request-Id,
        // and the evidence route reads PayPal first (provide_evidence disappears once evidence is in).
        if (i.status === 'sending') Object.assign(i, { status: 'failed', reason: 'the server restarted during the send', failedAt: this.iso() });
        if (OPEN.includes(i.status) || i.status === 'sent') intents.set(i.id, i);
      }
      if (!Array.isArray(saved)) for (const [d, v] of Object.entries(saved.sentDisputes ?? {})) sent.set(d, v);
    } catch (e) {
      return this.unreadable(file, e instanceof SyntaxError ? 'not JSON' : (e as Error).message, true);
    }
    for (const [k, v] of intents) this.intents.set(k, v);
    for (const [k, v] of sent) this.sentDisputes.set(k, v);
  }

  /**
   * The intents file could not be used. Corrupt content (`corrupt`) is moved aside; a read error (busy, permissions:
   * the file may be fine) or a failed move leaves it in place, never written over. Logs it and remembers why.
   */
  private unreadable(file: string, why: string, corrupt: boolean) {
    const to = corrupt ? preserveCorrupt(file, this.now()) : null;
    const name = basename(file);
    if (to) {
      this.problem = `${name} could not be read (${why}); preserved as ${to}. Open intents started empty; the disputes already sent to were taken from the send log (sends are still guarded by PayPal's fresh read)`;
    } else {
      this.blocked = true;
      this.problem = `${name} could not be read (${why})${corrupt ? ' and could not be moved aside' : ''}; left in place and never written over: every send is refused until it is fixed or removed, then restart`;
    }
    this.log(`ERROR intents · ${this.problem}`);
  }

  /** Why the saved intents could not be read at start, or null (shown by /api/health and the operator's check). */
  storageProblem(): string | null {
    return this.problem;
  }

  /** Whether the state reached the disk (true without a file: nothing to persist). */
  private writeNow(): boolean {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.file) return true;
    if (this.blocked) return false;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileDurable(this.file, JSON.stringify({ intents: [...this.intents.values()], sentDisputes: Object.fromEntries(this.sentDisputes) }));
      return true;
    } catch {
      // Ordinary transitions: best effort, the in-memory state still holds. Sends check the result.
      return false;
    }
  }

  /** Ordinary transitions are written shortly after (batched); sends and their outcomes are written at once. */
  private save(now = false): boolean {
    if (!this.file) return true;
    if (now) return this.writeNow();
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => this.writeNow(), 200);
      this.saveTimer.unref?.();
    }
    return true;
  }

  /** Write any pending state now (shutdown, tests). */
  flush() {
    if (this.saveTimer) this.writeNow();
  }

  // ---------------------------------------------------------------------------------------------------- audit

  private bucketPush(e: AuditEvent) {
    const owner = e.owner ?? e.actor;
    let b = this.buckets.get(owner);
    if (!b) {
      if (this.buckets.size >= MAX_EVENT_OWNERS) this.buckets.delete(this.buckets.keys().next().value!);
      b = [];
      this.buckets.set(owner, b);
    }
    b.push(e);
    if (b.length > MAX_EVENTS_PER_OWNER) b.splice(0, b.length - MAX_EVENTS_PER_OWNER);
  }

  record(e: Omit<AuditEvent, 'at'> & { at?: string }): AuditEvent {
    return this.recordChecked(e).event;
  }

  /** {@link record}, saying whether the event reached the disk (true without a file). */
  recordChecked(e: Omit<AuditEvent, 'at'> & { at?: string }): { event: AuditEvent; durable: boolean } {
    // An event about an intent belongs to the intent's workspace trail too.
    const about = e.intentId ? (this.intents.get(e.intentId) ?? this.tombstones.get(e.intentId)) : undefined;
    const team = e.team ?? about?.team ?? undefined;
    const ev: AuditEvent = { at: e.at ?? this.iso(), ...e, ...(team ? { team } : {}) } as AuditEvent;
    if (SEND_KINDS.includes(ev.kind)) {
      // Sends: append-only, never evicted (bounded by the daily send cap).
      this.sendLog.push(ev);
      if (this.sendsFile) {
        try {
          mkdirSync(dirname(this.sendsFile), { recursive: true });
          appendFileDurable(this.sendsFile, JSON.stringify(ev) + '\n');
        } catch {
          // The in-memory log still has it; the caller decides whether that is enough.
          return { event: ev, durable: false };
        }
      }
      return { event: ev, durable: true };
    }
    this.bucketPush(ev);
    let durable = true;
    if (this.eventsFile) {
      try {
        mkdirSync(dirname(this.eventsFile), { recursive: true });
        const line = JSON.stringify(ev) + '\n';
        const bytes = Buffer.byteLength(line);
        if (this.eventsBytes + bytes > MAX_EVENTS_FILE_BYTES) this.compact();
        else {
          appendFileDurable(this.eventsFile, line);
          this.eventsBytes += bytes;
        }
      } catch {
        // The in-memory log still has it.
        durable = false;
      }
    }
    return { event: ev, durable };
  }

  /** Rewrite the events file within half its budget, taking every session's newest events in turn (fair share). */
  private compact() {
    const lists = [...this.buckets.values()];
    const kept: Array<{ at: string; line: string }> = [];
    let bytes = 0;
    let more = true;
    for (let r = 1; more; r++) {
      more = false;
      for (const l of lists) {
        const e = l[l.length - r];
        if (!e) continue;
        more = true;
        const line = JSON.stringify(e) + '\n';
        const n = Buffer.byteLength(line);
        if (bytes + n > MAX_EVENTS_FILE_BYTES / 2) {
          more = false;
          break;
        }
        bytes += n;
        kept.push({ at: e.at, line });
      }
    }
    const text = kept.sort((a, b) => a.at.localeCompare(b.at)).map((k) => k.line).join('');
    writeFileDurable(this.eventsFile!, text);
    this.eventsBytes = Buffer.byteLength(text);
  }

  /** The case's events, oldest first; with `viewer`, only that session's own trail, or a workspace's (hosted). */
  events(caseId: string, viewer?: string | { team: string }): AuditEvent[] {
    if (viewer && typeof viewer === 'object') {
      const ours = (e: AuditEvent) => e.team === viewer.team;
      return [...[...this.buckets.values()].flat().filter(ours), ...this.sendLog.filter(ours)].filter((e) => e.caseId === caseId).sort((a, b) => a.at.localeCompare(b.at));
    }
    const mine = (e: AuditEvent) => viewer === undefined || (e.owner ?? e.actor) === viewer;
    const ordinary = viewer === undefined ? [...this.buckets.values()].flat() : (this.buckets.get(viewer) ?? []);
    return [...ordinary, ...this.sendLog.filter(mine)].filter((e) => e.caseId === caseId).sort((a, b) => a.at.localeCompare(b.at));
  }

  /** The audit files' size on disk (tests). */
  eventsFileBytes(): number {
    if (!this.eventsFile) return 0;
    try {
      return statSync(this.eventsFile).size;
    } catch {
      return 0;
    }
  }

  // ---------------------------------------------------------------------------------------------------- lifecycle

  /** When an intent stops counting by itself (TTL, retry window, retention), as epoch ms; null when it is in flight. */
  private endsAt(x: StoredIntent): number | null {
    if (x.status === 'proposed' || x.status === 'approved') return Date.parse(x.expiresAt);
    if (x.status === 'failed') return Date.parse(x.failedAt ?? x.createdAt) + FAILED_RETRY_MS;
    if (x.status === 'sent') return Date.parse(x.sentAt ?? x.createdAt) + SENT_RETENTION_MS;
    return null;
  }

  private bury(x: StoredIntent) {
    this.intents.delete(x.id);
    if (x.status === 'sent') return;
    this.tombstones.set(x.id, x);
    if (this.tombstones.size > MAX_TOMBSTONES) this.tombstones.delete(this.tombstones.keys().next().value!);
  }

  /** Apply the clock to one intent: past its TTL / retry window it is expired and leaves the store. */
  private fresh(i: StoredIntent): StoredIntent {
    const end = this.endsAt(i);
    if (end != null && end <= this.now().getTime() && this.intents.has(i.id)) {
      if (i.status !== 'sent') {
        i.reason = i.status === 'failed' ? 'the send failed and was not retried in time' : 'not sent within 30 minutes of being composed';
        i.status = 'expired';
      }
      this.bury(i);
      this.save();
    }
    return i;
  }

  private sweep() {
    for (const i of [...this.intents.values()]) this.fresh(i);
    // Analyses no intent refers to any more.
    const used = new Set([...this.intents.values()].map((i) => i.analysisHash));
    for (const h of this.pins.keys()) if (!used.has(h)) this.pins.delete(h);
  }

  /** The intent, only for its owner (anyone else: null, as if it did not exist). Includes its last state if it ended. */
  get(id: string, owner: string): StoredIntent | null {
    const i = this.intents.get(id);
    if (i && i.createdBy === owner) return this.fresh(i);
    const t = this.tombstones.get(id);
    return t && t.createdBy === owner ? t : null;
  }

  /** The intent whoever owns it (server-internal, tests). */
  peek(id: string): StoredIntent | null {
    const i = this.intents.get(id);
    return i ? this.fresh(i) : (this.tombstones.get(id) ?? null);
  }

  /** Keep the exact analysis an intent was composed from, by its hash. */
  pinAnalysis(hash: string, analysis: CaseAnalysis) {
    this.pins.set(hash, analysis);
  }

  /**
   * Drop the pinned analyses of every intent (sent ones included) that attaches this upload or was composed from an
   * input containing it: they quote it. The intent keeps its content and audit; only the analysis copy goes.
   */
  dropPinsUsing(uploadId: string) {
    for (const i of [...this.intents.values(), ...this.tombstones.values()]) {
      if (i.analysisHash && (i.request.attachments?.includes(uploadId) || i.inputUploads?.includes(uploadId))) this.pins.delete(i.analysisHash);
    }
  }

  analysisPin(hash: string | undefined): CaseAnalysis | null {
    return hash ? (this.pins.get(hash) ?? null) : null;
  }

  /** The intent PayPal accepted for this dispute, if any. */
  sentFor(disputeId: string): { intentId: string; at: string } | null {
    return this.sentDisputes.get(disputeId) ?? null;
  }

  /**
   * Whether a new intent of `owner` for `caseId` from `client` may be created, and which of the owner's OWN open intents
   * it would retire (the same case's, and its oldest beyond {@link MAX_OPEN_PER_OWNER}). Changes nothing: a refusal
   * leaves the store exactly as it was. Checked once before the expensive work (see {@link admit}) and again, in the
   * same synchronous step as the insert, by {@link create}.
   */
  private plan(caseId: string, owner: string, client: string): { ok: true; retire: StoredIntent[] } | Refused {
    const now = this.now().getTime();
    const live = [...this.intents.values()].filter((x) => {
      const end = this.endsAt(x);
      return end == null || end > now;
    });
    const isOpen = (x: StoredIntent) => OPEN.includes(x.status) || x.status === 'sending';
    const open = live.filter(isOpen);
    const retryAt = (list: StoredIntent[]) => {
      const ends = list.map((x) => this.endsAt(x) ?? now + 60_000);
      const soonest = ends.length ? Math.min(...ends) : now + 60_000;
      return Math.max(1, Math.ceil((soonest - now) / 1000));
    };
    const recent = (this.creations.get(owner) ?? []).filter((t) => t > now - CREATION_WINDOW_MS);
    if (recent.length >= MAX_CREATIONS_PER_OWNER) {
      const retryAfterSec = Math.max(1, Math.ceil((recent[0]! + CREATION_WINDOW_MS - now) / 1000));
      return { ok: false, status: 429, error: 'TOO_MANY_INTENTS', detail: 'This session composed too many submission intents; try again later', retryAfterSec };
    }
    const mine = open.filter((x) => x.createdBy === owner && x.status !== 'sending').sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    const sameCase = mine.filter((x) => x.caseId === caseId);
    const others = mine.filter((x) => x.caseId !== caseId);
    const retire = [...sameCase, ...others.slice(0, Math.max(0, others.length - (MAX_OPEN_PER_OWNER - 1)))];
    const retiring = new Set(retire.map((x) => x.id));
    const ownStored = live.filter((x) => x.createdBy === owner && !retiring.has(x.id));
    if (ownStored.length >= MAX_STORED_PER_OWNER) {
      return { ok: false, status: 429, error: 'TOO_MANY_INTENTS', detail: 'This session holds too many submission intents; try again later', retryAfterSec: retryAt(ownStored) };
    }
    // The client address's cap, however many sessions it holds: only that address is refused, nothing is evicted.
    const fromIp = open.filter((x) => x.createdFrom === client && !retiring.has(x.id));
    if (fromIp.length >= MAX_OPEN_PER_IP) {
      return { ok: false, status: 429, error: 'TOO_MANY_INTENTS', detail: 'Too many open submission intents from this address; try again later', retryAfterSec: retryAt(fromIp) };
    }
    // Global safety net: refuse, never evict.
    const stored = live.filter((x) => !retiring.has(x.id));
    if (open.length - retire.length >= MAX_OPEN || stored.length >= MAX_INTENTS) {
      return { ok: false, status: 429, error: 'TOO_MANY_INTENTS', detail: 'The server holds too many submission intents; try again later', retryAfterSec: retryAt(stored) };
    }
    return { ok: true, retire };
  }

  /** Before any expensive work: may this session/client create an intent now? No side effects. */
  admit(caseId: string, owner: string, client: string): Refused | null {
    const p = this.plan(caseId, owner, client);
    return p.ok ? null : p;
  }

  /**
   * Store a new intent for its owner, in one synchronous step: the caps are checked again, and only if the intent is
   * stored are the owner's own replaced intents retired (nobody else's are ever touched). A refusal changes nothing.
   */
  create(i: Draft, analysis?: CaseAnalysis): StoredIntent | Refused {
    const plan = this.plan(i.caseId, i.createdBy, i.createdFrom);
    if (!plan.ok) return plan;
    // Committed from here on (no await, no early return).
    this.sweep();
    for (const x of plan.retire) {
      this.invalidate(x.id, x.caseId === i.caseId ? 'replaced by a newer intent for this case' : 'replaced: this session holds too many open intents', i.createdBy);
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
      failedAt: null,
      voidReason: null,
    };
    this.intents.set(id, stored);
    if (analysis && i.analysisHash) this.pins.set(i.analysisHash, analysis);
    const times = (this.creations.get(i.createdBy) ?? []).filter((t) => t > now.getTime() - CREATION_WINDOW_MS);
    times.push(now.getTime());
    this.creations.delete(i.createdBy);
    this.creations.set(i.createdBy, times);
    if (this.creations.size > MAX_EVENT_OWNERS) this.creations.delete(this.creations.keys().next().value!);
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

  /**
   * approved | failed → sending, by its owner only, taking the dispute's send lock in the same synchronous step: of
   * two concurrent confirmations (of one intent, or of two intents for the same dispute) exactly one gets here, and
   * nothing is sent to a dispute PayPal already accepted evidence for through this server.
   */
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
    if (i.disputeId) {
      const done = this.sentDisputes.get(i.disputeId);
      if (done && done.intentId !== id) {
        return { ok: false, status: 409, error: 'SELLER_EVIDENCE_EXISTS', detail: 'PayPal already has seller evidence for this dispute; nothing more can be sent', intent: i };
      }
      const busy = this.inFlight.get(i.disputeId);
      if (busy && busy !== id) return { ok: false, status: 409, error: 'DISPUTE_BUSY', detail: 'Another response to this dispute is being sent right now; read the dispute back in a moment', intent: i };
      this.inFlight.set(i.disputeId, id);
    }
    const previous = i.status;
    i.status = 'sending';
    // Nothing goes to PayPal unless the approval and the "sending" state are on disk: a restart then finds the send
    // and reads PayPal before any retry, and the trail cannot lose an evidence submission.
    if (!this.save(true)) {
      i.status = previous;
      this.unlock(i);
      return { ok: false, status: 503, error: 'AUDIT_UNAVAILABLE', detail: 'The approval could not be recorded durably, so nothing was sent; try again later', intent: i };
    }
    return { ok: true, intent: i, previous };
  }

  private unlock(i: StoredIntent) {
    if (i.disputeId && this.inFlight.get(i.disputeId) === i.id) this.inFlight.delete(i.disputeId);
  }

  /** proposed | approved | failed → cancelled, by its owner only. */
  cancel(id: string, caseId: string, actor: string): Transition {
    const i = this.get(id, actor);
    if (!i || i.caseId !== caseId || !this.intents.has(id)) return i && i.caseId === caseId ? { ok: false, status: 409, error: `INTENT_${i.status.toUpperCase()}`, detail: `This intent is ${i.status}`, intent: i } : NOT_FOUND;
    if (!OPEN.includes(i.status)) return { ok: false, status: 409, error: `INTENT_${i.status.toUpperCase()}`, detail: `This intent is ${i.status}`, intent: i };
    const previous = i.status;
    i.status = 'invalidated';
    i.reason = 'cancelled by the merchant';
    this.bury(i);
    this.save();
    this.record({ caseId, kind: 'intent_cancelled', actor, disputeId: i.disputeId, intentId: id, contentHash: i.contentHash });
    return { ok: true, intent: i, previous };
  }

  /** sending → back to where it was (the send did not happen: PayPal unreadable, daily cap…), or void if edited meanwhile. */
  revert(id: string, previous: IntentStatus) {
    const i = this.intents.get(id);
    if (i?.status !== 'sending') return;
    this.unlock(i);
    if (i.voidReason) return this.invalidate(id, i.voidReason, i.createdBy);
    i.status = previous;
    this.save(true);
  }

  /** sending → sent. False when the outcome did not reach the disk (PayPal has it anyway: the caller reports it). */
  sent(id: string, actor: string, detail: string): boolean {
    const i = this.intents.get(id);
    if (!i) return false;
    this.unlock(i);
    i.status = 'sent';
    i.sentAt = this.iso();
    i.reason = null;
    if (i.disputeId) this.sentDisputes.set(i.disputeId, { intentId: id, at: i.sentAt });
    const saved = this.save(true);
    const logged = this.recordChecked({ caseId: i.caseId, kind: 'sent', actor, owner: i.createdBy, disputeId: i.disputeId, intentId: id, contentHash: i.contentHash, requestId: i.requestId, detail }).durable;
    return saved && logged;
  }

  failed(id: string, actor: string, reason: string) {
    const i = this.intents.get(id);
    if (!i) return;
    this.unlock(i);
    this.record({ caseId: i.caseId, kind: 'send_failed', actor, owner: i.createdBy, disputeId: i.disputeId, intentId: id, contentHash: i.contentHash, requestId: i.requestId, detail: reason });
    if (i.voidReason) return this.invalidate(id, i.voidReason, i.createdBy);
    i.status = 'failed';
    i.reason = reason;
    i.failedAt = this.iso();
    this.save(true);
  }

  invalidate(id: string, reason: string, actor = 'ResolveKit') {
    const i = this.intents.get(id);
    if (!i || !(OPEN.includes(i.status) || i.status === 'sending')) return;
    this.unlock(i);
    i.status = 'invalidated';
    i.reason = reason;
    this.bury(i);
    this.save();
    // Kept in the owner's trail whoever caused it (ResolveKit's own checks included).
    this.record({ caseId: i.caseId, kind: 'intent_invalidated', actor, owner: i.createdBy, disputeId: i.disputeId, intentId: id, contentHash: i.contentHash, detail: reason });
  }

  /**
   * Invalidate the open intents one session holds for a case (its edit, its newer intent). Never anyone else's. One
   * that is being sent right now is marked: if that send does not go through, it is void instead of approved again.
   */
  invalidateCase(caseId: string, reason: string, owner: string) {
    for (const i of [...this.intents.values()]) {
      if (i.caseId !== caseId || i.createdBy !== owner) continue;
      if (i.status === 'sending') i.voidReason = reason;
      else if (OPEN.includes(this.fresh(i).status) && this.intents.has(i.id)) this.invalidate(i.id, reason, owner);
    }
  }

  /**
   * The open or in-flight intents that use this upload (whoever owns them): they attach it, or it was in the input
   * they were composed from (their notes and sentences may quote it).
   */
  usingUpload(uploadId: string): StoredIntent[] {
    return [...this.intents.values()].filter(
      (i) => (i.request.attachments?.includes(uploadId) || i.inputUploads?.includes(uploadId)) && this.intents.has(this.fresh(i).id) && (OPEN.includes(i.status) || i.status === 'sending'),
    );
  }

  /** Invalidate every open intent (the operator changed the bindings). */
  invalidateAll(reason: string) {
    for (const i of [...this.intents.values()]) {
      if (i.status === 'sending') i.voidReason = reason;
      else if (OPEN.includes(this.fresh(i).status) && this.intents.has(i.id)) this.invalidate(i.id, reason);
    }
  }

  /** Number of stored intents (tests, health). */
  size(): number {
    return this.intents.size;
  }
}

/** The intent as the API shows it: the content and its state, not the server's bookkeeping. */
export function publicIntent(i: StoredIntent): SubmissionIntent {
  const { request: _r, rechecks: _c, createdBy: _b, createdFrom: _f, analysisHash: _h, failedAt: _a, voidReason: _v, inputUploads: _u, ...pub } = i;
  return pub;
}
