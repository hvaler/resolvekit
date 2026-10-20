/**
 * Task 10: evidence after an escalation (owner-approved W-6, packages/paypal/contracts/evidence-after-escalation.json).
 * PayPal took seller evidence in the claim of an escalated inquiry that had no seller evidence. Evidence stays once per
 * dispute (controller ruling): any seller evidence (PROVIDE_EVIDENCE in any stage, or without a stage), or any evidence
 * this server sent, blocks a new one; the only case W-6 opens is evidence in CHARGEBACK on a dispute with no seller
 * evidence at all, however it was escalated. Fake PayPal only: nothing is sent anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PayPalClient, type Dispute, type Evidence } from '@resolvekit/paypal';
import { caseInput, standardCase } from '@resolvekit/cases';
import { CONTRACTS } from '../../web/src/domain/actionContracts.ts';
import { ACTION_RULES, type ContractRegistry } from '../../web/src/domain/actions.ts';
import { createApp, DEFAULT_ORIGINS, TOKEN_HEADER } from '../src/app.ts';
import { IntentStore } from '../src/intents.ts';
import { toSnapshot } from '../src/mapping.ts';
import { RESOLVED, STD_CAPTURE, analystFor, standardDispute } from './kit.ts';

const CASE = standardCase.summary.id;
const REAL = 'PP-R-REAL-1';
const TOKEN = 'a'.repeat(64);
const BASE = 'http://127.0.0.1:8787';
const NOW = new Date(Date.UTC(2026, 9, 20, 8, 0, 0));
const intentPath = `/api/disputes/${CASE}/intent`;
const evidencePath = `/api/disputes/${CASE}/evidence`;

const ESCALATED: Evidence = { evidence_type: 'OTHER', notes: 'We ask PayPal to review.', source: 'SUBMITTED_BY_SELLER', date: '2026-10-20T06:17:41.810Z', action_info: { action: 'ESCALATE' }, dispute_life_cycle_stage: 'INQUIRY' };
const sellerEvidence = (stage: string | null, date: string): Evidence => ({
  evidence_type: 'PROOF_OF_FULFILLMENT',
  source: 'SUBMITTED_BY_SELLER',
  date,
  action_info: { action: 'PROVIDE_EVIDENCE' },
  ...(stage ? { dispute_life_cycle_stage: stage } : {}),
});
/** The claim after the escalation, waiting for the seller (W-6 `before`): accept and provide_evidence offered. */
function claim(extra: Evidence[] = [], escalated = true): Dispute {
  const d = standardDispute();
  return {
    ...d,
    dispute_life_cycle_stage: 'CHARGEBACK',
    evidences: [...(d.evidences ?? []), ...(escalated ? [ESCALATED] : []), ...extra, { evidence_type: 'PROOF_OF_FULFILLMENT', source: 'REQUESTED_FROM_SELLER', date: '2026-10-20T06:20:23.699Z' }],
    links: [{ rel: 'self' }, { rel: 'accept_claim' }, { rel: 'provide_evidence' }],
  };
}

async function setup(first: Dispute, o: { contracts?: ContractRegistry; later?: Dispute[] } = {}) {
  const state = { dispute: first };
  const sends: RequestInit[] = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
    if (u.pathname.endsWith('/provide-evidence')) {
      sends.push(init);
      return new Response(JSON.stringify({ links: [] }), { status: 200 });
    }
    return new Response(JSON.stringify(state.dispute), { status: 200 });
  }) as typeof globalThis.fetch;
  const client = new PayPalClient({ clientId: 'cid', clientSecret: 'secret', env: 'sandbox', fetch });
  // The analysis of the documents as read on each dispute the test moves to (the analyst's input carries the read).
  const inputOf = (d: Dispute) => caseInput(standardCase, { kind: 'live', snap: toSnapshot(d, CASE, 'sandbox', NOW), failed: null });
  const { analyst } = await analystFor([first, ...(o.later ?? [])].map((d) => [CASE, inputOf(d)] as [string, ReturnType<typeof inputOf>]));
  const intents = new IntentStore({ now: () => NOW });
  const app = createApp({
    paypal: client,
    env: 'sandbox',
    bindings: { [CASE]: { dispute: REAL, capture: STD_CAPTURE } },
    now: () => NOW,
    log: () => {},
    port: 8787,
    token: TOKEN,
    allowedOrigins: DEFAULT_ORIGINS,
    analyst,
    intents,
    ...(o.contracts ? { actionRegistry: { contracts: o.contracts, rules: ACTION_RULES } } : {}),
  });
  return { app, state, sends, intents };
}

const post = (path: string, body: unknown) =>
  new Request(BASE + path, { method: 'POST', headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json', origin: 'http://127.0.0.1:4173' }, body: JSON.stringify(body) });
type App = Awaited<ReturnType<typeof setup>>['app'];
const request = { evidenceType: 'PROOF_OF_FULFILLMENT', edits: {}, resolutions: RESOLVED };
async function propose(app: App): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await app(post(intentPath, request));
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}
/** Propose, approve and send one evidence response: the send's status and error. */
async function sendOne(app: App): Promise<[number, string | undefined]> {
  const p = await propose(app);
  if (p.status !== 201) return [p.status, p.body.error as string];
  const i = p.body as { id: string; contentHash: string };
  assert.equal((await app(post(`${intentPath}/${i.id}/approve`, { contentHash: i.contentHash }))).status, 200);
  const r = await app(post(evidencePath, { intentId: i.id }));
  return [r.status, ((await r.json()) as { error?: string }).error];
}

const NOT_RECORDED: ContractRegistry = { ...CONTRACTS, 'evidence:after_escalation': { ...CONTRACTS['evidence:after_escalation'], status: 'not_available', reason: 'Contract not recorded yet' } };

test('evidence after escalation follows the registry: the claim with no seller evidence at all takes evidence once', async () => {
  assert.equal(CONTRACTS['evidence:after_escalation'].status, 'tested_locally');
  // W-6: the claim after the seller's escalation, no seller evidence (the ESCALATE entry is not evidence).
  const { app, state, sends } = await setup(claim());
  assert.deepEqual(await sendOne(app), [202, undefined]);
  assert.equal(sends.length, 1);
  // PayPal's read does not show it yet: this server's memory refuses a second one.
  assert.deepEqual(await sendOne(app), [409, 'SELLER_EVIDENCE_EXISTS']);
  // PayPal shows the claim's seller evidence: composing is refused.
  state.dispute = claim([sellerEvidence('CHARGEBACK', '2026-10-20T08:00:03.000Z')]);
  const second = await propose(app);
  assert.deepEqual([second.status, second.body.error], [422, 'DRAFT_BLOCKED']);
  assert.equal(sends.length, 1);
});

test('evidence once: seller evidence from the inquiry still blocks the claim', async () => {
  for (const escalated of [true, false]) {
    const { app, sends } = await setup(claim([sellerEvidence('INQUIRY', '2026-10-19T20:00:00.000Z')], escalated));
    const p = await propose(app);
    assert.deepEqual([p.status, p.body.error], [422, 'DRAFT_BLOCKED'], JSON.stringify(p.body));
    assert.equal(sends.length, 0);
  }
});

test('evidence after escalation not recorded: the inquiry evidence blocks the claim (the whole dispute), and so does the escalation', async () => {
  const shown = await setup(claim([sellerEvidence('INQUIRY', '2026-10-19T20:00:00.000Z')], false), { contracts: NOT_RECORDED });
  const p = await propose(shown.app);
  assert.deepEqual([p.status, p.body.error], [422, 'DRAFT_BLOCKED'], JSON.stringify(p.body));
  // The seller escalated: evidence afterwards is that variant, «Not available» with its reason.
  const escalated = await setup(claim(), { contracts: NOT_RECORDED });
  const e = await propose(escalated.app);
  assert.deepEqual([e.status, e.body.error, e.body.detail], [409, 'VARIANT_NOT_AVAILABLE', 'Not available: Contract not recorded yet']);
  assert.equal(shown.sends.length + escalated.sends.length, 0);
});

test('memory: evidence this server sent in the inquiry blocks the claim, recorded variant or not', async () => {
  for (const contracts of [undefined, NOT_RECORDED]) {
    const inquiry = standardDispute();
    // The claim, escalated by someone else (no seller ESCALATE entry); PayPal's read lags and shows no seller evidence.
    const later = claim([], false);
    const { app, state, sends, intents } = await setup(inquiry, { ...(contracts ? { contracts } : {}), later: [later] });
    assert.deepEqual(await sendOne(app), [202, undefined]);
    assert.equal(intents.evidenceSentIn(REAL, 'INQUIRY'), true);
    state.dispute = later;
    assert.deepEqual(await sendOne(app), [409, 'SELLER_EVIDENCE_EXISTS']);
    assert.equal(sends.length, 1);
  }
});

test('a claim escalated by the buyer or PayPal, with no seller evidence, takes evidence (W-6 case)', async () => {
  const { app, sends } = await setup(claim([], false));
  assert.deepEqual(await sendOne(app), [202, undefined]);
  assert.equal(sends.length, 1);
});

test('a seller entry without a stage (legacy) blocks the whole dispute; the ESCALATE entry is not evidence', async () => {
  const legacy = await setup(claim([sellerEvidence(null, '2026-10-19T20:00:00.000Z')]));
  const l = await propose(legacy.app);
  assert.deepEqual([l.status, l.body.error], [422, 'DRAFT_BLOCKED']);
  // Only the escalation entry by the seller: nothing blocks evidence in the claim.
  const only = await setup(claim());
  assert.deepEqual(await sendOne(only.app), [202, undefined]);
});

test('after an escalation, evidence only where it was recorded: the claim waiting for the seller (not the inquiry under review)', async () => {
  // W-5 +30 s: UNDER_REVIEW in the inquiry, provide_evidence offered for a moment. Never recorded: refused.
  const d = standardDispute();
  const flicker: Dispute = { ...d, status: 'UNDER_REVIEW', evidences: [...(d.evidences ?? []), ESCALATED], links: [{ rel: 'self' }, { rel: 'provide_evidence' }] };
  const { app, sends } = await setup(flicker);
  const p = await propose(app);
  assert.deepEqual([p.status, p.body.error], [409, 'VARIANT_NOT_AVAILABLE'], JSON.stringify(p.body));
  assert.equal(sends.length, 0);
});
