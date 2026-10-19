/**
 * Hosted mode (public internet, e.g. Render): the building blocks apps/server and apps/metermcp share. Local mode
 * never uses them.
 *
 * - {@link clientIp}: the client address behind exactly N trusted proxy hops (Render: one, its own proxy).
 * - {@link KeyedLimiter}: fixed-window rate limit per key (client IP).
 * - {@link DailyCounters}: global per-day caps, persisted to a JSON file on the service's disk.
 * - {@link signDemoSession} / {@link verifyDemoSession}: the HMAC-signed demo-unlock cookie.
 * - {@link withSecurityHeaders}: CSP, HSTS, nosniff, frame-ancestors 'none', Referrer-Policy.
 * - {@link StaticSite}: the built web app served from memory, with the SPA fallback.
 * - {@link writeFileDurable} / {@link appendFileDurable} (durable.ts): the stores' writes to the data dir, in both
 *   modes (packages/analyst's cache too).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { writeFileDurable } from './durable.ts';

export * from './durable.ts';

/** Constant-time comparison of two secrets of any length (both are hashed first, so lengths do not leak). */
export function sameSecret(a: string, b: string): boolean {
  const x = createHash('sha256').update(a, 'utf8').digest();
  const y = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(x, y);
}

/**
 * Set by the node:http adapter to the TCP peer address (any copy sent by a client is removed first). It is the
 * client only when no proxy is in front.
 */
export const PEER_HEADER = 'x-resolvekit-peer';

const IP_CHARS = /^[0-9A-Fa-f:.]{2,45}$/;

/** Whose X-Forwarded-For is believed: a proxy on a private/loopback address (default), any peer, or none. */
export type ProxyTrust = 'private' | 'any' | 'none';

const v4 = (ip: string): number[] | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  return m ? m.slice(1).map(Number) : null;
};
const unmap = (ip: string) => ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');

/** Loopback, private (RFC 1918), shared/CGNAT (100.64/10), link-local, IPv6 unique-local: where a platform proxy sits. */
export function isPrivateAddress(raw: string): boolean {
  const ip = unmap(raw.trim());
  const a = v4(ip);
  if (a) {
    const [x, y] = a as [number, number];
    return x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127) || (x === 169 && y === 254);
  }
  const l = ip.toLowerCase();
  return l === '::1' || /^f[cd][0-9a-f]{2}:/.test(l) || /^fe[89ab][0-9a-f]:/.test(l);
}

/** The key limits use for an address: IPv4 as is (IPv4-mapped unwrapped), IPv6 per /64 (one subscriber's prefix). */
export function addressKey(raw: string): string {
  const ip = unmap(raw.trim());
  if (!ip.includes(':')) return ip;
  const [head, tail] = ip.toLowerCase().split('::') as [string, string | undefined];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const full = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${full.slice(0, 4).map((h) => h.replace(/^0+(?=.)/, '') || '0').join(':')}::/64`;
}

/**
 * Cloudflare's published edge ranges (https://www.cloudflare.com/ips-v4/ and /ips-v6/, read 2026-10-09). Render serves
 * *.onrender.com through Cloudflare, so the entry Render's proxy appends is normally a Cloudflare edge.
 */
const CLOUDFLARE_CIDRS = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

/** An address as a bigint plus its family, or null when it is not an IP literal. */
function ipBits(raw: string): { v: 4 | 6; n: bigint } | null {
  const ip = unmap(raw.trim());
  const a = v4(ip);
  if (a) return a.every((o) => o <= 255) ? { v: 4, n: a.reduce((acc, o) => (acc << 8n) | BigInt(o), 0n) } : null;
  if (!ip.includes(':') || !IP_CHARS.test(ip)) return null;
  const [head, tail] = ip.toLowerCase().split('::') as [string, string | undefined];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return { v: 6, n: groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n) };
}

/** True when `raw` lies inside one of `cidrs` (IPv4 or IPv6). */
export function inCidrs(raw: string, cidrs: readonly string[]): boolean {
  const ip = ipBits(raw);
  if (!ip) return false;
  return cidrs.some((c) => {
    const [base, len] = c.split('/') as [string, string];
    const b = ipBits(base);
    if (!b || b.v !== ip.v) return false;
    const width = ip.v === 4 ? 32n : 128n;
    const shift = width - BigInt(Number(len));
    return ip.n >> shift === b.n >> shift;
  });
}

/** The proxies whose appended entry may be skipped: Cloudflare's edges (the hop in front of Render's own proxy). */
export const TRUSTED_EDGE_CIDRS: readonly string[] = CLOUDFLARE_CIDRS;

/**
 * The client's address, as the key limits use ({@link addressKey}: IPv6 per /64). Each proxy appends the address it
 * received the connection from to X-Forwarded-For. Render's proxy appends the last entry (believed only when the TCP
 * peer is a proxy we trust: by default a private/loopback address, where a platform proxy connects from). With
 * `trustedHops` > 1, the walk from the end skips an entry only while that entry is a known edge proxy
 * ({@link TRUSTED_EDGE_CIDRS}: Cloudflare), so a request that reaches Render's proxy without going through Cloudflare
 * is keyed on its own address, and nothing a client writes in X-Forwarded-For is ever believed. A request straight
 * from the internet is keyed on its own TCP address. (Requests built in-process, without the peer header, are tests:
 * the header is used.)
 */
export function clientIp(req: Request, trustedHops = 1, trust: ProxyTrust = 'private', edges: readonly string[] = TRUSTED_EDGE_CIDRS): string {
  const peer = req.headers.get(PEER_HEADER);
  const believe = trust === 'any' || (trust === 'private' && (peer == null || isPrivateAddress(peer)));
  const xff = req.headers.get('x-forwarded-for');
  if (believe && xff && trustedHops > 0) {
    const hops = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length) {
      let i = hops.length - 1;
      for (let skipped = 1; skipped < trustedHops && i > 0 && inCidrs(hops[i]!, edges); skipped++) i--;
      const ip = hops[i]!;
      return IP_CHARS.test(ip) ? addressKey(ip) : 'invalid';
    }
  }
  return peer && IP_CHARS.test(peer) ? addressKey(peer) : 'unknown';
}

/** An address with its host part hidden (for logs): 203.0.113.x, 2001:db8:…. */
export function maskAddress(raw: string | null | undefined): string {
  if (!raw) return 'none';
  const ip = unmap(raw.trim());
  const a = v4(ip);
  if (a) return `${a[0]}.${a[1]}.${a[2]}.x`;
  return ip.includes(':') ? `${ip.split(':').slice(0, 2).join(':')}:…` : 'invalid';
}

/** How the client address of this request was derived, masked, for a one-time startup log line. */
export function describeClientIp(req: Request, trustedHops = 1, trust: ProxyTrust = 'private'): string {
  const peer = req.headers.get(PEER_HEADER);
  const xff = (req.headers.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const believed = trust === 'any' || (trust === 'private' && (peer == null || isPrivateAddress(peer)));
  return `peer ${maskAddress(peer)} (${peer ? (isPrivateAddress(peer) ? 'private' : 'public') : 'none'}) · X-Forwarded-For ${xff.length} entr${xff.length === 1 ? 'y' : 'ies'} [${xff.map(maskAddress).join(', ')}] ${believed ? 'believed' : 'ignored'} · trusted hops ${trustedHops} · client key ${maskAddress(clientIp(req, trustedHops, trust).replace(/::\/64$/, ''))}`;
}

/** The Host the request was sent to (lower-cased). */
export const hostOf = (req: Request): string => (req.headers.get('host') ?? new URL(req.url).host).toLowerCase();

// ---------------------------------------------------------------------------------------------------------------
// Rate limits

export type Take = { ok: true; remaining: number } | { ok: false; retryAfterSec: number };

/** Fixed-window limit per key (e.g. client IP): `limit` requests per `windowMs`. Bounded memory. */
export class KeyedLimiter {
  private readonly hits = new Map<string, { start: number; count: number }>();
  private readonly o: { limit: number; windowMs: number; now: () => number; maxKeys: number };
  constructor(o: { limit: number; windowMs: number; now?: () => number; maxKeys?: number }) {
    this.o = { now: Date.now, maxKeys: 20_000, ...o };
  }

  take(key: string): Take {
    const t = this.o.now();
    let h = this.hits.get(key);
    if (!h || t - h.start >= this.o.windowMs) {
      if (!h) this.prune(t);
      h = { start: t, count: 0 };
      this.hits.set(key, h);
    }
    if (h.count >= this.o.limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((h.start + this.o.windowMs - t) / 1000)) };
    h.count++;
    return { ok: true, remaining: this.o.limit - h.count };
  }

  /** How many requests `key` has used in its current window (0 when none). */
  used(key: string): number {
    const h = this.hits.get(key);
    return h && this.o.now() - h.start < this.o.windowMs ? h.count : 0;
  }

  /** Seconds until `key`'s window ends (1 at least). */
  retryAfterSec(key: string): number {
    const h = this.hits.get(key);
    return h ? Math.max(1, Math.ceil((h.start + this.o.windowMs - this.o.now()) / 1000)) : 1;
  }

  /** Give back one request taken in the current window (the action it counted for did not happen). */
  release(key: string): void {
    const h = this.hits.get(key);
    if (h && h.count > 0 && this.o.now() - h.start < this.o.windowMs) h.count -= 1;
  }

  /**
   * Whether `key` has no requests left in its window, without counting one. With {@link take} in the same
   * synchronous step (check, then count failures) it limits failures only, e.g. wrong demo codes.
   */
  blocked(key: string): boolean {
    const h = this.hits.get(key);
    return !!h && this.o.now() - h.start < this.o.windowMs && h.count >= this.o.limit;
  }

  private prune(t: number) {
    if (this.hits.size < this.o.maxKeys) return;
    for (const [k, h] of this.hits) if (t - h.start >= this.o.windowMs) this.hits.delete(k);
    // Still full (a flood of distinct keys): drop the oldest windows.
    for (const k of this.hits.keys()) {
      if (this.hits.size < this.o.maxKeys) break;
      this.hits.delete(k);
    }
  }
}

/**
 * Global caps per UTC day (e.g. live AI runs, evidence sends, budgets), persisted so a restart or redeploy does not
 * reset them. `file` null keeps them in memory (tests).
 */
export class DailyCounters {
  private readonly file: string | null;
  private readonly now: () => Date;
  readonly limits: Readonly<Record<string, number>>;
  private day = '';
  private counts: Record<string, number> = {};
  /**
   * Why reservations are refused now (fail closed): the file was there but unreadable at start (kept as it is, so
   * what was used today is not lost by overwriting it), or the last save failed (each reservation tries again).
   */
  private broken: { kind: 'unreadable' | 'unsaved'; detail: string } | null = null;

  constructor(o: { file: string | null; limits: Record<string, number>; now?: () => Date }) {
    this.file = o.file;
    this.limits = { ...o.limits };
    this.now = o.now ?? (() => new Date());
    this.load();
  }

  /** Read the caps file (at start, and again while it is unreadable: fixing it needs no restart). */
  private load() {
    if (this.file) {
      this.broken = null;
      let text: string | null = null;
      try {
        text = readFileSync(this.file, 'utf8');
      } catch (e) {
        // No file yet: start at zero. Any other read error: what was used today is unknown.
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.broken = { kind: 'unreadable', detail: `the daily caps file is unreadable (${(e as Error).message})` };
      }
      if (text != null) {
        try {
          const saved = JSON.parse(text) as { day?: unknown; counts?: unknown };
          if (typeof saved.day === 'string' && saved.counts && typeof saved.counts === 'object') {
            this.day = saved.day;
            for (const [k, v] of Object.entries(saved.counts)) if (Number.isSafeInteger(v) && (v as number) >= 0) this.counts[k] = v as number;
          }
        } catch {
          this.broken = { kind: 'unreadable', detail: 'the daily caps file is unreadable (not JSON): fix or remove it' };
        }
      }
    }
  }

  /** Why costly actions are refused regardless of the caps (null: the caps file is fine). */
  storageProblem(): string | null {
    return this.broken?.detail ?? null;
  }

  private roll() {
    const today = this.now().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.counts = {};
    }
  }

  remaining(name: string): number {
    this.roll();
    return Math.max(0, (this.limits[name] ?? 0) - (this.counts[name] ?? 0));
  }

  /**
   * Reserve one: check and count in one synchronous step (no await in between), so concurrent requests can never
   * overshoot the cap. False, and nothing counted, when today's cap is reached. The file is rewritten whole from
   * memory on every change, so no update is lost (one process owns the file).
   */
  take(name: string): boolean {
    return this.reserve(name).ok;
  }

  /**
   * {@link take}, saying why it was refused: today's cap, or the caps cannot be persisted. A reservation is counted
   * only once it is on disk: if saving fails it is undone and refused, so a restart can never forget a costly action.
   */
  reserve(name: string): { ok: true } | { ok: false; reason: 'cap' | 'storage' } {
    if (this.broken?.kind === 'unreadable') this.load();
    if (this.broken?.kind === 'unreadable') return { ok: false, reason: 'storage' };
    if (this.remaining(name) <= 0) return { ok: false, reason: 'cap' };
    this.counts[name] = (this.counts[name] ?? 0) + 1;
    if (!this.save()) {
      this.counts[name]! -= 1;
      return { ok: false, reason: 'storage' };
    }
    return { ok: true };
  }

  /** Refund one taken on `day` (the action did not happen). A refund for an earlier day is dropped: it was reset. */
  release(name: string, day: string): void {
    this.roll();
    if (day !== this.day || !this.counts[name]) return;
    this.counts[name]! -= 1;
    this.save();
  }

  /** The current UTC day, as {@link release} expects it. */
  today(): string {
    this.roll();
    return this.day;
  }

  state(): { day: string; resetsAt: string; caps: Record<string, { limit: number; used: number; remaining: number }> } {
    this.roll();
    const caps = Object.fromEntries(
      Object.entries(this.limits).map(([k, limit]) => [k, { limit, used: this.counts[k] ?? 0, remaining: Math.max(0, limit - (this.counts[k] ?? 0)) }]),
    );
    const next = new Date(`${this.day}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return { day: this.day, resetsAt: next.toISOString(), caps };
  }

  /** Whether the counts are on disk now. An unreadable file is never overwritten (it may hold today's use). */
  private save(): boolean {
    if (!this.file) return true;
    if (this.broken?.kind === 'unreadable') return false;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileDurable(this.file, JSON.stringify({ day: this.day, counts: this.counts }));
      this.broken = null;
      return true;
    } catch (e) {
      // A refund that is not saved only leaves the file counting one more: on the safe side.
      this.broken = { kind: 'unsaved', detail: `the daily caps cannot be saved (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}): costly actions are refused until they can` };
      return false;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Demo unlock: a signed, expiring session cookie

export const DEMO_COOKIE = 'rk_demo';
const b64url = (b: Buffer) => b.toString('base64url');
const mac = (secret: string, payload: string) => b64url(createHmac('sha256', secret).update(`rk-demo-v1|${payload}`).digest());

/** Cookie value `<expiry ms>.<nonce>.<HMAC-SHA256(secret, expiry.nonce)>`. */
export function signDemoSession(secret: string, expiresAtMs: number): string {
  const payload = `${Math.floor(expiresAtMs)}.${b64url(randomBytes(12))}`;
  return `${payload}.${mac(secret, payload)}`;
}

export type DemoSession = { ok: true; expiresAt: number } | { ok: false; reason: 'missing' | 'malformed' | 'bad_signature' | 'expired' };

/** Checks the signature (constant time) and the expiry; an expiry further away than `maxTtlMs` is refused too. */
export function verifyDemoSession(secret: string, value: string | null, nowMs: number, maxTtlMs: number): DemoSession {
  if (!value) return { ok: false, reason: 'missing' };
  const m = /^(\d{1,16})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m) return { ok: false, reason: 'malformed' };
  const expected = Buffer.from(mac(secret, `${m[1]}.${m[2]}`));
  const got = Buffer.from(m[3]!);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return { ok: false, reason: 'bad_signature' };
  const exp = Number(m[1]);
  if (exp <= nowMs || exp > nowMs + maxTtlMs + 60_000) return { ok: false, reason: 'expired' };
  return { ok: true, expiresAt: exp };
}

export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get('cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** HttpOnly, Secure, SameSite=Strict, whole site. (Browsers accept Secure cookies on http://localhost.) */
export function demoCookie(value: string, maxAgeSec: number): string {
  return `${DEMO_COOKIE}=${value}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}; HttpOnly; Secure; SameSite=Strict`;
}

// ---------------------------------------------------------------------------------------------------------------
// Security headers

/** The web app: its own scripts only; styles also inline (AG Grid injects its theme CSS) and Google Fonts. */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** API answers (JSON, PDF): nothing to load or run. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/** A copy of `res` with the security headers set (a CSP the response already has is kept). */
export function withSecurityHeaders(res: Response, o: { hsts: boolean; csp?: string }): Response {
  const h = new Headers(res.headers);
  if (!h.has('content-security-policy')) h.set('content-security-policy', o.csp ?? API_CSP);
  h.set('x-content-type-options', 'nosniff');
  h.set('x-frame-options', 'DENY');
  h.set('referrer-policy', 'no-referrer');
  h.set('cross-origin-opener-policy', 'same-origin');
  h.set('cross-origin-resource-policy', 'same-origin');
  h.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (o.hsts) h.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

// ---------------------------------------------------------------------------------------------------------------
// Static site (the built web app)

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};
const COMPRESSIBLE = /^(text\/|application\/json|image\/svg)/;

interface StaticFile {
  body: Uint8Array;
  gz: Uint8Array | null;
  type: string;
  cache: string;
}

/**
 * The files of a built single-page app, read into memory once. Only paths that are files of the build are served
 * (no filesystem lookups per request, so no traversal); other extension-less paths get index.html (client routes).
 */
export class StaticSite {
  private readonly files = new Map<string, StaticFile>();

  constructor(files: Iterable<[string, Uint8Array]>) {
    for (const [path, body] of files) {
      const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
      const gzBody = COMPRESSIBLE.test(type) && body.length > 1024 ? gzipSync(body, { level: 9 }) : null;
      this.files.set(path, {
        body,
        gz: gzBody && gzBody.length < body.length ? gzBody : null,
        type,
        // Vite fingerprints everything under /assets/; the rest (index.html, favicon) is revalidated.
        cache: path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
    }
    if (!this.files.has('/index.html')) throw new Error('StaticSite: the build has no index.html');
  }

  /** Every file under `dir` (e.g. apps/web/dist). Throws when there is no index.html. */
  static load(dir: string): StaticSite {
    const out: Array<[string, Uint8Array]> = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else out.push([`/${relative(dir, p).split(sep).join('/')}`, readFileSync(p)]);
      }
    };
    walk(dir);
    return new StaticSite(out);
  }

  get size(): number {
    return this.files.size;
  }

  /** GET/HEAD only (null for other methods): the file, index.html for a client route, or 404. */
  serve(req: Request): Response | null {
    if (req.method !== 'GET' && req.method !== 'HEAD') return null;
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url).pathname);
    } catch {
      return new Response('Bad request', { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    if (path === '/') path = '/index.html';
    let f = this.files.get(path);
    if (!f) {
      const last = path.slice(path.lastIndexOf('/') + 1);
      if (last.includes('.') || path.startsWith('/assets/')) {
        return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' } });
      }
      f = this.files.get('/index.html')!;
    }
    const gzip = !!f.gz && /\bgzip\b/.test(req.headers.get('accept-encoding') ?? '');
    const body = gzip ? f.gz! : f.body;
    const headers: Record<string, string> = { 'content-type': f.type, 'cache-control': f.cache, 'content-length': String(body.length), vary: 'Accept-Encoding' };
    if (gzip) headers['content-encoding'] = 'gzip';
    return new Response(req.method === 'HEAD' ? null : body, { status: 200, headers });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Environment

/** The explicit extra opt-in that lets a HOSTED service talk to live PayPal (never set in render.yaml). */
export const LIVE_OPT_IN = { name: 'RESOLVEKIT_ALLOW_LIVE_PAYPAL', value: 'yes-real-money' } as const;

/**
 * Which PayPal environment a service may use. Hosted (public) mode refuses to start unless PAYPAL_ENV is exactly
 * "sandbox", or "live" together with {@link LIVE_OPT_IN}: a missing, misspelt or changed value never silently becomes
 * live (or sandbox). Local mode keeps its behaviour: "live" only when PAYPAL_ENV says so, sandbox otherwise.
 */
export function paypalEnvFor(env: NodeJS.ProcessEnv, hosted: boolean): { ok: true; env: 'sandbox' | 'live' } | { ok: false; error: string } {
  const v = env.PAYPAL_ENV;
  if (!hosted) return { ok: true, env: v === 'live' ? 'live' : 'sandbox' };
  if (v === 'sandbox') return { ok: true, env: 'sandbox' };
  if (v === 'live') {
    return env[LIVE_OPT_IN.name] === LIVE_OPT_IN.value
      ? { ok: true, env: 'live' }
      : { ok: false, error: `PAYPAL_ENV=live in hosted mode needs ${LIVE_OPT_IN.name}=${LIVE_OPT_IN.value} as well (this demo runs on the PayPal sandbox)` };
  }
  return { ok: false, error: `hosted mode needs PAYPAL_ENV=sandbox (got ${v === undefined ? 'nothing' : JSON.stringify(v.slice(0, 20))})` };
}

/** A positive integer from the environment, or the default. */
export function envInt(env: NodeJS.ProcessEnv, name: string, dflt: number): number {
  const v = Number(env[name]);
  return Number.isSafeInteger(v) && v > 0 ? v : dflt;
}

/**
 * The public origins of a hosted service: RENDER_EXTERNAL_URL (Render sets it) plus custom domains (https). Hosts
 * are derived from them.
 */
export function publicOrigins(externalUrl: string | undefined, customDomains: string | undefined): { origins: string[]; hosts: string[]; https: boolean } {
  const origins: string[] = [];
  if (externalUrl) origins.push(new URL(externalUrl).origin);
  for (const d of (customDomains ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) origins.push(`https://${d}`);
  const hosts = origins.map((o) => new URL(o).host.toLowerCase());
  return { origins, hosts, https: origins.length > 0 && origins.every((o) => o.startsWith('https://')) };
}

/**
 * The first public origin that is not https, or null. PayPal returns buyers and merchants to these origins
 * (return_url / cancel_url), so a hosted service refuses to start on one; only loopback may be http (local runs).
 */
export function insecureOrigin(origins: readonly string[]): string | null {
  return origins.find((o) => {
    const u = new URL(o);
    return u.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  }) ?? null;
}
