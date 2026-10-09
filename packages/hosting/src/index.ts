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
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

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

/**
 * The client's address. Each proxy appends the address it received the connection from to X-Forwarded-For, so with
 * `trustedHops` proxies in front (Render: 1) the client is the entry that many places from the end; anything before it
 * was written by the client and is ignored. Without X-Forwarded-For (no proxy in front) it is the TCP peer.
 */
export function clientIp(req: Request, trustedHops = 1): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff && trustedHops > 0) {
    const hops = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length) {
      const ip = hops[Math.max(0, hops.length - trustedHops)]!;
      return IP_CHARS.test(ip) ? ip : 'invalid';
    }
  }
  return req.headers.get(PEER_HEADER) ?? 'unknown';
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

  constructor(o: { file: string | null; limits: Record<string, number>; now?: () => Date }) {
    this.file = o.file;
    this.limits = { ...o.limits };
    this.now = o.now ?? (() => new Date());
    if (this.file) {
      try {
        const saved = JSON.parse(readFileSync(this.file, 'utf8')) as { day?: unknown; counts?: unknown };
        if (typeof saved.day === 'string' && saved.counts && typeof saved.counts === 'object') {
          this.day = saved.day;
          for (const [k, v] of Object.entries(saved.counts)) if (Number.isSafeInteger(v) && (v as number) >= 0) this.counts[k] = v as number;
        }
      } catch {
        // No file yet (or unreadable): start at zero.
      }
    }
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
    if (this.remaining(name) <= 0) return false;
    this.counts[name] = (this.counts[name] ?? 0) + 1;
    this.save();
    return true;
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

  private save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ day: this.day, counts: this.counts }));
      renameSync(tmp, this.file);
    } catch {
      // Best effort: the in-memory count still applies until the next restart.
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
