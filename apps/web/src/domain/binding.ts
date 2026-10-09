/**
 * A demo case bound to a real PayPal dispute keeps its own merchant-side records (order, capture document,
 * tracking, draft). If the bound dispute is for a different amount, the screen would mix two payments, so the
 * mismatch is said out loud: in the case header for the demo operator, and in the server log at startup.
 * Shared by the web app and apps/server.
 */

export interface Money {
  value: string;
  currency: string;
}

function cents(value: string): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** "1.37 USD" */
export function moneyText(m: Money): string {
  const c = cents(m.value);
  return `${c == null ? m.value : (c / 100).toFixed(2)} ${m.currency}`;
}

/**
 * The warning to show when the bound PayPal dispute's amount differs from the demo case's order amount, or null
 * when they agree (or PayPal reports no amount, which is reported elsewhere as missing data).
 */
export function bindingMismatch(paypal: Money | null | undefined, caseOrder: Money, disputeId?: string): string | null {
  if (!paypal) return null;
  const a = cents(paypal.value);
  const b = cents(caseOrder.value);
  if (a != null && a === b && paypal.currency === caseOrder.currency) return null;
  const who = disputeId ? `Bound PayPal dispute ${disputeId}` : 'Bound PayPal dispute';
  return `${who} is ${moneyText(paypal)}; this demo case’s order is ${moneyText(caseOrder)}`;
}
