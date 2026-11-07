/**
 * The case page's read-only wiring for an ended case, with an analysis on screen (the bundled golden analysis of a
 * simulated case the server's health lists as ended): the contradiction offers no «Explain in response» or «Mark
 * resolved…», the draft no Rephrase or Edit, and the agent case's action section shows the read-only line instead of
 * PayPal's allowed actions. The same cases not ended keep them.
 */
import { renderToString } from 'react-dom/server';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { agentCase, standardCase } from '@resolvekit/cases';
import { describe, expect, it } from 'vitest';
import { ServicesContext, ServicesProvider, useServices } from '../app/services';
import { modeFor, type ServerHealth } from '../domain/httpGateway';
import { ThemeProvider } from '../theme/ThemeProvider';
import { CasePage } from './CasePage';

const STD = standardCase.summary.id;
const AGENT = agentCase.summary.id;
const health = (id: string, template: 'standard' | 'agent', ended: boolean): ServerHealth => ({
  paypal: 'sandbox',
  bound: [],
  cases: { [id]: { template, orderRef: 'rk-x-1', source: 'webhook', createdAt: '2026-11-06T10:04:00.000Z', ended } },
});

function WithHealth({ h, children }: { h: ServerHealth; children: ReactNode }) {
  const s = useServices();
  return <ServicesContext.Provider value={{ ...s, health: h, modeKnown: true, modeOf: (id) => modeFor(id, h) }}>{children}</ServicesContext.Provider>;
}

const render = (id: string, template: 'standard' | 'agent', ended: boolean) =>
  renderToString(
    <ThemeProvider>
      <ServicesProvider latencyMs={0} server={null}>
        <WithHealth h={health(id, template, ended)}>
          <MemoryRouter initialEntries={[`/cases/${id}`]}>
            <Routes>
              <Route path="/cases/:id" element={<CasePage />} />
            </Routes>
          </MemoryRouter>
        </WithHealth>
      </ServicesProvider>
    </ThemeProvider>,
  );

describe('ended case page wiring, with an analysis on screen', () => {
  it('the contradiction and the draft offer no review when ended; they do when not', () => {
    const open = render(STD, 'standard', false);
    expect(open).toContain('Mark resolved');
    const ended = render(STD, 'standard', true);
    expect(ended).toContain('Contradiction');
    expect(ended).not.toContain('Mark resolved');
    expect(ended).not.toContain('Explain in response');
    expect(ended).not.toMatch(/aria-label="Edit sentence \d+"/);
  });
  it('an ended agent case: the action section is the read-only line, not PayPal’s allowed actions', () => {
    const open = render(AGENT, 'agent', false);
    expect(open).toContain('Action · Provide evidence');
    expect(open).not.toContain('actions-ended');
    const ended = render(AGENT, 'agent', true);
    expect(ended).toContain('data-testid="actions-ended"');
    expect(ended).not.toContain('✓ allowed');
    expect(ended).not.toContain('Also allowed now');
  });
});
