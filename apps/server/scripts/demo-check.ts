/**
 * `npm run demo:check` — is the hosted demo ready for a judge, right now? Read-only: nothing is created or sent.
 *
 *   ResolveKit /healthz and the landing page · MeterMCP /healthz · GET /api/ops/status?probe=models with
 *   RESOLVEKIT_OPS_TOKEN: PayPal connected, the webhook on, each binding verified on a fresh PayPal read, each AI
 *   provider answering one tiny call, the last warm-up of the bound cases.
 *
 *   npm run demo:check -- [--app URL] [--metermcp URL] [--no-models]
 *
 * Exit 0 when every line passed, 1 otherwise. Run it after each deploy and daily during judging. The token comes
 * from .env (node --env-file-if-exists) and is never printed.
 */
import { evaluate, type Observed, type OpsBody } from './demo-check-lib.ts';

const DEFAULT_APP = 'https://resolvekit-i3j2.onrender.com';
const DEFAULT_METERMCP = 'https://resolvekit-metermcp.onrender.com';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return (i >= 0 ? args[i + 1] : undefined) ?? fallback;
};
const app = opt('--app', DEFAULT_APP).replace(/\/+$/, '');
const meter = opt('--metermcp', DEFAULT_METERMCP).replace(/\/+$/, '').replace(/\/mcp$/, '');
const probe = !args.includes('--no-models');

async function get(url: string, headers: Record<string, string> = {}, timeoutMs = 60_000): Promise<{ status: number; text: string }> {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    return { status: 0, text: e instanceof Error ? e.message : String(e) };
  }
}

async function main() {
  const token = process.env.RESOLVEKIT_OPS_TOKEN?.trim();
  if (!token) {
    console.error('[demo:check] RESOLVEKIT_OPS_TOKEN is not set (.env): it must be the same as on the resolvekit service');
    process.exitCode = 2;
    return;
  }
  console.log(`[demo:check] ${app} · ${meter}${probe ? '' : ' · models not probed'}`);
  const [healthz, landing, ops, meterHealthz] = await Promise.all([
    get(`${app}/healthz`),
    get(`${app}/`),
    get(`${app}/api/ops/status${probe ? '?probe=models' : ''}`, { authorization: `Bearer ${token}` }, 120_000),
    get(`${meter}/healthz`),
  ]);
  let body: OpsBody | null = null;
  if (ops.status === 200) {
    try {
      body = JSON.parse(ops.text) as OpsBody;
    } catch {
      body = null;
    }
  }
  const observed: Observed = {
    app: { healthz: healthz.status, landing: { status: landing.status, html: landing.text } },
    ops: { status: ops.status, body },
    meter: { healthz: meterHealthz.status },
  };
  const r = evaluate(observed);
  for (const l of r.lines) console.log(`  ${!l.ok ? 'FAIL' : l.warn ? 'WARN' : 'PASS'}  ${l.what}${l.detail ? ` · ${l.detail}` : ''}`);
  console.log(r.ok ? '[demo:check] READY: a judge can use the demo now.' : '[demo:check] NOT READY: fix the FAIL lines above.');
  process.exitCode = r.ok ? 0 : 1;
}

main().catch((e) => {
  console.error(`[demo:check] failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
