import { describe, expect, it } from 'vitest';
import type { AccountWorkspace, DemoState } from './demoClient';
import { draftKey } from './draftStore';
import { accountRecheckMs, casesBase, draftScope, environmentOf, healthRetryDelay, joinUrl, knownBound, signInUrl, signOutDestination, workspaceRoute, type Environment } from './environment';

function state(connection: AccountWorkspace['connection'], role: 'owner' | 'member' = 'owner'): DemoState {
  return {
    signedIn: true,
    person: { id: 'p1', name: 'Dana Ruiz', role, via: 'paypal', email: null, reviewer: false, accessUntil: null },
    workspace: { id: 'ws_1', name: 'Northwind Goods', connected: connection === 'evaluation', connection },
    expiresAt: null,
    methods: { paypal: true, passkey: true },
    unlocked: connection === 'evaluation',
    reasons: {},
    caps: {},
  };
}
const SIGNED_OUT: DemoState = { ...state('not_connected'), signedIn: false, person: null, workspace: null };

describe('environmentOf', () => {
  it('the demo area is demo whoever is signed in', () => {
    for (const d of [null, SIGNED_OUT, state('evaluation'), state('not_connected'), state('checking')]) expect(environmentOf('demo', d)).toEqual({ kind: 'demo' });
  });
  it('evaluation / not_connected / checking map to evaluation / merchant / checking', () => {
    expect(environmentOf('workspace', state('evaluation'))).toEqual({ kind: 'evaluation', workspace: 'Northwind Goods' });
    expect(environmentOf('workspace', state('not_connected'))).toEqual({ kind: 'merchant', owner: true });
    expect(environmentOf('workspace', state('checking'))).toEqual({ kind: 'checking' });
    expect(environmentOf('workspace', SIGNED_OUT)).toEqual({ kind: 'signed-out' });
  });
  it('merchant owner vs member', () => {
    expect(environmentOf('workspace', state('not_connected', 'owner'))).toEqual({ kind: 'merchant', owner: true });
    expect(environmentOf('workspace', state('not_connected', 'member'))).toEqual({ kind: 'merchant', owner: false });
  });
  it('local mode (no account state) is local', () => {
    expect(environmentOf('workspace', null)).toEqual({ kind: 'local' });
  });
});

describe('casesBase', () => {
  it('is /demo/cases in the demo and /cases in the workspace', () => {
    expect(casesBase('demo')).toBe('/demo/cases');
    expect(casesBase('workspace')).toBe('/cases');
  });
});

describe('draftScope', () => {
  it("demo always 'demo'; a draft saved under 'local' is not the demo's", () => {
    expect(draftScope('demo', 'p1')).toBe('demo');
    expect(draftScope('demo', null)).toBe('demo');
    expect(draftScope('workspace', 'p1')).toBe('p1');
    expect(draftScope('workspace', null)).toBe('local');
    const k = (scope: string) => draftKey({ scope, caseId: 'c1', analysis: 'a' });
    expect(k(draftScope('demo', null))).not.toBe(k(draftScope('workspace', null)));
  });
});

describe('workspaceRoute', () => {
  const BOUND = ['PP-R-TVH-10190665'];
  const evaluation: Environment = { kind: 'evaluation', workspace: 'Northwind Goods' };
  it('signed out goes to sign-in and comes back to where it was going', () => {
    expect(workspaceRoute({ kind: 'signed-out' }, { caseId: 'PP-R-TVH-10190665' }, [])).toEqual({ kind: 'redirect', to: '/signin?next=%2Fcases%2FPP-R-TVH-10190665' });
    expect(workspaceRoute({ kind: 'signed-out' }, { caseId: null }, [])).toEqual({ kind: 'redirect', to: '/signin?next=%2Fcases' });
  });
  it('evaluation: an unbound case id goes to the same case in the demo, a bound one opens', () => {
    expect(workspaceRoute(evaluation, { caseId: 'PP-R-PLN-10189901' }, BOUND)).toEqual({ kind: 'redirect', to: '/demo/cases/PP-R-PLN-10189901' });
    expect(workspaceRoute(evaluation, { caseId: 'PP-R-TVH-10190665' }, BOUND)).toEqual({ kind: 'case', id: 'PP-R-TVH-10190665' });
    expect(workspaceRoute(evaluation, { caseId: null }, BOUND)).toEqual({ kind: 'inbox' });
  });
  it('merchant waits, on the inbox and on any case', () => {
    const m: Environment = { kind: 'merchant', owner: true };
    expect(workspaceRoute(m, { caseId: null }, BOUND)).toEqual({ kind: 'waiting' });
    expect(workspaceRoute(m, { caseId: 'PP-R-TVH-10190665' }, BOUND)).toEqual({ kind: 'waiting' });
  });
  it('checking checks', () => {
    expect(workspaceRoute({ kind: 'checking' }, { caseId: null }, [])).toEqual({ kind: 'checking' });
    expect(workspaceRoute({ kind: 'checking' }, { caseId: 'x' }, [])).toEqual({ kind: 'checking' });
  });
  it('evaluation with the bound cases unknown (health failed or not read yet) retries: no demo redirect, no inbox', () => {
    expect(workspaceRoute(evaluation, { caseId: 'PP-R-TVH-10190665' }, null)).toEqual({ kind: 'retrying' });
    expect(workspaceRoute(evaluation, { caseId: 'PP-R-PLN-10189901' }, null)).toEqual({ kind: 'retrying' });
    expect(workspaceRoute(evaluation, { caseId: null }, null)).toEqual({ kind: 'retrying' });
    // Only a successful health with nothing bound sends an unbound id to the demo.
    expect(workspaceRoute(evaluation, { caseId: 'PP-R-TVH-10190665' }, [])).toEqual({ kind: 'redirect', to: '/demo/cases/PP-R-TVH-10190665' });
    expect(workspaceRoute(evaluation, { caseId: null }, [])).toEqual({ kind: 'inbox' });
  });
  it('the other environments do not depend on the bound cases being known', () => {
    expect(workspaceRoute({ kind: 'local' }, { caseId: 'x' }, null)).toEqual({ kind: 'case', id: 'x' });
    expect(workspaceRoute({ kind: 'merchant', owner: true }, { caseId: null }, null)).toEqual({ kind: 'waiting' });
    expect(workspaceRoute({ kind: 'checking' }, { caseId: null }, null)).toEqual({ kind: 'checking' });
  });
  it('the demo redirect encodes the case id', () => {
    expect(workspaceRoute(evaluation, { caseId: 'a/b?c' }, BOUND)).toEqual({ kind: 'redirect', to: '/demo/cases/a%2Fb%3Fc' });
  });
  it('local mode is the inbox and the case as today, bound or not', () => {
    expect(workspaceRoute({ kind: 'local' }, { caseId: null }, [])).toEqual({ kind: 'inbox' });
    expect(workspaceRoute({ kind: 'local' }, { caseId: 'PP-R-PLN-10189901' }, [])).toEqual({ kind: 'case', id: 'PP-R-PLN-10189901' });
  });
});

describe('sign-in and join URLs keep where the person was going', () => {
  it('encodes next, and leaves the plain URL when there is nowhere special to go back to', () => {
    expect(signInUrl('/cases/PP-R-TVH-10190665')).toBe('/signin?next=%2Fcases%2FPP-R-TVH-10190665');
    expect(joinUrl('/cases/PP-R-TVH-10190665')).toBe('/join?next=%2Fcases%2FPP-R-TVH-10190665');
    expect(signInUrl('/')).toBe('/signin');
    expect(joinUrl('/')).toBe('/join');
  });
});

describe('signOutDestination', () => {
  it('goes home, or to /signin for another PayPal account', () => {
    expect(signOutDestination(false)).toBe('/');
    expect(signOutDestination(true)).toBe('/signin');
  });
});

describe('knownBound', () => {
  it('is null while health is unread or failed, the bound list once the server answered', () => {
    expect(knownBound(null)).toBeNull();
    expect(knownBound({ paypal: 'unconfigured', bound: [], failed: true, error: 'HTTP 429' })).toBeNull();
    expect(knownBound({ paypal: 'sandbox', bound: [] })).toEqual([]);
    expect(knownBound({ paypal: 'sandbox', bound: ['A'] })).toEqual(['A']);
    // A server that answers but cannot reach PayPal is an answer: nothing bound.
    expect(knownBound({ paypal: 'unconfigured', bound: [], error: 'PayPal unreachable' })).toEqual([]);
  });
});

describe('healthRetryDelay', () => {
  it('doubles from 1 s after each failure, capped at 30 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(healthRetryDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });
});

describe('accountRecheckMs', () => {
  it('re-reads the account every 5 s while its connection is checking, and stops once it is known', () => {
    expect(accountRecheckMs(state('checking'))).toBe(5_000);
    expect(accountRecheckMs(state('evaluation'))).toBeNull();
    expect(accountRecheckMs(state('not_connected'))).toBeNull();
    expect(accountRecheckMs(SIGNED_OUT)).toBeNull();
    expect(accountRecheckMs(null)).toBeNull();
  });
});
