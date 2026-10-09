/**
 * Hosted mode (`RESOLVEKIT_MODE=hosted`, e.g. on Render): the web app and the API on one public origin.
 *
 * - Host must be one of the service's public hosts (RENDER_EXTERNAL_HOSTNAME, custom domains). `/healthz` is exempt.
 * - /api: a state-changing request must come from the service's own origin (Origin header); a present Origin must be
 *   ours on reads too; POST bodies are JSON only; per-IP rate limits (client IP behind one trusted proxy hop).
 * - Browsing is free. What costs money or quota, or cannot be undone (evidence to real PayPal, live AI runs, AI
 *   re-checks), needs the demo code: `POST /api/demo/unlock {code}` sets an HttpOnly, Secure, SameSite=Strict cookie
 *   signed with the server's secret, valid 12 h. Those actions also have global daily caps, persisted on the disk.
 * - Everything else: the built web app (apps/web/dist), with the SPA fallback.
 * - Every response carries the security headers (CSP, HSTS over https, nosniff, frame-ancestors 'none', Referrer-Policy).
 *
 * There is no per-launch token here: the browser talks to the API directly, so a secret in it would not be one. The
 * protection is the demo code (only judges have it), the Origin check and SameSite=Strict for CSRF, and the caps.
 */
import {
  APP_CSP,
  DEMO_COOKIE,
  KeyedLimiter,
  clientIp,
  demoCookie,
  hostOf,
  readCookie,
  sameSecret,
  signDemoSession,
  verifyDemoSession,
  withSecurityHeaders,
  type DailyCounters,
  type StaticSite,
} from '@resolvekit/hosting';
import { createHash } from 'node:crypto';
import type { LiveGate } from './analysis.ts';
import { createApi, json, withLog, type Actor, type ApiOptions, type CostGate, type CostlyAction, type Handler, type Reservation } from './app.ts';

/** What the warm-up did for one bound case. */
export interface WarmUpOutcome {
  caseId: string;
  outcome: 'cached' | 'done' | 'failed' | 'skipped';
  detail: string;
}

/** The hosted handler, plus the warm-up of the bound cases' analyses. */
export type HostedApp = Handler & {
  /** Analyse each bound case once, in the background, as system runs (same hourly limit and daily cap). */
  warmUp: () => Promise<WarmUpOutcome[]>;
  /** The bindings object was changed in place: forget the old reads and warm up again. */
  bindingsChanged: () => Promise<WarmUpOutcome[]>;
};

export interface HostedOptions extends Omit<ApiOptions, 'gate'> {
  /** The service's own origins, e.g. https://resolvekit.onrender.com (+ custom domains). */
  origins: readonly string[];
  /** Their hosts: requests for any other Host are refused. */
  hosts: readonly string[];
  /** All origins are https: send HSTS. */
  https: boolean;
  /** The demo code (env DEMO_CODE). null: nothing can be unlocked, costly actions are always refused. */
  demoCode: string | null;
  /** HMAC key of the unlock cookie (env RESOLVEKIT_SESSION_SECRET). */
  sessionSecret: string;
  sessionTtlMs?: number;
  /** Daily caps, keyed by {@link CostlyAction}. */
  counters: DailyCounters;
  /** The built web app; null serves the API only. */
  site: StaticSite | null;
  /** Proxies in front that append to X-Forwarded-For (Render: 1). */
  trustedHops?: number;
  limits?: Partial<HostedLimits>;
}

export interface HostedLimits {
  /** Every /api request, per IP. */
  api: { limit: number; windowMs: number };
  /** Reads that go to PayPal (GET /api/disputes/…), per IP. */
  paypalReads: { limit: number; windowMs: number };
  /** Unlock attempts per IP (brute force). */
  unlockPerIp: { limit: number; windowMs: number };
  /** Unlock attempts from everyone together (distributed brute force). */
  unlockGlobal: { limit: number; windowMs: number };
  /** Submission intents composed, per IP (a flood from one address cannot fill the server's intent store). */
  intentsPerIp: { limit: number; windowMs: number };
}

const MIN = 60_000;
export const DEFAULT_LIMITS: HostedLimits = {
  api: { limit: 300, windowMs: 5 * MIN },
  paypalReads: { limit: 60, windowMs: 5 * MIN },
  unlockPerIp: { limit: 5, windowMs: 15 * MIN },
  unlockGlobal: { limit: 60, windowMs: 60 * MIN },
  intentsPerIp: { limit: 20, windowMs: 10 * MIN },
};

export const SESSION_TTL_MS = 12 * 60 * MIN;

/** Why each costly action needs the demo code (shown by the web app as is). */
export const LOCKED_REASON: Record<CostlyAction, string> = {
  evidence: 'Sending evidence to the real PayPal sandbox cannot be undone, so on this public demo it needs the demo code from the Devpost testing instructions.',
  'live-analysis': 'A live AI run uses model quota, so on this public demo it needs the demo code from the Devpost testing instructions. The stored analysis stays on screen.',
  recheck: 'Re-checking an edited sentence calls the AI model, so on this public demo it needs the demo code from the Devpost testing instructions.',
};

const CAP_NAME: Record<CostlyAction, string> = { evidence: 'evidence sends', 'live-analysis': 'live AI runs', recheck: 'AI re-checks' };

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const tooMany = (retryAfterSec: number, detail: string) => {
  const r = json(429, { error: 'RATE_LIMITED', detail, retryAfterSec });
  r.headers.set('retry-after', String(retryAfterSec));
  return r;
};

export function createHostedApp(o: HostedOptions): HostedApp {
  const now = o.now ?? (() => new Date());
  const ttl = o.sessionTtlMs ?? SESSION_TTL_MS;
  const hops = o.trustedHops ?? 1;
  const L: HostedLimits = { ...DEFAULT_LIMITS, ...o.limits };
  const apiLimit = new KeyedLimiter({ ...L.api, now: () => now().getTime() });
  const readLimit = new KeyedLimiter({ ...L.paypalReads, now: () => now().getTime() });
  const unlockIp = new KeyedLimiter({ ...L.unlockPerIp, now: () => now().getTime() });
  const unlockAll = new KeyedLimiter({ ...L.unlockGlobal, now: () => now().getTime() });
  const intentLimit = new KeyedLimiter({ ...L.intentsPerIp, now: () => now().getTime() });
  const hosts = new Set(o.hosts.map((h) => h.toLowerCase()));

  const session = (req: Request) => verifyDemoSession(o.sessionSecret, readCookie(req, DEMO_COOKIE), now().getTime(), ttl);

  const gate: CostGate = {
    // Synchronous from the check to the count: concurrent requests cannot overshoot a cap.
    reserve(req: Request, action: CostlyAction): Reservation {
      if (!session(req).ok) {
        return { ok: false, refusal: { status: 403, body: { error: 'DEMO_CODE_REQUIRED', detail: LOCKED_REASON[action], action } } };
      }
      const day = o.counters.today();
      if (!o.counters.take(action)) {
        const s = o.counters.state();
        return {
          ok: false,
          refusal: { status: 429, body: { error: 'DAILY_CAP', detail: `This demo allows ${s.caps[action]?.limit ?? 0} ${CAP_NAME[action]} per day; the cap resets at ${s.resetsAt}.`, action, resetsAt: s.resetsAt } },
        };
      }
      return { ok: true, release: () => o.counters.release(action, day) };
    },
    // The approver of a send: the demo session (a hash of its signed cookie, never the code). Real PayPal needs one;
    // the simulator records a visitor without the code as such.
    actor(req: Request, unlocked: boolean): Actor {
      const cookie = readCookie(req, DEMO_COOKIE);
      const client = clientIp(req, hops);
      if (cookie && session(req).ok) return { ok: true, actor: `demo session ${createHash('sha256').update(cookie).digest('hex').slice(0, 12)}`, client };
      if (!unlocked) return { ok: true, actor: 'visitor (no demo code)', client };
      return { ok: false, refusal: { status: 403, body: { error: 'DEMO_CODE_REQUIRED', detail: LOCKED_REASON.evidence, action: 'evidence' } } };
    },
  };

  // Live runs and re-checks analyse inputs the server builds itself (app.ts), behind the demo code and the caps.
  const api = createApi({ ...o, gate });

  const demoState = (req: Request) => {
    const s = session(req);
    return { hosted: true, unlockable: !!o.demoCode, unlocked: s.ok, expiresAt: s.ok ? new Date(s.expiresAt).toISOString() : null, ...o.counters.state(), reasons: LOCKED_REASON };
  };

  const demoRoute = async (req: Request, path: string, ip: string): Promise<Response> => {
    if (path === '/api/demo') return req.method === 'GET' ? json(200, demoState(req)) : json(405, { error: 'METHOD_NOT_ALLOWED' });
    if (req.method !== 'POST') return json(405, { error: 'METHOD_NOT_ALLOWED' });
    if (path === '/api/demo/lock') {
      const r = json(200, { unlocked: false });
      r.headers.set('set-cookie', demoCookie('', 0));
      return r;
    }
    if (path !== '/api/demo/unlock') return json(404, { error: 'NOT_FOUND' });
    if (!o.demoCode) return json(503, { error: 'DEMO_DISABLED', detail: 'No demo code is configured on this server' });
    // A browser that is already unlocked keeps its session: no new one is minted (and no attempt is counted).
    if (session(req).ok) return json(200, demoState(req));
    // Count the attempt before looking at the code (both limits, atomically): guesses are capped per IP and overall.
    const perIp = unlockIp.take(ip);
    if (!perIp.ok) return tooMany(perIp.retryAfterSec, `Too many attempts; try again in ${Math.ceil(perIp.retryAfterSec / 60)} min`);
    const all = unlockAll.take('*');
    if (!all.ok) return tooMany(all.retryAfterSec, `Too many attempts on this demo; try again in ${Math.ceil(all.retryAfterSec / 60)} min`);
    let body: { code?: unknown } | null;
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json(400, { error: 'INVALID_JSON' });
    }
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!code || code.length > 200 || !sameSecret(code, o.demoCode)) return json(403, { error: 'BAD_DEMO_CODE', detail: 'That is not the demo code' });
    const exp = now().getTime() + ttl;
    const r = json(200, { ...demoState(req), unlocked: true, expiresAt: new Date(exp).toISOString() });
    r.headers.set('set-cookie', demoCookie(signDemoSession(o.sessionSecret, exp), ttl / 1000));
    return r;
  };

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    // Render's health check (and nothing else) needs no Host match: it tells nothing and costs nothing.
    if (path === '/healthz') return req.method === 'GET' || req.method === 'HEAD' ? json(200, { ok: true }) : json(405, { error: 'METHOD_NOT_ALLOWED' });
    if (!hosts.has(hostOf(req))) return json(403, { error: 'FORBIDDEN_HOST' });

    if (path === '/api' || path.startsWith('/api/')) {
      const origin = req.headers.get('origin');
      if (STATE_CHANGING.has(req.method) ? !origin || !o.origins.includes(origin) : origin != null && !o.origins.includes(origin)) {
        return json(403, { error: 'FORBIDDEN_ORIGIN' });
      }
      if (req.method === 'POST' && !/^application\/json\s*(;|$)/i.test(req.headers.get('content-type') ?? '')) {
        return json(415, { error: 'UNSUPPORTED_MEDIA_TYPE', detail: 'POST bodies must be application/json' });
      }
      const ip = clientIp(req, hops);
      const a = apiLimit.take(ip);
      if (!a.ok) return tooMany(a.retryAfterSec, `Too many requests; try again in ${a.retryAfterSec} s`);
      if (path === '/api/demo' || path.startsWith('/api/demo/')) return demoRoute(req, path, ip);
      // Reads that go to PayPal: the dispute itself, and composing an intent (it reads the dispute fresh).
      const paypalRead =
        (req.method === 'GET' && path.startsWith('/api/disputes/') && !path.endsWith('/audit') && !path.includes('/intent/')) ||
        (req.method === 'POST' && /^\/api\/disputes\/[^/]+\/intent$/.test(path));
      if (req.method === 'POST' && /^\/api\/disputes\/[^/]+\/intent$/.test(path)) {
        const t = intentLimit.take(ip);
        if (!t.ok) return tooMany(t.retryAfterSec, `Too many submission intents from this address; try again in ${t.retryAfterSec} s`);
      }
      if (paypalRead) {
        const r = readLimit.take(ip);
        if (!r.ok) return tooMany(r.retryAfterSec, `Too many PayPal reads; try again in ${r.retryAfterSec} s`);
      }
      return api(req);
    }

    if (o.site) return o.site.serve(req) ?? json(405, { error: 'METHOD_NOT_ALLOWED' });
    return json(404, { error: 'NOT_FOUND' });
  };

  const logged = withLog(o.log, handle);
  const handler: Handler = async (req) => {
    const res = await logged(req);
    const html = (res.headers.get('content-type') ?? '').startsWith('text/html');
    return withSecurityHeaders(res, { hsts: o.https, ...(html ? { csp: APP_CSP } : {}) });
  };

  // ---------------------------------------------------------------------------------------------- warm-up
  // So that visitors without the demo code see an analysis of each bound case: after boot and whenever the bindings
  // change, each bound case is analysed once (skipped when its documents already have a stored analysis). These are
  // system runs: no demo code, but the same hourly limit and the same daily cap as a visitor's live run. The log says
  // the outcome per case; no document text, no keys.
  const log = o.log ?? (() => {});
  const systemGate: LiveGate = () => {
    const day = o.counters.today();
    if (!o.counters.take('live-analysis')) {
      return { ok: false, refusal: { status: 429, body: { error: 'DAILY_CAP', detail: 'the daily cap of live analyses is reached' } } };
    }
    return { ok: true, release: () => o.counters.release('live-analysis', day) };
  };
  const warmCase = async (caseId: string): Promise<WarmUpOutcome> => {
    const analyst = o.analyst;
    if (!analyst) return { caseId, outcome: 'skipped', detail: 'no analyst on this server' };
    const input = await api.inputFor(caseId);
    if (input instanceof Response) {
      const b = (await input.json().catch(() => ({}))) as { error?: string };
      return { caseId, outcome: 'skipped', detail: `PayPal could not be read (${input.status}${b.error ? ` ${b.error}` : ''})` };
    }
    const r = await analyst.request(caseId, input, false, systemGate);
    const body = r.body as { status?: string; key?: string; origin?: string; error?: string; detail?: string };
    if (r.status === 200) return { caseId, outcome: 'cached', detail: `already stored (${body.origin})` };
    if (r.status !== 202 || !body.key) return { caseId, outcome: 'skipped', detail: `${body.error ?? r.status}: ${body.detail ?? ''}`.trim() };
    const t = Date.now();
    const end = (await analyst.settled(body.key)).body as { status?: string; error?: string };
    return end.status === 'ready'
      ? { caseId, outcome: 'done', detail: `system run · ${Date.now() - t} ms` }
      : { caseId, outcome: 'failed', detail: `system run · ${end.error ?? end.status ?? 'unknown'}` };
  };
  let chain: Promise<WarmUpOutcome[]> = Promise.resolve([]);
  const warmUp = (): Promise<WarmUpOutcome[]> => {
    const run = async () => {
      const out: WarmUpOutcome[] = [];
      for (const caseId of Object.keys(o.bindings)) {
        let w: WarmUpOutcome;
        try {
          w = await warmCase(caseId);
        } catch {
          w = { caseId, outcome: 'failed', detail: 'unexpected error' };
        }
        log(`warm-up · case ${caseId} · ${w.outcome} · ${w.detail}`);
        out.push(w);
      }
      return out;
    };
    // One warm-up at a time; a request during one runs after it (the bindings may have changed meanwhile).
    chain = chain.then(run, run);
    return chain;
  };
  return Object.assign(handler, {
    warmUp,
    bindingsChanged: () => {
      api.forgetReads();
      return warmUp();
    },
  });
}
