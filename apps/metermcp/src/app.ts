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
import type { PayPalEnv } from '@resolvekit/paypal';
import { createMcpEndpoint } from './mcp.ts';
import { SESSION_ID, type Meter } from './meter.ts';
import { receiptPdf } from './receipt.ts';

export const TOKEN_HEADER = 'x-metermcp-token';

export interface AppOptions {
  meter: Meter;
  env: PayPalEnv;
  port: number;
  /** Per-launch admin secret (apps/server reads it from apps/metermcp/.runtime-token). */
  token: string;
  /** Browser origins allowed when an Origin header is present (none by default: MCP clients send no Origin). */
  allowedOrigins: readonly string[];
  log?: (line: string) => void;
}

export type Handler = ((req: Request) => Promise<Response>) & { close: () => Promise<void> };

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

export function guard(req: Request, opts: Pick<AppOptions, 'port' | 'allowedOrigins'>): Response | null {
  const host = req.headers.get('host') ?? new URL(req.url).host;
  if (host !== `127.0.0.1:${opts.port}` && host !== `localhost:${opts.port}`) return json(403, { error: 'FORBIDDEN_HOST' });
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
  const mcp = createMcpEndpoint(meter);
  const admin = (req: Request) => {
    const t = req.headers.get(TOKEN_HEADER);
    return !!opts.token && !!t && sameSecret(t, opts.token);
  };

  const route = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === '/mcp') return mcp.handle(req);
    if (req.method === 'GET' && path === '/health') return json(200, { ok: true, paypal: opts.env, mcpSessions: mcp.sessions() });

    if (req.method === 'GET' && (path === '/approved' || path === '/cancelled')) {
      // PayPal appends ?token=<order id>. The order is re-read from PayPal; the URL itself proves nothing.
      const orderId = url.searchParams.get('token') ?? '';
      const s = /^[A-Z0-9]{5,40}$/.test(orderId) ? await meter.approvedByOrder(orderId) : null;
      if (path === '/cancelled' && s?.status !== 'active') {
        return page('Budget not approved', 'You cancelled in PayPal. Nothing was authorized or charged; your agent will ask again if it needs a budget.');
      }
      if (!s) return page('Unknown order', 'MeterMCP has no session for this PayPal order.');
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
      const m = /^\/sessions\/([^/]+)\/(receipt\.json|receipt\.pdf|close)$/.exec(path);
      if (!m) return json(404, { error: 'NOT_FOUND' });
      const id = m[1]!;
      if (!SESSION_ID.test(id)) return json(404, { error: 'NOT_FOUND' });
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

  const handler = async (req: Request) => {
    const t = Date.now();
    let res: Response;
    try {
      res = guard(req, opts) ?? (await route(req));
    } catch (e) {
      log(`error: ${e instanceof Error ? e.message : String(e)}`);
      res = json(500, { error: 'INTERNAL' });
    }
    log(`${req.method} ${new URL(req.url).pathname} → ${res.status} · ${Date.now() - t} ms`);
    return res;
  };
  return Object.assign(handler, { close: mcp.closeAll });
}
