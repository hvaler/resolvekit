/**
 * Every error, missing value or unexpected PayPal answer must deny: no paid call runs, no session opens, no money
 * moves, nothing is marked charged or settled.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.ts';
import { Meter, type ToolAnswer } from '../src/meter.ts';
import { toolByName } from '../src/tools.ts';
import { fakePayPal } from './fakePayPal.ts';

type Fake = ReturnType<typeof fakePayPal>;
const body = (a: ToolAnswer) => JSON.parse(a.content[0]!.text);

function setup(now?: () => Date) {
  const pp = fakePayPal();
  const ledger = new Ledger(':memory:');
  const meter = new Meter({ ledger, paypal: pp.client, env: 'sandbox', publicUrl: 'http://127.0.0.1:8790', now });
  return { pp, ledger, meter };
}

async function openSession(meter: Meter, pp: Fake) {
  const pr = body(await meter.call('mcp-1', 'quote_lookup', { symbol: 'A' }));
  pp.approve(pr.order_id);
  assert.equal(body(await meter.balance('mcp-1')).status, 'active');
  return pr.session_id as string;
}

function countRuns(name: string) {
  const t = toolByName(name)!;
  const orig = t.run;
  const c = { runs: 0, restore: () => void (t.run = orig) };
  t.run = (a) => ((c.runs += 1), orig(a));
  return c;
}

/** An authorize answer for `orderId`, altered by `edit`. */
function authorizeAnswer(orderId: string, sessionId: string, edit: (a: Record<string, any>, pu: Record<string, any>) => void) {
  const a: Record<string, any> = { id: 'AUTHX', status: 'CREATED', amount: { currency_code: 'USD', value: '5.00' }, expiration_time: '2026-11-06T18:09:13Z' };
  const pu: Record<string, any> = { custom_id: sessionId, amount: { currency_code: 'USD', value: '5.00' }, payments: { authorizations: [a] } };
  edit(a, pu);
  return { id: orderId, status: 'COMPLETED', purchase_units: [pu] };
}

test('an authorization that is not CREATED, not for the cap, not this session’s, without or past its expiry never opens the session', async () => {
  const cases: Array<[string, (a: Record<string, any>, pu: Record<string, any>) => void]> = [
    ['PENDING status', (a) => (a.status = 'PENDING')],
    ['missing status', (a) => delete a.status],
    ['amount below the cap', (a) => (a.amount.value = '1.00')],
    ['malformed amount', (a) => (a.amount.value = 'NaN')],
    ['missing amount', (a) => delete a.amount],
    ['other currency', (a) => (a.amount.currency_code = 'EUR')],
    ['other session', (_a, pu) => (pu.custom_id = 'mm-sess-ffffffffffffffffffffffffffffffff')],
    ['no expiry', (a) => delete a.expiration_time],
    ['expired', (a) => (a.expiration_time = '2020-01-01T00:00:00Z')],
    ['two authorizations', (a, pu) => pu.payments.authorizations.push({ ...a, id: 'AUTHY' })],
    ['no authorization', (_a, pu) => (pu.payments.authorizations = [])],
  ];
  for (const [what, edit] of cases) {
    const { meter, pp, ledger } = setup();
    const pr = body(await meter.call('mcp-1', 'quote_lookup', { symbol: 'A' }));
    pp.approve(pr.order_id);
    pp.failNext(/authorize$/, 201, authorizeAnswer(pr.order_id, pr.session_id, edit));
    assert.equal(body(await meter.balance('mcp-1')).status, 'pending_approval', what);
    // (The fake does not keep the altered answer; stop it from re-authorizing a clean one on the next read.)
    pp.orders.get(pr.order_id)!.status = 'PAYER_ACTION_REQUIRED';
    assert.equal(body(await meter.call('mcp-1', 'quote_lookup', { symbol: 'A' })).error, 'payment_required', what);
    assert.equal(ledger.session(pr.session_id)!.status, 'pending_approval', what);
    assert.equal(ledger.calls(pr.session_id).length, 0, what);
  }
});

test('an authorize answer for another order never opens the session', async () => {
  const { meter, pp, ledger } = setup();
  const pr = body(await meter.call('mcp-1', 'quote_lookup', { symbol: 'A' }));
  pp.approve(pr.order_id);
  pp.failNext(/authorize$/, 201, authorizeAnswer('OTHERORDER', pr.session_id, () => {}));
  await meter.balance('mcp-1');
  assert.equal(ledger.session(pr.session_id)!.status, 'pending_approval');
});

test('a PayPal error while checking the approval keeps the session pending', async () => {
  const { meter, pp, ledger } = setup();
  const pr = body(await meter.call('mcp-1', 'quote_lookup', { symbol: 'A' }));
  pp.approve(pr.order_id);
  pp.failNext(/authorize$/, 500);
  assert.equal(body(await meter.balance('mcp-1')).status, 'pending_approval');
  // A read is retried by the client (408/5xx, twice): PayPal failing every attempt.
  for (let i = 0; i < 3; i++) pp.failNext(/^GET \/v2\/checkout\/orders/, 503);
  assert.equal(body(await meter.call('mcp-1', 'quote_lookup', { symbol: 'A' })).error, 'payment_required');
  assert.equal(ledger.calls(pr.session_id).length, 0);
});

test('a session whose authorization has expired runs no paid call', async () => {
  let now = new Date('2026-10-09T10:00:00Z');
  const { meter, pp, ledger } = setup(() => now);
  const id = await openSession(meter, pp);
  now = new Date('2026-11-07T00:00:00Z'); // the fake authorization expires 2026-11-06T18:09:13Z
  const c = countRuns('quote_lookup');
  try {
    assert.equal(body(await meter.call('mcp-1', 'quote_lookup', { symbol: 'A' })).error, 'authorization_expired');
    assert.equal(c.runs, 0);
    assert.equal(ledger.calls(id).length, 0);
  } finally {
    c.restore();
  }
});

test('a tool without a valid price, an unknown tool, or a ledger that cannot reserve: nothing runs, nothing is charged', async () => {
  const { meter, pp, ledger } = setup();
  const id = await openSession(meter, pp);
  const t = toolByName('quote_lookup')!;
  const c = countRuns('quote_lookup');
  try {
    for (const bad of ['abc', '0.00', '', '-1', '1.001']) {
      const price = t.price;
      t.price = bad;
      try {
        assert.equal(body(await meter.call('mcp-1', 'quote_lookup', { symbol: 'A' })).error, 'price_unavailable', bad);
      } finally {
        t.price = price;
      }
    }
    assert.throws(() => ledger.reserve(id, 'quote_lookup', Number.NaN, 'now', () => 'h'), /Invalid price/);
    assert.throws(() => ledger.reserve(id, 'quote_lookup', 0, 'now', () => 'h'), /Invalid price/);
    assert.throws(() => ledger.reserve(id, 'quote_lookup', 1.5, 'now', () => 'h'), /Invalid price/);
    const reserve = ledger.reserve;
    ledger.reserve = () => {
      throw new Error('database is locked');
    };
    try {
      assert.equal(body(await meter.call('mcp-1', 'quote_lookup', { symbol: 'A' })).error, 'ledger_unavailable');
    } finally {
      ledger.reserve = reserve;
    }
    assert.equal(body(await meter.call('mcp-1', 'unknown_tool', {})).error, 'unknown_tool');
    assert.equal(c.runs, 0);
    assert.equal(ledger.calls(id).length, 0);
  } finally {
    c.restore();
  }
});

test('a ledger failure after the tool ran never marks the call charged', async () => {
  const { meter, pp, ledger } = setup();
  const id = await openSession(meter, pp);
  const commit = ledger.commit;
  ledger.commit = () => {
    throw new Error('disk I/O error');
  };
  try {
    assert.equal(body(await meter.call('mcp-1', 'quote_lookup', { symbol: 'A' })).error, 'upstream_failed');
  } finally {
    ledger.commit = commit;
  }
  assert.equal(ledger.chargedCents(id), 0);
  assert.equal(ledger.calls(id)[0]!.status, 'FAILED');
});

test('settlement moves money only on a verified CREATED authorization and a capture that matches', async () => {
  const authUrl = /^GET \/v2\/payments\/authorizations\/[^/]+$/;
  const usd = (value: string) => ({ currency_code: 'USD', value });
  const cases: Array<[string, (pp: Fake) => void, boolean, number]> = [
    ['authorization read fails (every retry)', (pp) => [1, 2, 3].forEach(() => pp.failNext(authUrl, 503)), true, 0],
    ['authorization VOIDED', (pp) => pp.failNext(authUrl, 200, { id: 'A', status: 'VOIDED', amount: usd('5.00') }), true, 0],
    ['authorization EXPIRED (void path)', (pp) => pp.failNext(authUrl, 200, { id: 'A', status: 'EXPIRED', amount: usd('5.00') }), false, 0],
    ['authorization CAPTURED on a first attempt', (pp) => pp.failNext(authUrl, 200, { id: 'A', status: 'CAPTURED', amount: usd('5.00') }), true, 0],
    ['authorization does not cover the amount', (pp) => pp.failNext(authUrl, 200, { id: 'A', status: 'CREATED', amount: usd('0.01') }), true, 0],
    ['authorization without amount', (pp) => pp.failNext(authUrl, 200, { id: 'A', status: 'CREATED' }), true, 0],
    ['capture for another amount', (pp) => pp.failNext(/capture$/, 201, { id: 'CAPX', status: 'COMPLETED', amount: usd('5.00') }), true, 1],
    ['capture without id', (pp) => pp.failNext(/capture$/, 201, { status: 'COMPLETED' }), true, 1],
    ['void not VOIDED', (pp) => pp.failNext(/void$/, 200, { id: 'A', status: 'CREATED' }), false, 1],
  ];
  for (const [what, prepare, consume, moves] of cases) {
    const { meter, pp, ledger } = setup();
    const id = await openSession(meter, pp);
    if (consume) await meter.call('mcp-1', 'quote_lookup', { symbol: 'A' });
    prepare(pp);
    const r = await meter.close(id);
    const s = ledger.session(id)!;
    const rc = meter.receipt(id)!;
    assert.equal(r.status, 'settlement_failed', what);
    assert.equal(s.capture_id, null, what);
    assert.equal(rc.settlement.status, 'failed', what);
    assert.equal(rc.settlement.remainder_released, false, what);
    assert.equal(pp.count(/capture$|void$/), moves, what);
  }
});

test('close and call at the same moment: the capture equals the OK calls, nothing runs after closing, nothing is left in flight', async () => {
  for (const order of ['call-first', 'close-first'] as const) {
    const { meter, pp, ledger } = setup();
    const id = await openSession(meter, pp);
    const [first, second] =
      order === 'call-first'
        ? await Promise.all([meter.call('mcp-1', 'quote_lookup', { symbol: 'A' }), meter.close(id)])
        : await Promise.all([meter.close(id), meter.call('mcp-1', 'quote_lookup', { symbol: 'A' })]);
    const call = (order === 'call-first' ? first : second) as ToolAnswer;
    const s = ledger.session(id)!;
    const ok = ledger.calls(id).filter((c) => c.status === 'OK').length;
    if (s.status === 'settled') {
      assert.equal(s.captured_cents, ledger.chargedCents(id), order);
      assert.equal(ok, 1, order);
    } else if (s.status === 'voided') {
      assert.equal(ok, 0, order);
      assert.equal(call.isError, true, order);
      assert.equal(pp.count(/capture$/), 0, order);
    } else {
      // The close lost to an in-flight call ("busy"): the session is still active, nothing settled.
      assert.equal(s.status, 'active', order);
      assert.equal(s.capture_id, null, order);
    }
    assert.equal(ledger.calls(id).filter((c) => c.status === 'PENDING').length, 0, order);
  }
});
