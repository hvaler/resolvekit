/**
 * Shared test kit for the submission-intent flow: a bound dispute that matches the standard case, the committed golden
 * analysis re-keyed to the server's input, and helpers that walk intent → approve → send through the API.
 */
import { readFileSync } from 'node:fs';
import { MemoryAnalysisStore, RateLimiter, analysisKey, type AnalysisInput, type CaseAnalysis } from '@resolvekit/analyst/node';
import type { Dispute } from '@resolvekit/paypal';
import { fakeModel } from '../../../packages/analyst/test/fake.ts';
import { AnalystService } from '../src/analysis.ts';
import { waitingDispute } from './fixtures.ts';

export const MODEL = 'gemini-3.8-flash';
export const STD_CAPTURE = '4FT237453Y5353014';

/** The waiting sandbox dispute, for exactly the standard case's order (7.00 USD) and its capture. */
export function standardDispute(over: Partial<Dispute> = {}): Dispute {
  const d = waitingDispute();
  return {
    ...d,
    dispute_amount: { currency_code: 'USD', value: '7.00' },
    disputed_transactions: [{ ...d.disputed_transactions![0]!, seller_transaction_id: STD_CAPTURE, gross_amount: { currency_code: 'USD', value: '7.00' } }],
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
