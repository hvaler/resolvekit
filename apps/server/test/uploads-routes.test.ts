import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest, createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { FileAnalysisStore, type AnalysisInput, type CaseAnalysis } from '@resolvekit/analyst/node';
import { PayPalClient } from '@resolvekit/paypal';
import { standardScript } from '../../../packages/analyst/test/fake.ts';
import { AnalystService, InputPins } from '../src/analysis.ts';
import { createApi, createApp, type ActingPerson } from '../src/app.ts';
import { toNodeListener } from '../src/node.ts';
import { coverImage, sanitiseImage, type Rect } from '../src/uploads/image.ts';
import { MAX_FILE_BYTES, MAX_STORED_BYTES, PAYPAL_MAX_SEND_BYTES } from '../src/uploads/limits.ts';
import { closeOcr, ocrPng } from '../src/uploads/ocr.ts';
import { canDeleteUpload, canEditUpload } from '../src/uploads/permissions.ts';
import { UploadStore, type UploadRecord } from '../src/uploads/store.ts';
import { STD_CAPTURE } from './kit.ts';
import { CASE, P, REAL, TIMEOUT, call, fileBytes, pasteText, req, sendSetup, setup, sha, type Answer, type App, type View } from './uploads-kit.ts';

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

const TRACKING = '1Z999AA10123456784';
const SECRET_WORDS = 'Account 9988776655 balance 4321.09 SECRETWORD';
const fixture = new Uint8Array(readFileSync(new URL('./fixtures/tracking.png', import.meta.url)));

const uploadPng = (app: App, cookie: string, bytes: Uint8Array = fixture, type = 'image/png') => call(app, P, { body: bytes, type, cookie, headers: { 'x-upload-name': 'tracking.png' } });

let trackingBox: Rect | null = null;
/** Where OCR finds the tracking number on the fixture (what the person covers in the web app). */
async function trackingRect(): Promise<Rect> {
  trackingBox ??= (await ocrPng(fixture)).find((l) => l.text.includes(TRACKING))!.box;
  return trackingBox;
}

test("a reviewer of the seller's workspace uploads a PNG; another workspace and a signed-out visitor get 404 UNKNOWN_CASE", TIMEOUT, async () => {
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
  // three-environments plan, task 2: outside the seller's workspace the case does not exist (404, was 403/401)
  assert.equal((await uploadPng(app, outsider)).status, 404);
  assert.equal((await uploadPng(app, '')).status, 404);
  assert.equal((await call(app, P, { cookie: outsider })).status, 404);
  assert.equal((await call(app, P)).status, 404);
  assert.equal((await call(app, `${P}/${r.body.upload.id}/image?v=original`, { cookie: outsider })).status, 404);
  assert.equal((await call(app, `${P}/${r.body.upload.id}/discard`, { body: {}, cookie: outsider })).status, 404);
  assert.equal((await call(app, `/api/cases/NOPE-1/uploads`, { cookie: reviewer })).status, 404);
  // The original is shown back to the person who can edit it.
  const img = await app(req(`${P}/${r.body.upload.id}/image?v=original`, { cookie: reviewer }));
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.deepEqual(new Uint8Array(await img.arrayBuffer()), fixture);
});

/** The tracking screenshot saved as a JPEG photo would be (quality 95). */
const fixtureJpeg = () => {
  const p = PNG.sync.read(Buffer.from(fixture));
  return new Uint8Array(jpeg.encode({ data: p.data, width: p.width, height: p.height }, 95).data);
};

test('a JPEG upload is accepted, and its sanitised file is a fresh JPEG (a photo stays a photo), read again from that file', TIMEOUT, async () => {
  const { app, people, store } = setup();
  const cookie = people.fullMember();
  const jpg = fixtureJpeg();
  const r = await uploadPng(app, cookie, jpg, 'image/jpeg');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const box = await trackingRect();
  const red = await call(app, `${P}/${r.body.upload.id}/redact`, { body: { rects: [box] }, cookie });
  assert.equal(red.status, 200, JSON.stringify(red.body));
  assert.ok(red.body.readLines.some((l) => l.trim().length > 0), JSON.stringify(red.body.readLines));
  assert.ok(!red.body.readLines.some((l) => l.includes('1Z999')), JSON.stringify(red.body.readLines));
  const expected = coverImage(jpg, [box]);
  assert.equal(expected.mime, 'image/jpeg');
  assert.equal(red.body.upload.sha256, expected.sha256);
  assert.equal(store.get(r.body.upload.id)!.mime, 'image/jpeg');
  const original = await app(req(`${P}/${r.body.upload.id}/image?v=original`, { cookie }));
  assert.equal(original.headers.get('content-type'), 'image/jpeg');
  const img = await app(req(`${P}/${r.body.upload.id}/image?v=sanitised`, { cookie }));
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  const bytes = new Uint8Array(await img.arrayBuffer());
  assert.deepEqual(bytes, expected.file);
  const d = jpeg.decode(bytes, { useTArray: true });
  const at = ((box.y + 2) * d.width + box.x + 2) * 4;
  assert.ok([...d.data.subarray(at, at + 3)].every((v) => v <= 24));
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

test('pasted text outside Latin-1 is refused (422 TEXT_UNSUPPORTED) naming the first such character; Latin-1 accents pass', TIMEOUT, async () => {
  const { app, people, store } = setup();
  const cookie = people.fullMember();
  const before = store.usedBytes();
  for (const [text, shown] of [['Total 5 € paid\nthanks', '€'], ['Arrived 👍 today', '👍'], ['Quote “delivered”', '“']] as const) {
    const r = await pasteText(app, cookie, text);
    assert.equal(r.status, 422, text);
    assert.equal(r.body.error, 'TEXT_UNSUPPORTED');
    const detail = (r.body as unknown as { detail: string }).detail;
    assert.ok(detail.includes(shown), detail);
    assert.ok(!detail.includes('paid') && !detail.includes('Arrived'), 'the message names the character, not the text');
  }
  assert.equal(store.usedBytes(), before);
  const ok = await pasteText(app, cookie, 'Señora Müller · déjà reçu ¿sí?\r\nÀ bientôt');
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.readLines, ['Señora Müller · déjà reçu ¿sí?', 'À bientôt']);
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
  // Until it is confirmed, someone who cannot edit it sees that it exists, not what it shows or reads.
  assert.equal((await call(app, `${P}/${id}/image?v=original`, { cookie: b })).status, 404);
  assert.equal((await call(app, `${P}/${id}/discard`, { body: {}, cookie: b })).status, 403);
  assert.equal((await call(app, P, { cookie: b })).body.uploads!.length, 1);
  const red = await call(app, `${P}/${id}/redact`, { body: { rects: [] }, cookie: owner });
  assert.equal(red.status, 200);
  assert.ok(red.body.readLines.length > 0);
  for (const v of ['sanitised', 'original']) assert.equal((await call(app, `${P}/${id}/image?v=${v}`, { cookie: b })).res.status, 404, v);
  const listed = (await call(app, P, { cookie: b })).body.uploads![0] as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(listed).sort(), ['createdAt', 'expiresAt', 'id', 'kind', 'name', 'restricted', 'status', 'uploadedBy']);
  assert.equal(listed.status, 'reviewing');
  // The uploader and full members see it all.
  assert.deepEqual((await call(app, P, { cookie: a })).body.uploads![0]!.readLines, red.body.readLines);
  assert.equal((await call(app, `${P}/${id}/image?v=sanitised`, { cookie: full })).res.status, 200);
  assert.equal((await call(app, `${P}/${id}/confirm`, { body: { lines: red.body.readLines, sha256: red.body.upload.sha256 }, cookie: b })).status, 403);
  const conf = await call(app, `${P}/${id}/confirm`, { body: { lines: red.body.readLines, sha256: red.body.upload.sha256 }, cookie: full });
  assert.equal(conf.status, 200);
  assert.equal(conf.body.upload.evidenceId, 'E7');
  // Confirmed: the workspace sees the confirmed document and its file.
  assert.equal((await call(app, `${P}/${id}/image?v=sanitised`, { cookie: b })).res.status, 200);
  assert.equal((await call(app, P, { cookie: b })).body.uploads![0]!.lines.length, red.body.readLines.length);
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

test('a sanitised file over the stored-file limit is refused at redact time (413) with what to do, and nothing is stored', TIMEOUT, async () => {
  // PayPal: each file under 10 MB, in either decimal or binary reading.
  assert.equal(MAX_STORED_BYTES, 9_900_000);
  const { app, people, store } = setup({ storedFileBytes: 400 });
  const cookie = people.fullMember();
  const img = await uploadPng(app, cookie);
  const text = await pasteText(app, cookie, `From: buyer\n${'The parcel arrived, thanks. '.repeat(40)}`);
  for (const [u, body, what] of [[img, { rects: [] }, /screenshot or a smaller image/], [text, { removals: [] }, /shorter text/]] as const) {
    const r = await call(app, `${P}/${u.body.upload.id}/redact`, { body, cookie });
    assert.equal(r.status, 413, JSON.stringify(r.body));
    assert.equal(r.body.error, 'TOO_LARGE');
    assert.match((r.body as unknown as { detail: string }).detail, what);
    assert.equal(store.get(u.body.upload.id)!.status, 'pending');
    assert.equal(store.sanitised(u.body.upload.id), null);
  }
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
  assert.ok(events.some((e) => e.kind === 'upload_confirmed' && e.detail!.includes('E7')));
  // No file name: it can hold what the person did not cover.
  assert.ok(events.every((e) => !e.detail!.includes('tracking.png') && !e.detail!.includes('bank.txt')), JSON.stringify(events));
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
  const { app, people, store } = setup({ caps: { 'live-analysis': 10 } });
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
    title: 'Pasted text',
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

  // The same case for someone outside the workspace (and signed out): not found.
  for (const c of [people.outsider(), undefined]) {
    // three-environments plan, task 2: no analysis at all outside the seller's workspace (was: a simulated one without uploads)
    assert.equal((await analyse(c)).status, 404);
  }
  // The seller's workspace again: its uploads are still there (the pin never carries one workspace's uploads).
  assert.equal((await analyse(cookie)).body.key, r.body.key);
  assert.deepEqual(store.get(t.body.upload.id)!.analysisKeys, [r.body.key]);

  // The uploads list gives each confirmed upload its analyst document (what the web app renders), pending ones none.
  const list = (await call(app, P, { cookie })).body.uploads as unknown as (View & { document: Doc | null })[];
  assert.deepEqual(list.find((u) => u.id === t.body.upload.id)!.document, e7);
  assert.equal(list.find((u) => u.status === 'pending')!.document, null);
});

// ------------------------------------------------------------------------------------- deletion purges what quotes the upload

const TOKEN = 'TOKEN-7f3a';
/** The standard script, plus a fact quoting the uploaded line (its statement carries the token into the analysis). */
const tokenScript = {
  ...standardScript,
  extract: { ...standardScript.extract, facts: [...standardScript.extract.facts, { id: 'z', doc: 'E7', quote: `${TOKEN} courier note`, statement: `Courier note ${TOKEN}`, at: null }] },
  recheck: { facts: [], verdict: 'supported', reason: '', rewrite: '' },
};
type Progress = { status: number; body: { status?: string; error?: string } };
const progressOf = (app: App, key: string, cookie: string) => call(app, `/api/cases/${CASE}/analysis/progress?key=${key}`, { cookie }) as unknown as Promise<Progress>;
const analyseAs = (app: App, cookie: string) => call(app, `/api/cases/${CASE}/analysis`, { body: {}, cookie }) as unknown as Promise<{ status: number; body: { key: string; status: string } }>;
async function untilReady(app: App, key: string, cookie: string) {
  for (let i = 0; i < 300; i++) {
    const p = await progressOf(app, key, cookie);
    if (p.body.status === 'ready' || p.body.status === 'failed') return p;
    await sleepMs(10);
  }
  throw new Error('analysis never settled');
}
const cacheText = (dir: string) => readdirSync(dir).map((f) => `${f}\n${readFileSync(join(dir, f), 'utf8')}`).join('\n');

async function confirmedToken(app: App, cookie: string) {
  const t = await pasteText(app, cookie, `${TOKEN} courier note\nParcel left with neighbour`, 'courier.txt');
  const red = await call(app, `${P}/${t.body.upload.id}/redact`, { body: { removals: [] }, cookie });
  const conf = await call(app, `${P}/${t.body.upload.id}/confirm`, { body: { lines: [`${TOKEN} courier note`, 'Parcel left with neighbour'], sha256: red.body.upload.sha256 }, cookie });
  assert.equal(conf.status, 200, JSON.stringify(conf.body));
  return t.body.upload.id;
}

test('after deleting an upload no stored analysis, pin or progress answer contains its text', TIMEOUT, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-purge-'));
  const { app, people, store } = setup({ analysisDir: dir, script: tokenScript, caps: { 'live-analysis': 10, recheck: 10 } });
  const cookie = people.fullMember('Ana Lopez');
  const id = await confirmedToken(app, cookie);

  const first = await analyseAs(app, cookie);
  assert.equal(first.status, 202, JSON.stringify(first.body));
  const oldKey = first.body.key;
  const ready = await untilReady(app, oldKey, cookie);
  assert.equal(ready.body.status, 'ready');
  assert.ok(JSON.stringify(ready.body).includes(TOKEN), 'the analysis quotes the upload');
  assert.ok(cacheText(dir).includes(TOKEN), 'and so does the stored file');
  const checked = await call(app, `/api/cases/${CASE}/analysis/verify`, { body: { text: 'Courier left it with the neighbour.' }, cookie });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.deepEqual(store.get(id)!.analysisKeys, [oldKey]);

  const del = await call(app, `${P}/${id}`, { method: 'DELETE', cookie });
  assert.equal(del.status, 200, JSON.stringify(del.body));

  // The stored file is gone, and nothing in the cache directory mentions the token.
  assert.deepEqual(readdirSync(dir), []);
  // The old key answers nothing: no analysis, no running job, no progress.
  const old = await progressOf(app, oldKey, cookie);
  assert.equal(old.status, 404);
  assert.ok(!JSON.stringify(old.body).includes(TOKEN));
  // Without the upload the input has another key; a later analysis does not quote the upload.
  const again = await analyseAs(app, cookie);
  assert.equal(again.status, 202, JSON.stringify(again.body));
  assert.notEqual(again.body.key, oldKey);
  const fresh = await untilReady(app, again.body.key, cookie);
  assert.equal(fresh.body.status, 'ready');
  assert.ok(!JSON.stringify(fresh.body).includes(TOKEN));
  assert.ok(!cacheText(dir).includes(TOKEN));
  const recheck = await call(app, `/api/cases/${CASE}/analysis/verify`, { body: { text: 'Courier left it with the neighbour.' }, cookie });
  assert.equal(recheck.status, 200, JSON.stringify(recheck.body));
  assert.ok(!JSON.stringify(recheck.body).includes(TOKEN));
  // The record forgot its keys.
  assert.deepEqual(store.get(id)!.analysisKeys, []);
});

test('deleting an upload while its analysis is still running: the finished result is dropped, never stored', TIMEOUT, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-purge-run-'));
  let open!: () => void;
  const gate = new Promise<void>((ok) => (open = ok));
  const { app, people, analyst } = setup({
    analysisDir: dir,
    caps: { 'live-analysis': 10, recheck: 10 },
    script: tokenScript,
    model: (m) => ({ ...m, generate: async (r) => (await gate, m.generate(r)) }),
  });
  const cookie = people.fullMember('Ana Lopez');
  const id = await confirmedToken(app, cookie);
  const first = await analyseAs(app, cookie);
  assert.equal(first.status, 202, JSON.stringify(first.body));
  const finished = analyst.settled(first.body.key); // waits for the job itself (taken before it is forgotten)
  const del = await call(app, `${P}/${id}`, { method: 'DELETE', cookie });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  open();
  await finished;
  assert.deepEqual(readdirSync(dir), [], 'the run that quoted the upload stored nothing');
  assert.equal((await progressOf(app, first.body.key, cookie)).status, 404);
});


/** Holds the `n`th call of `analyst.key` (1-based, counted from now) until `release()`; `held` resolves when it is held. */
function holdKeyCall(analyst: AnalystService, n: number) {
  let calls = 0;
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((ok) => (release = ok));
  const held = new Promise<void>((ok) => (reached = ok));
  const real = analyst.key.bind(analyst);
  analyst.key = async (input) => {
    const k = await real(input);
    if (++calls === n) {
      reached();
      await gate;
    }
    return k;
  };
  return { release, held };
}

test('a DELETE between reading the uploads and starting the run: the run is purged at once, nothing quoting the upload is kept or shown', TIMEOUT, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-purge-race-'));
  const { app, people, analyst, store, model } = setup({ analysisDir: dir, script: tokenScript, caps: { 'live-analysis': 10, recheck: 10 } });
  const cookie = people.fullMember('Ana Lopez');
  const id = await confirmedToken(app, cookie);
  const h = holdKeyCall(analyst, 1);
  const posting = analyseAs(app, cookie);
  await h.held;
  const del = await call(app, `${P}/${id}`, { method: 'DELETE', cookie });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  h.release();
  const r = await posting;
  assert.equal(r.status, 409, JSON.stringify(r.body).slice(0, 300));
  assert.ok(!JSON.stringify(r.body).includes(TOKEN));
  // The run that started in the gap finishes (its last stage was asked) and finds nothing to store.
  while (!model.requests.some((q) => q.stage === 'explain')) await sleepMs(5);
  await new Promise((ok) => setImmediate(ok));
  assert.deepEqual(store.get(id)!.analysisKeys, []);
  assert.deepEqual(readdirSync(dir), []);
  const after = await analyseAs(app, cookie);
  assert.equal(after.status, 202);
  assert.equal((await untilReady(app, after.body.key, cookie)).body.status, 'ready');
  assert.ok(!cacheText(dir).includes(TOKEN));
});

test('a DELETE between the verifier and remembering its verdict: no verdict is kept and nothing is shown', TIMEOUT, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-purge-verify-'));
  const { app, people, analyst, store } = setup({ analysisDir: dir, script: tokenScript, caps: { 'live-analysis': 10, recheck: 10 } });
  const cookie = people.fullMember('Ana Lopez');
  const id = await confirmedToken(app, cookie);
  const first = await analyseAs(app, cookie);
  assert.equal((await untilReady(app, first.body.key, cookie)).body.status, 'ready');
  // analyst.verify calls key() first, the route a second time: hold that one.
  const h = holdKeyCall(analyst, 2);
  const verifying = call(app, `/api/cases/${CASE}/analysis/verify`, { body: { text: 'Courier left it with the neighbour.' }, cookie });
  await h.held;
  assert.equal((await call(app, `${P}/${id}`, { method: 'DELETE', cookie })).status, 200);
  h.release();
  const r = await verifying;
  assert.equal(r.status, 409, JSON.stringify(r.body).slice(0, 300));
  assert.ok(!JSON.stringify(r.body).includes(TOKEN));
  assert.deepEqual(readdirSync(dir), []);
  assert.equal((await progressOf(app, first.body.key, cookie)).status, 404);
  assert.deepEqual(store.get(id)!.analysisKeys, []);
});

test('a re-check of an input with an upload is tied to it: deleting the upload sweeps the verdict even if no analysis request noted the key', TIMEOUT, async () => {
  const { app, people, analyst, store } = setup({ script: tokenScript, caps: { 'live-analysis': 10, recheck: 10 } });
  const cookie = people.fullMember('Ana Lopez');
  const id = await confirmedToken(app, cookie);
  const first = await analyseAs(app, cookie);
  assert.equal((await untilReady(app, first.body.key, cookie)).body.status, 'ready');
  // As if the analysis had been requested elsewhere: the upload does not know the key.
  store.update(id, { analysisKeys: [] });
  const checked = await call(app, `/api/cases/${CASE}/analysis/verify`, { body: { text: 'Courier left it with the neighbour.' }, cookie });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  const keys = store.get(id)!.analysisKeys;
  assert.equal(keys.length, 1, 'the verify noted its input key on the upload');
  const forgotten: string[] = [];
  const forget = analyst.forget.bind(analyst);
  analyst.forget = (k) => (forgotten.push(...k), forget(k));
  assert.equal((await call(app, `${P}/${id}`, { method: 'DELETE', cookie })).status, 200);
  assert.ok(forgotten.includes(keys[0]!), 'deleting purges what hangs from that key, the verdict included');
});

test('deleting an upload drops the analysis pins of intents that attach it or were composed with it, sent ones included', TIMEOUT, async () => {
  const s = sendSetup();
  const cookie = s.people.fullMember('Ana Lopez');
  const e7 = await s.confirmText(cookie, 'UPS tracking\nDelivered 8 Oct 2026', 'tracking.txt');
  const e8 = await s.confirmText(cookie, `${TOKEN} email\nIt arrived.`, 'email.txt');
  const quoting = { id: 'S7', text: `Quoting ${TOKEN}.`, noteId: null, citations: [{ doc: 'E8', quote: `${TOKEN} email`, valid: true }], verdict: 'supported', reason: null, decidedBy: 'model', rewrite: null } as unknown as CaseAnalysis['sentences'][number];
  await s.analyse(cookie, [quoting]);
  const pinned = (i: { analysisHash?: string }) => JSON.stringify(s.intents.analysisPin(i.analysisHash) ?? null);
  // Attaches E7 only, but was composed from an input that also contained E8.
  const i = await s.approved(cookie, { attachments: [e7.id] });
  const stored = s.intents.peek(i.id)!;
  assert.ok(pinned(stored).includes(TOKEN), 'the pin quotes the upload before deletion');
  assert.equal((await s.send(cookie, i.id)).status, 202);
  assert.equal(s.intents.peek(i.id)!.status, 'sent');
  assert.ok(pinned(stored).includes(TOKEN));
  assert.equal((await call(s.app, `${P}/${e8.id}`, { method: 'DELETE', cookie })).status, 200);
  assert.equal(pinned(stored), 'null');
  assert.equal(s.intents.peek(i.id)!.status, 'sent', 'the sent intent keeps its status');
});

test('InputPins.forget fails closed: a pin file that cannot be rewritten makes the purge fail and the pin stays', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-pins-'));
  const file = join(dir, 'pins.json');
  const pins = new InputPins({ file });
  const inp = { caseId: 'C', caseKind: 'standard', dispute: {}, documents: [], merchantNotes: [] } as unknown as AnalysisInput;
  pins.resolve('C', inp, false);
  assert.ok(readFileSync(file, 'utf8').includes('"C"'));
  unlinkSync(file);
  mkdirSync(file); // a directory where the file belongs: the rename fails
  assert.throws(() => pins.forget('C'));
  // still held: a retry once the disk allows it rewrites the file without it
  rmdirSync(file);
  pins.forget('C');
  assert.ok(!readFileSync(file, 'utf8').includes('"C"'));
});

test('a stray temporary file in the analysis cache is swept at startup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-tmp-'));
  writeFileSync(join(dir, `${'ab'.repeat(32)}.json.123.tmp`), TOKEN);
  new FileAnalysisStore({ dir, golden: new Map() });
  assert.deepEqual(readdirSync(dir), []);
});

// ------------------------------------------------------------------------------------- attachments and the send

test("only selected, confirmed uploads of the active dispute are attached; an archived or another workspace's id is refused", TIMEOUT, async () => {
  const s = sendSetup();
  const cookie = s.people.fullMember('Ana Lopez');
  const e7 = await s.confirmText(cookie, 'UPS tracking\nDelivered 8 Oct 2026', 'tracking.txt');
  const e8 = await s.confirmText(cookie, 'From: buyer\nIt arrived, thanks.', 'Recibo ñ (copia) #2 of the email the buyer sent us on the day it was delivered.txt');
  const pending = (await pasteText(s.app, cookie, 'not confirmed', 'pending.txt')).body.upload;
  const mk = (workspaceId: string, boundDisputeId: string, status: 'confirmed' | 'archived') => {
    const r = s.store.create({ workspaceId, caseId: CASE, boundDisputeId, kind: 'text', name: 'x.txt', uploadedBy: { id: 'x', label: 'x', name: 'x' } }, new TextEncoder().encode('x'));
    return s.store.update(r.id, { status, evidenceId: 'E9', lines: [{ text: 'x', correctedBy: null, original: null }], sha256: 'c'.repeat(64), mime: 'application/pdf' }).id;
  };
  const other = mk('ws-other', REAL, 'confirmed');
  const archived = mk(s.people.workspace.id, REAL, 'archived');
  const old = mk(s.people.workspace.id, 'PP-R-OLD-0', 'confirmed');
  await s.analyse(cookie);

  const i = await s.intent(cookie, { attachments: [e8.id] });
  assert.equal(i.status, 201, JSON.stringify(i.body));
  const demo = i.body.files.filter((f) => f.source === 'demo');
  assert.ok(demo.length > 0 && demo.every((f) => /^[0-9a-f]{64}$/.test(f.sha256 ?? '')), JSON.stringify(i.body.files));
  // E8 only (E7 is confirmed but not selected), named by its evidence id and kind only: the uploaded name stays here.
  const ups = i.body.files.filter((f) => f.source === 'upload');
  assert.deepEqual(ups.map((f) => [f.name, f.sha256]), [['E8-pasted.pdf', s.store.get(e8.id)!.sha256]]);
  assert.ok(!i.body.files.some((f) => f.name.startsWith(`${e7.evidenceId}-`)));

  for (const id of [pending.id, other, archived, old, 'upl-0123456789abcdef01234567']) {
    const r = await s.intent(cookie, { attachments: [e7.id, id] });
    assert.equal(r.status, 422, id);
    assert.equal(r.body.error, 'UNKNOWN_UPLOAD', id);
  }
});

test("the uploaded file name never leaves the server: not in PayPal's file names or bytes, not in the model's input; it is still shown to the workspace", TIMEOUT, async () => {
  const s = sendSetup();
  const cookie = s.people.fullMember('Ana Lopez');
  const NAME = 'statement-ES9121000418450200051332';
  const e7 = await s.confirmText(cookie, 'UPS tracking\nDelivered 8 Oct 2026', `${NAME}.txt`);
  const up = await call(s.app, P, { body: fixture, type: 'image/png', cookie, headers: { 'x-upload-name': `${NAME}.png` } });
  const red = await call(s.app, `${P}/${up.body.upload.id}/redact`, { body: { rects: [] }, cookie });
  const e8 = (await call(s.app, `${P}/${up.body.upload.id}/confirm`, { body: { lines: red.body.readLines, sha256: red.body.upload.sha256 }, cookie })).body.upload;
  const r = (await call(s.app, `/api/cases/${CASE}/analysis`, { body: {}, cookie })) as unknown as { body: { input: AnalysisInput } };
  const docs = r.body.input.documents.filter((d) => d.id === 'E7' || d.id === 'E8');
  assert.deepEqual(docs.map((d) => [d.id, d.title]), [['E7', 'Pasted text'], ['E8', 'Uploaded screenshot']]);
  assert.ok(!JSON.stringify(r.body.input).includes('ES9121000418450200051332'));
  await s.analyse(cookie);
  const i = await s.approved(cookie, { attachments: [e7.id, e8.id] });
  assert.deepEqual(i.files.filter((f) => f.source === 'upload').map((f) => f.name), ['E7-pasted.pdf', 'E8-upload.png']);
  assert.equal((await s.send(cookie, i.id)).status, 202);
  const sent = s.sends[0]!;
  const files = sent.getAll('evidence-file') as File[];
  for (const f of files) {
    assert.ok(!f.name.includes('ES912'), f.name);
    assert.ok(!Buffer.from(await fileBytes(f)).toString('latin1').includes('ES9121000418450200051332'), f.name);
  }
  assert.ok(!JSON.stringify([...sent.entries()].filter(([, v]) => typeof v === 'string')).includes('ES9121000418450200051332'));
  // The workspace still sees the name it uploaded.
  const list = (await call(s.app, P, { cookie })).body.uploads!;
  assert.deepEqual(list.map((u) => u.name).sort(), [`${NAME}.png`, `${NAME}.txt`]);
});

test('the bytes sent are the approved ones', TIMEOUT, async () => {
  const s = sendSetup();
  const cookie = s.people.fullMember('Ana Lopez');
  const up = await uploadPng(s.app, cookie);
  const red = await call(s.app, `${P}/${up.body.upload.id}/redact`, { body: { rects: [await trackingRect()] }, cookie });
  const conf = await call(s.app, `${P}/${up.body.upload.id}/confirm`, { body: { lines: red.body.readLines, sha256: red.body.upload.sha256 }, cookie });
  assert.equal(conf.status, 200, JSON.stringify(conf.body));
  await s.analyse(cookie);
  const i = await s.approved(cookie, { attachments: [up.body.upload.id] });
  const r = await s.send(cookie, i.id);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(s.sends.length, 1);
  const files = s.sends[0]!.getAll('evidence-file') as File[];
  // Every file PayPal received is one the intent names, with the approved SHA-256 of its bytes.
  assert.deepEqual(files.map((f) => f.name), i.files.map((f) => f.name));
  for (const [n, f] of files.entries()) assert.equal(sha(await fileBytes(f)), i.files[n]!.sha256, f.name);
  const png = files.find((f) => f.name === 'E7-upload.png')!;
  assert.equal(png.type, 'image/png');
  assert.equal(sha(await fileBytes(png)), red.body.upload.sha256);
  assert.equal(i.files.find((f) => f.name === 'E7-upload.png')!.sha256, red.body.upload.sha256);
  assert.deepEqual(await fileBytes(png), s.store.sanitised(up.body.upload.id));
});

test('a covered JPEG photo is sent as its stored JPEG: E7-upload.jpg, image/jpeg, the approved bytes', TIMEOUT, async () => {
  const s = sendSetup();
  const cookie = s.people.fullMember('Ana Lopez');
  const up = await uploadPng(s.app, cookie, fixtureJpeg(), 'image/jpeg');
  const red = await call(s.app, `${P}/${up.body.upload.id}/redact`, { body: { rects: [await trackingRect()] }, cookie });
  const conf = await call(s.app, `${P}/${up.body.upload.id}/confirm`, { body: { lines: red.body.readLines, sha256: red.body.upload.sha256 }, cookie });
  assert.equal(conf.status, 200, JSON.stringify(conf.body));
  await s.analyse(cookie);
  const i = await s.approved(cookie, { attachments: [up.body.upload.id] });
  const r = await s.send(cookie, i.id);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const files = s.sends[0]!.getAll('evidence-file') as File[];
  const photo = files.find((f) => f.name === 'E7-upload.jpg')!;
  assert.equal(photo.type, 'image/jpeg');
  assert.equal(sha(await fileBytes(photo)), red.body.upload.sha256);
  assert.deepEqual(await fileBytes(photo), s.store.sanitised(up.body.upload.id));
  assert.ok(!files.some((f) => f.name.endsWith('.png') && f.name.startsWith('E7')));
});

test('a stored upload whose bytes no longer match the approval is not sent (UPLOAD_CHANGED); an intent stored without file hashes must be composed again', TIMEOUT, async () => {
  const s = sendSetup();
  const cookie = s.people.fullMember('Ana Lopez');
  const e7 = await s.confirmText(cookie, 'UPS tracking\nDelivered 8 Oct 2026', 'tracking.txt');
  await s.analyse(cookie);
  const i = await s.approved(cookie, { attachments: [e7.id] });
  s.store.update(e7.id, {}, { sanitised: new TextEncoder().encode('%PDF-1.4 other bytes') });
  const r = await s.send(cookie, i.id);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error, 'UPLOAD_CHANGED');
  assert.match(r.body.detail!, /E7/);
  assert.equal(s.sends.length, 0);

  // An intent from before file hashes (its files have none): refused as stale, never sent without the check.
  const s2 = sendSetup();
  const c2 = s2.people.fullMember('Bea');
  await s2.analyse(c2);
  const j = await s2.approved(c2);
  for (const f of s2.intents.peek(j.id)!.files) delete f.sha256;
  const r2 = await s2.send(c2, j.id);
  assert.equal(r2.status, 409, JSON.stringify(r2.body));
  assert.equal(r2.body.error, 'INTENT_STALE');
  assert.equal(s2.sends.length, 0);
});

test("A confirms E7 while B has an approved intent: B's send is refused naming E7 and A", TIMEOUT, async () => {
  const s = sendSetup();
  const ana = s.people.fullMember('Ana Lopez');
  const bea = s.people.fullMember('Bea Ruiz');
  await s.analyse(bea);
  const i = await s.approved(bea);
  await s.confirmText(ana, 'UPS tracking\nDelivered 8 Oct 2026', 'tracking.txt');
  const r = await s.send(bea, i.id);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error, 'DOCUMENTS_CHANGED');
  assert.equal(r.body.detail, 'Ana Lopez added evidence E7 since you approved; review again');
  assert.equal(s.sends.length, 0);

  // Several: the first is named, and how many more.
  await s.analyse(bea);
  const j = await s.approved(bea);
  await s.confirmText(ana, 'one', 'one.txt');
  await s.confirmText(bea, 'two', 'two.txt');
  const r2 = await s.send(bea, j.id);
  assert.equal(r2.body.detail, 'Ana Lopez added evidence E8 and 1 more since you approved; review again');
  assert.equal(s.sends.length, 0);
});

test('deleting an upload used by a send in flight is refused (SEND_IN_PROGRESS); deleting one used by an approved, unsent intent invalidates that intent', TIMEOUT, async () => {
  const s = sendSetup();
  const cookie = s.people.fullMember('Ana Lopez');
  const e7 = await s.confirmText(cookie, 'UPS tracking\nDelivered 8 Oct 2026', 'tracking.txt');
  const e8 = await s.confirmText(cookie, 'From: buyer\nIt arrived.', 'email.txt');
  await s.analyse(cookie);

  // Approved, not sent: deleting E8 voids the response that attaches it.
  const i = await s.approved(cookie, { attachments: [e8.id] });
  assert.equal((await call(s.app, `${P}/${e8.id}`, { method: 'DELETE', cookie })).status, 200);
  assert.equal(s.intents.peek(i.id)!.status, 'invalidated');
  assert.match(s.intents.peek(i.id)!.reason!, /E8.*deleted/);
  assert.equal((await s.send(cookie, i.id)).status, 409);
  assert.equal(s.sends.length, 0);

  // In flight: deleting E7 waits for the outcome.
  await s.analyse(cookie);
  const j = await s.approved(cookie, { attachments: [e7.id] });
  let release!: () => void;
  s.holdSends(new Promise<void>((r) => (release = r)));
  const sending = s.send(cookie, j.id);
  while (s.sends.length === 0) await new Promise((r) => setTimeout(r, 5));
  const del = await call(s.app, `${P}/${e7.id}`, { method: 'DELETE', cookie });
  assert.equal(del.status, 409);
  assert.equal(del.body.error, 'SEND_IN_PROGRESS');
  assert.equal(s.store.get(e7.id)!.status, 'confirmed');
  release();
  assert.equal((await sending).status, 202);
  // Once the outcome is known it can be deleted (PayPal keeps its copy; the sent intent stays sent).
  assert.equal((await call(s.app, `${P}/${e7.id}`, { method: 'DELETE', cookie })).status, 200);
  assert.equal(s.intents.peek(j.id)!.status, 'sent');
});

/** Holds the next `analyst.stored` call (composing an intent) once it has its answer, until `release()`. */
function holdStored(analyst: AnalystService) {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((ok) => (release = ok));
  const held = new Promise<void>((ok) => (reached = ok));
  const real = analyst.stored.bind(analyst);
  analyst.stored = async (input) => {
    const a = await real(input);
    analyst.stored = real;
    reached();
    await gate;
    return a;
  };
  return { release, held };
}

test('an upload deleted while an intent is being composed: nothing is created (UPLOAD_CHANGED), attached or only quoted', TIMEOUT, async () => {
  for (const attach of [true, false]) {
    const s = sendSetup();
    const cookie = s.people.fullMember('Ana Lopez');
    const e7 = await s.confirmText(cookie, 'UPS tracking\nDelivered 8 Oct 2026', 'tracking.txt');
    const e8 = await s.confirmText(cookie, `${TOKEN} email\nIt arrived.`, 'email.txt');
    const quoting = { id: 'S7', text: `Quoting ${TOKEN}.`, noteId: null, citations: [{ doc: 'E8', quote: `${TOKEN} email`, valid: true }], verdict: 'supported', reason: null, decidedBy: 'model', rewrite: null } as unknown as CaseAnalysis['sentences'][number];
    await s.analyse(cookie, [quoting]);
    const before = s.intents.size();
    const h = holdStored(s.analyst);
    const creating = s.intent(cookie, { attachments: attach ? [e7.id, e8.id] : [e7.id] });
    await h.held;
    assert.equal((await call(s.app, `${P}/${e8.id}`, { method: 'DELETE', cookie })).status, 200);
    h.release();
    const r = await creating;
    assert.equal(r.status, 409, JSON.stringify(r.body).slice(0, 300));
    assert.equal(r.body.error, 'UPLOAD_CHANGED');
    assert.ok(!JSON.stringify(r.body).includes(TOKEN));
    assert.equal(s.intents.size(), before, 'no intent was created');
  }
});

test("a response whose files total more than PayPal's 50 MB per call is refused (422 ATTACHMENTS_TOO_LARGE) and nothing is created; at the limit it is created", TIMEOUT, async () => {
  assert.equal(PAYPAL_MAX_SEND_BYTES, 50_000_000);
  const compose = async (maxSendBytes?: number) => {
    const s = sendSetup(maxSendBytes ? { maxSendBytes } : {});
    const cookie = s.people.fullMember('Ana Lopez');
    const e7 = await s.confirmText(cookie, 'UPS tracking\nDelivered 8 Oct 2026', 'tracking.txt');
    await s.analyse(cookie);
    return { s, cookie, r: await s.intent(cookie, { attachments: [e7.id] }) };
  };
  // The real total is small: measure it, then set the limit to exactly it and to one byte less.
  const free = await compose();
  assert.equal(free.r.status, 201, JSON.stringify(free.r.body));
  const cookie = free.cookie;
  const approve = await call(free.s.app, `/api/disputes/${CASE}/intent/${free.r.body.id}/approve`, { body: { contentHash: free.r.body.contentHash }, cookie });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  assert.equal((await free.s.send(cookie, free.r.body.id)).status, 202);
  const total = (free.s.sends[0]!.getAll('evidence-file') as File[]).reduce((n, f) => n + f.size, 0);
  assert.ok(total > 0);
  const atLimit = await compose(total);
  assert.equal(atLimit.r.status, 201, JSON.stringify(atLimit.r.body));
  const over = await compose(total - 1);
  assert.equal(over.r.status, 422, JSON.stringify(over.r.body));
  assert.equal(over.r.body.error, 'ATTACHMENTS_TOO_LARGE');
  assert.match(over.r.body.detail!, /deselect an upload/i);
  assert.ok(over.r.body.detail!.includes(total.toLocaleString('en-US')) && over.r.body.detail!.includes((total - 1).toLocaleString('en-US')), over.r.body.detail);
  assert.equal(over.s.intents.size(), 0, 'no intent was created');
});

test('an upload only quoted by an intent (in its input, not attached) is in use: refused while sending, voids the approved intent when deleted', TIMEOUT, async () => {
  const s = sendSetup();
  const cookie = s.people.fullMember('Ana Lopez');
  const e7 = await s.confirmText(cookie, 'UPS tracking\nDelivered 8 Oct 2026', 'tracking.txt');
  const e8 = await s.confirmText(cookie, 'From: buyer\nIt arrived.', 'email.txt');
  await s.analyse(cookie);

  // Approved, not sent, attaches none of the uploads: deleting E8 (in its input) voids it.
  const i = await s.approved(cookie);
  assert.equal((await call(s.app, `${P}/${e8.id}`, { method: 'DELETE', cookie })).status, 200);
  assert.equal(s.intents.peek(i.id)!.status, 'invalidated');
  assert.match(s.intents.peek(i.id)!.reason!, /E8.*deleted/);

  // In flight, attaching E7 only: E9 (in its input, not attached) cannot be deleted until the outcome is known.
  const e9 = await s.confirmText(cookie, 'Note\nLeft at the door.', 'note.txt');
  await s.analyse(cookie);
  const j = await s.approved(cookie, { attachments: [e7.id] });
  let release!: () => void;
  s.holdSends(new Promise<void>((r) => (release = r)));
  const sending = s.send(cookie, j.id);
  while (s.sends.length === 0) await new Promise((r) => setTimeout(r, 5));
  const del = await call(s.app, `${P}/${e9.id}`, { method: 'DELETE', cookie });
  assert.equal(del.status, 409);
  assert.equal(del.body.error, 'SEND_IN_PROGRESS');
  assert.equal(s.store.get(e9.id)!.status, 'confirmed');
  release();
  assert.equal((await sending).status, 202);
  assert.equal((await call(s.app, `${P}/${e9.id}`, { method: 'DELETE', cookie })).status, 200);
});

test('a sentence citing a corrected line of a confirmed upload is composed only with its sentence@line confirmation', TIMEOUT, async () => {
  const s = sendSetup();
  const cookie = s.people.fullMember('Ana Lopez');
  await s.confirmText(cookie, 'UPS tracking\nNot delivered 8 Oct 2026', 'tracking.txt', ['UPS tracking', 'Delivered 8 Oct 2026']);
  const S7 = { id: 'S7', text: 'UPS records the delivery on 8 Oct 2026.', noteId: null, citations: [{ doc: 'E7', quote: 'Delivered 8 Oct 2026', valid: true }], verdict: 'supported', reason: null, decidedBy: 'model', rewrite: null } as unknown as CaseAnalysis['sentences'][number];
  await s.analyse(cookie, [S7]);
  for (const confirmedCorrections of [[], ['S7@E7.l1'], ['S1@E7.l2']]) {
    const r = await s.intent(cookie, { confirmedCorrections });
    assert.equal(r.status, 422, JSON.stringify(confirmedCorrections));
    assert.equal(r.body.error, 'DRAFT_BLOCKED');
    assert.ok(r.body.blockers!.includes('sentence 7 needs review'), JSON.stringify(r.body.blockers));
  }
  const ok = await s.intent(cookie, { confirmedCorrections: ['S7@E7.l2'] });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.ok((ok.body as unknown as { sentences: { id: string }[] }).sentences.some((x) => x.id === 'S7'));
});
