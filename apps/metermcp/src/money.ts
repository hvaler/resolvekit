/** Money as integer cents: prices, reservations and totals never go through floating point. */

export function toCents(value: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error(`Not a money amount: ${value}`);
  const [whole, frac = ''] = value.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/** 137 → "1.37" */
export function fromCents(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`Not a cent amount: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
