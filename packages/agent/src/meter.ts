/**
 * The engine's MeterMCP connection: an MCP client over Streamable HTTP, like any external agent. The engine only
 * sees tools (with their price) and JSON answers; the transport and its auth headers are the caller's choice.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JsonSchema } from './types.ts';

export interface MeterTool {
  name: string;
  title: string;
  description: string;
  /** Price per successful call (decimal string in USD); null for free tools. */
  price: string | null;
  inputSchema: JsonSchema;
}

/** A tool answer: MeterMCP's JSON text content, parsed (`{ text }` when it is not JSON). */
export interface MeterAnswer {
  isError: boolean;
  body: Record<string, any>;
}

export interface MeterConnection {
  listTools(): Promise<MeterTool[]>;
  call(name: string, args: Record<string, unknown>): Promise<MeterAnswer>;
  close(): Promise<void>;
}

/** The price a tool declares in `_meta['metermcp/price']`; free tools declare '0.00'. */
function priceOf(meta: unknown): string | null {
  const amount = (meta as Record<string, any> | undefined)?.['metermcp/price']?.amount;
  return typeof amount === 'string' && /^\d+(\.\d+)?$/.test(amount) && Number(amount) > 0 ? amount : null;
}

function parseBody(content: unknown): Record<string, any> {
  const text = Array.isArray(content) ? (content as Array<{ type?: string; text?: unknown }>).find((c) => c?.type === 'text')?.text : undefined;
  if (typeof text !== 'string') return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v };
  } catch {
    return { text };
  }
}

/** MCP client over Streamable HTTP. headers: { 'x-demo-code' } for public /mcp, or { 'x-metermcp-token', 'x-agent-run' } for /agent/mcp. */
export async function connectMeter(o: { url: string; headers?: Record<string, string> }): Promise<MeterConnection> {
  const client = new Client({ name: 'resolvekit-agent', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(o.url), o.headers ? { requestInit: { headers: o.headers } } : {}));
  return {
    async listTools() {
      const { tools } = await client.listTools();
      return tools.map((t) => ({
        name: t.name,
        title: t.title ?? t.annotations?.title ?? t.name,
        description: t.description ?? '',
        price: priceOf(t._meta),
        inputSchema: t.inputSchema as JsonSchema,
      }));
    },
    async call(name, args) {
      const r = await client.callTool({ name, arguments: args });
      return { isError: r.isError === true, body: parseBody(r.content) };
    },
    close: () => client.close(),
  };
}
