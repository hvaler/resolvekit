import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelError } from '@resolvekit/analyst/node';
import { GeminiAgentModel, GroqAgentModel, agentModelsFromEnv, estimateTokens, type TurnRequest } from '../src/index.ts';

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** A fetch that records every request and answers with the next canned response. */
function fakeFetch(answers: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>) {
  const requests: Recorded[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) }, body: JSON.parse(String(init?.body)) });
    const a = answers[Math.min(requests.length - 1, answers.length - 1)]!;
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json', ...a.headers } });
  }) as typeof fetch;
  return { f, requests };
}

const quote = { name: 'quote_dispute_pack', description: 'Price a dispute pack.', parameters: { type: 'object', additionalProperties: false, properties: { pages: { type: 'integer' } }, required: ['pages'] } };
const req: TurnRequest = { system: 'You buy evidence.', transcript: [{ role: 'user', text: 'Prepare the pack.' }], tools: [quote], maxOutputTokens: 512 };

test('Gemini turn sends function declarations with mode ANY and returns the function call and reported usage', async () => {
  const { f, requests } = fakeFetch([
    {
      body: {
        candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'quote_dispute_pack', args: { pages: 3 } } }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 15, thoughtsTokenCount: 40 },
      },
    },
  ]);
  const m = new GeminiAgentModel({ apiKey: 'gk-secret', fetch: f });
  const turn = await m.turn(req);
  assert.deepEqual(turn.calls, [{ name: 'quote_dispute_pack', arguments: { pages: 3 } }]);
  assert.equal(turn.text, null);
  // Thinking tokens are billed as output: 15 + 40.
  assert.deepEqual(turn.usage, { inputTokens: 120, outputTokens: 55, reported: true });

  const body = requests[0]!.body;
  assert.match(requests[0]!.url, /generateContent$/);
  assert.equal(requests[0]!.headers['x-goog-api-key'], 'gk-secret');
  assert.deepEqual(body.toolConfig, { functionCallingConfig: { mode: 'ANY' } });
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'You buy evidence.' }] });
  assert.deepEqual(body.generationConfig, { temperature: 0, maxOutputTokens: 512, thinkingConfig: { thinkingLevel: 'low' } });
  // Gemini's schema subset: additionalProperties is stripped from the declared parameters.
  assert.deepEqual(body.tools, [{ functionDeclarations: [{ name: 'quote_dispute_pack', description: 'Price a dispute pack.', parameters: { type: 'object', properties: { pages: { type: 'integer' } }, required: ['pages'] } }] }]);
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'Prepare the pack.' }] }]);
});

test('Gemini transcript maps model calls to functionCall parts and tool results to functionResponse parts', async () => {
  const { f, requests } = fakeFetch([{ body: { candidates: [{ content: { parts: [{ text: 'Done.' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } } }]);
  const m = new GeminiAgentModel({ apiKey: 'k', fetch: f });
  await m.turn({
    ...req,
    transcript: [
      { role: 'user', text: 'Prepare the pack.' },
      { role: 'model', call: { name: 'quote_dispute_pack', arguments: { pages: 3 } }, providerData: { thoughtSignature: 'sig-1' } },
      { role: 'tool', name: 'quote_dispute_pack', result: { priceUsd: '0.30' } },
      { role: 'model', call: { name: 'quote_dispute_pack', arguments: { pages: 4 } } },
      { role: 'tool', name: 'quote_dispute_pack', result: 'plain text' },
    ],
  });
  assert.deepEqual(requests[0]!.body.contents, [
    { role: 'user', parts: [{ text: 'Prepare the pack.' }] },
    { role: 'model', parts: [{ functionCall: { name: 'quote_dispute_pack', args: { pages: 3 } }, thoughtSignature: 'sig-1' }] },
    { role: 'user', parts: [{ functionResponse: { name: 'quote_dispute_pack', response: { priceUsd: '0.30' } } }] },
    { role: 'model', parts: [{ functionCall: { name: 'quote_dispute_pack', args: { pages: 4 } } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'quote_dispute_pack', response: { result: 'plain text' } } }] },
  ]);
});

test('Gemini turn keeps the thoughtSignature of a call as providerData so it can be sent back', async () => {
  const { f } = fakeFetch([{ body: { candidates: [{ content: { parts: [{ functionCall: { name: 'quote_dispute_pack', args: { pages: 1 } }, thoughtSignature: 'sig-9' }] } }] } }]);
  const turn = await new GeminiAgentModel({ apiKey: 'k', fetch: f }).turn(req);
  assert.deepEqual(turn.calls, [{ name: 'quote_dispute_pack', arguments: { pages: 1 }, providerData: { thoughtSignature: 'sig-9' } }]);
});

test('Groq turn sends tools with tool_choice required and parallel_tool_calls false and returns every tool call it got', async () => {
  const { f, requests } = fakeFetch([
    {
      body: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'x1', type: 'function', function: { name: 'quote_dispute_pack', arguments: '{"pages":2}' } },
                { id: 'x2', type: 'function', function: { name: 'quote_dispute_pack', arguments: 'not json' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 200, completion_tokens: 30 },
      },
    },
  ]);
  const m = new GroqAgentModel({ apiKey: 'gq-secret', fetch: f });
  const turn = await m.turn({
    ...req,
    transcript: [
      { role: 'user', text: 'Prepare the pack.' },
      { role: 'model', call: { name: 'quote_dispute_pack', arguments: { pages: 3 } } },
      { role: 'tool', name: 'quote_dispute_pack', result: { priceUsd: '0.30' } },
    ],
  });
  assert.equal(turn.calls.length, 2);
  assert.deepEqual(turn.calls[0], { name: 'quote_dispute_pack', arguments: { pages: 2 } });
  // Unparseable arguments are kept raw so the engine's schema validation rejects the call.
  assert.deepEqual(turn.calls[1], { name: 'quote_dispute_pack', arguments: { __unparsed: 'not json' } });
  assert.deepEqual(turn.usage, { inputTokens: 200, outputTokens: 30, reported: true });

  const body = requests[0]!.body;
  assert.equal(requests[0]!.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(requests[0]!.headers.authorization, 'Bearer gq-secret');
  assert.equal(body.tool_choice, 'required');
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.max_completion_tokens, 512);
  assert.equal(body.reasoning_effort, 'low');
  assert.deepEqual(body.tools, [{ type: 'function', function: quote }]);
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'You buy evidence.' },
    { role: 'user', content: 'Prepare the pack.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'quote_dispute_pack', arguments: '{"pages":3}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"priceUsd":"0.30"}' },
  ]);
});

test('a turn with no function call returns calls [] and the text', async () => {
  const gemini = fakeFetch([{ body: { candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: 'I am done.' }] } }] } }]);
  const g = await new GeminiAgentModel({ apiKey: 'k', fetch: gemini.f }).turn(req);
  assert.deepEqual(g.calls, []);
  assert.equal(g.text, 'I am done.');
  // No usageMetadata: zeros, not reported.
  assert.deepEqual(g.usage, { inputTokens: 0, outputTokens: 0, reported: false });

  const groq = fakeFetch([{ body: { choices: [{ message: { role: 'assistant', content: 'I am done.' } }] } }]);
  const q = await new GroqAgentModel({ apiKey: 'k', fetch: groq.f }).turn(req);
  assert.deepEqual(q.calls, []);
  assert.equal(q.text, 'I am done.');
  assert.deepEqual(q.usage, { inputTokens: 0, outputTokens: 0, reported: false });
});

test('HTTP 429 throws ModelError retryable with retryAfterMs; the API key appears only in the auth header', async () => {
  for (const [Model, header] of [
    [GeminiAgentModel, 'x-goog-api-key'],
    [GroqAgentModel, 'authorization'],
  ] as const) {
    const { f, requests } = fakeFetch([{ status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } }, headers: { 'retry-after': '7' } }]);
    const m = new Model({ apiKey: 'top-secret-key', fetch: f });
    const err = await m.turn(req).then(
      () => assert.fail('expected a ModelError'),
      (e: unknown) => e,
    );
    assert.ok(err instanceof ModelError);
    assert.equal(err.retryable, true);
    assert.equal(err.retryAfterMs, 7000);
    assert.equal(err.status, 429);
    assert.doesNotMatch(err.message, /top-secret-key/);
    // One request: the adapter does not retry (the engine does, and counts each attempt).
    assert.equal(requests.length, 1);
    assert.match(requests[0]!.headers[header]!, /top-secret-key/);
    assert.doesNotMatch(JSON.stringify(requests[0]!.body), /top-secret-key/);
    assert.doesNotMatch(requests[0]!.url, /top-secret-key/);
  }
});

test('estimateTokens is ceil(chars/4) of system, transcript and tools', () => {
  const chars = req.system.length + JSON.stringify(req.transcript).length + JSON.stringify(req.tools).length;
  assert.equal(estimateTokens(req), Math.ceil(chars / 4));
  assert.equal(estimateTokens({ system: 'abcde', transcript: [], tools: [], maxOutputTokens: 1 }), Math.ceil((5 + 2 + 2) / 4));
});

test('agentModelsFromEnv picks gemini primary and groq fallback by default; null without keys', () => {
  const both = agentModelsFromEnv({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' })!;
  assert.equal(both.primary.provider, 'gemini');
  assert.equal(both.fallback?.provider, 'groq');

  const groqFirst = agentModelsFromEnv({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', ANALYST_PROVIDER: 'groq', AGENT_GROQ_MODEL: 'llama-x' })!;
  assert.equal(groqFirst.primary.provider, 'groq');
  assert.equal(groqFirst.primary.model, 'llama-x');
  assert.equal(groqFirst.fallback?.provider, 'gemini');

  const onlyGroq = agentModelsFromEnv({ GROQ_API_KEY: 'q' })!;
  assert.equal(onlyGroq.primary.provider, 'groq');
  assert.equal(onlyGroq.fallback, null);

  assert.equal(agentModelsFromEnv({}), null);
});

test('Gemini functionCall with non-object args gives arguments {}', async () => {
  const { f } = fakeFetch([{ body: { candidates: [{ content: { parts: [{ functionCall: { name: 'a', args: [1, 2] } }, { functionCall: { name: 'b', args: 'x' } }, { functionCall: { name: 'c' } }] } }] } }]);
  const turn = await new GeminiAgentModel({ apiKey: 'k', fetch: f }).turn(req);
  assert.deepEqual(turn.calls, [
    { name: 'a', arguments: {} },
    { name: 'b', arguments: {} },
    { name: 'c', arguments: {} },
  ]);
});

test('Groq transcript: a tool entry before any model entry throws; an undefined result is sent as null', async () => {
  const { f, requests } = fakeFetch([{ body: { choices: [{ message: { content: 'ok' } }] } }]);
  const m = new GroqAgentModel({ apiKey: 'k', fetch: f });
  await assert.rejects(m.turn({ ...req, transcript: [{ role: 'user', text: 'hi' }, { role: 'tool', name: 'quote_dispute_pack', result: {} }] }), /without a model call/);
  assert.equal(requests.length, 0);
  await m.turn({ ...req, transcript: [{ role: 'model', call: { name: 'quote_dispute_pack', arguments: {} } }, { role: 'tool', name: 'quote_dispute_pack', result: undefined }] });
  assert.deepEqual(requests[0]!.body.messages[2], { role: 'tool', tool_call_id: 'call_0', content: 'null' });
});

test('usage with only one of the two counts is not reported (both providers)', async () => {
  const gemini = fakeFetch([{ body: { candidates: [{ content: { parts: [{ text: 'x' }] } }], usageMetadata: { promptTokenCount: 50 } } }]);
  assert.deepEqual((await new GeminiAgentModel({ apiKey: 'k', fetch: gemini.f }).turn(req)).usage, { inputTokens: 0, outputTokens: 0, reported: false });
  const groq = fakeFetch([{ body: { choices: [{ message: { content: 'x' } }], usage: { completion_tokens: 9 } } }]);
  assert.deepEqual((await new GroqAgentModel({ apiKey: 'k', fetch: groq.f }).turn(req)).usage, { inputTokens: 0, outputTokens: 0, reported: false });
});

test('a 200 that is not JSON, or not shaped as expected, is a non-retryable ModelError without body content', async () => {
  for (const Model of [GeminiAgentModel, GroqAgentModel]) {
    const notJson = (async () => new Response('<html>secret-body-text</html>', { status: 200 })) as typeof fetch;
    const e1 = await new Model({ apiKey: 'k', fetch: notJson }).turn(req).then(
      () => assert.fail('expected a ModelError'),
      (e: unknown) => e,
    );
    assert.ok(e1 instanceof ModelError);
    assert.equal(e1.retryable, false);
    assert.doesNotMatch(e1.message, /secret-body-text/);

    // Shapes that make reading throw: parts / tool_calls that are not arrays.
    const odd = fakeFetch([{ body: { candidates: [{ content: { parts: 'secret-body-text' } }], choices: [{ message: { tool_calls: 'secret-body-text' } }] } }]);
    const e2 = await new Model({ apiKey: 'k', fetch: odd.f }).turn(req).then(
      () => assert.fail('expected a ModelError'),
      (e: unknown) => e,
    );
    assert.ok(e2 instanceof ModelError);
    assert.equal(e2.retryable, false);
    assert.doesNotMatch(e2.message, /secret-body-text/);
  }
});
