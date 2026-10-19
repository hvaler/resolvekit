/**
 * Exact amounts [A3]: decimal strings in a currency's canonical form, never floats. The number of decimals (the
 * minor-unit exponent) comes from a table; a currency outside it is refused, since ResolveKit cannot check its amounts.
 * Amounts are compared as integer minor units (`BigInt` on the digits).
 */
import type { Money } from './actions.ts';

/** Minor-unit exponent by ISO currency code. */
export const CURRENCY_EXPONENT: Readonly<Record<string, number>> = { USD: 2, EUR: 2, GBP: 2, CAD: 2, AUD: 2, JPY: 0 };

/** At most this many digits before the decimal point (leading zeros not counted). */
const MAX_WHOLE_DIGITS = 15;

export type AmountResult = { ok: true; value: string; minor: bigint } | { ok: false; error: 'UNKNOWN_CURRENCY' | 'INVALID_AMOUNT'; detail: string };

const exponentOf = (currency: string): number | null => (Object.hasOwn(CURRENCY_EXPONENT, currency) ? CURRENCY_EXPONENT[currency]! : null);

/** The canonical form and minor units of an amount that matches `^\d+(\.\d{1,e})?$`, zero included. */
function canonical(input: string, currency: string): AmountResult {
  const e = exponentOf(currency);
  if (e === null) return { ok: false, error: 'UNKNOWN_CURRENCY', detail: `Unknown currency ${currency}: ResolveKit cannot check amounts in it` };
  const m = (e === 0 ? /^(\d+)$/ : new RegExp(`^(\\d+)(?:\\.(\\d{1,${e}}))?$`)).exec(input);
  if (!m) {
    const detail = e === 0 ? 'Type a whole amount, e.g. 700' : `Type the amount as digits with at most ${e} decimals and a dot, e.g. 7.50`;
    return { ok: false, error: 'INVALID_AMOUNT', detail };
  }
  const whole = m[1]!.replace(/^0+(?=\d)/, '');
  if (whole.length > MAX_WHOLE_DIGITS) return { ok: false, error: 'INVALID_AMOUNT', detail: `The amount must have at most ${MAX_WHOLE_DIGITS} digits before the decimal point` };
  const fraction = (m[2] ?? '').padEnd(e, '0');
  return { ok: true, value: e === 0 ? whole : `${whole}.${fraction}`, minor: BigInt(whole + fraction) };
}

/** Parse an amount typed or sent for `currency`: canonical (`7` → `7.00`, `07.00` → `7.00`) and more than 0. */
export function parseAmount(input: string, currency: string): AmountResult {
  const r = canonical(input, currency);
  if (r.ok && r.minor <= 0n) return { ok: false, error: 'INVALID_AMOUNT', detail: 'The amount must be more than 0' };
  return r;
}

/** An amount in integer minor units (`7.5` USD → 750n; zero allowed). Throws on an amount that is not exact. */
export function minorUnits(value: string, currency: string): bigint {
  const r = canonical(value, currency);
  if (!r.ok) throw new Error(r.detail);
  return r.minor;
}

/** `7.00 USD`: the canonical value when it has one, otherwise the value as given. */
export function formatMoney(m: Money): string {
  const r = canonical(m.value, m.currency);
  return `${r.ok ? r.value : m.value} ${m.currency}`;
}
