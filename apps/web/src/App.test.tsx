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
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </ServicesProvider>
    </ThemeProvider>,
  );
}

describe('routes render without errors', () => {
  it('inbox', () => {
    const html = render('/cases');
    expect(html).toContain('Disputes');
    // The grid rows render in the browser (AG Grid); the page around them renders here.
    expect(html).toContain('8 disputes · 5 waiting for you · 2 due within 48 h · 1 new, still processing at PayPal');
    expect(html).toContain('Needs my approval');
    expect(html).toContain('Search disputes');
    // All eight run on the simulator here: the inbox says their due times are on the demo clock.
    expect(html).toContain('Simulated disputes run on a demo clock (8 Oct 2026 19:00 UTC), so their due times read the same any day.');
  });

  it('the inbox count is unchanged without an owner seeing the settlement case', () => {
    const html = render('/cases');
    expect(html).toContain('8 disputes · 5 waiting for you · 2 due within 48 h · 1 new, still processing at PayPal');
    expect(html).not.toContain('Owner settlement case');
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

  it('buying agent page (local mode: the operator)', () => {
    const html = render('/agent');
    expect(html).toContain('Buying agent');
    expect(html).toContain('Find the price history of ACME-42 over the last year.');
    expect(html).toContain('Simulate an outage: the first call to Deep report fails (marked as injected)');
    expect(html).toContain('Start the run');
    // Local mode has no other people: no workspace toggle.
    expect(html).not.toContain('Workspace runs');
  });

  it('agent case file', () => {
    const html = render('/cases/PP-R-MMC-10190702');
    expect(html).toContain('Per-call receipt');
    expect(html).toContain('How this goes to PayPal as digital delivery');
    expect(html).toContain(`Analysis by ${goldenAnalyses['PP-R-MMC-10190702']!.model}`);
    expect(html).toContain('All four tool calls completed successfully.');
  });

  it('not-as-described case at the claim stage: notes and documents, no message offered', () => {
    const html = render('/cases/PP-R-BLW-10187733');
    expect(html).toContain('Buyer says the colour differs from the listing');
    expect(html).toContain('Other: notes and documents');
    expect(html).toContain('Product photos record');
    expect(html).toContain('Our packing photo shows the natural tote going into the box.');
    expect(html).toContain('accept_claim');
    expect(html).not.toContain('send_message');
  });

  it('incorrect-amount agent case: the mandate and receipt, labelled demo data, sent as notes and documents', () => {
    const html = render('/cases/PP-R-KDA-10192258');
    expect(html).toContain('INCORRECT_AMOUNT');
    expect(html).toContain('Demo data');
    expect(html).toContain('Attachments to send');
    expect(html).not.toContain('How this goes to PayPal as digital delivery');
  });

  it('recorded case: the read-back of what was sent, the draft locked', () => {
    const html = render('/cases/PP-R-QZE-10181290');
    expect(html).toContain('Recorded by the simulator');
    expect(html).toContain('Sent · read-only');
    expect(html).toContain('Evidence recorded by the simulator');
    expect(html).toContain('booking-B-4471.pdf');
    expect(html).not.toContain('PayPal is asking for:');
    expect(html).not.toContain('aria-label="Edit sentence');
  });

  it('closed case: the outcome, what was sent, no actions', () => {
    const html = render('/cases/PP-R-HFA-10176021');
    expect(html).toContain('Resolved in your favour');
    expect(html).toContain('RESOLVED_SELLER_FAVOUR');
    expect(html).toContain('Closed by the simulator');
    expect(html).toContain('PayPal allows no actions for this dispute right now.');
    expect(html).toContain('usps-tracking-9400111899223100176021.pdf');
  });

  it('every inbox row opens a case (no placeholder); an unknown id is not found', () => {
    for (const id of ['PP-R-TVH-10190665', 'PP-R-MMC-10190702', 'PP-R-BLW-10187733', 'PP-R-PLN-10189901', 'PP-R-KDA-10192258', 'PP-R-QZE-10181290', 'PP-R-HFA-10176021']) {
      const html = render(`/cases/${id}`);
      expect(html, id).toContain('Response draft');
      expect(html, id).toContain(`Analysis by ${goldenAnalyses[id]!.model}`);
      expect(html, id).not.toContain('for illustration');
    }
    const missing = render('/cases/PP-R-XXX-00000000');
    expect(missing).toContain('Case not found');
    expect(missing).toContain('There is no dispute PP-R-XXX-00000000 in this workspace.');
  });

  it('processing state', () => {
    const html = render('/cases/PP-R-NKQ-10194410');
    expect(html).toContain('PayPal is processing this new dispute');
    expect(html).toContain('No actions allowed by PayPal yet');
  });
});

describe('the public demo area', () => {
  it('/demo is the inbox of every fictional case', () => {
    const html = render('/demo');
    expect(html).toContain('8 disputes');
    expect(html).toContain('Explore demo · fictional cases, nothing is sent');
  });

  it('/demo/cases/:id opens the case file on the simulator', () => {
    const html = render('/demo/cases/PP-R-TVH-10190665');
    expect(html).toContain('Response draft');
    // The demo's own indicator says it; the old simulated chip is not repeated next to it.
    expect(html).not.toContain('data-testid="mode-badge"');
    expect(html).toContain('data-testid="environment-indicator"');
    expect(html).toContain('href="/demo/cases"');
  });

  it('an unknown id in the demo is not found "in the demo"', () => {
    const html = render('/demo/cases/PP-R-XXX-00000000');
    expect(html).toContain('Case not found');
    expect(html).toContain('There is no dispute PP-R-XXX-00000000 in the demo.');
    expect(html).not.toContain('in this workspace');
  });
});
