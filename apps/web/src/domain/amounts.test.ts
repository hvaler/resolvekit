import { describe, expect, it } from 'vitest';
import { CURRENCY_EXPONENT, formatMoney, minorUnits, parseAmount } from './amounts';

describe('exact amounts [A3]', () => {
  it('canonical amounts', () => {
    expect(parseAmount('7', 'USD')).toMatchObject({ ok: true, value: '7.00', minor: 700n });
    expect(parseAmount('7.5', 'USD')).toMatchObject({ ok: true, value: '7.50' });
    expect(parseAmount('07.00', 'USD')).toMatchObject({ ok: true, value: '7.00' });
    expect(parseAmount('700', 'JPY')).toMatchObject({ ok: true, value: '700', minor: 700n });
    for (const bad of ['7,00', '7.001', '-1', '1e2', ' 7', '7 ', '+7', '0', '0.00', '', '.5', '7.']) expect(parseAmount(bad, 'USD')).toMatchObject({ ok: false, error: 'INVALID_AMOUNT' });
    expect(parseAmount('7.5', 'JPY')).toMatchObject({ ok: false, error: 'INVALID_AMOUNT' });
    expect(parseAmount('7', 'XYZ')).toMatchObject({ ok: false, error: 'UNKNOWN_CURRENCY' });
  });

  it('keeps exact values beyond float precision and small values above zero', () => {
    expect(parseAmount('0.01', 'EUR')).toEqual({ ok: true, value: '0.01', minor: 1n });
    expect(parseAmount('0007', 'GBP')).toEqual({ ok: true, value: '7.00', minor: 700n });
    expect(parseAmount('900719925474099.31', 'USD')).toEqual({ ok: true, value: '900719925474099.31', minor: 90071992547409931n });
    expect(parseAmount('٧', 'USD')).toMatchObject({ ok: false, error: 'INVALID_AMOUNT' });
  });

  it('the whole part has at most 15 digits (leading zeros not counted)', () => {
    expect(parseAmount('999999999999999.99', 'USD')).toEqual({ ok: true, value: '999999999999999.99', minor: 99999999999999999n });
    expect(parseAmount('000999999999999999', 'JPY')).toMatchObject({ ok: true, value: '999999999999999' });
    expect(parseAmount('1000000000000000', 'USD')).toMatchObject({ ok: false, error: 'INVALID_AMOUNT' });
    expect(parseAmount('9'.repeat(10_000), 'JPY')).toMatchObject({ ok: false, error: 'INVALID_AMOUNT' });
    expect(() => minorUnits('1'.repeat(16), 'USD')).toThrow();
  });

  it('says what is wrong in words', () => {
    expect(parseAmount('7', 'XYZ')).toMatchObject({ detail: 'Unknown currency XYZ: ResolveKit cannot check amounts in it' });
    expect(parseAmount('7,00', 'USD')).toMatchObject({ detail: 'Type the amount as digits with at most 2 decimals and a dot, e.g. 7.50' });
    expect(parseAmount('7.5', 'JPY')).toMatchObject({ detail: 'Type a whole amount, e.g. 700' });
    expect(parseAmount('0.00', 'USD')).toMatchObject({ detail: 'The amount must be more than 0' });
    // Not a currency because an object has the key.
    expect(parseAmount('7', 'constructor')).toMatchObject({ ok: false, error: 'UNKNOWN_CURRENCY' });
  });

  it('exponents come from the table', () => {
    expect(CURRENCY_EXPONENT).toEqual({ USD: 2, EUR: 2, GBP: 2, CAD: 2, AUD: 2, JPY: 0 });
  });

  it('minor units and display', () => {
    expect(minorUnits('7.5', 'USD')).toBe(750n);
    expect(minorUnits('0.00', 'USD')).toBe(0n);
    expect(minorUnits('1200', 'JPY')).toBe(1200n);
    expect(() => minorUnits('7,5', 'USD')).toThrow();
    expect(() => minorUnits('7', 'XYZ')).toThrow();
    expect(formatMoney({ value: '7.00', currency: 'USD' })).toBe('7.00 USD');
    expect(formatMoney({ value: '7', currency: 'USD' })).toBe('7.00 USD');
    expect(formatMoney({ value: '700', currency: 'JPY' })).toBe('700 JPY');
  });
});
