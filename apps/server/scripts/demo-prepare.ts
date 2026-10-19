/**
 * `npm run demo:prepare` — fresh REAL PayPal sandbox disputes for the demo, human in the loop:
 *
 *   (a) standard case: an Orders v2 CAPTURE order for exactly the standard case's order (1 × "Linen tote, natural",
 *       7.00 USD, PHYSICAL_GOODS); prints the approval URL, waits until the buyer approves, captures, prints the capture.
 *   (b) agent case: the model-driven agent engine (packages/agent, as `npm run demo-agent`) against MeterMCP (default:
 *       the HOSTED one, so the session lives in the hosted ledger and the hosted agent case shows the real receipt),
 *       with --agent-goal / --agent-cap / --agent-fail-first and METERMCP_DEMO_CODE from the environment. Or
 *       `--agent-run <run id>`: a run already made on the /agent page, only read (record + receipt), never run again
 *       and never paid again. Either way a run joins the reserve only if it passes agentReserveProblems.
 *   (c) prints what the sandbox buyer clicks to open each dispute.
 *   (d) polls PayPal until each dispute appears and reaches WAITING_FOR_SELLER_RESPONSE (with --seller, an agent
 *       dispute must be that seller's).
 *   (e) prints the BINDINGS_JSON to paste into Render: each case bound to { dispute, capture } (agent entries also name
 *       their session, and their run when it is a --agent-run one: an engine run's record is local, not on the
 *       server), so the server can verify, right before any send, that the dispute is about exactly that capture.
 *
 * Flags run steps separately or resume (see USAGE in demo-prepare-lib.ts); --dry-run creates nothing. PayPal
 * credentials, model keys and tokens come from .env (node --env-file-if-exists); nothing secret is printed.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PayPalClient, PayPalError, approvalUrl, orderCapture, type Dispute } from '@resolvekit/paypal';
import { standardCase } from '@resolvekit/cases';
import { agentModelsFromEnv, limitsFromEnv, type AgentModel } from '@resolvekit/agent';
import { isLocal, runCli } from '../../metermcp/scripts/demo-agent.ts';
import { MeterMcpClient, type Receipt } from '../src/metermcp.ts';
import {
  agentEntries,
  bindingsJson,
  boundCaptures,
  buyerInstructions,
  disputeReadiness,
  disputeSellerProblems,
  localRunReader,
  opsRunReader,
  parseArgs,
  standardOrder,
  type EngineRun,
  type PrepareOptions,
  type ReadAgentRun,
} from './demo-prepare-lib.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (s: string) => console.log(`[demo:prepare] ${s}`);
const rule = () => console.log('-'.repeat(100));
const why = (e: unknown) => (e instanceof PayPalError ? `${e.message}${e.debugId ? ` (debug id ${e.debugId})` : ''}` : e instanceof Error ? e.message : String(e));
const dataDir = process.env.RESOLVEKIT_DATA_DIR ?? fileURLToPath(new URL('../data/', import.meta.url));

async function standardStep(paypal: PayPalClient, o: PrepareOptions): Promise<string | null> {
  rule();
  say('(a) Standard case: Orders v2 CAPTURE order for the standard case’s order');
  const body = standardOrder(standardCase, o.appUrl);
  const tag = randomBytes(6).toString('hex');
  const order = await paypal.orders.createCapture(body, { requestId: `rk-demo-std-${tag}` });
  const url = approvalUrl(order);
  if (!url) throw new Error(`PayPal returned no approval link for order ${order.id}`);
  say(`order ${order.id} · ${body.items[0]!.quantity} × ${body.items[0]!.name} · ${body.amount.value} ${body.amount.currency_code} · ${body.items[0]!.category}`);
  console.log(`\n  Approve it in PayPal with the sandbox BUYER (personal) account:\n\n  ${url}\n`);
  const until = Date.now() + o.approvalMinutes * 60_000;
  for (;;) {
    const cur = await paypal.orders.get(order.id);
    if (cur.status === 'APPROVED') break;
    if (cur.status === 'COMPLETED') {
      const done = orderCapture(cur);
      if (done) return printCapture(done.id);
    }
    if (cur.status === 'VOIDED' || Date.now() > until) {
      say(`order ${order.id} not approved (${cur.status}); stopping. Run again with --standard.`);
      return null;
    }
    await sleep(4000);
  }
  say('approved by the buyer · capturing');
  const captured = await paypal.orders.capture(order.id, { requestId: `rk-demo-std-${tag}-capture` });
  const cap = orderCapture(captured);
  if (!cap) throw new Error(`order ${order.id} captured but PayPal returned no capture (status ${captured.status})`);
  return printCapture(cap.id, cap.status);
}

function printCapture(id: string, status?: string): string {
  console.log(`\n  Standard capture id: ${id}${status ? ` (${status})` : ''}\n`);
  return id;
}

/** (b) One run of the engine; its record is saved under the data dir so the run, session and capture stay linked. */
async function engineStep(o: PrepareOptions, models: { primary: AgentModel; fallback: AgentModel | null }): Promise<EngineRun> {
  rule();
  say(`(b) Agent case: the agent engine against MeterMCP at ${o.meterUrl}`);
  const demoCode = process.env.METERMCP_DEMO_CODE?.trim() || undefined;
  say(`demo code ${demoCode ? 'set (not shown)' : 'not set'} · approve the budget with the sandbox personal (BUYER) account, not the business (seller) one, when the URL appears`);
  const { result, record } = await runCli({
    input: { goal: o.agentGoal, cap: o.agentCap, failFirst: o.agentFailFirst },
    url: o.meterUrl,
    demoCode,
    models,
    limits: { ...limitsFromEnv(process.env), approvalTimeoutMs: o.approvalMinutes * 60_000 },
    say: (l) => console.log(`[agent] ${l}`),
  });
  const dir = join(dataDir, 'demo-prepare-runs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${record.id}.json`), JSON.stringify(record, null, 2));
  say(`run ${record.id} saved to ${join(dir, `${record.id}.json`)}`);
  if (result.captureId) console.log(`\n  Agent capture id: ${result.captureId}${result.sessionId ? ` (MeterMCP session ${result.sessionId})` : ''}\n`);
  // MeterMCP's get_receipt body, unchecked here: agentEntries refuses it unless receiptShapeProblems finds nothing.
  return { record, receipt: result.receipt as unknown as Receipt | null };
}

/** --agent-run: the hosted server's ops route, or a server on this machine (its data dir, MeterMCP's admin route). */
function runReader(o: PrepareOptions): ReadAgentRun {
  if (isLocal(o.appUrl)) {
    if (!isLocal(o.meterUrl)) throw new Error('--agent-run against a local server reads receipts from a local MeterMCP: pass --metermcp http://127.0.0.1:8790/mcp');
    const base = o.meterUrl.replace(/\/mcp\/?$/, '');
    const tokenFile = process.env.METERMCP_TOKEN_FILE ?? fileURLToPath(new URL('../../metermcp/.runtime-token', import.meta.url));
    say(`agent runs: read from ${join(dataDir, 'agent-runs')} · receipts from MeterMCP at ${base}`);
    return localRunReader({ dir: join(dataDir, 'agent-runs'), meter: new MeterMcpClient({ base, tokenFile }) });
  }
  const token = process.env.RESOLVEKIT_OPS_TOKEN?.trim();
  if (!token) throw new Error('--agent-run needs RESOLVEKIT_OPS_TOKEN (.env): the same as on the resolvekit service');
  say(`agent runs: read from ${o.appUrl} (ops route; the server reads each receipt from MeterMCP's admin route)`);
  return opsRunReader({ appUrl: o.appUrl, token });
}

/** A capture of the agent case waiting for its dispute: where it comes from, and what to say about it. */
interface AgentPending {
  capture: string;
  amount: string;
  run?: string;
  session?: string;
  note: string | null;
}

async function waitForDispute(paypal: PayPalClient, which: string, capture: string, o: PrepareOptions, resume: string): Promise<Dispute | null> {
  const until = Date.now() + o.disputeMinutes * 60_000;
  let last = '';
  for (;;) {
    let line: string;
    try {
      const found = await paypal.disputes.findByCapture(capture);
      // The search result is a summary: re-read the dispute for its current status.
      const d = found?.dispute_id ? await paypal.disputes.get(found.dispute_id) : null;
      const r = disputeReadiness(d);
      if (r.state === 'ready') {
        say(`${which}: dispute ${r.disputeId} is WAITING_FOR_SELLER_RESPONSE`);
        return d;
      }
      line = r.state === 'missing' ? `${which}: no dispute on capture ${capture} yet` : `${which}: dispute ${r.disputeId} is ${r.status}; waiting for PayPal to open it`;
    } catch (e) {
      line = `${which}: PayPal read failed (${why(e)}); retrying`;
    }
    if (line !== last) say(line);
    last = line;
    if (Date.now() > until) {
      say(`${which}: gave up after ${o.disputeMinutes} min. Resume with: npm run demo:prepare -- ${resume}`);
      return null;
    }
    await sleep(30_000);
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if ('error' in o) {
    console.error(o.error);
    process.exitCode = 2;
    return;
  }
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set (.env)');
  if ((process.env.PAYPAL_ENV ?? 'sandbox') !== 'sandbox') throw new Error('demo:prepare only runs against the PayPal sandbox (PAYPAL_ENV=sandbox)');
  const paypal = new PayPalClient({ clientId, clientSecret, env: 'sandbox', timeoutMs: 30_000 });
  const models = o.agent ? agentModelsFromEnv(process.env) : null;
  if (o.agent && !models) throw new Error('the agent step needs a model key: GEMINI_API_KEY or GROQ_API_KEY (.env)');
  if (o.agent && !isLocal(o.meterUrl) && !process.env.METERMCP_DEMO_CODE?.trim()) throw new Error('METERMCP_DEMO_CODE is not set: the hosted MeterMCP needs the demo code to open a budget');

  // Every capture already bound (active and reserve, every case) and every one this command adds is used: no
  // capture is ever bound twice. --agent-run needs the current value to know that (Ruling A4).
  const rawBindings = process.env.BINDINGS_JSON;
  if (o.agentRuns.length && !rawBindings) throw new Error('--agent-run needs the current BINDINGS_JSON (.env, as on Render), so no capture already bound is taken again');
  let used: Set<string>;
  try {
    used = rawBindings ? boundCaptures(JSON.parse(rawBindings)) : new Set();
  } catch (e) {
    throw new Error(`BINDINGS_JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const c of [...(o.captures.standard ?? []), ...(o.captures.agent ?? [])]) used.add(c.toUpperCase());
  const read = o.agentRuns.length ? runReader(o) : null;

  const steps = [
    o.standard && '(a) standard order',
    o.agent && '(b) agent session',
    o.agentRuns.length && `(b) ${o.agentRuns.length} agent run${o.agentRuns.length > 1 ? 's' : ''} from the page`,
    (o.standard || o.agent || o.agentRuns.length) && '(c) buyer instructions',
    o.waitDisputes && '(d) wait for disputes + (e) BINDINGS_JSON',
  ].filter(Boolean);
  say(`steps: ${steps.join(' · ')}`);

  if (o.dryRun) {
    await paypal.verifyCredentials();
    say('PayPal sandbox credentials work (OAuth token obtained).');
    if (o.standard) {
      const b = standardOrder(standardCase, o.appUrl);
      say(`would create: Orders v2 CAPTURE · ${b.items[0]!.quantity} × "${b.items[0]!.name}" · ${b.amount.value} ${b.amount.currency_code} · ${b.items[0]!.category} · shipping ${b.shipping}`);
    }
    if (o.agent) say(`would run the agent engine (${models!.primary.provider}/${models!.primary.model}) against ${o.meterUrl} · goal "${o.agentGoal}" · cap ${o.agentCap} USD${o.agentFailFirst.length ? ` · fail first: ${o.agentFailFirst.join(', ')}` : ''} · METERMCP_DEMO_CODE ${process.env.METERMCP_DEMO_CODE ? 'set' : 'NOT set'}`);
    if (o.agent && o.agentCount > 1) say(`would run ${o.agentCount} agent sessions, one after another (each budget approved by the buyer): ${o.agentCount} disputes for the agent case's reserve`);
    if (o.standard && o.count > 1) say(`would create ${o.count} of them, one after another (each approved by the buyer): ${o.count} disputes for the reserve`);
    if (o.agentRuns.length) {
      // Reading is safe: the same checks as a real run, nothing created.
      const r = await agentEntries({ agent: false, agentCount: 0, agentRuns: o.agentRuns }, { runEngine: async () => null, read, used, say });
      for (const e of r.entries) say(`would take run ${e.run}: capture ${e.capture} · ${e.amount}${e.note ? ` · ${e.note}` : ''}`);
      for (const x of r.refused) say(`would refuse run ${x.run}: ${x.problems.join('; ')}`);
    }
    if (o.waitDisputes) say(`would wait for disputes on: ${[o.captures.standard?.join(', ') ?? (o.standard ? `(${o.count} new standard capture${o.count > 1 ? 's' : ''})` : null), o.captures.agent?.join(', ') ?? (o.agent ? `(${o.agentCount} new agent capture${o.agentCount > 1 ? 's' : ''})` : null)].filter(Boolean).join(', ') || 'the agent runs’ captures'}`);
    say('--dry-run: nothing created.');
    return;
  }

  const standard: string[] = [...(o.captures.standard ?? [])];
  const agent: AgentPending[] = (o.captures.agent ?? []).map((c) => ({ capture: c, amount: 'agent', note: null }));
  const approvals = (o.standard ? o.count : 0) + (o.agent ? o.agentCount : 0);
  if (approvals > 1) say(`this run needs ${approvals} buyer approvals and then ${approvals} disputes opened by you, one per payment; allow about ${approvals * 5} minutes plus PayPal's time to open each dispute`);
  if (o.standard) {
    // One after another: each needs the buyer's approval. --count N makes N disputes for the case's reserve.
    const made: string[] = [];
    for (let k = 1; k <= o.count; k++) {
      if (o.count > 1) say(`standard payment ${k} of ${o.count}`);
      const id = await standardStep(paypal, o);
      if (id) {
        made.push(id);
        used.add(id.toUpperCase());
      }
    }
    standard.splice(0, standard.length, ...made);
  }
  if (o.agent || o.agentRuns.length) {
    // Engine runs one after another (each budget needs its own approval), then the page's runs, only read.
    const r = await agentEntries(o, { runEngine: () => engineStep(o, models!), read, used, say });
    for (const x of r.refused) say(`run ${x.run} is not taken into the reserve: ${x.problems.join('; ')}`);
    for (const e of r.entries) {
      say(`agent entry: capture ${e.capture} · ${e.amount}${e.run ? ` · run ${e.run}` : ''} · session ${e.session}${e.note ? ` · ${e.note}` : ''}`);
      agent.push({ capture: e.capture, amount: e.amount, run: e.run, session: e.session, note: e.note });
    }
  }

  if (o.standard || o.agent || o.agentRuns.length) {
    rule();
    say('(c) Now open the disputes as the buyer (a capture whose dispute is already open needs nothing):');
    if (o.standard) for (const c of standard) console.log(`\n${buyerInstructions('standard', c, '7.00 USD')}\n`);
    for (const a of agent.filter((x) => x.session)) console.log(`\n${buyerInstructions('agent', a.capture, a.amount)}\n`);
  }

  if (!o.waitDisputes) {
    const list = [standard.join('+') || '-', agent.map((a) => a.capture).join('+') || '-'].join(',');
    say(`next: npm run demo:prepare -- --wait-disputes --captures ${list}`);
    return;
  }
  rule();
  say('(d) Waiting for the disputes (PayPal lists a new dispute after ~5 min, then opens it). Ctrl+C is safe; resume with --wait-disputes --captures (or --agent-run again).');
  const [stdFound, agentFound] = await Promise.all([
    Promise.all(standard.map(async (c) => ({ capture: c, dispute: await waitForDispute(paypal, 'standard', c, o, `--wait-disputes --captures ${c},`) }))),
    Promise.all(
      agent.map(async (a) => ({
        ...a,
        dispute: await waitForDispute(paypal, 'agent', a.capture, o, a.run && o.agentRuns.includes(a.run) ? `--agent-run ${a.run} --seller ${o.seller}` : `--wait-disputes --captures ,${a.capture}`),
      })),
    ),
  ]);
  // With --seller, an agent dispute that is not that seller's is left out (the run joins no reserve).
  const agentReady = agentFound.filter((a) => {
    if (!a.dispute) return false;
    if (!o.seller) return true;
    const p = disputeSellerProblems(a.dispute, o.seller);
    if (p.length) say(`agent ${a.capture}: dispute ${a.dispute.dispute_id} left out: ${p.join('; ')}`);
    return p.length === 0;
  });
  rule();
  // In the order they were made: the first ready one is active, the rest wait in reserve.
  const stdReady = stdFound.filter((f) => f.dispute);
  const b = bindingsJson({
    ...(stdReady.length ? { standard: stdReady.map((f) => ({ dispute: f.dispute!.dispute_id!, capture: f.capture })) } : {}),
    ...(agentReady.length ? { agent: agentReady.map((a) => ({ dispute: a.dispute!.dispute_id!, capture: a.capture, ...(a.run ? { run: a.run } : {}), ...(a.session ? { session: a.session } : {}) })) } : {}),
  });
  say('(e) BINDINGS_JSON for Render (resolvekit service → Environment), ready to paste:');
  console.log(`\n${b.json}\n`);
  for (const a of agentReady) if (a.note) say(`note · agent ${a.capture} (${a.run ? `run ${a.run}` : `session ${a.session}`}): ${a.note}`);
  if (b.missing.length) say(`not bound (no ready dispute): ${b.missing.join(', ')}; keep their current binding if they have one.`);
  // A capture whose dispute never got ready is left out of its case's list: say so, and how to add it later.
  const late = [...stdFound.filter((f) => !f.dispute).map((f) => `standard ${f.capture}`), ...agentFound.filter((f) => !f.dispute).map((f) => `agent ${f.capture}`)];
  if (late.length) say(`left out (no ready dispute yet): ${late.join(', ')}. When ready, run --wait-disputes --captures (or --agent-run for a page run) to print them.`);
  say('After saving it, Render restarts the service; the warm-up then analyses each bound case once (see the service log).');
}

main().catch((e) => {
  console.error(`[demo:prepare] failed: ${why(e)}`);
  process.exitCode = 1;
});
