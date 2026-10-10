/**
 * Merchant accounts for hosted mode: who is signed in, for which merchant, with which role.
 *
 * - A workspace is one merchant, identified by its PayPal account (the payer id it approves with, see
 *   packages/paypal identity.ts). Signing in with PayPal makes that account's person the workspace Owner.
 * - Members join an Owner's workspace through an invite link (one-time, or a reviewer link with a use limit and an
 *   access end date), with a passkey, or for one browser only when the device has none.
 * - A session is a cookie signed with the server's secret naming the person and the person's session epoch: revoking
 *   the person or "sign out of all devices" (epoch + 1) ends every session at once.
 *
 * Bounded: new workspaces, people, invites and passkeys are refused past their limits (nothing is evicted). Written
 * to the data dir; a write that does not reach the disk refuses the change it was for (StorageError → 503), because
 * a membership or passkey that exists only in memory would vanish on restart. Stored: payer ids, display names, the
 * email masked, passkey public keys, invite token hashes. No PayPal tokens, no invite tokens, no secrets.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type Role = 'owner' | 'member';
export type JoinedVia = 'paypal' | 'passkey' | 'browser';

export interface Workspace {
  id: string;
  /** The merchant's PayPal payer id (= seller.merchant_id on its disputes). */
  payerId: string;
  name: string;
  createdAt: string;
}

export interface Person {
  id: string;
  workspaceId: string;
  role: Role;
  name: string;
  /** Masked, e.g. j•••@example.com (owners signed in with PayPal); null for members. */
  email: string | null;
  via: JoinedVia;
  /** Joined through a reviewer link (hackathon judges). */
  reviewer: boolean;
  /** Access ends then (reviewer links); null: no end. */
  accessUntil: string | null;
  /** The invite it joined with (members). */
  inviteId: string | null;
  createdAt: string;
  lastActiveAt: string;
  revokedAt: string | null;
  /** Sessions carry it; +1 ends them all. */
  epoch: number;
}

export interface Credential {
  /** base64url credential id. */
  id: string;
  personId: string;
  /** base64url COSE public key. */
  publicKey: string;
  counter: number;
  transports: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export interface Invite {
  id: string;
  /** sha256 of the token (the token itself is only ever in the link). */
  tokenHash: string;
  workspaceId: string;
  label: string;
  reviewer: boolean;
  maxUses: number;
  uses: number;
  expiresAt: string;
  /** Reviewer links: people who join keep access until then. */
  accessUntil: string | null;
  revokedAt: string | null;
  createdBy: string;
  createdAt: string;
}

export const LIMITS = {
  workspaces: 2000,
  people: 5000,
  peoplePerWorkspace: 300,
  invitesPerWorkspace: 50,
  credentialsPerPerson: 5,
  maxUses: 300,
  inviteTtlMs: 120 * 24 * 60 * 60_000,
};

export const SESSION_COOKIE = 'rk_session';
export const SESSION_TTL_MS = 12 * 60 * 60_000;
export const NAME_RULE = /^[\p{L}\p{N} .,'’()&-]{1,60}$/u;

export class StorageError extends Error {
  constructor() {
    super('The account change could not be recorded durably');
    this.name = 'StorageError';
  }
}

export type InviteCheck =
  | { ok: true; invite: Invite; workspace: Workspace }
  | { ok: false; error: 'INVITE_UNKNOWN' | 'INVITE_EXPIRED' | 'INVITE_USED' | 'INVITE_REVOKED'; detail: string };

export type SessionCheck = { ok: true; person: Person; workspace: Workspace; expiresAt: number } | { ok: false; reason: string };

const b64url = (b: Buffer) => b.toString('base64url');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const id = (prefix: string) => `${prefix}_${b64url(randomBytes(12))}`;

/** j•••@example.com */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email || !email.includes('@')) return null;
  const [user, domain] = [email.slice(0, email.lastIndexOf('@')), email.slice(email.lastIndexOf('@') + 1)];
  return `${user.slice(0, 1)}•••@${domain}`;
}

/** A display name made safe: trimmed, single spaces, only letters, digits and plain punctuation, 60 chars. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  return NAME_RULE.test(s) ? s : null;
}

export function workspaceIdFor(payerId: string): string {
  return `ws_${sha256(`rk-workspace|${payerId}`).slice(0, 20)}`;
}

interface State {
  workspaces: Workspace[];
  people: Person[];
  credentials: Credential[];
  invites: Invite[];
}

export class AccountStore {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly people = new Map<string, Person>();
  private readonly credentials = new Map<string, Credential>();
  private readonly invites = new Map<string, Invite>();
  private readonly file: string | null;
  private readonly now: () => Date;

  constructor(o: { file?: string | null; now?: () => Date } = {}) {
    this.file = o.file ?? null;
    this.now = o.now ?? (() => new Date());
    if (this.file) {
      let raw: string | null = null;
      try {
        raw = readFileSync(this.file, 'utf8');
      } catch {
        /* no accounts yet */
      }
      // A file that exists but cannot be read as accounts stops the start: starting empty would silently drop every
      // membership and passkey.
      if (raw != null) {
        const s = JSON.parse(raw) as State;
        for (const w of s.workspaces ?? []) this.workspaces.set(w.id, w);
        for (const p of s.people ?? []) this.people.set(p.id, p);
        for (const c of s.credentials ?? []) this.credentials.set(c.id, c);
        for (const i of s.invites ?? []) this.invites.set(i.id, i);
      }
    }
  }

  private iso() {
    return this.now().toISOString();
  }

  /** Apply a change and write it; when the write fails the change is undone and StorageError thrown. */
  private commit<T>(change: () => T, undo: () => void): T {
    const out = change();
    if (!this.file) return out;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const state: State = { workspaces: [...this.workspaces.values()], people: [...this.people.values()], credentials: [...this.credentials.values()], invites: [...this.invites.values()] };
      writeFileSync(`${this.file}.tmp`, JSON.stringify(state));
      renameSync(`${this.file}.tmp`, this.file);
    } catch {
      undo();
      throw new StorageError();
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ workspaces

  workspace(id: string): Workspace | null {
    return this.workspaces.get(id) ?? null;
  }

  /** The person a PayPal sign-in stands for: the Owner of the workspace of that payer id (created on first sign-in). */
  signInWithPayPal(p: { payerId: string; name: string; email: string | null; workspaceName?: string | null }): { person: Person; workspace: Workspace; created: boolean } | { refused: string } {
    const wsId = workspaceIdFor(p.payerId);
    const existing = this.workspaces.get(wsId);
    const owner = existing && [...this.people.values()].find((x) => x.workspaceId === wsId && x.role === 'owner' && x.via === 'paypal' && !x.revokedAt);
    const name = cleanName(p.name) ?? 'PayPal merchant';
    const wsName = cleanName(p.workspaceName) ?? null;
    const email = maskEmail(p.email);
    if (existing && owner) {
      const before = { ...owner };
      const wsBefore = existing.name;
      this.commit(
        () => {
          Object.assign(owner, { name, email, lastActiveAt: this.iso() });
          if (wsName) existing.name = wsName;
        },
        () => {
          Object.assign(owner, before);
          existing.name = wsBefore;
        },
      );
      return { person: owner, workspace: existing, created: false };
    }
    if (!existing && this.workspaces.size >= LIMITS.workspaces) return { refused: 'This demo has reached its number of merchant workspaces' };
    if (this.people.size >= LIMITS.people) return { refused: 'This demo has reached its number of people' };
    const at = this.iso();
    const ws: Workspace = existing ?? { id: wsId, payerId: p.payerId, name: wsName ?? name, createdAt: at };
    const person: Person = { id: id('p'), workspaceId: wsId, role: 'owner', name, email, via: 'paypal', reviewer: false, accessUntil: null, inviteId: null, createdAt: at, lastActiveAt: at, revokedAt: null, epoch: 0 };
    this.commit(
      () => {
        this.workspaces.set(ws.id, ws);
        this.people.set(person.id, person);
      },
      () => {
        if (!existing) this.workspaces.delete(ws.id);
        this.people.delete(person.id);
      },
    );
    return { person, workspace: ws, created: !existing };
  }

  // ------------------------------------------------------------------------------------------------ people

  person(id: string): Person | null {
    return this.people.get(id) ?? null;
  }

  members(workspaceId: string): Person[] {
    return [...this.people.values()].filter((p) => p.workspaceId === workspaceId);
  }

  /** Whether the person may act now (not revoked, access not ended). */
  active(p: Person): boolean {
    return !p.revokedAt && (!p.accessUntil || Date.parse(p.accessUntil) > this.now().getTime());
  }

  /** Revoke a member of `workspaceId` (never an Owner, never someone else's member): their sessions end at once. */
  revoke(workspaceId: string, personId: string): Person | null {
    const p = this.people.get(personId);
    if (!p || p.workspaceId !== workspaceId || p.role === 'owner' || p.revokedAt) return null;
    const before = { ...p };
    this.commit(
      () => Object.assign(p, { revokedAt: this.iso(), epoch: p.epoch + 1 }),
      () => Object.assign(p, before),
    );
    return p;
  }

  /** Sign out everywhere: every session of this person ends. */
  bumpEpoch(personId: string): void {
    const p = this.people.get(personId);
    if (!p) return;
    const before = p.epoch;
    this.commit(
      () => (p.epoch += 1),
      () => (p.epoch = before),
    );
  }

  /** Best effort (not worth refusing a request over). */
  touch(p: Person): void {
    p.lastActiveAt = this.iso();
  }

  // ------------------------------------------------------------------------------------------------ invites

  /** A new invite link token for `workspaceId`; the token is returned once and only its hash is kept. */
  createInvite(o: { workspaceId: string; createdBy: string; label: string; reviewer: boolean; maxUses: number; ttlMs: number; accessUntil: string | null }): { invite: Invite; token: string } | { refused: string } {
    const open = [...this.invites.values()].filter((i) => i.workspaceId === o.workspaceId && !i.revokedAt && Date.parse(i.expiresAt) > this.now().getTime());
    if (open.length >= LIMITS.invitesPerWorkspace) return { refused: `A workspace keeps at most ${LIMITS.invitesPerWorkspace} open invites; revoke one first` };
    const token = b64url(randomBytes(32));
    const at = this.now().getTime();
    const invite: Invite = {
      id: id('inv'),
      tokenHash: sha256(token),
      workspaceId: o.workspaceId,
      label: o.label,
      reviewer: o.reviewer,
      maxUses: Math.min(Math.max(1, Math.floor(o.maxUses)), LIMITS.maxUses),
      uses: 0,
      expiresAt: new Date(at + Math.min(o.ttlMs, LIMITS.inviteTtlMs)).toISOString(),
      accessUntil: o.accessUntil,
      revokedAt: null,
      createdBy: o.createdBy,
      createdAt: new Date(at).toISOString(),
    };
    this.commit(
      () => this.invites.set(invite.id, invite),
      () => this.invites.delete(invite.id),
    );
    return { invite, token };
  }

  invitesOf(workspaceId: string): Invite[] {
    return [...this.invites.values()].filter((i) => i.workspaceId === workspaceId);
  }

  revokeInvite(workspaceId: string, inviteId: string): Invite | null {
    const i = this.invites.get(inviteId);
    if (!i || i.workspaceId !== workspaceId || i.revokedAt) return null;
    this.commit(
      () => (i.revokedAt = this.iso()),
      () => (i.revokedAt = null),
    );
    return i;
  }

  /** What an invite token opens, or why it opens nothing. Does not use it. */
  checkInvite(token: unknown): InviteCheck {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return { ok: false, error: 'INVITE_UNKNOWN', detail: 'This invite link is not valid' };
    const h = Buffer.from(sha256(token));
    const invite = [...this.invites.values()].find((i) => {
      const x = Buffer.from(i.tokenHash);
      return x.length === h.length && timingSafeEqual(x, h);
    });
    const workspace = invite && this.workspaces.get(invite.workspaceId);
    if (!invite || !workspace) return { ok: false, error: 'INVITE_UNKNOWN', detail: 'This invite link is not valid' };
    if (invite.revokedAt) return { ok: false, error: 'INVITE_REVOKED', detail: 'This invite was revoked by the workspace owner' };
    if (Date.parse(invite.expiresAt) <= this.now().getTime()) return { ok: false, error: 'INVITE_EXPIRED', detail: 'This invite has expired' };
    if (invite.uses >= invite.maxUses) return { ok: false, error: 'INVITE_USED', detail: invite.maxUses === 1 ? 'This invite was already used' : 'This invite has no uses left' };
    return { ok: true, invite, workspace };
  }

  /**
   * Use one of the invite's uses and add the member, in one synchronous step (two joins cannot both take the last
   * use). With `credential`, the passkey is stored with the person.
   */
  join(token: string, o: { name: string; via: 'passkey' | 'browser'; credential?: Omit<Credential, 'personId' | 'createdAt' | 'lastUsedAt'> }): { person: Person; workspace: Workspace } | { refused: string; error: string } {
    const c = this.checkInvite(token);
    if (!c.ok) return { refused: c.detail, error: c.error };
    const { invite, workspace } = c;
    if (this.members(workspace.id).length >= LIMITS.peoplePerWorkspace || this.people.size >= LIMITS.people) return { refused: 'This workspace has reached its number of members', error: 'WORKSPACE_FULL' };
    if (o.credential && this.credentials.has(o.credential.id)) return { refused: 'This passkey is already registered', error: 'CREDENTIAL_EXISTS' };
    const at = this.iso();
    const person: Person = {
      id: id('p'),
      workspaceId: workspace.id,
      role: 'member',
      name: o.name,
      email: null,
      via: o.via,
      reviewer: invite.reviewer,
      accessUntil: invite.accessUntil,
      inviteId: invite.id,
      createdAt: at,
      lastActiveAt: at,
      revokedAt: null,
      epoch: 0,
    };
    const cred: Credential | null = o.credential ? { ...o.credential, personId: person.id, createdAt: at, lastUsedAt: at } : null;
    this.commit(
      () => {
        invite.uses += 1;
        this.people.set(person.id, person);
        if (cred) this.credentials.set(cred.id, cred);
      },
      () => {
        invite.uses -= 1;
        this.people.delete(person.id);
        if (cred) this.credentials.delete(cred.id);
      },
    );
    return { person, workspace };
  }

  // ------------------------------------------------------------------------------------------------ passkeys

  credential(id: string): Credential | null {
    return this.credentials.get(id) ?? null;
  }

  credentialsOf(personId: string): Credential[] {
    return [...this.credentials.values()].filter((c) => c.personId === personId);
  }

  /** After a verified sign-in: the authenticator's new counter. */
  usedCredential(credId: string, counter: number): void {
    const c = this.credentials.get(credId);
    if (!c) return;
    const before = { counter: c.counter, lastUsedAt: c.lastUsedAt };
    this.commit(
      () => Object.assign(c, { counter, lastUsedAt: this.iso() }),
      () => Object.assign(c, before),
    );
  }
}

// -------------------------------------------------------------------------------------------------- sessions

const SESSION = /^v1\.(p_[A-Za-z0-9_-]{16})\.(\d{1,9})\.(\d{1,16})\.([A-Za-z0-9_-]{43})$/;
const mac = (secret: string, payload: string) => createHmac('sha256', secret).update(`rk-session|${payload}`).digest('base64url');

export function signSession(secret: string, p: Pick<Person, 'id' | 'epoch'>, expiresAtMs: number): string {
  const payload = `v1.${p.id}.${p.epoch}.${Math.floor(expiresAtMs)}`;
  return `${payload}.${mac(secret, payload)}`;
}

/** Signature (constant time), expiry, and the person as stored now: active, same epoch. */
export function verifySession(secret: string, value: string | null, store: AccountStore, nowMs: number, ttlMs = SESSION_TTL_MS): SessionCheck {
  if (!value) return { ok: false, reason: 'missing' };
  const m = SESSION.exec(value);
  if (!m) return { ok: false, reason: 'malformed' };
  const expected = Buffer.from(mac(secret, `v1.${m[1]}.${m[2]}.${m[3]}`));
  const got = Buffer.from(m[4]!);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return { ok: false, reason: 'bad_signature' };
  const exp = Number(m[3]);
  if (exp <= nowMs || exp > nowMs + ttlMs + 60_000) return { ok: false, reason: 'expired' };
  const person = store.person(m[1]!);
  if (!person) return { ok: false, reason: 'unknown_person' };
  if (person.epoch !== Number(m[2])) return { ok: false, reason: 'signed_out' };
  if (!store.active(person)) return { ok: false, reason: person.revokedAt ? 'revoked' : 'access_ended' };
  const workspace = store.workspace(person.workspaceId);
  if (!workspace) return { ok: false, reason: 'unknown_workspace' };
  return { ok: true, person, workspace, expiresAt: exp };
}

export function sessionCookie(value: string, maxAgeSec: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}; HttpOnly; Secure; SameSite=Strict`;
}
