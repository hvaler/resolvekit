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
 * DAILY_LIVE_ANALYSES (60) · DAILY_RECHECKS (200) · DAILY_EVIDENCE_SENDS (20) · DAILY_UPLOADS (40) · TRUSTED_PROXY_HOPS (1) ·
 * RESOLVEKIT_OPS_TOKEN (the operator's check, npm run demo:check) · DAILY_AGENT_RUNS (20) · DAILY_MESSAGE_SENDS (20) ·
 * DAILY_SETTLE_SENDS (20: accept, offer, escalate, appeal).
 * The buying agent (both modes): GEMINI_API_KEY / GROQ_API_KEY · AGENT_* run limits · RESOLVEKIT_PUBLIC_URL (falls back
 * to RENDER_EXTERNAL_URL) for PayPal's return to /agent?run=<id>; neither set: MeterMCP's own approval page.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DailyCounters, StaticSite, envInt, insecureOrigin, publicOrigins, paypalEnvFor, sweepDurableTmp, type ProxyTrust } from '@resolvekit/hosting';
import { PayPalClient, type PayPalEnv } from '@resolvekit/paypal';
import { CACHE_MAX_AGE_MS, CACHE_MAX_BYTES, FileAnalysisStore, RateLimiter, modelFromEnv, modelProbesFromEnv } from '@resolvekit/analyst/node';
import { agentModelsFromEnv, limitsFromEnv } from '@resolvekit/agent';
import { RunStore } from './agent/runs.ts';
import { AgentService, RECONCILE_EVERY_MS } from './agent/service.ts';
import { AccountStore } from './accounts.ts';
import { AnalystService, InputPins } from './analysis.ts';
import { createApp, DEFAULT_ORIGINS, type Handler } from './app.ts';
import { boundCaptureSet, checkBindings, parseBindingPools, type BindingPools } from './bindings.ts';
import { CASE_FILES } from './documents.ts';
import { AGENT_RUNS_PER_PERSON, createHostedApp, type HostedApp } from './hosted.ts';
import { PersonRunCaps } from './agent/person-caps.ts';
import { SellerMemory } from './sellers.ts';
import { WEBHOOK_KEY } from './webhook.ts';
import { IntentStore } from './intents.ts';
import { MeterMcpClient } from './metermcp.ts';
import { ReserveMemory, keepHeldActive } from './reserve.ts';
import { USAGE_MAX_AGE_MS, USAGE_MAX_BYTES, UsageLog } from './usage-log.ts';
import { RecheckVerdicts } from './verdicts.ts';
import { DAILY_UPLOADS } from './uploads/limits.ts';
import { closeOcr } from './uploads/ocr.ts';
import { UploadStore } from './uploads/store.ts';
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

// Every store of this server (intents, audit, accounts, caps, analyses, uploads, agent runs…). On Render this is the
// service's persistent disk.
const dataDir = process.env.RESOLVEKIT_DATA_DIR ?? fileURLToPath(new URL('../data/', import.meta.url));
// A crash in the middle of a durable write leaves `<file>.<pid>.<8 hex>.tmp` next to the store file: nothing reads it.
// Only that name, and only older than 10 min (never a write another process has in progress).
sweepDurableTmp(dataDir);

const bindingsFile = process.env.RESOLVEKIT_BINDINGS ?? (hosted ? join(dataDir, 'bindings.json') : fileURLToPath(new URL('../bindings.json', import.meta.url)));

function loadBindings(): BindingPools {
  // Hosted: BINDINGS_JSON (a secret env var) wins; otherwise a file. Never from a client.
  if (hosted && process.env.BINDINGS_JSON) {
    try {
      return parseBindingPools(JSON.parse(process.env.BINDINGS_JSON));
    } catch (e) {
      return fail(`BINDINGS_JSON: ${(e as Error).message}`);
    }
  }
  const file = bindingsFile;
  try {
    return parseBindingPools(JSON.parse(readFileSync(file, 'utf8')));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { bindings: {}, reserve: {} };
    if (hosted) return fail(`bindings file ${file}: ${(e as Error).message}`);
    console.error(`bindings: could not read ${file}: ${(e as Error).message}`);
    return { bindings: {}, reserve: {} };
  }
}

// The active binding of each case and its reserve; both change in place (rotation in app.ts, the watched file below).
const { bindings, reserve } = loadBindings();
// Submission intents (what the merchant approved, exactly) and the approval/send audit log: the server's record. Never
// expired by size or age beyond what intents.ts keeps (the send log is never compacted). Opened before the reserve is
// applied: its in-flight and uncertain disputes (seeded from the send log) are never skipped.
const intents = new IntentStore({ file: join(dataDir, 'intents.json'), eventsFile: join(dataDir, 'audit-events.jsonl'), log });
/** A dispute an action is still settling (in flight or unproven): rotation never moves a case off it. */
const held = (disputeId: string) => intents.held(disputeId);
// The disputes this server already moved each case past (reserve.ts): a restart starts after them, not at the first.
const reserveMemory = new ReserveMemory({ file: join(dataDir, 'reserve-position.json'), log });
for (const s of reserveMemory.apply({ bindings, reserve }, held)) log(`reserve · case ${s.caseId}: ${s.skipped.join(', ')} used before (reserve-position.json) → ${s.active}`);
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
// in <data>/analysis-cache; committed golden analyses answer for the demo documents. The cache and the usage log are
// bounded (swept at start and hourly with the uploads): ANALYSIS_CACHE_MAX_DAYS / _MAX_MB (unused for 30 days, 100 MiB)
// and ANALYST_USAGE_MAX_DAYS / _MAX_MB (90 days, 10 MiB). Floors: 1 day and 1 MiB (a value below, 0 or not a whole number
// gives the default), so a typo cannot empty the cache or the log on the next sweep.
const atLeast = (name: string, floor: number, dflt: number) => Math.max(floor, envInt(process.env, name, dflt));
const DAY = 86_400_000;
const MIB = 1024 * 1024;
const usageLog = new UsageLog({
  file: join(dataDir, 'analyst-usage.jsonl'),
  maxAgeMs: atLeast('ANALYST_USAGE_MAX_DAYS', 1, USAGE_MAX_AGE_MS / DAY) * DAY,
  maxBytes: atLeast('ANALYST_USAGE_MAX_MB', 1, USAGE_MAX_BYTES / MIB) * MIB,
});
const analysisCache = new FileAnalysisStore({
  dir: join(dataDir, 'analysis-cache'),
  maxAgeMs: atLeast('ANALYSIS_CACHE_MAX_DAYS', 1, CACHE_MAX_AGE_MS / DAY) * DAY,
  maxBytes: atLeast('ANALYSIS_CACHE_MAX_MB', 1, CACHE_MAX_BYTES / MIB) * MIB,
});
const analystConfig = modelFromEnv(process.env, { onFallback: (why) => log(`analyst fallback · ${why}`) });
const HOUR = 3_600_000;
const analyst = new AnalystService({
  model: analystConfig?.model ?? null,
  primaryModel: analystConfig?.primary.model ?? 'gemini-3.8-flash',
  store: analysisCache,
  liveLimit: new RateLimiter({ limit: envInt(process.env, 'LIVE_ANALYSES_PER_HOUR', 6), windowMs: HOUR }),
  verifyLimit: new RateLimiter({ limit: envInt(process.env, 'RECHECKS_PER_HOUR', 30), windowMs: HOUR }),
  log,
  // Token counts and timings only: no prompt or document text.
  onUsage: (caseId, u) => {
    log(`analyst call · ${u.stage} · ${u.provider}/${u.model} · in ${u.inputTokens} out ${u.outputTokens} thinking ${u.thinkingTokens} · ${u.ms} ms`);
    usageLog.append({ caseId, ...u });
  },
});

// The input each case was analysed with before the seller's evidence went in (see InputPins).
const pins = new InputPins({ file: join(dataDir, 'analysis-inputs.json'), log });

// The verifier's verdicts on edited sentences: a re-check made before a restart still counts (verdicts.ts).
const verdicts = new RecheckVerdicts({ file: join(dataDir, 'recheck-verdicts.json'), log });

// Merchant evidence uploads, outside any web-served path. At start and every hour, expired pending uploads and
// leftovers of interrupted writes are removed (counts only in the log; the routes also refuse an expired one at once),
// and the analysis cache and usage log are kept within their limits (above).
const uploads = new UploadStore({ dir: join(dataDir, 'uploads') });
const sweepStores = (when: string) => {
  try {
    const s = uploads.sweep();
    if (when === 'at start' || s.expired || s.orphans) log(`uploads · sweep ${when} · ${s.expired} expired · ${s.orphans} leftover(s) removed`);
    // Never deleted: kept on disk for a person to inspect and restore.
    if (s.corrupt) log(`ERROR uploads · sweep ${when} · ${s.corrupt} upload folder(s) with an unreadable record.json moved aside as <id>.corrupt-<time>`);
  } catch (e) {
    log(`uploads · sweep ${when} failed · ${(e as Error).name}`);
  }
  // The analysis cache and the usage log, with the same rhythm (counts only). Never the audit or send logs.
  try {
    const c = analysisCache.sweep();
    if (c.removed) log(`analysis cache · sweep ${when} · ${c.removed} unused analysis(es) removed · ${Math.round(c.bytes / 1024)} KB`);
  } catch (e) {
    log(`analysis cache · sweep ${when} failed · ${(e as Error).name}`);
  }
  try {
    const u = usageLog.sweep();
    if (u.dropped) log(`analyst usage log · sweep ${when} · ${u.dropped} old line(s) dropped`);
  } catch (e) {
    log(`analyst usage log · sweep ${when} failed · ${(e as Error).name}`);
  }
};
sweepStores('at start');
const uploadSweep = setInterval(() => sweepStores('hourly'), HOUR);
uploadSweep.unref();

// The buying agent: its runs on the data dir, each run its own MCP connection to MeterMCP's private /agent/mcp (hosted:
// with the admin token; local: MeterMCP on this machine needs only the run key). No model key: start answers
// MODEL_UNAVAILABLE. A run's PayPal approval returns to /agent?run=<id> on the public URL (none: MeterMCP's page).
const runStore = new RunStore({ dir: join(dataDir, 'agent-runs') });
const publicUrl = (process.env.RESOLVEKIT_PUBLIC_URL?.trim() || process.env.RENDER_EXTERNAL_URL?.trim() || '').replace(/\/$/, '');
const meterToken = process.env.METERMCP_ADMIN_TOKEN ?? '';
const agentModels = agentModelsFromEnv(process.env);
const agent = new AgentService({
  store: runStore,
  models: agentModels,
  meterUrl: meterMcp.agentMcpUrl,
  meterHeaders: (runId): Record<string, string> => (hosted ? { 'x-metermcp-token': meterToken, 'x-agent-run': runId } : { 'x-agent-run': runId }),
  meterAdmin: meterMcp,
  limits: limitsFromEnv(process.env),
  returnTo: (runId) => (publicUrl ? `${publicUrl}/agent?run=${runId}` : undefined),
  log,
});
const agentSweep = setInterval(() => {
  agent.reconcile().catch((e) => log(`agent runs · reconcile failed · ${(e as Error).message}`));
  try {
    // A run whose capture is bound (active or reserve, read now: the bindings change in place) is never swept.
    const gone = runStore.sweep(boundCaptureSet({ bindings, reserve }));
    if (gone.length) log(`agent runs · sweep · ${gone.length} run(s) older than 30 days removed`);
  } catch (e) {
    log(`agent runs · sweep failed · ${(e as Error).message}`);
  }
}, RECONCILE_EVERY_MS);
agentSweep.unref();

/** How the client address is derived behind the proxy: hosted.ts's per-IP limits and node.ts's large-body slots. */
const clientAddress = {
  trustedHops: envInt(process.env, 'TRUSTED_PROXY_HOPS', 1),
  // X-Forwarded-For is believed only from a proxy on a private address (Render's), unless set to "any" or "none".
  proxyTrust: (process.env.TRUSTED_PROXY_PEERS === 'any' ? 'any' : process.env.TRUSTED_PROXY_PEERS === 'none' ? 'none' : 'private') as ProxyTrust,
};

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
  // The operator's check (npm run demo:check → GET /api/ops/status): off without the token.
  const opsToken = process.env.RESOLVEKIT_OPS_TOKEN?.trim() || null;
  if (opsToken && !WEBHOOK_KEY.test(opsToken)) fail('RESOLVEKIT_OPS_TOKEN must be 32+ URL-safe characters');
  // Workspaces, people, passkeys and invites. An unreadable file stops the start (it would drop every membership).
  let accounts: AccountStore;
  try {
    accounts = new AccountStore({ file: join(dataDir, 'accounts.json') });
  } catch (e) {
    accounts = fail(`accounts file ${join(dataDir, 'accounts.json')}: ${(e as Error).message}`);
  }
  // The sellers of the bound disputes seen so far: an unreadable sandbox does not demote the evaluation workspace.
  let sellerMemory: SellerMemory;
  try {
    sellerMemory = new SellerMemory({ file: join(dataDir, 'sellers.json'), log });
  } catch (e) {
    sellerMemory = fail(`sellers file ${join(dataDir, 'sellers.json')}: ${(e as Error).message}`);
  }
  const dist = process.env.RESOLVEKIT_WEB_DIST ?? fileURLToPath(new URL('../../web/dist/', import.meta.url));
  if (!existsSync(join(dist, 'index.html'))) fail(`no web build at ${dist} (run npm run build)`);
  const counters = new DailyCounters({
    file: join(dataDir, 'daily-caps.json'),
    limits: {
      'live-analysis': envInt(process.env, 'DAILY_LIVE_ANALYSES', 60),
      recheck: envInt(process.env, 'DAILY_RECHECKS', 200),
      evidence: envInt(process.env, 'DAILY_EVIDENCE_SENDS', 20),
      upload: envInt(process.env, 'DAILY_UPLOADS', DAILY_UPLOADS),
      'agent-run': envInt(process.env, 'DAILY_AGENT_RUNS', 20),
      message: envInt(process.env, 'DAILY_MESSAGE_SENDS', 20),
      settle: envInt(process.env, 'DAILY_SETTLE_SENDS', 20),
    },
  });
  if (!meterToken) log('WARNING: METERMCP_ADMIN_TOKEN is not set: agent runs cannot authenticate to MeterMCP (/agent/mcp) and will stop as meter_unavailable; receipts and settlement through the admin routes fail too');
  const site = StaticSite.load(dist);
  app = hostedApp = createHostedApp({
    paypal, env, bindings, reserve, reserveMemory, verdicts, log, meterMcp, analyst, pins, intents, uploads, site, counters, accounts, sellerMemory, identity, sessionSecret,
    origins: pub.origins,
    hosts: pub.hosts,
    https: pub.https,
    ...clientAddress,
    webhook,
    opsToken,
    modelProbes: modelProbesFromEnv(process.env),
    agent,
    agentRunsPerPerson: new PersonRunCaps({ file: join(dataDir, 'agent-run-caps.json'), limit: AGENT_RUNS_PER_PERSON }),
  });
  log(`Hosted mode · ${pub.origins.join(', ')} · ${site.size} web files · PayPal sign-in ${identity ? 'on' : 'OFF'} · PayPal webhook ${webhook && paypal ? 'on' : 'OFF'} · ops check ${opsToken ? 'on' : 'OFF'} · data in ${dataDir}`);
} else {
  // Per-launch secret. Only the local Vite proxy reads this file and adds it to /api requests server-side, so the
  // browser never holds it and no other website can send it.
  const token = randomBytes(32).toString('hex');
  tokenFile = process.env.RESOLVEKIT_TOKEN_FILE ?? fileURLToPath(new URL('../.runtime-token', import.meta.url));
  writeFileSync(tokenFile, token, { mode: 0o600 });
  const allowedOrigins = process.env.RESOLVEKIT_ALLOWED_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean) ?? DEFAULT_ORIGINS;
  app = createApp({ paypal, env, bindings, reserve, reserveMemory, verdicts, log, port, token, allowedOrigins, meterMcp, analyst, pins, intents, uploads, agent });
}

// Runs a previous process left unfinished become interrupted and are settled, in the background: not awaited, so a
// MeterMCP that is down does not delay listening.
agent.recover().catch((e) => log(`agent runs · recovery failed · ${(e as Error).message}`));

// The listener derives the client address as hosted mode does (one large upload body per address at a time).
const server = createServer(toNodeListener(app, `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`, { ...(hosted ? clientAddress : {}), log }));
server.listen(port, host, () => {
  log(`ResolveKit server on http://${host}:${port} · PayPal ${paypal ? env : 'unconfigured'} · ${Object.keys(bindings).length} bound case(s)`);
  log(`Agent: ${agentModels ? `${agentModels.primary.provider}/${agentModels.primary.model}${agentModels.fallback ? ` (fallback ${agentModels.fallback.provider})` : ''}` : 'no model key: runs refused'} · return ${publicUrl ? `${publicUrl}/agent` : 'MeterMCP approval page'}`);
  log(`Analyst: ${analystConfig ? `${analystConfig.primary.provider}/${analystConfig.primary.model} (providers: ${analystConfig.available.join(', ')})` : 'no model key: stored analyses only'}`);
  for (const [caseId, b] of Object.entries(bindings)) log(`  ${caseId} → ${b.dispute}${b.capture ? ` · capture ${b.capture}` : " · no capture (cannot pass the send-time check)"}${reserve[caseId]?.length ? ` · ${reserve[caseId]!.length} in reserve` : ''}`);
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
    let next: BindingPools;
    try {
      next = parseBindingPools(JSON.parse(readFileSync(bindingsFile, 'utf8')));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') next = { bindings: {}, reserve: {} };
      else return log(`bindings file changed but is invalid, kept the old bindings: ${(e as Error).message}`);
    }
    // The disputes already used are skipped in the new lists too, before comparing with what is active now.
    // A held active dispute stays active even when the new file lists it elsewhere (never moved off mid-settlement).
    const kept = keepHeldActive({ bindings, reserve }, next, held);
    const skipped = reserveMemory.apply(next, held);
    if (JSON.stringify(next) === JSON.stringify({ bindings, reserve })) return;
    for (const k of kept) log(`reserve · case ${k.caseId}: ${k.active} is held by an action still settling → kept active`);
    for (const s of skipped) log(`reserve · case ${s.caseId}: ${s.skipped.join(', ')} used before (reserve-position.json) → ${s.active}`);
    for (const k of Object.keys(bindings)) delete bindings[k];
    for (const k of Object.keys(reserve)) delete reserve[k];
    Object.assign(bindings, next.bindings);
    Object.assign(reserve, next.reserve);
    log(`bindings changed · ${Object.keys(bindings).length} bound case(s)`);
    for (const [caseId, b] of Object.entries(bindings)) log(`  ${caseId} → ${b.dispute}${b.capture ? ` · capture ${b.capture}` : " · no capture (cannot pass the send-time check)"}${reserve[caseId]?.length ? ` · ${reserve[caseId]!.length} in reserve` : ''}`);
    void hostedApp?.bindingsChanged();
  });
}

/** The agent's loops end first (interrupted, settled) within 20 s, then everything else. */
const AGENT_STOP_MS = 20_000;
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  clearInterval(agentSweep);
  void Promise.race([agent.stop(), new Promise((r) => setTimeout(r, AGENT_STOP_MS).unref())])
    .catch((e) => log(`agent runs · stop failed · ${(e as Error).message}`))
    .finally(closeAll);
};
const closeAll = () => {
  intents.flush();
  clearInterval(uploadSweep);
  void closeOcr();
  if (tokenFile) rmSync(tokenFile, { force: true });
  if (watchBindings) unwatchFile(bindingsFile);
  server.close(() => process.exit(0));
  server.closeAllConnections();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
