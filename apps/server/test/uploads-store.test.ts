import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UploadStore, type NewUpload, type UploadRecord } from '../src/uploads/store.ts';
import { UploadError } from '../src/uploads/image.ts';
import { durableTestHooks } from '@resolvekit/hosting';
import { PDF_MAX_PAGES, PENDING_TTL_MS } from '../src/uploads/limits.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'rk-uploads-'));
const who = { id: 'u1', label: 'Owner', name: 'Ana' };
const base = (o: Partial<NewUpload> = {}): NewUpload => ({
  workspaceId: 'ws1', caseId: 'C1', boundDisputeId: 'PP-D-1', kind: 'image', name: 'proof.png', uploadedBy: who, ...o,
});
const bytes = (n: number, v = 7) => new Uint8Array(n).fill(v);
const NONE = 'upl-000000000000000000000000';

test('a record survives a restart (new store on the same dir)', () => {
  const dir = tmp();
  const a = new UploadStore({ dir });
  const r = a.create(base(), bytes(10));
  assert.match(r.id, /^upl-[0-9a-f]{24}$/);
  assert.equal(r.status, 'pending');
  assert.equal(r.expiresAt > r.createdAt, true);
  const b = new UploadStore({ dir });
  assert.deepEqual(b.get(r.id), r);
  assert.deepEqual([...b.original(r.id)!], [...bytes(10)]);
  assert.equal(b.get(NONE), null);
});

test('confirming drops the original: original() is null and the file is gone from disk', () => {
  const dir = tmp();
  const s = new UploadStore({ dir });
  const r = s.create(base(), bytes(10));
  const orig = join(dir, 'ws1', r.id, 'original.bin');
  assert.equal(existsSync(orig), true);
  const u = s.update(r.id, { status: 'confirmed', mime: 'image/png', size: 4, sha256: 'x' }, { original: null, sanitised: bytes(4, 1) });
  assert.equal(u.status, 'confirmed');
  assert.equal(s.original(r.id), null);
  assert.equal(existsSync(orig), false);
  assert.deepEqual([...s.sanitised(r.id)!], [...bytes(4, 1)]);
  assert.equal(existsSync(join(dir, 'ws1', r.id, 'sanitised.png')), true);
  const again = new UploadStore({ dir });
  assert.equal(again.original(r.id), null);
  assert.equal(again.get(r.id)!.status, 'confirmed');
  assert.throws(() => s.update(NONE, {}), (e) => e instanceof UploadError && e.code === 'NOT_FOUND' && e.status === 404);
});

test('a covered photo is stored as sanitised.jpg, read back, and removed with the upload', () => {
  const dir = tmp();
  const s = new UploadStore({ dir });
  const r = s.create(base(), bytes(10));
  s.update(r.id, { status: 'reviewing', mime: 'image/jpeg', size: 4, sha256: 'x' }, { sanitised: bytes(4, 2) });
  assert.equal(existsSync(join(dir, 'ws1', r.id, 'sanitised.jpg')), true);
  assert.equal(existsSync(join(dir, 'ws1', r.id, 'sanitised.png')), false);
  assert.deepEqual([...new UploadStore({ dir }).sanitised(r.id)!], [...bytes(4, 2)]);
  s.update(r.id, { status: 'discarded' });
  assert.equal(existsSync(join(dir, 'ws1', r.id, 'sanitised.jpg')), false);
});

test('sweep expires pending uploads after 24 h and removes their original, page images and text', () => {
  const dir = tmp();
  let t = new Date('2026-10-17T10:00:00Z');
  const s = new UploadStore({ dir, now: () => t });
  const old = s.create(base(), bytes(10));
  s.update(old.id, { status: 'reviewing', mime: 'application/pdf', readLines: ['SECRET-LINE'], lines: [{ text: 'SECRET-LINE', correctedBy: null, original: null }] }, { sanitised: bytes(3) });
  const keep = s.create(base({ name: 'later.png' }), bytes(5));
  const confirmed = s.create(base({ name: 'c.png' }), bytes(5));
  s.update(confirmed.id, { status: 'confirmed', mime: 'image/png' }, { original: null, sanitised: bytes(2) });
  t = new Date(t.getTime() + PENDING_TTL_MS + 1000);
  const fresh = s.create(base({ name: 'fresh.png' }), bytes(5));
  const res = s.sweep();
  assert.equal(res.expired, 2);
  assert.deepEqual(s.get(old.id)!.lines, []);
  assert.deepEqual(s.get(old.id)!.readLines, []);
  assert.equal(readFileSync(join(dir, 'ws1', old.id, 'record.json'), 'utf8').includes('SECRET-LINE'), false);
  assert.equal(s.get(old.id)!.status, 'discarded');
  assert.equal(s.get(keep.id)!.status, 'discarded');
  assert.equal(s.get(confirmed.id)!.status, 'confirmed');
  assert.equal(s.get(fresh.id)!.status, 'pending');
  assert.deepEqual(readdirSync(join(dir, 'ws1', old.id)), ['record.json']);
  assert.equal(s.original(old.id), null);
  assert.equal(s.sanitised(old.id), null);
  assert.equal(s.original(fresh.id)!.length, 5);
  assert.equal(s.sweep().expired, 0);
});

test('sweep removes directories with no record (a crash mid-write) and leftover originals of settled records', () => {
  const dir = tmp();
  const s = new UploadStore({ dir });
  const r = s.create(base(), bytes(5));
  mkdirSync(join(dir, 'ws1', 'upl-aaaaaaaaaaaaaaaaaaaaaaaa'), { recursive: true });
  writeFileSync(join(dir, 'ws1', 'upl-aaaaaaaaaaaaaaaaaaaaaaaa', 'original.bin'), bytes(9));
  s.update(r.id, { status: 'confirmed', mime: 'image/png' }, { original: null, sanitised: bytes(2) });
  writeFileSync(join(dir, 'ws1', r.id, 'original.bin'), bytes(5)); // a crash left it behind
  const res = s.sweep();
  assert.equal(res.orphans, 2);
  assert.equal(existsSync(join(dir, 'ws1', 'upl-aaaaaaaaaaaaaaaaaaaaaaaa')), false);
  assert.equal(existsSync(join(dir, 'ws1', r.id, 'original.bin')), false);
  assert.equal(s.sanitised(r.id)!.length, 2);
});

test('sweep never deletes a directory whose record.json is unreadable: it is moved aside as <id>.corrupt-<time> and reported', () => {
  const dir = tmp();
  const t = new Date('2026-10-29T10:00:00Z');
  const first = new UploadStore({ dir, now: () => t });
  const r = first.create(base(), bytes(5));
  first.update(r.id, { status: 'confirmed', mime: 'image/png' }, { original: null, sanitised: bytes(2) });
  // The disk damaged the record of a confirmed upload; its evidence file is still there.
  writeFileSync(join(dir, 'ws1', r.id, 'record.json'), '{"id": "upl-trunc');
  const s = new UploadStore({ dir, now: () => t });
  assert.equal(s.get(r.id), null);
  const res = s.sweep();
  assert.equal(res.corrupt, 1);
  assert.equal(res.orphans, 0);
  const aside = `${r.id}.corrupt-2026-10-29T10-00-00.000Z`;
  assert.deepEqual(readdirSync(join(dir, 'ws1')), [aside]);
  assert.deepEqual(readdirSync(join(dir, 'ws1', aside)).sort(), ['record.json', 'sanitised.png']);
  // Later sweeps and restarts leave the moved-aside folder alone.
  assert.deepEqual(s.sweep(), { expired: 0, orphans: 0, corrupt: 0 });
  assert.deepEqual(new UploadStore({ dir }).sweep(), { expired: 0, orphans: 0, corrupt: 0 });
  assert.deepEqual(readdirSync(join(dir, 'ws1')), [aside]);
});

test('archiveCase moves pending, reviewing and confirmed uploads of that case and dispute to archived; other cases and disputes untouched', () => {
  const s = new UploadStore({ dir: null });
  const a = s.create(base(), bytes(1));
  const b = s.create(base(), bytes(1));
  s.update(b.id, { status: 'reviewing' });
  const c = s.create(base(), bytes(1));
  s.update(c.id, { status: 'confirmed', mime: 'image/png' }, { original: null, sanitised: bytes(1) });
  const gone = s.create(base(), bytes(1));
  s.update(gone.id, { status: 'discarded' });
  const otherCase = s.create(base({ caseId: 'C2' }), bytes(1));
  const otherDispute = s.create(base({ boundDisputeId: 'PP-D-2' }), bytes(1));
  const noDispute = s.create(base({ boundDisputeId: null }), bytes(1));
  assert.deepEqual(s.archiveCase('C1', 'PP-D-1'), { archived: 3, failed: 0 });
  for (const x of [a, b, c]) assert.equal(s.get(x.id)!.status, 'archived');
  assert.equal(s.original(a.id), null);
  assert.equal(s.get(gone.id)!.status, 'discarded');
  assert.equal(s.get(otherCase.id)!.status, 'pending');
  assert.equal(s.get(otherDispute.id)!.status, 'pending');
  assert.equal(s.get(noDispute.id)!.status, 'pending');
  assert.deepEqual(s.archiveCase('C1', 'PP-D-1'), { archived: 0, failed: 0 });
});

test('archiving keeps the record (metadata) but drops its files and text, and the storage it used is free again', () => {
  const dir = tmp();
  const s = new UploadStore({ dir });
  const c = s.create(base(), bytes(100));
  const lines = [{ text: 'Account 9988776655', correctedBy: null, original: null }];
  s.update(c.id, { status: 'confirmed', evidenceId: 'E7', mime: 'image/png', size: 300, sha256: 'a'.repeat(64), lines, readLines: ['Account 9988776655'], rects: [{ x: 1, y: 1, w: 2, h: 2 }], analysisKeys: ['k1'] }, { original: null, sanitised: bytes(300) });
  const p = s.create(base(), bytes(200));
  assert.equal(s.usedBytes(), 500);
  assert.deepEqual(s.archiveCase('C1', 'PP-D-1'), { archived: 2, failed: 0 });
  assert.equal(s.usedBytes(), 0);
  for (const id of [c.id, p.id]) {
    assert.equal(s.original(id), null);
    assert.equal(s.sanitised(id), null);
  }
  const r = s.get(c.id)!;
  assert.deepEqual([r.status, r.evidenceId, r.name, r.sha256, r.analysisKeys], ['archived', 'E7', 'proof.png', 'a'.repeat(64), ['k1']]);
  assert.deepEqual([r.lines, r.readLines, r.rects, r.removals], [[], [], [], []]);
  // On disk too: only the record is left, and it holds no text.
  assert.deepEqual(readdirSync(join(dir, 'ws1', c.id)), ['record.json']);
  assert.ok(!readFileSync(join(dir, 'ws1', c.id, 'record.json'), 'utf8').includes('9988776655'));
  assert.deepEqual(new UploadStore({ dir }).get(c.id), r);
});

test('archiveCase never throws: a record that cannot be written is counted as failed and the others are archived', () => {
  const dir = tmp();
  const s = new UploadStore({ dir });
  const a = s.create(base(), bytes(1));
  const b = s.create(base(), bytes(1));
  // A directory where b's record belongs: writing it fails.
  const rec = join(dir, 'ws1', b.id, 'record.json');
  rmSync(rec);
  mkdirSync(rec);
  let out: ReturnType<UploadStore['archiveCase']> | null = null;
  assert.doesNotThrow(() => (out = s.archiveCase('C1', 'PP-D-1')));
  assert.deepEqual(out, { archived: 1, failed: 1 });
  assert.equal(s.get(a.id)!.status, 'archived');
  assert.equal(s.get(b.id)!.status, 'pending');
});

test("list never returns another workspace's or another dispute's uploads", () => {
  const s = new UploadStore({ dir: null });
  const mine = s.create(base(), bytes(1));
  s.create(base({ workspaceId: 'ws2' }), bytes(1));
  s.create(base({ boundDisputeId: 'PP-D-2' }), bytes(1));
  s.create(base({ boundDisputeId: null }), bytes(1));
  s.create(base({ caseId: 'C2' }), bytes(1));
  const l = s.list({ workspaceId: 'ws1', caseId: 'C1', boundDisputeId: 'PP-D-1' });
  assert.deepEqual(l.map((x) => x.id), [mine.id]);
  assert.equal(s.list({ workspaceId: 'ws1', caseId: 'C1', boundDisputeId: null }).length, 1);
  assert.equal(s.list({ workspaceId: 'ws1', caseId: 'C1', boundDisputeId: 'PP-D-1', statuses: ['confirmed'] }).length, 0);
});

test('usedBytes counts stored files', () => {
  for (const dir of [tmp(), null]) {
    const s = new UploadStore({ dir });
    assert.equal(s.usedBytes(), 0);
    const r = s.create(base(), bytes(10));
    assert.equal(s.usedBytes(), 10);
    s.update(r.id, { mime: 'image/png' }, { sanitised: bytes(6) });
    assert.equal(s.usedBytes(), 16);
    s.update(r.id, {}, { original: null });
    assert.equal(s.usedBytes(), 6);
    if (dir) assert.equal(new UploadStore({ dir }).usedBytes(), 6);
  }
});

test('an unwritable dir fails closed (STORAGE) and leaves no half record', () => {
  const root = tmp();
  const blocker = join(root, 'file');
  writeFileSync(blocker, 'x');
  const s = new UploadStore({ dir: join(blocker, 'sub') });
  assert.throws(() => s.create(base(), bytes(3)), (e) => e instanceof UploadError && e.code === 'STORAGE' && e.status === 503);
  assert.deepEqual(s.list({ workspaceId: 'ws1', caseId: 'C1', boundDisputeId: 'PP-D-1' }), []);
  assert.equal(s.usedBytes(), 0);
  // a failing update leaves the record and its files as they were
  const dir = tmp();
  const ok = new UploadStore({ dir });
  const r = ok.create(base(), bytes(3));
  // the record cannot be written (after the files were)
  Object.assign(durableTestHooks, { failAt: 'rename', match: /record\.json$/ });
  try {
    assert.throws(() => ok.update(r.id, { status: 'reviewing', mime: 'image/png' }, { original: null, sanitised: bytes(2) }), (e) => e instanceof UploadError && e.code === 'STORAGE');
  } finally {
    Object.assign(durableTestHooks, { failAt: null, match: null });
  }
  assert.equal(ok.get(r.id)!.status, 'pending');
  assert.equal(ok.original(r.id)!.length, 3);
  assert.equal(ok.sanitised(r.id), null);
});

test('ids and workspace ids are validated so paths cannot escape the dir', () => {
  const s = new UploadStore({ dir: tmp() });
  assert.throws(() => s.create(base({ workspaceId: '../x' }), bytes(1)), (e) => e instanceof UploadError && e.code === 'STORAGE');
  assert.equal(s.get('../../etc'), null);
  assert.equal(s.original('upl-../..'), null);
  assert.throws(() => s.update('../../etc', {}), (e) => e instanceof UploadError && e.code === 'NOT_FOUND');
});

test('noteAnalysisKey records a key once on the given uploads', () => {
  const s = new UploadStore({ dir: tmp() });
  const r = s.create(base(), bytes(1));
  s.update(r.id, { status: 'confirmed' });
  // Ids that are not confirmed (here an unknown one) are returned and noted nowhere.
  assert.deepEqual(s.noteAnalysisKey([r.id, NONE], 'k1'), [NONE]);
  assert.deepEqual(s.noteAnalysisKey([r.id], 'k1'), []);
  assert.deepEqual(s.get(r.id)!.analysisKeys, ['k1']);
  s.update(r.id, { status: 'deleted' });
  assert.deepEqual(s.noteAnalysisKey([r.id], 'k2'), [r.id]);
  assert.deepEqual(s.get(r.id)!.analysisKeys, ['k1']);
});

for (const end of ['discarded', 'deleted'] as const) {
  test(`${end} uploads end with only record.json and no text, and usedBytes drops`, () => {
    const dir = tmp();
    const s = new UploadStore({ dir });
    const r = s.create(base(), bytes(10));
    s.update(r.id, { status: 'reviewing', mime: 'image/png', rects: [{ x: 0, y: 0, w: 1, h: 1 }], readLines: ['SECRET-LINE'], lines: [{ text: 'SECRET-LINE', correctedBy: null, original: null }], removals: [{ start: 0, end: 1 }] }, { sanitised: bytes(6) });
    assert.equal(s.usedBytes(), 16);
    const u = s.update(r.id, { status: end });
    assert.deepEqual([u.lines, u.readLines, u.removals, u.rects], [[], [], [], []]);
    assert.deepEqual(readdirSync(join(dir, 'ws1', r.id)), ['record.json']);
    assert.equal(readFileSync(join(dir, 'ws1', r.id, 'record.json'), 'utf8').includes('SECRET-LINE'), false);
    assert.equal(s.usedBytes(), 0);
    assert.equal(s.sanitised(r.id), null);
    // a crash left the sanitised file behind: sweep removes it
    writeFileSync(join(dir, 'ws1', r.id, 'sanitised.png'), bytes(4));
    assert.equal(new UploadStore({ dir }).sweep().orphans, 1);
    assert.deepEqual(readdirSync(join(dir, 'ws1', r.id)), ['record.json']);
  });
}

test('update cannot rewrite identity or binding fields, and undefined does not overwrite', () => {
  const s = new UploadStore({ dir: tmp() });
  const r = s.create(base(), bytes(1));
  const bad = { boundDisputeId: 'PP-D-9', caseId: 'C9', workspaceId: 'ws9', kind: 'text', uploadedBy: { id: 'x', label: 'x', name: 'x' }, id: NONE, name: undefined, status: 'reviewing' } as never;
  const u = s.update(r.id, bad);
  assert.deepEqual([u.boundDisputeId, u.caseId, u.workspaceId, u.kind, u.uploadedBy, u.id, u.name, u.status], ['PP-D-1', 'C1', 'ws1', 'image', who, r.id, 'proof.png', 'reviewing']);
  assert.equal(s.get(NONE), null);
});

// -- PDF uploads --------------------------------------------------------------------------------------------

const pdfState = (job: NonNullable<UploadRecord['pdf']>['job'] = { state: 'reviewing' }): NonNullable<UploadRecord['pdf']> => ({
  pageCount: 3, selected: [1, 3], job,
  pages: [
    { original: 1, rects: [{ x: 0, y: 0, w: 2, h: 2 }], readLines: ['PDF-SECRET'], lines: [{ text: 'PDF-SECRET', correctedBy: null, original: null }], added: [{ area: { x: 1, y: 1, w: 3, h: 3 }, text: 'PDF-ADDED', by: 'u1' }], sha256: 'abc', redactions: 2, dpi: 170 },
    { original: 3, rects: [], readLines: [], lines: [], added: [], sha256: null, redactions: 0, dpi: 170 },
  ],
});
const pdfUpload = (s: UploadStore, job?: NonNullable<UploadRecord['pdf']>['job']) => {
  const r = s.create(base({ kind: 'pdf', name: 'doc.pdf' }), bytes(8));
  return s.update(r.id, { status: 'reviewing', pdf: pdfState(job) }, {
    pages: { 1: bytes(5, 1), 3: bytes(6, 3) }, thumbs: { 1: bytes(2, 9), 3: bytes(2, 8) }, origPages: { 1: bytes(4, 5) },
  });
};

test('a pdf record round-trips its pdf state and page files across a restart', () => {
  const dir = tmp();
  const s = new UploadStore({ dir });
  const r = pdfUpload(s);
  assert.deepEqual(r.pdf, pdfState());
  const b = new UploadStore({ dir });
  assert.deepEqual(b.get(r.id)!.pdf, pdfState());
  assert.deepEqual([...b.pageImage(r.id, 3)!], [...bytes(6, 3)]);
  assert.deepEqual([...b.thumb(r.id, 1)!], [...bytes(2, 9)]);
  assert.deepEqual([...b.origPage(r.id, 1)!], [...bytes(4, 5)]);
  assert.equal(b.pageImage(r.id, 2), null);
  assert.equal(b.origPage(r.id, 3), null);
  assert.equal(b.usedBytes(), 8 + 5 + 6 + 2 + 2 + 4);
});

test('setting thumbs, pages or origPages to null deletes those files only', () => {
  for (const dir of [tmp(), null]) {
    const s = new UploadStore({ dir });
    const r = pdfUpload(s);
    s.update(r.id, {}, { thumbs: { 1: null, 3: null }, origPages: { 1: null }, pages: { 3: null } });
    assert.equal(s.thumb(r.id, 1), null);
    assert.equal(s.thumb(r.id, 3), null);
    assert.equal(s.origPage(r.id, 1), null);
    assert.equal(s.pageImage(r.id, 3), null);
    assert.deepEqual([...s.pageImage(r.id, 1)!], [...bytes(5, 1)]);
    assert.equal(s.usedBytes(), 8 + 5);
    if (dir) assert.deepEqual(readdirSync(join(dir, 'ws1', r.id)).sort(), ['original.bin', 'page-1.png', 'record.json']);
  }
});

const gone = (dir: string | null, s: UploadStore, id: string) => {
  assert.equal(s.pageImage(id, 1), null);
  assert.equal(s.thumb(id, 1), null);
  assert.equal(s.origPage(id, 1), null);
  assert.equal(s.usedBytes(), 0);
  const rec = s.get(id)!;
  assert.deepEqual([rec.pdf!.pages.flatMap((p) => [p.rects, p.readLines, p.lines, p.added]).flat()], [[]]);
  assert.equal(rec.pdf!.pages.length, 2);
  if (dir) {
    assert.deepEqual(readdirSync(join(dir, 'ws1', id)), ['record.json']);
    const text = readFileSync(join(dir, 'ws1', id, 'record.json'), 'utf8');
    assert.equal(text.includes('PDF-SECRET') || text.includes('PDF-ADDED'), false);
  }
};

for (const end of ['discarded', 'deleted', 'archived'] as const) {
  for (const dir of [tmp(), null]) {
    test(`${end} pdf uploads lose every page file, thumb, render and text (${dir ? 'disk' : 'memory'})`, () => {
      const s = new UploadStore({ dir });
      const r = pdfUpload(s);
      assert.equal(s.update(r.id, { status: end }).status, end);
      gone(dir, s, r.id);
    });
  }
}

test('archiveCase and expiry purge a pdf upload completely', () => {
  const dir = tmp();
  let t = new Date('2026-10-18T10:00:00Z');
  const s = new UploadStore({ dir, now: () => t });
  const a = pdfUpload(s);
  assert.deepEqual(s.archiveCase('C1', 'PP-D-1'), { archived: 1, failed: 0 });
  gone(dir, s, a.id);
  const b = pdfUpload(s);
  t = new Date(t.getTime() + PENDING_TTL_MS + 1000);
  assert.equal(s.sweep().expired, 1);
  gone(dir, s, b.id);
});

test('sweep removes page files and text a crash left behind on a settled pdf record', () => {
  const dir = tmp();
  const s = new UploadStore({ dir });
  const r = pdfUpload(s);
  s.update(r.id, { status: 'discarded' });
  writeFileSync(join(dir, 'ws1', r.id, 'thumb-1.png'), bytes(3));
  writeFileSync(join(dir, 'ws1', r.id, 'page-2.orig.png'), bytes(3));
  assert.equal(new UploadStore({ dir }).sweep().orphans, 1);
  assert.deepEqual(readdirSync(join(dir, 'ws1', r.id)), ['record.json']);
});

for (const state of ['rendering', 'reading'] as const) {
  test(`a pdf job that was ${state} when the server stopped reloads as failed`, () => {
    const dir = tmp();
    const r = pdfUpload(new UploadStore({ dir }), { state, page: 1, of: 2 });
    const b = new UploadStore({ dir });
    assert.deepEqual(b.get(r.id)!.pdf!.job, { state: 'failed', error: 'The server restarted while reading this PDF. Discard it and upload it again.' });
    assert.equal(new UploadStore({ dir }).get(r.id)!.pdf!.job.state, 'failed');
  });
}

test('selecting, reviewing and failed pdf jobs reload as they were', () => {
  const dir = tmp();
  for (const job of [{ state: 'selecting' }, { state: 'reviewing' }, { state: 'failed', error: 'x' }] as const) {
    const r = pdfUpload(new UploadStore({ dir }), job);
    assert.deepEqual(new UploadStore({ dir }).get(r.id)!.pdf!.job, job);
  }
});

test('an invalid page number fails closed and a failed write restores the files it overwrote', () => {
  const s = new UploadStore({ dir: tmp() });
  const r = pdfUpload(s);
  assert.throws(() => s.update(r.id, { pdf: undefined }, { pages: { 1: bytes(9, 2), [-1]: bytes(1) } }), (e) => e instanceof UploadError && e.code === 'STORAGE');
  assert.deepEqual([...s.pageImage(r.id, 1)!], [...bytes(5, 1)]);
});

// -- fix round 1 --------------------------------------------------------------------------------------------

const MODES = () => [tmp(), null];
const onDisk = (dir: string | null, id: string) => (dir ? readdirSync(join(dir, 'ws1', id)).sort() : null);

test('uncovered page renders go with the original: confirm, leaving the live statuses', () => {
  for (const dir of MODES()) {
    const s = new UploadStore({ dir });
    const r = pdfUpload(s);
    assert.equal(s.origPage(r.id, 1)!.length, 4);
    // confirm drops the original and the uncovered renders, keeps the sanitised pages
    s.update(r.id, { status: 'confirmed', mime: 'application/pdf' }, { original: null, sanitised: bytes(3) });
    assert.equal(s.origPage(r.id, 1), null);
    assert.equal(s.pageImage(r.id, 1)!.length, 5);
    if (dir) assert.equal(onDisk(dir, r.id)!.includes('page-1.orig.png'), false);
    // a render written for a record that is not live is not stored
    s.update(r.id, {}, { origPages: { 1: bytes(4) } });
    assert.equal(s.origPage(r.id, 1), null);
  }
});

test('files.original null alone drops the uncovered renders of a live record', () => {
  for (const dir of MODES()) {
    const s = new UploadStore({ dir });
    const r = pdfUpload(s);
    s.update(r.id, {}, { original: null });
    assert.equal(s.original(r.id), null);
    assert.equal(s.origPage(r.id, 1), null);
    assert.equal(s.pageImage(r.id, 1)!.length, 5);
  }
});

test('origPage is null unless the record is live, even if the file is still there', () => {
  const dir = tmp();
  const s = new UploadStore({ dir });
  const r = pdfUpload(s);
  s.update(r.id, { status: 'confirmed', mime: 'application/pdf' }, { original: null });
  writeFileSync(join(dir, 'ws1', r.id, 'page-1.orig.png'), bytes(4));
  assert.equal(s.origPage(r.id, 1), null);
});

test('sweep removes uncovered renders of a confirmed record as orphans', () => {
  const dir = tmp();
  const s = new UploadStore({ dir });
  const r = pdfUpload(s);
  s.update(r.id, { status: 'confirmed', mime: 'application/pdf' }, { original: null });
  writeFileSync(join(dir, 'ws1', r.id, 'page-2.orig.png'), bytes(4));
  assert.equal(new UploadStore({ dir }).sweep().orphans, 1);
  assert.equal(readdirSync(join(dir, 'ws1', r.id)).includes('page-2.orig.png'), false);
  assert.equal(s.sweep().orphans, 0);
  assert.equal(s.pageImage(r.id, 1)!.length, 5);
});

test('sweep in memory mode removes leftover pdf files of settled records and uncovered renders of confirmed ones', () => {
  let t = new Date('2026-10-18T10:00:00Z');
  const s = new UploadStore({ dir: null, now: () => t });
  const live = pdfUpload(s);
  const conf = pdfUpload(s);
  s.update(conf.id, { status: 'confirmed', mime: 'application/pdf' }, { original: null });
  (s as any).writeFile(conf, 'page-2.orig.png', bytes(4));
  assert.equal(s.sweep().orphans, 1);
  assert.equal(s.origPage(conf.id, 2), null);
  const dead = pdfUpload(s);
  s.update(dead.id, { status: 'discarded' });
  (s as any).writeFile(dead, 'thumb-2.png', bytes(4));
  assert.equal(s.sweep().orphans, 1);
  assert.equal(s.thumb(dead.id, 2), null);
  assert.equal(s.usedBytes(), 27 + 15);
  void live;
  t = new Date(t.getTime() + PENDING_TTL_MS + 1000);
  assert.equal(s.sweep().expired, 1);
  assert.equal(s.usedBytes(), 15);
});

test('memory mode: archiveCase and expiry purge a pdf upload completely', () => {
  let t = new Date('2026-10-18T10:00:00Z');
  const s = new UploadStore({ dir: null, now: () => t });
  const a = pdfUpload(s);
  assert.deepEqual(s.archiveCase('C1', 'PP-D-1'), { archived: 1, failed: 0 });
  gone(null, s, a.id);
  const b = pdfUpload(s);
  t = new Date(t.getTime() + PENDING_TTL_MS + 1000);
  assert.equal(s.sweep().expired, 1);
  gone(null, s, b.id);
});

test('page and thumb numbers must be integers within 1..PDF_MAX_PAGES, in readers and writers', () => {
  const bad = [0, -1, PDF_MAX_PAGES + 1, 1.5, 1e21, NaN];
  for (const dir of MODES()) {
    const s = new UploadStore({ dir });
    const r = pdfUpload(s);
    const before = onDisk(dir, r.id);
    const storageErr = (e: unknown) => e instanceof UploadError && e.code === 'STORAGE';
    for (const n of bad) {
      assert.throws(() => s.pageImage(r.id, n), storageErr, `pageImage ${n}`);
      assert.throws(() => s.origPage(r.id, n), storageErr, `origPage ${n}`);
      assert.throws(() => s.thumb(r.id, n), storageErr, `thumb ${n}`);
      for (const key of ['pages', 'origPages', 'thumbs']) {
        assert.throws(() => s.update(r.id, {}, { [key]: { [String(n)]: bytes(1) } }), storageErr, `${key} ${n}`);
        assert.throws(() => s.update(r.id, {}, { [key]: { [String(n)]: null } }), storageErr, `${key} null ${n}`);
      }
    }
    assert.deepEqual(onDisk(dir, r.id), before);
    s.update(r.id, {}, { pages: { [PDF_MAX_PAGES]: bytes(1) } });
    assert.equal(s.pageImage(r.id, PDF_MAX_PAGES)!.length, 1);
  }
});
