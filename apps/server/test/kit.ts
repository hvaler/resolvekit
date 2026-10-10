/**
 * Shared test kit for the submission-intent flow: a bound dispute that matches the standard case, the committed golden
 * analysis re-keyed to the server's input, and helpers that walk intent → approve → send through the API.
 */
import { readFileSync } from 'node:fs';
import { MemoryAnalysisStore, RateLimiter, analysisKey, type AnalysisInput, type CaseAnalysis } from '@resolvekit/analyst/node';
import type { Dispute } from '@resolvekit/paypal';
import { fakeModel } from '../../../packages/analyst/test/fake.ts';
import { AccountStore, SESSION_COOKIE, SESSION_TTL_MS, signSession, type Person } from '../src/accounts.ts';
import { AnalystService } from '../src/analysis.ts';
import { waitingDispute } from './fixtures.ts';

export const MODEL = 'gemini-3.8-flash';
export const STD_CAPTURE = '4FT237453Y5353014';
/** The seller's PayPal merchant id on the bound disputes (the payer id its Owner signs in with). */
export const SELLER_ID = 'SELLERMERCHANT01';
export const TEST_SECRET = 'x'.repeat(48);

/** The waiting sandbox dispute, for exactly the standard case's order (7.00 USD) and its capture. */
export function standardDispute(over: Partial<Dispute> = {}): Dispute {
  const d = waitingDispute();
  return {
    ...d,
    dispute_amount: { currency_code: 'USD', value: '7.00' },
    disputed_transactions: [{ ...d.disputed_transactions![0]!, seller_transaction_id: STD_CAPTURE, gross_amount: { currency_code: 'USD', value: '7.00' }, seller: { merchant_id: SELLER_ID } }],
    ...over,
  };
}

/** The committed golden analysis of a demo case, re-keyed to `input` (as if the model had analysed these documents). */
export async function goldenFor(caseId: string, input: AnalysisInput): Promise<CaseAnalysis> {
  const a = JSON.parse(readFileSync(new URL(`../../../packages/analyst/golden/${caseId}.json`, import.meta.url), 'utf8')) as CaseAnalysis;
  return { ...a, key: await analysisKey(input, MODEL) };
}

/**
 * An analyst whose store holds the golden analysis for each input, and whose (fake) model re-checks edited sentences
 * as `recheck` says (default: supported, citing the order).
 */
export async function analystFor(inputs: Array<[string, AnalysisInput]>, recheck: Record<string, unknown> = { facts: ['F7', 'F8'], verdict: 'supported', reason: '', rewrite: '' }) {
  const store = new MemoryAnalysisStore();
  for (const [caseId, input] of inputs) store.cached.set((await goldenFor(caseId, input)).key, await goldenFor(caseId, input));
  const fm = fakeModel({ recheck });
  const analyst = new AnalystService({
    model: fm.model,
    primaryModel: MODEL,
    store,
    liveLimit: new RateLimiter({ limit: 50, windowMs: 3_600_000 }),
    verifyLimit: new RateLimiter({ limit: 50, windowMs: 3_600_000 }),
  });
  return { analyst, store, model: fm };
}

/** The standard case's address contradiction, resolved with a note (what the merchant does before sending). */
export const RESOLVED = { C1: { status: 'resolved', note: 'Same building: the carrier records the unit as 4B.' } };

/** What the standard case's response sends: its five supported sentences, in order. */
export function goldenNotes(caseId: string, without: string[] = []): string {
  const a = JSON.parse(readFileSync(new URL(`../../../packages/analyst/golden/${caseId}.json`, import.meta.url), 'utf8')) as CaseAnalysis;
  return a.sentences
    .filter((s) => s.verdict === 'supported' && !without.includes(s.id))
    .map((s) => s.text.trim())
    .join(' ');
}

/**
 * Accounts for hosted tests: the seller's workspace (its Owner signed in with the seller's PayPal account), members
 * joined through an invite, and an outsider (another PayPal account, its own workspace). Each call of `member()` is a
 * new person; cookies are signed with {@link TEST_SECRET} on the given clock.
 */
export function testAccounts(now: () => Date = () => new Date()) {
  const accounts = new AccountStore({ now });
  const cookieOf = (p: Person) => `${SESSION_COOKIE}=${signSession(TEST_SECRET, p, now().getTime() + SESSION_TTL_MS)}`;
  const owner = accounts.signInWithPayPal({ payerId: SELLER_ID, name: 'Northwind Goods', email: 'owner@example.com' });
  if ('refused' in owner) throw new Error(owner.refused);
  const inv = accounts.createInvite({ workspaceId: owner.workspace.id, createdBy: owner.person.id, label: 'Team', reviewer: true, maxUses: 300, ttlMs: 30 * 24 * 3_600_000, accessUntil: null });
  if ('refused' in inv) throw new Error(inv.refused);
  let n = 0;
  return {
    accounts,
    ownerCookie: cookieOf(owner.person),
    owner: owner.person,
    workspace: owner.workspace,
    member: (name = `Member ${++n}`) => {
      const j = accounts.join(inv.token, { name, via: 'browser' });
      if ('refused' in j) throw new Error(j.refused);
      return cookieOf(j.person);
    },
    outsider: (payerId = `OUTSIDER${++n}`) => {
      const o = accounts.signInWithPayPal({ payerId, name: 'Elsewhere Shop', email: 'other@example.com' });
      if ('refused' in o) throw new Error(o.refused);
      return cookieOf(o.person);
    },
    cookieOf,
  };
}
