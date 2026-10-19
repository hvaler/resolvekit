/**
 * Store robustness: an unreadable store file is preserved (renamed aside), logged and reported (health, operator's
 * check) instead of being treated as empty and overwritten. Fake PayPal only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DailyCounters, durableTestHooks } from '@resolvekit/hosting';
import { caseInput, standardCase } from '@resolvekit/cases';
import { PayPalClient } from '@resolvekit/paypal';
import { createApp, DEFAULT_ORIGINS, TOKEN_HEADER } from '../src/app.ts';
import { InputPins } from '../src/analysis.ts';
import { parseBindingPools } from '../src/bindings.ts';
import { createHostedApp } from '../src/hosted.ts';
import { IntentStore } from '../src/intents.ts';
import { UploadStore } from '../src/uploads/store.ts';
import { STD_CAPTURE, TEST_SECRET, standardDispute, testAccounts } from './kit.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'rk-stores-'));
const NOW = new Date('2026-10-19T12:00:00.000Z');
const CASE = standardCase.summary.id;

test('an unreadable intents.json is preserved as intents.json.corrupt-<time>, logged and reported; the store starts empty', () => {
  const dir = tmp();
  try {
    const file = join(dir, 'intents.json');
    writeFileSync(file, '{"intents": [ {"id": "int-');
    const lines: string[] = [];
    const store = new IntentStore({ file, eventsFile: join(dir, 'audit-events.jsonl'), now: () => NOW, log: (l) => lines.push(l) });
    assert.equal(store.size(), 0);
    const kept = join(dir, 'intents.json.corrupt-2026-10-19T12-00-00.000Z');
    assert.equal(readFileSync(kept, 'utf8'), '{"intents": [ {"id": "int-');
    assert.equal(existsSync(file), false);
    const p = store.storageProblem()!;
    assert.match(p, /intents\.json could not be read/);
    assert.match(p, /intents\.json\.corrupt-2026-10-19T12-00-00\.000Z/);
    assert.ok(lines.some((l) => /ERROR/.test(l) && l.includes('intents.json.corrupt-')), lines.join('\n'));
    // New state is written to a fresh intents.json; the preserved copy stays untouched.
    store.record({ caseId: CASE, kind: 'binding_checked', actor: 'local' });
    store.flush();
    assert.equal(readFileSync(kept, 'utf8'), '{"intents": [ {"id": "int-');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('intents.json that is JSON but not intents is unreadable too; a missing one is just empty (no problem)', () => {
  const dir = tmp();
  try {
    const file = join(dir, 'intents.json');
    writeFileSync(file, '{"something":"else"}');
    const store = new IntentStore({ file, now: () => NOW });
    assert.ok(store.storageProblem());
    assert.ok(readdirSync(dir).some((f) => f.startsWith('intents.json.corrupt-')));
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    assert.equal(new IntentStore({ file, now: () => NOW }).storageProblem(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an intents.json that cannot be moved aside is never overwritten: every write is refused (a send would get 503)', () => {
  const dir = tmp();
  try {
    const file = join(dir, 'intents.json');
    writeFileSync(file, 'not json');
    Object.assign(durableTestHooks, { failAt: 'rename', match: /intents\.json$/ });
    const store = new IntentStore({ file, now: () => NOW });
    assert.match(store.storageProblem()!, /could not be read.*left in place/);
    // The write a send makes before PayPal (save now) reports failure, so the send is refused; the file stays as it was.
    assert.equal((store as unknown as { save(now: boolean): boolean }).save(true), false);
    assert.equal(readFileSync(file, 'utf8'), 'not json');
  } finally {
    Object.assign(durableTestHooks, { failAt: null, match: null });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the send log and the audit events are appended durably: a failed append is not durable', () => {
  const dir = tmp();
  try {
    const store = new IntentStore({ file: join(dir, 'intents.json'), eventsFile: join(dir, 'audit-events.jsonl'), now: () => NOW });
    assert.equal(store.recordChecked({ caseId: CASE, kind: 'send_started', actor: 'local' }).durable, true);
    durableTestHooks.failAt = 'fsync';
    assert.equal(store.recordChecked({ caseId: CASE, kind: 'send_failed', actor: 'local' }).durable, false);
    durableTestHooks.failAt = 'fsync';
    assert.equal(store.recordChecked({ caseId: CASE, kind: 'intent_created', actor: 'local' }).durable, false);
    assert.equal(readFileSync(join(dir, 'audit-events-sends.jsonl'), 'utf8').split('\n').filter(Boolean).length >= 1, true);
  } finally {
    durableTestHooks.failAt = null;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable analysis-inputs.json is preserved and reported, not overwritten', () => {
  const dir = tmp();
  try {
    const file = join(dir, 'analysis-inputs.json');
    writeFileSync(file, 'garbage');
    const lines: string[] = [];
    const pins = new InputPins({ file, now: () => NOW, log: (l) => lines.push(l) });
    assert.match(pins.storageProblem()!, /analysis-inputs\.json could not be read/);
    assert.equal(readFileSync(`${file}.corrupt-2026-10-19T12-00-00.000Z`, 'utf8'), 'garbage');
    assert.ok(lines.some((l) => /ERROR/.test(l)));
    pins.resolve(CASE, caseInput(standardCase, { kind: 'simulated' }), false);
    assert.equal(readFileSync(`${file}.corrupt-2026-10-19T12-00-00.000Z`, 'utf8'), 'garbage');
    assert.ok(existsSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local /api/health names the stores that could not be read (only when there is one)', async () => {
  const dir = tmp();
  try {
    const token = 'a'.repeat(64);
    const health = async (intents: IntentStore) => {
      const app = createApp({ paypal: null, env: 'sandbox', bindings: {}, port: 8787, token, allowedOrigins: DEFAULT_ORIGINS, intents });
      return (await (await app(new Request('http://127.0.0.1:8787/api/health', { headers: { [TOKEN_HEADER]: token } }))).json()) as Record<string, unknown>;
    };
    assert.equal('storage' in (await health(new IntentStore())), false);
    writeFileSync(join(dir, 'intents.json'), '[');
    const h = await health(new IntentStore({ file: join(dir, 'intents.json'), now: () => NOW }));
    assert.deepEqual(h.storage, ['intents']);
    assert.equal(JSON.stringify(h).includes(dir), false, 'no path on the public health answer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hosted operator check: an unreadable intents.json is a problem with where it was preserved', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'intents.json'), 'nope');
    const intents = new IntentStore({ file: join(dir, 'intents.json'), now: () => NOW });
    const OPS = 'o'.repeat(20) + '0123456789abcdef';
    const b = { dispute: 'PP-R-STORE-1', capture: STD_CAPTURE };
    const p = parseBindingPools({ [CASE]: b });
    const fetch = (async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
      return new Response(JSON.stringify({ ...standardDispute(), dispute_id: b.dispute }), { status: 200 });
    }) as typeof globalThis.fetch;
    const app = createHostedApp({
      paypal: new PayPalClient({ clientId: 'cid', clientSecret: 'secret', env: 'sandbox', fetch }),
      env: 'sandbox',
      bindings: p.bindings,
      reserve: p.reserve,
      counters: new DailyCounters({ file: null, limits: { 'live-analysis': 5, upload: 40 } }),
      site: null,
      accounts: testAccounts(() => NOW).accounts,
      identity: null,
      sessionSecret: TEST_SECRET,
      origins: ['https://rk.example.com'],
      hosts: ['rk.example.com'],
      https: true,
      opsToken: OPS,
      uploads: new UploadStore({ dir: null, now: () => NOW }),
      intents,
      now: () => NOW,
    });
    const s = (await (await app(new Request('https://rk.example.com/api/ops/status', { headers: { host: 'rk.example.com', 'x-forwarded-for': '203.0.113.9', authorization: `Bearer ${OPS}` } }))).json()) as { ok: boolean; problems: string[] };
    assert.equal(s.ok, false);
    assert.ok(s.problems.some((x) => /intents\.json could not be read/.test(x) && /corrupt-/.test(x)), s.problems.join(' | '));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
