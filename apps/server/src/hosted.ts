/**
 * Hosted mode (`RESOLVEKIT_MODE=hosted`, e.g. on Render): the web app and the API on one public origin.
 *
 * - Host must be one of the service's public hosts (RENDER_EXTERNAL_HOSTNAME, custom domains). `/healthz` is exempt.
 * - /api: a state-changing request must come from the service's own origin (Origin header); a present Origin must be
 *   ours on reads too; POST bodies are JSON only (an evidence upload may also be image/png or image/jpeg, on its own
 *   route only); per-IP rate limits (client IP behind one trusted proxy hop).
 * - Browsing is free. People sign in (auth.ts): a merchant with PayPal (Owner), members through an invite link with a
 *   passkey or for one browser. The session is an HttpOnly, Secure, SameSite=Strict cookie signed with the server's
 *   secret, valid 12 h. Composing and approving a response needs a signed-in person.
 * - The real PayPal disputes are the seller's: only people of the workspace whose PayPal account is the seller on the
 *   bound disputes see them live and can act on them; everyone else gets the same cases on the simulator. What costs
 *   money or quota, or cannot be undone (evidence to real PayPal, live AI runs, AI re-checks), is for that workspace
 *   only, within global daily caps persisted on the disk.
 * - POST /api/paypal/webhook/<key> (with PAYPAL_WEBHOOK_ID and PAYPAL_WEBHOOK_KEY): PayPal's dispute notifications,
 *   outside the browser rules and confirmed with PayPal before anything happens (webhook.ts); its own per-IP limit.
 * - Everything else: the built web app (apps/web/dist), with the SPA fallback.
 * - Every response carries the security headers (CSP, HSTS over https, nosniff, frame-ancestors 'none', Referrer-Policy).
 *
 * There is no per-launch token here: the browser talks to the API directly, so a secret in it would not be one. The
 * protection is the signed-in person and their workspace, the Origin check and SameSite=Strict for CSRF, and the caps.
 */
import { APP_CSP, KeyedLimiter, clientIp, describeClientIp, type ProxyTrust, hostOf, sameSecret, withSecurityHeaders, type DailyCounters, type StaticSite } from '@resolvekit/hosting';
import type { PayPalClient } from '@resolvekit/paypal';
import type { AccountStore } from './accounts.ts';
import type { LiveGate } from './analysis.ts';
import { actorLabel, createAuth, type WebAuthn } from './auth.ts';
import { SellerMemory, type Connection } from './sellers.ts';
import { createApi, json, withLog, type ActingPerson, type Actor, type ApiOptions, type CostGate, type CostlyAction, type Handler, type Reservation } from './app.ts';
import { PersonRunCaps } from './agent/person-caps.ts';
import { RUN_ID } from './agent/runs.ts';
import type { Receipt } from './metermcp.ts';
import { createWebhookHandler, WEBHOOK_PREFIX } from './webhook.ts';
import { acceptsFileBody, HINT_PATH, REDACT_PATH, REFUSED_EARLY, UPLOAD_PATH } from './uploads/routes.ts';

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
  /** The person acting on a request (null when signed out). */
  personOf: (req: Request) => ActingPerson | null;
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
  /** Sellers confirmed by a complete read, kept across restarts (main.ts: sellers.json); default: this process only. */
  sellerMemory?: SellerMemory;
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
  /**
   * The webhook registered on the seller's app for `${origin}/api/paypal/webhook/${key}`: its id (PAYPAL_WEBHOOK_ID)
   * and the URL's secret key (PAYPAL_WEBHOOK_KEY). Absent: no webhook route.
   */
  webhook?: { id: string; key: string; verifyLimit?: { perMinute: number; inFlight: number } } | null;
  /**
   * The operator's token (RESOLVEKIT_OPS_TOKEN) for GET /api/ops/status, which `npm run demo:check` reads: PayPal,
   * the webhook, each binding verified now and the last warm-up. Absent: no such route.
   */
  opsToken?: string | null;
  /** Agent runs started per person per day (main.ts: persisted next to the daily caps); default 5, this process only. */
  agentRunsPerPerson?: PersonRunCaps;
  /** Each configured AI provider's health check, run by /api/ops/status?probe=models (modelProbesFromEnv). */
  modelProbes?: readonly { name: string; probe: () => Promise<void> }[];
}

export interface HostedLimits {
  /** Every /api request, per IP. */
  api: { limit: number; windowMs: number };
  /** Reads that go to PayPal (GET /api/disputes/…) and PDF text hints (GET …/page/:k/hint), per IP. */
  paypalReads: { limit: number; windowMs: number };
  /** Sign-in and invite requests (POST /api/auth/*), per IP: passkey ceremonies, invite checks and joins. */
  authPerIp: { limit: number; windowMs: number };
  /** PayPal sign-ins started (each asks PayPal for an agreement token), per IP. */
  paypalStartsPerIp: { limit: number; windowMs: number };
  /** Submission intents composed, per IP (a flood from one address cannot fill the server's intent store). */
  intentsPerIp: { limit: number; windowMs: number };
  /** PayPal webhook deliveries, per IP (each one costs a verification call to PayPal). */
  webhookPerIp: { limit: number; windowMs: number };
  /** Evidence uploads (POST /api/cases/:id/uploads: a file read and OCR'd on this server), per IP. */
  uploadsPerIp: { limit: number; windowMs: number };
}

const MIN = 60_000;
export const DEFAULT_LIMITS: HostedLimits = {
  api: { limit: 300, windowMs: 5 * MIN },
  paypalReads: { limit: 60, windowMs: 5 * MIN },
  authPerIp: { limit: 40, windowMs: 15 * MIN },
  paypalStartsPerIp: { limit: 10, windowMs: 15 * MIN },
  intentsPerIp: { limit: 20, windowMs: 10 * MIN },
  webhookPerIp: { limit: 120, windowMs: 15 * MIN },
  uploadsPerIp: { limit: 20, windowMs: 10 * MIN },
};

/** Agent runs a person may start per UTC day (env-free: the spec's 5). */
export const AGENT_RUNS_PER_PERSON = 5;

/** Why each costly action is the seller workspace's only (shown by the web app as is). */
export const LOCKED_REASON: Record<CostlyAction, string> = {
  evidence: 'Sending evidence to a real PayPal dispute cannot be undone, so only the seller’s workspace can do it: sign in with the seller’s PayPal account, or join its workspace with an invite.',
  'live-analysis': 'A live AI run uses model quota, so on this public demo only the seller’s workspace runs it. The stored analysis stays on screen.',
  recheck: 'Re-checking an edited sentence calls the AI model, so on this public demo only the seller’s workspace runs it.',
  upload: 'Adding evidence stores and reads a file on this server, so on this public demo only the seller’s workspace adds it.',
  'agent-run': 'An agent run uses model quota and asks for a real PayPal sandbox payment, so on this public demo only the seller’s workspace starts one.',
};
const SIGN_IN_REASON = 'Sign in to compose and approve responses: with PayPal (merchants) or with the invite link you were given.';

const CAP_NAME: Record<CostlyAction, string> = { evidence: 'evidence sends', 'live-analysis': 'live AI runs', recheck: 'AI re-checks', upload: 'evidence uploads', 'agent-run': 'agent runs' };

/** The operator's check (demo:check). */
export const OPS_PATH = '/api/ops/status';
/** `GET <prefix><run id>`: one agent run and its receipt, for `demo:prepare --agent-run` (same ops token). */
export const OPS_AGENT_RUN_PREFIX = '/api/ops/agent-run/';

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
  const uploadLimit = new KeyedLimiter({ ...L.uploadsPerIp, now: () => now().getTime() });
  const agentRunCaps = o.agentRunsPerPerson ?? new PersonRunCaps({ file: null, limit: AGENT_RUNS_PER_PERSON, now });
  const hosts = new Set(o.hosts.map((h) => h.toLowerCase()));

  // The seller merchant ids of the bound disputes (refreshed before each signed-in request): which workspace sees
  // real PayPal. A bound dispute that cannot be read now keeps the seller remembered for that same binding (same case,
  // same dispute id), so a slow sandbox never demotes the evaluation workspace; a changed binding forgets it.
  // `api` is created below with this gate.
  const memory = o.sellerMemory ?? new SellerMemory({ file: null, ...(o.log ? { log: o.log } : {}) });
  let sellers: ReadonlySet<string> = new Set<string>();
  let api: ReturnType<typeof createApi>;
  const refreshSellers = async () => {
    const read = await api.sellerRead();
    const effective = new Set<string>();
    for (const c of read.cases) {
      if (c.read) {
        if (c.merchant) effective.add(c.merchant);
        continue;
      }
      const m = memory.remembered().find((e) => e.caseId === c.caseId && e.dispute === c.dispute);
      if (m) effective.add(m.merchant);
    }
    if (read.complete) memory.confirm(read.cases.flatMap((c) => (c.merchant ? [{ caseId: c.caseId, dispute: c.dispute, merchant: c.merchant }] : [])));
    sellers = effective;
    return { effective, complete: read.complete, none: read.cases.length === 0 };
  };
  const connectionOf = async (payerId: string): Promise<Connection> => {
    const { effective, complete, none } = await refreshSellers();
    if (effective.has(payerId)) return 'evaluation';
    // No case bound at all: the last confirmed seller keeps the evaluation label (an empty inbox, not the waiting
    // screen). A label only: `sellers` stays empty and every case route stays bound-only.
    if (none && memory.lastSellers().includes(payerId)) return 'evaluation';
    return effective.size === 0 && !complete ? 'checking' : 'not_connected';
  };
  const auth = createAuth({
    accounts: o.accounts,
    identity: o.identity,
    secret: o.sessionSecret,
    origins: o.origins,
    connectionOf,
    sellerName: (payerId) => api.sellerName(payerId),
    now,
    log: o.log,
    ...(o.webauthn ? { webauthn: o.webauthn } : {}),
  });
  const session = (req: Request) => auth.session(req);

  const gate: CostGate = {
    person(req: Request): ActingPerson | null {
      const s = session(req);
      if (!s.ok) return null;
      const p = s.person;
      return { id: p.id, name: p.name, label: actorLabel(p), workspaceId: s.workspace.id, role: p.role, reviewer: p.reviewer };
    },
    // Synchronous from the check to the count: concurrent requests cannot overshoot a cap.
    reserve(req: Request, action: CostlyAction): Reservation {
      const s = session(req);
      if (!s.ok) return { ok: false, refusal: { status: 401, body: { error: 'SIGN_IN_REQUIRED', detail: SIGN_IN_REASON, action } } };
      if (!sellers.has(s.workspace.payerId)) {
        return { ok: false, refusal: { status: 403, body: { error: 'SELLER_WORKSPACE_ONLY', detail: LOCKED_REASON[action], action } } };
      }
      const day = o.counters.today();
      const r = o.counters.reserve(action);
      if (!r.ok && r.reason === 'storage') {
        o.log?.(`daily caps · ${action} refused · ${o.counters.storageProblem() ?? 'cannot be saved'}`);
        return { ok: false, refusal: { status: 503, body: { error: 'CAPS_UNAVAILABLE', detail: 'The demo cannot record this action’s use right now, so it is not done; try again later.', action } } };
      }
      if (!r.ok) {
        const s = o.counters.state();
        return {
          ok: false,
          refusal: { status: 429, body: { error: 'DAILY_CAP', detail: `This demo allows ${s.caps[action]?.limit ?? 0} ${CAP_NAME[action]} per day; the cap resets at ${s.resetsAt}.`, action, resetsAt: s.resetsAt } },
        };
      }
      if (action !== 'agent-run') return { ok: true, release: () => o.counters.release(action, day) };
      // An agent run also takes one of the person's own units; refused, the daily unit goes back.
      const mine = agentRunCaps.take(s.person.id);
      if (!mine.ok) {
        o.counters.release(action, day);
        if (mine.reason === 'storage') {
          o.log?.(`agent-run caps · refused · ${mine.detail}`);
          return { ok: false, refusal: { status: 503, body: { error: 'CAPS_UNAVAILABLE', detail: 'The demo cannot record this action’s use right now, so it is not done; try again later.', action } } };
        }
        const limit = agentRunCaps.limit;
        return {
          ok: false,
          refusal: { status: 429, body: { error: 'PERSON_CAP', detail: `This demo allows ${limit} agent run${limit === 1 ? '' : 's'} per person per day; try again in ${Math.ceil(mine.retryAfterSec / 3600)} h.`, action, retryAfterSec: mine.retryAfterSec } },
        };
      }
      return {
        ok: true,
        release: () => {
          o.counters.release(action, day);
          agentRunCaps.release(s.person.id, mine.day);
        },
      };
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
      return s.ok && (await connectionOf(s.workspace.payerId)) === 'evaluation';
    },
    merchant(req: Request) {
      const s = session(req);
      return s.ok ? s.workspace.payerId : null;
    },
    // Each PDF page read is one unit of the address's upload limit, as a redaction is: all of them or none.
    meterPages(req: Request, pages: number): Reservation {
      const ip = clientIp(req, hops, trust);
      const giveBack = (n: number) => { for (let i = 0; i < n; i++) uploadLimit.release(ip); };
      for (let taken = 0; taken < pages; taken++) {
        const t = uploadLimit.take(ip);
        if (!t.ok) {
          giveBack(taken);
          return { ok: false, refusal: { status: 429, body: { error: 'RATE_LIMITED', detail: `Too many uploads from this address; try again in ${Math.ceil(t.retryAfterSec / 60)} min`, retryAfterSec: t.retryAfterSec } } };
        }
      }
      return { ok: true, release: () => giveBack(pages) };
    },
  };

  // Live runs and re-checks analyse inputs the server builds itself (app.ts), behind the seller workspace and the caps.
  // A case that moved to the next dispute of its reserve has new PayPal data: analyse it again (the others are stored).
  api = createApi({
    ...o,
    gate,
    onRebound: (caseId) => {
      o.onRebound?.(caseId);
      void warmUp();
    },
  });
  const webhook =
    o.webhook && o.paypal
      ? createWebhookHandler({ paypal: o.paypal, webhookId: o.webhook.id, key: o.webhook.key, onEvent: (e) => api.paypalNotified(e), ...(o.log ? { log: o.log } : {}), ...(o.webhook.verifyLimit ? { verifyLimit: o.webhook.verifyLimit } : {}) })
      : null;

  /** GET /api/demo: hosted mode, the daily caps, and why the costly actions are limited (the web app shows it). */
  const demoState = () => ({ hosted: true, ...o.counters.state(), reasons: LOCKED_REASON });

  /** The last warm-up's outcome per bound case (null until one finished): the operator's check reports it. */
  let lastWarmUp: WarmUpOutcome[] | null = null;
  /** GET /api/ops/status: what would let a judge down, checked now. `problems` empty means the demo is ready. */
  const PROBE_TIMEOUT_MS = 30_000;
  const probeModels = () =>
    Promise.all(
      (o.modelProbes ?? []).map(async (m) => {
        try {
          await Promise.race([m.probe(), new Promise((_, no) => setTimeout(() => no(new Error(`no answer in ${PROBE_TIMEOUT_MS / 1000} s`)), PROBE_TIMEOUT_MS).unref?.())]);
          return { name: m.name, ok: true };
        } catch (e) {
          return { name: m.name, ok: false, error: e instanceof Error ? e.message : 'failed' };
        }
      }),
    );
  const opsStatus = async (probe: boolean) => {
    const [r, models] = await Promise.all([api.opsReport(), probe ? probeModels() : Promise.resolve(null)]);
    const problems: string[] = [];
    if (models && models.length === 0) problems.push('no AI model is configured (GEMINI_API_KEY / GROQ_API_KEY)');
    for (const m of models ?? []) if (!m.ok) problems.push(`AI model ${m.name}: ${m.error}`);
    if (r.paypal === 'unconfigured') problems.push(`PayPal is not connected${r.error ? ` (${r.error})` : ''}`);
    if (!webhook) problems.push('the PayPal webhook is off (PAYPAL_WEBHOOK_ID / PAYPAL_WEBHOOK_KEY)');
    const caps = o.counters.storageProblem();
    if (caps) problems.push(`${caps} (evidence sends, live AI runs, re-checks, uploads and agent runs are refused)`);
    const cases = Object.keys(r.bindings);
    if (cases.length === 0) problems.push('no case is bound to a real PayPal dispute (BINDINGS_JSON)');
    for (const [caseId, b] of Object.entries(r.bindings)) {
      if (b.status !== 'verified') problems.push(`binding ${caseId} → ${b.dispute} is ${b.status}${b.reasons.length ? `: ${b.reasons.join('; ')}` : ''}`);
      else if (b.used && b.reserve === 0) {
        problems.push(`binding ${caseId} → ${b.dispute} is used (PayPal has the seller’s evidence or closed it) and no dispute is left in reserve: npm run demo:prepare, then add the new ones to BINDINGS_JSON`);
      }
    }
    for (const w of lastWarmUp ?? []) {
      if (w.outcome === 'failed' || w.outcome === 'skipped') problems.push(`warm-up · case ${w.caseId} · ${w.outcome} · ${w.detail}`);
    }
    return { ok: problems.length === 0, problems, ...r, webhook: webhook ? 'on' : 'off', warmUp: lastWarmUp, models, caps: o.counters.state(), checkedAt: now().toISOString() };
  };

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    // Render's health check (and nothing else) needs no Host match: it tells nothing and costs nothing.
    if (path === '/healthz') return req.method === 'GET' || req.method === 'HEAD' ? json(200, { ok: true }) : json(405, { error: 'METHOD_NOT_ALLOWED' });
    if (!hosts.has(hostOf(req))) return json(403, { error: 'FORBIDDEN_HOST' });

    // The operator's check (demo:check): a script, so no Origin or session; the token, or the route does not exist.
    if (path === OPS_PATH) {
      if (!o.opsToken) return json(404, { error: 'NOT_FOUND' });
      const t = authLimit.take(clientIp(req, hops, trust));
      if (!t.ok) return tooMany(t.retryAfterSec, 'Too many requests from this address');
      const bearer = /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';
      if (!bearer || !sameSecret(bearer, o.opsToken)) return json(404, { error: 'NOT_FOUND' });
      return req.method === 'GET' ? json(200, await opsStatus(url.searchParams.get('probe') === 'models')) : json(405, { error: 'METHOD_NOT_ALLOWED' });
    }
    // demo:prepare --agent-run: the full run record and its receipt as MeterMCP's admin route reads it now. A read
    // only: no engine, no MCP connection. The ops token or 401, whoever is signed in; a session cookie is not enough.
    if (path.startsWith(OPS_AGENT_RUN_PREFIX)) {
      if (!o.opsToken) return json(404, { error: 'NOT_FOUND' });
      const t = authLimit.take(clientIp(req, hops, trust));
      if (!t.ok) return tooMany(t.retryAfterSec, 'Too many requests from this address');
      const bearer = /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';
      if (!bearer || !sameSecret(bearer, o.opsToken)) return json(401, { error: 'MISSING_OR_BAD_TOKEN' });
      if (req.method !== 'GET') return json(405, { error: 'METHOD_NOT_ALLOWED' });
      const id = path.slice(OPS_AGENT_RUN_PREFIX.length);
      if (!RUN_ID.test(id)) return json(400, { error: 'INVALID_RUN_ID', detail: 'run-<32 hex>' });
      const run = o.agent?.store.get(id) ?? null;
      if (!run) return json(404, { error: 'NOT_FOUND' });
      let receipt: Receipt | null = null;
      let receiptError: string | null = null;
      if (!run.sessionId) receiptError = 'the run has no MeterMCP session';
      else if (!o.meterMcp) receiptError = 'MeterMCP is not configured on this server';
      else {
        try {
          receipt = await o.meterMcp.receipt(run.sessionId);
        } catch (e) {
          receiptError = e instanceof Error ? e.message : 'the receipt could not be read';
        }
      }
      return json(200, { run, receipt, receiptError });
    }

    // PayPal's webhook deliveries: no browser, so none of the browser rules below (Origin, session); PayPal confirms
    // each delivery itself (webhook.ts).
    if (path.startsWith(WEBHOOK_PREFIX)) {
      const key = path.slice(WEBHOOK_PREFIX.length);
      if (!webhook || !key || key.includes('/')) return json(404, { error: 'NOT_FOUND' });
      const w = webhookLimit.take(clientIp(req, hops, trust));
      if (!w.ok) return tooMany(w.retryAfterSec, 'Too many webhook deliveries from this address');
      return webhook(req, key);
    }

    if (path === '/api' || path.startsWith('/api/')) {
      const origin = req.headers.get('origin');
      if (STATE_CHANGING.has(req.method) ? !origin || !o.origins.includes(origin) : origin != null && !o.origins.includes(origin)) {
        return json(403, { error: 'FORBIDDEN_ORIGIN' });
      }
      const type = req.headers.get('content-type');
      if (req.method === 'POST' && !/^application\/json\s*(;|$)/i.test(type ?? '') && !acceptsFileBody(req.method, path, type)) {
        return json(415, { error: 'UNSUPPORTED_MEDIA_TYPE', detail: 'POST bodies must be application/json (an evidence upload may be image/png, image/jpeg or application/pdf)' });
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
      // A PDF page's text hint (a pdf.js read of the file when not cached) counts as a read: it cannot be looped.
      if (req.method === 'GET' && HINT_PATH.test(path)) {
        const r = readLimit.take(ip);
        if (!r.ok) return tooMany(r.retryAfterSec, `Too many reads; try again in ${r.retryAfterSec} s`);
      }
      // Uploads and redactions (/api/cases/…, never a PayPal read): a file decoded and OCR'd here, limited per address.
      const uploading = req.method === 'POST' && (UPLOAD_PATH.test(path) || REDACT_PATH.test(path));
      if (uploading) {
        const t = uploadLimit.take(ip);
        if (!t.ok) return tooMany(t.retryAfterSec, `Too many uploads from this address; try again in ${Math.ceil(t.retryAfterSec / 60)} min`);
      }
      const res = await api(req);
      // Only a refusal the routes mark as given before any decoding or OCR gives the slot back; the mark stays here.
      if (res.headers.has(REFUSED_EARLY)) {
        if (uploading) uploadLimit.release(ip);
        res.headers.delete(REFUSED_EARLY);
      }
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
    const r = o.counters.reserve('live-analysis');
    if (!r.ok) {
      return r.reason === 'storage'
        ? { ok: false, refusal: { status: 503, body: { error: 'CAPS_UNAVAILABLE', detail: 'the daily caps cannot be saved' } } }
        : { ok: false, refusal: { status: 429, body: { error: 'DAILY_CAP', detail: 'the daily cap of live analyses is reached' } } };
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
      lastWarmUp = out;
      return out;
    };
    // One warm-up at a time; a request during one runs after it (the bindings may have changed meanwhile).
    chain = chain.then(run, run);
    return chain;
  };
  return Object.assign(handler, {
    warmUp,
    personOf: (req: Request) => api.personOf(req),
    bindingsChanged: () => {
      api.forgetReads();
      return warmUp();
    },
  });
}
