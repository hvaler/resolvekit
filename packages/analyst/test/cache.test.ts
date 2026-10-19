import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { durableTestHooks } from '@resolvekit/hosting';
import { CACHE_MAX_AGE_MS, CACHE_MAX_BYTES, FileAnalysisStore } from '../src/cache.ts';
import type { CaseAnalysis } from '../src/types.ts';

const DAY = 86_400_000;
const key = (n: number) => n.toString(16).padStart(64, '0');
const analysis = (k: string, pad = 0) => ({ key: k, pad: 'x'.repeat(pad) }) as unknown as CaseAnalysis;

function setup(o: { maxAgeMs?: number; maxBytes?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rk-cache-'));
  let t = Date.UTC(2026, 9, 19, 12);
  const golden = new Map([[key(999), analysis(key(999))]]);
  const store = new FileAnalysisStore({ dir, golden, now: () => new Date(t), ...o });
  /** Set a cache file's last-used time to `ms` (as if written then). */
  const age = (k: string, ms: number) => utimesSync(join(dir, `${k}.json`), new Date(ms), new Date(ms));
  return { dir, store, golden, now: () => t, advance: (ms: number) => void (t += ms), age, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('defaults: 30 days unused and 100 MiB in all', () => {
  assert.equal(CACHE_MAX_AGE_MS, 30 * DAY);
  assert.equal(CACHE_MAX_BYTES, 100 * 1024 * 1024);
});

test('a failed put keeps the previous cached analysis on disk', () => {
  const { dir, store, done } = setup();
  try {
    store.put(analysis(key(1), 10));
    durableTestHooks.failAt = 'rename';
    assert.throws(() => store.put(analysis(key(1), 20)));
    assert.equal(new FileAnalysisStore({ dir, golden: new Map() }).get(key(1))!.analysis.key, key(1));
    assert.deepEqual(readdirSync(dir), [`${key(1)}.json`]);
  } finally {
    durableTestHooks.failAt = null;
    done();
  }
});

test('sweep: analyses unused for longer than the age limit go (file and memory); recent ones and golden stay', () => {
  const { dir, store, now, age, done } = setup();
  try {
    store.put(analysis(key(1)));
    store.put(analysis(key(2)));
    age(key(1), now() - 31 * DAY);
    age(key(2), now() - 29 * DAY);
    const r = store.sweep();
    assert.equal(r.removed, 1);
    assert.equal(existsSync(join(dir, `${key(1)}.json`)), false);
    assert.equal(store.get(key(1)), null, 'not served from memory either');
    assert.equal(store.get(key(2))!.origin, 'cache');
    assert.equal(store.get(key(999))!.origin, 'golden');
  } finally {
    done();
  }
});

test('a cached analysis that is read counts as used: it is not swept for age while it keeps being read', () => {
  const { dir, store, now, advance, age, done } = setup();
  try {
    store.put(analysis(key(1)));
    age(key(1), now() - 29 * DAY);
    // A fresh store (a restart) reads it from disk: that read marks it used today.
    const again = new FileAnalysisStore({ dir, golden: new Map(), now: () => new Date(now()) });
    assert.ok(again.get(key(1)));
    assert.ok(statSync(join(dir, `${key(1)}.json`)).mtimeMs >= now() - 1000);
    advance(2 * DAY);
    assert.equal(again.sweep().removed, 0);
  } finally {
    done();
  }
});

test('sweep: over the size limit the least recently used go first until the cache fits', () => {
  const { dir, store, now, age, done } = setup({ maxBytes: 2500 });
  try {
    for (let i = 1; i <= 4; i++) {
      store.put(analysis(key(i), 1000));
      age(key(i), now() - (10 - i) * 60_000); // key(1) the oldest
    }
    const r = store.sweep();
    assert.equal(r.removed, 2);
    assert.deepEqual(readdirSync(dir).sort(), [`${key(3)}.json`, `${key(4)}.json`]);
  } finally {
    done();
  }
});

test('sweep ignores files that are not analyses and a missing directory', () => {
  const { dir, store, now, done } = setup({ maxAgeMs: DAY });
  try {
    writeFileSync(join(dir, 'README.txt'), 'kept');
    utimesSync(join(dir, 'README.txt'), new Date(now() - 9 * DAY), new Date(now() - 9 * DAY));
    assert.equal(store.sweep().removed, 0);
    assert.ok(existsSync(join(dir, 'README.txt')));
    assert.equal(new FileAnalysisStore({ dir: join(dir, 'missing'), golden: new Map() }).sweep().removed, 0);
  } finally {
    done();
  }
});

test('sweep never removes the most recently used analysis, even one larger than the whole size limit', () => {
  const { dir, store, now, age, done } = setup({ maxBytes: 500 });
  try {
    store.put(analysis(key(1), 2000));
    store.put(analysis(key(2), 3000));
    age(key(1), now() - 60_000);
    age(key(2), now());
    assert.equal(store.sweep().removed, 1);
    assert.deepEqual(readdirSync(dir), [`${key(2)}.json`]);
    assert.equal(store.sweep().removed, 0);
    assert.equal(store.get(key(2))!.origin, 'cache');
  } finally {
    done();
  }
});
