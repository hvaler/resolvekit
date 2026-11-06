import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CASE_FILES, SETTLEMENT_CASE_ID, caseFileOf, discoveredCaseFile, templateForOrderRef, TEMPLATE_CASE_IDS } from '../src/index.ts';

const SID = 'mm-sess-0123456789abcdef0123456789abcdef-settle';

test('templateForOrderRef maps the order reference prefix to a template', () => {
  assert.deepEqual(templateForOrderRef('rk-std-a1b2c3'), { template: 'standard', orderRef: 'rk-std-a1b2c3' });
  assert.deepEqual(templateForOrderRef('rk-stl-x'), { template: 'settlement', orderRef: 'rk-stl-x' });
  assert.deepEqual(templateForOrderRef(SID), { template: 'agent', orderRef: SID });
});

test('templateForOrderRef rejects anything else', () => {
  for (const v of ['INV2-ABCD', '', null, undefined, 'rk-std-', 'rk-stl-', 'mm-sess-abc-settle']) assert.equal(templateForOrderRef(v), null);
});

test('TEMPLATE_CASE_IDS points at fixed case files', () => {
  assert.equal(TEMPLATE_CASE_IDS.settlement, SETTLEMENT_CASE_ID);
  for (const id of Object.values(TEMPLATE_CASE_IDS)) assert.ok(CASE_FILES[id]);
});

test('discoveredCaseFile clones the template under the new id', () => {
  const f = discoveredCaseFile('settlement', 'PP-R-QFP-10195597');
  assert.equal(f.summary.id, 'PP-R-QFP-10195597');
  assert.equal(f.audience, 'owner');
  assert.equal(f.kind, CASE_FILES[SETTLEMENT_CASE_ID]!.kind);
  f.summary.title = 'mutated';
  f.evidence.length = 0;
  assert.equal(CASE_FILES[SETTLEMENT_CASE_ID]!.summary.id, SETTLEMENT_CASE_ID);
  assert.notEqual(CASE_FILES[SETTLEMENT_CASE_ID]!.summary.title, 'mutated');
  assert.ok(CASE_FILES[SETTLEMENT_CASE_ID]!.evidence.length > 0);
});

test('caseFileOf: fixed first, then discovered, else null', () => {
  assert.equal(caseFileOf(SETTLEMENT_CASE_ID, () => 'standard'), CASE_FILES[SETTLEMENT_CASE_ID]);
  assert.equal(caseFileOf('PP-R-NEW-1', (id) => (id === 'PP-R-NEW-1' ? 'agent' : null))!.summary.id, 'PP-R-NEW-1');
  assert.equal(caseFileOf('PP-R-NOPE', () => null), null);
});
