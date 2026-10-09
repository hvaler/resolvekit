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

/** Handles /mcp requests (already past the HTTP guards). */
export function createMcpEndpoint(meter: Meter, policy?: BudgetPolicy) {
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

  /** `authInfo`: what the HTTP layer established about this request (hosted mode: a valid demo code). */
  const handle = async (req: Request, authInfo?: AuthInfo): Promise<Response> => {
    const opts = authInfo ? { authInfo } : undefined;
    const sid = req.headers.get('mcp-session-id');
    if (sid) {
      const t = transports.get(sid);
      return t ? t.handleRequest(req, opts) : rpcError(404, 'Unknown MCP session');
    }
    if (req.method !== 'POST') return rpcError(400, 'No MCP session');
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return rpcError(400, 'Invalid JSON');
    }
    if (!isInitializeRequest(body)) return rpcError(400, 'No MCP session: initialize first');
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => void transports.set(id, transport),
      onsessionclosed: (id) => void transports.delete(id),
    });
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };
    await buildServer(meter, policy).connect(transport);
    return transport.handleRequest(req, { parsedBody: body, ...opts });
  };

  return {
    handle,
    sessions: () => transports.size,
    closeAll: async () => {
      await Promise.all([...transports.values()].map((t) => t.close()));
      transports.clear();
    },
  };
}
