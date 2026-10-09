import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  DailyCounters,
  KeyedLimiter,
  LIVE_OPT_IN,
  describeClientIp,
  isPrivateAddress,
  paypalEnvFor,
  PEER_HEADER,
  StaticSite,
  clientIp,
  demoCookie,
  publicOrigins,
  readCookie,
  sameSecret,
  signDemoSession,
  verifyDemoSession,
  withSecurityHeaders,
} from '../src/index.ts';

const req = (headers: Record<string, string> = {}, path = '/', method = 'GET') => new Request(`http://x.example${path}`, { headers, method });

test('clientIp: one trusted hop takes the last X-Forwarded-For entry; client-written entries are ignored', () => {
  assert.equal(clientIp(req({ 'x-forwarded-for': '203.0.113.9' })), '203.0.113.9');
  assert.equal(clientIp(req({ 'x-forwarded-for': '1.1.1.1, 6.6.6.6, 203.0.113.9' })), '203.0.113.9');
  assert.equal(clientIp(req({ 'x-forwarded-for': '1.1.1.1, 203.0.113.9' }), 2), '1.1.1.1');
  // IPv6 is keyed per /64 (one subscriber's prefix), IPv4-mapped addresses unwrapped.
  assert.equal(clientIp(req({ 'x-forwarded-for': '2001:db8::1' })), '2001:db8:0:0::/64');
  assert.equal(clientIp(req({ 'x-forwarded-for': '2001:db8:0:0:ffff:1:2:3' })), '2001:db8:0:0::/64');
  assert.equal(clientIp(req({ 'x-forwarded-for': '::ffff:203.0.113.9' })), '203.0.113.9');
  assert.equal(clientIp(req({ 'x-forwarded-for': 'evil<script>' })), 'invalid');
  assert.equal(clientIp(req({ [PEER_HEADER]: '127.0.0.1' })), '127.0.0.1');
  assert.equal(clientIp(req()), 'unknown');
});

test('clientIp: X-Forwarded-For is believed only from a proxy on a private address (review 7)', () => {
  // Render's proxy connects from a private address: its header is used.
  assert.equal(clientIp(req({ [PEER_HEADER]: '10.0.3.7', 'x-forwarded-for': '1.1.1.1, 203.0.113.9' })), '203.0.113.9');
  assert.equal(clientIp(req({ [PEER_HEADER]: '::ffff:10.0.3.7', 'x-forwarded-for': '203.0.113.9' })), '203.0.113.9');
  // Straight from the internet: a forged header is ignored; the TCP address is the key.
  assert.equal(clientIp(req({ [PEER_HEADER]: '198.51.100.20', 'x-forwarded-for': '203.0.113.9' })), '198.51.100.20');
  assert.equal(clientIp(req({ [PEER_HEADER]: '198.51.100.20', 'x-forwarded-for': '203.0.113.9' }), 1, 'any'), '203.0.113.9');
  assert.equal(clientIp(req({ [PEER_HEADER]: '10.0.3.7', 'x-forwarded-for': '203.0.113.9' }), 1, 'none'), '10.0.3.7');
  for (const a of ['10.1.2.3', '172.16.0.1', '192.168.1.1', '100.64.0.1', '127.0.0.1', '::1', 'fd00::1']) assert.equal(isPrivateAddress(a), true, a);
  for (const a of ['8.8.8.8', '172.32.0.1', '2001:db8::1']) assert.equal(isPrivateAddress(a), false, a);
  // The startup log line hides host parts.
  const line = describeClientIp(req({ [PEER_HEADER]: '10.0.3.7', 'x-forwarded-for': '1.2.3.4, 203.0.113.9' }));
  assert.match(line, /peer 10\.0\.3\.x \(private\) · X-Forwarded-For 2 entries \[1\.2\.3\.x, 203\.0\.113\.x\] believed · trusted hops 1 · client key 203\.0\.113\.x/);
  assert.ok(!line.includes('203.0.113.9') && !line.includes('10.0.3.7'));
});

test('KeyedLimiter: per key, fixed window, retry-after', () => {
  let t = 0;
  const l = new KeyedLimiter({ limit: 2, windowMs: 1000, now: () => t });
  assert.equal(l.take('a').ok, true);
  assert.equal(l.take('a').ok, true);
  const no = l.take('a');
  assert.equal(no.ok, false);
  assert.equal(!no.ok && no.retryAfterSec, 1);
  assert.equal(l.take('b').ok, true);
  t = 1000;
  assert.equal(l.take('a').ok, true);
});

test('KeyedLimiter: memory stays bounded under a flood of keys', () => {
  const l = new KeyedLimiter({ limit: 1, windowMs: 60_000, maxKeys: 100 });
  for (let i = 0; i < 1000; i++) l.take(`k${i}`);
  assert.ok((l as unknown as { hits: Map<string, unknown> }).hits.size <= 101);
});

test('DailyCounters: cap per UTC day, persisted across restarts, resets the next day', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-counters-'));
  try {
    const file = join(dir, 'caps.json');
    let now = new Date('2026-10-09T23:00:00Z');
    const a = new DailyCounters({ file, limits: { live: 2 }, now: () => now });
    assert.equal(a.take('live'), true);
    const b = new DailyCounters({ file, limits: { live: 2 }, now: () => now });
    assert.equal(b.remaining('live'), 1);
    assert.equal(b.take('live'), true);
    assert.equal(b.take('live'), false);
    assert.equal(b.state().caps.live!.used, 2);
    assert.equal(b.state().resetsAt, '2026-10-10T00:00:00.000Z');
    assert.equal(b.take('unknown'), false);
    now = new Date('2026-10-10T00:00:01Z');
    assert.equal(b.take('live'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('demo session: valid, expired, tampered, foreign secret, malformed, too far in the future', () => {
  const secret = 's'.repeat(44);
  const now = 1_800_000_000_000;
  const ttl = 12 * 3_600_000;
  const v = signDemoSession(secret, now + ttl);
  assert.deepEqual(verifyDemoSession(secret, v, now, ttl), { ok: true, expiresAt: now + ttl });
  assert.equal(verifyDemoSession(secret, v, now + ttl, ttl).ok, false);
  const [exp, nonce, sig] = v.split('.');
  assert.deepEqual(verifyDemoSession(secret, `${Number(exp) + 1000}.${nonce}.${sig}`, now, ttl), { ok: false, reason: 'bad_signature' });
  const flipped = sig!.slice(0, -1) + (sig!.endsWith('A') ? 'B' : 'A');
  assert.equal(verifyDemoSession(secret, `${exp}.${nonce}.${flipped}`, now, ttl).ok, false);
  assert.deepEqual(verifyDemoSession('other-secret', v, now, ttl), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verifyDemoSession(secret, 'garbage', now, ttl), { ok: false, reason: 'malformed' });
  assert.deepEqual(verifyDemoSession(secret, null, now, ttl), { ok: false, reason: 'missing' });
  const far = signDemoSession(secret, now + 30 * ttl);
  assert.deepEqual(verifyDemoSession(secret, far, now, ttl), { ok: false, reason: 'expired' });
});

test('cookie helpers: HttpOnly, Secure, SameSite=Strict; reading one cookie among several', () => {
  const c = demoCookie('abc', 43200);
  for (const part of ['rk_demo=abc', 'Path=/', 'Max-Age=43200', 'HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(c.includes(part), part);
  assert.equal(readCookie(req({ cookie: 'a=1; rk_demo=xyz; b=2' }), 'rk_demo'), 'xyz');
  assert.equal(readCookie(req({ cookie: 'a=1' }), 'rk_demo'), null);
});

test('sameSecret: equal only for equal strings, any lengths', () => {
  assert.equal(sameSecret('code-123', 'code-123'), true);
  assert.equal(sameSecret('code-123', 'code-124'), false);
  assert.equal(sameSecret('short', 'a much longer guess'), false);
});

test('security headers: CSP kept when present, HSTS only over https', async () => {
  const r = withSecurityHeaders(new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } }), { hsts: true });
  assert.equal(r.status, 201);
  assert.match(r.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.match(r.headers.get('strict-transport-security')!, /max-age=31536000/);
  assert.equal(await r.text(), '{}');
  const page = withSecurityHeaders(new Response('', { headers: { 'content-security-policy': "default-src 'none'" } }), { hsts: false });
  assert.equal(page.headers.get('content-security-policy'), "default-src 'none'");
  assert.equal(page.headers.get('strict-transport-security'), null);
});

test('StaticSite: files, gzip, immutable assets, SPA fallback, 404 for missing files, no traversal', async () => {
  const big = new TextEncoder().encode('console.log(1);'.repeat(200));
  const site = new StaticSite([
    ['/index.html', new TextEncoder().encode('<!doctype html><div id=root></div>')],
    ['/assets/app-1234.js', big],
    ['/favicon.svg', new TextEncoder().encode('<svg/>')],
  ]);
  const idx = site.serve(req({}, '/'))!;
  assert.equal(idx.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(idx.headers.get('cache-control'), 'no-cache');
  const js = site.serve(req({ 'accept-encoding': 'gzip, br' }, '/assets/app-1234.js'))!;
  assert.equal(js.headers.get('content-encoding'), 'gzip');
  assert.equal(js.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.deepEqual(new Uint8Array(gunzipSync(Buffer.from(await js.arrayBuffer()))), big);
  const plain = site.serve(req({}, '/assets/app-1234.js'))!;
  assert.equal(plain.headers.get('content-encoding'), null);
  const route = site.serve(req({}, '/cases/PP-R-TVH-10190665'))!;
  assert.match(await route.text(), /id=root/);
  assert.equal(site.serve(req({}, '/assets/missing.js'))!.status, 404);
  assert.equal(site.serve(req({}, '/robots.txt'))!.status, 404);
  // Dot segments are resolved by URL parsing and only build files are ever served: never a file outside the build.
  assert.match(await site.serve(req({}, '/%2e%2e/%2e%2e/etc/passwd'))!.text(), /id=root/);
  assert.equal(site.serve(req({}, '/..%2f..%2fpackage.json'))!.status, 404);
  assert.equal(site.serve(req({}, '/%E0%A4%A'))!.status, 400);
  assert.equal(site.serve(req({}, '/', 'POST')), null);
  assert.equal(await site.serve(req({}, '/', 'HEAD'))!.text(), '');
  assert.throws(() => new StaticSite([['/a.js', big]]), /index\.html/);
});

test('publicOrigins: Render URL plus custom domains', () => {
  assert.deepEqual(publicOrigins('https://rk.onrender.com', 'demo.example.com'), {
    origins: ['https://rk.onrender.com', 'https://demo.example.com'],
    hosts: ['rk.onrender.com', 'demo.example.com'],
    https: true,
  });
  assert.equal(publicOrigins('http://localhost:10000', undefined).https, false);
});

test('DailyCounters: concurrent takes never exceed the cap; release refunds today only', async () => {
  let now = new Date('2026-10-09T12:00:00Z');
  const c = new DailyCounters({ file: null, limits: { send: 3 }, now: () => now });
  const results = await Promise.all(Array.from({ length: 20 }, async () => {
    await new Promise((r) => setTimeout(r, Math.random() * 5));
    return c.take('send');
  }));
  assert.equal(results.filter(Boolean).length, 3);
  const day = c.today();
  c.release('send', day);
  assert.equal(c.remaining('send'), 1);
  assert.equal(c.take('send'), true);
  assert.equal(c.take('send'), false);
  now = new Date('2026-10-10T00:00:01Z');
  c.take('send');
  c.release('send', day); // yesterday's refund does not touch today's count
  assert.equal(c.remaining('send'), 2);
});

test('env guard: hosted mode starts only on PAYPAL_ENV=sandbox; live needs the explicit opt-in; render.yaml never sets it', async () => {
  assert.deepEqual(paypalEnvFor({ PAYPAL_ENV: 'sandbox' }, true), { ok: true, env: 'sandbox' });
  for (const v of [undefined, 'live', 'Sandbox', 'prod', '']) {
    const r = paypalEnvFor(v === undefined ? {} : { PAYPAL_ENV: v }, true);
    assert.equal(r.ok, false, String(v));
  }
  assert.equal(paypalEnvFor({ PAYPAL_ENV: 'live', [LIVE_OPT_IN.name]: 'yes' }, true).ok, false);
  assert.deepEqual(paypalEnvFor({ PAYPAL_ENV: 'live', [LIVE_OPT_IN.name]: LIVE_OPT_IN.value }, true), { ok: true, env: 'live' });
  // Local mode is unchanged.
  assert.deepEqual(paypalEnvFor({}, false), { ok: true, env: 'sandbox' });
  // The deploy blueprint: both services on the sandbox, and no live opt-in anywhere.
  const { readFileSync } = await import('node:fs');
  const yaml = readFileSync(new URL('../../../render.yaml', import.meta.url), 'utf8');
  const values = [...yaml.matchAll(/key: PAYPAL_ENV\s*\n\s*value: (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(values, ['sandbox', 'sandbox']);
  assert.ok(!yaml.includes(LIVE_OPT_IN.name));
});
