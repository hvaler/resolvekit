import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ServicesContext, type Services } from '../app/services';
import type { DemoState } from '../domain/demoClient';
import { ThemeProvider } from '../theme/ThemeProvider';
import { App } from '../App';
import { Lightbox, LandingPage } from './LandingPage';

const SIGNED_OUT: DemoState = { signedIn: false, person: null, workspace: null, expiresAt: null, methods: { paypal: true, passkey: true }, unlocked: false, reasons: {}, caps: {} };
const SIGNED_IN: DemoState = {
  ...SIGNED_OUT,
  signedIn: true,
  person: { id: 'p1', name: 'Dana Ruiz', role: 'owner', via: 'paypal', email: null, reviewer: false, accessUntil: null },
  workspace: { id: 'ws_1', name: 'Northwind Goods', connected: true, connection: 'evaluation' },
  unlocked: true,
};

function render(node: React.ReactNode, demo: DemoState | null, path = '/'): string {
  return renderToString(
    <ThemeProvider>
      <ServicesContext.Provider value={{ demo, accountKnown: true } as unknown as Services}>
        <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
      </ServicesContext.Provider>
    </ThemeProvider>,
  );
}

describe('`/` on the hosted service', () => {
  it('signed out: the landing with Sign in and Try the demo', () => {
    const html = render(<App />, SIGNED_OUT);
    expect(html).toContain('Answer PayPal disputes with evidence, not guesses.');
    expect(html).toMatch(/<a [^>]*href="\/signin"[^>]*>Sign in<\/a>/);
    expect(html).toMatch(/<a [^>]*href="\/demo"[^>]*>Try the demo<\/a>/);
    expect(html).not.toContain('Open your cases');
  });
  it('signed in: the landing too, its call to action «Open your cases →» to /cases, no Sign in', () => {
    const html = render(<App />, SIGNED_IN);
    expect(html).toContain('Answer PayPal disputes with evidence, not guesses.');
    expect(html).toMatch(/<a [^>]*href="\/cases"[^>]*>Open your cases →<\/a>/);
    expect(html).not.toMatch(/>Sign in<\/a>/);
  });
  it('signed in, back from a PayPal sign-in: not the landing (sent on to the cases)', () => {
    expect(render(<App />, SIGNED_IN, '/?signed-in=paypal')).not.toContain('Answer PayPal disputes');
  });
  it('local mode: not the landing (sent on to the cases)', () => {
    expect(render(<App />, null)).not.toContain('Answer PayPal disputes');
  });
  it('the landing logo goes home; it is not the in-app «all cases» link', () => {
    const html = render(<LandingPage />, SIGNED_IN);
    const logo = /<a [^>]*aria-label="ResolveKit, home"[^>]*>/.exec(html)?.[0];
    expect(logo).toContain('href="/"');
    expect(html).not.toContain('ResolveKit, all cases');
  });
});

describe('zoomable screenshots', () => {
  it('each screenshot is a button named «Enlarge: <alt>» with a zoom-in cursor, its caption the new captures', () => {
    const html = render(<LandingPage />, SIGNED_OUT);
    const buttons = html.match(/<button [^>]*aria-label="Enlarge: [^"]*"[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(5);
    for (const b of buttons) expect(b).toContain('cursor-zoom-in');
    expect(html).toContain('7.00 USD');
    expect(html).toContain('Apt 4 / Apt 4B');
    expect(html).toContain('E3 · UPS tracking');
    expect(html).toContain('Review what will be sent');
    expect(html).toContain('6 of 6 fields match');
    expect(html).toContain('0.45 USD of a 0.50 USD budget');
    // No dialog until one is opened.
    expect(html).not.toContain('role="dialog"');
  });
  it('the lightbox: a modal dialog labelled by its caption, the full image, a close (×)', () => {
    const html = renderToString(<Lightbox src="/landing/thumbnail.png" alt="The case file." onClose={() => {}} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    const labelled = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(labelled).toBeTruthy();
    expect(html).toMatch(new RegExp(`<figcaption [^>]*id="${labelled}"[^>]*>The case file.</figcaption>`));
    expect(html).toMatch(/<img [^>]*src="\/landing\/thumbnail.png"/);
    expect(html).toContain('object-contain');
    expect(html).toContain('max-w-[95vw]');
    expect(html).toContain('max-h-[90vh]');
    expect(html).toContain('aria-label="Close"');
  });
});
