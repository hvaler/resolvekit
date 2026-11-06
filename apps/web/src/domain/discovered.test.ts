import { describe, expect, it } from 'vitest';
import { canFindDisputes, provenanceText, scanErrorText, scanResultText, templateOfCase } from './discovered';
import type { DemoState } from './demoClient';
import { GatewayTimeoutError, GatewayUnavailableError } from './gateway';
import { GatewayRequestError as HttpRequestError, type ServerHealth } from './httpGateway';

const info = { template: 'standard' as const, orderRef: 'rk-std-a1', source: 'webhook' as const, createdAt: '2026-11-06T10:04:00Z', ended: false };
const health: ServerHealth = { paypal: 'sandbox', bound: ['PP-R-QFP-10195597'], cases: { 'PP-R-QFP-10195597': info } };

describe('the provenance line', () => {
  it('says how the case was found, the dispute, the capture, the order and when (UTC)', () => {
    expect(provenanceText('PP-R-QFP-10195597', info, '7XK12345AB678901C')).toBe(
      'Discovered from PayPal (webhook) · dispute PP-R-QFP-10195597 · capture 7XK12345AB678901C · order rk-std-a1 · 6 Nov 2026 10:04 UTC',
    );
    expect(provenanceText('PP-R-QFP-10195597', { ...info, source: 'scan' }, '7XK12345AB678901C')).toBe(
      'Discovered from PayPal (owner scan) · dispute PP-R-QFP-10195597 · capture 7XK12345AB678901C · order rk-std-a1 · 6 Nov 2026 10:04 UTC',
    );
  });
  it('the capture shows — until PayPal’s read is in', () => {
    expect(provenanceText('PP-R-QFP-10195597', info, null)).toContain(' · capture — · ');
  });
});

describe('which case file a case id opens', () => {
  it('in the workspace: the template of a discovered case the server lists', () => {
    expect(templateOfCase('workspace', health)('PP-R-QFP-10195597')).toBe('standard');
    expect(templateOfCase('workspace', health)('PP-R-NOPE-1')).toBeNull();
    expect(templateOfCase('workspace', null)('PP-R-QFP-10195597')).toBeNull();
    // Inherited keys are not cases.
    expect(templateOfCase('workspace', health)('constructor')).toBeNull();
  });
  it('the Explore demo never opens a discovered case', () => {
    expect(templateOfCase('demo', health)('PP-R-QFP-10195597')).toBeNull();
  });
});

const base: DemoState = { signedIn: true, person: null, workspace: null, expiresAt: null, methods: { paypal: true, passkey: true }, unlocked: true, reasons: {}, caps: {} };
const person = (role: 'owner' | 'member', reviewer = false) => ({ id: 'p1', name: 'Dana', role, via: 'paypal' as const, email: null, reviewer, accessUntil: null });
const evaluation = { id: 'ws_1', name: 'Northwind', connected: true, connection: 'evaluation' as const };

describe('who may look for new disputes', () => {
  it('only the owner of the evaluation workspace', () => {
    expect(canFindDisputes('workspace', { ...base, person: person('owner'), workspace: evaluation })).toBe(true);
    expect(canFindDisputes('workspace', { ...base, person: person('member'), workspace: evaluation })).toBe(false);
    expect(canFindDisputes('workspace', { ...base, person: person('member', true), workspace: evaluation })).toBe(false);
    expect(canFindDisputes('workspace', { ...base, signedIn: false })).toBe(false);
    expect(canFindDisputes('workspace', null)).toBe(false);
    expect(canFindDisputes('demo', { ...base, person: person('owner'), workspace: evaluation })).toBe(false);
    expect(canFindDisputes('workspace', { ...base, person: person('owner'), workspace: { ...evaluation, connection: 'not_connected' as const } })).toBe(false);
  });
});

describe('what Find new disputes says', () => {
  it('found and skipped, with the reasons on hover', () => {
    expect(scanResultText({ created: [{ caseId: 'A', orderRef: 'rk-std-1' }], skipped: [{ disputeId: 'B', why: 'not from a ResolveKit order' }, { disputeId: 'C', why: 'already a case' }] })).toEqual({
      text: 'Found 1 new · 2 skipped',
      title: 'B: not from a ResolveKit order\nC: already a case',
    });
    expect(scanResultText({ created: [], skipped: [] })).toEqual({ text: 'Found 0 new · 0 skipped', title: null });
  });
  it('too soon: when to try again; PayPal down: a short error', () => {
    expect(scanErrorText(new HttpRequestError(429, { error: 'SCAN_TOO_SOON', detail: 'x', retryAfterSec: 42 } as never))).toBe('Looked a moment ago · try again in 42 s');
    expect(scanErrorText(new HttpRequestError(503, { error: 'PAYPAL_UNAVAILABLE', detail: 'x' }))).toBe('PayPal unavailable · try again in a moment');
    expect(scanErrorText(new HttpRequestError(403, { error: 'OWNER_ONLY', detail: 'Only the owner can look' }))).toBe('Couldn’t look for new disputes: Only the owner can look');
    expect(scanErrorText(new GatewayTimeoutError())).toBe('PayPal unavailable · try again in a moment');
    expect(scanErrorText(new GatewayUnavailableError('down'))).toBe('Couldn’t look for new disputes: down');
  });
});
