/**
 * The model behind the analyst, behind one small interface so the pipeline, the tests (fake model) and the
 * providers (Gemini primary, Groq fallback) are interchangeable. Every call asks for JSON matching a schema.
 * Logs carry token counts and timings only, never prompt or document contents.
 */
import type { CallUsage } from './types.ts';

export type JsonSchema = Record<string, unknown>;

export interface ModelRequest {
  /** Pipeline stage, for usage logs. */
  stage: string;
  system: string;
  user: string;
  schema: JsonSchema;
  maxOutputTokens: number;
}

export interface ModelResponse {
  json: unknown;
  usage: CallUsage;
}

export interface AnalystModel {
  readonly provider: string;
  readonly model: string;
  generate(req: ModelRequest): Promise<ModelResponse>;
}

export class ModelError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  constructor(message: string, o: { status?: number | null; retryable?: boolean; retryAfterMs?: number | null } = {}) {
    super(message);
    this.name = 'ModelError';
    this.status = o.status ?? null;
    this.retryable = o.retryable ?? false;
    this.retryAfterMs = o.retryAfterMs ?? null;
  }
}

/** HTTP status → whether trying again (same provider) can help. */
export const retryableStatus = (s: number) => s === 408 || s === 429 || s >= 500;

export function parseJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(t);
  } catch {
    throw new ModelError('The model did not return valid JSON', { retryable: true });
  }
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retry retryable errors with exponential backoff (or the provider's Retry-After, capped). */
export function withRetries(m: AnalystModel, o: RetryOptions = {}): AnalystModel {
  const retries = o.retries ?? 2;
  const base = o.baseDelayMs ?? 1500;
  const max = o.maxDelayMs ?? 30_000;
  const sleep = o.sleep ?? realSleep;
  return {
    provider: m.provider,
    model: m.model,
    async generate(req) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await m.generate(req);
        } catch (e) {
          const err = e instanceof ModelError ? e : new ModelError(e instanceof Error ? e.message : String(e), { retryable: true });
          if (!err.retryable || attempt >= retries) throw err;
          await sleep(Math.min(max, err.retryAfterMs ?? base * 3 ** attempt));
        }
      }
    },
  };
}

/**
 * Primary first; when it fails (after its own retries), the fallback answers. The usage record says which one did.
 * `onFallback` is told why (status only, no contents).
 */
export function withFallback(primary: AnalystModel, fallback: AnalystModel | null, onFallback?: (why: string) => void): AnalystModel {
  if (!fallback) return primary;
  return {
    provider: primary.provider,
    model: primary.model,
    async generate(req) {
      try {
        return await primary.generate(req);
      } catch (e) {
        const why = e instanceof ModelError ? `${primary.provider} ${e.status ?? ''} ${e.message}`.replace(/\s+/g, ' ') : `${primary.provider} failed`;
        onFallback?.(why);
        return fallback.generate(req);
      }
    },
  };
}
