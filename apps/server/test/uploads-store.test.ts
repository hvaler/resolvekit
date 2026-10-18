import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UploadStore, type NewUpload } from '../src/uploads/store.ts';
import { UploadError } from '../src/uploads/image.ts';
import { PENDING_TTL_MS } from '../src/uploads/limits.ts';

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
  mkdirSync(join(dir, 'ws1', r.id, 'record.json.tmp')); // the record cannot be written
  assert.throws(() => ok.update(r.id, { status: 'reviewing', mime: 'image/png' }, { original: null, sanitised: bytes(2) }), (e) => e instanceof UploadError && e.code === 'STORAGE');
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
