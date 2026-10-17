import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, type Observed } from '../scripts/demo-check-lib.ts';

const goodOps = {
  ok: true,
  problems: [],
  paypal: 'sandbox',
  webhook: 'on',
  bindings: { 'PP-R-TVH-10190665': { dispute: 'PP-R-BGW-10193053', capture: '59U14501KS700990K', status: 'verified', reasons: [], checkedAt: '2026-10-17T12:00:00Z' } },
  warmUp: [{ caseId: 'PP-R-TVH-10190665', outcome: 'done', detail: 'system run · 26549 ms' }],
  models: [{ name: 'gemini/gemini-3.8-flash', ok: true }, { name: 'groq/openai/gpt-oss-120b', ok: true }],
};
const good = (): Observed => ({
  app: { healthz: 200, landing: { status: 200, html: '<!doctype html><title>ResolveKit</title>' } },
  ops: { status: 200, body: structuredClone(goodOps) },
  meter: { healthz: 200 },
});

test('everything up: ready, one line per thing checked', () => {
  const r = evaluate(good());
  assert.equal(r.ok, true, r.lines.map((l) => `${l.ok} ${l.what} ${l.detail}`).join('\n'));
  assert.ok(r.lines.some((l) => /binding PP-R-TVH-10190665/.test(l.what) && l.ok));
  assert.ok(r.lines.some((l) => /gemini/.test(l.what) && l.ok));
});

test('the ops route answers 404: the token is missing or different, said as such', () => {
  const o = good();
  o.ops = { status: 404, body: null };
  const r = evaluate(o);
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => !l.ok && /RESOLVEKIT_OPS_TOKEN/.test(l.detail)));
});

test('each problem the server reports is a failed line', () => {
  const o = good();
  o.ops.body = { ...goodOps, ok: false, problems: ['the PayPal webhook is off (PAYPAL_WEBHOOK_ID / PAYPAL_WEBHOOK_KEY)', 'AI model groq/openai/gpt-oss-120b: groq answered 401 invalid_api_key'], webhook: 'off', models: [goodOps.models[0]!, { name: 'groq/openai/gpt-oss-120b', ok: false, error: 'groq answered 401 invalid_api_key' }] };
  const r = evaluate(o);
  assert.equal(r.ok, false);
  const failed = r.lines.filter((l) => !l.ok).map((l) => l.detail).join(' | ');
  assert.match(failed, /webhook is off/);
  assert.match(failed, /401 invalid_api_key/);
});

test('the server says ok but MeterMCP or the landing is down: not ready', () => {
  const o = good();
  o.meter.healthz = 502;
  o.app.landing = { status: 200, html: 'Service unavailable' };
  const r = evaluate(o);
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => !l.ok && /MeterMCP/.test(l.what)));
  assert.ok(r.lines.some((l) => !l.ok && /landing/.test(l.what)));
});

test('no warm-up finished yet: said, not a failure (it runs after each start)', () => {
  const o = good();
  o.ops.body = { ...goodOps, warmUp: null };
  const r = evaluate(o);
  assert.equal(r.ok, true);
  assert.ok(r.lines.some((l) => /warm-up/.test(l.what) && /not finished/.test(l.detail)));
});
