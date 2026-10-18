import { describe, expect, it } from 'vitest';
import type { AccountWorkspace, DemoState } from './demoClient';
import { draftKey } from './draftStore';
import { casesBase, draftScope, environmentOf } from './environment';

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
