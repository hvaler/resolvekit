import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DailyCounters } from '@resolvekit/hosting';
import { SETTLEMENT_CASE_ID, standardCase } from '@resolvekit/cases';
import { PayPalClient, type Dispute } from '@resolvekit/paypal';
import { createHostedApp } from '../src/hosted.ts';
import { STD_CAPTURE, TEST_SECRET, standardDispute, testAccounts } from './kit.ts';

const ORIGIN = 'https://rk.example.com';
const HOST = 'rk.example.com';
const CASE = standardCase.summary.id;
const BOUND = 'PP-R-REAL-1';
const NEW = 'PP-R-NEW-2';
const ELSEWHERE = 'PP-R-OTHER-3';
const STL = 'PP-R-STL-WH-4';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** PayPal: verify answers `verdict()` (or fails), dispute reads by id; every call recorded. */
function paypal(o: { verdict?: () => string | number; failReads?: number } = {}) {
  let failReads = o.failReads ?? 0;
  const calls: string[] = [];
  const verifyBodies: string[] = [];
  const disputes: Record<string, Dispute> = {
    [BOUND]: { ...standardDispute(), dispute_id: BOUND },
    [NEW]: { ...standardDispute(), dispute_id: NEW },
    [STL]: { ...standardDispute(), dispute_id: STL },
    [ELSEWHERE]: { ...standardDispute(), dispute_id: ELSEWHERE, disputed_transactions: [{ ...standardDispute().disputed_transactions![0]!, seller: { merchant_id: 'SOMEONEELSE01' } }] },
  };
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
    calls.push(`${init.method ?? 'GET'} ${u.pathname}`);
    if (u.pathname === '/v1/notifications/verify-webhook-signature') {
      verifyBodies.push(String(init.body));
      const v = o.verdict?.() ?? 'SUCCESS';
      return typeof v === 'number' ? new Response('{"name":"INTERNAL_SERVER_ERROR"}', { status: v }) : new Response(JSON.stringify({ verification_status: v }), { status: 200 });
    }
    const d = disputes[decodeURIComponent(u.pathname.split('/').pop()!)];
    if (d && d.dispute_id !== BOUND && failReads > 0) {
      failReads--;
      return new Response('{"name":"INTERNAL_SERVICE_ERROR"}', { status: 500 });
    }
    return d ? new Response(JSON.stringify(d), { status: 200 }) : new Response('{"name":"RESOURCE_NOT_FOUND"}', { status: 404 });
  }) as typeof globalThis.fetch;
  return { calls, verifyBodies, client: new PayPalClient({ clientId: 'cid', clientSecret: 'secret', env: 'sandbox', fetch }) };
}

const KEY = 'k'.repeat(16) + '0123456789abcdef0123';

function setup(o: { bindings?: Record<string, { dispute: string; capture: string }>; webhook?: { id: string; key: string; verifyLimit?: { perMinute: number; inFlight: number } } | null; verdict?: () => string | number; failReads?: number } = {}) {
  const pp = paypal({ ...(o.verdict ? { verdict: o.verdict } : {}), ...(o.failReads ? { failReads: o.failReads } : {}) });
  const people = testAccounts();
  const lines: string[] = [];
  const app = createHostedApp({
    paypal: pp.client,
    env: 'sandbox',
    bindings: o.bindings ?? { [CASE]: { dispute: BOUND, capture: STD_CAPTURE } },
    log: (l) => lines.push(l),
    counters: new DailyCounters({ file: null, limits: {} }),
    site: null,
    accounts: people.accounts,
    identity: null,
    sessionSecret: TEST_SECRET,
    origins: [ORIGIN],
    hosts: [HOST],
    https: true,
    webhook: o.webhook === undefined ? { id: 'WEBHOOK0123456789', key: KEY } : o.webhook,
    webhookReadWaitsMs: [0, 1, 1],
  });
  return { app, pp, people, lines };
}

let seq = 0;
const event = (type: string, disputeId: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ id: `WH-TEST${String(++seq).padStart(6, '0')}-ABCDEF`, event_type: type, create_time: '2026-10-13T10:00:00Z', resource_type: 'dispute', resource: { dispute_id: disputeId, status: 'RESOLVED' }, ...over });

/** A delivery as PayPal makes it: no Origin, no cookie, the five transmission headers. */
const delivery = (body: string, headers: Record<string, string> = {}, key = KEY) =>
  new Request(`${ORIGIN}/api/paypal/webhook/${key}`, {
    method: 'POST',
    headers: {
      host: HOST,
      'x-forwarded-for': '173.0.81.1',
      'content-type': 'application/json',
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42',
      'paypal-transmission-id': `tx-${seq}`,
      'paypal-transmission-sig': 'c2lnbmF0dXJl',
      'paypal-transmission-time': '2026-10-13T10:00:01Z',
      ...headers,
    },
    body,
  });

const get = (path: string, cookie?: string) => new Request(ORIGIN + path, { headers: { host: HOST, 'x-forwarded-for': '203.0.113.7', ...(cookie ? { cookie } : {}) } });
type Notices = { notices: Array<{ eventType: string; disputeId: string; caseId: string | null; status: string | null; merchant?: string }> };
const notices = async (app: ReturnType<typeof setup>['app'], cookie?: string) => ((await (await app(get('/api/paypal/notices', cookie))).json()) as Notices).notices;
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 100 && !(await check()); i++) await sleep(5);
}

test('a verified CREATED for a new dispute: 200 at once, then PayPal is read again and only the seller’s workspace sees the notice', async () => {
  const { app, pp, people } = setup();
  const r = await app(delivery(event('CUSTOMER.DISPUTE.CREATED', NEW)));
  assert.equal(r.status, 200);
  await until(async () => (await notices(app, people.ownerCookie)).length > 0);
  const [n] = await notices(app, people.ownerCookie);
  assert.equal(n!.disputeId, NEW);
  assert.equal(n!.caseId, null);
  // The status is PayPal's own read, not what the payload claimed (RESOLVED).
  assert.equal(n!.status, standardDispute().status);
  assert.equal(n!.merchant, undefined);
  assert.ok(pp.calls.includes(`GET /v1/customer/disputes/${NEW}`));
  assert.equal((await notices(app, people.member())).length, 1);
  assert.deepEqual(await notices(app, people.outsider()), []);
  assert.deepEqual(await notices(app), []);
});

test('the raw body goes to PayPal for verification, with the configured webhook id', async () => {
  const { app, pp } = setup();
  const body = event('CUSTOMER.DISPUTE.CREATED', NEW);
  assert.equal((await app(delivery(body))).status, 200);
  assert.ok(pp.verifyBodies[0]!.endsWith(`"webhook_event":${body}}`));
  assert.equal(JSON.parse(pp.verifyBodies[0]!).webhook_id, 'WEBHOOK0123456789');
});

test('an UPDATED for the bound case: the workspace’s audit trail records it, and the next view reads PayPal again', async () => {
  const { app, pp, people } = setup();
  const member = people.member();
  assert.equal((await app(get(`/api/disputes/${CASE}`, member))).status, 200);
  const readsBefore = pp.calls.filter((c) => c === `GET /v1/customer/disputes/${BOUND}`).length;
  assert.equal((await app(delivery(event('CUSTOMER.DISPUTE.UPDATED', BOUND)))).status, 200);
  await until(async () => (await notices(app, member)).length > 0);
  assert.equal((await notices(app, member))[0]!.caseId, CASE);
  const audit = (await (await app(get(`/api/disputes/${CASE}/audit`, member))).json()) as { events: Array<{ kind: string; actor: string; detail?: string }> };
  const e = audit.events.find((x) => x.kind === 'paypal_notified');
  assert.ok(e, JSON.stringify(audit.events));
  assert.equal(e!.actor, 'PayPal (webhook)');
  assert.match(e!.detail!, /CUSTOMER\.DISPUTE\.UPDATED · dispute PP-R-REAL-1 is /);
  // Another workspace's trail does not show it.
  // three-environments plan, task 2: another workspace does not see the case at all
  assert.equal((await app(get(`/api/disputes/${CASE}/audit`, people.outsider()))).status, 404);
  assert.ok(pp.calls.filter((c) => c === `GET /v1/customer/disputes/${BOUND}`).length > readsBefore);
});

test('a dispute of another seller is noted for nobody here', async () => {
  const { app, people } = setup();
  assert.equal((await app(delivery(event('CUSTOMER.DISPUTE.CREATED', ELSEWHERE)))).status, 200);
  await sleep(50);
  assert.deepEqual(await notices(app, people.ownerCookie), []);
});

test('a delivery PayPal does not confirm is refused and changes nothing (no dispute read)', async () => {
  const { app, pp, people, lines } = setup({ verdict: () => 'FAILURE' });
  assert.equal((await app(delivery(event('CUSTOMER.DISPUTE.CREATED', NEW)))).status, 400);
  await sleep(30);
  assert.deepEqual(await notices(app, people.ownerCookie), []);
  // (A signed-in request reads the bound dispute anyway, to know the seller; the event's dispute is never read.)
  assert.ok(!pp.calls.includes(`GET /v1/customer/disputes/${NEW}`));
  assert.ok(lines.some((l) => /REJECTED/.test(l)));
});

test('when PayPal cannot confirm now, 503 asks PayPal to deliver again; the redelivery is then accepted', async () => {
  let down = true;
  const { app, people } = setup({ verdict: () => (down ? 500 : 'SUCCESS') });
  const body = event('CUSTOMER.DISPUTE.CREATED', NEW);
  assert.equal((await app(delivery(body))).status, 503);
  down = false;
  assert.equal((await app(delivery(body))).status, 200);
  await until(async () => (await notices(app, people.ownerCookie)).length > 0);
  assert.equal((await notices(app, people.ownerCookie)).length, 1);
});

test('a repeated event id is acknowledged once more without a second effect or a second verification', async () => {
  const { app, pp, people } = setup();
  const body = event('CUSTOMER.DISPUTE.CREATED', NEW);
  assert.equal((await app(delivery(body))).status, 200);
  const again = await app(delivery(body));
  assert.equal(again.status, 200);
  assert.equal(((await again.json()) as { repeated?: boolean }).repeated, true);
  await until(async () => (await notices(app, people.ownerCookie)).length > 0);
  await sleep(20);
  assert.equal((await notices(app, people.ownerCookie)).length, 1);
  assert.equal(pp.verifyBodies.length, 1);
});

test('unusable deliveries are refused before PayPal is asked: foreign certificate, missing header, not an event, too large', async () => {
  const { app, pp } = setup();
  assert.equal((await app(delivery(event('CUSTOMER.DISPUTE.CREATED', NEW), { 'paypal-cert-url': 'https://evil.example/cert.pem' }))).status, 400);
  const noSig = delivery(event('CUSTOMER.DISPUTE.CREATED', NEW));
  noSig.headers.delete('paypal-transmission-sig');
  assert.equal((await app(noSig)).status, 400);
  assert.equal((await app(delivery('{"hello":"world"}'))).status, 400);
  assert.equal((await app(delivery(event('CUSTOMER.DISPUTE.CREATED', NEW, { pad: 'x'.repeat(70_000) })))).status, 413);
  assert.equal(pp.verifyBodies.length, 0);
});

test('the webhook route needs no Origin or session, answers only POST, and does not exist without its configuration', async () => {
  const { app } = setup();
  assert.equal((await app(get(`/api/paypal/webhook/${KEY}`))).status, 405);
  const off = setup({ webhook: null }).app;
  assert.equal((await off(delivery(event('CUSTOMER.DISPUTE.CREATED', NEW)))).status, 404);
});

test('without the URL’s secret key a delivery is 404 and PayPal is never asked (strangers cannot spend the seller app’s calls)', async () => {
  const { app, pp } = setup();
  for (const key of ['wrong'.repeat(8), KEY.slice(0, -1), `${KEY}/x`]) assert.equal((await app(delivery(event('CUSTOMER.DISPUTE.CREATED', NEW), {}, key))).status, 404, key);
  assert.equal((await app(new Request(`${ORIGIN}/api/paypal/webhook`, { method: 'POST', headers: { host: HOST } }))).status, 403);
  assert.equal(pp.verifyBodies.length, 0);
});

test('non-dispute events and events without a dispute id are acknowledged without asking PayPal', async () => {
  const { app, pp, people } = setup();
  assert.equal((await app(delivery(event('PAYMENT.CAPTURE.COMPLETED', NEW)))).status, 200);
  assert.equal((await app(delivery(event('CUSTOMER.DISPUTE.CREATED', 'not-a-dispute')))).status, 200);
  await sleep(30);
  assert.deepEqual(await notices(app, people.ownerCookie), []);
  assert.equal(pp.verifyBodies.length, 0);
  assert.ok(!pp.calls.some((c) => c === `GET /v1/customer/disputes/${NEW}` || c.endsWith('/not-a-dispute')));
});

test('confirmations are capped across all callers: over the cap the answer is 503 (PayPal delivers again) without asking PayPal', async () => {
  const { app, pp } = setup({ webhook: { id: 'WEBHOOK0123456789', key: KEY, verifyLimit: { perMinute: 2, inFlight: 4 } } });
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await app(delivery(event('CUSTOMER.DISPUTE.CREATED', NEW), { 'x-forwarded-for': `198.51.100.${i}` }))).status);
  assert.deepEqual(codes, [200, 200, 503, 503]);
  assert.equal(pp.verifyBodies.length, 2);
});

test('a dispute read that fails right after a verified event is retried, so the notice is not lost', async () => {
  const { app, people } = setup({ failReads: 2 });
  assert.equal((await app(delivery(event('CUSTOMER.DISPUTE.CREATED', NEW)))).status, 200);
  await until(async () => (await notices(app, people.ownerCookie)).length > 0);
  assert.equal((await notices(app, people.ownerCookie))[0]!.disputeId, NEW);
});

test('a notice about the owner-only settlement case is listed to the owner only', async () => {
  const { app, people } = setup({ bindings: { [CASE]: { dispute: BOUND, capture: STD_CAPTURE }, [SETTLEMENT_CASE_ID]: { dispute: STL, capture: STD_CAPTURE } } });
  assert.equal((await app(delivery(event('CUSTOMER.DISPUTE.UPDATED', STL)))).status, 200);
  assert.equal((await app(delivery(event('CUSTOMER.DISPUTE.UPDATED', BOUND)))).status, 200);
  await until(async () => (await notices(app, people.ownerCookie)).length > 1);
  assert.deepEqual((await notices(app, people.ownerCookie)).map((n) => n.caseId).sort(), [CASE, SETTLEMENT_CASE_ID].sort());
  for (const cookie of [people.member(), people.fullMember()]) assert.deepEqual((await notices(app, cookie)).map((n) => n.caseId), [CASE]);
});
