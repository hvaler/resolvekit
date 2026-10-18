/**
 * Three environments, task 2: hosted case routes answer only bound cases, and only to the seller's workspace;
 * everything else is 404 UNKNOWN_CASE before any model call, PayPal call, store write or cap reservation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DailyCounters, StaticSite } from '@resolvekit/hosting';
import { MemoryAnalysisStore, RateLimiter, type AnalysisInput } from '@resolvekit/analyst/node';
import { caseInput, standardCase } from '@resolvekit/cases';
import { PayPalClient } from '@resolvekit/paypal';
import { fakeModel, standardScript } from '../../../packages/analyst/test/fake.ts';
import { SYNTHETIC_HEADER } from '../src/documents.ts';
import { AnalystService } from '../src/analysis.ts';
import { createApp, DEFAULT_ORIGINS, TOKEN_HEADER } from '../src/app.ts';
import { createHostedApp } from '../src/hosted.ts';
import { toSnapshot } from '../src/mapping.ts';
import { RESOLVED, STD_CAPTURE, TEST_SECRET, goldenFor, standardDispute, testAccounts } from './kit.ts';

const ORIGIN = 'https://rk.example.com';
const HOST = 'rk.example.com';
const CASE = standardCase.summary.id;
const DEMO = 'PP-R-PLN-10189901';
const REAL = 'PP-R-REAL-1';
const KEY = 'a'.repeat(64);

function stubs(store = new MemoryAnalysisStore()) {
  const calls: string[] = [];
  const sent: FormData[] = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    calls.push(`${init.method ?? 'GET'} ${u.pathname}`);
    if (u.pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
    if (u.pathname.endsWith('/provide-evidence')) sent.push(init.body as FormData);
    if (u.pathname.endsWith('/provide-evidence')) return new Response(JSON.stringify({ links: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(standardDispute()), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  const fm = fakeModel(standardScript);
  const analyst = new AnalystService({
    model: fm.model,
    primaryModel: 'gemini-3.8-flash',
    store,
    liveLimit: new RateLimiter({ limit: 50, windowMs: 3_600_000 }),
    verifyLimit: new RateLimiter({ limit: 50, windowMs: 3_600_000 }),
  });
  return { calls, sent, fm, analyst, client: new PayPalClient({ clientId: 'cid', clientSecret: 'secret', env: 'sandbox', fetch }) };
}

function hosted(store?: MemoryAnalysisStore) {
  const s = stubs(store);
  const people = testAccounts();
  const app = createHostedApp({
    paypal: s.client,
    env: 'sandbox',
    bindings: { [CASE]: { dispute: REAL, capture: STD_CAPTURE } },
    log: () => {},
    analyst: s.analyst,
    site: new StaticSite([['/index.html', new TextEncoder().encode('<!doctype html><div id="root"></div>')]]),
    counters: new DailyCounters({ file: null, limits: { 'live-analysis': 5, recheck: 5, evidence: 5 } }),
    accounts: people.accounts,
    identity: null,
    sessionSecret: TEST_SECRET,
    origins: [ORIGIN],
    hosts: [HOST],
    https: true,
  });
  return { app, people, ...s };
}

const req = (method: string, path: string, cookie?: string) =>
  new Request(ORIGIN + path, {
    method,
    headers: { host: HOST, 'x-forwarded-for': '203.0.113.7', ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });

/** Every case route this task gates, as [method, path template]. */
const ROUTES: Array<[string, (id: string) => string]> = [
  ['GET', (id) => `/api/disputes/${id}`],
  ['POST', (id) => `/api/disputes/${id}/intent`],
  ['GET', (id) => `/api/disputes/${id}/audit`],
  ['POST', (id) => `/api/disputes/${id}/evidence`],
  ['GET', (id) => `/api/cases/${id}/analysis`],
  ['POST', (id) => `/api/cases/${id}/analysis`],
  ['GET', (id) => `/api/cases/${id}/analysis/progress?key=${KEY}`],
  ['POST', (id) => `/api/cases/${id}/analysis/verify`],
  ['GET', (id) => `/api/cases/${id}/uploads`],
  ['POST', (id) => `/api/cases/${id}/uploads`],
];

for (const [method, path] of ROUTES) {
  const label = `${method} ${path(':id').replace(/\?.*/, '')}`;
  test(`${label}: bound case, another workspace → 404 UNKNOWN_CASE, no analyst or PayPal work`, async () => {
    const h = hosted();
    const before = h.calls.length;
    const r = await h.app(req(method, path(CASE), h.people.outsider()));
    assert.equal(r.status, 404);
    assert.equal(((await r.json()) as { error: string }).error, 'UNKNOWN_CASE');
    assert.equal(h.fm.requests.length, 0);
    assert.equal(h.calls.slice(before).filter((c) => c.startsWith('POST') && !c.includes('oauth2')).length, 0);
  });
  test(`${label}: bound case, signed out → 404 UNKNOWN_CASE`, async () => {
    const h = hosted();
    const r = await h.app(req(method, path(CASE)));
    assert.equal(r.status, 404);
    assert.equal(((await r.json()) as { error: string }).error, 'UNKNOWN_CASE');
  });
  test(`${label}: unbound demo case, seller workspace → 404 UNKNOWN_CASE`, async () => {
    const h = hosted();
    const r = await h.app(req(method, path(DEMO), h.people.ownerCookie));
    assert.equal(r.status, 404);
    assert.equal(((await r.json()) as { error: string }).error, 'UNKNOWN_CASE');
  });
  test(`${label}: bound case, seller workspace → not 404 UNKNOWN_CASE`, async () => {
    const h = hosted();
    const r = await h.app(req(method, path(CASE), h.people.ownerCookie));
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    assert.notEqual(body.error, 'UNKNOWN_CASE', `status ${r.status}`);
  });
}

test('local mode: an unbound case still has intents and analysis', async () => {
  const s = stubs();
  const app = createApp({ paypal: s.client, env: 'sandbox', bindings: {}, log: () => {}, port: 8787, token: 'a'.repeat(64), allowedOrigins: DEFAULT_ORIGINS, analyst: s.analyst });
  const r = await app(new Request(`http://127.0.0.1:8787/api/cases/${CASE}/analysis?x=1`, { headers: { [TOKEN_HEADER]: 'a'.repeat(64) } }));
  assert.notEqual(((await r.json().catch(() => ({}))) as { error?: string }).error, 'UNKNOWN_CASE');
  const a = await app(new Request(`http://127.0.0.1:8787/api/disputes/${DEMO}/audit`, { headers: { [TOKEN_HEADER]: 'a'.repeat(64) } }));
  assert.equal(a.status, 200);
});

test('every PDF composed for a bound standard case says SYNTHETIC TEST DOCUMENT on every page', async () => {
  const input: AnalysisInput = caseInput(standardCase, { kind: 'live', snap: toSnapshot(standardDispute(), CASE, 'sandbox', new Date()), failed: null });
  const store = new MemoryAnalysisStore();
  const g = await goldenFor(CASE, input);
  store.cached.set(g.key, g);
  const h = hosted(store);
  const cookie = h.people.ownerCookie;
  const post = (path: string, body: unknown) => h.app(new Request(ORIGIN + path, { method: 'POST', headers: { host: HOST, 'x-forwarded-for': '203.0.113.7', origin: ORIGIN, 'content-type': 'application/json', cookie }, body: JSON.stringify(body) }));
  const c = await post(`/api/disputes/${CASE}/intent`, { evidenceType: 'PROOF_OF_FULFILLMENT', resolutions: RESOLVED });
  const i = (await c.json()) as { id: string; contentHash: string };
  assert.equal(c.status, 201, JSON.stringify(i));
  assert.equal((await post(`/api/disputes/${CASE}/intent/${i.id}/approve`, { contentHash: i.contentHash })).status, 200);
  assert.equal((await post(`/api/disputes/${CASE}/evidence`, { intentId: i.id })).status, 202);
  assert.equal(h.sent.length, 1);
  const pdfs = h.sent[0]!.getAll('evidence-file').filter((f): f is File => typeof f !== 'string' && f.type === 'application/pdf');
  assert.ok(pdfs.length > 0, 'the intent sends at least one PDF');
  for (const f of pdfs) {
    const text = new TextDecoder('latin1').decode(await f.arrayBuffer());
    const pages = (text.match(/\/Type \/Page(?![s\w])/g) ?? []).length;
    assert.ok(pages > 0, `${f.name}: has pages`);
    assert.equal(text.split(SYNTHETIC_HEADER).length - 1, pages, `${f.name}: header on every page`);
  }
});
