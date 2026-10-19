import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServicesContext, type Services } from '../app/services';
import type { DemoState } from '../domain/demoClient';
import { ThemeProvider } from '../theme/ThemeProvider';
import { SignInPage } from './AuthPages';

const SIGNED_OUT: DemoState = { signedIn: false, person: null, workspace: null, expiresAt: null, methods: { paypal: true, passkey: true }, unlocked: false, reasons: {}, caps: {} };

/** The sign-in page as a signed-out visitor of the hosted demo sees it (only `demo` is read from the services). */
function signIn(): string {
  // The page reads its query (`next`, `error`) from the address bar.
  vi.stubGlobal('window', { location: { search: '', hash: '', origin: 'https://rk.example.com' } });
  return renderToString(
    <ThemeProvider>
      <ServicesContext.Provider value={{ demo: SIGNED_OUT, accountKnown: true } as unknown as Services}>
        <MemoryRouter initialEntries={['/signin']}>
          <SignInPage />
        </MemoryRouter>
      </ServicesContext.Provider>
    </ThemeProvider>,
  );
}

afterEach(() => void vi.unstubAllGlobals());

describe('sign-in page', () => {
  it('«Explore without signing in» opens the Explore demo, not the cases (which send a signed-out visitor back here)', () => {
    const html = signIn();
    expect(html).toContain('Continue with PayPal');
    expect(html).toMatch(/<a [^>]*href="\/demo"[^>]*>Explore without signing in<\/a>/);
    expect(html).not.toContain('href="/cases"');
  });
});
