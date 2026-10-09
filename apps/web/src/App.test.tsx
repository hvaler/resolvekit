import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { ServicesProvider } from './app/services';
import { goldenAnalyses } from './fixtures/golden';
import { ThemeProvider } from './theme/ThemeProvider';

function render(path: string): string {
  return renderToString(
    <ThemeProvider>
      <ServicesProvider latencyMs={0} server={null}>
        <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <App />
        </MemoryRouter>
      </ServicesProvider>
    </ThemeProvider>,
  );
}

describe('routes render without errors', () => {
  it('inbox', () => {
    const html = render('/');
    expect(html).toContain('Disputes');
    // The grid rows render in the browser (AG Grid); the page around them renders here.
    expect(html).toContain('8 disputes · 5 waiting for you · 2 due within 48 h · 1 new, still processing at PayPal');
    expect(html).toContain('Needs my approval');
    expect(html).toContain('Search disputes');
  });

  it('standard case file', () => {
    const html = render('/cases/PP-R-TVH-10190665');
    expect(html).toContain('Response draft');
    expect(html).toContain('PayPal is asking for:');
    expect(html).toContain('EVIDENCE_TYPE_IS_NOT_ALLOWED');
    // The real analysis: the golden one made by the model, labelled as such (no server in this test).
    const golden = goldenAnalyses['PP-R-TVH-10190665']!;
    expect(html).toContain(`Analysis by ${golden.model}`);
    expect(html).toContain('· cached');
    expect(html).toContain(golden.contradictions[0]!.title);
    expect(html).toContain('This document contains instructions');
    expect(html).toContain('The customer confirmed receipt by phone.');
    expect(html).toContain('From your notes');
    // Without the server reporting PayPal connected, the case runs on the simulator and says so.
    expect(html).toContain('Simulated PayPal');
    expect(html).not.toContain('PayPal sandbox · live');
  });

  it('agent case file', () => {
    const html = render('/cases/PP-R-MMC-10190702');
    expect(html).toContain('Per-call receipt');
    expect(html).toContain('How this goes to PayPal as digital delivery');
    expect(html).toContain(`Analysis by ${goldenAnalyses['PP-R-MMC-10190702']!.model}`);
    expect(html).toContain('All four tool calls completed successfully.');
  });

  it('processing state', () => {
    const html = render('/cases/PP-R-NKQ-10194410');
    expect(html).toContain('PayPal is processing this new dispute');
    expect(html).toContain('No actions allowed by PayPal yet');
  });
});
