import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CaseStore, type DiscoveredCase } from '../src/caseStore.ts';

const rec = (n: number, over: Partial<DiscoveredCase> = {}): DiscoveredCase => ({
  caseId: `d-${n}`,
  merchantId: 'MERCH1',
  disputeId: `PP-D-${n}`,
  captureId: `CAP${n}`,
  template: 'standard',
  orderRef: `RK-STD-${n}`,
  source: 'webhook',
  createdAt: '2026-11-06T10:00:00.000Z',
  ...over,
});

function inDir(f: (dir: string, file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'rk-cases-'));
  try {
    f(dir, join(dir, 'cases.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a missing file starts empty with no storage problem', () => {
  inDir((_d, file) => {
    const s = new CaseStore({ file });
    assert.deepEqual(s.all(), []);
    assert.equal(s.storageProblem(), null);
    assert.equal(s.get('x'), null);
    assert.equal(s.byDispute('x'), null);
    assert.equal(s.templateOf('x'), null);
  });
});

test('added cases survive a reopen of the same file', () => {
  inDir((_d, file) => {
    const s = new CaseStore({ file });
    assert.equal(s.add(rec(1)), true);
    assert.equal(s.add(rec(2, { template: 'settlement', source: 'scan' })), true);
    const again = new CaseStore({ file });
    assert.deepEqual(again.all(), [rec(1), rec(2, { template: 'settlement', source: 'scan' })]);
    assert.deepEqual(again.get('d-2'), rec(2, { template: 'settlement', source: 'scan' }));
    assert.deepEqual(again.byDispute('PP-D-1'), rec(1));
    assert.equal(again.templateOf('d-2'), 'settlement');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { v: 1, cases: again.all() });
  });
});

test('the same dispute or the same case id is added once', () => {
  inDir((_d, file) => {
    const s = new CaseStore({ file });
    assert.equal(s.add(rec(1)), true);
    assert.equal(s.add(rec(9, { disputeId: 'PP-D-1' })), false);
    assert.equal(s.add(rec(1, { disputeId: 'PP-D-other' })), false);
    assert.equal(s.all().length, 1);
    assert.equal(new CaseStore({ file }).all().length, 1);
  });
});

test('markEnded persists and keeps the other fields', () => {
  inDir((_d, file) => {
    const s = new CaseStore({ file });
    s.add(rec(1));
    s.markEnded('d-1', '2026-11-07T00:00:00.000Z');
    s.markEnded('unknown', '2026-11-07T00:00:00.000Z');
    assert.equal(s.get('d-1')?.endedAt, '2026-11-07T00:00:00.000Z');
    assert.deepEqual(new CaseStore({ file }).get('d-1'), rec(1, { endedAt: '2026-11-07T00:00:00.000Z' }));
  });
});

test('a corrupt file is reported, add refuses and writes nothing', () => {
  inDir((dir, file) => {
    writeFileSync(file, '{not json');
    const logs: string[] = [];
    const s = new CaseStore({ file, log: (l) => logs.push(l) });
    assert.ok(s.storageProblem());
    assert.deepEqual(s.all(), []);
    assert.equal(s.add(rec(1)), false);
    assert.deepEqual(s.all(), []);
    assert.equal(readdirSync(dir).includes('cases.json') ? readFileSync(file, 'utf8') : '{not json', '{not json');
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0);
    assert.ok(logs.some((l) => l.includes('ERROR')));
  });
});

test('a file of the wrong shape counts as corrupt', () => {
  inDir((_d, file) => {
    writeFileSync(file, JSON.stringify({ v: 1, cases: [{ caseId: 3 }] }));
    const s = new CaseStore({ file });
    assert.ok(s.storageProblem());
    assert.equal(s.add(rec(1)), false);
  });
});
