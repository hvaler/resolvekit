/**
 * The testable parts of `npm run demo:prepare` (see demo-prepare.ts): arguments, the standard case's order, the
 * buyer's instructions, dispute readiness, the checks a real agent run passes before it joins the agent case's
 * reserve, and the BINDINGS_JSON to paste. The run readers get their fetch / MeterMCP client from the caller; nothing
 * here prints a secret.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CreateCaptureOrder, Dispute } from '@resolvekit/paypal';
import type { CaseFile } from '../../web/src/domain/types.ts';
import { RUN_ID, type RunRecord } from '../src/agent/runs.ts';
import { parseBindingPools } from '../src/bindings.ts';
import type { MeterMcpClient, Receipt } from '../src/metermcp.ts';

export const DEFAULT_METERMCP_URL = 'https://resolvekit-metermcp.onrender.com/mcp';
export const DEFAULT_APP_URL = 'https://resolvekit-i3j2.onrender.com/';
export const STANDARD_CASE_ID = 'PP-R-TVH-10190665';
export const AGENT_CASE_ID = 'PP-R-MMC-10190702';
/** `--agent-count`: what the engine is asked, and the budget it may ask for, unless `--agent-goal` / `--agent-cap`. */
export const DEFAULT_AGENT_GOAL = 'Find the current quote for ACME-42 and whether there is any supplier risk.';
export const DEFAULT_AGENT_CAP = '2.00';
const GOAL_MAX = 300;
const CAP = /^\d{1,2}(\.\d{1,2})?$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,39}$/;
/** A PayPal merchant (payer) id, as seller.merchant_id on a dispute. */
const MERCHANT_ID = /^[A-Z0-9]{8,20}$/;

export interface PrepareOptions {
  /** (a) create, approve and capture the standard order. */
  standard: boolean;
  /** (b) run the demo agent against MeterMCP. */
  agent: boolean;
  /** (d) wait for the disputes on these captures (from this run or `--captures`). */
  waitDisputes: boolean;
  /** Captures of each case (several: a reserve of disputes for the same case). */
  captures: { standard?: string[]; agent?: string[] };
  /** (a) how many standard payments to create: each becomes one dispute of the case's reserve. */
  count: number;
  /** (b) how many agent sessions to run: each becomes one dispute of the agent case's reserve. */
  agentCount: number;
  /** (b) the engine's goal, cap and the tools whose first call fails on purpose (none by default). */
  agentGoal: string;
  agentCap: string;
  agentFailFirst: string[];
  /** Runs already made on the /agent page, taken into the reserve without a new run or payment (in this order). */
  agentRuns: string[];
  /** The seller's PayPal merchant id: the seller every agent-run dispute must have (`--seller`; needed with --agent-run). */
  seller: string | null;
  dryRun: boolean;
  meterUrl: string;
  appUrl: string;
  /** Minutes to wait for a buyer approval, and for each dispute to be ready. */
  approvalMinutes: number;
  disputeMinutes: number;
}

export const USAGE = `npm run demo:prepare -- [steps] [options]

Creates fresh REAL PayPal sandbox payments for the demo, with you (the sandbox buyer) in the loop, then waits for
the disputes you open and prints the BINDINGS_JSON to paste into Render.

Steps (default: all of them, in order)
  --standard                 (a) Orders v2 CAPTURE order for the standard case; approve it; it is captured
  --agent                    (b) the model-driven agent against MeterMCP (budget approval, its calls, close)
  --wait-disputes            (d)+(e) wait for the disputes on the captures, then print BINDINGS_JSON
  --count N                  (a) N standard payments (1-20): N disputes for the case's reserve
  --agent-count N            (b) N agent sessions (1-10), each approved by the buyer: N disputes for the agent case's reserve
  --agent-goal TEXT          (b) the agent's goal (default "${DEFAULT_AGENT_GOAL}")
  --agent-cap X.XX           (b) the budget it asks for, in USD (default ${DEFAULT_AGENT_CAP})
  --agent-fail-first T,...   (b) tools whose first call fails on purpose, not charged (default none)
  --agent-run RUN_ID         a run already made on the /agent page (repeatable): its capture joins the agent case's
                             reserve with no new run or payment, if it passes every check; then its dispute is awaited.
                             Needs BINDINGS_JSON (the current value: no capture is used twice), RESOLVEKIT_OPS_TOKEN
                             (hosted --app) and --seller
  --seller MERCHANT_ID       the seller's PayPal merchant id: each agent-run dispute must be this seller's
  --captures STD,AGENT       captures to wait for (either may be empty or "-"; several of a case joined with +), e.g. --captures 1AB...,
                             or --captures standard=1AB...+2CD...,agent=9XY...+8ZW...

Options
  --dry-run                  check the setup and show what would be created; creates nothing
  --metermcp URL             MeterMCP MCP endpoint (default ${DEFAULT_METERMCP_URL})
  --app URL                  where PayPal returns the buyer after approving (default ${DEFAULT_APP_URL}); also
                             where --agent-run reads its runs (a local server: from its data dir instead)
  --approval-minutes N       wait for each approval (default 20)
  --dispute-minutes N        wait for each dispute to be ready (default 45)

Env: PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (from .env; sandbox) · METERMCP_DEMO_CODE (the hosted MeterMCP needs
it to open a budget) · GEMINI_API_KEY / GROQ_API_KEY (the agent's model) · RESOLVEKIT_OPS_TOKEN · BINDINGS_JSON.
Nothing secret is printed.`;

/** Parse argv (without node and the script). Returns the options or an error message. */
export function parseArgs(argv: readonly string[]): PrepareOptions | { error: string } {
  const o: PrepareOptions = {
    standard: false,
    agent: false,
    waitDisputes: false,
    captures: {},
    count: 1,
    agentCount: 1,
    agentGoal: DEFAULT_AGENT_GOAL,
    agentCap: DEFAULT_AGENT_CAP,
    agentFailFirst: [],
    agentRuns: [],
    seller: null,
    dryRun: false,
    meterUrl: DEFAULT_METERMCP_URL,
    appUrl: DEFAULT_APP_URL,
    approvalMinutes: 20,
    disputeMinutes: 45,
  };
  const value = (i: number, flag: string): string | { error: string } => {
    const v = argv[i + 1];
    return v === undefined || v.startsWith('--') ? { error: `${flag} needs a value` } : v;
  };
  /** The engine flags given, which need the agent step. */
  const engineFlags: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '--agent-goal':
      case '--agent-cap':
      case '--agent-fail-first':
      case '--agent-run':
      case '--seller': {
        const v = value(i, a);
        if (typeof v !== 'string') return v;
        i++;
        if (a === '--agent-goal') {
          const g = v.trim();
          if (!g || [...g].length > GOAL_MAX) return { error: `--agent-goal must be 1 to ${GOAL_MAX} characters` };
          o.agentGoal = g;
        } else if (a === '--agent-cap') {
          if (!CAP.test(v) || Number(v) <= 0) return { error: '--agent-cap must be an amount in USD, e.g. 2.00' };
          o.agentCap = v;
        } else if (a === '--agent-fail-first') {
          const tools = v.split(',').map((t) => t.trim());
          if (tools.some((t) => !TOOL_NAME.test(t))) return { error: '--agent-fail-first must be tool names joined with commas, e.g. deep_report,bulk_export' };
          o.agentFailFirst = tools;
        } else if (a === '--agent-run') {
          if (!RUN_ID.test(v)) return { error: `--agent-run takes a run id (run-<32 hex>), not ${JSON.stringify(v.slice(0, 80))}` };
          o.agentRuns.push(v);
        } else {
          if (!MERCHANT_ID.test(v)) return { error: '--seller must be a PayPal merchant id (seller.merchant_id on its disputes)' };
          o.seller = v;
        }
        if (a === '--agent-goal' || a === '--agent-cap' || a === '--agent-fail-first') engineFlags.push(a);
        break;
      }
      case '--standard':
        o.standard = true;
        break;
      case '--agent':
        o.agent = true;
        break;
      case '--wait-disputes':
        o.waitDisputes = true;
        break;
      case '--dry-run':
        o.dryRun = true;
        break;
      case '--count':
      case '--agent-count': {
        const v = value(i, a);
        if (typeof v !== 'string') return v;
        i++;
        const n = Number(v);
        const max = a === '--count' ? 20 : 10;
        if (!Number.isInteger(n) || n < 1 || n > max) return { error: `${a} must be a whole number from 1 to ${max}` };
        if (a === '--count') o.count = n;
        else o.agentCount = n;
        break;
      }
      case '--captures':
      case '--metermcp':
      case '--app':
      case '--approval-minutes':
      case '--dispute-minutes': {
        const v = value(i, a);
        if (typeof v !== 'string') return v;
        i++;
        if (a === '--captures') {
          const c = parseCaptures(v);
          if ('error' in c) return c;
          o.captures = c;
        } else if (a === '--metermcp' || a === '--app') {
          if (!/^https?:\/\/\S+$/.test(v)) return { error: `${a} must be an http(s) URL` };
          if (a === '--metermcp') o.meterUrl = v;
          else o.appUrl = v;
        } else {
          const n = Number(v);
          if (!Number.isFinite(n) || n <= 0 || n > 240) return { error: `${a} must be a number of minutes (1-240)` };
          if (a === '--approval-minutes') o.approvalMinutes = n;
          else o.disputeMinutes = n;
        }
        break;
      }
      case '--help':
      case '-h':
        return { error: USAGE };
      default:
        return { error: `unknown argument ${a}\n\n${USAGE}` };
    }
  }
  // --agent-run on its own: take those runs and wait for their disputes (it creates nothing, so it is not "all steps").
  // Its entries are always waited for here: a resume with --captures would drop the run and session they carry.
  if (o.agentRuns.length) {
    if (!o.standard && !o.agent && !o.waitDisputes && (o.captures.standard || o.captures.agent)) return { error: '--captures goes with --wait-disputes' };
    o.waitDisputes = true;
    if (!o.seller) return { error: '--agent-run needs --seller <merchant id>: each run’s dispute must be the seller’s' };
  }
  if (!o.standard && !o.agent && !o.waitDisputes) {
    if (o.captures.standard || o.captures.agent) return { error: '--captures goes with --wait-disputes' };
    o.standard = o.agent = o.waitDisputes = true;
  }
  if (o.count > 1 && !o.standard) return { error: '--count goes with the standard step (--standard, or all steps)' };
  if (o.agentCount > 1 && !o.agent) return { error: '--agent-count goes with the agent step (--agent, or all steps)' };
  if (engineFlags.length && !o.agent) return { error: `${engineFlags[0]} goes with the agent step (--agent, or all steps)` };
  if (o.waitDisputes && !o.standard && !o.agent && !o.agentRuns.length && !o.captures.standard && !o.captures.agent) {
    return { error: '--wait-disputes on its own needs --captures STD,AGENT' };
  }
  return o;
}

const CAPTURE_ID = /^[A-Z0-9]{8,32}$/;

/** "STD,AGENT" (either empty or "-") or "standard=STD,agent=AGENT". */
export function parseCaptures(v: string): { standard?: string[]; agent?: string[] } | { error: string } {
  const parts = v.split(',').map((p) => p.trim());
  if (parts.length > 2) return { error: '--captures takes at most two groups: STD[+STD…],AGENT' };
  const out: { standard?: string[]; agent?: string[] } = {};
  const seen = new Set<string>();
  for (const [i, p] of parts.entries()) {
    if (!p || p === '-') continue;
    const m = /^(standard|agent)=(.+)$/.exec(p);
    const which = m ? (m[1] as 'standard' | 'agent') : i === 0 ? 'standard' : 'agent';
    const ids = (m ? m[2]! : p).split('+').map((x) => x.trim());
    for (const id of ids) if (!CAPTURE_ID.test(id)) return { error: `not a PayPal capture id: ${id}` };
    for (const id of ids) {
      if (seen.has(id)) return { error: 'a capture is listed twice' };
      seen.add(id);
    }
    if (out[which]) return { error: `--captures names the ${which} case twice: join its captures with +` };
    out[which] = ids;
  }
  if (!out.standard && !out.agent) return { error: '--captures names no capture' };
  return out;
}

/**
 * The standard case's order, from its own fixture: exactly the amount and the item of order #10482 (one
 * "Linen tote, natural", 7.00 USD, physical goods shipped to the buyer's PayPal address).
 */
export function standardOrder(c: CaseFile, appUrl: string): CreateCaptureOrder {
  const order = c.evidence.find((e) => e.id === 'E1');
  const lines = order?.body.kind === 'lines' ? order.body.lines.map((l) => l.text) : [];
  let item: { qty: string; name: string; value: string; currency: string } | null = null;
  for (const t of lines) {
    const m = /^(\d+) × (.+?) · (\d+\.\d{2}) ([A-Z]{3})$/.exec(t);
    if (m) item = { qty: m[1]!, name: m[2]!, value: m[3]!, currency: m[4]! };
  }
  if (!item) throw new Error('the standard case has no order line "N × item · amount CUR"');
  if (item.value !== c.summary.amount || item.currency !== c.summary.currency) {
    throw new Error(`the order line (${item.value} ${item.currency}) is not the case amount (${c.summary.amount} ${c.summary.currency})`);
  }
  const unit = (Number(item.value) / Number(item.qty)).toFixed(2);
  const amount = { currency_code: item.currency, value: item.value };
  const base = appUrl.endsWith('/') ? appUrl : `${appUrl}/`;
  return {
    amount,
    items: [{ name: item.name, quantity: item.qty, unit_amount: { currency_code: item.currency, value: unit }, category: 'PHYSICAL_GOODS' }],
    description: 'ResolveKit demo order (synthetic test purchase)',
    returnUrl: `${base}?demo=approved`,
    cancelUrl: `${base}?demo=cancelled`,
    shipping: 'GET_FROM_FILE',
  };
}

/** What the sandbox buyer does to open the dispute on a capture. */
export function buyerInstructions(which: 'standard' | 'agent', captureId: string, amount: string): string {
  const what = which === 'standard' ? `the 7.00 USD "Linen tote, natural" payment` : `the ${amount} MeterMCP agent session payment`;
  const lines = [
    `Open the ${which === 'standard' ? 'standard' : 'agent'} dispute (as the sandbox BUYER, personal account):`,
    `  1. Log in at https://www.sandbox.paypal.com/ with the sandbox personal (buyer) account.`,
    `  2. Activity → open ${what} (capture ${captureId}) → "Report a problem"`,
    `     (or https://www.sandbox.paypal.com/resolutioncenter → "Report a problem" → pick that payment).`,
    `  3. Problem: "I didn't receive an item I bought" (not received).`,
    which === 'standard'
      ? `  4. Item type: "Physical product". Describe it in your own words (e.g. "The parcel never arrived.").`
      : `  4. Item type: "Service". Reason / description: "I didn't receive any confirmation of the service".`,
    `  5. Submit. PayPal takes ~5 minutes to list a new dispute, then a few more to open it (UNDER_REVIEW →`,
    `     WAITING_FOR_SELLER_RESPONSE). This script keeps polling.`,
  ];
  return lines.join('\n');
}

export type DisputeReadiness = { state: 'missing' } | { state: 'processing' | 'ready'; disputeId: string; status: string };

/** Whether the dispute on a capture exists yet and waits for the seller (what the demo needs). */
export function disputeReadiness(d: Dispute | null): DisputeReadiness {
  if (!d?.dispute_id) return { state: 'missing' };
  const status = d.status ?? 'UNKNOWN';
  return { state: status === 'WAITING_FOR_SELLER_RESPONSE' ? 'ready' : 'processing', disputeId: d.dispute_id, status };
}

// ---------------------------------------------------------------------------------------------
// The agent case's reserve: real runs, each checked against the receipt MeterMCP holds for it.

/** Every capture the current BINDINGS_JSON binds: each case's active one and its reserve (upper case). */
export function boundCaptures(raw: unknown): Set<string> {
  const { bindings, reserve } = parseBindingPools(raw);
  const out = new Set<string>();
  for (const b of [...Object.values(bindings), ...Object.values(reserve).flat()]) if (b.capture) out.add(b.capture.toUpperCase());
  return out;
}

const cents = (v: string | null | undefined) => (typeof v === 'string' && /^\d+(\.\d{1,2})?$/.test(v) ? Math.round(Number(v) * 100) : 0);

/** The dispute's seller is the configured one; a dispute that names no seller fails. */
export function disputeSellerProblems(d: Pick<Dispute, 'disputed_transactions'>, expected: string): string[] {
  const seller = d.disputed_transactions?.[0]?.seller?.merchant_id ?? null;
  return sellerProblems(seller, expected);
}

function sellerProblems(seller: string | null, expected: string): string[] {
  if (!seller) return ['PayPal reports no seller on the dispute'];
  return seller === expected ? [] : [`the dispute's seller ${seller} is not the configured seller ${expected}`];
}

/**
 * Why a run cannot join the agent case's reserve (empty: it can). Read only: the run record and the receipt that
 * MeterMCP's admin route returned for its session. `used`: every capture already bound or taken in this command.
 * `seller`: once the capture's dispute is known, its seller and the configured one; null before.
 */
export function agentReserveProblems(run: RunRecord, receipt: Receipt, used: Set<string>, seller: { expected: string; dispute: string | null } | null): string[] {
  const out: string[] = [];
  if (run.state === 'running' || run.state === 'awaiting_approval') out.push(`the run has not ended yet (${run.state})`);
  const charged = receipt.calls.filter((c) => c.status === 'OK' && cents(c.price) > 0);
  if (charged.length === 0) out.push('no call completed and charged: the receipt has no OK paid call');
  const s = receipt.settlement;
  if (run.settlement !== 'captured' || s.status !== 'captured' || s.capture_status !== 'COMPLETED') {
    out.push(`the settlement is ${s.status} (run: ${run.settlement}) and PayPal's capture is ${s.capture_status ?? 'none'}, not COMPLETED: a pending capture does not count yet`);
  }
  if (run.sessionId !== receipt.session.id) out.push(`the run's MeterMCP session ${run.sessionId ?? '(none)'} is not the receipt's ${receipt.session.id}`);
  if (run.captureId !== s.capture_id) out.push(`the run's capture ${run.captureId ?? '(none)'} is not the receipt's capture ${s.capture_id ?? '(none)'}`);
  if (run.receiptSha256 !== receipt.receipt_sha256) out.push(`the run's receipt sha256 ${run.receiptSha256 ?? '(none)'} is not the receipt's ${receipt.receipt_sha256}`);
  if (seller) out.push(...sellerProblems(seller.dispute, seller.expected));
  const capture = s.capture_id ?? run.captureId;
  if (capture && [...used].some((u) => u.toUpperCase() === capture.toUpperCase())) out.push(`capture ${capture} is already used by another reserve entry`);
  return out;
}

/** A run that ended on a limit or an interruption is never presented as a goal achieved. */
export function agentReserveNote(run: RunRecord): string | null {
  return run.state === 'stopped' || run.state === 'interrupted' ? `ended on ${run.stopReason ?? run.state}; not a goal achieved` : null;
}

/** A run read for the reserve: its record and the receipt MeterMCP's admin route has for its session (null: unread). */
export interface AgentRunRead {
  run: RunRecord;
  receipt: Receipt | null;
  receiptError?: string | null;
}
export type ReadAgentRun = (runId: string) => Promise<AgentRunRead>;

/**
 * Reads runs from the hosted ResolveKit: `GET /api/ops/agent-run/<id>` with the ops token. The server reads the
 * receipt through MeterMCP's admin route (private network); nothing here talks to MeterMCP or runs anything.
 */
export function opsRunReader(o: { appUrl: string; token: string; fetch?: typeof fetch; timeoutMs?: number }): ReadAgentRun {
  const base = o.appUrl.replace(/\/+$/, '');
  const f = o.fetch ?? ((...a) => globalThis.fetch(...a));
  return async (id) => {
    if (!RUN_ID.test(id)) throw new Error(`${JSON.stringify(id.slice(0, 80))} is not a run id`);
    const r = await f(`${base}/api/ops/agent-run/${id}`, { method: 'GET', headers: { authorization: `Bearer ${o.token}` }, signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) });
    if (r.status === 401) throw new Error('ResolveKit answered 401: RESOLVEKIT_OPS_TOKEN is not the service’s');
    if (r.status === 404) throw new Error('ResolveKit answered 404: no such run (deleted after 30 days unless kept), or the ops route is off');
    if (!r.ok) throw new Error(`ResolveKit answered ${r.status}`);
    const body = (await r.json()) as AgentRunRead;
    if (body?.run?.id !== id) throw new Error('ResolveKit answered with another run');
    return { run: body.run, receipt: body.receipt ?? null, receiptError: body.receiptError ?? null };
  };
}

/** Reads runs of a server on this machine: `<data dir>/agent-runs/<id>.json`, the receipt from MeterMCP's admin route. */
export function localRunReader(o: { dir: string; meter: Pick<MeterMcpClient, 'receipt'> }): ReadAgentRun {
  return async (id) => {
    if (!RUN_ID.test(id)) throw new Error(`${JSON.stringify(id.slice(0, 80))} is not a run id`);
    let run: RunRecord;
    try {
      run = JSON.parse(readFileSync(join(o.dir, `${id}.json`), 'utf8')) as RunRecord;
    } catch {
      throw new Error(`no run ${id} in ${o.dir}`);
    }
    if (run?.id !== id) throw new Error(`${id}.json holds another run`);
    if (!run.sessionId) return { run, receipt: null, receiptError: 'the run has no MeterMCP session' };
    try {
      return { run, receipt: await o.meter.receipt(run.sessionId), receiptError: null };
    } catch (e) {
      return { run, receipt: null, receiptError: e instanceof Error ? e.message : String(e) };
    }
  };
}

/** One agent entry of the reserve, pending its dispute: the capture, the run and session it comes from. */
export interface AgentEntry {
  capture: string;
  run: string;
  session: string;
  /** What the buyer disputes, e.g. "0.45 USD". */
  amount: string;
  note: string | null;
}
export interface Refusal {
  run: string;
  problems: string[];
}

function entryOf(run: RunRecord, receipt: Receipt): AgentEntry {
  return { capture: receipt.settlement.capture_id!, run: run.id, session: receipt.session.id, amount: `${receipt.totals.charged} ${receipt.session.currency}`, note: agentReserveNote(run) };
}

/** An accepted run's capture joins `used` at once, so nothing later in the same command can take it again. */
function take(run: RunRecord, receipt: Receipt | null, receiptError: string | null | undefined, used: Set<string>): AgentEntry | Refusal {
  if (!receipt) return { run: run.id, problems: [`the receipt could not be read (${receiptError ?? 'no receipt'})`] };
  const problems = agentReserveProblems(run, receipt, used, null);
  if (problems.length) return { run: run.id, problems };
  used.add(receipt.settlement.capture_id!.toUpperCase());
  return entryOf(run, receipt);
}

/**
 * `--agent-run`: reserve entries from runs already made. Each run is only read (its record and receipt), never run
 * again, and nothing is paid. A run listed twice is refused the second time; a capture in `used` is refused.
 */
export async function reserveFromRuns(ids: readonly string[], o: { read: ReadAgentRun; used: Set<string> }): Promise<{ entries: AgentEntry[]; refused: Refusal[] }> {
  const entries: AgentEntry[] = [];
  const refused: Refusal[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      refused.push({ run: id, problems: ['this run is listed twice in this command; it is taken once'] });
      continue;
    }
    seen.add(id);
    let r: AgentRunRead;
    try {
      r = await o.read(id);
    } catch (e) {
      refused.push({ run: id, problems: [e instanceof Error ? e.message : String(e)] });
      continue;
    }
    const got = take(r.run, r.receipt, r.receiptError, o.used);
    if ('problems' in got) refused.push(got);
    else entries.push(got);
  }
  return { entries, refused };
}

/** One engine run made by this command: its record (RunRecord-shaped) and the receipt it read at the end. */
export interface EngineRun {
  record: RunRecord;
  receipt: Receipt | null;
}

/**
 * Step (b) and `--agent-run`: `--agent-count` engine runs, one after another (a refused one stops the loop, as each
 * needs the buyer), then the runs already made, which are only read. Every entry passes {@link agentReserveProblems}.
 */
export async function agentEntries(
  o: Pick<PrepareOptions, 'agent' | 'agentCount' | 'agentRuns'>,
  deps: { runEngine: (k: number) => Promise<EngineRun | null>; read: ReadAgentRun | null; used: Set<string>; say: (line: string) => void },
): Promise<{ entries: AgentEntry[]; refused: Refusal[] }> {
  const entries: AgentEntry[] = [];
  const refused: Refusal[] = [];
  if (o.agent) {
    for (let k = 1; k <= o.agentCount; k++) {
      if (o.agentCount > 1) deps.say(`agent session ${k} of ${o.agentCount}`);
      const r = await deps.runEngine(k);
      const got: AgentEntry | Refusal = r ? take(r.record, r.receipt, 'the run ended without one', deps.used) : { run: '(engine run)', problems: ['the run did not start'] };
      if ('problems' in got) {
        refused.push(got);
        deps.say(`agent session ${k} cannot join the reserve: ${got.problems.join('; ')}. Stopping the agent sessions here (${entries.length} made)${k < o.agentCount ? `; run the rest later with --agent --agent-count ${o.agentCount - entries.length}` : ''}.`);
        break;
      }
      entries.push(got);
    }
  }
  if (o.agentRuns.length) {
    if (!deps.read) throw new Error('--agent-run needs a way to read runs');
    const r = await reserveFromRuns(o.agentRuns, { read: deps.read, used: deps.used });
    entries.push(...r.entries);
    refused.push(...r.refused);
  }
  return { entries, refused };
}

/** One bound case: the dispute and the capture it must be about (the server verifies both before any send). */
export interface FoundDispute {
  dispute: string;
  capture: string;
  /** Agent entries: the run and the MeterMCP session the capture comes from (kept in BINDINGS_JSON, not verified by it). */
  run?: string;
  session?: string;
}

/**
 * The BINDINGS_JSON value for Render, with what is known; missing cases are said, not invented. Each case is bound to
 * its dispute AND the capture this script created, so the server can verify the dispute is that payment.
 */
export function bindingsJson(found: { standard?: FoundDispute | FoundDispute[]; agent?: FoundDispute | FoundDispute[] }): { json: string; missing: string[] } {
  const b: Record<string, FoundDispute | FoundDispute[]> = {};
  const missing: string[] = [];
  // Several disputes of a case: its list, first active and the rest in reserve (bindings.ts); one stays an object.
  for (const [caseId, f] of [[STANDARD_CASE_ID, found.standard], [AGENT_CASE_ID, found.agent]] as const) {
    const list = (Array.isArray(f) ? f : f ? [f] : []).map((d) => ({ dispute: d.dispute, capture: d.capture, ...(d.run ? { run: d.run } : {}), ...(d.session ? { session: d.session } : {}) }));
    if (list.length > 1) b[caseId] = list;
    else if (list.length === 1) b[caseId] = list[0]!;
    else missing.push(caseId);
  }
  return { json: JSON.stringify(b), missing };
}
