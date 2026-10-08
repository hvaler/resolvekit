import type { ReceiptCall } from './types';

/** Total of the calls that completed (failed calls are not charged), computed in cents. */
export function chargedTotal(calls: readonly ReceiptCall[]): { total: string; parts: string[] } {
  const ok = calls.filter((c) => c.ok);
  const cents = ok.reduce((n, c) => n + Math.round(Number.parseFloat(c.price) * 100), 0);
  return { total: (cents / 100).toFixed(2), parts: ok.map((c) => c.price) };
}
