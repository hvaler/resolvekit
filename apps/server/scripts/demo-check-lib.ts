/**
 * What `npm run demo:check` concludes from what it observed (demo-check.ts fetches; this decides, without network):
 * one line per thing checked, and ready only when every line passed.
 */

export interface OpsBody {
  ok: boolean;
  problems: string[];
  paypal: string;
  webhook: 'on' | 'off' | string;
  bindings: Record<string, { dispute: string; capture: string | null; status: string; reasons: string[]; checkedAt: string | null; used?: boolean; reserve?: number }>;
  warmUp: Array<{ caseId: string; outcome: string; detail: string }> | null;
  models: Array<{ name: string; ok: boolean; error?: string }> | null;
}

export interface Observed {
  app: { healthz: number; landing: { status: number; html: string } };
  /** GET /api/ops/status?probe=models with the token. */
  ops: { status: number; body: OpsBody | null };
  meter: { healthz: number };
}

export interface Line {
  ok: boolean;
  /** Passed, but needs attention soon (e.g. the reserve of fresh disputes is running out). */
  warn?: boolean;
  what: string;
  detail: string;
}

export function evaluate(o: Observed): { ok: boolean; lines: Line[] } {
  const lines: Line[] = [];
  const add = (ok: boolean, what: string, detail = '') => lines.push({ ok, what, detail });

  add(o.app.healthz === 200, 'ResolveKit up (/healthz)', `HTTP ${o.app.healthz}`);
  add(o.app.landing.status === 200 && /ResolveKit/.test(o.app.landing.html), 'landing page', `HTTP ${o.app.landing.status}`);
  add(o.meter.healthz === 200, 'MeterMCP up (/healthz)', `HTTP ${o.meter.healthz}`);

  const b = o.ops.body;
  if (o.ops.status !== 200 || !b) {
    add(
      false,
      'operator check (/api/ops/status)',
      o.ops.status === 404
        ? 'HTTP 404: RESOLVEKIT_OPS_TOKEN is not set on the resolvekit service, or differs from the local .env'
        : `HTTP ${o.ops.status}`,
    );
    return { ok: false, lines };
  }

  // What passed, line by line; what failed, as the server words it (its `problems` are the authority).
  if (b.paypal !== 'unconfigured') add(true, 'PayPal connected', b.paypal);
  if (b.webhook === 'on') add(true, 'PayPal webhook', 'on');
  for (const [caseId, x] of Object.entries(b.bindings)) {
    if (x.status !== 'verified') continue;
    const left = x.reserve ?? 0;
    add(true, `binding ${caseId} → ${x.dispute}`, `verified · capture ${x.capture}${x.used ? ' · used' : ''} · ${left} in reserve`);
    if (left < 2) lines.push({ ok: true, warn: true, what: `reserve · case ${caseId}`, detail: `only ${left} fresh dispute${left === 1 ? '' : 's'} left in reserve: npm run demo:prepare and add them to BINDINGS_JSON` });
  }
  for (const m of b.models ?? []) if (m.ok) add(true, `AI model ${m.name}`, 'answered');
  if (b.warmUp === null) add(true, 'warm-up of the bound cases', 'not finished yet (runs after each start)');
  else for (const w of b.warmUp) if (w.outcome === 'done' || w.outcome === 'cached') add(true, `warm-up · case ${w.caseId}`, `${w.outcome} · ${w.detail}`);
  for (const p of b.problems) add(false, 'server reports', p);
  if (!b.ok && b.problems.length === 0) add(false, 'server reports', 'not ready (no reason given)');

  return { ok: lines.every((l) => l.ok), lines };
}
