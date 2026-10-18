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
import { writePdf } from '@resolvekit/pdf';
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
    if (u.pathname.endsWith('/provide-evidence')) {
      sent.push(init.body as FormData);
      return new Response(JSON.stringify({ links: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
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

/**
 * Page by page: every `/Type /Page` object's content stream must carry the header. Assumes the writer's content
 * streams are plain text (no filter), so the header is readable in the bytes; a `/FlateDecode` fails loudly. Returns
 * the page count.
 */
function headerPerPage(name: string, bytes: Uint8Array): number {
  const text = new TextDecoder('latin1').decode(bytes);
  assert.ok(!text.includes('/FlateDecode'), `${name}: compressed content streams; inflate them before scanning`);
  const objs = new Map<number, string>();
  for (const m of text.matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj/g)) objs.set(Number(m[1]), m[2]!);
  const pages = [...objs.values()].filter((o) => /\/Type \/Page(?![s\w])/.test(o));
  assert.ok(pages.length > 0, `${name}: has pages`);
  pages.forEach((p, i) => {
    const ref = /\/Contents (\d+) 0 R/.exec(p);
    assert.ok(ref, `${name}: page ${i + 1} has a content stream`);
    assert.ok(objs.get(Number(ref[1]))!.includes(`(${SYNTHETIC_HEADER})`), `${name}: header on page ${i + 1} of ${pages.length}`);
  });
  return pages.length;
}

test('the page-by-page check sees a header missing from a later page of a multi-page PDF', () => {
  const lines = Array.from({ length: 130 }, (_, i) => `line ${i}`);
  assert.equal(headerPerPage('with header', writePdf({ header: SYNTHETIC_HEADER, title: 't', lines })), 3);
  assert.throws(() => headerPerPage('no header', writePdf({ title: 't', lines })), /header on page 1 of 3/);
  // The header is cut from page 2's content stream only: pages 1 and 3 still carry it, and page 2 is the one named.
  const later = withoutHeaderOnPage(writePdf({ header: SYNTHETIC_HEADER, title: 't', lines }), 2);
  assert.throws(() => headerPerPage('page 2 without header', later), /header on page 2 of 3/);
});

/** The PDF with the synthetic header blanked out (same length) in the content stream of page `n` only. */
function withoutHeaderOnPage(bytes: Uint8Array, n: number): Uint8Array {
  const text = new TextDecoder('latin1').decode(bytes);
  const objs = [...text.matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj/g)];
  const pages = objs.filter((m) => /\/Type \/Page(?![s\w])/.test(m[2]!));
  const contents = /\/Contents (\d+) 0 R/.exec(pages[n - 1]![2]!)![1];
  const target = objs.find((m) => m[1] === contents)!;
  const blanked = target[0].replace(`(${SYNTHETIC_HEADER})`, `(${'X'.repeat(SYNTHETIC_HEADER.length)})`);
  assert.notEqual(blanked, target[0], `page ${n} carried the header`);
  const out = text.slice(0, target.index) + blanked + text.slice(target.index! + target[0].length);
  return Uint8Array.from(out, (c) => c.charCodeAt(0));
}

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
  const counts: number[] = [];
  for (const f of pdfs) counts.push(headerPerPage(f.name, new Uint8Array(await f.arrayBuffer())));
  // Today's standard-case PDFs are one page each; the multi-page case is covered by the test above (same writePdf).
  assert.ok(counts.length >= 1);
});
