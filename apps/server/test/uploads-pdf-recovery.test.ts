/**
 * Recovery attempts on a covered PDF: everything a viewer does not show (white text, metadata, an annotation, an
 * attachment) and the covered line itself must be gone from everything that leaves the upload: the rebuilt PDF, the
 * stored page image, the analysis input, the PayPal request, the logs and the audit trail. Then legibility at the
 * render dpi, and the size of five dense pages. Real OCR (tesseract.js, local data) and the real pdf.js child.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { PNG } from 'pngjs';
import type { AnalysisInput } from '@resolvekit/analyst/node';
import { MAX_STORED_BYTES, PAYPAL_MAX_SEND_BYTES, PDF_RENDER_DPI } from '../src/uploads/limits.ts';
import { closeOcr, ocrPng } from '../src/uploads/ocr.ts';
import { renderPage } from '../src/uploads/pdf-input.ts';
import { A4, densePdf, secretsPdf, textPdf, type Secrets } from './fixtures/make-pdfs.ts';
import { CASE, P, call, fileBytes, req, sendSetup, sha } from './uploads-kit.ts';

after(() => closeOcr());

const SLOW = { timeout: 300_000 };

type Rect = { x: number; y: number; w: number; h: number };
type Job = { state: string; error?: string };
type Page = { original: number; readLines: string[]; sha256: string | null };
type PdfView = { id: string; status: string; evidenceId: string | null; pdf: { pages: Page[]; job: Job } };
type App = ReturnType<typeof sendSetup>['app'];

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const view = (r: { body: unknown }) => (r.body as { upload: PdfView }).upload;
const uploadPdf = (app: App, cookie: string, bytes: Uint8Array, name: string) =>
  call(app, P, { body: bytes, type: 'application/pdf', cookie, headers: { 'x-upload-name': name } });
/** Poll GET /uploads, as the web app does, until the upload's pages are read (or the job failed). */
async function settled(app: App, cookie: string, id: string): Promise<PdfView> {
  for (let i = 0; i < 2400; i++) {
    const list = (await call(app, P, { cookie })).body.uploads as unknown as PdfView[];
    const u = list.find((x) => x.id === id)!;
    if (u.pdf.job.state === 'reviewing' || u.pdf.job.state === 'failed') return u;
    await sleep(100);
  }
  throw new Error('the job did not finish');
}
/** Cover every page (`covers[k-1]` on page k) and confirm each page with its lines as read. */
async function coverAndConfirm(app: App, cookie: string, id: string, covers: Rect[][]) {
  let pages: Page[] = [];
  for (const [i, rects] of covers.entries()) {
    const c = await call(app, `${P}/${id}/redact`, { body: { page: i + 1, rects }, cookie });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    pages = view(c).pdf.pages;
  }
  const conf = await call(app, `${P}/${id}/confirm`, { body: { pages: pages.map((p) => ({ lines: p.readLines, added: [], sha256: p.sha256 })) }, cookie });
  assert.equal(conf.status, 200, JSON.stringify(conf.body));
  return view(conf);
}

/**
 * A 16-digit random token. Digits, because OCR reads digit runs exactly at this size and mixed random letters and
 * digits it does not (measured: 4/A, 9/O, 3/S swapped in about a third of 14-character mixed tokens at 12 pt).
 */
const token = () => Array.from({ length: 16 }, () => String(randomInt(10))).join('');

/** Every stream of a PDF, as stored and, when it is FlateDecode, inflated; with its dictionary. */
function streams(pdf: Uint8Array): { dict: string; raw: Buffer; data: Buffer }[] {
  const b = Buffer.from(pdf);
  const s = b.toString('latin1');
  const out: { dict: string; raw: Buffer; data: Buffer }[] = [];
  for (const m of s.matchAll(/<<([^]*?)\/Length (\d+) >>\nstream\n/g)) {
    const start = m.index + m[0].length;
    const raw = b.subarray(start, start + Number(m[2]));
    assert.equal(s.slice(start + raw.length, start + raw.length + 10), '\nendstream');
    out.push({ dict: m[1]!, raw, data: m[1]!.includes('/FlateDecode') ? inflateSync(raw) : raw });
  }
  return out;
}

/** The places a secret could be spelt in bytes: plain, UTF-16 either way, hex either case. */
const spellings = (secret: string) => {
  const hex = Buffer.from(secret, 'latin1').toString('hex');
  return [secret, Buffer.from(secret, 'utf16le').toString('latin1'), Buffer.from(secret, 'utf16le').swap16().toString('latin1'), hex, hex.toUpperCase()];
};
/** Fails naming `where` if any secret, in any spelling, is in `haystack` (read as latin1 when bytes). */
function absent(secrets: Record<string, string>, haystack: string | Uint8Array, where: string) {
  const h = typeof haystack === 'string' ? haystack : Buffer.from(haystack).toString('latin1');
  for (const [name, secret] of Object.entries(secrets)) {
    for (const s of spellings(secret)) assert.ok(!h.includes(s), `the ${name} secret is in ${where}`);
  }
}
/** OCR may misread a character: no 8-digit run of any secret token appears in the text, spaces aside. */
function absentFromOcr(tokens: Record<string, string>, text: string, where: string) {
  const t = text.replace(/\s+/g, '');
  for (const [name, secret] of Object.entries(tokens)) {
    for (let i = 0; i + 8 <= secret.length; i++) assert.ok(!t.includes(secret.slice(i, i + 8)), `part of the ${name} secret is in ${where}`);
  }
}

/** Every pixel of `r` in an RGB(A) buffer of `width` pixels is 0,0,0. */
function black(data: Uint8Array, width: number, channels: 3 | 4, r: Rect, where: string) {
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * width + x) * channels;
      if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 0) assert.fail(`pixel ${x},${y} of ${where} is not black`);
    }
  }
}

test('recovery attempts: no secret of a covered PDF page reaches the rebuilt PDF, its page image, the analysis, PayPal, the logs or the audit', SLOW, async () => {
  const tokens = { visible: token(), white: token(), info: token(), xmp: token(), annotation: token(), attachment: token() };
  assert.equal(new Set(Object.values(tokens)).size, 6);
  const secrets: Secrets = { ...tokens, visible: `Ref ${tokens.visible}` };
  const pdf = secretsPdf(secrets, 500);
  // The fixture really holds them (the raw file, before anything else).
  for (const t of Object.values(tokens)) assert.ok(Buffer.from(pdf).toString('latin1').includes(t));

  // Everything printed while the upload is handled, besides the app's own log lines.
  const printed: string[] = [];
  const restore: (() => void)[] = [];
  for (const k of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const real = console[k];
    console[k] = (...a: unknown[]) => (printed.push(a.map(String).join(' ')), real.apply(console, a));
    restore.push(() => (console[k] = real));
  }
  for (const stream of [process.stdout, process.stderr]) {
    const real = stream.write;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => (printed.push(String(chunk)), (real as (...a: unknown[]) => boolean).call(stream, chunk, ...rest))) as typeof stream.write;
    restore.push(() => (stream.write = real));
  }

  const s = sendSetup();
  try {
    const cookie = s.people.fullMember('Ana Lopez');
    const r = await uploadPdf(s.app, cookie, pdf, 'statement.pdf');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = view(r).id;
    const read = await settled(s.app, cookie, id);
    assert.equal(read.pdf.job.state, 'reviewing', JSON.stringify(read.pdf.job));
    const dpi = s.store.get(id)!.pdf!.pages[0]!.dpi;
    assert.equal(dpi, PDF_RENDER_DPI);
    // Uncovered, OCR reads the visible secret and nothing hidden: the cover is what removes it.
    const before = read.pdf.pages[0]!.readLines.join('\n');
    assert.ok(before.replace(/\s+/g, '').includes(tokens.visible), before);
    absentFromOcr({ white: tokens.white, info: tokens.info, xmp: tokens.xmp, annotation: tokens.annotation, attachment: tokens.attachment }, before, 'the uncovered reading');
    // An editor may look at the text layer hint (it shows the white text); nothing keeps it.
    const hint = await s.app(req(`${P}/${id}/page/1/hint`, { cookie }));
    assert.equal(hint.status, 200);
    assert.ok(JSON.stringify(await hint.json()).includes(tokens.white));

    // The visible line sits 60 pt from the top, 12 pt high: cover 44..68 pt from the top, across the page.
    const px = (pt: number) => Math.round((pt * dpi) / 72);
    const cover: Rect = { x: px(20), y: px(44), w: px(555), h: px(24) };
    const u = await coverAndConfirm(s.app, cookie, id, [[cover]]);
    assert.equal(u.status, 'confirmed');

    // The stored page image: the cover is solid black, and OCR of it finds none of the secrets.
    const stored = s.store.pageImage(id, 1)!;
    const png = PNG.sync.read(Buffer.from(stored));
    black(png.data, png.width, 4, cover, 'the stored page image');
    absent(tokens, stored, 'the stored page image bytes');
    const ocr = (await ocrPng(stored)).map((l) => l.text).join('\n');
    absentFromOcr(tokens, ocr, 'the OCR of the stored page image');

    // sanitised.pdf: its bytes, every stream inflated, no structure that could carry anything but the image.
    const sanitised = s.store.sanitised(id)!;
    absent(tokens, sanitised, 'sanitised.pdf');
    const all = streams(sanitised);
    assert.equal(all.length, 2, 'one image and one content stream');
    for (const st of all) absent(tokens, st.data, `a stream of sanitised.pdf (${st.dict.trim()})`);
    const text = Buffer.from(sanitised).toString('latin1');
    for (const key of ['/Metadata', '/Annots', '/EmbeddedFile', '/Font', '/JavaScript', '/JS', '/Names', '/OpenAction', '/AA', '/Subject', '/Author']) {
      assert.ok(!text.includes(key), `sanitised.pdf carries ${key}`);
    }
    // The page image inside it is the covered one, black under the cover.
    const image = all.find((st) => st.dict.includes('/Subtype /Image'))!;
    const width = Number(/\/Width (\d+)/.exec(image.dict)![1]);
    assert.equal(width, png.width);
    black(image.data, width, 3, cover, 'the image in sanitised.pdf');

    // The analysis input.
    const a = (await call(s.app, `/api/cases/${CASE}/analysis`, { body: {}, cookie })) as unknown as { body: { input: AnalysisInput } };
    assert.ok(a.body.input);
    const input = JSON.stringify(a.body.input);
    assert.ok(input.includes(u.evidenceId!), 'the upload is in the analysis input');
    absent(tokens, input, 'the analysis input');

    // The send: the PayPal multipart body as it goes on the wire.
    await s.analyse(cookie);
    const i = await s.approved(cookie, { attachments: [id] });
    const sent = await s.send(cookie, i.id);
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    assert.equal(s.sends.length, 1);
    const body = new Uint8Array(await new Response(s.sends[0]!).arrayBuffer());
    absent(tokens, body, 'the PayPal multipart body');
    const files = s.sends[0]!.getAll('evidence-file') as File[];
    const up = files.find((f) => f.name === `${u.evidenceId}-upload.pdf`)!;
    assert.equal(sha(await fileBytes(up)), sha(sanitised));
    for (const f of files) for (const st of streams(await fileBytes(f))) absent(tokens, st.data, `a stream of ${f.name}`);

    // What the server kept about it, the workspace's view of it, the logs and the audit trail.
    absent(tokens, JSON.stringify(s.store.get(id)), 'the upload record');
    absent(tokens, JSON.stringify((await call(s.app, P, { cookie: s.people.member() })).body), 'the uploads list');
    assert.ok(s.lines.length > 0);
    absent(tokens, s.lines.join('\n'), 'the log');
    absent(tokens, printed.join('\n'), 'the console');
    const audit = JSON.stringify(s.intents.events(CASE));
    assert.ok(audit.includes(id));
    absent(tokens, audit, 'the audit trail');
  } finally {
    for (const r of restore) r();
  }
});

test('legibility: an 8 pt account number and tracking number rendered at PDF_RENDER_DPI are read exactly', SLOW, async () => {
  // Measured on this machine: at 150 dpi the UPS number reads 12999AA... (Z as 2); at 170 every line below is exact.
  // Random mixes of letters and digits are not in this list: about 62% of them read exactly at 170 and at 200 dpi
  // alike (4 read as A, for example), so that is the OCR, not the resolution; the merchant corrects such a line.
  const lines = [
    'Account number 4021987763',
    'Tracking number 1Z999AA10123456784',
    'IBAN ES9121000418450200051332',
    'USPS 9400111899223197428490',
    'Amazon TBA304512778000',
  ];
  const pdf = textPdf([{ ...A4, size: 8, lines }]);
  const page = await renderPage(pdf, 1, PDF_RENDER_DPI);
  assert.equal(page.dpi, PDF_RENDER_DPI);
  const png = new Uint8Array(PNG.sync.write({ width: page.width, height: page.height, data: Buffer.from(page.rgba) } as PNG));
  const read = (await ocrPng(png)).map((l) => l.text.replace(/\s+/g, ' '));
  for (const l of lines) assert.ok(read.includes(l), `${l} in ${JSON.stringify(read)}`);
});

test('size: five dense A4 pages rebuild under MAX_STORED_BYTES, and with the demo PDFs stay under PAYPAL_MAX_SEND_BYTES', SLOW, async () => {
  const s = sendSetup();
  const cookie = s.people.fullMember('Ana Lopez');
  const r = await uploadPdf(s.app, cookie, densePdf(5), 'dense.pdf');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = view(r).id;
  const read = await settled(s.app, cookie, id);
  assert.equal(read.pdf.job.state, 'reviewing', JSON.stringify(read.pdf.job));
  assert.equal(read.pdf.pages.length, 5);
  const u = await coverAndConfirm(s.app, cookie, id, [[], [], [], [], []]);
  const pdf = s.store.sanitised(id)!;
  assert.ok(pdf.length < MAX_STORED_BYTES, `sanitised.pdf is ${pdf.length} bytes`);

  await s.analyse(cookie);
  const i = await s.approved(cookie, { attachments: [id] });
  assert.equal((await s.send(cookie, i.id)).status, 202);
  const files = s.sends[0]!.getAll('evidence-file') as File[];
  assert.ok(files.some((f) => f.name === `${u.evidenceId}-upload.pdf`));
  assert.ok(files.length > 1, 'the demo PDFs go too');
  const total = files.reduce((n, f) => n + f.size, 0);
  assert.ok(total < PAYPAL_MAX_SEND_BYTES, `the files total ${total} bytes`);
});
