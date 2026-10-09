/**
 * ResolveKit server: `npm run server` (from the repo root). Loads the repo-root .env through `node --env-file`.
 *
 * Local mode (default): listens on 127.0.0.1 only and serves /api for the web app (Vite proxies /api here in dev and
 * preview, adding the per-launch token).
 *
 * Hosted mode (`RESOLVEKIT_MODE=hosted`, e.g. on Render, see render.yaml): listens on 0.0.0.0:$PORT and serves the
 * built web app and /api on one public origin, with the demo code, daily caps and per-IP limits of hosted.ts.
 * Env (hosted): RENDER_EXTERNAL_URL (set by Render) · RESOLVEKIT_CUSTOM_DOMAINS · DEMO_CODE · RESOLVEKIT_SESSION_SECRET ·
 * RESOLVEKIT_DATA_DIR (the disk) · BINDINGS_JSON (or RESOLVEKIT_BINDINGS, a file) · METERMCP_URL + METERMCP_ADMIN_TOKEN ·
 * DAILY_LIVE_ANALYSES (60) · DAILY_RECHECKS (200) · DAILY_EVIDENCE_SENDS (20) · TRUSTED_PROXY_HOPS (1).
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DailyCounters, StaticSite, envInt, publicOrigins } from '@resolvekit/hosting';
import { PayPalClient, type PayPalEnv } from '@resolvekit/paypal';
import { FileAnalysisStore, RateLimiter, modelFromEnv } from '@resolvekit/analyst/node';
import { AnalystService } from './analysis.ts';
import { createApp, DEFAULT_ORIGINS, type Handler } from './app.ts';
import { checkBindings, parseBindings } from './bindings.ts';
import { CASE_FILES } from './documents.ts';
import { createHostedApp } from './hosted.ts';
import { MeterMcpClient } from './metermcp.ts';
import { toNodeListener } from './node.ts';

const hosted = process.env.RESOLVEKIT_MODE === 'hosted';
const env: PayPalEnv = process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox';
const clientId = process.env.PAYPAL_CLIENT_ID;
const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
const paypal = clientId && clientSecret ? new PayPalClient({ clientId, clientSecret, env, timeoutMs: 30_000 }) : null;
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const fail = (why: string): never => {
  console.error(`ResolveKit server not started: ${why}`);
  process.exit(1);
};

// Analysis cache, usage log and (hosted) daily caps. On Render this is the service's persistent disk.
const dataDir = process.env.RESOLVEKIT_DATA_DIR ?? fileURLToPath(new URL('../data/', import.meta.url));

function loadBindings(): Record<string, string> {
  // Hosted: BINDINGS_JSON (a secret env var) wins; otherwise a file. Never from a client.
  if (hosted && process.env.BINDINGS_JSON) {
    try {
      return parseBindings(JSON.parse(process.env.BINDINGS_JSON));
    } catch (e) {
      return fail(`BINDINGS_JSON: ${(e as Error).message}`);
    }
  }
  const file = process.env.RESOLVEKIT_BINDINGS ?? (hosted ? join(dataDir, 'bindings.json') : fileURLToPath(new URL('../bindings.json', import.meta.url)));
  try {
    return parseBindings(JSON.parse(readFileSync(file, 'utf8')));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    if (hosted) return fail(`bindings file ${file}: ${(e as Error).message}`);
    console.error(`bindings: could not read ${file}: ${(e as Error).message}`);
    return {};
  }
}

const bindings = loadBindings();
const port = Number(process.env.PORT ?? (hosted ? 10000 : 8787));
const host = hosted ? '0.0.0.0' : '127.0.0.1';

// MeterMCP: the agent case's real session receipt, read server-to-server (local: this machine and MeterMCP's
// per-launch token file; hosted: Render's private network and the admin token both services get from render.yaml).
const meterBase = process.env.METERMCP_URL ?? 'http://127.0.0.1:8790';
const meterMcp = new MeterMcpClient({
  base: /^https?:\/\//.test(meterBase) ? meterBase : `http://${meterBase}`,
  ...(hosted
    ? { token: process.env.METERMCP_ADMIN_TOKEN ?? '' }
    : { tokenFile: process.env.METERMCP_TOKEN_FILE ?? fileURLToPath(new URL('../../metermcp/.runtime-token', import.meta.url)) }),
});

// The AI analyst: Gemini (primary) with Groq as automatic fallback, keys from the environment. Live runs are cached
// in <data>/analysis-cache; committed golden analyses answer for the demo documents.
const usageFile = join(dataDir, 'analyst-usage.jsonl');
const analystConfig = modelFromEnv(process.env, { onFallback: (why) => log(`analyst fallback · ${why}`) });
const HOUR = 3_600_000;
const analyst = new AnalystService({
  model: analystConfig?.model ?? null,
  primaryModel: analystConfig?.primary.model ?? 'gemini-3.8-flash',
  store: new FileAnalysisStore({ dir: join(dataDir, 'analysis-cache') }),
  liveLimit: new RateLimiter({ limit: envInt(process.env, 'LIVE_ANALYSES_PER_HOUR', 6), windowMs: HOUR }),
  verifyLimit: new RateLimiter({ limit: envInt(process.env, 'RECHECKS_PER_HOUR', 30), windowMs: HOUR }),
  log,
  // Token counts and timings only: no prompt or document text.
  onUsage: (caseId, u) => {
    log(`analyst call · ${u.stage} · ${u.provider}/${u.model} · in ${u.inputTokens} out ${u.outputTokens} thinking ${u.thinkingTokens} · ${u.ms} ms`);
    try {
      mkdirSync(dataDir, { recursive: true });
      appendFileSync(usageFile, JSON.stringify({ at: new Date().toISOString(), caseId, ...u }) + '\n');
    } catch {
      /* the usage log is best effort */
    }
  },
});

let app: Handler;
let tokenFile: string | null = null;
if (hosted) {
  const pub = publicOrigins(process.env.RENDER_EXTERNAL_URL, process.env.RESOLVEKIT_CUSTOM_DOMAINS);
  if (!pub.origins.length) fail('RENDER_EXTERNAL_URL is not set (Render sets it; set it yourself elsewhere)');
  const demoCode = process.env.DEMO_CODE?.trim() || null;
  if (!demoCode) log('WARNING: DEMO_CODE is not set: costly demo actions (evidence, live AI) cannot be unlocked');
  else if (demoCode.length < 12) log('WARNING: DEMO_CODE is short; use 12+ random characters');
  let sessionSecret = process.env.RESOLVEKIT_SESSION_SECRET ?? '';
  if (sessionSecret.length < 32) {
    log('WARNING: RESOLVEKIT_SESSION_SECRET missing or short: using a per-launch secret (unlocks end on restart)');
    sessionSecret = randomBytes(32).toString('base64url');
  }
  const dist = process.env.RESOLVEKIT_WEB_DIST ?? fileURLToPath(new URL('../../web/dist/', import.meta.url));
  if (!existsSync(join(dist, 'index.html'))) fail(`no web build at ${dist} (run npm run build)`);
  const counters = new DailyCounters({
    file: join(dataDir, 'daily-caps.json'),
    limits: {
      'live-analysis': envInt(process.env, 'DAILY_LIVE_ANALYSES', 60),
      recheck: envInt(process.env, 'DAILY_RECHECKS', 200),
      evidence: envInt(process.env, 'DAILY_EVIDENCE_SENDS', 20),
    },
  });
  const site = StaticSite.load(dist);
  app = createHostedApp({
    paypal, env, bindings, log, meterMcp, analyst, site, counters, demoCode, sessionSecret,
    origins: pub.origins,
    hosts: pub.hosts,
    https: pub.https,
    trustedHops: envInt(process.env, 'TRUSTED_PROXY_HOPS', 1),
  });
  log(`Hosted mode · ${pub.origins.join(', ')} · ${site.size} web files · demo code ${demoCode ? 'set' : 'NOT set'} · data in ${dataDir}`);
} else {
  // Per-launch secret. Only the local Vite proxy reads this file and adds it to /api requests server-side, so the
  // browser never holds it and no other website can send it.
  const token = randomBytes(32).toString('hex');
  tokenFile = process.env.RESOLVEKIT_TOKEN_FILE ?? fileURLToPath(new URL('../.runtime-token', import.meta.url));
  writeFileSync(tokenFile, token, { mode: 0o600 });
  const allowedOrigins = process.env.RESOLVEKIT_ALLOWED_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean) ?? DEFAULT_ORIGINS;
  app = createApp({ paypal, env, bindings, log, port, token, allowedOrigins, meterMcp, analyst });
}

const server = createServer(toNodeListener(app, `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`));
server.listen(port, host, () => {
  log(`ResolveKit server on http://${host}:${port} · PayPal ${paypal ? env : 'unconfigured'} · ${Object.keys(bindings).length} bound case(s)`);
  log(`Analyst: ${analystConfig ? `${analystConfig.primary.provider}/${analystConfig.primary.model} (providers: ${analystConfig.available.join(', ')})` : 'no model key: stored analyses only'}`);
  for (const [caseId, disputeId] of Object.entries(bindings)) log(`  ${caseId} → ${disputeId}`);
  // Read each bound dispute once in the background and warn if its amount is not the demo case's order amount.
  const caseOrders = Object.fromEntries(Object.entries(CASE_FILES).map(([id, c]) => [id, { value: c.summary.amount, currency: c.summary.currency }]));
  void checkBindings({ paypal, bindings, caseOrders, log });
});

const stop = () => {
  if (tokenFile) rmSync(tokenFile, { force: true });
  server.close(() => process.exit(0));
  server.closeAllConnections();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
