/**
 * Merchant sign-in on the hosted demo (auth.ts, accounts.ts): PayPal identifies the Owner through a no-charge
 * agreement token of the platform's app; members join with invite links (passkey or this browser); sessions end on
 * revoke, sign-out everywhere and the end of reviewer access; only the seller's workspace answers the real dispute.
 * Fake PayPal and a fake authenticator only: nothing is sent anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DailyCounters } from '@resolvekit/hosting';
import { PayPalClient, type Dispute } from '@resolvekit/paypal';
import { caseInput, standardCase } from '@resolvekit/cases';
import { AccountStore, SESSION_COOKIE } from '../src/accounts.ts';
import type { WebAuthn } from '../src/auth.ts';
import { createHostedApp } from '../src/hosted.ts';
import { IntentStore } from '../src/intents.ts';
import { toSnapshot } from '../src/mapping.ts';
import { RESOLVED, SELLER_ID, STD_CAPTURE, TEST_SECRET, analystFor, standardDispute } from './kit.ts';

const ORIGIN = 'https://rk.example.com';
const HOST = 'rk.example.com';
const CASE = standardCase.summary.id;
const REAL = 'PP-R-REAL-1';
const TOKEN = 'BA-9BU79859F44918800';

/** The seller's app: disputes (the seller may be switched to someone else mid-test). */
function sellerPayPal(o: { seller?: { id: string } } = {}) {
  const seller = o.seller ?? { id: SELLER_ID };
  const sends: string[] = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
    if (u.pathname.endsWith('/provide-evidence')) {
      sends.push(u.pathname);
      return new Response(JSON.stringify({ links: [] }), { status: 200 });
    }
    const d: Dispute = standardDispute();
    d.disputed_transactions![0]!.seller = { merchant_id: seller.id, name: 'Northwind Goods Ltd' };
    return new Response(JSON.stringify(d), { status: 200 });
  }) as typeof globalThis.fetch;
  return { sends, seller, client: new PayPalClient({ clientId: 'seller', clientSecret: 's', env: 'sandbox', fetch }) };
}

/** The platform's app: agreement tokens. `approve(payerId)` makes the token APPROVED by that account. */
function platformPayPal() {
  // Each start is a new token (the first one is TOKEN); approving applies to the latest.
  const state = { status: 'PENDING', payerId: null as string | null, reads: 0, starts: 0, token: TOKEN, returnUrl: '' };
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
    if (u.pathname === '/v1/billing-agreements/agreement-tokens' && init.method === 'POST') {
      state.token = state.starts++ === 0 ? TOKEN : `BA-${String(7000000000000000 + state.starts)}`;
      state.returnUrl = (JSON.parse(String(init.body)) as { plan: { merchant_preferences: { return_url: string } } }).plan.merchant_preferences.return_url;
      Object.assign(state, { status: 'PENDING', payerId: null });
      return new Response(JSON.stringify({ token_id: state.token, links: [{ rel: 'approval_url', href: `https://www.sandbox.paypal.com/agreements/approve?ba_token=${state.token}` }] }), { status: 201 });
    }
    if (u.pathname === `/v1/billing-agreements/agreement-tokens/${state.token}`) {
      state.reads++;
      return new Response(JSON.stringify({ token_id: state.token, token_status: state.status, ...(state.payerId ? { payer_info: { payer_id: state.payerId, email: 'boss@example.com', first_name: 'Northwind', last_name: 'Goods' } } : {}) }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof globalThis.fetch;
  return {
    state,
    approve: (payerId: string) => Object.assign(state, { status: 'APPROVED', payerId }),
    /** Where PayPal sends the approver's browser back (the return URL it was given, plus the token). */
    redirect: () => `${new URL(state.returnUrl).pathname}?token=${state.token}&ba_token=${state.token}`,
    client: new PayPalClient({ clientId: 'platform', clientSecret: 'p', env: 'sandbox', fetch }),
  };
}

/** A fake authenticator: options carry a fresh challenge; verification passes unless told otherwise. */
function fakeWebAuthn() {
  let n = 0;
  const calls = { register: 0, login: 0, reject: false };
  const wa: WebAuthn = {
    registrationOptions: (async () => ({ challenge: `reg-challenge-${++n}` })) as unknown as WebAuthn['registrationOptions'],
    verifyRegistration: (async () => {
      calls.register++;
      return calls.reject ? { verified: false } : { verified: true, registrationInfo: { credential: { id: 'cred-1', publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] } } };
    }) as unknown as WebAuthn['verifyRegistration'],
    authenticationOptions: (async () => ({ challenge: `login-challenge-${++n}` })) as unknown as WebAuthn['authenticationOptions'],
    verifyAuthentication: (async () => {
      calls.login++;
      return calls.reject ? { verified: false } : { verified: true, authenticationInfo: { newCounter: 7 } };
    }) as unknown as WebAuthn['verifyAuthentication'],
  };
  return { wa, calls };
}
/** What a browser sends back for a ceremony: the challenge inside clientDataJSON. */
const ceremony = (challenge: string, id = 'cred-1') => ({ id, rawId: id, type: 'public-key', response: { clientDataJSON: Buffer.from(JSON.stringify({ challenge, type: 'webauthn.get', origin: ORIGIN })).toString('base64url') } });

async function setup(o: { accounts?: AccountStore; now?: () => Date; seller?: { id: string }; intents?: IntentStore } = {}) {
  const pp = sellerPayPal(o.seller ? { seller: o.seller } : {});
  const platform = platformPayPal();
  const authn = fakeWebAuthn();
  const live = caseInput(standardCase, { kind: 'live', snap: toSnapshot(standardDispute(), CASE, 'sandbox', new Date()), failed: null });
  const { analyst } = await analystFor([[CASE, live], [CASE, caseInput(standardCase, { kind: 'simulated' })]]);
  const accounts = o.accounts ?? new AccountStore(o.now ? { now: o.now } : {});
  const lines: string[] = [];
  const app = createHostedApp({
    log: (l) => lines.push(l),
    paypal: pp.client,
    env: 'sandbox',
    bindings: { [CASE]: { dispute: REAL, capture: STD_CAPTURE } },
    analyst,
    site: null,
    counters: new DailyCounters({ file: null, limits: { 'live-analysis': 5, recheck: 50, evidence: 5 } }),
    accounts,
    identity: platform.client,
    webauthn: authn.wa,
    sessionSecret: TEST_SECRET,
    origins: [ORIGIN],
    hosts: [HOST],
    https: true,
    ...(o.now ? { now: o.now } : {}),
    ...(o.intents ? { intents: o.intents } : {}),
  });
  return { app, pp, platform, authn, accounts, lines };
}
type App = Awaited<ReturnType<typeof setup>>['app'];

const req = (path: string, i: { body?: unknown; cookie?: string; ip?: string } = {}) => {
  const method = i.body !== undefined ? 'POST' : 'GET';
  const headers: Record<string, string> = { host: HOST, 'x-forwarded-for': i.ip ?? '203.0.113.7', ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/json' } : {}), ...(i.cookie ? { cookie: i.cookie } : {}) };
  return new Request(ORIGIN + path, { method, headers, ...(i.body !== undefined ? { body: JSON.stringify(i.body) } : {}) });
};
const cookieFrom = (r: Response, name: string) => r.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? null;
const pair = (setCookie: string | null) => (setCookie ? setCookie.split(';')[0]! : '');
const me = async (app: App, cookie?: string) => (await (await app(req('/api/auth/me', cookie ? { cookie } : {}))).json()) as { signedIn: boolean; person?: { role: string; name: string; via: string; email: string | null }; workspace?: { connected: boolean; connection: string; name: string } };

/** The whole PayPal sign-in of `payerId`: start, approve on PayPal, come back. Returns the session cookie. */
async function paypalSignIn(s: Awaited<ReturnType<typeof setup>>, payerId: string): Promise<string> {
  const start = await s.app(req('/api/auth/paypal/start', { body: {} }));
  assert.equal(start.status, 200);
  const pending = pair(cookieFrom(start, 'rk_pp'));
  s.platform.approve(payerId);
  const back = await s.app(req(s.platform.redirect(), { cookie: pending }));
  assert.equal(back.status, 303, back.headers.get('location') ?? '');
  assert.equal(back.headers.get('location'), '/?signed-in=paypal');
  return pair(cookieFrom(back, SESSION_COOKIE));
}

async function ownerWithInvite(s: Awaited<ReturnType<typeof setup>>, body: Record<string, unknown> = {}) {
  const owner = await paypalSignIn(s, SELLER_ID);
  const r = await s.app(req('/api/workspace/invites', { body: { label: 'Judges', reviewer: true, maxUses: 5, ttlDays: 30, ...body }, cookie: owner }));
  assert.equal(r.status, 201);
  const b = (await r.json()) as { url: string; invite: { id: string } };
  return { owner, url: b.url, token: b.url.split('#')[1]!, inviteId: b.invite.id };
}

// ------------------------------------------------------------------------------------------------ PayPal

test('paypal: start returns PayPal’s approval link and a short-lived Lax cookie bound to this browser; nothing is stored yet', async () => {
  const s = await setup();
  const r = await s.app(req('/api/auth/paypal/start', { body: {} }));
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { approvalUrl: string }).approvalUrl, `https://www.sandbox.paypal.com/agreements/approve?ba_token=${TOKEN}`);
  const set = cookieFrom(r, 'rk_pp')!;
  for (const part of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/api/auth/paypal', 'Max-Age=900']) assert.ok(set.includes(part), part);
  assert.ok(set.startsWith(`rk_pp=${TOKEN}.`));
  assert.equal((await me(s.app)).signedIn, false);
});

test('paypal: the seller’s account signs in as Owner of a connected workspace; the real dispute is then listed for it', async () => {
  const s = await setup();
  const cookie = await paypalSignIn(s, SELLER_ID);
  const m = await me(s.app, cookie);
  assert.equal(m.signedIn, true);
  assert.deepEqual([m.person!.role, m.person!.via, m.person!.name, m.person!.email], ['owner', 'paypal', 'Northwind Goods', 'b•••@example.com']);
  assert.equal(m.workspace!.connected, true);
  assert.equal(m.workspace!.connection, 'evaluation');
  // The seller's workspace takes the business name PayPal gives on its disputes.
  assert.equal(m.workspace!.name, 'Northwind Goods Ltd');
  // The single-use return key never reaches the log.
  const key = new URL(s.platform.state.returnUrl).pathname.split('/').pop()!;
  assert.ok(s.lines.some((l) => l.startsWith('GET /api/auth/paypal/return/… → 303')));
  assert.ok(s.lines.every((l) => !l.includes(key)));
  const health = (await (await s.app(req('/api/health', { cookie }))).json()) as { bound: string[] };
  assert.deepEqual(health.bound, [CASE]);
  // Signing in again finds the same workspace and person.
  const again = await paypalSignIn(s, SELLER_ID);
  assert.equal((await me(s.app, again)).person!.name, 'Northwind Goods');
  assert.equal(s.accounts.members(s.accounts.person(again.split('.')[1]!)!.workspaceId).length, 1);
});

test('paypal: another PayPal account gets its own workspace, not connected: the case runs on the simulator for it', async () => {
  const s = await setup();
  const cookie = await paypalSignIn(s, 'SOMEONEELSE01');
  const m = await me(s.app, cookie);
  assert.equal(m.person!.role, 'owner');
  assert.equal(m.workspace!.connected, false);
  assert.equal(m.workspace!.connection, 'not_connected');
  assert.deepEqual(((await (await s.app(req('/api/health', { cookie }))).json()) as { bound: string[] }).bound, []);
  assert.equal((await s.app(req(`/api/disputes/${CASE}`, { cookie }))).status, 404);
});

test('paypal: a return without this browser’s pending cookie, with another token, a tampered or expired cookie signs nobody in and reads nothing', async () => {
  let t = Date.parse('2026-10-10T10:00:00Z');
  const s = await setup({ now: () => new Date(t) });
  const start = await s.app(req('/api/auth/paypal/start', { body: {} }));
  const pending = pair(cookieFrom(start, 'rk_pp'));
  s.platform.approve(SELLER_ID);
  const [name, value] = pending.split('=');
  const [tok, nonce, exp, sig] = value!.split('.');
  const path = new URL(s.platform.state.returnUrl).pathname;
  const cases = [
    { cookie: undefined, token: TOKEN },
    { cookie: pending, token: 'BA-1111111111111111' },
    { cookie: `${name}=${tok}.${nonce}.${Number(exp) + 3_600_000}.${sig}`, token: TOKEN },
    { cookie: `${name}=${tok}.${nonce}.${exp}.${'A'.repeat(43)}`, token: TOKEN },
    { cookie: pending, token: '../../v1/oauth2/token' },
  ];
  for (const c of cases) {
    const r = await s.app(req(`${path}?ba_token=${encodeURIComponent(c.token)}`, c.cookie ? { cookie: c.cookie } : {}));
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/signin?error=session_mismatch');
    assert.equal(cookieFrom(r, SESSION_COOKIE), null);
  }
  t += 16 * 60_000;
  const late = await s.app(req(`${path}?ba_token=${TOKEN}`, { cookie: pending }));
  assert.equal(late.headers.get('location'), '/signin?error=session_mismatch');
  assert.equal(s.platform.state.reads, 0);
});

test('paypal: a phished approval signs nobody in — the attacker has the pending cookie but not the return key; the merchant has the key but not the cookie', async () => {
  const s = await setup();
  // The attacker starts a sign-in in their browser and sends the (genuine) PayPal approval link to the merchant.
  const start = await s.app(req('/api/auth/paypal/start', { body: {} }));
  const attacker = pair(cookieFrom(start, 'rk_pp'));
  const link = ((await start.json()) as { approvalUrl: string }).approvalUrl;
  assert.ok(!link.includes(new URL(s.platform.state.returnUrl).pathname.split('/').pop()!));
  // The merchant approves on PayPal; PayPal sends the MERCHANT's browser back (no pending cookie there).
  s.platform.approve(SELLER_ID);
  const merchant = await s.app(req(s.platform.redirect()));
  assert.equal(merchant.headers.get('location'), '/signin?error=session_mismatch');
  assert.equal(cookieFrom(merchant, SESSION_COOKIE), null);
  // The attacker knows the token id (it is in the link) but not the key: every guess of the return URL fails.
  for (const path of [`/api/auth/paypal/return?ba_token=${TOKEN}`, `/api/auth/paypal/return/${'A'.repeat(43)}?ba_token=${TOKEN}`, `/api/auth/paypal/return/x?ba_token=${TOKEN}`]) {
    const r = await s.app(req(path, { cookie: attacker }));
    assert.equal(r.headers.get('location'), '/signin?error=session_mismatch', path);
    assert.equal(cookieFrom(r, SESSION_COOKIE), null);
  }
  assert.equal(s.platform.state.reads, 0);
});

test('paypal: each token gets one attempt — an arrival before the approval ends it (no polling for someone else’s approval)', async () => {
  const s = await setup();
  const start = await s.app(req('/api/auth/paypal/start', { body: {} }));
  const pending = pair(cookieFrom(start, 'rk_pp'));
  const r = await s.app(req(s.platform.redirect(), { cookie: pending }));
  assert.equal(r.headers.get('location'), '/signin?error=not_approved');
  // Approved afterwards: this token is spent; the same browser starts again and signs in.
  s.platform.approve(SELLER_ID);
  const again = await s.app(req(s.platform.redirect(), { cookie: pending }));
  assert.equal(again.headers.get('location'), '/signin?error=session_mismatch');
  assert.equal(cookieFrom(again, SESSION_COOKIE), null);
  const cookie = await paypalSignIn(s, SELLER_ID);
  assert.equal((await me(s.app, cookie)).signedIn, true);
});

test('paypal: even with the return key leaked, an attacker cannot use the merchant’s approval — the merchant’s redirect burns the token', async () => {
  const s = await setup();
  const start = await s.app(req('/api/auth/paypal/start', { body: {} }));
  const attacker = pair(cookieFrom(start, 'rk_pp'));
  // Suppose the attacker read the return URL (with its key) somewhere. The merchant approves; PayPal sends the
  // merchant's browser back first, without the attacker's cookie.
  const leaked = s.platform.redirect();
  s.platform.approve(SELLER_ID);
  assert.equal((await s.app(req(leaked))).headers.get('location'), '/signin?error=session_mismatch');
  // Now the attacker, with the cookie and the key: the token is spent.
  const r = await s.app(req(leaked, { cookie: attacker }));
  assert.equal(r.headers.get('location'), '/signin?error=session_mismatch');
  assert.equal(cookieFrom(r, SESSION_COOKIE), null);
  assert.equal(s.platform.state.reads, 0);
});

test('paypal: cancelling on PayPal returns to the sign-in page; starts are rate-limited per address', async () => {
  const s = await setup();
  const c = await s.app(req('/api/auth/paypal/cancel'));
  assert.equal(c.headers.get('location'), '/signin?error=cancelled');
  const statuses: number[] = [];
  for (let k = 0; k < 12; k++) statuses.push((await s.app(req('/api/auth/paypal/start', { body: {}, ip: '198.51.100.40' }))).status);
  assert.deepEqual([statuses.filter((x) => x === 200).length, statuses.filter((x) => x === 429).length], [10, 2]);
  assert.equal(s.platform.state.starts, 10);
});

/** A whole PayPal sign-in started with `body` (each from its own address: starts are rate-limited); the return's Location. */
async function paypalSignInFrom(s: Awaited<ReturnType<typeof setup>>, body: unknown, ip: string): Promise<string> {
  const start = await s.app(req('/api/auth/paypal/start', { body, ip }));
  assert.equal(start.status, 200);
  const pending = pair(cookieFrom(start, 'rk_pp'));
  s.platform.approve(SELLER_ID);
  const back = await s.app(req(s.platform.redirect(), { cookie: pending, ip }));
  assert.equal(back.status, 303);
  assert.ok(cookieFrom(back, SESSION_COOKIE), 'signed in');
  return back.headers.get('location')!;
}

test('paypal: the sign-in comes back to the page it started from (`next`, a same-site path)', async () => {
  const s = await setup();
  assert.equal(await paypalSignInFrom(s, { next: `/cases/${CASE}` }, '198.51.100.50'), `/cases/${CASE}`);
  assert.equal(await paypalSignInFrom(s, { next: '/agent?run=r1#log' }, '198.51.100.51'), '/agent?run=r1#log');
  // Without `next` (or with the start page) it lands where it always did.
  assert.equal(await paypalSignInFrom(s, {}, '198.51.100.52'), '/?signed-in=paypal');
  assert.equal(await paypalSignInFrom(s, { next: '/' }, '198.51.100.53'), '/?signed-in=paypal');
});

test('paypal: an unsafe `next` is ignored — no other origin, scheme, protocol-relative or backslash path, no API path', async () => {
  const s = await setup();
  const attempts: unknown[] = [
    '//evil.example/x',
    '/\\evil.example',
    '\\\\evil.example',
    '/\t/evil.example',
    '/\n/evil.example',
    'https://evil.example/',
    'javascript:alert(1)',
    'evil.example',
    '/api/auth/me',
    '/./../api/auth/signout',
    '/%2F/evil.example/../..//x',
    `/${'a'.repeat(600)}`,
    42,
    ['/cases'],
  ];
  let ip = 60;
  for (const next of attempts) assert.equal(await paypalSignInFrom(s, { next }, `198.51.100.${ip++}`), '/?signed-in=paypal', JSON.stringify(next));
});

test('paypal: a `next` short as typed but long once percent-encoded falls back to the start page; the sign-in still completes', async () => {
  const s = await setup();
  // 201 characters typed, 1,801 encoded ('€' is %E2%82%AC); 512 quotes are 1,536 encoded.
  assert.equal(await paypalSignInFrom(s, { next: `/${'€'.repeat(200)}` }, '198.51.100.90'), '/?signed-in=paypal');
  assert.equal(await paypalSignInFrom(s, { next: `/${'"'.repeat(511)}` }, '198.51.100.91'), '/?signed-in=paypal');
  // Up to the limit once encoded, it comes back as asked.
  const fits = `/cases/${'€'.repeat(50)}`;
  assert.equal(await paypalSignInFrom(s, { next: fits }, '198.51.100.92'), new URL(fits, 'http://x').pathname);
});

test('paypal: `next` is bound to the pending cookie — changing it in the cookie ends the sign-in', async () => {
  const s = await setup();
  const start = await s.app(req('/api/auth/paypal/start', { body: { next: `/cases/${CASE}` } }));
  const pending = pair(cookieFrom(start, 'rk_pp'));
  const [name, value] = pending.split('=');
  const parts = value!.split('.');
  assert.equal(parts.length, 5);
  assert.equal(Buffer.from(parts[3]!, 'base64url').toString('utf8'), `/cases/${CASE}`);
  parts[3] = Buffer.from('//evil.example').toString('base64url');
  s.platform.approve(SELLER_ID);
  const r = await s.app(req(s.platform.redirect(), { cookie: `${name}=${parts.join('.')}` }));
  assert.equal(r.headers.get('location'), '/signin?error=session_mismatch');
  assert.equal(cookieFrom(r, SESSION_COOKIE), null);
  assert.equal(s.platform.state.reads, 0);
});

// ------------------------------------------------------------------------------------------------ invites

test('invites: only the Owner creates them; the token is only in the link’s fragment and only its hash is stored', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-accounts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'accounts.json');
  const s = await setup({ accounts: new AccountStore({ file }) });
  const { owner, url, token } = await ownerWithInvite(s);
  assert.match(url, /^https:\/\/rk\.example\.com\/join#[A-Za-z0-9_-]{43}$/);
  assert.ok(!readFileSync(file, 'utf8').includes(token));
  // A member cannot manage the workspace.
  const j = await s.app(req('/api/auth/invite/join', { body: { token, name: 'Dana Ruiz' } }));
  const member = pair(cookieFrom(j, SESSION_COOKIE));
  assert.equal((await s.app(req('/api/workspace/invites', { body: { label: 'More' }, cookie: member }))).status, 403);
  assert.equal((await s.app(req('/api/workspace/members', { cookie: member }))).status, 403);
  assert.equal((await s.app(req('/api/workspace/members'))).status, 401);
  const list = (await (await s.app(req('/api/workspace/members', { cookie: owner }))).json()) as { members: Array<{ name: string; role: string }>; invites: Array<{ uses: number }> };
  assert.deepEqual(list.members.map((m) => [m.name, m.role]), [['Northwind Goods', 'owner'], ['Dana Ruiz', 'member']]);
  assert.equal(list.invites[0]!.uses, 1);
  // A restart reads the same accounts.
  const reloaded = new AccountStore({ file });
  assert.equal(reloaded.checkInvite(token).ok, true);
});

test('invites: inspect tells what a link opens; joining for this browser makes a reviewer member of the connected workspace', async () => {
  const s = await setup();
  const { token } = await ownerWithInvite(s, { accessUntil: '2026-12-15T23:59:00Z' });
  const i = await s.app(req('/api/auth/invite/inspect', { body: { token } }));
  const view = (await i.json()) as { workspace: { name: string }; reviewer: boolean; usesLeft: number; accessUntil: string };
  assert.deepEqual([view.workspace.name, view.reviewer, view.usesLeft, view.accessUntil], ['Northwind Goods Ltd', true, 5, '2026-12-15T23:59:00.000Z']);
  assert.equal((await s.app(req('/api/auth/invite/join', { body: { token, name: '<script>' } }))).status, 400);
  const j = await s.app(req('/api/auth/invite/join', { body: { token, name: '  Dana   Ruiz ' } }));
  assert.equal(j.status, 200);
  const cookie = pair(cookieFrom(j, SESSION_COOKIE));
  const m = await me(s.app, cookie);
  assert.deepEqual([m.person!.name, m.person!.role, m.person!.via, m.workspace!.connected], ['Dana Ruiz', 'member', 'browser', true]);
});

test('invites: used up, revoked, expired or unknown links open nothing; concurrent joins never exceed the uses', async () => {
  let t = Date.parse('2026-10-10T10:00:00Z');
  const s = await setup({ now: () => new Date(t) });
  const one = await ownerWithInvite(s, { maxUses: 2, reviewer: false, ttlDays: 1 });
  const joins = await Promise.all(Array.from({ length: 6 }, (_, k) => s.app(req('/api/auth/invite/join', { body: { token: one.token, name: `Person ${k}` } }))));
  assert.equal(joins.filter((r) => r.status === 200).length, 2);
  const used = joins.find((r) => r.status !== 200)!;
  assert.equal(used.status, 410);
  assert.equal(((await used.json()) as { error: string }).error, 'INVITE_USED');
  const two = await s.app(req('/api/workspace/invites', { body: { label: 'Second', maxUses: 3, ttlDays: 1 }, cookie: one.owner }));
  const { url, invite } = (await two.json()) as { url: string; invite: { id: string } };
  const token2 = url.split('#')[1]!;
  assert.equal((await s.app(req(`/api/workspace/invites/${invite.id}/revoke`, { body: {}, cookie: one.owner }))).status, 200);
  assert.equal(((await (await s.app(req('/api/auth/invite/inspect', { body: { token: token2 } }))).json()) as { error: string }).error, 'INVITE_REVOKED');
  const three = await s.app(req('/api/workspace/invites', { body: { label: 'Third', maxUses: 3, ttlDays: 1 }, cookie: one.owner }));
  const token3 = ((await three.json()) as { url: string }).url.split('#')[1]!;
  t += 25 * 3_600_000;
  assert.equal(((await (await s.app(req('/api/auth/invite/inspect', { body: { token: token3 } }))).json()) as { error: string }).error, 'INVITE_EXPIRED');
  const unknown = await s.app(req('/api/auth/invite/inspect', { body: { token: 'A'.repeat(43) } }));
  assert.equal(unknown.status, 404);
});

// ------------------------------------------------------------------------------------------------ passkeys

test('passkeys: joining with a passkey, then signing in with it on a new browser; challenges are single-use', async () => {
  const s = await setup();
  const { token } = await ownerWithInvite(s);
  const opt = (await (await s.app(req('/api/auth/passkey/register/options', { body: { token, name: 'Dana Ruiz' } }))).json()) as { challenge: string };
  const reg = await s.app(req('/api/auth/passkey/register/verify', { body: { response: ceremony(opt.challenge) } }));
  assert.equal(reg.status, 200);
  assert.equal((await me(s.app, pair(cookieFrom(reg, SESSION_COOKIE)))).person!.via, 'passkey');
  // The same ceremony again: the challenge is gone.
  assert.equal((await s.app(req('/api/auth/passkey/register/verify', { body: { response: ceremony(opt.challenge) } }))).status, 400);
  // A new browser signs in with the passkey.
  const lo = (await (await s.app(req('/api/auth/passkey/login/options', { body: {} }))).json()) as { challenge: string };
  const login = await s.app(req('/api/auth/passkey/login/verify', { body: { response: ceremony(lo.challenge) } }));
  assert.equal(login.status, 200);
  const cookie = pair(cookieFrom(login, SESSION_COOKIE));
  assert.equal((await me(s.app, cookie)).person!.name, 'Dana Ruiz');
  assert.equal(s.accounts.credential('cred-1')!.counter, 7);
  assert.equal((await s.app(req('/api/auth/passkey/login/verify', { body: { response: ceremony(lo.challenge) } }))).status, 400);
  // An unknown passkey or a failed verification signs nobody in.
  const lo2 = (await (await s.app(req('/api/auth/passkey/login/options', { body: {} }))).json()) as { challenge: string };
  assert.equal((await s.app(req('/api/auth/passkey/login/verify', { body: { response: ceremony(lo2.challenge, 'cred-unknown') } }))).status, 401);
  s.authn.calls.reject = true;
  const lo3 = (await (await s.app(req('/api/auth/passkey/login/options', { body: {} }))).json()) as { challenge: string };
  const bad = await s.app(req('/api/auth/passkey/login/verify', { body: { response: ceremony(lo3.challenge) } }));
  assert.equal(bad.status, 401);
  assert.equal(cookieFrom(bad, SESSION_COOKIE), null);
});

// ------------------------------------------------------------------------------------------------ sessions end

test('sessions: revoking a member, signing out everywhere and the end of reviewer access end sessions at once', async () => {
  let t = Date.parse('2026-12-15T20:00:00Z');
  const s = await setup({ now: () => new Date(t) });
  const { owner, token } = await ownerWithInvite(s, { accessUntil: '2026-12-15T23:00:00Z' });
  const join = async (name: string) => pair(cookieFrom(await s.app(req('/api/auth/invite/join', { body: { token, name } })), SESSION_COOKIE));
  const dana = await join('Dana Ruiz');
  const lee = await join('Lee Park');
  const danaId = (await (await s.app(req('/api/workspace/members', { cookie: owner }))).json()) as { members: Array<{ id: string; name: string }> };
  const id = danaId.members.find((m) => m.name === 'Dana Ruiz')!.id;
  assert.equal((await s.app(req(`/api/workspace/members/${id}/revoke`, { body: {}, cookie: owner }))).status, 200);
  assert.equal((await me(s.app, dana)).signedIn, false);
  assert.equal((await s.app(req(`/api/disputes/${CASE}/intent`, { body: { evidenceType: 'PROOF_OF_FULFILLMENT', resolutions: RESOLVED }, cookie: dana }))).status, 404); // three-environments plan, task 2: a signed-out visitor does not see the case at all
  // The Owner cannot be revoked.
  const ownerId = s.accounts.members(s.accounts.person(owner.split('.')[1]!)!.workspaceId).find((p) => p.role === 'owner')!.id;
  assert.equal((await s.app(req(`/api/workspace/members/${ownerId}/revoke`, { body: {}, cookie: owner }))).status, 404);
  // Sign out everywhere: the old cookie no longer works.
  const out = await s.app(req('/api/auth/signout', { body: { everywhere: true }, cookie: lee }));
  assert.match(cookieFrom(out, SESSION_COOKIE)!, /Max-Age=0/);
  assert.equal((await me(s.app, lee)).signedIn, false);
  // Reviewer access ends at its date, whatever the cookie says.
  const kim = await join('Kim Lee');
  assert.equal((await me(s.app, kim)).signedIn, true);
  t = Date.parse('2026-12-15T23:00:01Z');
  assert.equal((await me(s.app, kim)).signedIn, false);
  assert.equal((await me(s.app, owner)).signedIn, true);
});

test('sessions: a forged, tampered or foreign-secret session cookie is nobody', async () => {
  const s = await setup();
  const owner = await paypalSignIn(s, SELLER_ID);
  const [name, value] = owner.split('=');
  const parts = value!.split('.');
  const forged = [
    `${name}=${[...parts.slice(0, 3), String(Number(parts[3]) + 3_600_000), parts[4]].join('.')}`,
    `${name}=${[...parts.slice(0, 2), '9', ...parts.slice(3)].join('.')}`,
    `${name}=${[...parts.slice(0, 4), 'A'.repeat(43)].join('.')}`,
    `${name}=garbage`,
  ];
  for (const c of forged) assert.equal((await me(s.app, c)).signedIn, false, c);
});

// ------------------------------------------------------------------------------------------------ the seller check

test('seller: only the seller’s workspace answers the dispute; if the dispute’s seller is someone else at send time, nothing is sent', async () => {
  const intents = new IntentStore();
  const s = await setup({ intents });
  const owner = await paypalSignIn(s, SELLER_ID);
  const r = await s.app(req(`/api/disputes/${CASE}/intent`, { body: { evidenceType: 'PROOF_OF_FULFILLMENT', resolutions: RESOLVED }, cookie: owner }));
  const i = (await r.json()) as { id: string; contentHash: string };
  assert.equal(r.status, 201, JSON.stringify(i));
  assert.equal((await s.app(req(`/api/disputes/${CASE}/intent/${i.id}/approve`, { body: { contentHash: i.contentHash }, cookie: owner }))).status, 200);
  // PayPal now reports another seller on the dispute (the fresh read before sending is what counts).
  s.pp.seller.id = 'SOMEONEELSE01';
  const send = await s.app(req(`/api/disputes/${CASE}/evidence`, { body: { intentId: i.id }, cookie: owner }));
  assert.equal(send.status, 403);
  assert.equal(((await send.json()) as { error: string }).error, 'NOT_THE_SELLER');
  assert.equal(s.pp.sends.length, 0);
  // three-environments plan, task 2: while PayPal names another seller the workspace no longer sees the case over HTTP; the trail is read from the store.
  const trail = intents.events(CASE);
  assert.equal(trail.at(-1)!.kind, 'send_refused');
  assert.match(trail.at(-1)!.detail!, /not the seller/);
});

// ------------------------------------------------------------------------------------------------ durability

test('durability: a membership that cannot be written is refused (503) and nothing changes', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rk-accounts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'data');
  mkdirSync(dir);
  const accounts = new AccountStore({ file: join(dir, 'accounts.json') });
  const s = await setup({ accounts });
  const { token } = await ownerWithInvite(s);
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(dir, 'not a directory');
  const r = await s.app(req('/api/auth/invite/join', { body: { token, name: 'Dana Ruiz' } }));
  assert.equal(r.status, 503);
  assert.equal(((await r.json()) as { error: string }).error, 'ACCOUNTS_UNAVAILABLE');
  assert.equal(cookieFrom(r, SESSION_COOKIE), null);
  const c = accounts.checkInvite(token);
  assert.ok(c.ok && c.invite.uses === 0);
});
