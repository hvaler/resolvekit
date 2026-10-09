/**
 * MeterMCP: `npm run metermcp` (from the repo root). Loads the repo-root .env (PayPal sandbox app: MeterMCP charges
 * into that account).
 *
 * Local mode (default): listens on 127.0.0.1 only, keeps its ledger in apps/metermcp/data/ (git-ignored), writes a
 * per-launch admin token for apps/server to apps/metermcp/.runtime-token.
 * Env: METERMCP_PORT (8790) · METERMCP_BUDGET (5.00) · METERMCP_IDLE_MINUTES (15) · METERMCP_PUBLIC_URL
 * (http://127.0.0.1:<port>) · METERMCP_DB · METERMCP_FAIL_FIRST (test switch, e.g. "deep_report") ·
 * METERMCP_ALLOWED_ORIGINS · METERMCP_TOKEN_FILE.
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
import { DailyCounters, envInt, publicOrigins } from '@resolvekit/hosting';
import { PayPalClient, type PayPalEnv } from '@resolvekit/paypal';
import { createApp, type HostedMeterOptions } from './app.ts';
import { Ledger } from './ledger.ts';
import { Meter } from './meter.ts';
import { toNodeListener } from './node.ts';

const hosted = process.env.METERMCP_MODE === 'hosted';
const env: PayPalEnv = process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox';
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

const ledger = new Ledger(process.env.METERMCP_DB ?? join(dataDir, 'metermcp.sqlite'));
const meter = new Meter({ ledger, paypal, env, publicUrl, budget: process.env.METERMCP_BUDGET ?? '5.00', log, failFirst });

// Admin secret for apps/server (receipts, lookups by capture, admin close). Never logged. Local: per launch, in a
// file only this machine reads. Hosted: from the environment (render.yaml generates it and gives it to apps/server).
let token: string;
let tokenFile: string | null = null;
let hostedOpts: HostedMeterOptions | null = null;
if (hosted) {
  token = process.env.METERMCP_ADMIN_TOKEN ?? '';
  if (token.length < 32) fail('METERMCP_ADMIN_TOKEN missing or shorter than 32 characters');
  const pub = publicOrigins(publicUrl, process.env.METERMCP_CUSTOM_DOMAINS);
  const demoCode = process.env.DEMO_CODE?.trim() || null;
  if (!demoCode) log('WARNING: DEMO_CODE is not set: no budget can be created');
  hostedOpts = {
    publicHosts: pub.hosts,
    https: pub.https,
    demoCode,
    budgets: new DailyCounters({ file: join(dataDir, 'daily-caps.json'), limits: { budget: envInt(process.env, 'DAILY_BUDGETS', 20) } }),
    trustedHops: envInt(process.env, 'TRUSTED_PROXY_HOPS', 1),
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
  log(`MeterMCP on http://${host}:${port}/mcp · public ${publicUrl} · PayPal ${paypal ? env : 'unconfigured'} · budget ${process.env.METERMCP_BUDGET ?? '5.00'} USD · idle close ${idleMs / 60_000} min${hosted ? ' · hosted mode' : ''}`);
  if (failFirst.length) log(`TEST SWITCH: the first ${failFirst.join(', ')} call of each session fails (not charged)`);
});
const sweep = setInterval(() => void meter.sweepIdle(idleMs).catch((e) => log(`idle sweep failed: ${String(e)}`)), 30_000);

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
