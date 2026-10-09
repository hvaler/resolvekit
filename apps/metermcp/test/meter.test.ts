import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, requestHash } from '../src/hash.ts';
import { Ledger } from '../src/ledger.ts';
import { INJECTED_FAILURE, Meter, newSessionId, SESSION_ID, type ToolAnswer } from '../src/meter.ts';
import { fromCents, toCents } from '../src/money.ts';
import { receiptLines, receiptPdf } from '../src/receipt.ts';
import { toolByName } from '../src/tools.ts';
import { fakePayPal } from './fakePayPal.ts';

const body = (a: ToolAnswer) => JSON.parse(a.content[0]!.text);

function setup(o: { budget?: string; failFirst?: string[]; now?: () => Date } = {}) {
  const pp = fakePayPal();
  const ledger = new Ledger(':memory:');
  const meter = new Meter({ ledger, paypal: pp.client, env: 'sandbox', publicUrl: 'http://127.0.0.1:8790', budget: o.budget, failFirst: o.failFirst, now: o.now });
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
