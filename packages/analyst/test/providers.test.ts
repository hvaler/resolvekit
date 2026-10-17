import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelError, withFallback, withRetries, type AnalystModel, type ModelRequest } from '../src/model.ts';
import { GeminiModel, GroqModel, modelFromEnv, modelProbesFromEnv } from '../src/providers.ts';

const req: ModelRequest = { stage: 'extract', system: 'sys', user: 'secret document text', schema: { type: 'object', additionalProperties: false, properties: {} }, maxOutputTokens: 100 };
const noSleep = async () => {};

function scripted(answers: Array<() => unknown>, provider = 'p'): AnalystModel & { calls: number } {
  const m = {
    provider,
    model: `${provider}-m`,
    calls: 0,
    async generate() {
      const f = answers[Math.min(m.calls, answers.length - 1)]!;
      m.calls++;
      return { json: f(), usage: { stage: 'x', provider, model: `${provider}-m`, inputTokens: 1, outputTokens: 1, thinkingTokens: 0, ms: 1 } };
    },
  };
  return m;
}

test('retries: retryable errors are retried with backoff, then succeed; non-retryable fail at once', async () => {
  const flaky = scripted([
    () => {
      throw new ModelError('429', { status: 429, retryable: true });
    },
    () => ({ ok: true }),
  ]);
  const delays: number[] = [];
  const r = await withRetries(flaky, { retries: 2, baseDelayMs: 10, sleep: async (ms) => void delays.push(ms) }).generate(req);
  assert.deepEqual(r.json, { ok: true });
  assert.equal(flaky.calls, 2);
  assert.deepEqual(delays, [10]);

  const bad = scripted([
    () => {
      throw new ModelError('400', { status: 400, retryable: false });
    },
  ]);
  await assert.rejects(withRetries(bad, { sleep: noSleep }).generate(req), /400/);
  assert.equal(bad.calls, 1);
});

test('fallback: when the primary fails (after its retries) the fallback answers, and says so', async () => {
  const primary = withRetries(
    scripted(
      [
        () => {
          throw new ModelError('gemini answered 503', { status: 503, retryable: true });
        },
      ],
      'gemini',
    ),
    { retries: 1, sleep: noSleep },
  );
  const fallback = scripted([() => ({ from: 'groq' })], 'groq');
  const why: string[] = [];
  const r = await withFallback(primary, fallback, (w) => why.push(w)).generate(req);
  assert.deepEqual(r.json, { from: 'groq' });
  assert.equal(r.usage.provider, 'groq');
  assert.match(why[0]!, /gemini/);
});

test('modelFromEnv: gemini primary by default, groq fallback; ANALYST_PROVIDER=groq swaps; no keys → null', () => {
  assert.equal(modelFromEnv({}), null);
  const both = modelFromEnv({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' })!;
  assert.deepEqual(both.primary, { provider: 'gemini', model: 'gemini-3.8-flash' });
  assert.deepEqual(both.available, ['gemini', 'groq']);
  assert.deepEqual(modelFromEnv({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', ANALYST_PROVIDER: 'groq' })!.primary, { provider: 'groq', model: 'openai/gpt-oss-120b' });
  assert.deepEqual(modelFromEnv({ GROQ_API_KEY: 'q' })!.primary.provider, 'groq');
});

test('gemini: JSON schema request with low thinking, key only in the header; usage parsed', async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fetch = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"facts":[]}' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3 },
        modelVersion: 'gemini-3.8-flash',
      }),
      { status: 200 },
    );
  }) as unknown as typeof globalThis.fetch;
  const r = await new GeminiModel({ apiKey: 'KEY123', fetch }).generate(req);
  assert.deepEqual(r.json, { facts: [] });
  assert.deepEqual([r.usage.inputTokens, r.usage.outputTokens, r.usage.thinkingTokens], [10, 5, 3]);
  const s = seen!;
  assert.ok(!s.url.includes('KEY123'));
  assert.equal((s.init.headers as Record<string, string>)['x-goog-api-key'], 'KEY123');
  const body = JSON.parse(String(s.init.body));
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'low');
  assert.equal(body.generationConfig.responseJsonSchema.additionalProperties, undefined);
});

test('providers: HTTP errors become ModelError without the provider body; 429 is retryable with Retry-After', async () => {
  const fetch = (async () =>
    new Response(JSON.stringify({ error: { code: 429, message: 'quota … secret document text …', status: 'RESOURCE_EXHAUSTED' } }), {
      status: 429,
      headers: { 'retry-after': '7' },
    })) as unknown as typeof globalThis.fetch;
  const err = await new GroqModel({ apiKey: 'k', fetch }).generate(req).catch((e: unknown) => e);
  assert.ok(err instanceof ModelError);
  assert.equal(err.status, 429);
  assert.equal(err.retryable, true);
  assert.equal(err.retryAfterMs, 7000);
  assert.ok(!err.message.includes('secret'));
});

test('probes: one per provider with a key, each its own provider (no fallback hides a broken key)', async () => {
  const hosts: string[] = [];
  const fetch = (async (url: string | URL) => {
    const u = new URL(String(url));
    hosts.push(u.host);
    if (u.host === 'api.groq.com') return new Response(JSON.stringify({ error: { code: 'invalid_api_key', message: 'Invalid API Key' } }), { status: 401 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const probes = modelProbesFromEnv({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' }, { fetch });
  assert.deepEqual(probes.map((p) => p.name), ['gemini/gemini-3.8-flash', 'groq/openai/gpt-oss-120b']);
  await probes[0]!.probe();
  const err = await probes[1]!.probe().catch((e: unknown) => e);
  assert.ok(err instanceof ModelError);
  assert.equal(err.status, 401);
  assert.deepEqual(hosts, ['generativelanguage.googleapis.com', 'api.groq.com']);
});

test('probes: none without keys', () => {
  assert.deepEqual(modelProbesFromEnv({}), []);
});

test('probes: a provider that does not answer fails within the probe timeout', async () => {
  const fetch = ((_: unknown, init: RequestInit = {}) =>
    new Promise((_, no) => init.signal?.addEventListener('abort', () => no(new DOMException('timed out', 'TimeoutError'))))) as unknown as typeof globalThis.fetch;
  const [p] = modelProbesFromEnv({ GEMINI_API_KEY: 'g' }, { fetch, timeoutMs: 50 });
  const t = Date.now();
  await assert.rejects(p!.probe());
  assert.ok(Date.now() - t < 2000);
});
