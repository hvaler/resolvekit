import { renderToString } from 'react-dom/server';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ServicesContext, ServicesProvider, useServices } from '../app/services';
import { modeFor, type ServerHealth } from '../domain/httpGateway';
import { ThemeProvider } from '../theme/ThemeProvider';
import { CasePage } from './CasePage';

const ID = 'PP-R-DSC-30001';
const health = (ended: boolean): ServerHealth => ({
  paypal: 'sandbox',
  bound: [ID],
  cases: { [ID]: { template: 'standard', orderRef: 'rk-std-a1', source: 'webhook', createdAt: '2026-11-06T10:04:00.000Z', ended } },
});

/** The services as the provider builds them, with the server's `/api/health` answer already in (no effects run here). */
function WithHealth({ h, children }: { h: ServerHealth; children: ReactNode }) {
  const s = useServices();
  return <ServicesContext.Provider value={{ ...s, health: h, modeKnown: true, modeOf: (id) => modeFor(id, h) }}>{children}</ServicesContext.Provider>;
}

const render = (ended: boolean) =>
  renderToString(
    <ThemeProvider>
      <ServicesProvider latencyMs={0} server={null}>
        <WithHealth h={health(ended)}>
          <MemoryRouter initialEntries={[`/cases/${ID}`]}>
            <Routes>
              <Route path="/cases/:id" element={<CasePage />} />
            </Routes>
          </MemoryRouter>
        </WithHealth>
      </ServicesProvider>
    </ThemeProvider>,
  );

describe('an ended discovered case is read-only on screen', () => {
  it('says so, and offers no send controls (composer blocked, actions and uploads locked with the same reason)', () => {
    const html = render(true);
    expect(html).toContain('data-testid="case-ended"');
    expect(html).toContain('This case has ended · read-only');
    expect(html).not.toContain('Review what will be sent');
    // «+ Add evidence» is disabled with the reason.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="This case has ended · read-only"[^>]*>\+ Add evidence<\/button>/);
  });
  it('no live re-run or replay, and «What to do» offers no action, only the read-only line', () => {
    const html = render(true);
    expect(html).not.toContain('Re-run with AI');
    expect(html).not.toContain('Replay analysis');
    const what = html.slice(html.indexOf('>What to do<'));
    expect(what).not.toContain('role="radio"');
    expect(what).toContain('data-testid="actions-ended"');
    expect(what).not.toContain('PayPal allows');
  });
  it('an open discovered case keeps the re-run and today’s «What to do» (PayPal’s actions; none while its read is pending)', () => {
    const html = render(false);
    expect(html).toContain('Re-run with AI');
    expect(html.slice(html.indexOf('>What to do<'))).toContain('PayPal allows no actions for this dispute right now.');
    expect(html).not.toContain('actions-ended');
  });
  it('an open discovered case has no read-only line', () => {
    const html = render(false);
    expect(html).toContain('Discovered from PayPal (webhook)');
    expect(html).not.toContain('case-ended');
    expect(html).not.toContain('This case has ended');
  });
});
