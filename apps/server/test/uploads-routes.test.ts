import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { request as httpRequest, createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { DailyCounters } from '@resolvekit/hosting';
import { MemoryAnalysisStore, RateLimiter } from '@resolvekit/analyst/node';
import { standardCase } from '@resolvekit/cases';
import { PayPalClient } from '@resolvekit/paypal';
import { fakeModel, standardScript } from '../../../packages/analyst/test/fake.ts';
import { AnalystService } from '../src/analysis.ts';
import { createApi, createApp, type ActingPerson } from '../src/app.ts';
import { createHostedApp, type HostedLimits } from '../src/hosted.ts';
import { IntentStore } from '../src/intents.ts';
import { toNodeListener } from '../src/node.ts';
import { sanitiseImage, type Rect } from '../src/uploads/image.ts';
import { MAX_FILE_BYTES } from '../src/uploads/limits.ts';
import { closeOcr, ocrPng } from '../src/uploads/ocr.ts';
import { canDeleteUpload, canEditUpload } from '../src/uploads/permissions.ts';
import { UploadStore, type UploadRecord } from '../src/uploads/store.ts';
import { STD_CAPTURE, TEST_SECRET, standardDispute, testAccounts } from './kit.ts';

after(() => closeOcr());

const person = (o: Partial<ActingPerson>): ActingPerson => ({ id: 'p1', name: 'Ana', label: 'Ana (member)', workspaceId: 'ws1', role: 'member', reviewer: false, ...o });
const upload = (by: string) => ({ uploadedBy: { id: by, label: 'x', name: 'x' } }) as UploadRecord;

test('permissions: an owner edits and deletes any upload', () => {
  const owner = person({ role: 'owner' });
  assert.equal(canEditUpload(owner, upload('someone-else')), true);
  assert.equal(canDeleteUpload(owner), true);
});

test('permissions: an owner flagged as a reviewer is still an owner', () => {
  const owner = person({ role: 'owner', reviewer: true });
  assert.equal(canEditUpload(owner, upload('someone-else')), true);
  assert.equal(canDeleteUpload(owner), true);
});

test('permissions: a full member edits and deletes any upload', () => {
  const member = person({ role: 'member', reviewer: false });
  assert.equal(canEditUpload(member, upload('someone-else')), true);
  assert.equal(canDeleteUpload(member), true);
});

test('permissions: a reviewer edits only their own upload and never deletes', () => {
  const reviewer = person({ role: 'member', reviewer: true });
  assert.equal(canEditUpload(reviewer, upload('p1')), true);
  assert.equal(canEditUpload(reviewer, upload('someone-else')), false);
  assert.equal(canDeleteUpload(reviewer), false);
});

test('local mode (no gate): the acting person is the local operator, an owner and not a reviewer', () => {
  const fetch = (async () => new Response('{}', { status: 200 })) as typeof globalThis.fetch;
  const api = createApi({ paypal: new PayPalClient({ clientId: 'cid', clientSecret: 'secret', env: 'sandbox', fetch }), env: 'sandbox', bindings: {}, analyst: null });
  assert.deepEqual(api.personOf(new Request('http://localhost/api/x')), { id: 'local', name: 'local operator', label: 'local operator', workspaceId: 'local', role: 'owner', reviewer: false });
});

// ------------------------------------------------------------------------------------------------ the routes

const ORIGIN = 'https://rk.example.com';
const HOST = 'rk.example.com';
const CASE = standardCase.summary.id;
const REAL = 'PP-R-REAL-1';
const TRACKING = '1Z999AA10123456784';
const SECRET_WORDS = 'Account 9988776655 balance 4321.09 SECRETWORD';
const fixture = new Uint8Array(readFileSync(new URL('./fixtures/tracking.png', import.meta.url)));
const TIMEOUT = { timeout: 120_000 };

function setup(o: { caps?: Record<string, number>; capsFile?: string; limits?: Partial<HostedLimits>; storageBytes?: number } = {}) {
  const calls: string[] = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    calls.push(`${init.method ?? 'GET'} ${u.pathname}`);
    if (u.pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
    const id = decodeURIComponent(u.pathname.split('/').pop()!);
    return new Response(JSON.stringify({ ...standardDispute(), dispute_id: id }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  const fm = fakeModel(standardScript);
  const analyst = new AnalystService({
    model: fm.model,
    primaryModel: 'gemini-3.8-flash',
    store: new MemoryAnalysisStore(),
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
    limits: { uploadsPerIp: { limit: 1000, windowMs: 600_000 }, ...o.limits },
  });
  return { app, calls, model: fm, people, lines, store, intents, bindings, counters };
}

type Init = { method?: string; body?: unknown; type?: string; cookie?: string; headers?: Record<string, string> };
const req = (path: string, i: Init = {}) => {
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
const P = `/api/cases/${CASE}/uploads`;
type View = { id: string; status: string; evidenceId: string | null; kind: string; name: string; sha256: string | null; lines: { text: string; correctedBy: string | null; original: string | null }[]; uploadedBy: { label: string } };
type Answer = { upload: View; readLines: string[]; error?: string; uploads?: View[] };
type App = ReturnType<typeof setup>['app'];
const call = async (app: App, path: string, i: Init = {}) => {
  const r = await app(req(path, i));
  const ct = r.headers.get('content-type') ?? '';
  return { status: r.status, body: (ct.startsWith('application/json') ? await r.json() : null) as Answer, res: r };
};
const uploadPng = (app: App, cookie: string, bytes: Uint8Array = fixture, type = 'image/png') => call(app, P, { body: bytes, type, cookie, headers: { 'x-upload-name': 'tracking.png' } });
const pasteText = (app: App, cookie: string, text = 'From: buyer\nThe parcel arrived, thanks.', name = 'email.txt') => call(app, P, { body: { text, name }, cookie });

let trackingBox: Rect | null = null;
/** Where OCR finds the tracking number on the fixture (what the person covers in the web app). */
async function trackingRect(): Promise<Rect> {
  trackingBox ??= (await ocrPng(fixture)).find((l) => l.text.includes(TRACKING))!.box;
  return trackingBox;
}

test("a reviewer of the seller's workspace uploads a PNG; another workspace and a signed-out visitor are refused (403/401)", TIMEOUT, async () => {
  // PayPal reads are limited to 1 per IP: the uploads routes must not count as PayPal reads.
  const { app, people } = setup({ limits: { paypalReads: { limit: 1, windowMs: 600_000 } } });
  const reviewer = people.member('Rita Reviewer');
  const r = await uploadPng(app, reviewer);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.upload.status, 'pending');
  assert.equal(r.body.upload.kind, 'image');
  assert.equal(r.body.upload.name, 'tracking.png');
  assert.equal(r.body.upload.evidenceId, null);
  assert.ok(r.body.readLines.some((l) => l.includes(TRACKING)), JSON.stringify(r.body.readLines));

  for (let i = 0; i < 3; i++) {
    const list = await call(app, P, { cookie: reviewer });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.uploads!.map((u) => u.id), [r.body.upload.id]);
  }
  const outsider = people.outsider();
  assert.equal((await uploadPng(app, outsider)).status, 403);
  assert.equal((await uploadPng(app, '')).status, 401);
  assert.equal((await call(app, P, { cookie: outsider })).status, 403);
  assert.equal((await call(app, P)).status, 401);
  assert.equal((await call(app, `${P}/${r.body.upload.id}/image?v=original`, { cookie: outsider })).status, 403);
  assert.equal((await call(app, `${P}/${r.body.upload.id}/discard`, { body: {}, cookie: outsider })).status, 403);
  assert.equal((await call(app, `/api/cases/NOPE-1/uploads`, { cookie: reviewer })).status, 404);
  // The original is shown back to the person who can edit it.
  const img = await app(req(`${P}/${r.body.upload.id}/image?v=original`, { cookie: reviewer }));
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.deepEqual(new Uint8Array(await img.arrayBuffer()), fixture);
});

test('a JPEG upload is accepted, and its sanitised file is a fresh PNG', TIMEOUT, async () => {
  const { app, people } = setup();
  const cookie = people.fullMember();
  const w = 64, h = 32;
  const jpg = new Uint8Array(jpeg.encode({ data: Buffer.alloc(w * h * 4, 255), width: w, height: h }, 90).data);
  const r = await uploadPng(app, cookie, jpg, 'image/jpeg');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const red = await call(app, `${P}/${r.body.upload.id}/redact`, { body: { rects: [{ x: 0, y: 0, w: 10, h: 10 }] }, cookie });
  assert.equal(red.status, 200, JSON.stringify(red.body));
  const original = await app(req(`${P}/${r.body.upload.id}/image?v=original`, { cookie }));
  assert.equal(original.headers.get('content-type'), 'image/jpeg');
  const img = await app(req(`${P}/${r.body.upload.id}/image?v=sanitised`, { cookie }));
  assert.equal(img.headers.get('content-type'), 'image/png');
  const png = PNG.sync.read(Buffer.from(await img.arrayBuffer()));
  assert.deepEqual([...png.data.subarray(0, 4)], [0, 0, 0, 255]);
});

test("the upload's content reaches no external service before confirmation", TIMEOUT, async () => {
  const { app, people, calls, model } = setup();
  const cookie = people.member();
  // Signing in reads the bound dispute once (who the seller is); that read has nothing of any upload.
  assert.equal((await call(app, P, { cookie })).status, 200);
  const before = calls.length;
  const realFetch = globalThis.fetch;
  const stray: string[] = [];
  globalThis.fetch = (async (u: string | URL) => (stray.push(String(u)), new Response('{}'))) as typeof fetch;
  try {
    const img = await uploadPng(app, cookie);
    assert.equal(img.status, 201);
    assert.equal((await call(app, `${P}/${img.body.upload.id}/redact`, { body: { rects: [await trackingRect()] }, cookie })).status, 200);
    const txt = await pasteText(app, cookie, SECRET_WORDS);
    assert.equal(txt.status, 201);
    assert.equal((await call(app, `${P}/${txt.body.upload.id}/redact`, { body: { removals: [{ start: 8, end: 18 }] }, cookie })).status, 200);
    assert.equal((await call(app, P, { cookie })).status, 200);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(calls.slice(before), []);
  assert.deepEqual(stray, []);
  assert.equal(model.requests.length, 0);
});

/** POST with these headers, write `chunks` without ending the body, and resolve on the response. */
function rawPost(server: Server, path: string, headers: Record<string, string | number>, chunks: Buffer[]): Promise<{ status: number; body: string; connection?: string }> {
  const { port } = server.address() as { port: number };
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, connection: res.headers.connection }));
      res.on('error', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    r.on('error', (e) => reject(e));
    for (const c of chunks) r.write(c);
  });
}

test('a 6 MB body is refused before it is read whole (413) and a GIF is refused (415)', TIMEOUT, async () => {
  let handled = 0;
  const seen: number[] = [];
  const server = createServer(toNodeListener(async (r) => (handled++, seen.push((await r.arrayBuffer()).byteLength), new Response('{}', { status: 200 })), 'http://127.0.0.1'));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    // Declared 6 MB, only 1 KB sent: refused on the header alone.
    const declared = await rawPost(server, P, { 'content-type': 'image/png', 'content-length': 6 * 1024 * 1024 }, [Buffer.alloc(1024)]);
    assert.equal(declared.status, 413);
    assert.match(declared.body, /BODY_TOO_LARGE/);
    assert.equal(declared.connection, 'close');
    // Chunked, no length, the body never ended: refused once the limit is passed.
    const chunked = await rawPost(server, P, { 'content-type': 'image/png', 'transfer-encoding': 'chunked' }, Array.from({ length: 6 }, () => Buffer.alloc(1024 * 1024)));
    assert.equal(chunked.status, 413);
    assert.equal(handled, 0);
    // 300 KB: fine on the upload route, too large anywhere else.
    const body = Buffer.alloc(300 * 1024);
    const ok = await new Promise<number>((resolve) => {
      const r = httpRequest({ host: '127.0.0.1', port: (server.address() as { port: number }).port, path: P, method: 'POST', headers: { 'content-type': 'image/png', 'content-length': body.length } }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
      r.end(body);
    });
    assert.equal(ok, 200);
    assert.deepEqual(seen, [body.length]);
    const other = await rawPost(server, `/api/disputes/${CASE}/intent`, { 'content-type': 'application/json', 'content-length': body.length }, [body]);
    assert.equal(other.status, 413);
    // The upload route's 5 MB are for images of a real case only.
    const asJson = await rawPost(server, P, { 'content-type': 'application/json', 'content-length': body.length }, [body]);
    assert.equal(asJson.status, 413);
    const noCase = await rawPost(server, '/api/cases/constructor/uploads', { 'content-type': 'image/png', 'content-length': body.length }, [body]);
    assert.equal(noCase.status, 413);
    assert.equal(handled, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
  }

  const { app, people } = setup();
  const cookie = people.member();
  // Handed straight to the app (no node listener): still refused.
  assert.equal((await uploadPng(app, cookie, new Uint8Array(MAX_FILE_BYTES + 1))).status, 413);
  const gif = new TextEncoder().encode('GIF89a\x01\x00\x01\x00\x00\x00\x00;');
  assert.equal((await uploadPng(app, cookie, gif, 'image/gif')).status, 415);
  const disguised = await uploadPng(app, cookie, gif, 'image/png');
  assert.equal(disguised.status, 415);
  assert.equal(disguised.body.error, 'UNSUPPORTED_TYPE');
  // Image bodies are for the upload route only.
  assert.equal((await call(app, `/api/disputes/${CASE}/intent`, { body: fixture, type: 'image/png', cookie })).status, 415);
});

test('redact then confirm: the stored file is the sanitised PNG, the original is gone, E7 is assigned', TIMEOUT, async () => {
  const { app, people, store } = setup();
  const cookie = people.member('Rita Reviewer');
  const up = await uploadPng(app, cookie);
  const id = up.body.upload.id;
  const box = await trackingRect();
  // Confirming before redacting (even with nothing to cover) is refused: there is no sanitised file yet.
  assert.equal((await call(app, `${P}/${id}/confirm`, { body: { lines: [], sha256: 'a'.repeat(64) }, cookie })).status, 409);
  const red = await call(app, `${P}/${id}/redact`, { body: { rects: [box] }, cookie });
  assert.equal(red.status, 200, JSON.stringify(red.body));
  assert.equal(red.body.upload.status, 'reviewing');
  assert.ok(!red.body.readLines.some((l) => l.includes('1Z999')), JSON.stringify(red.body.readLines));
  const expected = sanitiseImage(fixture, [box]);
  assert.equal(red.body.upload.sha256, expected.sha256);

  const lines = [...red.body.readLines];
  const fix = lines.findIndex((l) => l.length > 0);
  lines[fix] = `${lines[fix]} (fixed)`;
  const conf = await call(app, `${P}/${id}/confirm`, { body: { lines, sha256: red.body.upload.sha256 }, cookie });
  assert.equal(conf.status, 200, JSON.stringify(conf.body));
  assert.equal(conf.body.upload.status, 'confirmed');
  assert.equal(conf.body.upload.evidenceId, 'E7');
  assert.equal(conf.body.upload.lines[fix]!.correctedBy, up.body.upload.uploadedBy.label);
  assert.equal(conf.body.upload.lines[fix]!.original, red.body.readLines[fix]);
  assert.ok(conf.body.upload.lines.every((l, i) => i === fix || (l.correctedBy === null && l.original === null)));

  assert.equal(store.original(id), null);
  assert.deepEqual(store.sanitised(id), expected.png);
  const img = await app(req(`${P}/${id}/image?v=sanitised`, { cookie }));
  assert.deepEqual(new Uint8Array(await img.arrayBuffer()), expected.png);
  assert.equal((await call(app, `${P}/${id}/image?v=original`, { cookie })).status, 404);
  // Covered pixels are black in what is stored.
  const png = PNG.sync.read(Buffer.from(expected.png));
  const at = ((box.y + 2) * png.width + box.x + 2) * 4;
  assert.deepEqual([...png.data.subarray(at, at + 4)], [0, 0, 0, 255]);
  // A confirmed upload is not redacted or discarded again.
  assert.equal((await call(app, `${P}/${id}/redact`, { body: { rects: [] }, cookie })).status, 409);
  assert.equal((await call(app, `${P}/${id}/discard`, { body: {}, cookie })).status, 409);

  // The next confirmed upload is E8.
  const t = await pasteText(app, cookie);
  const tr = await call(app, `${P}/${t.body.upload.id}/redact`, { body: { removals: [] }, cookie });
  const tc = await call(app, `${P}/${t.body.upload.id}/confirm`, { body: { lines: tr.body.readLines, sha256: tr.body.upload.sha256 }, cookie });
  assert.equal(tc.body.upload.evidenceId, 'E8');
  assert.deepEqual(tc.body.upload.lines.map((l) => l.text), ['From: buyer', 'The parcel arrived, thanks.']);
  assert.equal(store.get(t.body.upload.id)!.mime, 'application/pdf');
});

test('rectangles, removals and pasted text are checked at the door', TIMEOUT, async () => {
  const { app, people, store } = setup();
  const cookie = people.fullMember();
  const img = await uploadPng(app, cookie);
  const bad = [
    { rects: [{ x: -1, y: 0, w: 5, h: 5 }] },
    { rects: [{ x: 1.5, y: 0, w: 5, h: 5 }] },
    { rects: [{ x: 1, y: 0, w: 5 }] },
    { rects: 'all' },
    { rects: Array.from({ length: 201 }, () => ({ x: 0, y: 0, w: 1, h: 1 })) },
    { removals: [{ start: 0, end: 1 }] },
  ];
  for (const b of bad) {
    const r = await call(app, `${P}/${img.body.upload.id}/redact`, { body: b, cookie });
    assert.deepEqual([r.status, r.body.error], [400, 'BAD_REDACTION'], JSON.stringify(b).slice(0, 80));
  }

  const empty = await pasteText(app, cookie, '  \n\t ');
  assert.deepEqual([empty.status, empty.body.error], [400, 'EMPTY_TEXT']);
  assert.equal((await pasteText(app, cookie, 'x'.repeat(20_001))).status, 413);
  const ctl = await pasteText(app, cookie, 'a\u0007b\r\nc\td‮e');
  assert.equal(ctl.status, 201);
  assert.deepEqual(ctl.body.readLines, ['a b', 'c\td e']);
  assert.equal((await call(app, `${P}/${ctl.body.upload.id}/redact`, { body: { removals: [{ start: 0, end: 99 }] }, cookie })).status, 422);
  assert.equal((await call(app, `${P}/${ctl.body.upload.id}/redact`, { body: { rects: [] }, cookie })).status, 400);
  const ok = await call(app, `${P}/${ctl.body.upload.id}/redact`, { body: { removals: [{ start: 0, end: 1 }] }, cookie });
  assert.deepEqual(ok.body.readLines, ['[redacted] b', 'c\td e']);
  // Confirmed lines are checked too.
  const conf = (lines: unknown) => call(app, `${P}/${ctl.body.upload.id}/confirm`, { body: { lines, sha256: ok.body.upload.sha256 }, cookie });
  assert.equal((await conf(['only one'])).status, 400);
  assert.equal((await conf(['a\nb', 'c'])).status, 400);
  assert.equal((await conf('nope')).status, 400);
  assert.equal(store.get(ctl.body.upload.id)!.status, 'reviewing');
  // The lines as read (a tab included) are confirmed as they are.
  assert.equal((await conf(ok.body.readLines)).status, 200);
});

test("a reviewer cannot redact or confirm someone else's upload; owner and full member can; only owner and full member delete", TIMEOUT, async () => {
  const { app, people, store } = setup();
  const a = people.member('Reviewer A');
  const b = people.member('Reviewer B');
  const full = people.fullMember('Full Member');
  const owner = people.ownerCookie;
  const up = await uploadPng(app, a);
  const id = up.body.upload.id;
  assert.equal((await call(app, `${P}/${id}/redact`, { body: { rects: [] }, cookie: b })).status, 403);
  assert.equal((await call(app, `${P}/${id}/image?v=original`, { cookie: b })).status, 403);
  assert.equal((await call(app, `${P}/${id}/discard`, { body: {}, cookie: b })).status, 403);
  // Everyone in the workspace sees it, and its sanitised file once there is one.
  assert.equal((await call(app, P, { cookie: b })).body.uploads!.length, 1);
  const red = await call(app, `${P}/${id}/redact`, { body: { rects: [] }, cookie: owner });
  assert.equal(red.status, 200);
  assert.equal((await call(app, `${P}/${id}/image?v=sanitised`, { cookie: b })).res.status, 200);
  assert.equal((await call(app, `${P}/${id}/confirm`, { body: { lines: red.body.readLines, sha256: red.body.upload.sha256 }, cookie: b })).status, 403);
  const conf = await call(app, `${P}/${id}/confirm`, { body: { lines: red.body.readLines, sha256: red.body.upload.sha256 }, cookie: full });
  assert.equal(conf.status, 200);
  assert.equal(conf.body.upload.evidenceId, 'E7');
  // Reviewers never delete, not even their own.
  assert.equal((await call(app, `${P}/${id}`, { method: 'DELETE', cookie: a })).status, 403);
  assert.equal((await call(app, `${P}/${id}`, { method: 'DELETE', cookie: full })).status, 200);
  assert.equal(store.get(id)!.status, 'deleted');
  assert.equal(store.sanitised(id), null);
  assert.equal((await call(app, P, { cookie: a })).body.uploads!.length, 0);
  assert.equal((await call(app, `${P}/${id}`, { method: 'DELETE', cookie: owner })).status, 404);
  // The owner deletes a reviewer's pending upload; the reviewer discards their own.
  const t1 = await pasteText(app, a);
  assert.equal((await call(app, `${P}/${t1.body.upload.id}`, { method: 'DELETE', cookie: owner })).status, 200);
  const t2 = await pasteText(app, a);
  const d = await call(app, `${P}/${t2.body.upload.id}/discard`, { body: {}, cookie: a });
  assert.equal(d.status, 200);
  assert.equal(d.body.upload.status, 'discarded');
  assert.equal(store.original(t2.body.upload.id), null);
});

test('confirm with a stale sha256 is refused (UPLOAD_CHANGED)', TIMEOUT, async () => {
  const { app, people } = setup();
  const cookie = people.fullMember();
  const t = await pasteText(app, cookie, 'line one\nline two');
  const first = await call(app, `${P}/${t.body.upload.id}/redact`, { body: { removals: [] }, cookie });
  const second = await call(app, `${P}/${t.body.upload.id}/redact`, { body: { removals: [{ start: 0, end: 4 }] }, cookie });
  assert.notEqual(first.body.upload.sha256, second.body.upload.sha256);
  const stale = await call(app, `${P}/${t.body.upload.id}/confirm`, { body: { lines: second.body.readLines, sha256: first.body.upload.sha256 }, cookie });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'UPLOAD_CHANGED');
  assert.equal((await call(app, `${P}/${t.body.upload.id}/confirm`, { body: { lines: second.body.readLines, sha256: second.body.upload.sha256 }, cookie })).status, 200);
});

test('an upload made for one dispute cannot be confirmed after the case moved to another (UPLOAD_ARCHIVED)', TIMEOUT, async () => {
  const { app, people, bindings } = setup();
  const cookie = people.fullMember();
  const t = await pasteText(app, cookie);
  const red = await call(app, `${P}/${t.body.upload.id}/redact`, { body: { removals: [] }, cookie });
  bindings[CASE] = { dispute: 'PP-R-NEXT-2', capture: STD_CAPTURE };
  const conf = await call(app, `${P}/${t.body.upload.id}/confirm`, { body: { lines: red.body.readLines, sha256: red.body.upload.sha256 }, cookie });
  assert.equal(conf.status, 409);
  assert.equal(conf.body.error, 'UPLOAD_ARCHIVED');
  // The new dispute's list starts empty.
  assert.equal((await call(app, P, { cookie })).body.uploads!.length, 0);
});

test('the 41st upload of the day is refused (DAILY_CAP) and an unwritable caps file refuses it (CAPS_UNAVAILABLE)', TIMEOUT, async () => {
  const { app, people } = setup();
  const cookie = people.fullMember();
  for (let i = 0; i < 40; i++) {
    const t = await pasteText(app, cookie, `note ${i}`);
    assert.equal(t.status, 201, `upload ${i + 1}: ${JSON.stringify(t.body)}`);
    // Discarded uploads do not count towards the per-case limit, only towards the day's.
    assert.equal((await call(app, `${P}/${t.body.upload.id}/discard`, { body: {}, cookie })).status, 200);
  }
  const over = await pasteText(app, cookie, 'one more');
  assert.equal(over.status, 429);
  assert.equal(over.body.error, 'DAILY_CAP');

  // A directory where the caps file should be: unreadable, so every reservation fails closed.
  const broken = setup({ capsFile: mkdtempSync(join(tmpdir(), 'rk-caps-')) });
  const r = await pasteText(broken.app, broken.people.fullMember());
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'CAPS_UNAVAILABLE');
});

test('beyond 10 uploads in a case: 409 TOO_MANY_UPLOADS', TIMEOUT, async () => {
  const { app, people } = setup();
  const cookie = people.fullMember();
  for (let i = 0; i < 10; i++) assert.equal((await pasteText(app, cookie, `note ${i}`)).status, 201);
  const over = await pasteText(app, cookie, 'eleven');
  assert.equal(over.status, 409);
  assert.equal(over.body.error, 'TOO_MANY_UPLOADS');
});

test('a full upload store refuses new uploads (507 STORAGE_FULL)', TIMEOUT, async () => {
  const { app, people } = setup({ storageBytes: 1000 });
  const cookie = people.fullMember();
  assert.equal((await pasteText(app, cookie, 'x'.repeat(600))).status, 201);
  const full = await pasteText(app, cookie, 'y'.repeat(600));
  assert.equal(full.status, 507);
  assert.equal(full.body.error, 'STORAGE_FULL');
});

test("every step is in the case's audit trail with the person's label, and neither audit details nor log lines contain the pasted text or OCR'd words", TIMEOUT, async () => {
  const { app, people, lines, intents } = setup();
  const owner = people.ownerCookie;
  const img = await uploadPng(app, owner);
  const red = await call(app, `${P}/${img.body.upload.id}/redact`, { body: { rects: [] }, cookie: owner });
  assert.equal((await call(app, `${P}/${img.body.upload.id}/confirm`, { body: { lines: red.body.readLines, sha256: red.body.upload.sha256 }, cookie: owner })).status, 200);
  const txt = await pasteText(app, owner, SECRET_WORDS, 'bank.txt');
  assert.equal((await call(app, `${P}/${txt.body.upload.id}/discard`, { body: {}, cookie: owner })).status, 200);
  assert.equal((await call(app, `${P}/${img.body.upload.id}`, { method: 'DELETE', cookie: owner })).status, 200);

  const audit = await app(req(`/api/disputes/${CASE}/audit`, { cookie: owner }));
  assert.equal(audit.status, 200);
  const events = ((await audit.json()) as { events: { kind: string; actor: string; detail?: string }[] }).events.filter((e) => e.kind.startsWith('upload_'));
  assert.deepEqual(events.map((e) => e.kind), ['upload_added', 'upload_redacted', 'upload_confirmed', 'upload_added', 'upload_discarded', 'upload_deleted']);
  const label = img.body.upload.uploadedBy.label;
  assert.ok(events.every((e) => e.actor === label), JSON.stringify(events));
  assert.ok(events.every((e) => e.detail?.includes(img.body.upload.id) || e.detail?.includes(txt.body.upload.id)), JSON.stringify(events));
  assert.ok(events.some((e) => e.kind === 'upload_confirmed' && e.detail!.includes('E7') && e.detail!.includes('tracking.png')));
  // Another workspace's trail has none of it.
  assert.ok(intents.events(CASE, { team: 'someone-else' }).every((e) => !e.kind.startsWith('upload_')));

  const everything = JSON.stringify(intents.events(CASE)) + '\n' + lines.join('\n');
  for (const secret of [TRACKING, '9988776655', 'SECRETWORD', 'Delivered']) assert.ok(!everything.includes(secret), `${secret} leaked`);
});

test('local mode: the guard lets PNG bodies through to the upload route only', TIMEOUT, async () => {
  const token = 't'.repeat(32);
  const app = createApp({ paypal: null, env: 'sandbox', bindings: {}, analyst: null, port: 8787, token, allowedOrigins: [], uploads: new UploadStore({ dir: null }) });
  const local = (path: string, body: Uint8Array) =>
    app(new Request(`http://127.0.0.1:8787${path}`, { method: 'POST', headers: { host: '127.0.0.1:8787', 'x-resolvekit-token': token, 'content-type': 'image/png', 'x-upload-name': 'tracking.png' }, body: body as BodyInit }));
  const r = await local(P, fixture);
  assert.equal(r.status, 201);
  const body = (await r.json()) as Answer;
  assert.equal(body.upload.uploadedBy.label, 'local operator');
  assert.equal((await local(`/api/disputes/${CASE}/intent`, fixture)).status, 415);
});

// ------------------------------------------------------------------------------------------------ fix round 1

const MB = 1024 * 1024;
const sleepMs = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
/** A node listener on a free port (X-Forwarded-For believed, so each test client can be its own address). */
async function listen(handler: Parameters<typeof toNodeListener>[0], o: Parameters<typeof toNodeListener>[2] = {}) {
  const lines: string[] = [];
  const server = createServer(toNodeListener(handler, 'http://127.0.0.1', { proxyTrust: 'any', trustedHops: 1, log: (l) => lines.push(l), ...o }));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as { port: number };
  /** A complete POST of `body` from `ip`. */
  const post = (body: Buffer, ip: string) =>
    new Promise<number>((resolve) => {
      const r = httpRequest({ host: '127.0.0.1', port, path: P, method: 'POST', headers: { 'content-type': 'image/png', 'content-length': body.length, 'x-forwarded-for': ip } }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
      r.on('error', () => resolve(-1));
      r.end(body);
    });
  /** A 1 MB upload from `ip` stuck after 1 KB; `closed` resolves when the server drops it. */
  const hold = (ip: string) => {
    const r = httpRequest({ host: '127.0.0.1', port, path: P, method: 'POST', headers: { 'content-type': 'image/png', 'content-length': MB, 'x-forwarded-for': ip } });
    const closed = new Promise<void>((ok) => r.on('close', () => ok()));
    r.on('error', () => {});
    r.write(Buffer.alloc(1024));
    return { r, closed };
  };
  const close = async () => {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
  };
  return { server, port, post, hold, close, lines };
}

test('at most 3 large uploads are read at once: a 4th is refused before reading (503 BUSY)', TIMEOUT, async () => {
  let handled = 0;
  const l = await listen(async (r) => (handled++, await r.arrayBuffer(), new Response('{}', { status: 200 })));
  // Three uploads of 1 MB from three addresses, each stuck after 1 KB: they hold the three large-body slots.
  const held = ['198.51.100.1', '198.51.100.2', '198.51.100.3'].map(l.hold);
  try {
    await sleepMs(100);
    const busy = await rawPost(l.server, P, { 'content-type': 'image/png', 'content-length': MB, 'x-forwarded-for': '198.51.100.4' }, [Buffer.alloc(1024)]);
    assert.equal(busy.status, 503);
    assert.match(busy.body, /BUSY/);
    // A small one (up to 256 KB) needs no slot.
    assert.equal(await l.post(Buffer.alloc(1024), '198.51.100.5'), 200);
    // The held ones go away: their slots are free again.
    for (const h of held) h.r.destroy();
    await sleepMs(100);
    assert.equal(await l.post(Buffer.alloc(MB), '198.51.100.6'), 200);
    assert.equal(handled, 2);
  } finally {
    for (const h of held) h.r.destroy();
    await l.close();
  }
});

test('one large body at a time per address: a second one from the same address is refused before reading (503 BUSY)', TIMEOUT, async () => {
  const l = await listen(async (r) => (await r.arrayBuffer(), new Response('{}', { status: 200 })));
  const held = l.hold('203.0.113.50');
  try {
    await sleepMs(100);
    const second = await rawPost(l.server, P, { 'content-type': 'image/png', 'content-length': MB, 'x-forwarded-for': '203.0.113.50' }, [Buffer.alloc(1024)]);
    assert.equal(second.status, 503);
    assert.match(second.body, /BUSY/);
    // Another address is not held up.
    assert.equal(await l.post(Buffer.alloc(MB), '203.0.113.51'), 200);
  } finally {
    held.r.destroy();
    await l.close();
  }
});

test('a large body that does not arrive within the deadline is dropped and its slot freed', TIMEOUT, async () => {
  const l = await listen(async (r) => (await r.arrayBuffer(), new Response('{}', { status: 200 })), { largeBodyDeadlineMs: 300 });
  try {
    const slow = l.hold('203.0.113.60');
    // Trickle a little more, far slower than 1 MB in 300 ms.
    const trickle = setInterval(() => slow.r.write(Buffer.alloc(16)), 50);
    const t0 = Date.now();
    await slow.closed;
    clearInterval(trickle);
    const took = Date.now() - t0;
    assert.ok(took >= 250 && took < 5000, `closed after ${took} ms`);
    // The same address has its slot back.
    assert.equal(await l.post(Buffer.alloc(MB), '203.0.113.60'), 200);
  } finally {
    await l.close();
  }
});

test('the node listener never crashes on a bad request: 400 for one it cannot build, 500 for a failing handler, no details', TIMEOUT, async () => {
  let fail = false;
  const l = await listen(async () => {
    if (fail) throw new Error('secret detail 9988776655');
    return new Response('{}', { status: 200 });
  });
  try {
    // TRACE is a method Node accepts and a Fetch Request refuses to be built with.
    const traced = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = httpRequest({ host: '127.0.0.1', port: l.port, path: '/api/health', method: 'TRACE' }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      r.on('error', reject);
      r.end();
    });
    assert.equal(traced.status, 400);
    assert.match(traced.body, /BAD_REQUEST/);
    fail = true;
    const broken = await rawPost(l.server, '/api/health', { 'content-type': 'application/json', 'content-length': 2 }, [Buffer.from('{}')]);
    assert.equal(broken.status, 500);
    assert.ok(!broken.body.includes('secret'), broken.body);
    assert.ok(l.lines.length >= 2 && l.lines.every((x) => !x.includes('secret') && !x.includes('9988776655')), JSON.stringify(l.lines));
    // Still serving.
    fail = false;
    assert.equal(await l.post(Buffer.alloc(16), '203.0.113.70'), 200);
  } finally {
    await l.close();
  }
});

test('each redact counts in the per-address upload limit, and an upload takes at most 5 redacts (TOO_MANY_REDACTS)', TIMEOUT, async () => {
  const limited = setup({ limits: { uploadsPerIp: { limit: 3, windowMs: 600_000 } } });
  const c1 = limited.people.fullMember();
  const t = await pasteText(limited.app, c1);
  assert.equal((await call(limited.app, `${P}/${t.body.upload.id}/redact`, { body: { removals: [] }, cookie: c1 })).status, 200);
  assert.equal((await call(limited.app, `${P}/${t.body.upload.id}/redact`, { body: { removals: [] }, cookie: c1 })).status, 200);
  const over = await call(limited.app, `${P}/${t.body.upload.id}/redact`, { body: { removals: [] }, cookie: c1 });
  assert.equal(over.status, 429);
  assert.equal(over.body.error, 'RATE_LIMITED');

  const { app, people } = setup();
  const cookie = people.fullMember();
  const img = await uploadPng(app, cookie);
  for (let i = 0; i < 5; i++) assert.equal((await call(app, `${P}/${img.body.upload.id}/redact`, { body: { rects: [] }, cookie })).status, 200);
  const sixth = await call(app, `${P}/${img.body.upload.id}/redact`, { body: { rects: [] }, cookie });
  assert.equal(sixth.status, 409);
  assert.equal(sixth.body.error, 'TOO_MANY_REDACTS');
  // The internal refund signal never reaches the browser.
  assert.equal(sixth.res.headers.get('x-rk-refused-early'), null);
});

test('no refund after work: an upload refused after its OCR keeps its daily unit and its address slot; one refused before any work gives both back', TIMEOUT, async () => {
  const { app, people, counters } = setup({ limits: { uploadsPerIp: { limit: 12, windowMs: 600_000 } } });
  const cookie = people.fullMember();
  const ids: string[] = [];
  for (let i = 0; i < 9; i++) ids.push((await pasteText(app, cookie, `note ${i}`)).body.upload.id);
  // Two images at once with room for one: both pass the first check and are read; the second is refused after.
  const [a, b] = await Promise.all([uploadPng(app, cookie), uploadPng(app, cookie)]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal(counters.state().caps.upload!.used, 11);
  // Refused before any work (the case is full): nothing is taken.
  const full = await pasteText(app, cookie, 'eleven');
  assert.equal(full.status, 409);
  assert.equal(full.res.headers.get('x-rk-refused-early'), null);
  assert.equal(counters.state().caps.upload!.used, 11);
  // Address slots used so far: 9 + 2 (the one refused after OCR is not given back) = 11 of 12.
  assert.equal((await call(app, `${P}/${ids[0]}/discard`, { body: {}, cookie })).status, 200);
  assert.equal((await pasteText(app, cookie, 'twelve')).status, 201);
  assert.equal((await call(app, `${P}/${ids[1]}/discard`, { body: {}, cookie })).status, 200);
  const limited = await pasteText(app, cookie, 'thirteen');
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'RATE_LIMITED');
  assert.equal(counters.state().caps.upload!.used, 12);
});

test('an upload past its expiry cannot be redacted, confirmed or shown', TIMEOUT, async () => {
  const { app, people, store, intents } = setup();
  const cookie = people.fullMember();
  const t = await pasteText(app, cookie);
  const red = await call(app, `${P}/${t.body.upload.id}/redact`, { body: { removals: [] }, cookie });
  const img = await uploadPng(app, cookie);
  const past = new Date(Date.now() - 1000).toISOString();
  store.update(t.body.upload.id, { expiresAt: past });
  store.update(img.body.upload.id, { expiresAt: past });
  assert.equal((await call(app, `${P}/${t.body.upload.id}/confirm`, { body: { lines: red.body.readLines, sha256: red.body.upload.sha256 }, cookie })).status, 404);
  assert.equal((await call(app, `${P}/${t.body.upload.id}/redact`, { body: { removals: [] }, cookie })).status, 404);
  assert.equal((await call(app, `${P}/${img.body.upload.id}/image?v=original`, { cookie })).status, 404);
  assert.equal(store.get(t.body.upload.id)!.status, 'discarded');
  assert.equal(store.get(img.body.upload.id)!.status, 'discarded');
  assert.equal(store.original(img.body.upload.id), null);
  assert.equal((await call(app, P, { cookie })).body.uploads!.length, 0);
  assert.ok(intents.events(CASE).some((e) => e.kind === 'upload_discarded' && e.detail?.includes('expired')));
});

test('unknown cases (inherited names too) are 404, and an archived upload cannot be discarded (404) but can be deleted', TIMEOUT, async () => {
  const { app, people, store } = setup();
  const cookie = people.fullMember();
  for (const id of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal((await call(app, `/api/cases/${id}/uploads`, { cookie })).status, 404, id);
    assert.equal((await call(app, `/api/cases/${id}/uploads`, { body: { text: 'x' }, cookie })).status, 404, id);
  }
  const t = await pasteText(app, cookie, 'to archive');
  store.archiveCase(CASE, REAL);
  assert.equal((await call(app, `${P}/${t.body.upload.id}/discard`, { body: {}, cookie })).status, 404);
  assert.equal((await call(app, `${P}/${t.body.upload.id}`, { method: 'DELETE', cookie })).status, 200);
});

test("the analysis input includes the workspace's confirmed uploads of the active dispute only", TIMEOUT, async () => {
  const { app, people, store } = setup();
  const cookie = people.fullMember('Ana Lopez');
  // Confirmed, with line 2 corrected by the person: "Not delivered" was a misreading.
  const t = await pasteText(app, cookie, 'UPS tracking\nNot delivered 8 Oct 2026', 'tracking.txt');
  const red = await call(app, `${P}/${t.body.upload.id}/redact`, { body: { removals: [] }, cookie });
  const conf = await call(app, `${P}/${t.body.upload.id}/confirm`, { body: { lines: ['UPS tracking', 'Delivered 8 Oct 2026'], sha256: red.body.upload.sha256 }, cookie });
  assert.equal(conf.status, 200, JSON.stringify(conf.body));
  const label = conf.body.upload.lines[1]!.correctedBy!;
  // Pending: not confirmed yet.
  await pasteText(app, cookie, 'PENDINGWORDS only', 'pending.txt');
  // Another workspace's confirmed upload of the same case and dispute, and an archived one of a previous dispute.
  const mk = (workspaceId: string, boundDisputeId: string, text: string, status: 'confirmed' | 'archived') => {
    const r = store.create({ workspaceId, caseId: CASE, boundDisputeId, kind: 'text', name: `${text}.txt`, uploadedBy: { id: 'x', label: 'x', name: 'x' } }, new TextEncoder().encode(text));
    store.update(r.id, { status, evidenceId: 'E9', lines: [{ text, correctedBy: null, original: null }], confirmedAt: new Date().toISOString() });
  };
  mk('ws-other', REAL, 'OTHERWORKSPACE', 'confirmed');
  mk(people.workspace.id, 'PP-R-OLD-0', 'ARCHIVEDWORDS', 'archived');
  mk(people.workspace.id, 'PP-R-OLD-0', 'OLDDISPUTE', 'confirmed');

  type Doc = { id: string; title: string; type: string; source: string; tag: string; lines: { text: string; fragment?: string; corrected?: string }[] };
  const analyse = (c?: string) => call(app, `/api/cases/${CASE}/analysis`, { body: {}, ...(c ? { cookie: c } : {}) }) as unknown as Promise<{ status: number; body: { key: string; input: { documents: Doc[] } } & Answer }>;
  const r = await analyse(cookie);
  assert.ok(r.body.input, JSON.stringify(r.body).slice(0, 300));
  const docs = r.body.input.documents;
  const e7 = docs.find((d) => d.id === 'E7');
  assert.deepEqual(e7, {
    id: 'E7',
    title: 'tracking.txt',
    type: 'Merchant upload · pasted text',
    source: 'Uploaded by Ana Lopez',
    tag: 'UPL',
    lines: [
      { text: 'UPS tracking', fragment: 'E7.l1' },
      { text: 'Delivered 8 Oct 2026', fragment: 'E7.l2', corrected: label },
    ],
  });
  const all = JSON.stringify(docs);
  for (const w of ['PENDINGWORDS', 'OTHERWORKSPACE', 'ARCHIVEDWORDS', 'OLDDISPUTE', 'Not delivered']) assert.ok(!all.includes(w), w);
  // The analysis key is remembered on the upload (deleting it purges by these keys).
  assert.match(r.body.key, /^[0-9a-f]{64}$/);
  assert.deepEqual(store.get(t.body.upload.id)!.analysisKeys, [r.body.key]);

  // The same case for someone outside the workspace (and signed out): no uploads, and a different input.
  for (const c of [people.outsider(), undefined]) {
    const o = await analyse(c);
    assert.ok(o.body.input, JSON.stringify(o.body).slice(0, 300));
    assert.ok(!o.body.input.documents.some((d) => d.tag === 'UPL'));
    assert.notEqual(o.body.key, r.body.key);
  }
  // The seller's workspace again: its uploads are still there (the pin never carries one workspace's uploads).
  assert.equal((await analyse(cookie)).body.key, r.body.key);
  assert.deepEqual(store.get(t.body.upload.id)!.analysisKeys, [r.body.key]);

  // The uploads list gives each confirmed upload its analyst document (what the web app renders), pending ones none.
  const list = (await call(app, P, { cookie })).body.uploads as unknown as (View & { document: Doc | null })[];
  assert.deepEqual(list.find((u) => u.id === t.body.upload.id)!.document, e7);
  assert.equal(list.find((u) => u.status === 'pending')!.document, null);
});
