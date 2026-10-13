/**
 * Hosted mode (`RESOLVEKIT_MODE=hosted`, e.g. on Render): the web app and the API on one public origin.
 *
 * - Host must be one of the service's public hosts (RENDER_EXTERNAL_HOSTNAME, custom domains). `/healthz` is exempt.
 * - /api: a state-changing request must come from the service's own origin (Origin header); a present Origin must be
 *   ours on reads too; POST bodies are JSON only; per-IP rate limits (client IP behind one trusted proxy hop).
 * - Browsing is free. People sign in (auth.ts): a merchant with PayPal (Owner), members through an invite link with a
 *   passkey or for one browser. The session is an HttpOnly, Secure, SameSite=Strict cookie signed with the server's
 *   secret, valid 12 h. Composing and approving a response needs a signed-in person.
 * - The real PayPal disputes are the seller's: only people of the workspace whose PayPal account is the seller on the
 *   bound disputes see them live and can act on them; everyone else gets the same cases on the simulator. What costs
 *   money or quota, or cannot be undone (evidence to real PayPal, live AI runs, AI re-checks), is for that workspace
 *   only, within global daily caps persisted on the disk.
 * - POST /api/paypal/webhook (with PAYPAL_WEBHOOK_ID): PayPal's dispute notifications, outside the browser rules and
 *   confirmed with PayPal before anything happens (webhook.ts); its own per-IP limit.
 * - Everything else: the built web app (apps/web/dist), with the SPA fallback.
 * - Every response carries the security headers (CSP, HSTS over https, nosniff, frame-ancestors 'none', Referrer-Policy).
 *
 * There is no per-launch token here: the browser talks to the API directly, so a secret in it would not be one. The
 * protection is the signed-in person and their workspace, the Origin check and SameSite=Strict for CSRF, and the caps.
 */
import { APP_CSP, KeyedLimiter, clientIp, describeClientIp, type ProxyTrust, hostOf, withSecurityHeaders, type DailyCounters, type StaticSite } from '@resolvekit/hosting';
import type { PayPalClient } from '@resolvekit/paypal';
import type { AccountStore } from './accounts.ts';
import type { LiveGate } from './analysis.ts';
import { actorLabel, createAuth, type WebAuthn } from './auth.ts';
import { createApi, json, withLog, type Actor, type ApiOptions, type CostGate, type CostlyAction, type Handler, type Reservation } from './app.ts';
import { createWebhookHandler, WEBHOOK_PATH } from './webhook.ts';

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
  /** Merchant workspaces, people, passkeys and invites (persisted on the data dir by main.ts). */
  accounts: AccountStore;
  /** The platform's PayPal app, for PayPal sign-in (PAYPAL_IDENTITY_CLIENT_ID/SECRET); null: PayPal sign-in off. */
  identity: PayPalClient | null;
  /** HMAC key of the session cookies (env RESOLVEKIT_SESSION_SECRET). */
  sessionSecret: string;
  /** Tests: WebAuthn without an authenticator. */
  webauthn?: WebAuthn;
  /** Daily caps, keyed by {@link CostlyAction}. */
  counters: DailyCounters;
  /** The built web app; null serves the API only. */
  site: StaticSite | null;
  /** Proxies in front that append to X-Forwarded-For (Render: 1). */
  trustedHops?: number;
  /** Whose X-Forwarded-For is believed (default: a proxy on a private address; env TRUSTED_PROXY_PEERS). */
  proxyTrust?: ProxyTrust;
  limits?: Partial<HostedLimits>;
  /** The id of the webhook registered on the seller's app (PAYPAL_WEBHOOK_ID); absent: no webhook route. */
  webhookId?: string | null;
}

export interface HostedLimits {
  /** Every /api request, per IP. */
  api: { limit: number; windowMs: number };
  /** Reads that go to PayPal (GET /api/disputes/…), per IP. */
  paypalReads: { limit: number; windowMs: number };
  /** Sign-in and invite requests (POST /api/auth/*), per IP: passkey ceremonies, invite checks and joins. */
  authPerIp: { limit: number; windowMs: number };
  /** PayPal sign-ins started (each asks PayPal for an agreement token), per IP. */
  paypalStartsPerIp: { limit: number; windowMs: number };
  /** Submission intents composed, per IP (a flood from one address cannot fill the server's intent store). */
  intentsPerIp: { limit: number; windowMs: number };
  /** PayPal webhook deliveries, per IP (each one costs a verification call to PayPal). */
  webhookPerIp: { limit: number; windowMs: number };
}

const MIN = 60_000;
export const DEFAULT_LIMITS: HostedLimits = {
  api: { limit: 300, windowMs: 5 * MIN },
  paypalReads: { limit: 60, windowMs: 5 * MIN },
  authPerIp: { limit: 40, windowMs: 15 * MIN },
  paypalStartsPerIp: { limit: 10, windowMs: 15 * MIN },
  intentsPerIp: { limit: 20, windowMs: 10 * MIN },
  webhookPerIp: { limit: 120, windowMs: 15 * MIN },
};

/** Why each costly action is the seller workspace's only (shown by the web app as is). */
export const LOCKED_REASON: Record<CostlyAction, string> = {
  evidence: 'Sending evidence to a real PayPal dispute cannot be undone, so only the seller’s workspace can do it: sign in with the seller’s PayPal account, or join its workspace with an invite.',
  'live-analysis': 'A live AI run uses model quota, so on this public demo only the seller’s workspace runs it. The stored analysis stays on screen.',
  recheck: 'Re-checking an edited sentence calls the AI model, so on this public demo only the seller’s workspace runs it.',
};
const SIGN_IN_REASON = 'Sign in to compose and approve responses: with PayPal (merchants) or with the invite link you were given.';

const CAP_NAME: Record<CostlyAction, string> = { evidence: 'evidence sends', 'live-analysis': 'live AI runs', recheck: 'AI re-checks' };

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const tooMany = (retryAfterSec: number, detail: string) => {
  const r = json(429, { error: 'RATE_LIMITED', detail, retryAfterSec });
  r.headers.set('retry-after', String(retryAfterSec));
  return r;
};

export function createHostedApp(o: HostedOptions): HostedApp {
  const now = o.now ?? (() => new Date());
  const hops = o.trustedHops ?? 1;
  const trust: ProxyTrust = o.proxyTrust ?? 'private';
  let derivationLogged = false;
  const L: HostedLimits = { ...DEFAULT_LIMITS, ...o.limits };
  const apiLimit = new KeyedLimiter({ ...L.api, now: () => now().getTime() });
  const readLimit = new KeyedLimiter({ ...L.paypalReads, now: () => now().getTime() });
  const intentLimit = new KeyedLimiter({ ...L.intentsPerIp, now: () => now().getTime() });
  const authLimit = new KeyedLimiter({ ...L.authPerIp, now: () => now().getTime() });
  const paypalStarts = new KeyedLimiter({ ...L.paypalStartsPerIp, now: () => now().getTime() });
  const webhookLimit = new KeyedLimiter({ ...L.webhookPerIp, now: () => now().getTime() });
  const hosts = new Set(o.hosts.map((h) => h.toLowerCase()));

  // The seller merchant ids of the bound disputes, as last read (refreshed before each signed-in request): which
  // workspace sees real PayPal. `api` is created below with this gate.
  let sellers = new Set<string>();
  let api: ReturnType<typeof createApi>;
  const refreshSellers = async () => {
    sellers = await api.sellerIds();
    return sellers;
  };
  const auth = createAuth({
    accounts: o.accounts,
    identity: o.identity,
    secret: o.sessionSecret,
    origins: o.origins,
    isConnected: async (payerId) => (await refreshSellers()).has(payerId),
    sellerName: (payerId) => api.sellerName(payerId),
    now,
    log: o.log,
    ...(o.webauthn ? { webauthn: o.webauthn } : {}),
  });
  const session = (req: Request) => auth.session(req);

  const gate: CostGate = {
    // Synchronous from the check to the count: concurrent requests cannot overshoot a cap.
    reserve(req: Request, action: CostlyAction): Reservation {
      const s = session(req);
      if (!s.ok) return { ok: false, refusal: { status: 401, body: { error: 'SIGN_IN_REQUIRED', detail: SIGN_IN_REASON, action } } };
      if (!sellers.has(s.workspace.payerId)) {
        return { ok: false, refusal: { status: 403, body: { error: 'SELLER_WORKSPACE_ONLY', detail: LOCKED_REASON[action], action } } };
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
    // Who approves or sends: the signed-in person, named in the audit trail of their workspace. The simulator records
    // a signed-out visitor as such; anything that needs an owner (intents) needs a signed-in person.
    actor(req: Request, unlocked: boolean): Actor {
      const client = clientIp(req, hops, trust);
      const s = session(req);
      if (s.ok) return { ok: true, actor: actorLabel(s.person), team: s.workspace.id, client };
      if (!unlocked) return { ok: true, actor: 'visitor (signed out)', client };
      return { ok: false, refusal: { status: 401, body: { error: 'SIGN_IN_REQUIRED', detail: SIGN_IN_REASON } } };
    },
    async live(req: Request) {
      const s = session(req);
      return s.ok && (await refreshSellers()).has(s.workspace.payerId);
    },
    merchant(req: Request) {
      const s = session(req);
      return s.ok ? s.workspace.payerId : null;
    },
  };

  // Live runs and re-checks analyse inputs the server builds itself (app.ts), behind the seller workspace and the caps.
  api = createApi({ ...o, gate });
  const webhook =
    o.webhookId && o.paypal ? createWebhookHandler({ paypal: o.paypal, webhookId: o.webhookId, onEvent: (e) => api.paypalNotified(e), ...(o.log ? { log: o.log } : {}) }) : null;

  /** GET /api/demo: hosted mode, the daily caps, and why the costly actions are limited (the web app shows it). */
  const demoState = () => ({ hosted: true, ...o.counters.state(), reasons: LOCKED_REASON });

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    // Render's health check (and nothing else) needs no Host match: it tells nothing and costs nothing.
    if (path === '/healthz') return req.method === 'GET' || req.method === 'HEAD' ? json(200, { ok: true }) : json(405, { error: 'METHOD_NOT_ALLOWED' });
    if (!hosts.has(hostOf(req))) return json(403, { error: 'FORBIDDEN_HOST' });

    // PayPal's webhook deliveries: no browser, so none of the browser rules below (Origin, session); PayPal confirms
    // each delivery itself (webhook.ts).
    if (path === WEBHOOK_PATH) {
      if (!webhook) return json(404, { error: 'NOT_FOUND' });
      const w = webhookLimit.take(clientIp(req, hops, trust));
      if (!w.ok) return tooMany(w.retryAfterSec, 'Too many webhook deliveries from this address');
      return webhook(req);
    }

    if (path === '/api' || path.startsWith('/api/')) {
      const origin = req.headers.get('origin');
      if (STATE_CHANGING.has(req.method) ? !origin || !o.origins.includes(origin) : origin != null && !o.origins.includes(origin)) {
        return json(403, { error: 'FORBIDDEN_ORIGIN' });
      }
      if (req.method === 'POST' && !/^application\/json\s*(;|$)/i.test(req.headers.get('content-type') ?? '')) {
        return json(415, { error: 'UNSUPPORTED_MEDIA_TYPE', detail: 'POST bodies must be application/json' });
      }
      const ip = clientIp(req, hops, trust);
      if (!derivationLogged) {
        // Once: how the client address is derived on this deployment (masked), to confirm the proxy's header shape.
        derivationLogged = true;
        o.log?.(`client address derivation · ${describeClientIp(req, hops, trust)}`);
      }
      const a = apiLimit.take(ip);
      if (!a.ok) return tooMany(a.retryAfterSec, `Too many requests; try again in ${a.retryAfterSec} s`);
      if (path === '/api/demo') return req.method === 'GET' ? json(200, demoState()) : json(405, { error: 'METHOD_NOT_ALLOWED' });
      if (req.method === 'POST' && path.startsWith('/api/auth/')) {
        const t = path === '/api/auth/paypal/start' ? paypalStarts.take(ip) : authLimit.take(ip);
        if (!t.ok) return tooMany(t.retryAfterSec, `Too many sign-in requests from this address; try again in ${Math.ceil(t.retryAfterSec / 60)} min`);
      }
      const authRes = auth.route(req, path);
      if (authRes) return authRes;
      // A signed-in request sees the sellers as PayPal reports them now (each bound dispute read once, then cached).
      if (session(req).ok) await refreshSellers();
      // Reads that go to PayPal: the dispute itself, and composing an intent (it reads the dispute fresh).
      const paypalRead =
        (req.method === 'GET' && path.startsWith('/api/disputes/') && !path.endsWith('/audit') && !path.includes('/intent/')) ||
        (req.method === 'POST' && /^\/api\/disputes\/[^/]+\/intent$/.test(path));
      const composing = req.method === 'POST' && /^\/api\/disputes\/[^/]+\/intent$/.test(path);
      if (composing) {
        const t = intentLimit.take(ip);
        if (!t.ok) return tooMany(t.retryAfterSec, `Too many submission intents from this address; try again in ${t.retryAfterSec} s`);
      }
      if (paypalRead) {
        const r = readLimit.take(ip);
        if (!r.ok) {
          if (composing) intentLimit.release(ip);
          return tooMany(r.retryAfterSec, `Too many PayPal reads; try again in ${r.retryAfterSec} s`);
        }
      }
      const res = await api(req);
      // A composition that did not create an intent gives its slot back; one refused before reading PayPal (no
      // session, a cap, a malformed request) gives back its PayPal read too. Nothing else changed on the server.
      if (composing && res.status !== 201) {
        intentLimit.release(ip);
        if (res.status === 400 || res.status === 403 || res.status === 429) readLimit.release(ip);
      }
      return res;
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
