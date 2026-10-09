/**
 * Startup check of apps/server/bindings.json: each bound PayPal dispute is read once (lazily, after the server is
 * listening) and its amount compared with the demo case's own order. A mismatch is logged so a wrong binding cannot
 * slip into a recording unnoticed; it never blocks startup and never sends anything to PayPal.
 */
import type { PayPalClient } from '@resolvekit/paypal';
import { bindingMismatch, moneyText, type Money } from '../../web/src/domain/binding.ts';

export async function checkBindings(opts: {
  paypal: Pick<PayPalClient, 'disputes'> | null;
  bindings: Readonly<Record<string, string>>;
  /** Order amount of each demo case, by case id. */
  caseOrders: Readonly<Record<string, Money>>;
  log: (line: string) => void;
}): Promise<void> {
  const { paypal, bindings, caseOrders, log } = opts;
  if (!paypal) return;
  await Promise.all(
    Object.entries(bindings).map(async ([caseId, disputeId]) => {
      const order = caseOrders[caseId];
      try {
        const d = await paypal.disputes.get(disputeId);
        const amount = d.dispute_amount ? { value: d.dispute_amount.value, currency: d.dispute_amount.currency_code } : null;
        if (!order) {
          log(`binding ${caseId} → ${disputeId}: no demo case with this id (PayPal ${d.status ?? '?'}${amount ? ` · ${moneyText(amount)}` : ''})`);
          return;
        }
        const warning = bindingMismatch(amount, order, disputeId);
        if (warning) log(`binding ${caseId} → ${disputeId}: MISMATCH · ${warning}`);
        else if (!amount) log(`binding ${caseId} → ${disputeId}: PayPal reports no amount · ${d.status ?? '?'}`);
        else log(`binding ${caseId} → ${disputeId}: amount matches (${moneyText(amount)}) · ${d.status ?? '?'}`);
      } catch (e) {
        log(`binding ${caseId} → ${disputeId}: could not read the dispute (${e instanceof Error ? e.message : String(e)})`);
      }
    }),
  );
}

const CASE_ID = /^[A-Za-z0-9-]{1,64}$/;
const DISPUTE_ID = /^PP-[A-Z0-9-]{4,60}$/;

/**
 * Bindings as configured (bindings.json, or the BINDINGS_JSON env in hosted mode): `{ "<web case id>": "<PayPal
 * dispute id>" }`; keys starting with "_" are comments. Throws on anything else, so a bad binding stops the start
 * instead of silently pointing a case somewhere unexpected. Never read from a client.
 */
export function parseBindings(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('bindings must be a JSON object { "<case id>": "<PayPal dispute id>" }');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    if (!CASE_ID.test(k)) throw new Error(`bindings: invalid case id ${JSON.stringify(k.slice(0, 80))}`);
    if (typeof v !== 'string' || !DISPUTE_ID.test(v)) throw new Error(`bindings: ${k} must map to a PayPal dispute id (PP-…)`);
    out[k] = v;
  }
  return out;
}
