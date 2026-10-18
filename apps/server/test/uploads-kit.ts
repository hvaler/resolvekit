/** Hosted-app helpers shared by the upload route tests: one app with the standard case bound, requests, answers. */
import { DailyCounters } from '@resolvekit/hosting';
import { FileAnalysisStore, MemoryAnalysisStore, RateLimiter, type AnalystModel } from '@resolvekit/analyst/node';
import { standardCase } from '@resolvekit/cases';
import { PayPalClient } from '@resolvekit/paypal';
import { fakeModel, standardScript } from '../../../packages/analyst/test/fake.ts';
import { AnalystService } from '../src/analysis.ts';
import { createHostedApp, type HostedLimits } from '../src/hosted.ts';
import { IntentStore } from '../src/intents.ts';
import { UploadStore } from '../src/uploads/store.ts';
import { STD_CAPTURE, TEST_SECRET, standardDispute, testAccounts } from './kit.ts';


export const ORIGIN = 'https://rk.example.com';
export const HOST = 'rk.example.com';
export const CASE = standardCase.summary.id;
export const REAL = 'PP-R-REAL-1';
export const TIMEOUT = { timeout: 120_000 };

export function setup(o: { caps?: Record<string, number>; capsFile?: string; limits?: Partial<HostedLimits>; storageBytes?: number; storedFileBytes?: number; analysisDir?: string; script?: Parameters<typeof fakeModel>[0]; model?: (m: AnalystModel) => AnalystModel } = {}) {
  const calls: string[] = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    calls.push(`${init.method ?? 'GET'} ${u.pathname}`);
    if (u.pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
    const id = decodeURIComponent(u.pathname.split('/').pop()!);
    return new Response(JSON.stringify({ ...standardDispute(), dispute_id: id }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  const fm = fakeModel(o.script ?? standardScript);
  const analyst = new AnalystService({
    model: o.model ? o.model(fm.model) : fm.model,
    primaryModel: 'gemini-3.8-flash',
    store: o.analysisDir ? new FileAnalysisStore({ dir: o.analysisDir, golden: new Map() }) : new MemoryAnalysisStore(),
    liveLimit: new RateLimiter({ limit: 50, windowMs: 3_600_000 }),
    verifyLimit: new RateLimiter({ limit: 50, windowMs: 3_600_000 }),
  });
  const people = testAccounts();
  const lines: string[] = [];
  const store = new UploadStore({ dir: null });
  const intents = new IntentStore();
  const bindings: Record<string, { dispute: string; capture: string }> = { [CASE]: { dispute: REAL, capture: STD_CAPTURE } };
  const counters = new DailyCounters({ file: o.capsFile ?? null, limits: { upload: 40, ...o.caps } });
  const app = createHostedApp({
    paypal: new PayPalClient({ clientId: 'cid', clientSecret: 'secret', env: 'sandbox', fetch }),
    env: 'sandbox',
    bindings,
    log: (l) => lines.push(l),
    analyst,
    site: null,
    counters,
    accounts: people.accounts,
    identity: null,
    sessionSecret: TEST_SECRET,
    origins: [ORIGIN],
    hosts: [HOST],
    https: true,
    intents,
    uploads: store,
    ...(o.storageBytes ? { uploadStorageBytes: o.storageBytes } : {}),
    ...(o.storedFileBytes ? { uploadStoredFileBytes: o.storedFileBytes } : {}),
    limits: { uploadsPerIp: { limit: 1000, windowMs: 600_000 }, ...o.limits },
  });
  return { app, calls, model: fm, people, lines, store, intents, bindings, counters, analyst };
}

export type Init = { method?: string; body?: unknown; type?: string; cookie?: string; headers?: Record<string, string> };
export const req = (path: string, i: Init = {}) => {
  const method = i.method ?? (i.body !== undefined ? 'POST' : 'GET');
  const raw = i.body instanceof Uint8Array;
  const headers: Record<string, string> = {
    host: HOST,
    'x-forwarded-for': '203.0.113.7',
    ...(method !== 'GET' ? { origin: ORIGIN } : {}),
    ...(i.body !== undefined ? { 'content-type': i.type ?? 'application/json' } : {}),
    ...(i.cookie ? { cookie: i.cookie } : {}),
    ...i.headers,
  };
  const body = i.body === undefined ? undefined : raw ? (i.body as Uint8Array) : typeof i.body === 'string' ? i.body : JSON.stringify(i.body);
  return new Request(ORIGIN + path, { method, headers, ...(body !== undefined ? { body: body as BodyInit } : {}) });
};
export const P = `/api/cases/${CASE}/uploads`;
export type View = { id: string; status: string; evidenceId: string | null; kind: string; name: string; sha256: string | null; lines: { text: string; correctedBy: string | null; original: string | null }[]; uploadedBy: { label: string } };
export type Answer = { upload: View; readLines: string[]; error?: string; uploads?: View[] };
export type App = ReturnType<typeof setup>['app'];
export const call = async (app: App, path: string, i: Init = {}) => {
  const r = await app(req(path, i));
  const ct = r.headers.get('content-type') ?? '';
  return { status: r.status, body: (ct.startsWith('application/json') ? await r.json() : null) as Answer, res: r };
};
