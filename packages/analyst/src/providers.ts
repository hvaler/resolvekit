/**
 * Providers over plain fetch (no SDK): Google Gemini API (generateContent with a JSON schema) and Groq's
 * OpenAI-compatible chat completions (json_schema response format). Keys come from the environment and are only
 * ever sent in the provider's auth header.
 */
import { ModelError, parseJson, retryableStatus, withFallback, withRetries, type AnalystModel, type JsonSchema, type ModelRequest, type ModelResponse } from './model.ts';

export const GEMINI_MODEL = 'gemini-3.8-flash';
export const GROQ_MODEL = 'openai/gpt-oss-120b';

interface ProviderOptions {
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Groq: tokens per minute of the account (free tier: 8,000). A request (prompt + max output) must fit in it. */
  tpm?: number;
}

function retryAfter(r: Response): number | null {
  const h = r.headers.get('retry-after');
  if (!h) return null;
  const s = Number(h);
  return Number.isFinite(s) ? s * 1000 : null;
}

/** POST JSON to a provider; failures become a ModelError carrying only the status and the provider's short code. */
export async function postJson(f: typeof fetch, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number, provider: string): Promise<{ json: any; ms: number }> {
  const t = Date.now();
  let r: Response;
  try {
    r = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new ModelError(timeout ? `${provider} timed out` : `${provider} unreachable`, { retryable: true });
  }
  if (!r.ok) {
    // The error body may echo the request; keep only the status and the provider's short status text.
    let code = '';
    try {
      const b = (await r.json()) as { error?: { status?: string; code?: string | number } };
      code = String(b.error?.status ?? b.error?.code ?? '');
    } catch {
      /* not JSON */
    }
    throw new ModelError(`${provider} answered ${r.status}${code ? ` ${code}` : ''}`, { status: r.status, retryable: retryableStatus(r.status), retryAfterMs: retryAfter(r) });
  }
  return { json: await r.json(), ms: Date.now() - t };
}

/** Gemini schemas: strip keys its JSON-schema subset does not take. */
export function geminiSchema(s: JsonSchema): JsonSchema {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) if (k !== 'additionalProperties') out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(s) as JsonSchema;
}

export class GeminiModel implements AnalystModel {
  readonly provider = 'gemini';
  readonly model: string;
  private readonly key: string;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;
  constructor(o: ProviderOptions) {
    this.key = o.apiKey;
    this.model = o.model ?? GEMINI_MODEL;
    this.fetch = o.fetch ?? ((...a) => globalThis.fetch(...a));
    this.timeoutMs = o.timeoutMs ?? 90_000;
  }
  async generate(req: ModelRequest): Promise<ModelResponse> {
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts: [{ text: req.user }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: geminiSchema(req.schema),
        maxOutputTokens: req.maxOutputTokens,
        temperature: 0,
        // Low thinking: the schema and the deterministic checks do the heavy lifting; thinking tokens are billed.
        thinkingConfig: { thinkingLevel: 'low' },
      },
    };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    const { json, ms } = await postJson(this.fetch, url, { 'x-goog-api-key': this.key }, body, this.timeoutMs, 'gemini');
    const cand = json?.candidates?.[0];
    const text = (cand?.content?.parts ?? []).filter((p: any) => typeof p.text === 'string' && !p.thought).map((p: any) => p.text).join('');
    if (!text) throw new ModelError(`gemini returned no text (${cand?.finishReason ?? json?.promptFeedback?.blockReason ?? 'unknown'})`, { retryable: true });
    if (cand?.finishReason === 'MAX_TOKENS') throw new ModelError('gemini hit max output tokens', { retryable: false });
    const u = json?.usageMetadata ?? {};
    return {
      json: parseJson(text),
      usage: {
        stage: req.stage,
        provider: this.provider,
        model: json?.modelVersion ?? this.model,
        inputTokens: u.promptTokenCount ?? 0,
        outputTokens: u.candidatesTokenCount ?? 0,
        thinkingTokens: u.thoughtsTokenCount ?? 0,
        ms,
      },
    };
  }
}

export class GroqModel implements AnalystModel {
  readonly provider = 'groq';
  readonly model: string;
  private readonly key: string;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly tpm: number;
  constructor(o: ProviderOptions) {
    this.key = o.apiKey;
    this.model = o.model ?? GROQ_MODEL;
    this.fetch = o.fetch ?? ((...a) => globalThis.fetch(...a));
    this.timeoutMs = o.timeoutMs ?? 90_000;
    this.tpm = o.tpm ?? 8_000;
  }
  async generate(req: ModelRequest): Promise<ModelResponse> {
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      response_format: { type: 'json_schema', json_schema: { name: req.stage.replace(/\W/g, '_'), strict: true, schema: req.schema } },
      // Reasoning tokens count against this limit; Groq refuses a request whose prompt + max output exceeds the
      // per-minute token budget, so the output cap is what the budget leaves after a rough prompt estimate.
      max_completion_tokens: Math.max(1024, Math.min(req.maxOutputTokens, this.tpm - 200 - Math.ceil((req.system.length + req.user.length + JSON.stringify(req.schema).length) / 3.2))),
      temperature: 0,
      reasoning_effort: 'low',
    };
    const { json, ms } = await postJson(this.fetch, 'https://api.groq.com/openai/v1/chat/completions', { authorization: `Bearer ${this.key}` }, body, this.timeoutMs, 'groq');
    const choice = json?.choices?.[0];
    const text: string = choice?.message?.content ?? '';
    if (!text) throw new ModelError(`groq returned no text (${choice?.finish_reason ?? 'unknown'})`, { retryable: true });
    if (choice?.finish_reason === 'length') throw new ModelError('groq hit max output tokens', { retryable: false });
    const u = json?.usage ?? {};
    const reasoning = u.completion_tokens_details?.reasoning_tokens ?? 0;
    return {
      json: parseJson(text),
      usage: {
        stage: req.stage,
        provider: this.provider,
        model: this.model,
        inputTokens: u.prompt_tokens ?? 0,
        outputTokens: Math.max(0, (u.completion_tokens ?? 0) - reasoning),
        thinkingTokens: reasoning,
        ms,
      },
    };
  }
}

export interface AnalystConfig {
  /** The model the cache key and the label name: the primary's. */
  model: AnalystModel;
  primary: { provider: string; model: string };
  /** Providers configured (keys present). */
  available: string[];
}

/**
 * Build the analyst model from the environment: ANALYST_PROVIDER=gemini|groq (default gemini) is the primary; the
 * other one, when its key is set, is the automatic fallback on errors and 429s. null when no key is set.
 */
export function modelFromEnv(env: Record<string, string | undefined>, o: { fetch?: typeof fetch; onFallback?: (why: string) => void; sleep?: (ms: number) => Promise<void> } = {}): AnalystConfig | null {
  const gemini = env.GEMINI_API_KEY ? new GeminiModel({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || GEMINI_MODEL, fetch: o.fetch }) : null;
  const groq = env.GROQ_API_KEY ? new GroqModel({ apiKey: env.GROQ_API_KEY, model: env.GROQ_MODEL || GROQ_MODEL, fetch: o.fetch, tpm: Number(env.GROQ_TPM) || 8_000 }) : null;
  const wantGroq = env.ANALYST_PROVIDER === 'groq';
  const first = wantGroq ? (groq ?? gemini) : (gemini ?? groq);
  const second = first === gemini ? groq : gemini;
  if (!first) return null;
  // Up to a minute between retries: Groq's free tier resets its token budget per minute (Retry-After says when).
  const retry = (m: AnalystModel) => withRetries(m, { retries: 2, maxDelayMs: 65_000, ...(o.sleep ? { sleep: o.sleep } : {}) });
  return {
    model: withFallback(retry(first), second ? retry(second) : null, o.onFallback),
    primary: { provider: first.provider, model: first.model },
    available: [gemini, groq].filter(Boolean).map((m) => m!.provider),
  };
}

/** One tiny call to one provider: resolves when it answered, throws its ModelError otherwise. */
export interface ModelProbe {
  /** "provider/model". */
  name: string;
  probe: () => Promise<void>;
}

const PROBE: ModelRequest = {
  stage: 'probe',
  system: 'You are a health check. Answer with the JSON object asked for, nothing else.',
  user: 'Return {"ok": true}.',
  schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  maxOutputTokens: 256,
};

/**
 * The operator's check (/api/ops/status?probe=models): each configured provider on its own, without retries or
 * fallback, so a broken fallback key shows up even while the primary answers.
 */
export function modelProbesFromEnv(env: Record<string, string | undefined>, o: { fetch?: typeof fetch; timeoutMs?: number } = {}): ModelProbe[] {
  // A short timeout of its own: a provider that hangs fails the check instead of holding the request for 90 s.
  const timeoutMs = o.timeoutMs ?? 20_000;
  const models: AnalystModel[] = [];
  if (env.GEMINI_API_KEY) models.push(new GeminiModel({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || GEMINI_MODEL, fetch: o.fetch, timeoutMs }));
  if (env.GROQ_API_KEY) models.push(new GroqModel({ apiKey: env.GROQ_API_KEY, model: env.GROQ_MODEL || GROQ_MODEL, fetch: o.fetch, timeoutMs, tpm: Number(env.GROQ_TPM) || 8_000 }));
  return models.map((m) => ({
    name: `${m.provider}/${m.model}`,
    probe: async () => {
      await m.generate(PROBE);
    },
  }));
}
