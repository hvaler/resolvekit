import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CASES } from '../evals/cases.ts';
import { HELD_OUT_CASES } from '../evals/heldout/cases.ts';

const authoring = (f: string) => fileURLToPath(new URL(`../evals/heldout/authoring/${f}`, import.meta.url));
const byName = (n: string) => HELD_OUT_CASES.find((c) => c.name === n)!;
const docText = (c: { input: { documents: Array<{ lines: Array<{ text: string }> }> } }) => c.input.documents.flatMap((d) => d.lines.map((l) => l.text));
const conflictDocs = (c: (typeof HELD_OUT_CASES)[number]) => (c.conflicts ?? []).map((k) => [k.a.doc, k.b.doc].sort().join('+')).sort();

const attacks = HELD_OUT_CASES.filter((c) => c.injection);
const plain = HELD_OUT_CASES.filter((c) => !c.injection);
const uploads = (c: (typeof HELD_OUT_CASES)[number]) => c.input.documents.filter((d) => d.tag === 'UPL');

test('the held-out set has 12 uniquely named cases, all in the held-out set', () => {
  assert.equal(HELD_OUT_CASES.length, 12);
  assert.equal(new Set(HELD_OUT_CASES.map((c) => c.name)).size, 12);
  for (const c of HELD_OUT_CASES) assert.equal(c.set, 'held-out', c.name);
});

test('composition: 2 A, 2 B, 3 C on different fields, 2 D (uploads with required facts), 3 attacks', () => {
  assert.deepEqual(HELD_OUT_CASES.map((c) => c.name.split('-')[1]), ['a1', 'a2', 'b1', 'b2', 'c1', 'c2', 'c3', 'd1', 'd2', 'e1', 'e2', 'e3']);
  for (const n of ['ho-a1-porch-delivery', 'ho-a2-graded-laptop', 'ho-b1-untracked-letter', 'ho-b2-attempt-depot-hold']) {
    assert.equal(byName(n).contradictions.length, 0, n);
    assert.deepEqual(byName(n).conflicts, [], n);
  }
  const cs = ['ho-c1-unit-swap', 'ho-c2-capture-over-invoice', 'ho-c3-pod-date-drift'].map(byName);
  for (const c of cs) assert.equal(c.conflicts!.length, 1, c.name);
  assert.deepEqual(cs.map((c) => c.conflicts![0]?.field), ['address', 'amount', 'date']);
  for (const n of ['ho-d1-courier-screenshot', 'ho-d2-manifest-pdf']) {
    const c = byName(n);
    assert.ok(uploads(c).length > 0, `${n} has uploadDocuments documents`);
    assert.ok(c.requiredFacts && c.requiredFacts.length > 0, `${n} requiredFacts`);
    for (const f of c.requiredFacts!) assert.ok(docText(c).some((t) => t.includes(f.needle)) && c.input.documents.some((d) => d.id === f.doc), `${n} ${f.id}`);
  }
  assert.equal(attacks.length, 3);
  assert.equal(plain.length, 9);
});

test('attacks: E1 on an A twin (buyer message), E2 on a C twin (carrier record), E3 on a D twin (uploaded document)', () => {
  const [e1, e2, e3] = ['ho-e1-buyer-message-refund', 'ho-e2-carrier-record-address', 'ho-e3-upload-photo-id'].map(byName);
  assert.ok(e1 && e2 && e3);
  const expect = (a: typeof e1 & {}, twin: string, type: string, tag?: string) => {
    assert.equal(a.injection!.cleanTwin, twin);
    const t = byName(twin);
    assert.ok(HELD_OUT_CASES.includes(t));
    const added = a.input.documents.filter((d) => !t.input.documents.some((x) => x.id === d.id));
    assert.deepEqual(added.map((d) => d.id), [a.injection!.doc]);
    const doc = added[0];
    assert.ok(doc);
    assert.equal(doc.type, type);
    if (tag) assert.equal(doc.tag, tag);
    assert.equal(a.input.documents.length, t.input.documents.length + 1);
    assert.deepEqual([a.trueNotes, a.baitNotes, a.group], [t.trueNotes, t.baitNotes, t.group]);
  };
  expect(e1, 'ho-a1-porch-delivery', 'Buyer message');
  expect(e2, 'ho-c1-unit-swap', 'Carrier record');
  expect(e3, 'ho-d1-courier-screenshot', 'Merchant upload · pasted text', 'UPL');
  assert.equal(e1.injection!.cleanTwin.slice(0, 4), 'ho-a');
  assert.equal(e2.injection!.cleanTwin.slice(0, 4), 'ho-c');
  assert.equal(e3.injection!.cleanTwin.slice(0, 4), 'ho-d');
  for (const a of attacks) {
    const f = a.injection!.forbidden;
    assert.ok(f.action || f.checklistChange || (f.claimPatterns && f.claimPatterns.length > 0), `${a.name} forbidden is non-empty`);
    for (const p of f.claimPatterns ?? []) assert.doesNotThrow(() => new RegExp(p, 'gi'), `${a.name} ${p}`);
  }
});

test('contradictions and conflicts agree (same count, same document pairs)', () => {
  for (const c of HELD_OUT_CASES) {
    assert.deepEqual(c.contradictions.map((p) => [...p].sort().join('+')).sort(), conflictDocs(c), c.name);
    for (const k of c.conflicts ?? []) {
      for (const s of [k.a, k.b]) assert.ok(docText(c).some((t) => t.includes(s.value)), `${c.name}: ${s.value} appears in the documents`);
    }
  }
});

test('no held-out case reuses a development case name, case id or identifier', () => {
  const devNames = new Set(CASES.map((c) => c.name));
  const devIds = new Set(CASES.flatMap((c) => [c.input.caseId, c.input.dispute.id]));
  const ident = (t: string) => t.match(/[\p{L}\p{N}][\p{L}\p{N}\-/]{7,}/gu)?.filter((w) => /\d/.test(w)) ?? [];
  const devTokens = new Set(CASES.flatMap(docText).flatMap(ident));
  assert.ok(devTokens.size >= 2);
  for (const c of HELD_OUT_CASES) {
    assert.ok(!devNames.has(c.name) && !devNames.has(c.group), c.name);
    assert.ok(!devIds.has(c.input.caseId) && !devIds.has(c.input.dispute.id), c.name);
    for (const t of docText(c).flatMap(ident)) assert.ok(!devTokens.has(t), `${c.name} reuses ${t}`);
  }
});

test('authoring checks: the claim patterns pass the author sentences and the reviewer probes (only the 2 accepted gaps are off)', () => {
  const out = execFileSync(process.execPath, [authoring('check-patterns.mjs')], { encoding: 'utf8' });
  assert.match(out, /all pass/);
  assert.ok(!/^FAIL/m.test(out));
  const probe = execFileSync(process.execPath, [authoring('probe.mjs')], { encoding: 'utf8' });
  const first = probe.split('--- with proposed fixes ---')[0];
  assert.ok(first !== undefined);
  const off = first.split('\n').filter((l) => l.startsWith('OFF'));
  assert.ok(off.length <= 2, `${off.length} probes off`);
  const gaps = ['Issue a full refund to the buyer.', 'There is no address discrepancy'];
  for (const l of off) assert.ok(gaps.some((g) => l.includes(g)), `unexpected gap: ${l}`);
  assert.match(first, /\d+ probe\(s\) off expectation/);
});
