/**
 * Function-calling adapters over plain fetch: Gemini generateContent (functionDeclarations, mode ANY) and Groq's
 * OpenAI-compatible chat completions (tools, tool_choice required). They make exactly one request per turn and
 * never retry: retries belong to the engine, so every attempt's tokens are counted. Keys are only ever sent in
 * the provider's auth header.
 */
import { GEMINI_MODEL, GROQ_MODEL, geminiSchema, postJson } from '@resolvekit/analyst/node';
import type { AgentModel, ModelCall, ModelTurn, TranscriptEntry, TurnRequest, Usage } from './types.ts';

interface AdapterOptions {
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const usage = (input: unknown, output: unknown): Usage =>
  typeof input === 'number' || typeof output === 'number'
    ? { inputTokens: typeof input === 'number' ? input : 0, outputTokens: typeof output === 'number' ? output : 0, reported: true }
    : { inputTokens: 0, outputTokens: 0, reported: false };

/** Gemini's functionResponse.response must be an object: anything else is wrapped as { result }. */
const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { result: v });

const asArgs = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function geminiContents(transcript: TranscriptEntry[]): unknown[] {
  return transcript.map((e) => {
    if (e.role === 'user') return { role: 'user', parts: [{ text: e.text }] };
    if (e.role === 'model') {
      // The thoughtSignature Gemini gave with this call goes back on the same part.
      const sig = (e.providerData as { thoughtSignature?: unknown } | undefined)?.thoughtSignature;
      return { role: 'model', parts: [{ functionCall: { name: e.call.name, args: e.call.arguments }, ...(typeof sig === 'string' ? { thoughtSignature: sig } : {}) }] };
    }
    return { role: 'user', parts: [{ functionResponse: { name: e.name, response: asObject(e.result) } }] };
  });
}

export class GeminiAgentModel implements AgentModel {
  readonly provider = 'gemini';
  readonly model: string;
  private readonly key: string;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;
  constructor(o: AdapterOptions) {
    this.key = o.apiKey;
    this.model = o.model ?? GEMINI_MODEL;
    this.fetch = o.fetch ?? ((...a) => globalThis.fetch(...a));
    this.timeoutMs = o.timeoutMs ?? 30_000;
  }
  async turn(req: TurnRequest): Promise<ModelTurn> {
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: geminiContents(req.transcript),
      tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) })) }],
      toolConfig: { functionCallingConfig: { mode: 'ANY' } },
      generationConfig: { temperature: 0, maxOutputTokens: req.maxOutputTokens },
    };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    const { json } = await postJson(this.fetch, url, { 'x-goog-api-key': this.key }, body, this.timeoutMs, 'gemini');
    const parts: any[] = json?.candidates?.[0]?.content?.parts ?? [];
    const calls: ModelCall[] = parts
      .filter((p) => p?.functionCall && typeof p.functionCall.name === 'string')
      .map((p) => ({
        name: p.functionCall.name,
        arguments: asArgs(p.functionCall.args),
        ...(typeof p.thoughtSignature === 'string' ? { providerData: { thoughtSignature: p.thoughtSignature } } : {}),
      }));
    const text = parts.filter((p) => typeof p?.text === 'string' && !p.thought).map((p) => p.text).join('');
    const u = json?.usageMetadata;
    return { calls, text: text || null, usage: usage(u?.promptTokenCount, u?.candidatesTokenCount) };
  }
}

/**
 * Groq's arguments arrive as a JSON string. Unparseable (or non-object) arguments are kept raw under __unparsed,
 * so the call still reaches the engine and its schema validation rejects it.
 */
function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return asArgs(raw);
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch {
    /* fall through */
  }
  return { __unparsed: raw };
}

function groqMessages(system: string, transcript: TranscriptEntry[]): unknown[] {
  const messages: unknown[] = [{ role: 'system', content: system }];
  // Stable ids: a model entry at transcript index i is call_<i>; its tool result answers the latest model entry.
  let lastCall: string | null = null;
  transcript.forEach((e, i) => {
    if (e.role === 'user') messages.push({ role: 'user', content: e.text });
    else if (e.role === 'model') {
      lastCall = `call_${i}`;
      messages.push({ role: 'assistant', content: null, tool_calls: [{ id: lastCall, type: 'function', function: { name: e.call.name, arguments: JSON.stringify(e.call.arguments) } }] });
    } else {
      if (!lastCall) throw new Error(`transcript entry ${i}: a tool result without a model call before it`);
      messages.push({ role: 'tool', tool_call_id: lastCall, content: JSON.stringify(e.result) });
    }
  });
  return messages;
}

export class GroqAgentModel implements AgentModel {
  readonly provider = 'groq';
  readonly model: string;
  private readonly key: string;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;
  constructor(o: AdapterOptions) {
    this.key = o.apiKey;
    this.model = o.model ?? GROQ_MODEL;
    this.fetch = o.fetch ?? ((...a) => globalThis.fetch(...a));
    this.timeoutMs = o.timeoutMs ?? 30_000;
  }
  async turn(req: TurnRequest): Promise<ModelTurn> {
    const body = {
      model: this.model,
      messages: groqMessages(req.system, req.transcript),
      tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
      tool_choice: 'required',
      parallel_tool_calls: false,
      max_completion_tokens: req.maxOutputTokens,
      temperature: 0,
      reasoning_effort: 'low',
    };
    const { json } = await postJson(this.fetch, 'https://api.groq.com/openai/v1/chat/completions', { authorization: `Bearer ${this.key}` }, body, this.timeoutMs, 'groq');
    const message = json?.choices?.[0]?.message;
    const calls: ModelCall[] = (message?.tool_calls ?? [])
      .filter((c: any) => typeof c?.function?.name === 'string')
      .map((c: any) => ({ name: c.function.name, arguments: parseArgs(c.function.arguments) }));
    const text = typeof message?.content === 'string' && message.content ? message.content : null;
    const u = json?.usage;
    return { calls, text, usage: usage(u?.prompt_tokens, u?.completion_tokens) };
  }
}

/**
 * The agent's models from the environment, like the analyst's modelFromEnv: ANALYST_PROVIDER=gemini|groq (default
 * gemini) is the primary, the other one (when its key is set) the fallback. AGENT_GEMINI_MODEL / AGENT_GROQ_MODEL
 * pick the models. No retry or fallback wrapper: the engine decides both. null when no key is set.
 */
export function agentModelsFromEnv(env: Record<string, string | undefined>, o: { fetch?: typeof fetch } = {}): { primary: AgentModel; fallback: AgentModel | null } | null {
  const gemini = env.GEMINI_API_KEY ? new GeminiAgentModel({ apiKey: env.GEMINI_API_KEY, model: env.AGENT_GEMINI_MODEL || GEMINI_MODEL, fetch: o.fetch }) : null;
  const groq = env.GROQ_API_KEY ? new GroqAgentModel({ apiKey: env.GROQ_API_KEY, model: env.AGENT_GROQ_MODEL || GROQ_MODEL, fetch: o.fetch }) : null;
  const first = env.ANALYST_PROVIDER === 'groq' ? (groq ?? gemini) : (gemini ?? groq);
  if (!first) return null;
  return { primary: first, fallback: first === gemini ? groq : gemini };
}
