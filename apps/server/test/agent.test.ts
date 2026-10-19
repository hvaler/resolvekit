import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PayPalClient } from '@resolvekit/paypal';
import { writePdf } from '@resolvekit/pdf';
import { MemoryAnalysisStore, type AnalysisInput } from '@resolvekit/analyst/node';
import { agentCase, caseInput } from '@resolvekit/cases';
import { AnalystService, InputPins } from '../src/analysis.ts';
import { createApp, DEFAULT_ORIGINS, TOKEN_HEADER } from '../src/app.ts';
import { MeterMcpClient, MeterMcpError, toMeteredSession, type MeterMcpSource, type Receipt } from '../src/metermcp.ts';
import { fakePayPal, waitingDispute } from './fixtures.ts';
import { analystFor } from './kit.ts';
import { toSnapshot } from '../src/mapping.ts';
import type { AgentReceiptSource } from '../../web/src/domain/types.ts';
import type { Step } from '@resolvekit/agent';
import { RunStore } from '../src/agent/runs.ts';
import type { AgentService } from '../src/agent/service.ts';

const CASE = 'PP-R-MMC-10190702';
const REAL = 'PP-R-REAL-1';
const TOKEN = 'a'.repeat(64);
const BASE = 'http://127.0.0.1:8787';
const SID = 'mm-sess-0123456789abcdef0123456789abcdef';
const CAPTURE = '4FT237453Y5353014';

/** A settled MeterMCP receipt for the bound dispute's capture (shape of apps/metermcp/src/receipt.ts). */
function receipt(): Receipt {
  const call = (n: number, tool: string, price: string, status: 'OK' | 'FAILED') => ({
    n,
    time: `2026-10-08T19:1${n}:00.000Z`,
    tool,
    price,
    status,
    request_hash: `${n}`.repeat(64),
    response_hash: status === 'OK' ? 'f'.repeat(64) : null,
    error: status === 'OK' ? null : 'UPSTREAM_UNAVAILABLE',
  });
  return {
    kind: 'metermcp.session_receipt',
    version: 1,
    paypal_env: 'sandbox',
    session: { id: SID, status: 'settled', currency: 'USD', created_at: '2026-10-08T19:09:00.000Z', closed_at: '2026-10-08T19:20:00.000Z' },
    mandate: {
      item: 'MeterMCP agent session (metered tool calls)',
      category: 'DIGITAL_GOODS',
      cap: '5.00',
      order_id: 'ORDER1',
      authorization_id: 'AUTH1',
      authorization_status: 'CAPTURED',
      authorization_expires_at: '2026-11-06T19:10:00Z',
      approved_at: '2026-10-08T19:10:00.000Z',
      authorized_at: '2026-10-08T19:10:00Z',
    },
    calls: [call(1, 'quote_lookup', '0.05', 'OK'), call(2, 'deep_report', '0.40', 'FAILED'), call(3, 'deep_report', '0.40', 'OK'), call(4, 'bulk_export', '0.92', 'OK')],
    totals: { calls: 4, ok: 3, failed: 1, pending: 0, charged: '1.37', cap: '5.00' },
    settlement: {
      status: 'captured',
      capture_id: CAPTURE,
      capture_status: 'COMPLETED',
      invoice_id: `${SID}-settle`,
      captured: '1.37',
      released: '3.63',
      remainder_released: true,
      settled_at: '2026-10-08T19:20:01.000Z',
      error: null,
    },
    note: 'Tool outputs are synthetic demo data.',
    receipt_sha256: 'e'.repeat(64),
  };
}

const RECEIPT_PDF = writePdf({ title: 'Session receipt', lines: [`Session ${SID}`, 'REAL RECEIPT MARKER'] });

function fakeMeter(o: { session?: boolean; down?: boolean } = {}) {
  const asked: string[] = [];
  const meter: MeterMcpSource = {
    findByCapture: async (c) => {
      asked.push(c);
      if (o.down) throw new MeterMcpError('MeterMCP unreachable');
      return o.session === false || c !== CAPTURE ? null : SID;
    },
    receipt: async () => receipt(),
    receiptPdf: async () => RECEIPT_PDF,
  };
  return { meter, asked };
}

function setup(replies: Parameters<typeof fakePayPal>[0], meterMcp: MeterMcpSource | null) {
  const pp = fakePayPal(replies);
  const paypal = new PayPalClient({ clientId: 'cid', clientSecret: 'secret', env: 'sandbox', fetch: pp.fetch });
  const app = createApp({ paypal, env: 'sandbox', bindings: { [CASE]: REAL }, port: 8787, token: TOKEN, allowedOrigins: DEFAULT_ORIGINS, meterMcp });
  return { pp, app };
}

const get = (path: string) => new Request(BASE + path, { headers: { [TOKEN_HEADER]: TOKEN } });
const post = (path: string, body: unknown) =>
  new Request(BASE + path, { method: 'POST', headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('receipt → MeteredSession keeps mandate, every call and the settlement', () => {
  const s = toMeteredSession(receipt());
  assert.equal(s.sessionId, SID);
  assert.deepEqual(s.mandate, { cap: '5.00', orderId: 'ORDER1', authorizationId: 'AUTH1', authorizationStatus: 'CAPTURED', approvedAt: '2026-10-08T19:10:00.000Z', authorizedAt: '2026-10-08T19:10:00Z' });
  assert.deepEqual(s.calls.map((c) => [c.n, c.tool, c.price, c.status]), [
    [1, 'quote_lookup', '0.05', 'OK'],
    [2, 'deep_report', '0.40', 'FAILED'],
    [3, 'deep_report', '0.40', 'OK'],
    [4, 'bulk_export', '0.92', 'OK'],
  ]);
  assert.deepEqual(s.settlement, { status: 'captured', captureId: CAPTURE, captureStatus: 'COMPLETED', captured: '1.37', released: '3.63', remainderReleased: true, settledAt: '2026-10-08T19:20:01.000Z' });
});

test('GET of the bound agent case adds the MeterMCP session found by the disputed capture', async () => {
  const { meter, asked } = fakeMeter();
  const { app } = setup([{ status: 200, body: waitingDispute() }], meter);
  const s = await (await app(get(`/api/disputes/${CASE}`))).json();
  assert.deepEqual(asked, [CAPTURE]);
  assert.equal(s.agentReceipt.kind, 'metermcp');
  assert.equal(s.agentReceipt.session.sessionId, SID);
  assert.equal(s.agentReceipt.session.totals.charged, '1.37');
  assert.equal('run' in s.agentReceipt, false, 'no run record for this session: no run summary');
});

/** A run record holding the session SID (and another one holding another session). */
function runStore() {
  const store = new RunStore({ dir: null });
  const steps: Step[] = [
    { n: 1, at: '2026-10-08T19:11:00.000Z', state: 'done', kind: 'call', tool: 'deep_report', arguments: { company: 'ACME' }, reason: 'The report answers the goal', summary: 'Deep report on ACME', metering: { status: 'OK', price: '0.40', charged: true, remaining: '0.60', injected: null } },
    { n: 2, at: '2026-10-08T19:12:00.000Z', state: 'uncertain', kind: 'call', tool: 'bulk_export', arguments: {}, reason: 'Export it', summary: 'Result unknown', metering: null },
  ];
  const rec = store.create({
    by: { personId: 'p-ana', label: 'Ana', workspaceId: 'ws-1' },
    finishedAt: null, goal: 'Report on ACME', cap: '1.00', failFirst: [], state: 'interrupted', stopReason: null, answer: null, steps,
    approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDERSECRET', provider: 'gemini', model: 'm', usage: { modelCalls: 2, inputTokens: 10, outputTokens: 5, reported: true },
    sessionId: SID, orderId: 'ORDERSECRET', captureId: CAPTURE, settlement: 'captured', receiptSha256: null, captured: '0.40', released: '0.60', kept: false,
  });
  const other = store.create({ ...store.get(rec.id)!, sessionId: 'mm-sess-other', goal: 'another run' });
  return { store, rec, other };
}

async function readWith(binding: string | Partial<Record<'dispute' | 'capture' | 'run' | 'session', string>>, store: RunStore, reads = 1) {
  const { meter } = fakeMeter();
  const lines: string[] = [];
  const pp = fakePayPal(Array.from({ length: reads }, () => ({ status: 200, body: waitingDispute() })));
  const paypal = new PayPalClient({ clientId: 'cid', clientSecret: 'secret', env: 'sandbox', fetch: pp.fetch });
  const app = createApp({ paypal, env: 'sandbox', bindings: { [CASE]: binding as never }, port: 8787, token: TOKEN, allowedOrigins: DEFAULT_ORIGINS, meterMcp: meter, agent: { store } as unknown as AgentService, log: (l) => lines.push(l) });
  let s;
  for (let k = 0; k < reads; k++) s = await (await app(get(`/api/disputes/${CASE}`))).json();
  return { s, lines, pp };
}

test('Ruling A14: the run record goes with the case only when the binding names that run: a summary, no person, approval link or order', async () => {
  const { store, rec } = runStore();
  const { s, lines } = await readWith({ dispute: REAL, capture: CAPTURE, run: rec.id, session: SID }, store);
  assert.equal(s.agentReceipt.kind, 'metermcp');
  assert.deepEqual(s.agentReceipt.run, {
    runId: rec.id,
    goal: 'Report on ACME',
    outcome: 'interrupted',
    stopReason: null,
    steps: [
      { n: 1, tool: 'deep_report', state: 'done', reason: 'The report answers the goal', summary: 'Deep report on ACME' },
      { n: 2, tool: 'bulk_export', state: 'uncertain', reason: 'Export it', summary: 'Result unknown' },
    ],
  });
  const text = JSON.stringify(s);
  for (const v of ['p-ana', 'ORDERSECRET', 'checkoutnow', 'Ana']) assert.ok(!text.includes(v), v);
  assert.deepEqual(lines.filter((l) => l.includes('attached (E5)')), [`agent case ${CASE}: run record ${rec.id} attached (E5)`]);
  // Without the binding's session the named run still matches by the receipt's session.
  assert.equal((await readWith({ dispute: REAL, capture: CAPTURE, run: rec.id }, store)).s.agentReceipt.run.runId, rec.id);
});

test('the E5 run record is logged once when it is attached, not on every read of the case', async () => {
  const { store, rec } = runStore();
  const { s, lines, pp } = await readWith({ dispute: REAL, capture: CAPTURE, run: rec.id, session: SID }, store, 3);
  assert.equal(pp.apiCalls().length, 3);
  assert.equal(s.agentReceipt.run.runId, rec.id);
  assert.deepEqual(lines.filter((l) => l.includes('attached (E5)')), [`agent case ${CASE}: run record ${rec.id} attached (E5)`]);
});

test('Ruling A14: a run that holds the session but is not named by the binding, or named with another session, is never shown', async () => {
  const { store, rec, other } = runStore();
  for (const binding of [
    { dispute: REAL, capture: CAPTURE },
    REAL,
    { dispute: REAL, capture: CAPTURE, run: rec.id, session: 'mm-sess-another' },
    { dispute: REAL, capture: CAPTURE, run: other.id },
    { dispute: REAL, capture: CAPTURE, run: other.id, session: SID },
    { dispute: REAL, capture: CAPTURE, run: 'run-' + 'f'.repeat(32), session: SID },
  ]) {
    const { s, lines } = await readWith(binding, store);
    assert.equal(s.agentReceipt.kind, 'metermcp', JSON.stringify(binding));
    assert.equal('run' in s.agentReceipt, false, JSON.stringify(binding));
    assert.ok(!JSON.stringify(s).includes('Report on ACME'), JSON.stringify(binding));
    assert.equal(lines.some((l) => l.includes('attached (E5)')), false);
  }
});

test('GET of the agent case without a session (or with MeterMCP down) says why, and still returns PayPal’s dispute', async () => {
  for (const [m, why] of [
    [fakeMeter({ session: false }).meter, `MeterMCP has no session for capture ${CAPTURE}`],
    [fakeMeter({ down: true }).meter, 'MeterMCP unreachable'],
    [null, 'MeterMCP is not configured on this server'],
  ] as const) {
    const { app } = setup([{ status: 200, body: waitingDispute() }], m);
    const r = await app(get(`/api/disputes/${CASE}`));
    assert.equal(r.status, 200);
    const s = await r.json();
    assert.deepEqual(s.agentReceipt, { kind: 'none', reason: why });
    assert.equal(s.status, 'WAITING_FOR_SELLER_RESPONSE');
  }
});

/** The agent case bound to the waiting dispute, as the server composes it (MeterMCP session or demo documents). */
async function intentSetup(replies: Parameters<typeof fakePayPal>[0], meterMcp: MeterMcpSource | null, docsMeter: MeterMcpSource | null = meterMcp) {
  const pp = fakePayPal(replies);
  const paypal = new PayPalClient({ clientId: 'cid', clientSecret: 'secret', env: 'sandbox', fetch: pp.fetch });
  // The analysis of exactly the documents the server builds (with or without the MeterMCP session).
  const snap = toSnapshot(waitingDispute(), CASE, 'sandbox', new Date());
  const receiptSource: AgentReceiptSource = docsMeter ? { kind: 'metermcp', session: toMeteredSession(receipt()) } : { kind: 'none', reason: `MeterMCP has no session for capture ${CAPTURE}` };
  const input = caseInput(agentCase, { kind: 'live', snap: { ...snap, agentReceipt: receiptSource }, failed: null });
  const { analyst } = await analystFor([[CASE, input]]);
  const app = createApp({ paypal, env: 'sandbox', bindings: { [CASE]: { dispute: REAL, capture: CAPTURE } }, port: 8787, token: TOKEN, allowedOrigins: DEFAULT_ORIGINS, meterMcp, analyst });
  const intent = async () => {
    const r = await app(post(`/api/disputes/${CASE}/intent`, { evidenceType: 'PROOF_OF_FULFILLMENT' }));
    const b = (await r.json()) as { id: string; contentHash: string; carrier: string; tracking: string; files: Array<{ name: string }>; error?: string };
    assert.equal(r.status, 201, JSON.stringify(b));
    assert.equal((await app(post(`/api/disputes/${CASE}/intent/${b.id}/approve`, { contentHash: b.contentHash }))).status, 200);
    return b;
  };
  return { pp, app, intent };
}

test('agent case with a session: the server composes digital delivery (OTHER, session id) with the real receipt PDF, and sends exactly that', async () => {
  const { meter } = fakeMeter();
  const { app, pp, intent } = await intentSetup([{ status: 200, body: waitingDispute() }, { status: 200, body: waitingDispute() }, { status: 200, body: {} }], meter);
  const i = await intent();
  assert.deepEqual([i.carrier, i.tracking, i.files.map((f) => f.name)], ['OTHER', SID, [`session-receipt-${SID}.pdf`]]);
  const r = await app(post(`/api/disputes/${CASE}/evidence`, { intentId: i.id }));
  assert.equal(r.status, 202);
  const send = pp.apiCalls()[2]!;
  const form = send.init.body as FormData;
  const input = JSON.parse(await (form.get('input') as Blob).text());
  assert.deepEqual(input.evidences[0].evidence_info.tracking_info, [{ carrier_name: 'OTHER', tracking_number: SID, carrier_name_other: 'Digital delivery' }]);
  assert.equal(input.evidences[0].evidence_type, 'PROOF_OF_FULFILLMENT');
  const files = form.getAll('evidence-file') as File[];
  assert.deepEqual(files.map((f) => f.name), [`session-receipt-${SID}.pdf`]);
  const text = Buffer.from(await files[0]!.arrayBuffer()).toString('latin1');
  assert.ok(text.includes('REAL RECEIPT MARKER'));
  assert.ok(!text.includes('SYNTHETIC TEST DOCUMENT'));
});

test('agent case: another reference or another file cannot be asked for; the request is refused and nothing is sent', async () => {
  const { app, pp } = await intentSetup([{ status: 200, body: waitingDispute() }], fakeMeter().meter);
  for (const extra of [{ tracking: 'mm-sess-20261008-01' }, { carrier: 'UPS' }, { files: [{ name: 'session-receipt-mm-sess-20261008-01.pdf', size: '46 KB' }] }]) {
    const r = await app(post(`/api/disputes/${CASE}/intent`, { evidenceType: 'PROOF_OF_FULFILLMENT', ...extra }));
    assert.equal(r.status, 400);
  }
  assert.equal(pp.apiCalls().filter((c) => c.method === 'POST').length, 0);
});

test('agent case: no session → the demo documents; MeterMCP down at send time → documents changed, nothing sent', async () => {
  {
    const { app, pp, intent } = await intentSetup([{ status: 200, body: waitingDispute() }, { status: 200, body: waitingDispute() }, { status: 200, body: {} }], fakeMeter({ session: false }).meter, null);
    const i = await intent();
    assert.equal((await app(post(`/api/disputes/${CASE}/evidence`, { intentId: i.id }))).status, 202);
    const files = (pp.apiCalls()[2]!.init.body as FormData).getAll('evidence-file') as File[];
    assert.ok(Buffer.from(await files[0]!.arrayBuffer()).toString('latin1').includes('SYNTHETIC TEST DOCUMENT'));
  }
  {
    let down = false;
    const { meter } = fakeMeter();
    const flaky: MeterMcpSource = { ...meter, findByCapture: async (c) => (down ? Promise.reject(new MeterMcpError('MeterMCP unreachable')) : meter.findByCapture(c)) };
    const { app, pp, intent } = await intentSetup([{ status: 200, body: waitingDispute() }, { status: 200, body: waitingDispute() }], flaky, meter);
    const i = await intent();
    down = true;
    const r = await app(post(`/api/disputes/${CASE}/evidence`, { intentId: i.id }));
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, 'DOCUMENTS_CHANGED');
    assert.equal(pp.apiCalls().filter((c) => c.method === 'POST').length, 0);
  }
});

test('MeterMcpClient sends the per-launch token from the token file and maps errors', async (t) => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'rk-mm-'));
  const tokenFile = join(dir, '.runtime-token');
  const seen: Array<{ url: string; token: string | null }> = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    seen.push({ url: String(url), token: new Headers(init.headers).get('x-metermcp-token') });
    return new Response(JSON.stringify({ sessions: [{ id: SID }] }), { status: 200 });
  }) as typeof globalThis.fetch;
  const c = new MeterMcpClient({ base: 'http://127.0.0.1:8790/', tokenFile, fetch });
  await assert.rejects(c.findByCapture(CAPTURE), /not running/);
  writeFileSync(tokenFile, 'tok123\n');
  assert.equal(await c.findByCapture(CAPTURE), SID);
  assert.deepEqual(seen, [{ url: `http://127.0.0.1:8790/sessions?capture=${CAPTURE}`, token: 'tok123' }]);
  const down = new MeterMcpClient({ base: 'http://127.0.0.1:8790', tokenFile, fetch: (async () => new Response('{}', { status: 401 })) as typeof globalThis.fetch });
  await assert.rejects(down.receipt(SID), /answered 401/);
  t.after(async () => (await import('node:fs')).rmSync(dir, { recursive: true, force: true }));
});

test('analysis input of the bound agent case: built by the server from its own PayPal read and MeterMCP receipt, equal to what the web app shows', async () => {
  const { meter } = fakeMeter();
  const pp = fakePayPal([{ status: 200, body: waitingDispute() }]);
  const paypal = new PayPalClient({ clientId: 'cid', clientSecret: 'secret', env: 'sandbox', fetch: pp.fetch });
  const analyst = new AnalystService({ model: null, primaryModel: 'gemini-3.8-flash', store: new MemoryAnalysisStore() });
  const app = createApp({ paypal, env: 'sandbox', bindings: { [CASE]: REAL }, port: 8787, token: TOKEN, allowedOrigins: DEFAULT_ORIGINS, meterMcp: meter, analyst });
  const snap = await (await app(get(`/api/disputes/${CASE}`))).json();
  const web = caseInput(agentCase, { kind: 'live', snap, failed: null });
  // A client that sends its own receipt lines is ignored; the read above is reused (one PayPal call in all).
  const forged = { ...web, documents: web.documents.map((d) => (d.id === 'E2' ? { ...d, lines: [{ text: '#2 deep_report 0.40 USD OK' }] } : d)) };
  const r = await app(post(`/api/cases/${CASE}/analysis`, { input: forged }));
  const input = ((await r.json()) as { input: AnalysisInput }).input;
  assert.deepEqual(input, web);
  assert.equal(pp.apiCalls().length, 1);
  const e2 = input.documents.find((d) => d.id === 'E2')!.lines.map((l) => l.text);
  assert.ok(e2.some((t) => t.includes('#2') && t.includes('deep_report') && t.includes('FAILED')), e2.join('\n'));
  assert.ok(input.documents.find((d) => d.id === 'E1')!.lines.some((l) => l.text.includes(SID)));
});

test('pinned input: once PayPal shows the seller’s evidence, the analysis input stays the one from before sending', () => {
  const pins = new InputPins();
  const before = caseInput(agentCase, { kind: 'simulated' });
  const after = { ...before, dispute: { ...before.dispute, allowedActions: ['send_message'] } };
  assert.equal(pins.resolve(CASE, before, false), before);
  assert.equal(pins.resolve(CASE, after, true), before);
  // Different documents (e.g. a new stage) are not covered by the pin.
  const changed = { ...after, documents: after.documents.slice(1) };
  assert.equal(pins.resolve(CASE, changed, true), changed);
  // Before sending, the latest input is used (and pinned).
  assert.equal(pins.resolve(CASE, after, false), after);
});

test('H3: an agent session whose capture is still PENDING is not used as proof of a final charge: nothing composed, nothing sent', async () => {
  const pending: Receipt = { ...receipt(), settlement: { ...receipt().settlement, status: 'capture_pending', capture_status: 'PENDING', captured: null, released: null, remainder_released: false, settled_at: null } };
  const meter: MeterMcpSource = { findByCapture: async () => SID, receipt: async () => pending, receiptPdf: async () => RECEIPT_PDF };
  const { app, pp } = await intentSetup([{ status: 200, body: waitingDispute() }], meter);
  const r = await app(post(`/api/disputes/${CASE}/intent`, { evidenceType: 'PROOF_OF_FULFILLMENT' }));
  assert.equal(r.status, 409);
  const b = (await r.json()) as { error: string; detail: string };
  assert.equal(b.error, 'RECEIPT_NOT_FINAL');
  assert.match(b.detail, /PENDING/);
  assert.equal(pp.apiCalls().filter((c) => c.method === 'POST').length, 0);
});
