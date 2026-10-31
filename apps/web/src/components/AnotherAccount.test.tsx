/**
 * «Use another PayPal account» restarts Continue with PayPal, but PayPal keeps its own session cookie (ResolveKit
 * cannot clear it), so the same account comes back. The help next to the link says so: sign out of PayPal first (the
 * PayPal site of the environment this server uses) or use a private window.
 */
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { anotherAccountHelp } from '../domain/copy';
import { AnotherAccountHelp } from './SignOutActions';

describe('another PayPal account', () => {
  it('sandbox: sign out at www.sandbox.paypal.com first, or a private window', () => {
    const h = anotherAccountHelp('sandbox');
    expect(h.url).toBe('https://www.sandbox.paypal.com/');
    expect(h.text).toBe('PayPal keeps you signed in, so the same account may come back. Sign out of PayPal first, or use a private window.');
  });

  it('live: www.paypal.com; not known: no link, the same advice', () => {
    expect(anotherAccountHelp('live').url).toBe('https://www.paypal.com/');
    expect(anotherAccountHelp('unconfigured').url).toBeNull();
    expect(anotherAccountHelp(null).url).toBeNull();
    expect(anotherAccountHelp(null).text).toContain('or use a private window');
  });

  it('renders the help with the PayPal link (new tab), or without one', () => {
    const html = renderToString(<AnotherAccountHelp env="sandbox" />);
    expect(html).toContain('href="https://www.sandbox.paypal.com/"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('Sign out of PayPal');
    expect(html).toContain('or use a private window');
    const none = renderToString(<AnotherAccountHelp env={null} />);
    expect(none).not.toContain('href=');
    expect(none).toContain('Sign out of PayPal first, or use a private window.');
  });
});
