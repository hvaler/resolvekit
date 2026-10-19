import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { USAGE_MAX_AGE_MS, USAGE_MAX_BYTES, UsageLog } from '../src/usage-log.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 19, 12);
const line = (daysAgo: number, n = 0) => JSON.stringify({ at: new Date(NOW - daysAgo * DAY).toISOString(), caseId: 'C', n }) + '\n';

function setup(o: { maxAgeMs?: number; maxBytes?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rk-usage-'));
  const file = join(dir, 'analyst-usage.jsonl');
  const log = new UsageLog({ file, now: () => new Date(NOW), ...o });
  const lines = () => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { n: number });
  return { dir, file, log, lines, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('defaults: 90 days and 10 MiB', () => {
  assert.equal(USAGE_MAX_AGE_MS, 90 * DAY);
  assert.equal(USAGE_MAX_BYTES, 10 * 1024 * 1024);
});

test('append writes one JSON line with its time; a missing directory is created', () => {
  const { dir, log, lines, done } = setup();
  try {
    rmSync(dir, { recursive: true, force: true });
    log.append({ caseId: 'C', n: 1 });
    assert.deepEqual(lines().map((l) => l.n), [1]);
    assert.match(readFileSync(join(dir, 'analyst-usage.jsonl'), 'utf8'), /"at":"2026-10-19T12:00:00.000Z"/);
  } finally {
    done();
  }
});

test('sweep drops lines older than the age limit, keeps the rest in order', () => {
  const { file, log, lines, done } = setup();
  try {
    writeFileSync(file, line(120, 1) + line(91, 2) + line(89, 3) + line(1, 4));
    assert.deepEqual(log.sweep(), { dropped: 2 });
    assert.deepEqual(lines().map((l) => l.n), [3, 4]);
    assert.deepEqual(log.sweep(), { dropped: 0 });
  } finally {
    done();
  }
});

test('sweep keeps the newest lines within the size limit; torn or undated lines go', () => {
  const { file, log, lines, done } = setup({ maxBytes: 3 * line(0, 0).length + 5 });
  try {
    writeFileSync(file, 'not json\n' + line(5, 1) + line(4, 2) + line(3, 3) + line(2, 4) + line(1, 5) + '{"half":');
    const r = log.sweep();
    assert.deepEqual(lines().map((l) => l.n), [3, 4, 5]);
    assert.equal(r.dropped, 4);
  } finally {
    done();
  }
});

test('sweep without a file does nothing', () => {
  const { file, log, done } = setup();
  try {
    assert.deepEqual(log.sweep(), { dropped: 0 });
    assert.equal(existsSync(file), false);
  } finally {
    done();
  }
});
