import { describe, expect, it } from 'vitest';
import { apiProxyDecision } from './proxyGuard';

const own = { host: 'localhost:4173', origin: 'http://localhost:4173', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };

describe('the Vite proxy only forwards the app’s own /api calls', () => {
  it('allows the app’s own GET and JSON POST (same origin, localhost or 127.0.0.1)', () => {
    expect(apiProxyDecision('GET', { host: 'localhost:4173', 'sec-fetch-site': 'same-origin' })).toEqual({ allow: true });
    expect(apiProxyDecision('POST', own)).toEqual({ allow: true });
    expect(apiProxyDecision('POST', { ...own, host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' })).toEqual({ allow: true });
  });

  it('refuses cross-site and same-site fetch metadata', () => {
    expect(apiProxyDecision('GET', { host: 'localhost:4173', 'sec-fetch-site': 'cross-site' })).toMatchObject({ allow: false, reason: 'CROSS_SITE' });
    expect(apiProxyDecision('POST', { ...own, 'sec-fetch-site': 'same-site' })).toMatchObject({ allow: false, reason: 'CROSS_SITE' });
  });

  it('refuses a foreign Origin, including another local port', () => {
    expect(apiProxyDecision('POST', { ...own, origin: 'https://evil.example', 'sec-fetch-site': undefined })).toMatchObject({ allow: false, reason: 'FORBIDDEN_ORIGIN' });
    expect(apiProxyDecision('POST', { ...own, origin: 'http://localhost:3000' })).toMatchObject({ allow: false, reason: 'FORBIDDEN_ORIGIN' });
  });

  it('refuses a foreign Host (DNS rebinding)', () => {
    expect(apiProxyDecision('GET', { host: 'evil.example:4173' })).toMatchObject({ allow: false, status: 403, reason: 'FORBIDDEN_HOST' });
  });

  it('refuses a state-changing request that is not JSON', () => {
    expect(apiProxyDecision('POST', { ...own, 'content-type': 'text/plain' })).toMatchObject({ allow: false, status: 415 });
    expect(apiProxyDecision('POST', { ...own, 'content-type': undefined })).toMatchObject({ allow: false, status: 415 });
  });
});
