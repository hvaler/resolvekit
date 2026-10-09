/**
 * MeterMCP: `npm run metermcp` (from the repo root). Loads the repo-root .env (PayPal sandbox app: MeterMCP charges
 * into that account), listens on 127.0.0.1 only, keeps its ledger in apps/metermcp/data/ (git-ignored).
 *
 * Env: METERMCP_PORT (8790) · METERMCP_BUDGET (5.00) · METERMCP_IDLE_MINUTES (15) · METERMCP_PUBLIC_URL
 * (http://127.0.0.1:<port>) · METERMCP_DB · METERMCP_FAIL_FIRST (test switch, e.g. "deep_report") ·
 * METERMCP_ALLOWED_ORIGINS · METERMCP_TOKEN_FILE.
 */
import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { PayPalClient, type PayPalEnv } from '@resolvekit/paypal';
import { createApp } from './app.ts';
import { Ledger } from './ledger.ts';
import { Meter } from './meter.ts';
import { toNodeListener } from './node.ts';

const env: PayPalEnv = process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox';
const clientId = process.env.PAYPAL_CLIENT_ID;
const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
const paypal = clientId && clientSecret ? new PayPalClient({ clientId, clientSecret, env, timeoutMs: 30_000 }) : null;

const port = Number(process.env.METERMCP_PORT ?? 8790);
const host = '127.0.0.1';
const publicUrl = (process.env.METERMCP_PUBLIC_URL ?? `http://${host}:${port}`).replace(/\/$/, '');
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const failFirst = (process.env.METERMCP_FAIL_FIRST ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const idleMs = Number(process.env.METERMCP_IDLE_MINUTES ?? 15) * 60_000;

const ledger = new Ledger(process.env.METERMCP_DB ?? fileURLToPath(new URL('../data/metermcp.sqlite', import.meta.url)));
const meter = new Meter({ ledger, paypal, env, publicUrl, budget: process.env.METERMCP_BUDGET ?? '5.00', log, failFirst });

// Per-launch admin secret for apps/server (receipts, lookups by capture, admin close). Never logged.
const token = randomBytes(32).toString('hex');
const tokenFile = process.env.METERMCP_TOKEN_FILE ?? fileURLToPath(new URL('../.runtime-token', import.meta.url));
writeFileSync(tokenFile, token, { mode: 0o600 });
const allowedOrigins = process.env.METERMCP_ALLOWED_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean) ?? [];

const app = createApp({ meter, env, port, token, allowedOrigins, log });
const server = createServer(toNodeListener(app, `http://${host}:${port}`));
server.listen(port, host, () => {
  log(`MeterMCP on http://${host}:${port}/mcp · PayPal ${paypal ? env : 'unconfigured'} · budget ${process.env.METERMCP_BUDGET ?? '5.00'} USD · idle close ${idleMs / 60_000} min`);
  if (failFirst.length) log(`TEST SWITCH: the first ${failFirst.join(', ')} call of each session fails (not charged)`);
});
const sweep = setInterval(() => void meter.sweepIdle(idleMs).catch((e) => log(`idle sweep failed: ${String(e)}`)), 30_000);

const stop = () => {
  clearInterval(sweep);
  rmSync(tokenFile, { force: true });
  void app.close().finally(() => server.close(() => {
    ledger.close();
    process.exit(0);
  }));
  server.closeAllConnections();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
