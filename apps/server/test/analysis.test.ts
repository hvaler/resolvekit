import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryAnalysisStore, RateLimiter, analysisKey, buildInput, type CaseAnalysis } from '@resolvekit/analyst/node';
import { standardCase } from '../../web/src/fixtures/standardCase.ts';
import { fakeModel, standardScript } from '../../../packages/analyst/test/fake.ts';
import { AnalystService } from '../src/analysis.ts';
import { createApp, DEFAULT_ORIGINS, TOKEN_HEADER } from '../src/app.ts';

const CASE = standardCase.summary.id;
const TOKEN = 'a'.repeat(64);
const BASE = 'http://127.0.0.1:8787';
const input = () => buildInput(standardCase);

function setup(o: { model?: boolean; liveLimit?: number; store?: MemoryAnalysisStore; script?: Record<string, unknown> } = {}) {
  const store = o.store ?? new MemoryAnalysisStore();
  const lines: string[] = [];
  const fm = fakeModel(o.script ?? standardScript);
  const analyst = new AnalystService({
    model: o.model === false ? null : fm.model,
    primaryModel: 'gemini-3.8-flash',
    store,
    liveLimit: new RateLimiter({ limit: o.liveLimit ?? 6, windowMs: 3_600_000 }),
    log: (l) => lines.push(l),
  });
  const app = createApp({ paypal: null, env: 'sandbox', bindings: {}, port: 8787, token: TOKEN, allowedOrigins: DEFAULT_ORIGINS, analyst, log: (l) => lines.push(l) });
  return { app, store, lines, requests: fm.requests };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(BASE + path, { method: 'POST', headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json', origin: 'http://127.0.0.1:4173', ...headers }, body: JSON.stringify(body) });
const get = (path: string) => new Request(BASE + path, { headers: { [TOKEN_HEADER]: TOKEN } });
const analysisPath = `/api/cases/${CASE}/analysis`;

async function waitReady(app: ReturnType<typeof setup>['app'], key: string) {
  for (let i = 0; i < 50; i++) {
    const r = await app(get(`${analysisPath}/progress?key=${key}`));
    const b = (await r.json()) as { status: string };
    if (b.status !== 'running') return b as { status: string; origin?: string; analysis?: CaseAnalysis; progress?: Array<{ stage: string }> };
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error('analysis did not finish');
}

test('analysis API: same guards as the rest of the API (token, Host, Origin, JSON only)', async () => {
  const { app } = setup();
  assert.equal((await app(new Request(BASE + analysisPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))).status, 401);
  assert.equal((await app(post(analysisPath, { input: input() }, { host: 'evil.example:8787' }))).status, 403);
  assert.equal((await app(post(analysisPath, { input: input() }, { origin: 'https://evil.example' }))).status, 403);
  assert.equal((await app(post(analysisPath, { input: input() }, { 'content-type': 'text/plain' }))).status, 415);
});

test('analysis API: unknown case, bad input, mismatched case id', async () => {
  const { app } = setup();
  assert.equal((await app(post('/api/cases/PP-R-NOPE/analysis', { input: input() }))).status, 404);
  const bad = await app(post(analysisPath, { input: { ...input(), documents: 'x' } }));
  assert.equal(bad.status, 400);
  const other = await app(post(analysisPath, { input: { ...input(), caseId: 'PP-R-OTHER' } }));
  assert.equal(other.status, 400);
  const tooMany = await app(post(analysisPath, { input: { ...input(), merchantNotes: Array.from({ length: 11 }, (_, i) => ({ id: `N${i}`, text: 'x' })) } }));
  assert.equal(tooMany.status, 400);
});

test('analysis API: a stored (golden) analysis is returned without calling the model', async () => {
  const store = new MemoryAnalysisStore();
  const key = await analysisKey(input(), 'gemini-3.8-flash');
  store.golden.set(key, { key, caseId: CASE } as CaseAnalysis);
  const { app, requests } = setup({ store });
  const r = await app(post(analysisPath, { input: input() }));
  assert.equal(r.status, 200);
  const b = (await r.json()) as { status: string; origin: string; key: string; live: { configured: boolean; remaining: number } };
  assert.deepEqual([b.status, b.origin, b.key], ['ready', 'golden', key]);
  assert.deepEqual([b.live.configured, b.live.remaining], [true, 6]);
  assert.equal(requests.length, 0);
});

test('analysis API: no stored analysis → live run with progress, then cached; refresh=1 forces a new run', async () => {
  const { app, store, lines } = setup();
  const r = await app(post(analysisPath, { input: input() }));
  assert.equal(r.status, 202);
  const b = (await r.json()) as { status: string; key: string };
  assert.equal(b.status, 'running');
  const done = await waitReady(app, b.key);
  assert.equal(done.status, 'ready');
  assert.equal(done.origin, 'live');
  assert.deepEqual(
    done.progress!.map((p) => p.stage),
    ['read', 'extract', 'timeline', 'contradictions', 'draft', 'verify', 'ready'],
  );
  assert.ok(store.cached.has(b.key));
  // Next time it is the cache.
  const again = (await (await app(post(analysisPath, { input: input() }))).json()) as { status: string; origin: string };
  assert.deepEqual([again.status, again.origin], ['ready', 'cache']);
  // Forced live run.
  assert.equal((await app(post(`${analysisPath}?refresh=1`, { input: input() }))).status, 202);
  // Logs carry counts, never document text.
  assert.ok(lines.some((l) => l.startsWith('analysis done')));
  assert.ok(!lines.some((l) => l.includes('Example Street') || l.includes('ignore the tracking')));
});

test('analysis API: live runs are rate-limited per process (429 with the reset time)', async () => {
  const { app } = setup({ liveLimit: 1 });
  assert.equal((await app(post(`${analysisPath}?refresh=1`, { input: input() }))).status, 202);
  const b0 = (await (await app(post(`${analysisPath}?refresh=1`, { input: input() }))).json()) as { key: string };
  await waitReady(app, b0.key);
  const r = await app(post(`${analysisPath}?refresh=1`, { input: input() }));
  assert.equal(r.status, 429);
  const b = (await r.json()) as { error: string; live: { remaining: number; resetInSec: number } };
  assert.equal(b.error, 'RATE_LIMITED');
  assert.equal(b.live.remaining, 0);
  assert.ok(b.live.resetInSec > 0);
});

test('analysis API: without a model key, stored analyses still answer and a live run says why it cannot', async () => {
  const { app } = setup({ model: false });
  const r = await app(post(analysisPath, { input: input() }));
  assert.equal(r.status, 503);
  assert.equal(((await r.json()) as { error: string }).error, 'ANALYST_UNCONFIGURED');
});

test('analysis API: verify re-checks an edited sentence against the analysis of the same documents', async () => {
  const { app } = setup();
  const b = (await (await app(post(analysisPath, { input: input() }))).json()) as { key: string };
  await waitReady(app, b.key);
  // The fake model has no "recheck" script: the route reports the failure instead of inventing a verdict.
  const failed = await app(post(`${analysisPath}/verify`, { input: input(), text: 'UPS delivered to Apt 4B.' }));
  assert.equal(failed.status, 502);
  assert.equal((await app(post(`${analysisPath}/verify`, { input: input(), text: '' }))).status, 400);
  const changed = input();
  changed.documents[1]!.lines[0]!.text = 'changed';
  assert.equal((await app(post(`${analysisPath}/verify`, { input: changed, text: 'x' }))).status, 404);
});

test('analysis API: verify answers the verdict and the citations the verifier chose', async () => {
  const { app } = setup({ script: { ...standardScript, recheck: { facts: ['F2', 'F5'], verdict: 'supported', reason: '', rewrite: '' } } });
  const b = (await (await app(post(analysisPath, { input: input() }))).json()) as { key: string };
  await waitReady(app, b.key);
  const r = await app(post(`${analysisPath}/verify`, { input: input(), text: 'UPS delivered to Apt 4B; the order lists Apt 4.' }));
  assert.equal(r.status, 200);
  const v = (await r.json()) as { verdict: string; citations: Array<{ doc: string; valid: boolean }>; model: string };
  assert.equal(v.verdict, 'supported');
  assert.deepEqual(v.citations.map((c) => [c.doc, c.valid]), [['E1', true], ['E3', true]]);
  assert.equal(v.model, 'fake-1');
});
