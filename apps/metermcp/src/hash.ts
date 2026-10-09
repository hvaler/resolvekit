import { createHash } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted at every level, no whitespace, `undefined` members dropped. The same value
 * always gives the same text, so its hash is stable whatever order the client sent the arguments in.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('Non-finite number');
    return JSON.stringify(v) ?? 'null';
  }
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(',')}}`;
}

export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The request hash of a paid call: sha256 of canonical {session, n, tool, args}. */
export function requestHash(session: string, n: number, tool: string, args: unknown): string {
  return sha256(canonicalJson({ session, n, tool, args }));
}
