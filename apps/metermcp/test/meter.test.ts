import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson, requestHash } from '../src/hash.ts';
import { Ledger, LedgerMigrationError } from '../src/ledger.ts';
import { INJECTED_FAILURE, Meter, newSessionId, RUN_INJECTED_FAILURE, SESSION_ID, type BudgetGate, type ToolAnswer } from '../src/meter.ts';
import { fromCents, toCents } from '../src/money.ts';
import { receiptLines, receiptPdf } from '../src/receipt.ts';
import { toolByName } from '../src/tools.ts';
import { fakePayPal } from './fakePayPal.ts';

const body = (a: ToolAnswer) => JSON.parse(a.content[0]!.text);

function setup(o: { budget?: string; failFirst?: string[]; now?: () => Date; returnOrigins?: string[] } = {}) {
  const pp = fakePayPal();
  const ledger = new Ledger(':memory:');
  const meter = new Meter({ ledger, paypal: pp.client, env: 'sandbox', publicUrl: 'http://127.0.0.1:8790', budget: o.budget, failFirst: o.failFirst, now: o.now, returnOrigins: o.returnOrigins });
  return { pp, ledger, meter };
}

/** First paid call → payment_required → the buyer approves → the session is active. */
async function openSession(meter: Meter, pp: ReturnType<typeof fakePayPal>, mcp = 'mcp-1') {
  const pr = body(await meter.call(mcp, 'quote_lookup', { symbol: 'ACME' }));
  assert.equal(pr.error, 'payment_required');
  pp.approve(pr.order_id);
  const b = body(await meter.balance(mcp));
  assert.equal(b.status, 'active');
  return pr.session_id as string;
}

/** Make a tool slow or count its runs, for the duration of a test. */
function patchTool(name: string, run: (orig: (a: Record<string, unknown>) => Promise<unknown>) => (a: Record<string, unknown>) => Promise<unknown>) {
  const t = toolByName(name)!;
  const orig = t.run;
  t.run = run(orig);
  return () => void (t.run = orig);
}

test('money is integer cents', () => {
  assert.equal(toCents('0.05') + toCents('0.40') + toCents('0.92'), 137);
  assert.equal(fromCents(363), '3.63');
  assert.equal(toCents('5'), 500);
  assert.throws(() => toCents('1.005'));
});

test('session ids carry 128 random bits and fit PayPal fields', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newSessionId()));
  assert.equal(ids.size, 200);
  for (const id of ids) {
    assert.match(id, SESSION_ID);
    assert.equal(id.length, 40);
    assert.ok(`${id}-settle`.length <= 127 && `${id}-authorize`.length <= 108);
  }
});

test('a paid call without a session answers payment_required and creates an AUTHORIZE order for the budget', async () => {
  const { meter, pp } = setup();
  const r = await meter.call('mcp-1', 'deep_report', { topic: 'x' });
  assert.equal(r.isError, true);
  const b = body(r);
  assert.equal(b.error, 'payment_required');
  assert.equal(b.price, '0.40');
  assert.equal(b.budget_proposal, '5.00');
  assert.match(b.session_id, SESSION_ID);
  assert.equal(b.approval_url, `https://www.sandbox.paypal.com/checkoutnow?token=${b.order_id}`);
  const order = pp.orders.get(b.order_id)!.body;
  assert.equal(order.intent, 'AUTHORIZE');
  const pu = order.purchase_units[0];
  assert.deepEqual(pu.amount, { currency_code: 'USD', value: '5.00', breakdown: { item_total: { currency_code: 'USD', value: '5.00' } } });
  assert.equal(pu.items[0].name, 'MeterMCP agent session (metered tool calls)');
  assert.equal(pu.items[0].category, 'DIGITAL_GOODS');
  assert.equal(pu.custom_id, b.session_id);
  assert.deepEqual(order.payment_source.paypal.experience_context, {
    return_url: 'http://127.0.0.1:8790/approved',
    cancel_url: 'http://127.0.0.1:8790/cancelled',
    user_action: 'CONTINUE',
    shipping_preference: 'NO_SHIPPING',
    brand_name: 'MeterMCP',
  });
  // Asking again (concurrently) reuses the same pending order.
  const [x, y] = await Promise.all([meter.call('mcp-1', 'quote_lookup', { symbol: 'A' }), meter.call('mcp-1', 'quote_lookup', { symbol: 'B' })]);
  assert.equal(body(x).order_id, b.order_id);
  assert.equal(body(y).order_id, b.order_id);
  assert.equal(pp.count(/^POST \/v2\/checkout\/orders$/), 1);
  assert.equal(body(await meter.balance('mcp-1')).status, 'pending_approval');
});

test('full lifecycle: approve, four calls (one failed, not charged), close → capture of the OK calls only, remainder released', async () => {
  const { meter, pp, ledger } = setup({ failFirst: ['deep_report'] });
  const id = await openSession(meter, pp);
  assert.equal(pp.count(/authorize$/), 1);

  const r1 = body(await meter.call('mcp-1', 'quote_lookup', { symbol: 'ACME' }));
  assert.equal(r1.metering.status, 'OK');
  assert.equal(r1.metering.remaining, '4.95');
  const r2 = await meter.call('mcp-1', 'deep_report', { topic: 'agents' });
  assert.equal(r2.isError, true);
  assert.equal(body(r2).error, 'upstream_failed');
  assert.equal(body(r2).metering.charged, false);
  assert.equal(body(r2).metering.remaining, '4.95');
  const r3 = body(await meter.call('mcp-1', 'deep_report', { topic: 'agents' }));
  assert.equal(r3.metering.status, 'OK');
  const r4 = body(await meter.call('mcp-1', 'bulk_export', { dataset: 'quotes', rows: 10 }));
  assert.equal(r4.metering.remaining, '3.63');

  const calls = ledger.calls(id);
  assert.deepEqual(calls.map((c) => [c.n, c.tool, c.price_cents, c.status]), [
    [1, 'quote_lookup', 5, 'OK'],
    [2, 'deep_report', 40, 'FAILED'],
    [3, 'deep_report', 40, 'OK'],
    [4, 'bulk_export', 92, 'OK'],
  ]);
  assert.equal(calls[1]!.error, INJECTED_FAILURE);
  assert.equal(calls[1]!.response_hash, null);
  assert.equal(calls[0]!.request_hash, requestHash(id, 1, 'quote_lookup', { symbol: 'ACME' }));

  const closed = body(await meter.closeFor('mcp-1'));
  assert.equal(closed.status, 'settled');
  assert.equal(closed.captured, '1.37');
  assert.equal(closed.released, '3.63');
  const cap = pp.calls.find((c) => /capture$/.test(c.path))!;
  assert.deepEqual(cap.body.amount, { currency_code: 'USD', value: '1.37' });
  assert.equal(cap.body.final_capture, true);
  assert.equal(cap.body.invoice_id, `${id}-settle`);
  assert.equal(cap.headers['PayPal-Request-Id'], `${id}-settle`);
  assert.match(cap.body.note_to_payer, /3 paid tool calls \(quote_lookup 0\.05, deep_report 0\.40, bulk_export 0\.92\)/);
  assert.ok(cap.body.note_to_payer.length <= 255);
  const s = ledger.session(id)!;
  assert.equal(s.authorization_status, 'CAPTURED');
  assert.equal(meter.sessionsByCapture(s.capture_id!)[0]!.id, id);

  // Settled: no more paid calls on it; the next paid call asks for a new budget.
  assert.equal(body(await meter.call('mcp-1', 'quote_lookup', { symbol: 'X' })).error, 'payment_required');
  assert.notEqual(body(await meter.balance('mcp-1')).session_id, id);

  const rc = meter.receipt(id)!;
  assert.equal(rc.mandate.order_id, s.order_id);
  assert.equal(rc.mandate.authorization_id, s.authorization_id);
  assert.equal(rc.mandate.cap, '5.00');
  assert.ok(rc.mandate.approved_at);
  assert.deepEqual(rc.calls.map((c) => [c.tool, c.price, c.status]), [
    ['quote_lookup', '0.05', 'OK'],
    ['deep_report', '0.40', 'FAILED'],
    ['deep_report', '0.40', 'OK'],
    ['bulk_export', '0.92', 'OK'],
  ]);
  assert.deepEqual(rc.totals, { calls: 4, ok: 3, failed: 1, pending: 0, charged: '1.37', cap: '5.00' });
  assert.deepEqual(
    { status: rc.settlement.status, capture_id: rc.settlement.capture_id, captured: rc.settlement.captured, released: rc.settlement.released, remainder_released: rc.settlement.remainder_released },
    { status: 'captured', capture_id: s.capture_id, captured: '1.37', released: '3.63', remainder_released: true },
  );
  assert.match(rc.receipt_sha256, /^[0-9a-f]{64}$/);
  const lines = receiptLines(rc).join('\n');
  for (const want of [s.order_id!, s.authorization_id!, s.capture_id!, 'FAILED (not charged)', 'Remainder released: 3.63 USD', calls[0]!.request_hash]) assert.ok(lines.includes(want), want);
  const pdf = Buffer.from(receiptPdf(rc)).toString('latin1');
  assert.ok(pdf.startsWith('%PDF-1.4') && pdf.trimEnd().endsWith('%%EOF'));
  assert.ok(pdf.includes(s.capture_id!));
});

test('a call over the remaining budget is refused before the tool runs, with remaining, price and a top-up hint', async () => {
  const { meter, pp, ledger } = setup({ budget: '1.00' });
  const id = await openSession(meter, pp);
  let runs = 0;
  const restore = patchTool('deep_report', (orig) => (a) => ((runs += 1), orig(a)));
  try {
    assert.equal(body(await meter.call('mcp-1', 'bulk_export', { dataset: 'd' })).metering.remaining, '0.08');
    const r = await meter.call('mcp-1', 'deep_report', { topic: 't' });
    assert.equal(r.isError, true);
    const b = body(r);
    assert.equal(b.error, 'budget_exceeded');
    assert.equal(b.remaining, '0.08');
    assert.equal(b.price, '0.40');
    assert.match(b.top_up, /close_session/);
    assert.equal(runs, 0);
    assert.equal(ledger.calls(id).length, 1);
    assert.equal(body(await meter.call('mcp-1', 'quote_lookup', { symbol: 'Q' })).metering.remaining, '0.03');
  } finally {
    restore();
  }
});

test('two concurrent calls cannot both take the last of the budget', async () => {
  const { meter, pp, ledger } = setup({ budget: '1.00' });
  const id = await openSession(meter, pp);
  let running = 0;
  let maxRunning = 0;
  const restore = patchTool('bulk_export', (orig) => async (a) => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, 20));
    running -= 1;
    return orig(a);
  });
  try {
    const rs = await Promise.all([1, 2, 3].map((i) => meter.call('mcp-1', 'bulk_export', { dataset: `d${i}` })));
    const ok = rs.filter((r) => !r.isError);
    const refused = rs.filter((r) => r.isError).map(body);
    assert.equal(ok.length, 1);
    assert.equal(maxRunning, 1);
    assert.deepEqual(refused.map((b) => b.error), ['budget_exceeded', 'budget_exceeded']);
    assert.equal(ledger.chargedCents(id), 92);
    assert.equal(ledger.calls(id).length, 1);
  } finally {
    restore();
  }
});

test('a failing tool releases its reservation: a failed call is never charged, even on the last of the budget', async () => {
  const { meter, pp, ledger } = setup({ budget: '0.40', failFirst: ['deep_report'] });
  const id = await openSession(meter, pp);
  assert.equal(body(await meter.call('mcp-1', 'deep_report', { topic: 'a' })).error, 'upstream_failed');
  assert.equal(ledger.usedCents(id), 0);
  assert.equal(body(await meter.call('mcp-1', 'deep_report', { topic: 'a' })).metering.status, 'OK');
  assert.equal(ledger.chargedCents(id), 40);
  const restore = patchTool('quote_lookup', () => async () => {
    throw new Error('boom');
  });
  try {
    // Over budget is refused before running; a thrown tool error is released.
    assert.equal(body(await meter.call('mcp-1', 'quote_lookup', { symbol: 'Z' })).error, 'budget_exceeded');
  } finally {
    restore();
  }
});

test('closing with nothing consumed voids the authorization (no capture)', async () => {
  const { meter, pp, ledger } = setup({ failFirst: ['deep_report'] });
  const id = await openSession(meter, pp);
  await meter.call('mcp-1', 'deep_report', { topic: 'x' }); // fails, not charged
  const r = body(await meter.closeFor('mcp-1'));
  assert.equal(r.status, 'voided');
  assert.equal(r.released, '5.00');
  assert.equal(pp.count(/capture$/), 0);
  assert.equal(pp.count(/void$/), 1);
  assert.equal(ledger.session(id)!.authorization_status, 'VOIDED');
  assert.equal(meter.receipt(id)!.settlement.status, 'voided');
});

test('a failed capture leaves the session settlement_failed (never charged); closing again retries and captures once', async () => {
  const { meter, pp, ledger } = setup();
  const id = await openSession(meter, pp);
  await meter.call('mcp-1', 'quote_lookup', { symbol: 'A' });
  pp.failNext(/capture$/, 503, { name: 'SERVICE_UNAVAILABLE' });
  const first = await meter.closeFor('mcp-1');
  assert.equal(first.isError, true);
  assert.equal(body(first).status, 'settlement_failed');
  assert.match(body(first).settlement_error, /503/);
  let s = ledger.session(id)!;
  assert.equal(s.capture_id, null);
  assert.equal(meter.receipt(id)!.settlement.status, 'failed');
  // No more paid calls while unsettled.
  assert.equal(body(await meter.call('mcp-1', 'quote_lookup', { symbol: 'B' })).error, 'session_closed');
  const retry = await meter.close(id);
  assert.equal(retry.status, 'settled');
  assert.equal(retry.captured, '0.05');
  s = ledger.session(id)!;
  assert.equal(s.settlement_attempts, 2);
  assert.equal([...pp.auths.values()][0]!.captures.length, 1);
  // Closing a settled session again changes nothing.
  assert.equal((await meter.close(id)).status, 'settled');
  assert.equal(pp.count(/capture$/), 2);
});

test('a session cannot close while a call is in flight', async () => {
  const { meter, pp } = setup();
  const id = await openSession(meter, pp);
  let release!: () => void;
  const restore = patchTool('deep_report', (orig) => async (a) => {
    await new Promise<void>((r) => (release = r));
    return orig(a);
  });
  try {
    const running = meter.call('mcp-1', 'deep_report', { topic: 't' });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await meter.close(id)).status, 'busy');
    release();
    await running;
    assert.equal((await meter.close(id)).status, 'settled');
  } finally {
    restore();
  }
});

test('another MCP session can neither use, read nor close someone else’s session', async () => {
  const { meter, pp, ledger } = setup();
  const id = await openSession(meter, pp, 'mcp-owner');
  await meter.call('mcp-owner', 'quote_lookup', { symbol: 'A' });
  assert.equal(body(await meter.balance('mcp-other')).status, 'none');
  assert.equal(body(await meter.closeFor('mcp-other')).error, 'no_session');
  assert.equal(body(meter.receiptFor('mcp-other')).error, 'no_session');
  assert.equal(body(await meter.call('mcp-other', 'quote_lookup', { symbol: 'A' })).error, 'payment_required');
  assert.equal(ledger.session(id)!.status, 'active');
  assert.equal(body(meter.receiptFor('mcp-owner')).session.id, id);
});

test('idle sessions are closed and settled', async () => {
  let now = new Date('2026-10-09T10:00:00Z');
  const { meter, pp, ledger } = setup({ now: () => now });
  const id = await openSession(meter, pp);
  await meter.call('mcp-1', 'quote_lookup', { symbol: 'A' });
  now = new Date('2026-10-09T10:10:00Z');
  assert.deepEqual(await meter.sweepIdle(15 * 60_000), []);
  now = new Date('2026-10-09T10:16:00Z');
  assert.deepEqual(await meter.sweepIdle(15 * 60_000), [id]);
  assert.equal(ledger.session(id)!.status, 'settled');
});

test('an approval PayPal has not seen yet keeps the session pending; the buyer cancelling leaves nothing held', async () => {
  const { meter, pp } = setup();
  const pr = body(await meter.call('mcp-1', 'quote_lookup', { symbol: 'A' }));
  assert.equal((await meter.approvedByOrder(pr.order_id))!.status, 'pending_approval');
  assert.equal(pp.count(/authorize$/), 0);
  assert.equal((await meter.close(pr.session_id)).status, 'cancelled');
  assert.equal(pp.count(/void$|capture$/), 0);
});

test('a funding source PayPal declines at authorization ends the session with the reason; the next call asks for a new approval', async () => {
  const { meter, pp, ledger } = setup();
  const pr = body(await meter.call('mcp-1', 'quote_lookup', { symbol: 'A' }));
  pp.approve(pr.order_id);
  pp.failNext(/authorize$/, 422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }] });
  const declined = body(await meter.call('mcp-1', 'quote_lookup', { symbol: 'A' }));
  assert.equal(declined.error, 'payment_declined');
  assert.equal(declined.session_id, pr.session_id);
  assert.match(declined.message, /another funding source/);
  assert.equal(ledger.session(pr.session_id)!.status, 'cancelled');
  assert.match(ledger.session(pr.session_id)!.settlement_error!, /INSTRUMENT_DECLINED/);
  // Polling never re-sends the declined authorization.
  const b = body(await meter.balance('mcp-1'));
  assert.equal(b.status, 'declined');
  assert.equal(pp.count(/authorize$/), 1);
  // The next paid call starts a new budget: a new order with its own approval link.
  const again = body(await meter.call('mcp-1', 'quote_lookup', { symbol: 'A' }));
  assert.equal(again.error, 'payment_required');
  assert.notEqual(again.order_id, pr.order_id);
  assert.notEqual(again.session_id, pr.session_id);
});

test('an authorization error that is not a decline keeps the session pending; the next poll retries it', async () => {
  const { meter, pp, ledger } = setup();
  const pr = body(await meter.call('mcp-1', 'quote_lookup', { symbol: 'A' }));
  pp.approve(pr.order_id);
  pp.failNext(/authorize$/, 500);
  assert.equal(body(await meter.balance('mcp-1')).status, 'pending_approval');
  assert.equal(ledger.session(pr.session_id)!.status, 'pending_approval');
  assert.equal(body(await meter.balance('mcp-1')).status, 'active');
});

test('request hashes are stable: canonical JSON ignores key order', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: 'x' } }), '{"a":{"c":"x","d":[1,{"x":1,"y":2}]},"b":1}');
  assert.equal(requestHash('s', 1, 't', { a: 1, b: 2 }), requestHash('s', 1, 't', { b: 2, a: 1 }));
  assert.notEqual(requestHash('s', 1, 't', { a: 1 }), requestHash('s', 2, 't', { a: 1 }));
  assert.equal(requestHash('mm-sess-x', 1, 'quote_lookup', { symbol: 'ACME' }), requestHash('mm-sess-x', 1, 'quote_lookup', { symbol: 'ACME' }));
});

// ------------------------------------------------------------------------------------------------ H3: PENDING captures

test('H3: a capture PayPal answers PENDING is capture_pending, not settled: ledger and receipt say pending, nothing released', async () => {
  const { meter, pp, ledger } = setup();
  const id = await openSession(meter, pp);
  await meter.call('mcp-1', 'quote_lookup', { symbol: 'A' });
  pp.captureAnswers('PENDING');
  const closed = body(await meter.closeFor('mcp-1'));
  assert.equal(closed.status, 'capture_pending');
  assert.equal(closed.captured, undefined);
  assert.equal(closed.released, undefined);
  assert.match(closed.message, /PENDING/);
  const s = ledger.session(id)!;
  assert.equal(s.status, 'capture_pending');
  assert.equal(s.settled_at, null);
  const r = meter.receipt(id)!;
  assert.equal(r.settlement.status, 'capture_pending');
  assert.equal(r.settlement.capture_status, 'PENDING');
  assert.equal(r.settlement.captured, null);
  assert.equal(r.settlement.remainder_released, false);
  const text = receiptLines(r).join('\n');
  assert.ok(!/Captured \d|Remainder released|Settled at/.test(text), text);
  assert.match(text, /PENDING at PayPal|not a final charge/);
  // No more paid calls on it.
  assert.equal(body(await meter.call('mcp-1', 'quote_lookup', { symbol: 'B' })).error, 'session_closed');
});

test('H3: reconciliation moves a pending capture to settled exactly once when PayPal reports COMPLETED (scheduled, on demand, on close)', async () => {
  const { meter, pp, ledger } = setup();
  const id = await openSession(meter, pp);
  await meter.call('mcp-1', 'quote_lookup', { symbol: 'A' });
  pp.captureAnswers('PENDING');
  await meter.closeFor('mcp-1');
  const captureId = ledger.session(id)!.capture_id!;
  // Still pending at PayPal: nothing changes.
  assert.deepEqual(await meter.reconcilePending(), [id]);
  assert.equal(ledger.session(id)!.status, 'capture_pending');
  pp.setCapture(captureId, 'COMPLETED');
  // Concurrent reconciliations (schedule + a close retry + on demand) settle it once.
  const [a, b, c] = await Promise.all([meter.reconcile(id), meter.close(id), meter.reconcilePending()]);
  assert.equal(a!.status, 'settled');
  assert.equal(b.status, 'settled');
  assert.ok(Array.isArray(c));
  const r = meter.receipt(id)!;
  assert.equal(r.settlement.status, 'captured');
  assert.equal(r.settlement.captured, '0.05');
  assert.equal(r.settlement.remainder_released, true);
  assert.ok(r.settlement.settled_at);
  // Once settled, nothing more: no new capture, no further transition.
  assert.equal((await meter.reconcile(id))!.status, 'settled');
  assert.equal(pp.count(/capture$/), 1);
  assert.equal([...pp.auths.values()][0]!.captures.length, 1);
});

test('H3: a pending capture PayPal later declines keeps the attempt on record and claims no charge', async () => {
  const { meter, pp, ledger } = setup();
  const id = await openSession(meter, pp);
  await meter.call('mcp-1', 'quote_lookup', { symbol: 'A' });
  pp.captureAnswers('PENDING');
  await meter.closeFor('mcp-1');
  const captureId = ledger.session(id)!.capture_id!;
  pp.setCapture(captureId, 'DECLINED');
  assert.equal((await meter.reconcile(id))!.status, 'capture_declined');
  const r = meter.receipt(id)!;
  assert.equal(r.settlement.status, 'capture_declined');
  assert.equal(r.settlement.capture_id, captureId);
  assert.equal(r.settlement.capture_status, 'DECLINED');
  assert.equal(r.settlement.captured, null);
  assert.equal(r.settlement.remainder_released, false);
  assert.match(r.settlement.error!, /DECLINED/);
  assert.ok(!/Captured \d/.test(receiptLines(r).join('\n')));
  // Terminal: a close does not capture again.
  assert.equal((await meter.close(id)).status, 'capture_declined');
  assert.equal(pp.count(/capture$/), 1);
});

test('APIMatic review: an authorization PayPal already VOIDED with nothing consumed is recorded as voided, not failed forever', async () => {
  const { meter, pp, ledger } = setup();
  const id = await openSession(meter, pp);
  // The void happened at PayPal but its answer was lost: PayPal now reports the authorization VOIDED.
  pp.auths.get(ledger.session(id)!.authorization_id!)!.status = 'VOIDED';
  const r = await meter.close(id);
  assert.equal(r.status, 'voided');
  assert.equal(pp.count(/void$/), 0);
  assert.equal(ledger.session(id)!.captured_cents, 0);
});

test('APIMatic review: VOIDED while calls were consumed is still a failure (nothing can be captured)', async () => {
  const { meter, pp, ledger } = setup();
  const id = await openSession(meter, pp);
  assert.equal(body(await meter.call('mcp-1', 'quote_lookup', { symbol: 'ACME' })).metering.status, 'OK');
  pp.auths.get(ledger.session(id)!.authorization_id!)!.status = 'VOIDED';
  assert.equal((await meter.close(id)).status, 'settlement_failed');
});

test('APIMatic review: an authorization PayPal DENIES ends the session with the reason; the next call asks for a new approval', async () => {
  const { meter, pp, ledger } = setup();
  const pr = body(await meter.call('mcp-1', 'quote_lookup', { symbol: 'A' }));
  pp.approve(pr.order_id);
  pp.authAnswers('DENIED', 'DECLINED_BY_RISK_FRAUD_FILTERS');
  const b = body(await meter.balance('mcp-1'));
  assert.equal(b.status, 'declined');
  assert.match(ledger.session(pr.session_id)!.settlement_error!, /denied the authorization \(DECLINED_BY_RISK_FRAUD_FILTERS\)/);
  pp.authAnswers('CREATED');
  const again = body(await meter.call('mcp-1', 'quote_lookup', { symbol: 'A' }));
  assert.equal(again.error, 'payment_required');
  assert.notEqual(again.session_id, pr.session_id);
});

test('APIMatic review: a PENDING authorization (PayPal review) keeps the session waiting, without failing it', async () => {
  const { meter, pp, ledger, logs } = setupWithLog();
  const pr = body(await meter.call('mcp-1', 'quote_lookup', { symbol: 'A' }));
  pp.approve(pr.order_id);
  pp.authAnswers('PENDING', 'PENDING_REVIEW');
  assert.equal(body(await meter.balance('mcp-1')).status, 'pending_approval');
  assert.equal(ledger.session(pr.session_id)!.status, 'pending_approval');
  assert.ok(logs.some((l) => /PENDING at PayPal \(PENDING_REVIEW\); waiting/.test(l)), logs.join('\n'));
});

test('APIMatic review: a capture PayPal answers DECLINED at once is capture_declined on record, not a retry loop', async () => {
  const { meter, pp, ledger } = setup();
  const id = await openSession(meter, pp);
  body(await meter.call('mcp-1', 'quote_lookup', { symbol: 'ACME' }));
  pp.captureAnswers('DECLINED');
  const r = await meter.close(id);
  assert.equal(r.status, 'capture_declined');
  const s = ledger.session(id)!;
  assert.ok(s.capture_id);
  assert.match(s.settlement_error!, /answered the capture DECLINED/);
  assert.equal((await meter.close(id)).status, 'capture_declined');
  assert.equal(pp.count(/capture$/), 1);
});

function setupWithLog() {
  const pp = fakePayPal();
  const ledger = new Ledger(':memory:');
  const logs: string[] = [];
  const meter = new Meter({ ledger, paypal: pp.client, env: 'sandbox', publicUrl: 'http://127.0.0.1:8790', log: (l) => logs.push(l) });
  return { pp, ledger, meter, logs };
}

test('each paid tool result is labelled synthetic and lists its limits; deep_report has no confidence score', async () => {
  const run = async (name: string, args: Record<string, unknown>) => (await toolByName(name)!.run(args)) as Record<string, unknown>;
  const quote = await run('quote_lookup', { symbol: 'ACME' });
  const report = await run('deep_report', { topic: 'rate limits' });
  const bulk = await run('bulk_export', { dataset: 'quotes-2026-10' });
  for (const r of [quote, report, bulk]) assert.equal(r.synthetic, true);
  assert.deepEqual(quote.limits, ['Current quote only: no price history.', 'No risk or supplier information.']);
  assert.deepEqual(report.limits, ['Qualitative findings only: no row-level figures.', 'For the underlying data, use bulk_export.']);
  assert.deepEqual(bulk.limits, ['Raw rows only: no interpretation or recommendation.', 'Preview shows at most 3 rows; the checksum covers all rows.']);
  assert.ok(!('confidence' in report));
  assert.doesNotMatch(String(report.summary), /confidence/i);
  assert.equal((report.findings as string[]).length, 3);
  assert.deepEqual((await run('deep_report', { topic: 'rate limits' })).findings, report.findings);
});

// ------------------------------------------------------------------------------------------------ open_budget

const ORDERS = /^POST \/v2\/checkout\/orders$/;

/** open_budget → the buyer approves → the session is active. */
async function openBudget(meter: Meter, pp: ReturnType<typeof fakePayPal>, req: Parameters<Meter['openBudget']>[1], mcp = 'mcp-1') {
  const r = await meter.openBudget(mcp, req, {});
  assert.equal(r.isError, undefined, r.content[0]!.text);
  const b = body(r);
  pp.approve(b.order_id);
  assert.equal(body(await meter.balance(mcp)).status, 'active');
  return b.session_id as string;
}

test('open_budget with cap 2.50 creates an AUTHORIZE order for exactly 2.50 USD and the session cap is 250 cents', async () => {
  const { meter, pp, ledger } = setup();
  const r = await meter.openBudget('mcp-1', { cap: '2.50' }, {});
  assert.equal(r.isError, undefined);
  const b = body(r);
  assert.match(b.session_id, SESSION_ID);
  assert.deepEqual({ ...b, session_id: 'x', order_id: 'y', approval_url: 'z' }, { session_id: 'x', order_id: 'y', approval_url: 'z', cap: '2.50', currency: 'USD', fail_first: [], status: 'pending_approval' });
  assert.equal(b.approval_url, `https://www.sandbox.paypal.com/checkoutnow?token=${b.order_id}`);
  const order = pp.orders.get(b.order_id)!.body;
  assert.equal(order.intent, 'AUTHORIZE');
  assert.deepEqual(order.purchase_units[0].amount, { currency_code: 'USD', value: '2.50', breakdown: { item_total: { currency_code: 'USD', value: '2.50' } } });
  assert.equal(order.payment_source.paypal.experience_context.return_url, 'http://127.0.0.1:8790/approved');
  assert.equal(ledger.session(b.session_id)!.cap_cents, 250);
  // Approved: the authorization for 2.50 opens the session with that cap.
  pp.approve(b.order_id);
  const bal = body(await meter.balance('mcp-1'));
  assert.equal(bal.status, 'active');
  assert.equal(bal.cap, '2.50');
});

test('open_budget refuses caps outside 0.50–5.00 and malformed caps without creating an order', async () => {
  const { meter, pp, ledger } = setup();
  for (const cap of ['0.49', '5.01', 'abc', '1.234', '', '100', '-1', '2.']) {
    const r = await meter.openBudget('mcp-1', { cap }, {});
    assert.equal(r.isError, true, cap);
    const b = body(r);
    assert.equal(b.error, 'invalid_cap', cap);
    assert.match(b.message, /0\.50/);
    assert.match(b.message, /5\.00/);
  }
  assert.equal(pp.count(ORDERS), 0);
  assert.equal(ledger.latestSessionFor('mcp-1'), null);
  // The bounds themselves are accepted.
  assert.equal(body(await meter.openBudget('mcp-1', { cap: '0.50' }, {})).cap, '0.50');
  assert.equal(body(await meter.openBudget('mcp-2', { cap: '5' }, {})).cap, '5.00');
});

test('open_budget refuses a second budget for the same MCP session', async () => {
  const { meter, pp } = setup();
  const first = body(await meter.openBudget('mcp-1', { cap: '1.00' }, {}));
  const again = await meter.openBudget('mcp-1', { cap: '2.00' }, {});
  assert.equal(again.isError, true);
  assert.equal(body(again).error, 'budget_exists');
  assert.equal(body(again).session_id, first.session_id);
  // Once active, too; and over a session opened by payment_required.
  pp.approve(first.order_id);
  assert.equal(body(await meter.balance('mcp-1')).status, 'active');
  assert.equal(body(await meter.openBudget('mcp-1', { cap: '1.00' }, {})).error, 'budget_exists');
  await meter.call('mcp-2', 'quote_lookup', { symbol: 'A' });
  assert.equal(body(await meter.openBudget('mcp-2', { cap: '1.00' }, {})).error, 'budget_exists');
  assert.equal(pp.count(ORDERS), 2);
  // Also while the first order is still being created: one order per MCP session.
  const { meter: m2, pp: pp2 } = setup();
  const [a, b] = await Promise.all([m2.openBudget('mcp-1', { cap: '1.00' }, {}), m2.openBudget('mcp-1', { cap: '1.00' }, {})]);
  assert.deepEqual([a.isError, body(b).error], [undefined, 'budget_exists']);
  const [c, d] = await Promise.all([m2.call('mcp-3', 'quote_lookup', { symbol: 'A' }), m2.openBudget('mcp-3', { cap: '1.00' }, {})]);
  assert.deepEqual([body(c).error, body(d).error], ['payment_required', 'budget_exists']);
  assert.equal(pp2.count(ORDERS), 2);
});

test('open_budget validates fail_first: paid tool names only, at most 3, duplicates removed', async () => {
  const { meter, pp, ledger } = setup();
  const unknown = await meter.openBudget('mcp-1', { cap: '1.00', failFirst: ['deep_report', 'close_session'] }, {});
  assert.equal(unknown.isError, true);
  assert.equal(body(unknown).error, 'unknown_tool');
  assert.equal(body(unknown).tool, 'close_session');
  const tooMany = await meter.openBudget('mcp-1', { cap: '1.00', failFirst: ['deep_report', 'quote_lookup', 'bulk_export', 'quote_lookup', 'deep_report', 'x'] }, {});
  assert.equal(tooMany.isError, true);
  assert.equal(pp.count(ORDERS), 0);
  const ok = body(await meter.openBudget('mcp-1', { cap: '1.00', failFirst: ['deep_report', 'deep_report', 'quote_lookup'] }, {}));
  assert.deepEqual(ok.fail_first, ['deep_report', 'quote_lookup']);
  assert.equal(ledger.session(ok.session_id)!.fail_first, '["deep_report","quote_lookup"]');
});

test("a session opened with fail_first ['deep_report'] fails the first deep_report with RUN_INJECTED_FAILURE, not charged; the second succeeds", async () => {
  const { meter, pp, ledger } = setup();
  const id = await openBudget(meter, pp, { cap: '1.00', failFirst: ['deep_report'] });
  const r1 = await meter.call('mcp-1', 'deep_report', { topic: 'x' });
  assert.equal(r1.isError, true);
  assert.equal(body(r1).error, 'upstream_failed');
  assert.equal(body(r1).metering.charged, false);
  assert.equal(body(r1).metering.remaining, '1.00');
  assert.ok(body(r1).message.includes(RUN_INJECTED_FAILURE));
  assert.equal(body(await meter.call('mcp-1', 'deep_report', { topic: 'x' })).metering.status, 'OK');
  assert.deepEqual(ledger.calls(id).map((c) => [c.tool, c.status, c.error]), [['deep_report', 'FAILED', RUN_INJECTED_FAILURE], ['deep_report', 'OK', null]]);
  assert.equal(ledger.chargedCents(id), 40);
  assert.equal(meter.receipt(id)!.calls[0]!.error, RUN_INJECTED_FAILURE);
});

test('a session opened with fail_first [] never injects, even when the server switch names the tool', async () => {
  const { meter, pp, ledger } = setup({ failFirst: ['deep_report'] });
  const id = await openBudget(meter, pp, { cap: '1.00', failFirst: [] });
  assert.equal(body(await meter.call('mcp-1', 'deep_report', { topic: 'x' })).metering.status, 'OK');
  assert.equal(ledger.session(id)!.fail_first, '[]');
  // An omitted fail_first is the same as [].
  const id2 = await openBudget(meter, pp, { cap: '1.00' }, 'mcp-2');
  assert.equal(body(await meter.call('mcp-2', 'deep_report', { topic: 'x' })).metering.status, 'OK');
  assert.equal(ledger.session(id2)!.fail_first, '[]');
});

test('a session opened through payment_required keeps the server switch and its existing message INJECTED_FAILURE', async () => {
  assert.equal(INJECTED_FAILURE, 'UPSTREAM_UNAVAILABLE (injected by the METERMCP_FAIL_FIRST test switch)');
  assert.equal(RUN_INJECTED_FAILURE, "UPSTREAM_UNAVAILABLE (injected for this run at the person's request)");
  const { meter, pp, ledger } = setup({ failFirst: ['deep_report'] });
  const id = await openSession(meter, pp);
  assert.equal(ledger.session(id)!.fail_first, null);
  assert.equal(ledger.session(id)!.return_to, null);
  assert.equal(body(await meter.call('mcp-1', 'deep_report', { topic: 'x' })).error, 'upstream_failed');
  assert.equal(ledger.calls(id)[0]!.error, INJECTED_FAILURE);
});

test('the budget gate is asked once per open_budget and released when PayPal fails', async () => {
  const { meter, pp } = setup();
  let asked = 0;
  let released = 0;
  const gate: BudgetGate = () => ((asked += 1), { ok: true, release: () => void (released += 1) });
  // Refused before the gate (invalid cap): not asked.
  await meter.openBudget('mcp-1', { cap: '9.00' }, { budgetGate: gate });
  assert.equal(asked, 0);
  pp.failNext(ORDERS, 503);
  const failed = await meter.openBudget('mcp-1', { cap: '1.00' }, { budgetGate: gate });
  assert.equal(body(failed).error, 'paypal_unavailable');
  assert.deepEqual([asked, released], [1, 1]);
  const ok = await meter.openBudget('mcp-1', { cap: '1.00' }, { budgetGate: gate });
  assert.equal(ok.isError, undefined);
  assert.deepEqual([asked, released], [2, 1]);
  // budget_exists does not ask the gate either.
  await meter.openBudget('mcp-1', { cap: '1.00' }, { budgetGate: gate });
  assert.equal(asked, 2);
  // A refusing gate answers with its own refusal and no order is created.
  const refuse: BudgetGate = () => ({ ok: false, answer: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'demo_code_required' }) }] } });
  assert.equal(body(await meter.openBudget('mcp-9', { cap: '1.00' }, { budgetGate: refuse })).error, 'demo_code_required');
  assert.equal(pp.count(ORDERS), 2);
});

test('return_to on the allowlist is kept; any other origin is ignored (stored null)', async () => {
  const { meter, ledger } = setup({ returnOrigins: ['https://resolvekit.example'] });
  const evil = body(await meter.openBudget('mcp-1', { cap: '1.00', returnTo: 'https://evil.example/agent' }, {}));
  assert.equal(evil.error, undefined);
  assert.equal(ledger.session(evil.session_id)!.return_to, null);
  const kept = body(await meter.openBudget('mcp-2', { cap: '1.00', returnTo: 'https://resolvekit.example/agent?run=run-1' }, {}));
  assert.equal(ledger.session(kept.session_id)!.return_to, 'https://resolvekit.example/agent?run=run-1');
  for (const [i, returnTo] of ['not a url', '/agent', 'http://resolvekit.example/agent', 'https://resolvekit.example:8443/agent', 'https://resolvekit.example.evil.example/x', 'javascript:alert(1)'].entries()) {
    const r = body(await meter.openBudget(`mcp-x${i}`, { cap: '1.00', returnTo }, {}));
    assert.equal(ledger.session(r.session_id)!.return_to, null, returnTo);
  }
  // No allowlist: nothing is kept.
  const { meter: m2, ledger: l2 } = setup();
  const r = body(await m2.openBudget('mcp-1', { cap: '1.00', returnTo: 'https://resolvekit.example/agent' }, {}));
  assert.equal(l2.session(r.session_id)!.return_to, null);
});

// ------------------------------------------------------------------------------------------------ Ledger migration

/** The ledger as it was before fail_first / return_to, with a settled session (two calls) and a pending one. */
const OLD_SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, mcp_session TEXT, status TEXT NOT NULL, currency TEXT NOT NULL, cap_cents INTEGER NOT NULL CHECK (cap_cents > 0),
  order_id TEXT UNIQUE, approval_url TEXT, authorization_id TEXT, authorization_status TEXT, authorization_expires_at TEXT, approved_at TEXT,
  authorized_at TEXT, created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL, closed_at TEXT, capture_id TEXT, capture_status TEXT,
  captured_cents INTEGER, settled_at TEXT, settlement_error TEXT, settlement_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sessions_mcp ON sessions (mcp_session);
CREATE INDEX sessions_capture ON sessions (capture_id);
CREATE TABLE calls (
  session_id TEXT NOT NULL REFERENCES sessions (id), n INTEGER NOT NULL, time TEXT NOT NULL, tool TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0), status TEXT NOT NULL CHECK (status IN ('PENDING', 'OK', 'FAILED')),
  request_hash TEXT NOT NULL, response_hash TEXT, error TEXT, finished_at TEXT, PRIMARY KEY (session_id, n)
);
INSERT INTO sessions VALUES ('mm-sess-old', 'mcp-old', 'settled', 'USD', 500, 'ORD0001', 'https://x/approve', 'AUTH0001', 'CAPTURED',
  '2026-11-06T18:09:13Z', '2026-10-08T18:00:00Z', '2026-10-08T18:00:01Z', '2026-10-08T17:59:00Z', '2026-10-08T18:10:00Z',
  '2026-10-08T18:10:00Z', 'CAP0001', 'COMPLETED', 137, '2026-10-08T18:10:02Z', NULL, 1);
INSERT INTO sessions (id, mcp_session, status, currency, cap_cents, created_at, last_activity_at)
  VALUES ('mm-sess-new', 'mcp-2', 'pending_approval', 'USD', 250, '2026-10-09T10:00:00Z', '2026-10-09T10:00:00Z');
INSERT INTO calls VALUES ('mm-sess-old', 1, '2026-10-08T18:01:00Z', 'quote_lookup', 5, 'OK', 'h1', 'r1', NULL, '2026-10-08T18:01:01Z');
INSERT INTO calls VALUES ('mm-sess-old', 2, '2026-10-08T18:02:00Z', 'deep_report', 40, 'FAILED', 'h2', NULL, '${INJECTED_FAILURE}', '2026-10-08T18:02:01Z');
`;

function oldDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'metermcp-ledger-'));
  const file = join(dir, 'metermcp.sqlite');
  const db = new DatabaseSync(file);
  db.exec(OLD_SCHEMA);
  db.close();
  return { dir, file };
}

/** Columns and every row, read with a raw connection. */
function snapshot(file: string) {
  const db = new DatabaseSync(file);
  try {
    const columns = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((c) => c.name);
    const sessions = db.prepare('SELECT * FROM sessions ORDER BY id').all().map((r) => ({ ...r }));
    const calls = db.prepare('SELECT * FROM calls ORDER BY session_id, n').all().map((r) => ({ ...r }));
    return { columns, sessions, calls };
  } finally {
    db.close();
  }
}

const withoutNewColumns = (rows: Array<Record<string, unknown>>) => rows.map(({ fail_first: _f, return_to: _r, ...rest }) => rest);

test('ledger: an existing database without fail_first/return_to gains both columns, and old rows read as null', () => {
  const { dir, file } = oldDatabase();
  try {
    const before = snapshot(file);
    assert.ok(!before.columns.includes('fail_first'));
    const ledger = new Ledger(file);
    const s = ledger.session('mm-sess-old')!;
    assert.equal(s.fail_first, null);
    assert.equal(s.return_to, null);
    assert.equal(s.captured_cents, 137);
    assert.equal(ledger.calls('mm-sess-old').length, 2);
    // The migrated ledger takes new sessions with both fields.
    ledger.createSession({ id: 'mm-sess-3', mcpSession: 'mcp-3', currency: 'USD', capCents: 100, now: '2026-10-18T00:00:00Z', failFirst: ['deep_report'], returnTo: 'https://resolvekit.example/agent' });
    assert.equal(ledger.session('mm-sess-3')!.fail_first, '["deep_report"]');
    assert.equal(ledger.session('mm-sess-3')!.return_to, 'https://resolvekit.example/agent');
    ledger.close();
    const after = snapshot(file);
    assert.deepEqual(after.columns, [...before.columns, 'fail_first', 'return_to']);
    // Every old row keeps every value.
    assert.deepEqual(withoutNewColumns(after.sessions.filter((r) => r.id !== 'mm-sess-3')), before.sessions);
    assert.deepEqual(after.calls, before.calls);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger: a migration forced to fail leaves the schema and rows unchanged and throws LedgerMigrationError', () => {
  const { dir, file } = oldDatabase();
  try {
    const before = snapshot(file);
    const logs: string[] = [];
    // The first ALTER runs, the second fails: the first is rolled back with it.
    const migrationStep = (sql: string) => {
      if (sql.includes('return_to')) throw new Error('injected exec failure');
    };
    assert.throws(
      () => new Ledger(file, { log: (l) => logs.push(l), migrationStep }),
      (e: unknown) => e instanceof LedgerMigrationError && /injected exec failure/.test(e.message),
    );
    assert.ok(logs.some((l) => /migration failed/.test(l) && /rolled back/.test(l)), logs.join('\n'));
    assert.deepEqual(snapshot(file), before);
    // Nothing half-done is left behind: a later healthy start migrates normally.
    new Ledger(file).close();
    assert.deepEqual(snapshot(file).columns, [...before.columns, 'fail_first', 'return_to']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger: reopening an already-migrated database is a no-op', () => {
  const { dir, file } = oldDatabase();
  try {
    new Ledger(file).close();
    const migrated = snapshot(file);
    const steps: string[] = [];
    new Ledger(file, { migrationStep: (sql) => void steps.push(sql) }).close();
    assert.deepEqual(steps, []);
    assert.deepEqual(snapshot(file), migrated);
    // A fresh database is created with both columns and needs no migration step either.
    const fresh = join(dir, 'fresh.sqlite');
    const freshSteps: string[] = [];
    new Ledger(fresh, { migrationStep: (sql) => void freshSteps.push(sql) }).close();
    assert.deepEqual(freshSteps, []);
    assert.ok(snapshot(fresh).columns.includes('fail_first'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
