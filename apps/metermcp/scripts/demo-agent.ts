/**
 * `npm run demo-agent` — the buying agent on the command line: the same engine as the /agent page
 * (packages/agent: a model decides each action, code validates it, MeterMCP meters the money), against MeterMCP's
 * public /mcp like any external MCP client. It prints each step as the page shows it, the model usage, and the
 * settlement as the session's receipt states it.
 *
 *   npm run demo-agent -- --goal "Quote for ACME-42" [--cap 2.00] [--fail-first deep_report,bulk_export] [--no-wait] [--out run.json]
 *
 * --no-wait stops right after printing the approval URL and closes the session: MeterMCP cancels a budget that was
 * never approved, so nothing stays authorized or charged. Ctrl+C does the same at any point (the run ends interrupted
 * and is settled). --out writes the run as a RunRecord-shaped JSON.
 *
 * Env (.env): METERMCP_URL (http://127.0.0.1:8790/mcp) · METERMCP_DEMO_CODE (sent as the x-demo-code header: the
 * hosted MeterMCP needs it to open a budget) · GEMINI_API_KEY / GROQ_API_KEY · AGENT_* run limits. Keys and the
 * demo code are never printed.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  agentModelsFromEnv,
  connectMeter,
  formatStep,
  limitsFromEnv,
  runAgent,
  type AgentModel,
  type MeterConnection,
  type RunInput,
  type RunLimits,
  type RunResult,
} from '@resolvekit/agent';
import type { RunRecord } from '../../server/src/agent/runs.ts';

export const CLI_DEFAULT_CAP = '2.00';
const GOAL_MAX = 300;
const CAP = /^\d{1,2}(\.\d{1,2})?$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,39}$/;
/** MeterMCP's free tools that only code calls (the model is never offered them): not listed as the agent's tools. */
const CODE_ONLY = new Set(['open_budget', 'close_session', 'get_receipt']);

export const USAGE = `Usage: npm run demo-agent -- --goal "<text>" [--cap X.XX] [--fail-first tool,...] [--no-wait] [--out file.json]

  --goal TEXT              what the agent should find (required, at most ${GOAL_MAX} characters)
  --cap X.XX               the budget it asks the buyer to approve, in USD (default ${CLI_DEFAULT_CAP})
  --fail-first T,...       tools whose first call fails on purpose for this run, never charged (default none)
  --no-wait                stop after printing the approval URL; the session is closed, nothing stays authorized
  --out FILE.json          write the run as a RunRecord-shaped JSON

Env: METERMCP_URL (default http://127.0.0.1:8790/mcp) · METERMCP_DEMO_CODE (hosted MeterMCP) · GEMINI_API_KEY /
GROQ_API_KEY · AGENT_* run limits.`;

export interface CliOptions {
  goal: string;
  cap: string;
  failFirst: string[];
  noWait: boolean;
  out: string | null;
}

/** Parse argv (without node and the script). The options, or an error that ends with the usage. */
export function parseCliArgs(argv: readonly string[]): CliOptions | { error: string } {
  const o: CliOptions = { goal: '', cap: CLI_DEFAULT_CAP, failFirst: [], noWait: false, out: null };
  const bad = (why: string) => ({ error: `${why}\n\n${USAGE}` });
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--no-wait') {
      o.noWait = true;
      continue;
    }
    if (a === '--help' || a === '-h') return { error: USAGE };
    if (a !== '--goal' && a !== '--cap' && a !== '--fail-first' && a !== '--out') return bad(`unknown argument ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) return bad(`${a} needs a value`);
    i++;
    if (a === '--goal') {
      const g = v.trim();
      if (!g || [...g].length > GOAL_MAX) return bad(`--goal must be 1 to ${GOAL_MAX} characters`);
      o.goal = g;
    } else if (a === '--cap') {
      if (!CAP.test(v) || Number(v) <= 0) return bad('--cap must be an amount in USD, e.g. 2.00');
      o.cap = v;
    } else if (a === '--fail-first') {
      const tools = v.split(',').map((t) => t.trim());
      if (tools.some((t) => !TOOL_NAME.test(t))) return bad('--fail-first must be tool names joined with commas, e.g. deep_report,bulk_export');
      o.failFirst = tools;
    } else o.out = v;
  }
  if (!o.goal) return bad('--goal is required');
  return o;
}

/** METERMCP_URL as the MCP endpoint: a bare base (as the server's METERMCP_URL) gets /mcp. */
export function mcpEndpoint(url: string): string {
  const u = new URL(/^https?:\/\//.test(url) ? url : `http://${url}`);
  const path = u.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/mcp')) u.pathname = `${path}/mcp`;
  return u.toString();
}

export const isLocal = (url: string) => /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url);

/** The run as the server's RunRecord, so a CLI run and a page run are read the same way. Amounts only from a receipt. */
export function toRunRecord(r: RunResult, input: RunInput, meta: { approvalUrl: string | null; startedAt: Date; finishedAt: Date; id?: string }): RunRecord {
  const s = r.settlement !== 'unverified' && r.receipt ? (r.receipt.settlement as Record<string, unknown> | undefined) : undefined;
  const amount = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    id: meta.id ?? `run-${randomBytes(16).toString('hex')}`,
    createdAt: meta.startedAt.toISOString(),
    updatedAt: meta.finishedAt.toISOString(),
    finishedAt: meta.finishedAt.toISOString(),
    by: { personId: 'cli', label: 'command line', workspaceId: 'cli' },
    goal: input.goal,
    cap: input.cap,
    failFirst: [...input.failFirst],
    state: r.outcome,
    stopReason: r.stopReason,
    answer: r.answer,
    steps: r.steps,
    approvalUrl: meta.approvalUrl,
    provider: r.provider,
    model: r.model,
    usage: { ...r.usage },
    sessionId: r.sessionId,
    orderId: r.orderId,
    captureId: r.captureId,
    settlement: r.settlement,
    receiptSha256: r.receiptSha256,
    captured: amount(s?.captured),
    released: amount(s?.released),
    kept: false,
  };
}

function usageLine(r: RunResult): string {
  if (!r.provider) return 'model: none answered';
  const u = r.usage;
  return `model: ${r.provider}/${r.model} · ${u.modelCalls} model call${u.modelCalls === 1 ? '' : 's'} · tokens in ${u.inputTokens} / out ${u.outputTokens}${u.reported ? '' : ' (some estimated)'} · not paid from the PayPal budget`;
}

function settlementLine(r: RunResult): string {
  const rc = r.receipt;
  if (!rc) return `settlement: ${r.settlement}${r.settlement === 'none' ? ' (no budget was opened)' : ' (no receipt could be read)'}`;
  const s = rc.settlement ?? {};
  const t = rc.totals ?? {};
  return [
    `settlement (from the receipt): ${s.status}`,
    `capture ${s.capture_id ?? '—'} (${s.capture_status ?? '—'})`,
    `captured ${s.captured ?? '—'} · released ${s.released ?? '—'} of cap ${t.cap ?? '—'} ${rc.session?.currency ?? 'USD'}`,
    `${t.ok ?? 0} OK / ${t.failed ?? 0} failed calls`,
    `receipt sha256 ${rc.receipt_sha256 ?? '—'}`,
  ].join(' · ');
}

export interface CliRunOptions {
  input: RunInput;
  /** MeterMCP's MCP endpoint. */
  url: string;
  /** Sent as x-demo-code (the hosted MeterMCP needs it to open a budget). Never printed. */
  demoCode?: string | undefined;
  noWait?: boolean;
  models: { primary: AgentModel; fallback: AgentModel | null };
  limits?: RunLimits;
  /** Aborting it ends the run interrupted; the session is still closed and its receipt read. */
  signal?: AbortSignal;
  say?: (line: string) => void;
  /** Tests: a fake MeterMCP. */
  connect?: (o: { url: string; headers?: Record<string, string> }) => Promise<MeterConnection>;
}

/** One run of the engine, printed as it goes. Whatever ends it, the engine closes the session and reads its receipt. */
export async function runCli(o: CliRunOptions): Promise<{ result: RunResult; record: RunRecord }> {
  const say = o.say ?? ((s: string) => console.log(`[agent] ${s}`));
  const controller = new AbortController();
  o.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  const startedAt = new Date();
  let approvalUrl: string | null = null;
  const connection = await (o.connect ?? connectMeter)({ url: o.url, ...(o.demoCode ? { headers: { 'x-demo-code': o.demoCode } } : {}) });
  try {
    const tools = await connection.listTools();
    say(`connected to ${o.url} · tools: ${tools.filter((t) => !CODE_ONLY.has(t.name)).map((t) => `${t.name} (${t.price ? `${t.price} USD` : 'free'})`).join(', ')}`);
    say(`goal: ${o.input.goal} · cap ${o.input.cap} USD${o.input.failFirst.length ? ` · first call fails on purpose: ${o.input.failFirst.join(', ')}` : ''}`);
    // The engine lists the tools itself: the same answer, not a second request.
    const meter: MeterConnection = { listTools: async () => tools, call: (n, a) => connection.call(n, a), close: () => connection.close() };
    const result = await runAgent({
      input: o.input,
      meter,
      models: o.models,
      ...(o.limits ? { limits: o.limits } : {}),
      signal: controller.signal,
      onEvent: (e) => {
        // A paid call is announced before it runs: the first one may wait for the buyer's approval.
        if (e.type === 'step_started' && e.step.kind === 'call') say(formatStep(e.step));
        else if (e.type === 'step') say(formatStep(e.step));
        else if (e.type === 'awaiting_approval') {
          approvalUrl = e.approvalUrl;
          say(`budget of ${e.cap} USD asked for · session ${e.sessionId} · PayPal order ${e.orderId}`);
          say(`Approve the budget in PayPal (sandbox buyer account):\n\n  ${e.approvalUrl}\n`);
          if (o.noWait) {
            say('--no-wait: stopping here; the session is closed now, so nothing stays authorized or charged.');
            controller.abort();
          }
        } else if (e.type === 'approved') say(`budget approved · cap ${e.cap} USD`);
      },
    });
    say(`outcome: ${result.outcome}${result.stopReason ? ` (${result.stopReason})` : ''}${result.answer ? ` · answer: ${result.answer}` : ''}`);
    say(usageLine(result));
    say(settlementLine(result));
    return { result, record: toRunRecord(result, o.input, { approvalUrl, startedAt, finishedAt: new Date() }) };
  } finally {
    await connection.close();
  }
}

async function main() {
  const o = parseCliArgs(process.argv.slice(2));
  if ('error' in o) {
    console.error(o.error);
    process.exitCode = 2;
    return;
  }
  const models = agentModelsFromEnv(process.env);
  if (!models) {
    console.error('[agent] no model key: set GEMINI_API_KEY or GROQ_API_KEY (.env)');
    process.exitCode = 2;
    return;
  }
  const url = mcpEndpoint(process.env.METERMCP_URL ?? 'http://127.0.0.1:8790/mcp');
  const demoCode = process.env.METERMCP_DEMO_CODE?.trim() || undefined;
  if (!isLocal(url) && !demoCode) console.log('[agent] METERMCP_DEMO_CODE is not set: the hosted MeterMCP will refuse to open a budget');
  // Ctrl+C ends the run interrupted, and it is still settled (session closed, receipt read).
  const stop = new AbortController();
  process.once('SIGINT', () => {
    console.log('[agent] interrupted: closing the session');
    stop.abort();
  });
  const { record } = await runCli({ input: { goal: o.goal, cap: o.cap, failFirst: o.failFirst }, url, demoCode, noWait: o.noWait, models, limits: limitsFromEnv(process.env), signal: stop.signal });
  if (o.out) {
    writeFileSync(o.out, JSON.stringify(record, null, 2));
    console.log(`[agent] run ${record.id} written to ${o.out}`);
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/scripts/demo-agent.ts')) {
  main().catch((e) => {
    console.error(`[agent] failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
