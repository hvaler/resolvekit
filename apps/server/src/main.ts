/**
 * ResolveKit server: `npm run server` (from the repo root). Loads the repo-root .env through `node --env-file`,
 * listens on 127.0.0.1 only, and serves /api for the web app (Vite proxies /api here in dev and preview).
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { PayPalClient, type PayPalEnv } from '@resolvekit/paypal';
import { FileAnalysisStore, modelFromEnv } from '@resolvekit/analyst/node';
import { AnalystService } from './analysis.ts';
import { createApp, DEFAULT_ORIGINS } from './app.ts';
import { checkBindings } from './bindings.ts';
import { CASE_FILES } from './documents.ts';
import { MeterMcpClient } from './metermcp.ts';
import { toNodeListener } from './node.ts';

const env: PayPalEnv = process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox';
const clientId = process.env.PAYPAL_CLIENT_ID;
const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
const paypal = clientId && clientSecret ? new PayPalClient({ clientId, clientSecret, env, timeoutMs: 30_000 }) : null;

function loadBindings(): Record<string, string> {
  const file = process.env.RESOLVEKIT_BINDINGS ?? fileURLToPath(new URL('../bindings.json', import.meta.url));
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => !e[0].startsWith('_') && typeof e[1] === 'string' && e[1].length > 0));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`bindings: could not read ${file}: ${(e as Error).message}`);
    return {};
  }
}

const bindings = loadBindings();
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const port = Number(process.env.PORT ?? 8787);
const host = '127.0.0.1';

// Per-launch secret. Only the local Vite proxy reads this file and adds it to /api requests server-side, so the
// browser never holds it and no other website can send it.
const token = randomBytes(32).toString('hex');
const tokenFile = process.env.RESOLVEKIT_TOKEN_FILE ?? fileURLToPath(new URL('../.runtime-token', import.meta.url));
writeFileSync(tokenFile, token, { mode: 0o600 });
const allowedOrigins = process.env.RESOLVEKIT_ALLOWED_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean) ?? DEFAULT_ORIGINS;

// MeterMCP on this machine (apps/metermcp): the agent case's real session receipt, read server-to-server.
const meterMcp = new MeterMcpClient({
  base: process.env.METERMCP_URL ?? 'http://127.0.0.1:8790',
  tokenFile: process.env.METERMCP_TOKEN_FILE ?? fileURLToPath(new URL('../../metermcp/.runtime-token', import.meta.url)),
});

// The AI analyst: Gemini (primary) with Groq as automatic fallback, keys from the environment. Live runs are cached
// in apps/server/data/analysis-cache (git-ignored); committed golden analyses answer for the demo documents.
const dataDir = fileURLToPath(new URL('../data/', import.meta.url));
const usageFile = fileURLToPath(new URL('../data/analyst-usage.jsonl', import.meta.url));
const analystConfig = modelFromEnv(process.env, { onFallback: (why) => log(`analyst fallback · ${why}`) });
const analyst = new AnalystService({
  model: analystConfig?.model ?? null,
  primaryModel: analystConfig?.primary.model ?? 'gemini-3.8-flash',
  store: new FileAnalysisStore({ dir: fileURLToPath(new URL('../data/analysis-cache/', import.meta.url)) }),
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

const app = createApp({ paypal, env, bindings, log, port, token, allowedOrigins, meterMcp, analyst });
const server = createServer(toNodeListener(app, `http://${host}:${port}`));
server.listen(port, host, () => {
  log(`ResolveKit server on http://${host}:${port} · PayPal ${paypal ? env : 'unconfigured'} · ${Object.keys(bindings).length} bound case(s)`);
  log(`Analyst: ${analystConfig ? `${analystConfig.primary.provider}/${analystConfig.primary.model} (providers: ${analystConfig.available.join(', ')})` : 'no model key: stored analyses only'}`);
  for (const [caseId, disputeId] of Object.entries(bindings)) log(`  ${caseId} → ${disputeId}`);
  // Read each bound dispute once in the background and warn if its amount is not the demo case's order amount.
  const caseOrders = Object.fromEntries(Object.entries(CASE_FILES).map(([id, c]) => [id, { value: c.summary.amount, currency: c.summary.currency }]));
  void checkBindings({ paypal, bindings, caseOrders, log });
});

const stop = () => {
  rmSync(tokenFile, { force: true });
  server.close(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
