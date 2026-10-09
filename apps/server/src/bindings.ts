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
