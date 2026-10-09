/**
 * The cache key of an analysis: sha256 of the canonical JSON of { input, promptVersion, model }. Same documents,
 * same prompt, same model → same key, in Node and in the browser (Web Crypto), so the web app can tell whether a
 * golden analysis was made from exactly the documents it shows.
 */
import { PROMPT_VERSION } from './prompts.ts';
import type { AnalysisInput } from './types.ts';

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function analysisKey(input: AnalysisInput, model: string, promptVersion: string = PROMPT_VERSION): Promise<string> {
  return sha256Hex(canonicalJson({ input, model, promptVersion }));
}
