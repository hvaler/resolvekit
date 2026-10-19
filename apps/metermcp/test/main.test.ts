import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { budgetRangeProblem } from '../src/meter.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

test('budget range: the smallest cap above the largest is a problem; equal or below is not', () => {
  assert.match(budgetRangeProblem('5.00', '6.00')!, /METERMCP_MIN_BUDGET 6\.00 is above METERMCP_BUDGET 5\.00/);
  assert.equal(budgetRangeProblem('5.00', '0.50'), null);
  assert.equal(budgetRangeProblem('1.00', '1.00'), null);
  // The hosted values (render.yaml): 5.00 / 0.50.
  assert.equal(budgetRangeProblem('5.00', '0.50'), null);
  assert.match(budgetRangeProblem('5', 'abc')!, /not an amount/);
});

test('MeterMCP refuses to start when METERMCP_MIN_BUDGET is above METERMCP_BUDGET (nothing created)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metermcp-main-'));
  try {
    const db = join(dir, 'ledger.sqlite');
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', METERMCP_BUDGET: '1.00', METERMCP_MIN_BUDGET: '2.00', METERMCP_DB: db, METERMCP_TOKEN_FILE: join(dir, 'token'), METERMCP_PORT: '0' };
    const r = spawnSync(process.execPath, [MAIN], { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /MeterMCP not started: METERMCP_MIN_BUDGET 2\.00 is above METERMCP_BUDGET 1\.00/);
    assert.equal(existsSync(db), false);
    assert.equal(existsSync(join(dir, 'token')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
