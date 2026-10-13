/**
 * MeterMCP's HTTP surface as a `(Request) => Promise<Response>` handler (tests call it directly):
 *
 * - `POST|GET|DELETE /mcp` — the MCP endpoint (Streamable HTTP) for MCP clients, not browsers.
 * - `GET /approved`, `GET /cancelled` — where PayPal sends the buyer's browser back. They only make MeterMCP re-read
 *   the order from PayPal; nothing there trusts the query string.
 * - `GET /health`.
 * - Admin, for apps/server on this machine (header `x-metermcp-token`, the per-launch secret):
 *   `GET /sessions?capture=<id>`, `GET /sessions/<id>/receipt.json|.pdf`, `POST /sessions/<id>/close`.
 *   A session id alone never authorizes anything.
 *
 * Every request: Host must be this server (DNS rebinding); a present Origin must be an allowed one (browsers on
 * other sites are refused); POST bodies must be application/json.
 */
import { timingSafeEqual } from 'node:crypto';
import { KeyedLimiter, clientIp, describeClientIp, hostOf, sameSecret as sameCode, withSecurityHeaders, type DailyCounters, type ProxyTrust } from '@resolvekit/hosting';
import type { PayPalEnv } from '@resolvekit/paypal';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { createMcpEndpoint, type BudgetPolicy, type McpLimits, type McpMetrics } from './mcp.ts';
import { SESSION_ID, answer, type Meter } from './meter.ts';
import { receiptPdf } from './receipt.ts';

export const TOKEN_HEADER = 'x-metermcp-token';
/** Hosted mode: the header an MCP client sends with the demo code to be allowed to open a budget. */
export const DEMO_CODE_HEADER = 'x-demo-code';

/**
 * Hosted mode (public internet, e.g. Render). Public: `/mcp` (judges' own MCP clients), `/approved`, `/cancelled`,
 * `/health`, on the public host only. Creating a budget (a PayPal order) needs the demo code in `x-demo-code` and
 * stays within a daily cap; free tools and an already approved budget work without it. Admin routes (`/sessions…`)
 * answer only requests that did not come through Render's public proxy (no X-Forwarded-For, not the public Host),
 * i.e. apps/server over the private network, with the shared admin token.
 */
export interface HostedMeterOptions {
  publicHosts: readonly string[];
  https: boolean;
  demoCode: string | null;
  /** Daily cap `budget`: budgets (PayPal orders) created per UTC day, persisted on the disk. */
  budgets: DailyCounters;
  trustedHops?: number;
  /** Whose X-Forwarded-For is believed (default: a proxy on a private address). */
  proxyTrust?: ProxyTrust;
  /** /mcp requests per IP. */
  mcpPerIp?: { limit: number; windowMs: number };
  /** Wrong demo codes per IP before even the right one is refused for a while. */
  badCodesPerIp?: { limit: number; windowMs: number };
  now?: () => number;
}

const DEMO_REQUIRED = 'Creating a budget opens a real PayPal sandbox order, so on this public demo it needs the demo code from the Devpost testing instructions: send it in the x-demo-code HTTP header of your MCP client. Free tools (price_list, get_balance, get_receipt, close_session) work without it.';

export interface AppOptions {
  meter: Meter;
  env: PayPalEnv;
  port: number;
  /** Per-launch admin secret (apps/server reads it from apps/metermcp/.runtime-token). */
  token: string;
  /** Browser origins allowed when an Origin header is present (none by default: MCP clients send no Origin). */
  allowedOrigins: readonly string[];
  log?: (line: string) => void;
  /** Present in hosted mode; replaces the local Host check. */
  hosted?: HostedMeterOptions | null;
  /** Caps and idle timeout of live MCP sessions (defaults: 200 in all, 20 per IP, 15 min idle). */
  mcpLimits?: Partial<McpLimits>;
}

export type Handler = ((req: Request) => Promise<Response>) & {
  close: () => Promise<void>;
  /** Close MCP sessions idle past the limit (main.ts runs it on a timer). */
  sweepMcp: () => Promise<string[]>;
  /** Live MCP sessions and how many were refused or expired. */
  metrics: () => McpMetrics;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title: string, text: string) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;color:#1b1f24;background:#fff}@media (prefers-color-scheme:dark){body{color:#e6e8eb;background:#14171a}}</style></head><body><h1>${esc(title)}</h1><p>${esc(text)}</p></body></html>`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" } },
  );

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Local guard. `hostChecked`: the caller (hosted mode) already checked Host its own way. */
export function guard(req: Request, opts: Pick<AppOptions, 'port' | 'allowedOrigins'>, hostChecked = false): Response | null {
  const host = req.headers.get('host') ?? new URL(req.url).host;
  if (!hostChecked && host !== `127.0.0.1:${opts.port}` && host !== `localhost:${opts.port}`) return json(403, { error: 'FORBIDDEN_HOST' });
  const origin = req.headers.get('origin');
  if (origin != null && !opts.allowedOrigins.includes(origin)) return json(403, { error: 'FORBIDDEN_ORIGIN' });
  if (req.method === 'POST' && !/^application\/json\s*(;|$)/i.test(req.headers.get('content-type') ?? '')) {
    return json(415, { error: 'UNSUPPORTED_MEDIA_TYPE', detail: 'POST bodies must be application/json' });
  }
  return null;
}

export function createApp(opts: AppOptions): Handler {
  const { meter } = opts;
  const log = opts.log ?? (() => {});
  const h = opts.hosted ?? null;
  const now = h?.now ?? Date.now;
  const mcpLimit = new KeyedLimiter({ limit: 600, windowMs: 5 * 60_000, ...h?.mcpPerIp, now });
  const badCodes = new KeyedLimiter({ limit: 5, windowMs: 15 * 60_000, ...h?.badCodesPerIp, now });
  let derivationLogged = false;
  const publicHosts = new Set((h?.publicHosts ?? []).map((x) => x.toLowerCase()));

  // Hosted: a budget opens only for a request that carried the demo code, within today's cap (reserved atomically,
  // refunded if PayPal could not create the order).
  const policy: BudgetPolicy | undefined = h
    ? (auth) => () => {
        if (!auth?.scopes.includes('open_budget')) return { ok: false, answer: answer({ error: 'demo_code_required', message: DEMO_REQUIRED }, true) };
        const day = h.budgets.today();
        if (!h.budgets.take('budget')) {
          const st = h.budgets.state();
          return { ok: false, answer: answer({ error: 'daily_cap', message: `This demo creates at most ${st.caps.budget?.limit ?? 0} budgets per day; the cap resets at ${st.resetsAt}.` }, true) };
        }
        return { ok: true, release: () => h.budgets.release('budget', day) };
      }
    : undefined;
  const mcp = createMcpEndpoint(meter, policy, opts.mcpLimits ?? {});
  const admin = (req: Request) => {
    const t = req.headers.get(TOKEN_HEADER);
    return !!opts.token && !!t && sameSecret(t, opts.token);
  };

  const route = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === '/mcp') {
      if (!h) return mcp.handle(req, undefined, 'local');
      const ip = clientIp(req, h.trustedHops ?? 1, h.proxyTrust ?? 'private');
      if (!derivationLogged) {
        derivationLogged = true;
        log(`client address derivation · ${describeClientIp(req, h.trustedHops ?? 1, h.proxyTrust ?? 'private')}`);
      }
      const lim = mcpLimit.take(ip);
      if (!lim.ok) return json(429, { jsonrpc: '2.0', error: { code: -32000, message: `Too many requests; retry in ${lim.retryAfterSec} s` }, id: null });
      const code = req.headers.get(DEMO_CODE_HEADER);
      let auth: AuthInfo | undefined;
      if (code != null) {
        // Wrong codes are counted per IP; once over the limit even the right code waits. Check and count happen in
        // one synchronous step, so concurrent guesses cannot get past the limit.
        if (badCodes.blocked(ip)) return json(429, { jsonrpc: '2.0', error: { code: -32001, message: 'Too many wrong demo codes from this address; try again later' }, id: null });
        if (!h.demoCode || code.length > 200 || !sameCode(code.trim(), h.demoCode)) {
          badCodes.take(ip);
          return json(403, { jsonrpc: '2.0', error: { code: -32001, message: 'Invalid demo code (x-demo-code)' }, id: null });
        }
        auth = { token: 'demo-code', clientId: 'demo', scopes: ['open_budget'] };
      }
      return mcp.handle(req, auth, ip);
    }
    if (req.method === 'GET' && path === '/health') {
      const m = mcp.metrics();
      return json(200, { ok: true, paypal: opts.env, mcpSessions: m.live, mcpRejected: m.rejected, mcpExpired: m.expired });
    }

    if (req.method === 'GET' && (path === '/approved' || path === '/cancelled')) {
      // PayPal appends ?token=<order id>. The order is re-read from PayPal; the URL itself proves nothing.
      const orderId = url.searchParams.get('token') ?? '';
      const s = /^[A-Z0-9]{5,40}$/.test(orderId) ? await meter.approvedByOrder(orderId) : null;
      if (path === '/cancelled' && s?.status !== 'active') {
        return page('Budget not approved', 'You cancelled in PayPal. Nothing was authorized or charged; your agent will ask again if it needs a budget.');
      }
      if (!s) return page('Unknown order', 'MeterMCP has no session for this PayPal order.');
      if (s.status === 'cancelled' && s.settlement_error) {
        return page('Payment method declined', 'PayPal declined the payment method you chose. Nothing was authorized or charged. Return to your agent: its next paid call gives you a new approval link, where you can choose another payment method.');
      }
      if (s.status === 'active') return page('Budget approved', 'PayPal authorized the budget. You can close this tab and return to your agent: it is charged only for successful tool calls, and the rest is released when the session closes.');
      return page('Waiting for PayPal', `PayPal reports the order is not approved yet (session ${s.status}). Reload this page in a moment.`);
    }

    if (path === '/sessions' || path.startsWith('/sessions/')) {
      if (!admin(req)) return json(401, { error: 'MISSING_OR_BAD_TOKEN' });
      if (req.method === 'GET' && path === '/sessions') {
        const capture = url.searchParams.get('capture') ?? '';
        if (!/^[A-Z0-9]{5,40}$/.test(capture)) return json(400, { error: 'CAPTURE_REQUIRED', detail: '?capture=<PayPal capture id>' });
        return json(200, { sessions: meter.sessionsByCapture(capture).map((s) => ({ id: s.id, status: s.status, capture_id: s.capture_id })) });
      }
      const m = /^\/sessions\/([^/]+)\/(receipt\.json|receipt\.pdf|close|reconcile)$/.exec(path);
      if (!m) return json(404, { error: 'NOT_FOUND' });
      const id = m[1]!;
      if (!SESSION_ID.test(id)) return json(404, { error: 'NOT_FOUND' });
      if (m[2] === 'reconcile') {
        // On demand: read a PENDING capture back from PayPal now.
        if (req.method !== 'POST') return json(405, { error: 'METHOD_NOT_ALLOWED' });
        const s = await meter.reconcile(id);
        return s ? json(200, { session_id: s.id, status: s.status, capture_id: s.capture_id, capture_status: s.capture_status }) : json(404, { error: 'NOT_FOUND' });
      }
      if (m[2] === 'close') {
        if (req.method !== 'POST') return json(405, { error: 'METHOD_NOT_ALLOWED' });
        const r = await meter.close(id);
        return json(r.status === 'not_found' ? 404 : r.status === 'busy' ? 409 : 200, r);
      }
      if (req.method !== 'GET') return json(405, { error: 'METHOD_NOT_ALLOWED' });
      const receipt = meter.receipt(id);
      if (!receipt) return json(404, { error: 'NOT_FOUND' });
      if (m[2] === 'receipt.json') return json(200, receipt);
      return new Response(receiptPdf(receipt), {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="session-receipt-${id}.pdf"`, 'cache-control': 'no-store' },
      });
    }
    return json(404, { error: 'NOT_FOUND' });
  };

  /**
   * Hosted guard: admin routes only for requests that did not come through the public proxy (apps/server on the
   * private network; they still need the admin token); everything else only on the public host. Origin and JSON-only
   * POST as in local mode.
   */
  const hostedGuard = (req: Request): Response | null => {
    const path = new URL(req.url).pathname;
    const host = hostOf(req);
    if (path === '/sessions' || path.startsWith('/sessions/')) {
      if (req.headers.has('x-forwarded-for') || publicHosts.has(host)) return json(404, { error: 'NOT_FOUND' });
    } else if (!publicHosts.has(host)) return json(403, { error: 'FORBIDDEN_HOST' });
    return guard(req, opts, true);
  };

  const handler = async (req: Request) => {
    const t = Date.now();
    let res: Response;
    try {
      // Render's health check needs no Host match: it tells nothing and costs nothing.
      if (h && new URL(req.url).pathname === '/healthz') res = json(200, { ok: true });
      else res = (h ? hostedGuard(req) : guard(req, opts)) ?? (await route(req));
    } catch (e) {
      log(`error: ${e instanceof Error ? e.message : String(e)}`);
      res = json(500, { error: 'INTERNAL' });
    }
    log(`${req.method} ${new URL(req.url).pathname} → ${res.status} · ${Date.now() - t} ms`);
    return h ? withSecurityHeaders(res, { hsts: h.https }) : res;
  };
  return Object.assign(handler, { close: mcp.closeAll, sweepMcp: mcp.sweepIdle, metrics: mcp.metrics });
}
