/**
 * MeterMCP: `npm run metermcp` (from the repo root). Loads the repo-root .env (PayPal sandbox app: MeterMCP charges
 * into that account).
 *
 * Local mode (default): listens on 127.0.0.1 only, keeps its ledger in apps/metermcp/data/ (git-ignored), writes a
 * per-launch admin token for apps/server to apps/metermcp/.runtime-token.
 * Env: METERMCP_PORT (8790) · METERMCP_BUDGET (5.00, the largest budget) · METERMCP_MIN_BUDGET (0.50, the smallest
 * open_budget cap) · METERMCP_IDLE_MINUTES (15) · METERMCP_PUBLIC_URL (http://127.0.0.1:<port>) · METERMCP_DB ·
 * METERMCP_FAIL_FIRST (test switch, e.g. "deep_report") · METERMCP_RETURN_ORIGINS (comma list of origins an
 * open_budget return_to may point at) · METERMCP_ALLOWED_ORIGINS · METERMCP_TOKEN_FILE.
 *
 * Hosted mode (`METERMCP_MODE=hosted`, e.g. on Render): listens on 0.0.0.0:$PORT; the public URL is
 * METERMCP_PUBLIC_URL or RENDER_EXTERNAL_URL (PayPal return/cancel pages); the admin token is METERMCP_ADMIN_TOKEN
 * (shared with apps/server through render.yaml); creating a budget needs DEMO_CODE in the `x-demo-code` header and
 * stays within DAILY_BUDGETS (20) per day; data in METERMCP_DATA_DIR (the disk).
 */
import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DailyCounters, envInt, insecureOrigin, publicOrigins, paypalEnvFor } from '@resolvekit/hosting';
import { PayPalClient, type PayPalEnv } from '@resolvekit/paypal';
import { createApp, type HostedMeterOptions } from './app.ts';
import { Ledger } from './ledger.ts';
import { Meter } from './meter.ts';
import { toNodeListener } from './node.ts';

const hosted = process.env.METERMCP_MODE === 'hosted';
// Hosted (public) mode runs on the PayPal sandbox only: anything else refuses to start (live needs an explicit opt-in).
const paypalEnv = paypalEnvFor(process.env, hosted);
if (!paypalEnv.ok) {
  console.error(`MeterMCP not started: ${paypalEnv.error}`);
  process.exit(1);
}
const env: PayPalEnv = paypalEnv.env;
const clientId = process.env.PAYPAL_CLIENT_ID;
const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
const paypal = clientId && clientSecret ? new PayPalClient({ clientId, clientSecret, env, timeoutMs: 30_000 }) : null;
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const fail = (why: string): never => {
  console.error(`MeterMCP not started: ${why}`);
  process.exit(1);
};

const port = Number((hosted ? process.env.PORT : process.env.METERMCP_PORT) ?? (hosted ? 10000 : 8790));
const host = hosted ? '0.0.0.0' : '127.0.0.1';
const publicUrl = (process.env.METERMCP_PUBLIC_URL ?? (hosted ? process.env.RENDER_EXTERNAL_URL : undefined) ?? `http://${host}:${port}`).replace(/\/$/, '');
const failFirst = (process.env.METERMCP_FAIL_FIRST ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const idleMs = Number(process.env.METERMCP_IDLE_MINUTES ?? 15) * 60_000;
const dataDir = process.env.METERMCP_DATA_DIR ?? fileURLToPath(new URL('../data/', import.meta.url));

const returnOrigins = (process.env.METERMCP_RETURN_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const budget = process.env.METERMCP_BUDGET ?? '5.00';
const minBudget = process.env.METERMCP_MIN_BUDGET ?? '0.50';

// A ledger that cannot be migrated is left untouched and MeterMCP does not start (the previous deploy keeps serving).
const ledger = (() => {
  try {
    return new Ledger(process.env.METERMCP_DB ?? join(dataDir, 'metermcp.sqlite'), { log });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
})();
const MONEY = /^\d+(\.\d{1,2})?$/;
if (MONEY.test(minBudget) && MONEY.test(budget) && Number(minBudget) > Number(budget)) {
  log(`WARNING: METERMCP_MIN_BUDGET ${minBudget} is above METERMCP_BUDGET ${budget}: open_budget will refuse every cap`);
}
const meter = (() => {
  try {
    return new Meter({ ledger, paypal, env, publicUrl, budget, minBudget, returnOrigins, log, failFirst });
  } catch (e) {
    return fail(`invalid METERMCP_BUDGET / METERMCP_MIN_BUDGET / METERMCP_RETURN_ORIGINS (${e instanceof Error ? e.message : String(e)})`);
  }
})();

// Admin secret for apps/server (receipts, lookups by capture, admin close). Never logged. Local: per launch, in a
// file only this machine reads. Hosted: from the environment (render.yaml generates it and gives it to apps/server).
let token: string;
let tokenFile: string | null = null;
let hostedOpts: HostedMeterOptions | null = null;
if (hosted) {
  token = process.env.METERMCP_ADMIN_TOKEN ?? '';
  if (token.length < 32) fail('METERMCP_ADMIN_TOKEN missing or shorter than 32 characters');
  const pub = publicOrigins(publicUrl, process.env.METERMCP_CUSTOM_DOMAINS);
  const insecure = insecureOrigin(pub.origins);
  if (insecure) fail(`public URL ${insecure} is not https (PayPal returns buyers there; set METERMCP_PUBLIC_URL; only localhost may be http)`);
  const demoCode = process.env.DEMO_CODE?.trim() || null;
  if (!demoCode) log('WARNING: DEMO_CODE is not set: no budget can be created');
  hostedOpts = {
    publicHosts: pub.hosts,
    https: pub.https,
    demoCode,
    budgets: new DailyCounters({ file: join(dataDir, 'daily-caps.json'), limits: { budget: envInt(process.env, 'DAILY_BUDGETS', 20) } }),
    trustedHops: envInt(process.env, 'TRUSTED_PROXY_HOPS', 1),
    proxyTrust: process.env.TRUSTED_PROXY_PEERS === 'any' ? 'any' : process.env.TRUSTED_PROXY_PEERS === 'none' ? 'none' : 'private',
  };
} else {
  token = randomBytes(32).toString('hex');
  tokenFile = process.env.METERMCP_TOKEN_FILE ?? fileURLToPath(new URL('../.runtime-token', import.meta.url));
  writeFileSync(tokenFile, token, { mode: 0o600 });
}
const allowedOrigins = process.env.METERMCP_ALLOWED_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean) ?? [];

const app = createApp({ meter, env, port, token, allowedOrigins, log, hosted: hostedOpts });
const server = createServer(toNodeListener(app, `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`));
server.listen(port, host, () => {
  log(`MeterMCP on http://${host}:${port}/mcp · public ${publicUrl} · PayPal ${paypal ? env : 'unconfigured'} · budget ${minBudget}–${budget} USD · idle close ${idleMs / 60_000} min${hosted ? ' · hosted mode' : ''}`);
  if (failFirst.length) log(`TEST SWITCH: the first ${failFirst.join(', ')} call of each payment_required session fails (not charged; open_budget sessions follow their own fail_first)`);
});
const sweep = setInterval(() => {
  void meter.sweepIdle(idleMs).catch((e) => log(`idle sweep failed: ${String(e)}`));
  // Captures PayPal reported PENDING: read them back until they complete or are declined.
  void meter.reconcilePending().catch((e) => log(`capture reconciliation failed: ${String(e)}`));
  // Idle MCP sessions: free their transports (and close their payment sessions); log the counters when it acts.
  void app
    .sweepMcp()
    .then((closed) => closed.length && log(`mcp sessions: closed ${closed.length} idle · ${JSON.stringify(app.metrics())}`))
    .catch((e) => log(`mcp idle sweep failed: ${String(e)}`));
}, 30_000);

const stop = () => {
  clearInterval(sweep);
  if (tokenFile) rmSync(tokenFile, { force: true });
  void app.close().finally(() => server.close(() => {
    ledger.close();
    process.exit(0);
  }));
  server.closeAllConnections();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
