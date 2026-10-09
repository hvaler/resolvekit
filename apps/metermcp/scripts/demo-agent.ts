/**
 * Demo MCP client for MeterMCP (scripted, no LLM): connects over Streamable HTTP, hits payment_required, prints the
 * approval URL for the human, polls get_balance until PayPal shows the budget approved, makes the paid calls
 * (retrying a failed one once) and closes the session, which settles it in PayPal.
 *
 *   npm run demo-agent --workspace @resolvekit/metermcp            # full run (waits for approval)
 *   npm run demo-agent --workspace @resolvekit/metermcp -- --no-wait   # stop after printing the approval URL
 *
 * Env: METERMCP_URL (http://127.0.0.1:8790/mcp) · APPROVAL_TIMEOUT_MINUTES (15).
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
const say = (s: string) => console.log(`[agent] ${s}`);

async function main() {
  const url = process.env.METERMCP_URL ?? 'http://127.0.0.1:8790/mcp';
  const noWait = process.argv.includes('--no-wait');
  const timeoutMs = Number(process.env.APPROVAL_TIMEOUT_MINUTES ?? 15) * 60_000;

  const client = new Client({ name: 'metermcp-demo-agent', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
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
      console.log(`\n  Approve the budget in PayPal (sandbox buyer account):\n  ${r.body.approval_url}\n`);
      if (noWait) {
        say('--no-wait: stopping here. The unapproved order expires on its own; nothing is authorized or charged.');
        return;
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
          return;
        }
        await sleep(3000);
      }
      r = await callTool(first);
    } else if (r.isError) {
      say(`error: ${JSON.stringify(r.body)}`);
      return;
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
    if (rc.settlement?.capture_id) console.log(`\n  PayPal capture id (the buyer disputes this one): ${rc.settlement.capture_id}\n`);
  } finally {
    await client.close();
  }
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/').replace(/^\//, '')}` || process.argv[1]?.endsWith('demo-agent.ts')) {
  main().catch((e) => {
    console.error(`[agent] failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
