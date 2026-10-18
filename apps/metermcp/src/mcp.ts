/**
 * The MCP side of MeterMCP: one McpServer + Streamable HTTP transport per MCP session (stateful, JSON responses).
 * The MCP session id is what ties an agent to its payment session: every tool reaches only the caller's own
 * session, so another MCP client can never spend, close or read someone else's budget.
 */
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { z } from 'zod';
import type { BudgetGate, Meter, ToolAnswer } from './meter.ts';
import { CURRENCY, PAID_TOOLS } from './tools.ts';

const FREE = { 'metermcp/price': { amount: '0.00', currency: CURRENCY, per: 'call' } };

function noSession(): ToolAnswer {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'no_mcp_session', message: 'MeterMCP needs a stateful MCP session (Mcp-Session-Id).' }) }] };
}

/**
 * Hosted mode: the gate for opening a new budget, given what the HTTP layer established about this request (the
 * demo code it carried, as `authInfo`). Absent (local mode): budgets open freely.
 */
export type BudgetPolicy = (auth: AuthInfo | undefined) => BudgetGate;

export function buildServer(meter: Meter, policy?: BudgetPolicy): McpServer {
  const server = new McpServer({ name: 'metermcp', version: '0.1.0' }, { instructions: 'Paid tools draw on a budget the user approves in PayPal. A paid call without one answers payment_required with an approval_url for the user. Failed calls are never charged. Call close_session when done: only successful calls are captured and the rest of the budget is released.' });

  for (const t of PAID_TOOLS) {
    const title = `${t.title} · ${t.price} ${CURRENCY} per call`;
    server.registerTool(
      t.name,
      {
        title,
        description: `${t.summary} Price: ${t.price} ${CURRENCY} per successful call; failed calls are not charged. Draws on the MeterMCP budget the user approved in PayPal; without one it answers payment_required with an approval URL.`,
        inputSchema: t.input,
        annotations: { title, readOnlyHint: true, openWorldHint: false },
        _meta: { 'metermcp/price': { amount: t.price, currency: CURRENCY, per: 'successful call' } },
      },
      async (args, extra) =>
        extra.sessionId ? meter.call(extra.sessionId, t.name, args as Record<string, unknown>, policy ? { budgetGate: policy(extra.authInfo) } : {}) : noSession(),
    );
  }

  server.registerTool(
    'price_list',
    { title: 'Price list · free', description: 'Prices of the paid MeterMCP tools (free).', annotations: { readOnlyHint: true, openWorldHint: false }, _meta: FREE },
    async () => meter.priceList(),
  );
  server.registerTool(
    'get_balance',
    {
      title: 'Balance · free',
      description: 'Your session: status (pending_approval, active…), approved cap, charged, remaining, and the approval URL while waiting for the user (free). Polling it also picks up the user’s approval.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: FREE,
    },
    async (extra) => (extra.sessionId ? meter.balance(extra.sessionId) : noSession()),
  );
  const { min, max } = meter.capRange;
  server.registerTool(
    'open_budget',
    {
      title: 'Open budget · free',
      description: `Open your session's budget with the cap you need, from ${min} to ${max} ${CURRENCY} (instead of the payment_required proposal). The cap must be approved by the user in PayPal: it answers an approval_url for the user, and the budget is active once they approve (poll get_balance). Only one budget at a time per session. Optional fail_first: up to 3 paid tools whose first call fails on purpose (not charged), to show that path. Optional return_to: where the user's browser goes after approving, when it is an allowed origin (free).`,
      inputSchema: {
        cap: z.string().max(16).describe(`Budget cap in ${CURRENCY}, e.g. "2.50" (from ${min} to ${max})`),
        fail_first: z.array(z.string().max(64)).max(3).optional().describe('Paid tools whose first call fails on purpose (not charged), e.g. ["deep_report"]'),
        return_to: z.string().max(2048).optional().describe('Absolute URL to send the user back to after approval (ignored unless its origin is allowed)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: FREE,
    },
    async (args, extra) =>
      extra.sessionId
        ? meter.openBudget(extra.sessionId, { cap: args.cap, failFirst: args.fail_first, returnTo: args.return_to }, policy ? { budgetGate: policy(extra.authInfo) } : {})
        : noSession(),
  );
  server.registerTool(
    'close_session',
    {
      title: 'Close session · free',
      description: 'Close your session and settle it in PayPal: capture only the successful calls and release the rest of the budget (void it if nothing was used). Calling it again retries a failed settlement (free).',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: FREE,
    },
    async (extra) => (extra.sessionId ? meter.closeFor(extra.sessionId) : noSession()),
  );
  server.registerTool(
    'get_receipt',
    { title: 'Receipt · free', description: 'The receipt of your latest session: mandate, every call with its request hash, totals and settlement (free).', annotations: { readOnlyHint: true, openWorldHint: false }, _meta: FREE },
    async (extra) => (extra.sessionId ? meter.receiptFor(extra.sessionId) : noSession()),
  );
  return server;
}

const rpcError = (status: number, message: string) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }), { status, headers: { 'content-type': 'application/json' } });

/** Limits on live MCP sessions (transports, each with its own McpServer in memory). */
export interface McpLimits {
  /** Live MCP sessions in all. */
  maxSessions: number;
  /** Live MCP sessions per key (the client IP; the agent run on /agent/mcp). */
  maxPerIp: number;
  /** A session with no request for this long is closed (its transport freed, its payment session closed). */
  idleMs: number;
  /** A request carrying a session id must come from the key that opened it (else 404): one run cannot drive another's session. */
  bindSessionToKey?: boolean;
  now?: () => number;
}

export const DEFAULT_MCP_LIMITS: McpLimits = { maxSessions: 200, maxPerIp: 20, idleMs: 15 * 60_000 };

/** Simple counters for /health and the log. */
export interface McpMetrics {
  live: number;
  rejected: number;
  expired: number;
}

/**
 * Handles /mcp requests (already past the HTTP guards). Live sessions are capped in all and per client IP; the slot
 * is reserved synchronously before the session is set up, so concurrent initializations cannot overshoot. A session
 * idle for {@link McpLimits.idleMs} is closed: its transport is freed and its payment session closed safely (settled
 * with only its OK calls, or cancelled if never approved; a call in flight makes it wait for the meter's own sweep).
 */
export function createMcpEndpoint(meter: Meter, policy?: BudgetPolicy, limits: Partial<McpLimits> = {}) {
  const L: McpLimits = { ...DEFAULT_MCP_LIMITS, ...limits };
  const now = L.now ?? Date.now;
  const live = new Map<string, { transport: WebStandardStreamableHTTPServerTransport | null; ip: string; lastSeen: number }>();
  const metrics = { rejected: 0, expired: 0 };

  const drop = (id: string) => void live.delete(id);

  /** Close every session idle for longer than the limit. Returns the ids closed. */
  const sweepIdle = async (): Promise<string[]> => {
    const cutoff = now() - L.idleMs;
    const idle = [...live.entries()].filter(([, s]) => s.transport && s.lastSeen < cutoff);
    for (const [id, s] of idle) {
      live.delete(id);
      metrics.expired += 1;
      try {
        await s.transport!.close();
      } catch {
        /* already closed */
      }
      // The payment session of this MCP session, if any: closed like close_session would (never charged for failures).
      try {
        await meter.closeFor(id);
      } catch {
        /* the meter's own idle sweep retries */
      }
    }
    return idle.map(([id]) => id);
  };

  /** `authInfo`: what the HTTP layer established about this request (hosted mode: a valid demo code). */
  const handle = async (req: Request, authInfo?: AuthInfo, ip = 'local'): Promise<Response> => {
    const opts = authInfo ? { authInfo } : undefined;
    const sid = req.headers.get('mcp-session-id');
    if (sid) {
      const s = live.get(sid);
      if (!s?.transport || (L.bindSessionToKey && s.ip !== ip)) return rpcError(404, 'Unknown MCP session');
      s.lastSeen = now();
      return s.transport.handleRequest(req, opts);
    }
    if (req.method !== 'POST') return rpcError(400, 'No MCP session');
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return rpcError(400, 'Invalid JSON');
    }
    if (!isInitializeRequest(body)) return rpcError(400, 'No MCP session: initialize first');
    await sweepIdle();
    // Reserve the slot in this synchronous step: the caps hold under concurrent initializations.
    const fromIp = [...live.values()].filter((s) => s.ip === ip).length;
    if (live.size >= L.maxSessions || fromIp >= L.maxPerIp) {
      metrics.rejected += 1;
      return rpcError(503, live.size >= L.maxSessions ? 'Too many live MCP sessions on this server; try again later' : 'Too many live MCP sessions from this address; close one or try again later');
    }
    const id = randomUUID();
    live.set(id, { transport: null, ip, lastSeen: now() });
    try {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => id,
        enableJsonResponse: true,
        onsessionclosed: (closed) => drop(closed),
      });
      transport.onclose = () => drop(id);
      await buildServer(meter, policy).connect(transport);
      const entry = live.get(id);
      if (!entry) return rpcError(503, 'MCP session closed during setup');
      entry.transport = transport;
      const res = await transport.handleRequest(req, { parsedBody: body, ...opts });
      if (!res.ok || transport.sessionId !== id) drop(id);
      return res;
    } catch (e) {
      drop(id);
      throw e;
    }
  };

  return {
    handle,
    sweepIdle,
    sessions: () => live.size,
    metrics: (): McpMetrics => ({ live: live.size, ...metrics }),
    closeAll: async () => {
      const all = [...live.values()];
      live.clear();
      await Promise.all(all.map((s) => s.transport?.close()));
    },
  };
}
