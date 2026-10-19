import { agentErrorText, type AgentRun } from './agentRun';

/** A refusal by the agent routes: the server's code, and the page's words for it (`agentErrorText`). */
export class AgentRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, body: { error?: string; detail?: unknown; resetsAt?: unknown; retryAfterSec?: unknown }) {
    const code = body.error ?? `HTTP_${status}`;
    super(agentErrorText(code, body));
    this.name = 'AgentRequestError';
    this.status = status;
    this.code = code;
  }
}

/** Whose runs: the caller's own, or the workspace's (owner only; someone else's run is then an owner view). */
export type RunScope = 'mine' | 'workspace';

/** The buying agent's runs on the ResolveKit server (`/api/agent/runs`). `fetch` and `base` as the other clients. */
export function createAgentClient(o: { base?: string; fetch?: typeof fetch } = {}) {
  const base = `${o.base ?? '/api'}/agent/runs`;
  const f = o.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const q = (scope: RunScope) => (scope === 'workspace' ? '?scope=workspace' : '');
  const call = async <T>(path: string, init: RequestInit): Promise<T> => {
    let r: Response;
    try {
      r = await f(base + path, { credentials: 'same-origin', ...init, signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new AgentRequestError(0, { error: 'SERVER_UNREACHABLE' });
    }
    const body = (await r.json().catch(() => ({}))) as T & { error?: string };
    if (!r.ok) throw new AgentRequestError(r.status, body);
    return body;
  };
  const post = <T>(path: string, body: unknown) => call<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const one = (id: string) => `/${encodeURIComponent(id)}`;
  return {
    start: async (input: { goal: string; cap: string; failFirst: string[] }) => (await post<{ run: AgentRun }>('', input)).run,
    list: async (scope: RunScope) => {
      const body = await call<{ runs?: unknown }>(q(scope), { method: 'GET' });
      // Not a list (a static host answering /api with a page): there is no ResolveKit server behind it.
      if (!Array.isArray(body.runs)) throw new AgentRequestError(0, { error: 'SERVER_UNREACHABLE' });
      return body.runs as AgentRun[];
    },
    get: async (id: string, scope: RunScope) => (await call<{ run: AgentRun }>(one(id) + q(scope), { method: 'GET' })).run,
    stop: async (id: string, scope: RunScope) => (await post<{ run: AgentRun }>(`${one(id)}/stop${q(scope)}`, {})).run,
    keep: async (id: string, kept: boolean) => post<{ id: string; kept: boolean }>(`${one(id)}/keep`, { kept }),
  };
}

export type AgentClient = ReturnType<typeof createAgentClient>;
