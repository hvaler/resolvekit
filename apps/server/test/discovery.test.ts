import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CASE_FILES } from '@resolvekit/cases';
import type { Capture, Dispute, PayPalClient } from '@resolvekit/paypal';
import { CaseStore } from '../src/caseStore.ts';
import { createDiscovery, type Admission } from '../src/discovery.ts';
import type { MeterMcpSource, Receipt } from '../src/metermcp.ts';

const NOW = new Date('2026-11-06T12:00:00.000Z');
const TOMORROW = '2026-11-07T12:00:00.000Z';
const SELLER = 'JWULA7T75ZA4Q';
const CAPTURE = '7AB12345CD678901E';
const SESSION_REF = `mm-sess-${'a'.repeat(32)}-settle`;

function dispute(over: Partial<Dispute> = {}, tx: Partial<NonNullable<Dispute['disputed_transactions']>[number]> = {}): Dispute {
  return {
    dispute_id: 'PP-R-ABC-10001',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    status: 'WAITING_FOR_SELLER_RESPONSE',
    seller_response_due_date: TOMORROW,
    dispute_amount: { currency_code: 'USD', value: '7.00' },
    disputed_transactions: [{ seller_transaction_id: CAPTURE, gross_amount: { currency_code: 'USD', value: '7.00' }, seller: { merchant_id: SELLER }, ...tx }],
    ...over,
  };
}

const capture = (over: Partial<Capture> = {}): Capture => ({ id: CAPTURE, status: 'COMPLETED', amount: { currency_code: 'USD', value: '7.00' }, invoice_id: 'rk-std-t1', ...over });

function receipt(captured: string, captureId = CAPTURE): Receipt {
  return {
    session: { id: 'sess-1', currency: 'USD' },
    receipt_sha256: 'x',
    mandate: { cap: '2.00', order_id: null, authorization_id: null, authorization_status: null, approved_at: null, authorized_at: null },
    calls: [],
    totals: { calls: 1, ok: 1, failed: 0, pending: 0, charged: captured, cap: '2.00' },
    settlement: { status: 'captured', capture_id: captureId, capture_status: 'COMPLETED', invoice_id: SESSION_REF, captured, released: null, remainder_released: false, settled_at: null, error: null },
  } as unknown as Receipt;
}

interface Setup {
  getCapture?: (id: string) => Promise<Capture>;
  meter?: Pick<MeterMcpSource, 'findByCapture' | 'receipt'> | null;
  anchor?: string | null;
  bound?: string[];
  isBound?: (id: string) => boolean;
}

function withDiscovery(s: Setup, f: (d: ReturnType<typeof createDiscovery>, store: CaseStore, lines: string[]) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rk-discovery-'));
    try {
      const store = new CaseStore({ file: join(dir, 'cases.json') });
      const lines: string[] = [];
      const paypal = { payments: { getCapture: s.getCapture ?? (async () => capture()) } } as unknown as PayPalClient;
      const d = createDiscovery({
        paypal,
        meterMcp: s.meter === undefined ? null : s.meter,
        store,
        anchor: () => (s.anchor === undefined ? SELLER : s.anchor),
        isBound: s.isBound ?? ((id) => (s.bound ?? []).includes(id)),
        now: () => NOW,
        log: (l) => lines.push(l),
      });
      await f(d, store, lines);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const skipped = (a: Admission) => ('skipped' in a ? a.skipped : null);

const skips: Array<[string, Setup, Dispute]> = [
  ['no evaluation seller configured', { anchor: null }, dispute()],
  ["another seller's dispute", {}, dispute({}, { seller: { merchant_id: 'OTHERSELLER1' } })],
  ['already bound', { bound: ['PP-R-ABC-10001'] }, dispute()],
  ['not a not-received dispute', {}, dispute({ reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' })],
  ['not waiting for the seller (UNDER_REVIEW)', {}, dispute({ status: 'UNDER_REVIEW' })],
  ['past its response date', {}, dispute({ seller_response_due_date: '2026-11-06T11:59:59.000Z' })],
  ['no disputed capture', {}, dispute({}, { seller_transaction_id: undefined })],
  ['not from a ResolveKit order', { getCapture: async () => capture({ invoice_id: 'INV-0001' }) }, dispute()],
  ['amount does not match the order', { getCapture: async () => capture({ amount: { currency_code: 'USD', value: '8.00' } }) }, dispute()],
  ['capture could not be read', { getCapture: async () => { throw new Error('PayPal 500'); } }, dispute()],
  ['no MeterMCP receipt for this capture', { getCapture: async () => capture({ invoice_id: SESSION_REF }), meter: { findByCapture: async () => null, receipt: async () => receipt('0.45') } }, dispute({ dispute_amount: { currency_code: 'USD', value: '0.45' } }, { gross_amount: undefined })],
];

for (const [why, setup, d] of skips) {
  test(`skipped: ${why}`, withDiscovery(setup, async (disc, store) => {
    assert.equal(skipped(await disc.admit(d, 'webhook')), why);
    assert.deepEqual(store.all(), []);
  }));
}

test('skipped: a dispute already in the store is already bound', withDiscovery({}, async (disc) => {
  assert.ok('created' in (await disc.admit(dispute(), 'webhook')));
  assert.equal(skipped(await disc.admit(dispute(), 'scan')), 'already bound');
}));

test('skipped: a dispute whose id is a fixed case’s id is already bound (a discovered case may never shadow a fixed one)', withDiscovery({}, async (disc, store) => {
  for (const id of Object.keys(CASE_FILES)) {
    assert.equal(skipped(await disc.admit(dispute({ dispute_id: id }), 'webhook')), 'already bound', id);
  }
  assert.deepEqual(store.all(), []);
}));

test('skipped: no due date is past its response date', withDiscovery({}, async (disc) => {
  assert.equal(skipped(await disc.admit(dispute({ seller_response_due_date: undefined }), 'webhook')), 'past its response date');
}));

test('skipped: the disputed amount differs from the order even when the capture matches', withDiscovery({}, async (disc) => {
  assert.equal(skipped(await disc.admit(dispute({ dispute_amount: { currency_code: 'USD', value: '6.00' } }), 'webhook')), 'amount does not match the order');
}));

test('skipped: the capture currency differs from the order', withDiscovery({ getCapture: async () => capture({ amount: { currency_code: 'EUR', value: '7.00' } }) }, async (disc) => {
  assert.equal(skipped(await disc.admit(dispute(), 'webhook')), 'amount does not match the order');
}));

test('skipped: MeterMCP not configured or failing means no receipt', async () => {
  const agent = dispute({ dispute_amount: { currency_code: 'USD', value: '0.45' } }, { gross_amount: undefined });
  const cap = async () => capture({ invoice_id: SESSION_REF, amount: { currency_code: 'USD', value: '0.45' } });
  await withDiscovery({ getCapture: cap, meter: null }, async (disc) => {
    assert.equal(skipped(await disc.admit(agent, 'webhook')), 'no MeterMCP receipt for this capture');
  })();
  await withDiscovery({ getCapture: cap, meter: { findByCapture: async () => { throw new Error('MeterMCP unreachable'); }, receipt: async () => receipt('0.45') } }, async (disc) => {
    assert.equal(skipped(await disc.admit(agent, 'webhook')), 'no MeterMCP receipt for this capture');
  })();
  await withDiscovery({ getCapture: cap, meter: { findByCapture: async () => 'sess-1', receipt: async () => receipt('0.45', 'OTHERCAPTURE0001') } }, async (disc) => {
    assert.equal(skipped(await disc.admit(agent, 'webhook')), 'no MeterMCP receipt for this capture');
  })();
});

test('a standard dispute from a ResolveKit order becomes a case', withDiscovery({}, async (disc, store, lines) => {
  const a = await disc.admit(dispute(), 'webhook');
  assert.ok('created' in a);
  const want = { caseId: 'PP-R-ABC-10001', merchantId: SELLER, disputeId: 'PP-R-ABC-10001', captureId: CAPTURE, template: 'standard', orderRef: 'rk-std-t1', source: 'webhook', createdAt: NOW.toISOString() };
  assert.deepEqual(a.created, want);
  assert.deepEqual(store.byDispute('PP-R-ABC-10001'), want);
  assert.ok(lines.some((l) => l.includes('PP-R-ABC-10001') && l.includes('standard')));
}));

test('a settlement order becomes a settlement case', withDiscovery({ getCapture: async () => capture({ invoice_id: 'rk-stl-t2' }) }, async (disc) => {
  const a = await disc.admit(dispute(), 'scan');
  assert.ok('created' in a);
  assert.equal(a.created.template, 'settlement');
  assert.equal(a.created.orderRef, 'rk-stl-t2');
  assert.equal(a.created.source, 'scan');
}));

test('an agent capture with its receipt becomes an agent case', withDiscovery({
  getCapture: async () => capture({ invoice_id: SESSION_REF, amount: { currency_code: 'USD', value: '0.45' } }),
  meter: { findByCapture: async (c) => (c === CAPTURE ? 'sess-1' : null), receipt: async () => receipt('0.45') },
}, async (disc) => {
  const a = await disc.admit(dispute({ dispute_amount: { currency_code: 'USD', value: '0.45' } }, { gross_amount: { currency_code: 'USD', value: '0.45' } }), 'webhook');
  assert.ok('created' in a);
  assert.equal(a.created.template, 'agent');
  assert.equal(a.created.orderRef, SESSION_REF);
}));

test('an agent receipt of another amount does not match the order', withDiscovery({
  getCapture: async () => capture({ invoice_id: SESSION_REF, amount: { currency_code: 'USD', value: '0.45' } }),
  meter: { findByCapture: async () => 'sess-1', receipt: async () => receipt('0.50') },
}, async (disc, store) => {
  assert.equal(skipped(await disc.admit(dispute({ dispute_amount: { currency_code: 'USD', value: '0.45' } }, { gross_amount: undefined }), 'webhook')), 'amount does not match the order');
  assert.deepEqual(store.all(), []);
}));

test('an agent capture of another amount than its receipt does not match the order', withDiscovery({
  getCapture: async () => capture({ invoice_id: SESSION_REF, amount: { currency_code: 'USD', value: '0.50' } }),
  meter: { findByCapture: async () => 'sess-1', receipt: async () => receipt('0.45') },
}, async (disc, store) => {
  assert.equal(skipped(await disc.admit(dispute({ dispute_amount: { currency_code: 'USD', value: '0.45' } }, { gross_amount: undefined }), 'webhook')), 'amount does not match the order');
  assert.deepEqual(store.all(), []);
}));

test('skipped: a gross amount other than the order does not match', withDiscovery({}, async (disc) => {
  assert.equal(skipped(await disc.admit(dispute({}, { gross_amount: { currency_code: 'USD', value: '7.01' } }), 'webhook')), 'amount does not match the order');
}));

test('an unexpected error is a skip, never a rejection', withDiscovery({ isBound: () => { throw new Error('boom'); } }, async (disc, store, lines) => {
  assert.equal(skipped(await disc.admit(dispute(), 'webhook')), 'dispute could not be checked');
  assert.deepEqual(store.all(), []);
  assert.ok(lines.some((l) => l.includes('unexpected error') && l.includes('boom')));
}));

let inFlight = 0;
let maxInFlight = 0;
test('concurrent admits of one dispute create one case', withDiscovery({
  getCapture: async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return capture();
  },
}, async (disc, store) => {
  const other = dispute({ dispute_id: 'PP-R-ABC-10002' });
  const [a, b, c] = await Promise.all([disc.admit(dispute(), 'webhook'), disc.admit(dispute(), 'scan'), disc.admit(other, 'scan')]);
  assert.ok('created' in a);
  assert.equal(skipped(b), 'already bound');
  assert.ok('created' in c);
  assert.equal(maxInFlight, 1, 'admissions overlapped');
  assert.equal(store.all().length, 2);
}));
