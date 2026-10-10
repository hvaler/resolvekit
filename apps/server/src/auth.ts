/**
 * Sign-in routes of hosted mode (see accounts.ts for the model).
 *
 * PayPal (merchant Owner):
 *   POST /api/auth/paypal/start            → { approvalUrl }: a no-charge agreement token of the PLATFORM's PayPal app
 *                                            (packages/paypal identity.ts), bound to this browser by a short-lived
 *                                            signed cookie (SameSite=Lax: PayPal's redirect back is a cross-site GET)
 *   GET  /api/auth/paypal/return/:k?ba_token → signs in as the Owner of the approving account's workspace, only when
 *                                            BOTH hold: the browser holds the pending cookie of this token (it started
 *                                            the sign-in) and the path carries `k`, a key PayPal only reveals by
 *                                            redirecting the approver's browser to the return URL. The token id alone
 *                                            proves nothing (it is in the approval link): an attacker who starts a
 *                                            sign-in and gets a merchant to approve the link has the cookie but not
 *                                            `k`; the merchant's browser has `k` but not the cookie. Each token gets
 *                                            one attempt: an arrival without the cookie (the approver coming back) or
 *                                            before the approval burns it, so even if PayPal's page showed `k`, an
 *                                            attacker could not wait for the merchant's approval and use it.
 *   GET  /api/auth/paypal/cancel           → back to the sign-in page
 * Invites and passkeys (Members):
 *   POST /api/auth/invite/inspect {token}                 → what the invite opens (or why not), without using it
 *   POST /api/auth/invite/join {token, name}              → join for this browser only (no passkey)
 *   POST /api/auth/passkey/register/options {token, name} → WebAuthn creation options for joining
 *   POST /api/auth/passkey/register/verify {response}     → verified passkey: join and sign in
 *   POST /api/auth/passkey/login/options                  → WebAuthn request options (discoverable credentials)
 *   POST /api/auth/passkey/login/verify {response}        → verified assertion: sign in
 * Session:
 *   GET  /api/auth/me · POST /api/auth/signout {everywhere?}
 * Workspace (Owner only):
 *   GET  /api/workspace/members · POST /api/workspace/invites {label, reviewer, maxUses, ttlDays, accessUntil?}
 *   POST /api/workspace/invites/:id/revoke · POST /api/workspace/members/:id/revoke
 *
 * PayPal tokens are never stored or returned; invite tokens are returned once (in the link) and kept as hashes.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PayPalClient } from '@resolvekit/paypal';
import { isAgreementTokenId } from '@resolvekit/paypal';
import { readCookie } from '@resolvekit/hosting';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { AccountStore, SESSION_COOKIE, SESSION_TTL_MS, StorageError, cleanName, sessionCookie, signSession, verifySession, type Invite, type Person, type SessionCheck, type Workspace } from './accounts.ts';
import { json } from './app.ts';

export const PENDING_COOKIE = 'rk_pp';
const PENDING_TTL_MS = 15 * 60_000;
const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_CHALLENGES = 2000;
const MAX_USED_TOKENS = 5000;
/** PayPal redirects after approving; its token status may lag by a moment. */
const APPROVAL_RETRIES = 3;
const APPROVAL_RETRY_MS = 1_000;
const DAY = 24 * 60 * 60_000;

/** The WebAuthn calls, injectable so tests need no authenticator. */
export interface WebAuthn {
  registrationOptions: typeof generateRegistrationOptions;
  verifyRegistration: typeof verifyRegistrationResponse;
  authenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthentication: typeof verifyAuthenticationResponse;
}
const LIBRARY: WebAuthn = {
  registrationOptions: generateRegistrationOptions,
  verifyRegistration: verifyRegistrationResponse,
  authenticationOptions: generateAuthenticationOptions,
  verifyAuthentication: verifyAuthenticationResponse,
};

export interface AuthOptions {
  accounts: AccountStore;
  /** The platform's PayPal app (PAYPAL_IDENTITY_CLIENT_ID/SECRET); null: PayPal sign-in is off. */
  identity: PayPalClient | null;
  /** HMAC key of the session and pending cookies. */
  secret: string;
  /** The service's public origins; the first one builds PayPal's return URLs and is the passkeys' relying party. */
  origins: readonly string[];
  /** Whether this payer id is the seller on the bound PayPal disputes (fresh reads). */
  isConnected: (payerId: string) => Promise<boolean>;
  now?: () => Date;
  log?: (line: string) => void;
  webauthn?: WebAuthn;
}

export interface Auth {
  /** /api/auth/* and /api/workspace/*; null for any other path. */
  route(req: Request, path: string): Promise<Response> | null;
  session(req: Request): SessionCheck;
}

const mac = (secret: string, payload: string) => createHmac('sha256', secret).update(`rk-pending|${payload}`).digest('base64url');
/** The return URL's key for a pending sign-in's nonce (43 chars). */
const returnKey = (secret: string, nonce: string) => createHmac('sha256', secret).update(`rk-return|${nonce}`).digest('base64url');

function redirect(to: string, cookies: string[] = []): Response {
  const r = new Response(null, { status: 303, headers: { location: to, 'cache-control': 'no-store' } });
  for (const c of cookies) r.headers.append('set-cookie', c);
  return r;
}

const pendingCookie = (value: string, maxAgeSec: number) => `${PENDING_COOKIE}=${value}; Path=/api/auth/paypal; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}; HttpOnly; Secure; SameSite=Lax`;

/** What a person looks like to the web app. */
export function publicPerson(p: Person) {
  return { id: p.id, name: p.name, role: p.role, via: p.via, email: p.email, reviewer: p.reviewer, accessUntil: p.accessUntil };
}

function publicInvite(i: Invite) {
  return { id: i.id, label: i.label, reviewer: i.reviewer, maxUses: i.maxUses, uses: i.uses, expiresAt: i.expiresAt, accessUntil: i.accessUntil, revokedAt: i.revokedAt, createdAt: i.createdAt };
}

/** The audit trail's name for a person: who, in which role, how they signed in, and their id. */
export function actorLabel(p: Person): string {
  return `${p.name} (${p.role === 'owner' ? 'Owner' : p.reviewer ? 'Member, reviewer' : 'Member'} · ${p.via}) ${p.id}`;
}

export function createAuth(o: AuthOptions): Auth {
  const now = o.now ?? (() => new Date());
  const log = o.log ?? (() => {});
  const wa = o.webauthn ?? LIBRARY;
  const origin = o.origins[0]!;
  const rpID = new URL(origin).hostname;
  /** Pending WebAuthn ceremonies by challenge (memory: a restart only means asking again). */
  const challenges = new Map<string, { kind: 'register' | 'login'; exp: number; token?: string; name?: string; userId?: string }>();
  /** Agreement tokens already used to sign in (a token signs in once). */
  const usedTokens = new Set<string>();

  const session = (req: Request) => verifySession(o.secret, readCookie(req, SESSION_COOKIE), o.accounts, now().getTime());
  const signIn = (p: Person) => sessionCookie(signSession(o.secret, p, now().getTime() + SESSION_TTL_MS), SESSION_TTL_MS / 1000);

  const readBody = async (req: Request): Promise<Record<string, unknown> | null> => {
    try {
      const b = await req.json();
      return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const storage = (e: unknown): Response => {
    if (e instanceof StorageError) return json(503, { error: 'ACCOUNTS_UNAVAILABLE', detail: 'The change could not be recorded durably; nothing changed. Try again later' });
    throw e;
  };
  const remember = (challenge: string, v: { kind: 'register' | 'login'; token?: string; name?: string; userId?: string }) => {
    const t = now().getTime();
    for (const [k, x] of challenges) if (x.exp <= t) challenges.delete(k);
    if (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value!);
    challenges.set(challenge, { ...v, exp: t + CHALLENGE_TTL_MS });
  };
  /** The ceremony a client response answers (its clientDataJSON names the challenge), taken once. */
  const takeChallenge = (response: unknown, kind: 'register' | 'login') => {
    try {
      const r = response as { response?: { clientDataJSON?: string } };
      const data = JSON.parse(Buffer.from(String(r.response?.clientDataJSON ?? ''), 'base64url').toString('utf8')) as { challenge?: string };
      const c = data.challenge ? challenges.get(data.challenge) : undefined;
      if (!c || c.kind !== kind || c.exp <= now().getTime()) return null;
      challenges.delete(data.challenge!);
      return { ...c, challenge: data.challenge! };
    } catch {
      return null;
    }
  };

  const me = async (req: Request) => {
    const s = session(req);
    const methods = { paypal: !!o.identity, passkey: true };
    if (!s.ok) return json(200, { signedIn: false, methods });
    o.accounts.touch(s.person);
    return json(200, {
      signedIn: true,
      methods,
      person: publicPerson(s.person),
      workspace: { id: s.workspace.id, name: s.workspace.name, connected: await o.isConnected(s.workspace.payerId) },
      expiresAt: new Date(s.expiresAt).toISOString(),
    });
  };

  // ------------------------------------------------------------------------------------------------ PayPal

  const paypalStart = async () => {
    if (!o.identity) return json(503, { error: 'PAYPAL_SIGNIN_OFF', detail: 'PayPal sign-in is not configured on this server' });
    // `k` is derived from a fresh nonce kept in the signed cookie; it reaches a browser only through PayPal's redirect.
    const nonce = randomBytes(16).toString('base64url');
    let t: { tokenId: string; approvalUrl: string };
    try {
      t = await o.identity.identity.start({
        returnUrl: `${origin}/api/auth/paypal/return/${returnKey(o.secret, nonce)}`,
        cancelUrl: `${origin}/api/auth/paypal/cancel`,
        description: 'ResolveKit: confirm which PayPal account is yours. No charge, no agreement is created.',
      });
    } catch (e) {
      log(`paypal sign-in · start failed · ${e instanceof Error ? e.message : 'error'}`);
      return json(502, { error: 'PAYPAL_UNAVAILABLE', detail: 'PayPal could not start the sign-in; try again in a moment' });
    }
    const exp = now().getTime() + PENDING_TTL_MS;
    const payload = `${t.tokenId}.${nonce}.${exp}`;
    const r = json(200, { approvalUrl: t.approvalUrl });
    r.headers.set('set-cookie', pendingCookie(`${payload}.${mac(o.secret, payload)}`, PENDING_TTL_MS / 1000));
    return r;
  };

  const paypalReturn = async (req: Request, url: URL, k: string) => {
    const clear = pendingCookie('', 0);
    const fail = (code: string) => redirect(`/signin?error=${code}`, [clear]);
    if (!o.identity) return fail('paypal_off');
    const token = url.searchParams.get('ba_token') ?? url.searchParams.get('token');
    // Any arrival for a token without its starting browser's cookie burns that token: it is the approver's browser
    // coming back from a link it did not start (phishing), or someone trying tokens. Nobody can finish it afterwards.
    const burn = () => {
      if (isAgreementTokenId(token)) {
        usedTokens.add(token);
        if (usedTokens.size > MAX_USED_TOKENS) usedTokens.delete(usedTokens.values().next().value!);
      }
    };
    // The token must be the one this browser started (signed cookie, not expired, not used before), AND the path must
    // carry the key of that cookie's nonce, which reaches a browser through PayPal's redirect of the approver.
    const m = /^(BA-[A-Z0-9]{8,32})\.([A-Za-z0-9_-]{22})\.(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(readCookie(req, PENDING_COOKIE) ?? '');
    if (!m || !isAgreementTokenId(token) || m[1] !== token) {
      burn();
      return fail('session_mismatch');
    }
    const expected = Buffer.from(mac(o.secret, `${m[1]}.${m[2]}.${m[3]}`));
    const got = Buffer.from(m[4]!);
    if (expected.length !== got.length || !timingSafeEqual(expected, got) || Number(m[3]) <= now().getTime()) return fail('session_mismatch');
    const wantK = Buffer.from(returnKey(o.secret, m[2]!));
    const gotK = Buffer.from(k);
    if (wantK.length !== gotK.length || !timingSafeEqual(wantK, gotK)) return fail('session_mismatch');
    if (usedTokens.has(token)) return fail('session_mismatch');
    // One attempt per token: whatever happens next, it cannot be finished again. An early arrival (before the approval)
    // therefore ends the sign-in, so nobody can poll this URL waiting for someone else's approval; PayPal redirects only
    // after approving, so the read is retried briefly in case its status lags the redirect.
    burn();
    let state;
    try {
      state = await o.identity.identity.read(token);
      for (let i = 0; !state.payer && i < APPROVAL_RETRIES; i++) {
        await new Promise((r) => setTimeout(r, APPROVAL_RETRY_MS));
        state = await o.identity.identity.read(token);
      }
    } catch (e) {
      log(`paypal sign-in · read failed · ${e instanceof Error ? e.message : 'error'}`);
      return fail('paypal_unavailable');
    }
    if (!state.payer) return fail('not_approved');
    const p = state.payer;
    const name = [p.firstName, p.lastName].filter(Boolean).join(' ') || 'PayPal merchant';
    let r;
    try {
      r = o.accounts.signInWithPayPal({ payerId: p.payerId, name, email: p.email });
    } catch (e) {
      if (e instanceof StorageError) return fail('unavailable');
      throw e;
    }
    if ('refused' in r) return fail('full');
    const connected = await o.isConnected(r.workspace.payerId);
    log(`paypal sign-in · workspace ${r.workspace.id}${r.created ? ' (new)' : ''} · ${connected ? 'seller of the bound disputes' : 'not the seller of any bound dispute'}`);
    return redirect('/?signed-in=paypal', [clear, signIn(r.person)]);
  };

  // ------------------------------------------------------------------------------------------------ invites, passkeys

  const inviteView = (c: { invite: Invite; workspace: Workspace }) => ({
    workspace: { name: c.workspace.name },
    role: 'member',
    reviewer: c.invite.reviewer,
    expiresAt: c.invite.expiresAt,
    accessUntil: c.invite.accessUntil,
    usesLeft: c.invite.maxUses - c.invite.uses,
  });
  const inviteRefusal = (c: { error: string; detail: string }) => json(c.error === 'INVITE_UNKNOWN' ? 404 : 410, { error: c.error, detail: c.detail });

  const inspect = async (req: Request) => {
    const b = await readBody(req);
    const c = o.accounts.checkInvite(b?.token);
    return c.ok ? json(200, inviteView(c)) : inviteRefusal(c);
  };

  const joinBrowser = async (req: Request) => {
    const b = await readBody(req);
    const name = cleanName(b?.name);
    if (!name) return json(400, { error: 'INVALID_NAME', detail: 'A name of 1-60 letters, digits or plain punctuation' });
    try {
      const r = o.accounts.join(String(b?.token ?? ''), { name, via: 'browser' });
      if ('refused' in r) return r.error.startsWith('INVITE_') ? inviteRefusal({ error: r.error, detail: r.refused }) : json(409, { error: r.error, detail: r.refused });
      const res = json(200, { person: publicPerson(r.person), workspace: { name: r.workspace.name } });
      res.headers.set('set-cookie', signIn(r.person));
      return res;
    } catch (e) {
      return storage(e);
    }
  };

  const registerOptions = async (req: Request) => {
    const b = await readBody(req);
    const name = cleanName(b?.name);
    if (!name) return json(400, { error: 'INVALID_NAME', detail: 'A name of 1-60 letters, digits or plain punctuation' });
    const c = o.accounts.checkInvite(b?.token);
    if (!c.ok) return inviteRefusal(c);
    const userId = randomBytes(16);
    const options = await wa.registrationOptions({
      rpName: 'ResolveKit',
      rpID,
      userName: `${name} · ${c.workspace.name}`.slice(0, 64),
      userDisplayName: name,
      userID: userId,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    remember(options.challenge, { kind: 'register', token: String(b!.token), name, userId: userId.toString('base64url') });
    return json(200, options);
  };

  const registerVerify = async (req: Request) => {
    const b = await readBody(req);
    const c = takeChallenge(b?.response, 'register');
    if (!c) return json(400, { error: 'CHALLENGE_UNKNOWN', detail: 'This passkey request expired; start again' });
    let v;
    try {
      v = await wa.verifyRegistration({ response: b!.response as never, expectedChallenge: c.challenge, expectedOrigin: [...o.origins], expectedRPID: rpID, requireUserVerification: false });
    } catch {
      return json(400, { error: 'PASSKEY_REJECTED', detail: 'The passkey could not be verified' });
    }
    if (!v.verified || !v.registrationInfo) return json(400, { error: 'PASSKEY_REJECTED', detail: 'The passkey could not be verified' });
    const cred = v.registrationInfo.credential;
    try {
      const r = o.accounts.join(c.token!, {
        name: c.name!,
        via: 'passkey',
        credential: { id: cred.id, publicKey: Buffer.from(cred.publicKey).toString('base64url'), counter: cred.counter, transports: (cred.transports ?? []).map(String) },
      });
      if ('refused' in r) return r.error.startsWith('INVITE_') ? inviteRefusal({ error: r.error, detail: r.refused }) : json(409, { error: r.error, detail: r.refused });
      const res = json(200, { person: publicPerson(r.person), workspace: { name: r.workspace.name } });
      res.headers.set('set-cookie', signIn(r.person));
      return res;
    } catch (e) {
      return storage(e);
    }
  };

  const loginOptions = async () => {
    const options = await wa.authenticationOptions({ rpID, userVerification: 'preferred', allowCredentials: [] });
    remember(options.challenge, { kind: 'login' });
    return json(200, options);
  };

  const loginVerify = async (req: Request) => {
    const b = await readBody(req);
    const c = takeChallenge(b?.response, 'login');
    if (!c) return json(400, { error: 'CHALLENGE_UNKNOWN', detail: 'This sign-in request expired; start again' });
    const credId = (b!.response as { id?: unknown }).id;
    const cred = typeof credId === 'string' ? o.accounts.credential(credId) : null;
    const person = cred ? o.accounts.person(cred.personId) : null;
    if (!cred || !person) return json(401, { error: 'PASSKEY_UNKNOWN', detail: 'This passkey is not registered here' });
    if (!o.accounts.active(person)) return json(403, { error: person.revokedAt ? 'ACCESS_REVOKED' : 'ACCESS_ENDED', detail: person.revokedAt ? 'Your access to this workspace was revoked' : 'Your reviewer access has ended' });
    let v;
    try {
      v = await wa.verifyAuthentication({
        response: b!.response as never,
        expectedChallenge: c.challenge,
        expectedOrigin: [...o.origins],
        expectedRPID: rpID,
        credential: { id: cred.id, publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64url')), counter: cred.counter, transports: cred.transports as never },
        requireUserVerification: false,
      });
    } catch {
      return json(401, { error: 'PASSKEY_REJECTED', detail: 'The passkey could not be verified' });
    }
    if (!v.verified) return json(401, { error: 'PASSKEY_REJECTED', detail: 'The passkey could not be verified' });
    try {
      o.accounts.usedCredential(cred.id, v.authenticationInfo.newCounter);
    } catch (e) {
      return storage(e);
    }
    const res = json(200, { person: publicPerson(person) });
    res.headers.set('set-cookie', signIn(person));
    return res;
  };

  const signout = async (req: Request) => {
    const b = await readBody(req);
    const s = session(req);
    if (s.ok && b?.everywhere === true) {
      try {
        o.accounts.bumpEpoch(s.person.id);
      } catch (e) {
        return storage(e);
      }
    }
    const r = json(200, { signedIn: false });
    r.headers.set('set-cookie', sessionCookie('', 0));
    return r;
  };

  // ------------------------------------------------------------------------------------------------ workspace

  const ownerOnly = (req: Request): SessionCheck | Response => {
    const s = session(req);
    if (!s.ok) return json(401, { error: 'SIGN_IN_REQUIRED', detail: 'Sign in first' });
    if (s.person.role !== 'owner') return json(403, { error: 'OWNER_ONLY', detail: 'Only the workspace owner manages members and invites' });
    return s;
  };

  const workspaceRoute = async (req: Request, path: string): Promise<Response> => {
    const s = ownerOnly(req);
    if (s instanceof Response) return s;
    if (!s.ok) return json(401, { error: 'SIGN_IN_REQUIRED', detail: 'Sign in first' });
    const ws = s.workspace;
    if (path === '/api/workspace/members') {
      if (req.method !== 'GET') return json(405, { error: 'METHOD_NOT_ALLOWED' });
      const members = o.accounts.members(ws.id).map((p) => ({ ...publicPerson(p), createdAt: p.createdAt, lastActiveAt: p.lastActiveAt, revokedAt: p.revokedAt, passkeys: o.accounts.credentialsOf(p.id).length }));
      return json(200, { members, invites: o.accounts.invitesOf(ws.id).map(publicInvite) });
    }
    if (req.method !== 'POST') return json(405, { error: 'METHOD_NOT_ALLOWED' });
    try {
      if (path === '/api/workspace/invites') {
        const b = await readBody(req);
        const label = cleanName(b?.label);
        if (!label) return json(400, { error: 'INVALID_LABEL', detail: 'A label of 1-60 letters, digits or plain punctuation' });
        const reviewer = b?.reviewer === true;
        const maxUses = Number(b?.maxUses ?? 1);
        const ttlDays = Number(b?.ttlDays ?? 7);
        if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 300) return json(400, { error: 'INVALID_USES', detail: 'maxUses must be 1-300' });
        if (!Number.isFinite(ttlDays) || ttlDays <= 0 || ttlDays > 120) return json(400, { error: 'INVALID_TTL', detail: 'ttlDays must be more than 0 and at most 120' });
        let accessUntil: string | null = null;
        if (b?.accessUntil != null) {
          const t = Date.parse(String(b.accessUntil));
          if (!Number.isFinite(t) || t <= now().getTime() || t > now().getTime() + 180 * DAY) return json(400, { error: 'INVALID_ACCESS_END', detail: 'accessUntil must be a date within the next 180 days' });
          accessUntil = new Date(t).toISOString();
        }
        const r = o.accounts.createInvite({ workspaceId: ws.id, createdBy: s.person.id, label, reviewer, maxUses, ttlMs: ttlDays * DAY, accessUntil });
        if ('refused' in r) return json(409, { error: 'TOO_MANY_INVITES', detail: r.refused });
        // The token travels in the fragment: never sent to a server, never in a log or a Referer.
        return json(201, { invite: publicInvite(r.invite), url: `${origin}/join#${r.token}` });
      }
      const inv = /^\/api\/workspace\/invites\/(inv_[A-Za-z0-9_-]{16})\/revoke$/.exec(path);
      if (inv) {
        const i = o.accounts.revokeInvite(ws.id, inv[1]!);
        return i ? json(200, publicInvite(i)) : json(404, { error: 'UNKNOWN_INVITE' });
      }
      const mem = /^\/api\/workspace\/members\/(p_[A-Za-z0-9_-]{16})\/revoke$/.exec(path);
      if (mem) {
        const p = o.accounts.revoke(ws.id, mem[1]!);
        return p ? json(200, publicPerson(p)) : json(404, { error: 'UNKNOWN_MEMBER', detail: 'No such member (owners cannot be revoked)' });
      }
    } catch (e) {
      return storage(e);
    }
    return json(404, { error: 'NOT_FOUND' });
  };

  const route = (req: Request, path: string): Promise<Response> | null => {
    if (path.startsWith('/api/workspace/')) return workspaceRoute(req, path);
    if (!path.startsWith('/api/auth/')) return null;
    const url = new URL(req.url);
    const get = req.method === 'GET';
    const post = req.method === 'POST';
    const routes: Record<string, () => Promise<Response> | Response> = {
      '/api/auth/me': () => (get ? me(req) : json(405, { error: 'METHOD_NOT_ALLOWED' })),
      '/api/auth/paypal/start': () => (post ? paypalStart() : json(405, { error: 'METHOD_NOT_ALLOWED' })),
      '/api/auth/paypal/cancel': () => (get ? redirect('/signin?error=cancelled', [pendingCookie('', 0)]) : json(405, { error: 'METHOD_NOT_ALLOWED' })),
      '/api/auth/invite/inspect': () => (post ? inspect(req) : json(405, { error: 'METHOD_NOT_ALLOWED' })),
      '/api/auth/invite/join': () => (post ? joinBrowser(req) : json(405, { error: 'METHOD_NOT_ALLOWED' })),
      '/api/auth/passkey/register/options': () => (post ? registerOptions(req) : json(405, { error: 'METHOD_NOT_ALLOWED' })),
      '/api/auth/passkey/register/verify': () => (post ? registerVerify(req) : json(405, { error: 'METHOD_NOT_ALLOWED' })),
      '/api/auth/passkey/login/options': () => (post ? loginOptions() : json(405, { error: 'METHOD_NOT_ALLOWED' })),
      '/api/auth/passkey/login/verify': () => (post ? loginVerify(req) : json(405, { error: 'METHOD_NOT_ALLOWED' })),
      '/api/auth/signout': () => (post ? signout(req) : json(405, { error: 'METHOD_NOT_ALLOWED' })),
    };
    const back = /^\/api\/auth\/paypal\/return\/([A-Za-z0-9_-]{43})$/.exec(path);
    if (back) return get ? paypalReturn(req, url, back[1]!) : Promise.resolve(json(405, { error: 'METHOD_NOT_ALLOWED' }));
    // Without the key there is no sign-in to finish: back to the sign-in page.
    if (path === '/api/auth/paypal/return' || path.startsWith('/api/auth/paypal/return/')) return Promise.resolve(redirect('/signin?error=session_mismatch', [pendingCookie('', 0)]));
    const h = routes[path];
    return h ? Promise.resolve(h()) : Promise.resolve(json(404, { error: 'NOT_FOUND' }));
  };

  return { route, session };
}
