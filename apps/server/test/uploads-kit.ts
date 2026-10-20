/** Hosted-app helpers shared by the upload route tests: one app with the standard case bound, requests, answers. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DailyCounters } from '@resolvekit/hosting';
import { FileAnalysisStore, MemoryAnalysisStore, RateLimiter, type AnalysisInput, type AnalystModel, type CaseAnalysis } from '@resolvekit/analyst/node';
import { standardCase } from '@resolvekit/cases';
import { PayPalClient } from '@resolvekit/paypal';
import { fakeModel, standardScript } from '../../../packages/analyst/test/fake.ts';
import { AnalystService } from '../src/analysis.ts';
import { createHostedApp, type HostedLimits } from '../src/hosted.ts';
import { IntentStore } from '../src/intents.ts';
import { UploadStore } from '../src/uploads/store.ts';
import { MODEL, RESOLVED, STD_CAPTURE, TEST_SECRET, goldenFor, standardDispute, testAccounts } from './kit.ts';


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
    // The job polling of the PDF tests would hit the hosted API limiter (300 / 5 min) under a loaded full run.
    limits: { api: { limit: 100_000, windowMs: 600_000 }, uploadsPerIp: { limit: 1000, windowMs: 600_000 }, ...o.limits },
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
export type View = { id: string; status: string; evidenceId: string | null; kind: string; name: string; sha256: string | null; readLines?: string[]; lines: { text: string; correctedBy: string | null; original: string | null }[]; uploadedBy: { label: string } };
export type Answer = { upload: View; readLines: string[]; error?: string; uploads?: View[] };
export type App = ReturnType<typeof setup>['app'];
export const call = async (app: App, path: string, i: Init = {}) => {
  const r = await app(req(path, i));
  const ct = r.headers.get('content-type') ?? '';
  return { status: r.status, body: (ct.startsWith('application/json') ? await r.json() : null) as Answer, res: r };
};

/** Pasted text, as the upload route takes it. */
export const pasteText = (app: App, cookie: string, text = 'From: buyer\nThe parcel arrived, thanks.', name = 'email.txt') => call(app, P, { body: { text, name }, cookie });

// ------------------------------------------------------------------------------------- attachments and the send

/** A hosted app whose analyst serves the golden analysis (plus `extra` sentences) for whatever input it is asked about. */
/** `dispute`: fields over the standard dispute on every read (e.g. another status), read each time. */
export function sendSetup(o: { maxSendBytes?: number; dispute?: () => Record<string, unknown> } = {}) {
  const sends: FormData[] = [];
  /** Every write to PayPal (`METHOD path`, any non-GET but the OAuth token): provide-evidence, send-message, any action. */
  const writes: string[] = [];
  let hold: Promise<void> | null = null;
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
    const method = (init.method ?? 'GET').toUpperCase();
    if (method !== 'GET') writes.push(`${method} ${u.pathname}`);
    if (method !== 'GET' && !u.pathname.endsWith('/provide-evidence')) return new Response(JSON.stringify({ links: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.pathname.endsWith('/provide-evidence')) {
      sends.push(init.body as FormData);
      if (hold) await hold;
      return new Response(JSON.stringify({ links: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const id = decodeURIComponent(u.pathname.split('/').pop()!);
    return new Response(JSON.stringify({ ...standardDispute(), ...(o.dispute?.() ?? {}), dispute_id: id }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  const analyses = new MemoryAnalysisStore();
  const analyst = new AnalystService({ model: null, primaryModel: MODEL, store: analyses });
  const people = testAccounts();
  const store = new UploadStore({ dir: null });
  const intents = new IntentStore();
  const lines: string[] = [];
  const app = createHostedApp({
    paypal: new PayPalClient({ clientId: 'cid', clientSecret: 'secret', env: 'sandbox', fetch }),
    env: 'sandbox',
    bindings: { [CASE]: { dispute: REAL, capture: STD_CAPTURE } },
    log: (l) => lines.push(l),
    analyst,
    site: null,
    counters: new DailyCounters({ file: null, limits: { upload: 40, evidence: 10, message: 5 } }),
    accounts: people.accounts,
    identity: null,
    sessionSecret: TEST_SECRET,
    origins: [ORIGIN],
    hosts: [HOST],
    https: true,
    intents,
    uploads: store,
    ...(o.maxSendBytes ? { paypalMaxSendBytes: o.maxSendBytes } : {}),
    limits: { api: { limit: 100_000, windowMs: 600_000 }, uploadsPerIp: { limit: 1000, windowMs: 600_000 } },
  });
  /** The analysis of the case as `cookie` sees it now (the golden one, with `extra` sentences). */
  const analyse = async (cookie: string, extra: CaseAnalysis['sentences'] = []) => {
    const r = (await call(app, `/api/cases/${CASE}/analysis`, { body: {}, cookie })) as unknown as { body: { input: AnalysisInput } };
    assert.ok(r.body.input, JSON.stringify(r.body).slice(0, 300));
    const a = await goldenFor(CASE, r.body.input);
    analyses.cached.set(a.key, { ...a, sentences: [...a.sentences, ...extra] });
  };
  /** Pasted text, redacted (nothing removed) and confirmed with `lines` (default: as read). */
  const confirmText = async (cookie: string, text: string, name: string, lines?: string[]) => {
    const t = await pasteText(app, cookie, text, name);
    const red = await call(app, `${P}/${t.body.upload.id}/redact`, { body: { removals: [] }, cookie });
    const conf = await call(app, `${P}/${t.body.upload.id}/confirm`, { body: { lines: lines ?? red.body.readLines, sha256: red.body.upload.sha256 }, cookie });
    assert.equal(conf.status, 200, JSON.stringify(conf.body));
    return conf.body.upload;
  };
  const intent = (cookie: string, over: Record<string, unknown> = {}) =>
    call(app, `/api/disputes/${CASE}/intent`, { body: { evidenceType: 'PROOF_OF_FULFILLMENT', resolutions: RESOLVED, ...over }, cookie }) as unknown as Promise<{ status: number; body: SentIntent & { error?: string; detail?: string; blockers?: string[] } }>;
  const approved = async (cookie: string, over: Record<string, unknown> = {}) => {
    const i = await intent(cookie, over);
    assert.equal(i.status, 201, JSON.stringify(i.body));
    const a = await call(app, `/api/disputes/${CASE}/intent/${i.body.id}/approve`, { body: { contentHash: i.body.contentHash }, cookie });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    return i.body;
  };
  const send = (cookie: string, intentId: string) => call(app, `/api/disputes/${CASE}/evidence`, { body: { intentId }, cookie }) as unknown as Promise<{ status: number; body: { error?: string; detail?: string } }>;
  return { app, people, store, intents, lines, analyst, analyses, sends, writes, analyse, confirmText, intent, approved, send, holdSends: (p: Promise<void> | null) => (hold = p) };
}
export type SentIntent = { id: string; contentHash: string; status: string; files: { name: string; size: string; sha256?: string; source?: string }[] };
export const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
export const fileBytes = async (f: File) => new Uint8Array(await f.arrayBuffer());
