/**
 * The pure parts of `npm run demo:prepare` (see demo-prepare.ts): arguments, the standard case's order, the buyer's
 * instructions, dispute readiness, the agent receipt check and the BINDINGS_JSON to paste. No network, no secrets.
 */
import type { CreateCaptureOrder, Dispute } from '@resolvekit/paypal';
import type { CaseFile } from '../../web/src/domain/types.ts';

export const DEFAULT_METERMCP_URL = 'https://resolvekit-metermcp.onrender.com/mcp';
export const DEFAULT_APP_URL = 'https://resolvekit-i3j2.onrender.com/';
export const STANDARD_CASE_ID = 'PP-R-TVH-10190665';
export const AGENT_CASE_ID = 'PP-R-MMC-10190702';

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
  --agent                    (b) the demo agent against MeterMCP (budget approval, 4 calls, one fails, close)
  --wait-disputes            (d)+(e) wait for the disputes on the captures, then print BINDINGS_JSON
  --count N                  (a) N standard payments (1-20): N disputes for the case's reserve
  --agent-count N            (b) N agent sessions (1-10), each approved by the buyer: N disputes for the agent case's reserve
  --captures STD,AGENT       captures to wait for (either may be empty or "-"; several of a case joined with +), e.g. --captures 1AB...,
                             or --captures standard=1AB...+2CD...,agent=9XY...+8ZW...

Options
  --dry-run                  check the setup and show what would be created; creates nothing
  --metermcp URL             MeterMCP MCP endpoint (default ${DEFAULT_METERMCP_URL})
  --app URL                  where PayPal returns the buyer after approving (default ${DEFAULT_APP_URL})
  --approval-minutes N       wait for each approval (default 20)
  --dispute-minutes N        wait for each dispute to be ready (default 45)

Env: PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (from .env; sandbox) · METERMCP_DEMO_CODE (the hosted MeterMCP needs
it to open a budget; never printed).`;

/** Parse argv (without node and the script). Returns the options or an error message. */
export function parseArgs(argv: readonly string[]): PrepareOptions | { error: string } {
  const o: PrepareOptions = {
    standard: false,
    agent: false,
    waitDisputes: false,
    captures: {},
    count: 1,
    agentCount: 1,
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
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
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
  if (!o.standard && !o.agent && !o.waitDisputes) {
    if (o.captures.standard || o.captures.agent) return { error: '--captures goes with --wait-disputes' };
    o.standard = o.agent = o.waitDisputes = true;
  }
  if (o.count > 1 && !o.standard) return { error: '--count goes with the standard step (--standard, or all steps)' };
  if (o.agentCount > 1 && !o.agent) return { error: '--agent-count goes with the agent step (--agent, or all steps)' };
  if (o.waitDisputes && !o.standard && !o.agent && !o.captures.standard && !o.captures.agent) {
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

/** Problems with the agent receipt for the demo story (4 calls, exactly one failed and not charged, settled). */
export function agentReceiptProblems(r: Record<string, any> | null): string[] {
  if (!r) return ['no receipt (the run stopped before closing the session)'];
  const out: string[] = [];
  const calls: Array<{ status?: string }> = Array.isArray(r.calls) ? r.calls : [];
  if (calls.length !== 4) out.push(`${calls.length} calls, not 4`);
  const failed = calls.filter((c) => c.status === 'FAILED').length;
  if (failed !== 1) out.push(`${failed} failed calls, not 1 (is METERMCP_FAIL_FIRST=deep_report set on that MeterMCP?)`);
  if (r.settlement?.status !== 'captured' || !r.settlement?.capture_id) out.push(`settlement ${r.settlement?.status ?? 'missing'}, no capture`);
  return out;
}

/** One bound case: the dispute and the capture it must be about (the server verifies both before any send). */
export interface FoundDispute {
  dispute: string;
  capture: string;
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
    const list = (Array.isArray(f) ? f : f ? [f] : []).map((d) => ({ dispute: d.dispute, capture: d.capture }));
    if (list.length > 1) b[caseId] = list;
    else if (list.length === 1) b[caseId] = list[0]!;
    else missing.push(caseId);
  }
  return { json: JSON.stringify(b), missing };
}
