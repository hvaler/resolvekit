/**
 * Bindings: which real PayPal dispute a demo case stands for, and the check that it really is that payment.
 *
 * Configured as `{ "<web case id>": { "dispute": "PP-R-…", "capture": "<capture id>" } }` (bindings.json, or the
 * BINDINGS_JSON env in hosted mode; keys starting with "_" are comments). The old string form
 * `{ "<case id>": "PP-R-…" }` is still read, with no capture: then the dispute's disputed transaction must be the demo
 * case's own capture record (`summary.transactionId`), which a real sandbox payment never is, so a string binding
 * can be read and shown but cannot pass the check that guards sending. `npm run demo:prepare` emits the object form.
 *
 * {@link verifyBinding} is run on a fresh read right before an intent is composed and again right before it is sent
 * (apps/server/src/app.ts). It fails closed: the dispute must be the bound one, with exactly one disputed transaction
 * that is the expected capture, and the disputed amount (and the transaction's gross amount, when PayPal reports it)
 * in the case's currency and amount. Missing data is a failure, not a pass.
 */
import type { Dispute, PayPalClient } from '@resolvekit/paypal';
import { moneyText } from '../../web/src/domain/binding.ts';

export interface Binding {
  dispute: string;
  /** The PayPal capture the dispute must be about; null for a binding in the old string form. */
  capture: string | null;
}

/** What a bound case expects of its PayPal payment (from the demo case). */
export interface ExpectedPayment {
  value: string;
  currency: string;
  /** The demo case's own capture record: what a string binding (no capture) is compared with. */
  transactionId: string;
}

export type BindingState = 'verified' | 'invalid' | 'unavailable';

export interface BindingCheck {
  status: BindingState;
  /** Why it is not verified (empty when verified). */
  reasons: string[];
}

function cents(value: string | undefined): number | null {
  if (value == null || !/^\d+(\.\d{1,2})?$/.test(value)) return null;
  return Math.round(Number(value) * 100);
}

/** Whether the dispute just read is the payment this case is bound to. Pure; fails closed on missing data. */
export function verifyBinding(expected: ExpectedPayment, b: Binding, d: Dispute): BindingCheck {
  const reasons: string[] = [];
  if (d.dispute_id !== b.dispute) reasons.push(`PayPal returned dispute ${d.dispute_id ?? '(no id)'}, not the bound ${b.dispute}`);
  const amount = d.dispute_amount;
  if (!amount) reasons.push('PayPal reports no disputed amount');
  else if (amount.currency_code !== expected.currency) reasons.push(`the disputed amount is in ${amount.currency_code}; this case is in ${expected.currency}`);
  else if (cents(amount.value) == null || cents(amount.value) !== cents(expected.value)) {
    reasons.push(`the disputed amount is ${moneyText({ value: amount.value, currency: amount.currency_code })}; this case’s order is ${moneyText(expected)}`);
  }
  const txs = d.disputed_transactions ?? [];
  if (txs.length !== 1) reasons.push(`PayPal reports ${txs.length} disputed transactions; exactly one is expected`);
  const tx = txs[0];
  const capture = tx?.seller_transaction_id;
  const want = b.capture ?? expected.transactionId;
  if (!capture) reasons.push('PayPal reports no disputed capture');
  else if (capture !== want) {
    reasons.push(
      b.capture
        ? `the dispute is about capture ${capture}, not the bound capture ${b.capture}`
        : `the binding names no capture, and the dispute’s capture ${capture} is not this case’s ${expected.transactionId} (bind it as { "dispute": "${b.dispute}", "capture": "${capture}" } if that is the right payment)`,
    );
  }
  const gross = tx?.gross_amount;
  if (gross && (gross.currency_code !== expected.currency || cents(gross.value) !== cents(expected.value))) {
    reasons.push(`the disputed transaction is ${moneyText({ value: gross.value, currency: gross.currency_code })}; this case’s order is ${moneyText(expected)}`);
  }
  return { status: reasons.length ? 'invalid' : 'verified', reasons };
}

/**
 * Startup check: each bound dispute is read once (lazily, after the server is listening) and verified; the outcome is
 * logged. It never blocks startup and never sends anything; sending re-verifies on its own fresh read anyway.
 */
export async function checkBindings(opts: {
  paypal: Pick<PayPalClient, 'disputes'> | null;
  bindings: Readonly<Record<string, Binding>>;
  /** What each demo case expects, by case id. */
  cases: Readonly<Record<string, ExpectedPayment>>;
  log: (line: string) => void;
}): Promise<void> {
  const { paypal, bindings, cases, log } = opts;
  if (!paypal) return;
  await Promise.all(
    Object.entries(bindings).map(async ([caseId, b]) => {
      const expected = cases[caseId];
      const label = `binding ${caseId} → ${b.dispute}${b.capture ? ` (capture ${b.capture})` : ''}`;
      try {
        const d = await paypal.disputes.get(b.dispute);
        if (!expected) return log(`${label}: no demo case with this id (PayPal ${d.status ?? '?'})`);
        const c = verifyBinding(expected, b, d);
        if (c.status === 'verified') log(`${label}: verified (${moneyText(expected)}) · ${d.status ?? '?'}`);
        else log(`${label}: INVALID · ${c.reasons.join('; ')} · sending is blocked for this case`);
      } catch (e) {
        log(`${label}: could not read the dispute (${e instanceof Error ? e.message : String(e)}) · sending is blocked until it can be read`);
      }
    }),
  );
}

const CASE_ID = /^[A-Za-z0-9-]{1,64}$/;
const DISPUTE_ID = /^PP-[A-Z0-9-]{4,60}$/;
const CAPTURE_ID = /^[A-Z0-9]{8,32}$/;

/** A configured binding value (string or object) as a {@link Binding}, or null when it is not one. */
export function toBinding(v: unknown): Binding | null {
  if (typeof v === 'string') return DISPUTE_ID.test(v) ? { dispute: v, capture: null } : null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== 'dispute' && k !== 'capture')) return null;
  if (typeof o.dispute !== 'string' || !DISPUTE_ID.test(o.dispute)) return null;
  if (o.capture != null && (typeof o.capture !== 'string' || !CAPTURE_ID.test(o.capture))) return null;
  return { dispute: o.dispute, capture: typeof o.capture === 'string' ? o.capture : null };
}

/**
 * Bindings as configured: `{ "<case id>": { "dispute": "PP-…", "capture": "…" } }` or the old `"PP-…"` string; keys
 * starting with "_" are comments. Throws on anything else, so a bad binding stops the start instead of silently
 * pointing a case somewhere unexpected. Never read from a client.
 */
export function parseBindings(raw: unknown): Record<string, Binding> {
  return parseBindingPools(raw).bindings;
}

/** The active binding of each case, and the disputes in reserve behind it (first to be used first). */
export interface BindingPools {
  bindings: Record<string, Binding>;
  reserve: Record<string, Binding[]>;
}

/**
 * Like {@link parseBindings}, and a case may also map to a list `[{ dispute, capture }, …]`: a reserve of fresh
 * disputes for the same demo case. PayPal takes a seller's evidence once per dispute, so when the active one is used
 * the server moves the case to the next (app.ts). The first is active; a dispute may appear only once.
 */
export function parseBindingPools(raw: unknown): BindingPools {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('bindings must be a JSON object { "<case id>": { "dispute": "PP-…", "capture": "…" } }');
  const bindings: Record<string, Binding> = {};
  const reserve: Record<string, Binding[]> = {};
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    if (!CASE_ID.test(k)) throw new Error(`bindings: invalid case id ${JSON.stringify(k.slice(0, 80))}`);
    const list = Array.isArray(v) ? v : [v];
    if (list.length === 0) throw new Error(`bindings: ${k} must list at least one dispute`);
    const pool = list.map((x) => {
      const b = toBinding(x);
      if (!b) throw new Error(`bindings: ${k} must map to a PayPal dispute id (PP-…), { "dispute": "PP-…", "capture": "<capture id>" } or a list of them`);
      if (seen.has(b.dispute)) throw new Error(`bindings: dispute ${b.dispute} is listed twice`);
      seen.add(b.dispute);
      return b;
    });
    bindings[k] = pool[0]!;
    reserve[k] = pool.slice(1);
  }
  return { bindings, reserve };
}
