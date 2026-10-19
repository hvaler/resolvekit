import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFileDurable, durableTestHooks, fsyncDir, preserveCorrupt, readStoreFile, sweepDurableTmp, writeFileDurable } from '../src/durable.ts';

function dir() {
  const d = mkdtempSync(join(tmpdir(), 'durable-'));
  return { d, done: () => rmSync(d, { recursive: true, force: true }) };
}

test('writeFileDurable writes the new content and leaves no temporary file', () => {
  const { d, done } = dir();
  try {
    const f = join(d, 'state.json');
    writeFileDurable(f, '{"a":1}');
    assert.equal(readFileSync(f, 'utf8'), '{"a":1}');
    writeFileDurable(f, new Uint8Array([1, 2, 3]));
    assert.deepEqual([...readFileSync(f)], [1, 2, 3]);
    assert.deepEqual(readdirSync(d), ['state.json']);
  } finally {
    done();
  }
});

for (const step of ['write', 'fsync', 'rename'] as const) {
  test(`a write that fails at ${step} throws, keeps the old file intact and removes its temporary file`, () => {
    const { d, done } = dir();
    try {
      const f = join(d, 'state.json');
      writeFileDurable(f, 'old content');
      durableTestHooks.failAt = step;
      assert.throws(() => writeFileDurable(f, 'new content that never lands'), /injected/);
      assert.equal(durableTestHooks.failAt, null);
      assert.equal(readFileSync(f, 'utf8'), 'old content');
      assert.deepEqual(readdirSync(d), ['state.json']);
    } finally {
      durableTestHooks.failAt = null;
      done();
    }
  });
}

test('a write into a missing directory throws and creates nothing', () => {
  const { d, done } = dir();
  try {
    assert.throws(() => writeFileDurable(join(d, 'no', 'such', 'file.json'), 'x'), { code: 'ENOENT' });
    assert.deepEqual(readdirSync(d), []);
  } finally {
    done();
  }
});

test('appendFileDurable creates the file, appends in order, and a failed append throws', () => {
  const { d, done } = dir();
  try {
    const f = join(d, 'log.jsonl');
    appendFileDurable(f, 'one\n');
    appendFileDurable(f, 'two\n');
    assert.equal(readFileSync(f, 'utf8'), 'one\ntwo\n');
    durableTestHooks.failAt = 'fsync';
    assert.throws(() => appendFileDurable(f, 'three\n'), /injected/);
  } finally {
    durableTestHooks.failAt = null;
    done();
  }
});

test('fsyncDir never throws (Windows cannot fsync a directory; a missing one is ignored too)', () => {
  const { d, done } = dir();
  try {
    writeFileSync(join(d, 'x'), 'x');
    fsyncDir(d);
    fsyncDir(join(d, 'missing'));
  } finally {
    done();
  }
});

test('the test hook can target one file: other writes go through until it is hit', () => {
  const { d, done } = dir();
  try {
    durableTestHooks.failAt = 'rename';
    durableTestHooks.match = /record\.json$/;
    writeFileDurable(join(d, 'page.png'), 'p');
    assert.throws(() => writeFileDurable(join(d, 'record.json'), 'r'), /injected rename/);
    assert.equal(durableTestHooks.failAt, null);
    writeFileDurable(join(d, 'record.json'), 'r2');
    assert.deepEqual(readdirSync(d).sort(), ['page.png', 'record.json']);
  } finally {
    durableTestHooks.failAt = null;
    durableTestHooks.match = null;
    done();
  }
});

test('preserveCorrupt moves the file aside with its content and a timestamped name; a missing file gives null', () => {
  const { d, done } = dir();
  try {
    const f = join(d, 'intents.json');
    writeFileSync(f, '{not json');
    const to = preserveCorrupt(f, new Date('2026-10-19T12:34:56.789Z'));
    assert.equal(to, join(d, 'intents.json.corrupt-2026-10-19T12-34-56.789Z'));
    assert.equal(readFileSync(to!, 'utf8'), '{not json');
    assert.deepEqual(readdirSync(d), ['intents.json.corrupt-2026-10-19T12-34-56.789Z']);
    assert.equal(preserveCorrupt(f), null);
  } finally {
    done();
  }
});

test('appendFileDurable after a torn last line starts a new line, so the next event is not swallowed', () => {
  const { d, done } = dir();
  try {
    const f = join(d, 'sends.jsonl');
    writeFileSync(f, '{"ok":1}\n{"torn":');
    appendFileDurable(f, '{"ok":2}\n');
    const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(lines, ['{"ok":1}', '{"torn":', '{"ok":2}']);
    appendFileDurable(f, '{"ok":3}\n');
    assert.equal(readFileSync(f, 'utf8').endsWith('{"ok":2}\n{"ok":3}\n'), true);
  } finally {
    done();
  }
});

test('a rename that is busy (EBUSY/EPERM) is retried: two busy tries still write; three fail and keep the old file', () => {
  const { d, done } = dir();
  try {
    const f = join(d, 'state.json');
    writeFileDurable(f, 'old');
    durableTestHooks.renameBusy = 2;
    writeFileDurable(f, 'new');
    assert.equal(readFileSync(f, 'utf8'), 'new');
    durableTestHooks.renameBusy = 3;
    assert.throws(() => writeFileDurable(f, 'never'), { code: 'EBUSY' });
    assert.equal(readFileSync(f, 'utf8'), 'new');
    assert.deepEqual(readdirSync(d), ['state.json']);
  } finally {
    durableTestHooks.renameBusy = 0;
    done();
  }
});

test('readStoreFile: missing, text, or a read error (never mistaken for corrupt)', () => {
  const { d, done } = dir();
  try {
    const f = join(d, 'x.json');
    assert.deepEqual(readStoreFile(f), { kind: 'missing' });
    writeFileSync(f, '{}');
    assert.deepEqual(readStoreFile(f), { kind: 'text', text: '{}' });
    durableTestHooks.readError = { match: /x\.json$/, code: 'EBUSY' };
    assert.deepEqual(readStoreFile(f), { kind: 'error', code: 'EBUSY' });
    assert.deepEqual(readStoreFile(f), { kind: 'text', text: '{}' });
  } finally {
    durableTestHooks.readError = null;
    done();
  }
});

test('sweepDurableTmp removes only old files with the durable temporary name', () => {
  const { d, done } = dir();
  try {
    const now = Date.now();
    const old = (name: string) => {
      writeFileSync(join(d, name), 'x');
      utimesSync(join(d, name), new Date(now - 11 * 60_000), new Date(now - 11 * 60_000));
    };
    old('intents.json.1234.0a1b2c3d.tmp');
    old('notes.tmp');
    writeFileSync(join(d, 'intents.json.99.deadbeef.tmp'), 'in progress');
    assert.equal(sweepDurableTmp(d, 10 * 60_000, now), 1);
    assert.deepEqual(readdirSync(d).sort(), ['intents.json.99.deadbeef.tmp', 'notes.tmp']);
    assert.equal(sweepDurableTmp(join(d, 'missing')), 0);
  } finally {
    done();
  }
});
