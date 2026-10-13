/**
 * ResolveKit server: `npm run server` (from the repo root). Loads the repo-root .env through `node --env-file`.
 *
 * Local mode (default): listens on 127.0.0.1 only and serves /api for the web app (Vite proxies /api here in dev and
 * preview, adding the per-launch token).
 *
 * Hosted mode (`RESOLVEKIT_MODE=hosted`, e.g. on Render, see render.yaml): listens on 0.0.0.0:$PORT and serves the
 * built web app and /api on one public origin, with merchant sign-in (auth.ts), daily caps and per-IP limits of hosted.ts.
 * Env (hosted): RENDER_EXTERNAL_URL (set by Render) · RESOLVEKIT_CUSTOM_DOMAINS · RESOLVEKIT_SESSION_SECRET ·
 * PAYPAL_IDENTITY_CLIENT_ID + PAYPAL_IDENTITY_CLIENT_SECRET (the platform's PayPal app, for PayPal sign-in) ·
 * RESOLVEKIT_DATA_DIR (the disk) · BINDINGS_JSON (or RESOLVEKIT_BINDINGS, a file) · METERMCP_URL + METERMCP_ADMIN_TOKEN ·
 * DAILY_LIVE_ANALYSES (60) · DAILY_RECHECKS (200) · DAILY_EVIDENCE_SENDS (20) · TRUSTED_PROXY_HOPS (1).
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DailyCounters, StaticSite, envInt, insecureOrigin, publicOrigins, paypalEnvFor } from '@resolvekit/hosting';
import { PayPalClient, type PayPalEnv } from '@resolvekit/paypal';
import { FileAnalysisStore, RateLimiter, modelFromEnv } from '@resolvekit/analyst/node';
import { AccountStore } from './accounts.ts';
import { AnalystService, InputPins } from './analysis.ts';
import { createApp, DEFAULT_ORIGINS, type Handler } from './app.ts';
import { checkBindings, parseBindings, type Binding } from './bindings.ts';
import { CASE_FILES } from './documents.ts';
import { createHostedApp, type HostedApp } from './hosted.ts';
import { WEBHOOK_KEY } from './webhook.ts';
import { IntentStore } from './intents.ts';
import { MeterMcpClient } from './metermcp.ts';
import { toNodeListener } from './node.ts';

const hosted = process.env.RESOLVEKIT_MODE === 'hosted';
// Hosted (public) mode runs on the PayPal sandbox only: anything else refuses to start (live needs an explicit opt-in).
const paypalEnv = paypalEnvFor(process.env, hosted);
if (!paypalEnv.ok) {
  console.error(`ResolveKit server not started: ${paypalEnv.error}`);
  process.exit(1);
}
const env: PayPalEnv = paypalEnv.env;
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

const bindingsFile = process.env.RESOLVEKIT_BINDINGS ?? (hosted ? join(dataDir, 'bindings.json') : fileURLToPath(new URL('../bindings.json', import.meta.url)));

function loadBindings(): Record<string, Binding> {
  // Hosted: BINDINGS_JSON (a secret env var) wins; otherwise a file. Never from a client.
  if (hosted && process.env.BINDINGS_JSON) {
    try {
      return parseBindings(JSON.parse(process.env.BINDINGS_JSON));
    } catch (e) {
      return fail(`BINDINGS_JSON: ${(e as Error).message}`);
    }
  }
  const file = bindingsFile;
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

// The input each case was analysed with before the seller's evidence went in (see InputPins).
const pins = new InputPins({ file: join(dataDir, 'analysis-inputs.json') });

// Submission intents (what the merchant approved, exactly) and the approval/send audit log: the server's record.
const intents = new IntentStore({ file: join(dataDir, 'intents.json'), eventsFile: join(dataDir, 'audit-events.jsonl') });

let app: Handler;
let hostedApp: HostedApp | null = null;
let tokenFile: string | null = null;
if (hosted) {
  const pub = publicOrigins(process.env.RENDER_EXTERNAL_URL, process.env.RESOLVEKIT_CUSTOM_DOMAINS);
  if (!pub.origins.length) fail('RENDER_EXTERNAL_URL is not set (Render sets it; set it yourself elsewhere)');
  const insecure = insecureOrigin(pub.origins);
  if (insecure) fail(`public origin ${insecure} is not https (PayPal returns merchants there; only localhost may be http)`);
  let sessionSecret = process.env.RESOLVEKIT_SESSION_SECRET ?? '';
  if (sessionSecret.length < 32) {
    log('WARNING: RESOLVEKIT_SESSION_SECRET missing or short: using a per-launch secret (sign-ins end on restart)');
    sessionSecret = randomBytes(32).toString('base64url');
  }
  // PayPal sign-in identifies the merchant through a no-charge approval requested by the PLATFORM's own PayPal app:
  // a seller cannot approve a request of its own app, so this must not be the seller's app (PAYPAL_CLIENT_ID).
  const idId = process.env.PAYPAL_IDENTITY_CLIENT_ID;
  const idSecret = process.env.PAYPAL_IDENTITY_CLIENT_SECRET;
  if (idId && idId === clientId) fail('PAYPAL_IDENTITY_CLIENT_ID must be a different PayPal app than PAYPAL_CLIENT_ID (the seller cannot approve its own app)');
  const identity = idId && idSecret ? new PayPalClient({ clientId: idId, clientSecret: idSecret, env, timeoutMs: 30_000 }) : null;
  if (!identity) log('WARNING: PAYPAL_IDENTITY_CLIENT_ID / _SECRET not set: PayPal sign-in is off (members can still join with invites)');
  // The webhook registered on the seller's app for <origin>/api/paypal/webhook/<PAYPAL_WEBHOOK_KEY>: its id is what
  // PayPal signs for; the key keeps strangers from making this server ask PayPal to confirm forged deliveries.
  const webhookId = process.env.PAYPAL_WEBHOOK_ID?.trim() || null;
  const webhookKey = process.env.PAYPAL_WEBHOOK_KEY?.trim() || null;
  if (webhookId && !/^[A-Z0-9]{10,40}$/.test(webhookId)) fail('PAYPAL_WEBHOOK_ID does not look like a PayPal webhook id');
  if (webhookId && (!webhookKey || !WEBHOOK_KEY.test(webhookKey))) fail('PAYPAL_WEBHOOK_KEY (32+ URL-safe characters, the secret segment of the webhook URL) is required with PAYPAL_WEBHOOK_ID');
  const webhook = webhookId && webhookKey ? { id: webhookId, key: webhookKey } : null;
  // Workspaces, people, passkeys and invites. An unreadable file stops the start (it would drop every membership).
  let accounts: AccountStore;
  try {
    accounts = new AccountStore({ file: join(dataDir, 'accounts.json') });
  } catch (e) {
    accounts = fail(`accounts file ${join(dataDir, 'accounts.json')}: ${(e as Error).message}`);
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
  app = hostedApp = createHostedApp({
    paypal, env, bindings, log, meterMcp, analyst, pins, intents, site, counters, accounts, identity, sessionSecret,
    origins: pub.origins,
    hosts: pub.hosts,
    https: pub.https,
    trustedHops: envInt(process.env, 'TRUSTED_PROXY_HOPS', 1),
    // X-Forwarded-For is believed only from a proxy on a private address (Render's), unless set to "any" or "none".
    proxyTrust: process.env.TRUSTED_PROXY_PEERS === 'any' ? 'any' : process.env.TRUSTED_PROXY_PEERS === 'none' ? 'none' : 'private',
    webhook,
  });
  log(`Hosted mode · ${pub.origins.join(', ')} · ${site.size} web files · PayPal sign-in ${identity ? 'on' : 'OFF'} · PayPal webhook ${webhook && paypal ? 'on' : 'OFF'} · data in ${dataDir}`);
} else {
  // Per-launch secret. Only the local Vite proxy reads this file and adds it to /api requests server-side, so the
  // browser never holds it and no other website can send it.
  const token = randomBytes(32).toString('hex');
  tokenFile = process.env.RESOLVEKIT_TOKEN_FILE ?? fileURLToPath(new URL('../.runtime-token', import.meta.url));
  writeFileSync(tokenFile, token, { mode: 0o600 });
  const allowedOrigins = process.env.RESOLVEKIT_ALLOWED_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean) ?? DEFAULT_ORIGINS;
  app = createApp({ paypal, env, bindings, log, port, token, allowedOrigins, meterMcp, analyst, pins, intents });
}

const server = createServer(toNodeListener(app, `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`));
server.listen(port, host, () => {
  log(`ResolveKit server on http://${host}:${port} · PayPal ${paypal ? env : 'unconfigured'} · ${Object.keys(bindings).length} bound case(s)`);
  log(`Analyst: ${analystConfig ? `${analystConfig.primary.provider}/${analystConfig.primary.model} (providers: ${analystConfig.available.join(', ')})` : 'no model key: stored analyses only'}`);
  for (const [caseId, b] of Object.entries(bindings)) log(`  ${caseId} → ${b.dispute}${b.capture ? ` · capture ${b.capture}` : " · no capture (cannot pass the send-time check)"}`);
  // Read and verify each bound dispute once in the background (logged); sending verifies again on its own fresh read.
  const cases = Object.fromEntries(Object.entries(CASE_FILES).map(([id, c]) => [id, { value: c.summary.amount, currency: c.summary.currency, transactionId: c.summary.transactionId }]));
  void checkBindings({ paypal, bindings, cases, log });
  // Hosted: analyse each bound case once in the background, so the seller's workspace finds an analysis ready.
  if (hostedApp) void hostedApp.warmUp();
});

// Hosted with bindings from a file (no BINDINGS_JSON): a changed file is picked up without a restart (BINDINGS_JSON
// changes restart the service on Render anyway). Invalid content is logged and ignored; the old bindings stay.
const watchBindings = hosted && !process.env.BINDINGS_JSON;
if (watchBindings) {
  watchFile(bindingsFile, { interval: 30_000 }, () => {
    let next: Record<string, Binding>;
    try {
      next = parseBindings(JSON.parse(readFileSync(bindingsFile, 'utf8')));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') next = {};
      else return log(`bindings file changed but is invalid, kept the old bindings: ${(e as Error).message}`);
    }
    if (JSON.stringify(next) === JSON.stringify(bindings)) return;
    for (const k of Object.keys(bindings)) delete bindings[k];
    Object.assign(bindings, next);
    log(`bindings changed · ${Object.keys(bindings).length} bound case(s)`);
    for (const [caseId, b] of Object.entries(bindings)) log(`  ${caseId} → ${b.dispute}${b.capture ? ` · capture ${b.capture}` : " · no capture (cannot pass the send-time check)"}`);
    void hostedApp?.bindingsChanged();
  });
}

const stop = () => {
  intents.flush();
  if (tokenFile) rmSync(tokenFile, { force: true });
  if (watchBindings) unwatchFile(bindingsFile);
  server.close(() => process.exit(0));
  server.closeAllConnections();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
