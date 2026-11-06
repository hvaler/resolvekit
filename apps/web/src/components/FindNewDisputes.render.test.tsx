import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ServicesContext, type Services } from '../app/services';
import type { DemoState } from '../domain/demoClient';
import type { Area } from '../domain/environment';
import { CaseHeader } from './CaseHeader';
import { FindNewDisputes } from './FindNewDisputes';
import type { HeaderView } from '../domain/paypalView';

const SIGNED_OUT: DemoState = { signedIn: false, person: null, workspace: null, expiresAt: null, methods: { paypal: true, passkey: true }, unlocked: false, reasons: {}, caps: {} };
const evaluation = { id: 'ws_1', name: 'Northwind Goods', connected: true, connection: 'evaluation' as const };
const as = (role: 'owner' | 'member', reviewer = false, workspace: DemoState['workspace'] = evaluation): DemoState => ({
  ...SIGNED_OUT,
  signedIn: true,
  person: { id: 'p1', name: 'Dana Ruiz', role, via: 'paypal', email: null, reviewer, accessUntil: null },
  workspace,
  unlocked: true,
});

const render = (demo: DemoState | null, area: Area = 'workspace') =>
  renderToString(
    <ServicesContext.Provider value={{ demo, area, accountKnown: true, retryHealth: () => {} } as unknown as Services}>
      <FindNewDisputes scan={async () => ({ created: [], skipped: [] })} />
    </ServicesContext.Provider>,
  );

describe('Find new disputes', () => {
  it('is shown to the owner of the evaluation workspace', () => {
    expect(render(as('owner'))).toMatch(/<button [^>]*>Find new disputes<\/button>/);
  });
  it('is not shown to members, reviewers, the signed out, another workspace, local mode or the Explore demo', () => {
    for (const html of [
      render(as('member')),
      render(as('member', true)),
      render(SIGNED_OUT),
      render(as('owner', false, { ...evaluation, connection: 'not_connected' })),
      render(null),
      render(as('owner'), 'demo'),
    ])
      expect(html).not.toContain('Find new disputes');
  });
});

describe('the case header’s provenance line', () => {
  const view = { amount: '7.00', currency: 'USD', reasonText: 'r', reasonCode: null, itemType: null, stage: null, stageEmpty: '—', status: null, statusEmpty: '', statusDetail: '', due: null, dueClock: null, dueEmpty: { text: '—', sub: null }, transactionId: '—', transactionText: '', disputeLine: null, notice: null, mismatch: null } satisfies HeaderView;
  it('is shown for a discovered case only', () => {
    expect(renderToString(<CaseHeader view={view} provenance="Discovered from PayPal (webhook) · dispute X" />)).toContain('Discovered from PayPal (webhook) · dispute X');
    expect(renderToString(<CaseHeader view={view} />)).not.toContain('case-provenance');
  });
});
