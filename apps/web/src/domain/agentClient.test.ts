import { describe, expect, it } from 'vitest';
import { AgentRequestError, createAgentClient } from './agentClient';

function fake(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, client: createAgentClient({ fetch: f }) };
}

describe('createAgentClient', () => {
  it('asks for the workspace’s runs only with scope=workspace', async () => {
    const a = fake(200, { runs: [] });
    await a.client.list('mine');
    await a.client.list('workspace');
    await a.client.get('run-1', 'workspace');
    await a.client.stop('run-1', 'mine').catch(() => {});
    expect(a.calls.map((c) => c.url)).toEqual(['/api/agent/runs', '/api/agent/runs?scope=workspace', '/api/agent/runs/run-1?scope=workspace', '/api/agent/runs/run-1/stop']);
  });

  it('starts a run with JSON and keeps with { kept }', async () => {
    const a = fake(201, { run: { id: 'run-1' } });
    await a.client.start({ goal: 'g', cap: '2.00', failFirst: ['deep_report'] });
    await a.client.keep('run-1', true);
    expect(a.calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(a.calls[0]!.init.body))).toEqual({ goal: 'g', cap: '2.00', failFirst: ['deep_report'] });
    expect(a.calls[1]!.url).toBe('/api/agent/runs/run-1/keep');
    expect(JSON.parse(String(a.calls[1]!.init.body))).toEqual({ kept: true });
  });

  it('a refusal carries the code and the page’s words for it', async () => {
    const a = fake(429, { error: 'PERSON_CAP', detail: 'server words', retryAfterSec: 3600 });
    const e = await a.client.start({ goal: 'g', cap: '2.00', failFirst: [] }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AgentRequestError);
    expect((e as AgentRequestError).code).toBe('PERSON_CAP');
    expect((e as AgentRequestError).status).toBe(429);
    expect((e as AgentRequestError).message).toBe('You have used your agent runs for today; try again in 1 h.');
  });

  it('a page instead of a list means no server behind /api', async () => {
    const a = fake(200, '<html>');
    await expect(a.client.list('mine')).rejects.toMatchObject({ code: 'SERVER_UNREACHABLE' });
  });
});
