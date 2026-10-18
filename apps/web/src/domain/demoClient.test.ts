import { describe, expect, it } from 'vitest';
import { DemoClient, SIGN_IN_FIRST, actorName, initials, lockedReason, roleLabel, type DemoState } from './demoClient';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** Answers by path: /api/demo and /api/auth/me. */
const server = (demo: unknown, me: unknown, meStatus = 200) =>
  (async (url: string | URL) => (String(url).endsWith('/auth/me') ? json(meStatus, me) : json(200, demo))) as typeof fetch;

const DEMO = { hosted: true, reasons: { evidence: 'Only the seller’s workspace can send.' }, caps: {} };
const PERSON = { id: 'p_aaaaaaaaaaaaaaaa', name: 'Dana Ruiz', role: 'member', via: 'passkey', email: null, reviewer: true, accessUntil: '2026-12-15T23:59:00.000Z' };

describe('DemoClient', () => {
  it('has no sign-in on a local server (hosted: false or 404) or without a server', async () => {
    expect(await new DemoClient({ fetch: server({ hosted: false }, {}, 404) }).state()).toBeNull();
    expect(await new DemoClient({ fetch: (async () => json(404, { error: 'NOT_FOUND' })) as typeof fetch }).state()).toBeNull();
    expect(await new DemoClient({ fetch: (async () => { throw new TypeError('down'); }) as typeof fetch }).state()).toBeNull();
  });

  it('signed out: the sign-in methods, nothing open', async () => {
    const s = await new DemoClient({ fetch: server(DEMO, { signedIn: false, methods: { paypal: true, passkey: true } }) }).state();
    expect(s).toMatchObject({ signedIn: false, person: null, workspace: null, unlocked: false, methods: { paypal: true, passkey: true } });
  });

  it('signed in to the seller’s workspace: open; to another workspace: signed in but not open', async () => {
    const seller = await new DemoClient({ fetch: server(DEMO, { signedIn: true, person: PERSON, workspace: { id: 'ws_1', name: 'Northwind Goods', connected: true }, expiresAt: '2026-10-10T22:00:00.000Z', methods: { paypal: true, passkey: true } }) }).state();
    expect(seller?.workspace?.connection).toBe('not_connected'); // an older server sends no connection
    expect(seller).toMatchObject({ signedIn: true, unlocked: true, person: { name: 'Dana Ruiz' }, workspace: { name: 'Northwind Goods', connected: true } });
    const other = await new DemoClient({ fetch: server(DEMO, { signedIn: true, person: { ...PERSON, role: 'owner' }, workspace: { id: 'ws_2', name: 'Elsewhere', connected: false }, methods: { paypal: true, passkey: true } }) }).state();
    expect(other).toMatchObject({ signedIn: true, unlocked: false });
  });

  it('lockedReason: sign in first; then the server’s reason for other workspaces; nothing when open or local', () => {
    const base: DemoState = { signedIn: false, person: null, workspace: null, expiresAt: null, methods: { paypal: true, passkey: true }, unlocked: false, reasons: { evidence: 'Cannot be undone.' }, caps: {} };
    expect(lockedReason(base, 'evidence')).toBe(SIGN_IN_FIRST);
    const outsider = { ...base, signedIn: true };
    expect(lockedReason(outsider, 'evidence')).toBe('Cannot be undone.');
    expect(lockedReason(outsider, 'recheck')).toBe('Only the seller’s workspace can do this.');
    expect(lockedReason({ ...outsider, unlocked: true }, 'evidence')).toBeNull();
    expect(lockedReason(null, 'evidence')).toBeNull();
  });

  it('initials and role labels', () => {
    expect([initials('Dana Ruiz'), initials('Northwind Goods Ltd'), initials('Kim'), initials('  ')]).toEqual(['DR', 'NL', 'K', '?']);
    expect([roleLabel({ role: 'owner', reviewer: false }), roleLabel({ role: 'member', reviewer: true }), roleLabel({ role: 'member', reviewer: false })]).toEqual(['Owner', 'Reviewer', 'Member']);
  });
});

describe('who is acting, as the page names them', () => {
  it('initials skip punctuation: a name with brackets or digits still gives letters', () => {
    expect([initials('Judge 2 (rehearsal)'), initials('(Ana) Ruiz'), initials('2 Kim')]).toEqual(['JR', 'AR', 'K']);
  });

  it('the signed-in person, else the local merchant', () => {
    expect(actorName(null)).toBe('Alex Moreno');
    expect(actorName({ person: { name: 'Judge 2 (rehearsal)' } } as unknown as DemoState)).toBe('Judge 2 (rehearsal)');
  });
});
