/**
 * `npm run demo:prepare` — fresh REAL PayPal sandbox disputes for the demo, human in the loop:
 *
 *   (a) standard case: an Orders v2 CAPTURE order for exactly the standard case's order (1 × "Linen tote, natural",
 *       7.00 USD, PHYSICAL_GOODS); prints the approval URL, waits until the buyer approves, captures, prints the capture.
 *   (b) agent case: the demo agent against MeterMCP (default: the HOSTED one, so the session lives in the hosted
 *       ledger and the hosted agent case shows the real receipt), with METERMCP_DEMO_CODE from the environment.
 *   (c) prints what the sandbox buyer clicks to open each dispute.
 *   (d) polls PayPal until each dispute appears and reaches WAITING_FOR_SELLER_RESPONSE.
 *   (e) prints the BINDINGS_JSON to paste into Render: each case bound to { dispute, capture }, so the server can verify,
 *       right before any send, that the dispute is about exactly the capture this script created.
 *
 * Flags run steps separately or resume (see USAGE in demo-prepare-lib.ts); --dry-run creates nothing. PayPal
 * credentials come from .env (node --env-file-if-exists); nothing secret is printed.
 */
import { randomBytes } from 'node:crypto';
import { PayPalClient, PayPalError, approvalUrl, orderCapture } from '@resolvekit/paypal';
import { standardCase } from '@resolvekit/cases';
import { runDemoAgent } from '../../metermcp/scripts/demo-agent.ts';
import {
  agentReceiptProblems,
  bindingsJson,
  buyerInstructions,
  disputeReadiness,
  parseArgs,
  standardOrder,
  type PrepareOptions,
} from './demo-prepare-lib.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (s: string) => console.log(`[demo:prepare] ${s}`);
const rule = () => console.log('-'.repeat(100));
const why = (e: unknown) => (e instanceof PayPalError ? `${e.message}${e.debugId ? ` (debug id ${e.debugId})` : ''}` : e instanceof Error ? e.message : String(e));

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

async function agentStep(o: PrepareOptions): Promise<{ capture: string | null; amount: string }> {
  rule();
  say(`(b) Agent case: the demo agent against MeterMCP at ${o.meterUrl}`);
  const demoCode = process.env.METERMCP_DEMO_CODE?.trim() || undefined;
  const hostedMeter = !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(o.meterUrl);
  if (hostedMeter && !demoCode) throw new Error('METERMCP_DEMO_CODE is not set: the hosted MeterMCP needs the demo code to open a budget');
  say(`demo code ${demoCode ? 'set (not shown)' : 'not set'} · approve the budget with the sandbox BUYER account when the URL appears`);
  const r = await runDemoAgent({ url: o.meterUrl, demoCode, approvalTimeoutMs: o.approvalMinutes * 60_000, say: (l) => console.log(`[agent] ${l}`) });
  const problems = agentReceiptProblems(r.receipt);
  for (const p of problems) say(`WARNING: agent receipt: ${p}`);
  const amount = r.receipt?.totals?.charged ? `${r.receipt.totals.charged} ${r.receipt.session?.currency ?? 'USD'}` : 'agent';
  if (r.captureId) console.log(`\n  Agent capture id: ${r.captureId}${r.sessionId ? ` (MeterMCP session ${r.sessionId})` : ''}\n`);
  return { capture: r.captureId, amount };
}

async function waitForDispute(paypal: PayPalClient, which: string, capture: string, o: PrepareOptions): Promise<string | null> {
  const until = Date.now() + o.disputeMinutes * 60_000;
  let last = '';
  for (;;) {
    let line: string;
    try {
      const found = await paypal.disputes.findByCapture(capture);
      // The search result is a summary: re-read the dispute for its current status.
      const r = disputeReadiness(found?.dispute_id ? await paypal.disputes.get(found.dispute_id) : null);
      if (r.state === 'ready') {
        say(`${which}: dispute ${r.disputeId} is WAITING_FOR_SELLER_RESPONSE`);
        return r.disputeId;
      }
      line = r.state === 'missing' ? `${which}: no dispute on capture ${capture} yet` : `${which}: dispute ${r.disputeId} is ${r.status}; waiting for PayPal to open it`;
    } catch (e) {
      line = `${which}: PayPal read failed (${why(e)}); retrying`;
    }
    if (line !== last) say(line);
    last = line;
    if (Date.now() > until) {
      say(`${which}: gave up after ${o.disputeMinutes} min. Resume with: npm run demo:prepare -- --wait-disputes --captures ${which === 'standard' ? `${capture},` : `,${capture}`}`);
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

  const steps = [o.standard && '(a) standard order', o.agent && '(b) agent session', (o.standard || o.agent) && '(c) buyer instructions', o.waitDisputes && '(d) wait for disputes + (e) BINDINGS_JSON'].filter(Boolean);
  say(`steps: ${steps.join(' · ')}`);

  if (o.dryRun) {
    await paypal.verifyCredentials();
    say('PayPal sandbox credentials work (OAuth token obtained).');
    if (o.standard) {
      const b = standardOrder(standardCase, o.appUrl);
      say(`would create: Orders v2 CAPTURE · ${b.items[0]!.quantity} × "${b.items[0]!.name}" · ${b.amount.value} ${b.amount.currency_code} · ${b.items[0]!.category} · shipping ${b.shipping}`);
    }
    if (o.agent) say(`would run the demo agent against ${o.meterUrl} · METERMCP_DEMO_CODE ${process.env.METERMCP_DEMO_CODE ? 'set' : 'NOT set'}`);
    if (o.agent && o.agentCount > 1) say(`would run ${o.agentCount} agent sessions, one after another (each budget approved by the buyer): ${o.agentCount} disputes for the agent case's reserve`);
    if (o.standard && o.count > 1) say(`would create ${o.count} of them, one after another (each approved by the buyer): ${o.count} disputes for the reserve`);
    if (o.waitDisputes) say(`would wait for disputes on: ${[o.captures.standard?.join(', ') ?? (o.standard ? `(${o.count} new standard capture${o.count > 1 ? 's' : ''})` : null), o.captures.agent?.join(', ') ?? (o.agent ? `(${o.agentCount} new agent capture${o.agentCount > 1 ? 's' : ''})` : null)].filter(Boolean).join(', ')}`);
    say('--dry-run: nothing created.');
    return;
  }

  const captures: { standard?: string[]; agent?: string[] } = { ...o.captures };
  const agentAmounts = new Map<string, string>();
  const approvals = (o.standard ? o.count : 0) + (o.agent ? o.agentCount : 0);
  if (approvals > 1) say(`this run needs ${approvals} buyer approvals and then ${approvals} disputes opened by you, one per payment; allow about ${approvals * 5} minutes plus PayPal's time to open each dispute`);
  if (o.standard) {
    // One after another: each needs the buyer's approval. --count N makes N disputes for the case's reserve.
    const made: string[] = [];
    for (let k = 1; k <= o.count; k++) {
      if (o.count > 1) say(`standard payment ${k} of ${o.count}`);
      const id = await standardStep(paypal, o);
      if (id) made.push(id);
    }
    captures.standard = made.length ? made : undefined;
  }
  if (o.agent) {
    // One after another: each session needs its own budget approval. --agent-count N makes N disputes for the reserve.
    const made: string[] = [];
    for (let k = 1; k <= o.agentCount; k++) {
      if (o.agentCount > 1) say(`agent session ${k} of ${o.agentCount}`);
      const a = await agentStep(o);
      if (!a.capture) {
        say(`agent session ${k} did not end in a capture: stopping the agent sessions here (${made.length} made). Run the rest later with --agent --agent-count ${o.agentCount - made.length}.`);
        break;
      }
      made.push(a.capture);
      agentAmounts.set(a.capture, a.amount);
    }
    captures.agent = made.length ? made : undefined;
  }

  if (o.standard || o.agent) {
    rule();
    say('(c) Now open the disputes as the buyer:');
    if (o.standard) for (const c of captures.standard ?? []) console.log(`\n${buyerInstructions('standard', c, '7.00 USD')}\n`);
    if (o.agent) for (const c of captures.agent ?? []) console.log(`\n${buyerInstructions('agent', c, agentAmounts.get(c) ?? 'agent')}\n`);
  }

  if (!o.waitDisputes) {
    const list = [captures.standard?.join('+') || '-', captures.agent?.join('+') || '-'].join(',');
    say(`next: npm run demo:prepare -- --wait-disputes --captures ${list}`);
    return;
  }
  rule();
  say('(d) Waiting for the disputes (PayPal lists a new dispute after ~5 min, then opens it). Ctrl+C is safe; resume with --wait-disputes --captures.');
  const wait = (which: 'standard' | 'agent', list: string[]) => Promise.all(list.map(async (c) => ({ capture: c, dispute: await waitForDispute(paypal, which, c, o) })));
  const [stdFound, agentFound] = await Promise.all([wait('standard', captures.standard ?? []), wait('agent', captures.agent ?? [])]);
  rule();
  // In the order they were made: the first ready one is active, the rest wait in reserve.
  const isReady = (f: { capture: string; dispute: string | null }): f is { capture: string; dispute: string } => !!f.dispute;
  const b = bindingsJson({
    ...(stdFound.some(isReady) ? { standard: stdFound.filter(isReady) } : {}),
    ...(agentFound.some(isReady) ? { agent: agentFound.filter(isReady) } : {}),
  });
  say('(e) BINDINGS_JSON for Render (resolvekit service → Environment), ready to paste:');
  console.log(`\n${b.json}\n`);
  if (b.missing.length) say(`not bound (no ready dispute): ${b.missing.join(', ')}; keep their current binding if they have one.`);
  say('After saving it, Render restarts the service; the warm-up then analyses each bound case once (see the service log).');
}

main().catch((e) => {
  console.error(`[demo:prepare] failed: ${why(e)}`);
  process.exitCode = 1;
});
