/**
 * The MeterMCP ledger: sessions (one approved PayPal budget each) and their calls, in SQLite (node:sqlite, built
 * into Node 24). Every money decision is one transaction: a call reserves its price only if the session's OK and
 * in-flight calls plus this price stay within the cap, so two concurrent calls can never both take the last of
 * the budget. Amounts are integer cents.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type SessionStatus =
  /** Order created; waiting for the buyer to approve the budget in PayPal. */
  | 'pending_approval'
  /** Budget authorized in PayPal; paid calls draw on it. */
  | 'active'
  /** No more calls; settlement in progress. */
  | 'closing'
  /**
   * The final capture was made but PayPal reports it PENDING: not a completed charge yet, and nothing is claimed as
   * charged or released. Reconciled by reading the capture (on a schedule, on demand, on close) until it is
   * COMPLETED (→ settled, once) or DECLINED/FAILED (→ capture_declined).
   */
  | 'capture_pending'
  /** Consumed total captured with final_capture and COMPLETED at PayPal (the remainder released). */
  | 'settled'
  /** PayPal declined or failed the pending capture: the attempt stays on record; nothing was charged. */
  | 'capture_declined'
  /** Nothing consumed: the authorization was voided. */
  | 'voided'
  /** The capture or void failed: never charged as far as MeterMCP knows; retry with close. */
  | 'settlement_failed'
  /** The buyer cancelled in PayPal, or the order could not be approved (a declined funding source: settlement_error). */
  | 'cancelled';

export type CallStatus = 'PENDING' | 'OK' | 'FAILED';

export interface SessionRow {
  id: string;
  mcp_session: string | null;
  status: SessionStatus;
  currency: string;
  cap_cents: number;
  order_id: string | null;
  approval_url: string | null;
  authorization_id: string | null;
  authorization_status: string | null;
  authorization_expires_at: string | null;
  approved_at: string | null;
  authorized_at: string | null;
  created_at: string;
  last_activity_at: string;
  closed_at: string | null;
  capture_id: string | null;
  capture_status: string | null;
  captured_cents: number | null;
  settled_at: string | null;
  settlement_error: string | null;
  settlement_attempts: number;
  /**
   * Opened by open_budget: the paid tools whose first call fails upstream on purpose, as a JSON array ('[]' = none).
   * null when opened through payment_required (the server switch METERMCP_FAIL_FIRST applies instead).
   */
  fail_first: string | null;
  /** Where /approved sends the buyer once the budget is active (an allowlisted origin), or null. */
  return_to: string | null;
}

export interface CallRow {
  session_id: string;
  n: number;
  time: string;
  tool: string;
  price_cents: number;
  status: CallStatus;
  request_hash: string;
  response_hash: string | null;
  error: string | null;
  finished_at: string | null;
}

export type Reservation =
  | { ok: true; n: number; time: string; remainingCents: number }
  | { ok: false; reason: 'not_active'; status: SessionStatus | null }
  | { ok: false; reason: 'over_budget'; remainingCents: number; capCents: number };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  mcp_session TEXT,
  status TEXT NOT NULL,
  currency TEXT NOT NULL,
  cap_cents INTEGER NOT NULL CHECK (cap_cents > 0),
  order_id TEXT UNIQUE,
  approval_url TEXT,
  authorization_id TEXT,
  authorization_status TEXT,
  authorization_expires_at TEXT,
  approved_at TEXT,
  authorized_at TEXT,
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  closed_at TEXT,
  capture_id TEXT,
  capture_status TEXT,
  captured_cents INTEGER,
  settled_at TEXT,
  settlement_error TEXT,
  settlement_attempts INTEGER NOT NULL DEFAULT 0,
  fail_first TEXT,
  return_to TEXT
);
CREATE INDEX IF NOT EXISTS sessions_mcp ON sessions (mcp_session);
CREATE INDEX IF NOT EXISTS sessions_capture ON sessions (capture_id);
CREATE TABLE IF NOT EXISTS calls (
  session_id TEXT NOT NULL REFERENCES sessions (id),
  n INTEGER NOT NULL,
  time TEXT NOT NULL,
  tool TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'OK', 'FAILED')),
  request_hash TEXT NOT NULL,
  response_hash TEXT,
  error TEXT,
  finished_at TEXT,
  PRIMARY KEY (session_id, n)
);
`;

/**
 * Columns added to `sessions` after the first deploy, in order: an older database gains them at start. SCHEMA runs
 * before the migration, so an index on an added column must be created after `migrate`, never in SCHEMA.
 */
const ADDED_COLUMNS: ReadonlyArray<readonly [name: string, type: string]> = [
  ['fail_first', 'TEXT'],
  ['return_to', 'TEXT'],
];

/** The ledger could not be migrated: nothing was changed, and MeterMCP must not start on it. */
export class LedgerMigrationError extends Error {
  override name = 'LedgerMigrationError';
}

export interface LedgerOptions {
  log?: (line: string) => void;
  /** Test seam: called with each migration statement right before it runs; throwing makes the migration fail. */
  migrationStep?: (sql: string) => void;
}

export class Ledger {
  private readonly db: DatabaseSync;

  /** @param file a path under apps/metermcp/data/, or ':memory:' (tests). Throws {@link LedgerMigrationError}. */
  constructor(file: string, opts: LedgerOptions = {}) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.migrate(opts);
    this.recover(opts);
  }

  /**
   * What a previous process left half-done when it stopped (crash, deploy kill, OOM), resolved once at open, in one
   * transaction. A session still `closing` was mid-settlement: it becomes `settlement_failed`, so close retries it
   * (beginClose counts the attempt; a capture that did reach PayPal is replayed with the same PayPal-Request-Id and
   * recorded once). A call still PENDING never got its answer: it becomes FAILED, released and never charged. A
   * ledger with nothing interrupted changes nothing.
   */
  private recover(opts: LedgerOptions): void {
    const now = new Date().toISOString();
    const why = `interrupted by a restart at ${now}`;
    const { sessions, calls } = this.tx(() => ({
      sessions: Number(this.db.prepare("UPDATE sessions SET status = 'settlement_failed', settlement_error = ? WHERE status = 'closing'").run(`Settlement ${why}; close again to retry`).changes),
      calls: Number(this.db.prepare("UPDATE calls SET status = 'FAILED', error = ?, finished_at = ? WHERE status = 'PENDING'").run(`Call ${why}; not charged`, now).changes),
    }));
    const log = opts.log ?? console.error;
    if (sessions) log(`ledger: ${sessions} session(s) left closing by a restart are settlement_failed; close again to retry`);
    if (calls) log(`ledger: ${calls} call(s) left PENDING by a restart are FAILED (not charged)`);
  }

  /**
   * Add the missing {@link ADDED_COLUMNS}, all in one transaction: either every column is added or none is (the
   * schema and rows are left as they were, and the constructor throws). An up-to-date database changes nothing.
   */
  private migrate(opts: LedgerOptions): void {
    const columns = () => new Set((this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((c) => c.name));
    if (ADDED_COLUMNS.every(([name]) => columns().has(name))) return;
    try {
      this.tx(() => {
        const have = columns(); // re-read under the write lock
        for (const [name, type] of ADDED_COLUMNS) {
          if (have.has(name)) continue;
          const sql = `ALTER TABLE sessions ADD COLUMN ${name} ${type}`;
          opts.migrationStep?.(sql);
          this.db.exec(sql);
        }
      });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      (opts.log ?? console.error)(`ledger migration failed, rolled back (nothing changed): ${why}`);
      this.db.close();
      throw new LedgerMigrationError(`Ledger migration failed (rolled back): ${why}`, { cause: e });
    }
  }

  close(): void {
    this.db.close();
  }

  /** Run `fn` in one IMMEDIATE transaction (write lock taken up front); rolled back if it throws. */
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  createSession(s: { id: string; mcpSession: string | null; currency: string; capCents: number; now: string; failFirst: string[] | null; returnTo: string | null }): void {
    this.db
      .prepare('INSERT INTO sessions (id, mcp_session, status, currency, cap_cents, created_at, last_activity_at, fail_first, return_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s.id, s.mcpSession, 'pending_approval', s.currency, s.capCents, s.now, s.now, s.failFirst ? JSON.stringify(s.failFirst) : null, s.returnTo);
  }

  setOrder(id: string, orderId: string, approvalUrl: string): void {
    this.db.prepare('UPDATE sessions SET order_id = ?, approval_url = ? WHERE id = ?').run(orderId, approvalUrl, id);
  }

  session(id: string): SessionRow | null {
    return (this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined) ?? null;
  }

  sessionByOrder(orderId: string): SessionRow | null {
    return (this.db.prepare('SELECT * FROM sessions WHERE order_id = ?').get(orderId) as SessionRow | undefined) ?? null;
  }

  sessionsByCapture(captureId: string): SessionRow[] {
    return this.db.prepare('SELECT * FROM sessions WHERE capture_id = ? ORDER BY created_at').all(captureId) as unknown as SessionRow[];
  }

  /** The MCP session's current payment session: the latest one not yet settled, voided or cancelled. */
  openSessionFor(mcpSession: string): SessionRow | null {
    return (
      (this.db
        .prepare(
          "SELECT * FROM sessions WHERE mcp_session = ? AND status IN ('pending_approval', 'active', 'closing', 'settlement_failed', 'capture_pending') ORDER BY created_at DESC, rowid DESC LIMIT 1",
        )
        .get(mcpSession) as SessionRow | undefined) ?? null
    );
  }

  /** The MCP session's most recent payment session, whatever its status. */
  latestSessionFor(mcpSession: string): SessionRow | null {
    return (this.db.prepare('SELECT * FROM sessions WHERE mcp_session = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(mcpSession) as SessionRow | undefined) ?? null;
  }

  sessionsWithStatus(status: SessionStatus): SessionRow[] {
    return this.db.prepare('SELECT * FROM sessions WHERE status = ?').all(status) as unknown as SessionRow[];
  }

  /** pending_approval → active, once PayPal has authorized the budget. Only from pending_approval. */
  activate(id: string, a: { authorizationId: string; authorizationStatus: string | null; expiresAt: string | null; approvedAt: string; authorizedAt: string | null }): boolean {
    const r = this.db
      .prepare(
        "UPDATE sessions SET status = 'active', authorization_id = ?, authorization_status = ?, authorization_expires_at = ?, approved_at = ?, authorized_at = ?, last_activity_at = ? WHERE id = ? AND status = 'pending_approval'",
      )
      .run(a.authorizationId, a.authorizationStatus, a.expiresAt, a.approvedAt, a.authorizedAt, a.approvedAt, id);
    return r.changes === 1;
  }

  cancel(id: string, now: string, reason: string | null = null): boolean {
    const r = this.db
      .prepare("UPDATE sessions SET status = 'cancelled', closed_at = ?, settlement_error = ? WHERE id = ? AND status = 'pending_approval'")
      .run(now, reason, id);
    return r.changes === 1;
  }

  /**
   * Reserve `priceCents` for a call, atomically. Refused when the session is not active or when OK + in-flight
   * calls + this price would exceed the cap. The reservation is the PENDING call row.
   */
  reserve(id: string, tool: string, priceCents: number, now: string, hash: (n: number) => string): Reservation {
    if (!Number.isSafeInteger(priceCents) || priceCents <= 0) throw new Error(`Invalid price ${priceCents}`);
    return this.tx(() => {
      const s = this.db.prepare('SELECT status, cap_cents FROM sessions WHERE id = ?').get(id) as { status: SessionStatus; cap_cents: number } | undefined;
      if (!s || s.status !== 'active') return { ok: false, reason: 'not_active', status: s?.status ?? null };
      const used = this.usedCents(id);
      if (!Number.isSafeInteger(used) || !Number.isSafeInteger(s.cap_cents)) throw new Error('Ledger totals unreadable');
      if (used + priceCents > s.cap_cents) return { ok: false, reason: 'over_budget', remainingCents: s.cap_cents - used, capCents: s.cap_cents };
      const { next } = this.db.prepare('SELECT COALESCE(MAX(n), 0) + 1 AS next FROM calls WHERE session_id = ?').get(id) as { next: number };
      this.db
        .prepare("INSERT INTO calls (session_id, n, time, tool, price_cents, status, request_hash) VALUES (?, ?, ?, ?, ?, 'PENDING', ?)")
        .run(id, next, now, tool, priceCents, hash(next));
      this.db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?').run(now, id);
      return { ok: true, n: next, time: now, remainingCents: s.cap_cents - used - priceCents };
    });
  }

  /** The upstream call succeeded: the reservation becomes a charge. */
  commit(id: string, n: number, responseHash: string, now: string): void {
    this.db.prepare("UPDATE calls SET status = 'OK', response_hash = ?, finished_at = ? WHERE session_id = ? AND n = ? AND status = 'PENDING'").run(responseHash, now, id, n);
    this.db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?').run(now, id);
  }

  /** The upstream call failed: the reservation is released and the call is never charged. */
  release(id: string, n: number, error: string, now: string): void {
    this.db.prepare("UPDATE calls SET status = 'FAILED', error = ?, finished_at = ? WHERE session_id = ? AND n = ? AND status = 'PENDING'").run(error, now, id, n);
    this.db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?').run(now, id);
  }

  /** OK calls plus in-flight reservations. */
  usedCents(id: string): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(price_cents), 0) AS c FROM calls WHERE session_id = ? AND status IN ('OK', 'PENDING')").get(id) as { c: number };
    return r.c;
  }

  /** What settlement captures: OK calls only. */
  chargedCents(id: string): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(price_cents), 0) AS c FROM calls WHERE session_id = ? AND status = 'OK'").get(id) as { c: number };
    return r.c;
  }

  calls(id: string): CallRow[] {
    return this.db.prepare('SELECT * FROM calls WHERE session_id = ? ORDER BY n').all(id) as unknown as CallRow[];
  }

  /**
   * active (or settlement_failed, for a retry) → closing, only when no call is in flight. Returns the reason when
   * it cannot close now.
   */
  beginClose(id: string, now: string): { ok: true } | { ok: false; reason: 'not_found' | 'in_flight' | 'wrong_status'; status?: SessionStatus } {
    return this.tx(() => {
      const s = this.db.prepare('SELECT status FROM sessions WHERE id = ?').get(id) as { status: SessionStatus } | undefined;
      if (!s) return { ok: false, reason: 'not_found' };
      if (s.status !== 'active' && s.status !== 'settlement_failed') return { ok: false, reason: 'wrong_status', status: s.status };
      const p = this.db.prepare("SELECT COUNT(*) AS c FROM calls WHERE session_id = ? AND status = 'PENDING'").get(id) as { c: number };
      if (p.c > 0) return { ok: false, reason: 'in_flight' };
      this.db
        .prepare("UPDATE sessions SET status = 'closing', closed_at = COALESCE(closed_at, ?), settlement_attempts = settlement_attempts + 1 WHERE id = ?")
        .run(now, id);
      return { ok: true };
    });
  }

  /**
   * closing → settled when PayPal reports the capture COMPLETED; → capture_pending (no settled_at, nothing claimed)
   * when it reports PENDING. The capture id and amount are recorded either way.
   */
  settled(id: string, c: { captureId: string; captureStatus: string | null; capturedCents: number; authorizationStatus: string | null; now: string }): void {
    const pending = c.captureStatus === 'PENDING';
    this.db
      .prepare(
        "UPDATE sessions SET status = ?, capture_id = ?, capture_status = ?, captured_cents = ?, authorization_status = COALESCE(?, authorization_status), settled_at = ?, settlement_error = NULL WHERE id = ? AND status = 'closing'",
      )
      .run(pending ? 'capture_pending' : 'settled', c.captureId, c.captureStatus, c.capturedCents, c.authorizationStatus, pending ? null : c.now, id);
  }

  /** capture_pending → settled, once (a second reconciliation changes nothing). True when this call made the change. */
  captureCompleted(id: string, now: string): boolean {
    const r = this.db.prepare("UPDATE sessions SET status = 'settled', capture_status = 'COMPLETED', settled_at = ? WHERE id = ? AND status = 'capture_pending'").run(now, id);
    return r.changes === 1;
  }

  /** capture_pending → capture_declined: the attempt stays on record (capture id, amount asked), nothing is charged. */
  captureDeclined(id: string, captureStatus: string, now: string): boolean {
    const r = this.db
      .prepare("UPDATE sessions SET status = 'capture_declined', capture_status = ?, settlement_error = ?, settled_at = NULL WHERE id = ? AND status = 'capture_pending'")
      .run(captureStatus, `PayPal reported the capture ${captureStatus} at ${now}: not charged`, id);
    return r.changes === 1;
  }

  /** closing → capture_declined: PayPal refused the capture outright (DECLINED/FAILED); on record, nothing charged. */
  declinedAtClose(id: string, c: { captureId: string; captureStatus: string; capturedCents: number; reason: string | null; now: string }): void {
    this.db
      .prepare("UPDATE sessions SET status = 'capture_declined', capture_id = ?, capture_status = ?, captured_cents = ?, settlement_error = ?, settled_at = NULL WHERE id = ? AND status = 'closing'")
      .run(c.captureId, c.captureStatus, c.capturedCents, `PayPal answered the capture ${c.captureStatus}${c.reason ? ` (${c.reason})` : ''} at ${c.now}: not charged`, id);
  }

  voided(id: string, c: { authorizationStatus: string | null; now: string }): void {
    this.db
      .prepare("UPDATE sessions SET status = 'voided', authorization_status = ?, captured_cents = 0, settled_at = ?, settlement_error = NULL WHERE id = ? AND status = 'closing'")
      .run(c.authorizationStatus, c.now, id);
  }

  settlementFailed(id: string, error: string): void {
    this.db.prepare("UPDATE sessions SET status = 'settlement_failed', settlement_error = ? WHERE id = ? AND status = 'closing'").run(error, id);
  }

  /** Active sessions with no activity since `before` (ISO). */
  idleSince(before: string): SessionRow[] {
    return this.db.prepare("SELECT * FROM sessions WHERE status = 'active' AND last_activity_at < ?").all(before) as unknown as SessionRow[];
  }
}
