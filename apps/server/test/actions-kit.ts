/**
 * Test kit for the action routes (B0, Task 7). The fake PayPal answers dispute reads from a recorded sandbox read
 * (packages/paypal/contracts/reads/), re-bound to the standard case's payment, and the action POSTs with a reply the
 * test chooses. No contract for an action write is recorded yet, so the default reply is synthetic (marked below).
 * The real registry still says «Not available»: the routes are tested with a test-only contract and rules injected
 * through `actionRegistry`, never by changing CONTRACTS or ACTION_RULES.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PayPalClient, type Dispute } from '@resolvekit/paypal';
import { caseInput, standardCase } from '@resolvekit/cases';
import { CONTRACTS } from '../../web/src/domain/actionContracts.ts';
import type { ContractRegistry, RulesOf, SimpleAction } from '../../web/src/domain/actions.ts';
import { createApp, DEFAULT_ORIGINS, TOKEN_HEADER } from '../src/app.ts';
import { IntentStore } from '../src/intents.ts';
import { toSnapshot } from '../src/mapping.ts';
import { SELLER_ID, STD_CAPTURE, analystFor } from './kit.ts';

export const CASE = standardCase.summary.id;
export const REAL = 'PP-R-REAL-1';
export const TOKEN = 'a'.repeat(64);
const BASE = 'http://127.0.0.1:8787';
export const T0 = Date.UTC(2026, 9, 19, 9, 0, 0);
/** The read-back may take an action as absent this long after send_started (test-only contract). */
export const ABSENT_AFTER_MS = 60_000;

/**
 * A recorded sandbox read of a dispute waiting for the seller (PP-R-KHH-10193360, 2026-10-19), re-bound to the standard
 * case's payment (dispute id, capture, 7.00 USD, the test seller) so the binding verifies.
 */
export function recordedDispute(): Dispute {
  const d = JSON.parse(readFileSync(new URL('../../../packages/paypal/contracts/reads/inquiry-waiting-seller-KHH.json', import.meta.url), 'utf8')) as Dispute;
  const usd = { currency_code: 'USD', value: '7.00' };
  return {
    ...d,
    dispute_id: REAL,
    dispute_amount: usd,
    disputed_transactions: [{ ...d.disputed_transactions![0]!, seller_transaction_id: STD_CAPTURE, gross_amount: usd, seller: { merchant_id: SELLER_ID } }],
  };
}

/** A copy of the dispute with one more thread message (PayPal's shape: posted_by, time_posted, content). */
export const withMessage = (d: Dispute, postedBy: 'BUYER' | 'SELLER', at: number, content: string): Dispute => ({
  ...d,
  messages: [...(d.messages ?? []), { posted_by: postedBy, time_posted: new Date(at).toISOString(), content }],
});

/** The registry with test-only contracts: a message with its recorded proof fields and an absence delay, an escalate. */
export const TEST_CONTRACTS: ContractRegistry = {
  ...CONTRACTS,
  send_message: { ...CONTRACTS.send_message, status: 'implemented', reason: null, absentAfterMs: ABSENT_AFTER_MS },
  escalate: { ...CONTRACTS.escalate, status: 'implemented', reason: null },
  'accept_claim:REFUND': { ...CONTRACTS['accept_claim:REFUND'], status: 'implemented', reason: null },
};
export const TEST_RULES: Readonly<Partial<Record<SimpleAction, RulesOf>>> = {
  send_message: () => ({ stages: ['INQUIRY'], amount: 'not_allowed', text: 'required' }),
  escalate: () => ({ stages: ['INQUIRY'], amount: 'not_allowed', text: 'required' }),
  accept_claim: () => ({ stages: null, amount: 'optional', text: 'optional' }),
};

type Reply = { status: number; body: unknown } | Error;
export interface ActionPost {
  path: string;
  requestId: string | null;
  body: string;
}

/**
 * PayPal by path. Reads answer `dispute()` (or `readReply()` when set: an unreadable dispute); the action POSTs are
 * recorded and answered by `actionReply()`.
 */
export function actionPayPal(o: { dispute: () => Dispute; actionReply?: () => Reply; readReply?: () => Reply | null; postDelayMs?: number }) {
  const posts: ActionPost[] = [];
  const reads: string[] = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
    if ((init.method ?? 'GET') === 'POST') {
      const h = new Headers(init.headers);
      posts.push({ path: u.pathname, requestId: h.get('paypal-request-id'), body: typeof init.body === 'string' ? init.body : '' });
      if (o.postDelayMs) await new Promise((r) => setTimeout(r, o.postDelayMs));
      // synthetic: no contract yet (no action write is recorded; PayPal documents a 200 with the dispute's links)
      const r = o.actionReply?.() ?? { status: 200, body: { links: [{ rel: 'self', method: 'GET' }] } };
      if (r instanceof Error) throw r;
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json', 'paypal-debug-id': 'dbg-action' } });
    }
    reads.push(u.pathname);
    const fail = o.readReply?.();
    if (fail instanceof Error) throw fail;
    if (fail) return new Response(JSON.stringify(fail.body), { status: fail.status, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(o.dispute()), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { posts, reads, client: new PayPalClient({ clientId: 'cid', clientSecret: 'secret', env: 'sandbox', fetch, sleep: async () => {} }) };
}

/** A timeout as the PayPal client's fetch gives it. */
export const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

/** The local app with the standard case bound to the recorded dispute, the test-only registry and a movable clock. */
export async function setupActions(o: { dispute?: () => Dispute; actionReply?: () => Reply; readReply?: () => Reply | null; postDelayMs?: number; intents?: IntentStore; registry?: false } = {}) {
  const state = { dispute: recordedDispute(), t: T0 };
  const dispute = o.dispute ?? (() => state.dispute);
  const pp = actionPayPal({ dispute, ...(o.actionReply ? { actionReply: o.actionReply } : {}), ...(o.readReply ? { readReply: o.readReply } : {}), ...(o.postDelayMs ? { postDelayMs: o.postDelayMs } : {}) });
  const now = () => new Date(state.t);
  const intents = o.intents ?? new IntentStore({ now });
  const input = caseInput(standardCase, { kind: 'live', snap: toSnapshot(dispute(), CASE, 'sandbox', now()), failed: null });
  const { analyst } = await analystFor([[CASE, input]]);
  const lines: string[] = [];
  const app = createApp({
    paypal: pp.client,
    env: 'sandbox',
    bindings: { [CASE]: { dispute: REAL, capture: STD_CAPTURE } },
    now,
    log: (l) => lines.push(l),
    port: 8787,
    token: TOKEN,
    allowedOrigins: DEFAULT_ORIGINS,
    analyst,
    intents,
    ...(o.registry === false ? {} : { actionRegistry: { contracts: TEST_CONTRACTS, rules: TEST_RULES } }),
  });
  return { app, pp, state, intents, lines, now };
}

export type App = Awaited<ReturnType<typeof setupActions>>['app'];
export interface Intent {
  id: string;
  contentHash: string;
  requestId: string;
  status: string;
  reason?: string | null;
  disputeId: string | null;
  readBack?: string | null;
  [k: string]: unknown;
}

const post = (path: string, body: unknown) =>
  new Request(BASE + path, { method: 'POST', headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json', origin: 'http://127.0.0.1:4173' }, body: JSON.stringify(body) });
const get = (path: string) => new Request(BASE + path, { headers: { [TOKEN_HEADER]: TOKEN } });
export const intentPath = `/api/disputes/${CASE}/intent`;
export const sendPath = `/api/disputes/${CASE}/send`;
export const evidencePath = `/api/disputes/${CASE}/evidence`;

export async function answer(r: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}
/** Compose an action intent (201 expected unless `expect` says otherwise). */
export async function compose(app: App, body: Record<string, unknown> = { action: 'send_message', text: 'Your order shipped on 7 Oct; tracking 1Z999AA10123456784.' }): Promise<Intent> {
  const r = await answer(await app(post(intentPath, body)));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body as unknown as Intent;
}
export const approve = async (app: App, i: Intent, hash = i.contentHash) => answer(await app(post(`${intentPath}/${i.id}/approve`, { contentHash: hash })));
export const confirm = async (app: App, i: Intent, terms: unknown) => answer(await app(post(`${intentPath}/${i.id}/confirm`, { terms })));
export const acknowledge = async (app: App, i: Intent, shownMessageKeys: string[] = [], hash = i.contentHash) =>
  answer(await app(post(`${intentPath}/${i.id}/acknowledge`, { contentHash: hash, shownMessageKeys })));
export const send = async (app: App, i: Intent) => answer(await app(post(sendPath, { intentId: i.id })));
export const readBack = async (app: App, i: Intent) => answer(await app(get(`${intentPath}/${i.id}/readback`)));
export const postRaw = post;
