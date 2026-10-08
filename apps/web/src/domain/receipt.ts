import type { ReceiptCall } from './types';

/** Total of the calls that completed (failed calls are not charged), computed in cents. */
export function chargedTotal(calls: readonly ReceiptCall[]): { total: string; parts: string[] } {
  const ok = calls.filter((c) => c.ok);
  const cents = ok.reduce((n, c) => n + Math.round(Number.parseFloat(c.price) * 100), 0);
  return { total: (cents / 100).toFixed(2), parts: ok.map((c) => c.price) };
}

/** The pinned total row of the receipt: "Total charged · 3 OK calls · 1.37 of 5.00 USD approved". */
export function receiptTotal(calls: readonly ReceiptCall[], currency: string, cap?: string): { label: string; total: string; ofCap: string } {
  const { total, parts } = chargedTotal(calls);
  return {
    label: `Total charged · ${parts.length} OK ${parts.length === 1 ? 'call' : 'calls'}`,
    total,
    ofCap: cap ? `of ${cap} ${currency} approved` : currency,
  };
}
