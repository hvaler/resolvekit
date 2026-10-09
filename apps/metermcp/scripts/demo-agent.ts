/**
 * Demo MCP client for MeterMCP (scripted, no LLM): connects over Streamable HTTP, hits payment_required, prints the
 * approval URL for the human, polls get_balance until PayPal shows the budget approved, makes the paid calls
 * (retrying a failed one once) and closes the session, which settles it in PayPal.
 *
 *   npm run demo-agent --workspace @resolvekit/metermcp            # full run (waits for approval)
 *   npm run demo-agent --workspace @resolvekit/metermcp -- --no-wait   # stop after printing the approval URL
 *
 * Env: METERMCP_URL (http://127.0.0.1:8790/mcp) · APPROVAL_TIMEOUT_MINUTES (15) · METERMCP_DEMO_CODE (sent as the
 * x-demo-code header: the hosted demo needs it to open a budget).
 * The agent is pluggable: `run(plan, tools)` takes any planner that yields tool calls; an LLM-driven one can replace
 * `SCRIPTED_PLAN` later without touching the MCP or payment handling.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  isError: boolean;
  body: Record<string, any>;
}

/** What the agent can do: call a MeterMCP tool. */
export type CallTool = (c: ToolCall) => Promise<ToolResult>;

/** A planner yields the next call given the last result (null = done). */
export type Planner = (last: { call: ToolCall; result: ToolResult } | null) => ToolCall | null;

/** The demo: quote_lookup, deep_report (retried once if it fails), bulk_export. */
export function scriptedPlanner(): Planner {
  const steps: ToolCall[] = [
    { name: 'quote_lookup', arguments: { symbol: 'ACME-42' } },
    { name: 'deep_report', arguments: { topic: 'ACME-42 supplier risk' } },
    { name: 'bulk_export', arguments: { dataset: 'quotes-2026-10', rows: 250 } },
  ];
  let i = 0;
  let retried = false;
  return (last) => {
    if (last && last.result.isError && last.result.body.error === 'upstream_failed' && !retried) {
      retried = true;
      return last.call; // retry the failed call once
    }
    return steps[i++] ?? null;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AgentRunOptions {
  /** MeterMCP's MCP endpoint, e.g. http://127.0.0.1:8790/mcp. */
  url: string;
  /** Sent as the x-demo-code header (the hosted MeterMCP needs it to open a budget). Never printed. */
  demoCode?: string | undefined;
  /** Stop after printing the approval URL. */
  noWait?: boolean;
  /** How long to wait for the buyer's approval. */
  approvalTimeoutMs?: number;
  /** Progress lines (default: console, prefixed "[agent]"). */
  say?: (line: string) => void;
}

export interface AgentRunResult {
  /** The PayPal capture of the settled session (the payment the buyer disputes); null if none. */
  captureId: string | null;
  sessionId: string | null;
  /** MeterMCP's receipt (get_receipt), when the run got that far. */
  receipt: Record<string, any> | null;
}

/** Run the scripted agent against MeterMCP: payment_required → approval → paid calls → close → receipt. */
export async function runDemoAgent(o: AgentRunOptions): Promise<AgentRunResult> {
  const url = o.url;
  const noWait = o.noWait ?? false;
  const timeoutMs = o.approvalTimeoutMs ?? 15 * 60_000;
  const say = o.say ?? ((s: string) => console.log(`[agent] ${s}`));
  const out: AgentRunResult = { captureId: null, sessionId: null, receipt: null };

  const client = new Client({ name: 'metermcp-demo-agent', version: '0.1.0' });
  const demoCode = o.demoCode;
  await client.connect(new StreamableHTTPClientTransport(new URL(url), demoCode ? { requestInit: { headers: { 'x-demo-code': demoCode } } } : {}));
  const callTool: CallTool = async (c) => {
    const r = await client.callTool(c);
    const text = (r.content as Array<{ type: string; text?: string }>).find((x) => x.type === 'text')?.text ?? '{}';
    return { isError: r.isError === true, body: JSON.parse(text) };
  };
  try {
    const { tools } = await client.listTools();
    say(`connected to ${url} · tools: ${tools.map((t) => `${t.name} (${t.annotations?.title ?? t.title ?? ''})`).join(', ')}`);

    const planner = scriptedPlanner();
    let first = planner(null)!;
    let r = await callTool(first);
    if (r.isError && r.body.error === 'payment_required') {
      say(`payment_required: ${first.name} costs ${r.body.price} ${r.body.currency}; MeterMCP proposes a budget of ${r.body.budget_proposal} ${r.body.currency}`);
      say(`session ${r.body.session_id} · PayPal order ${r.body.order_id}`);
      out.sessionId = r.body.session_id ?? null;
      say(`Approve the budget in PayPal (sandbox buyer account):\n\n  ${r.body.approval_url}\n`);
      if (noWait) {
        say('--no-wait: stopping here. The unapproved order expires on its own; nothing is authorized or charged.');
        return out;
      }
      const until = Date.now() + timeoutMs;
      for (;;) {
        const b = await callTool({ name: 'get_balance', arguments: {} });
        if (b.body.status === 'active') {
          say(`budget approved · cap ${b.body.cap} ${b.body.currency} · remaining ${b.body.remaining}`);
          break;
        }
        if (b.body.status !== 'pending_approval' || Date.now() > until) {
          say(`not approved (${b.body.status}); giving up`);
          return out;
        }
        await sleep(3000);
      }
      r = await callTool(first);
    } else if (r.isError) {
      say(`error: ${JSON.stringify(r.body)}`);
      return out;
    }

    let last: { call: ToolCall; result: ToolResult } | null = { call: first, result: r };
    for (;;) {
      const m = last.result.body.metering;
      say(`${last.call.name} → ${m ? `${m.status} · ${m.price} ${m.currency}${m.status === 'OK' ? '' : ' (not charged)'} · request ${String(m.request_hash).slice(0, 12)}… · remaining ${m.remaining}` : JSON.stringify(last.result.body)}`);
      const next = planner(last);
      if (!next) break;
      first = next;
      last = { call: next, result: await callTool(next) };
    }

    const closed = await callTool({ name: 'close_session', arguments: {} });
    say(`close_session → ${JSON.stringify(closed.body, null, 2)}`);
    const receipt = await callTool({ name: 'get_receipt', arguments: {} });
    const rc = receipt.body;
    say(`receipt: ${rc.totals?.ok} OK / ${rc.totals?.failed} failed · charged ${rc.totals?.charged} of ${rc.totals?.cap} · capture ${rc.settlement?.capture_id ?? '—'} · sha256 ${rc.receipt_sha256}`);
    if (rc.settlement?.capture_id) say(`PayPal capture id (the buyer disputes this one): ${rc.settlement.capture_id}`);
    out.receipt = rc;
    out.sessionId = rc.session?.id ?? out.sessionId;
    out.captureId = rc.settlement?.capture_id ?? null;
    return out;
  } finally {
    await client.close();
  }
}

async function main() {
  await runDemoAgent({
    url: process.env.METERMCP_URL ?? 'http://127.0.0.1:8790/mcp',
    demoCode: process.env.METERMCP_DEMO_CODE,
    noWait: process.argv.includes('--no-wait'),
    approvalTimeoutMs: Number(process.env.APPROVAL_TIMEOUT_MINUTES ?? 15) * 60_000,
  });
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/scripts/demo-agent.ts')) {
  main().catch((e) => {
    console.error(`[agent] failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
