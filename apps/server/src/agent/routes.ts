/**
 * The HTTP routes of the buying agent's runs, for signed-in people (local mode: the operator):
 *
 *   POST /api/agent/runs                 { goal, cap, failFirst? } → 201 { run }: started in the background
 *   GET  /api/agent/runs                 { runs }: the caller's own runs, newest first
 *   GET  /api/agent/runs?scope=workspace the workspace's runs (owner only, else 403)
 *   GET  /api/agent/runs/:id             the caller's own run; someone else's only to the owner with ?scope=workspace
 *   POST /api/agent/runs/:id/stop        202: aborts the run's loop (it ends interrupted and settles); the author, or
 *                                        the owner with ?scope=workspace
 *   POST /api/agent/runs/:id/keep        { kept } → never swept; the owner only
 *
 * Isolation (Ruling A2): a run nobody may read answers 404, whoever asks and whatever exists, so its id tells nothing.
 * Owner access is explicit (?scope=workspace), shown in the answer (`viewedAs: 'owner'`) and logged (run id and the
 * owner's label). A run of another workspace is never visible.
 *
 * Validation comes before any reservation; a start the service refuses gives the daily and per-person units back.
 */
import type { ActingPerson, Reservation } from '../app.ts';
import type { AgentService, StartError } from './service.ts';
import type { RunRecord } from './runs.ts';

/** A run as the API shows it: no person id; the approval link only for its author. */
export type PublicRun = Omit<RunRecord, 'by' | 'approvalUrl'> & { by: { label: string; workspaceId: string }; approvalUrl?: string | null; viewedAs?: 'owner' };

export const GOAL_MAX = 300;
/** The demo's cap range and format, as MeterMCP's defaults (METERMCP_MIN_BUDGET 0.50, METERMCP_BUDGET 5.00). */
export const CAP_FORMAT = /^\d{1,2}(\.\d{1,2})?$/;
export const CAP_MIN_CENTS = 50;
export const CAP_MAX_CENTS = 500;
/** MeterMCP takes at most three paid tool names in fail_first and checks them; here only their shape. */
const FAIL_FIRST_MAX = 3;
const TOOL_NAME = /^[a-z_]{1,40}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/;

const ROUTE = /^\/api\/agent\/runs(?:\/(run-[0-9a-f]{32})(?:\/(stop|keep))?)?$/;

const START_REFUSAL: Record<StartError, { status: number; detail: string }> = {
  RUN_IN_PROGRESS: { status: 409, detail: 'You already have a run going; wait for it to end or stop it.' },
  BUSY: { status: 503, detail: 'The server is running as many agent runs as it allows; try again in a few minutes.' },
  MODEL_UNAVAILABLE: { status: 503, detail: 'No AI model is configured on this server, so the agent cannot run.' },
  STORAGE: { status: 503, detail: 'The run could not be saved, so it was not started; try again later.' },
  STOPPING: { status: 503, detail: 'The server is restarting; try again in a minute.' },
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const notFound = () => json(404, { error: 'NOT_FOUND' });
const notAllowed = () => json(405, { error: 'METHOD_NOT_ALLOWED' });
const refusal = (r: { status: number; body: unknown }) => {
  const res = json(r.status, r.body);
  const after = (r.body as { retryAfterSec?: unknown } | null)?.retryAfterSec;
  if (typeof after === 'number') res.headers.set('retry-after', String(after));
  return res;
};

/** The run as its author sees it, or as the owner sees someone else's (`owner`: marked, no approval link). */
export function publicRun(r: RunRecord, as: 'author' | 'owner'): PublicRun {
  const { by, approvalUrl, ...rest } = r;
  const out: PublicRun = { ...rest, by: { label: by.label, workspaceId: by.workspaceId } };
  if (as === 'author') out.approvalUrl = approvalUrl;
  else out.viewedAs = 'owner';
  return out;
}

/** Goal, cap and failFirst checked as MeterMCP would, before anything is reserved or opened. */
export function parseStart(body: unknown): { ok: true; goal: string; cap: string; failFirst: string[] } | { ok: false; error: string; detail: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const goal = typeof b.goal === 'string' ? b.goal.trim() : '';
  if (!goal || goal.length > GOAL_MAX || CONTROL.test(goal)) return { ok: false, error: 'INVALID_GOAL', detail: `The goal is 1 to ${GOAL_MAX} characters of plain text.` };
  const cap = b.cap;
  const cents = typeof cap === 'string' && CAP_FORMAT.test(cap) ? Math.round(Number(cap) * 100) : null;
  if (cents == null || cents < CAP_MIN_CENTS || cents > CAP_MAX_CENTS) {
    return { ok: false, error: 'INVALID_CAP', detail: `The cap is an amount in USD from ${(CAP_MIN_CENTS / 100).toFixed(2)} to ${(CAP_MAX_CENTS / 100).toFixed(2)}, e.g. "2.50".` };
  }
  const ff = b.failFirst ?? [];
  if (!Array.isArray(ff) || ff.length > FAIL_FIRST_MAX || !ff.every((t) => typeof t === 'string' && TOOL_NAME.test(t))) {
    return { ok: false, error: 'INVALID_FAIL_FIRST', detail: `failFirst names at most ${FAIL_FIRST_MAX} paid tools.` };
  }
  return { ok: true, goal, cap: cap as string, failFirst: [...new Set(ff as string[])] };
}

export function createAgentRoutes(o: {
  agent: AgentService | null;
  /** The person acting (hosted: from the session, null when signed out; local: the operator). */
  person: (req: Request) => ActingPerson | null;
  /** Hosted: the daily and per-person agent-run units, one of each (null in local mode: no caps). */
  reserve: ((req: Request) => Reservation) | null;
  log: (line: string) => void;
}): (req: Request, url: URL) => Promise<Response | null> {
  /** How `p` may see `r`: as its author, as the workspace's owner (only when asked with ?scope=workspace), or not. */
  const access = (p: ActingPerson, r: RunRecord, scope: boolean): 'author' | 'owner' | null => {
    if (r.by.workspaceId !== p.workspaceId) return null;
    if (r.by.personId === p.id) return 'author';
    return scope && p.role === 'owner' ? 'owner' : null;
  };

  const start = async (req: Request, agent: AgentService, p: ActingPerson): Promise<Response> => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: 'INVALID_JSON' });
    }
    const v = parseStart(body);
    if (!v.ok) return json(400, { error: v.error, detail: v.detail });
    const reserved = o.reserve?.(req);
    if (reserved && !reserved.ok) return refusal(reserved.refusal);
    // The label is the person's name: actorLabel carries the person id, which no run shown to anyone may.
    const r = agent.start({ personId: p.id, label: p.name, workspaceId: p.workspaceId }, { goal: v.goal, cap: v.cap, failFirst: v.failFirst });
    if (!r.ok) {
      if (reserved?.ok) reserved.release();
      const s = START_REFUSAL[r.error];
      return json(s.status, { error: r.error, detail: s.detail });
    }
    return json(201, { run: publicRun(r.run, 'author') });
  };

  return async (req, url) => {
    const m = ROUTE.exec(url.pathname);
    if (!m) return null;
    const agent = o.agent;
    if (!agent) return json(503, { error: 'AGENT_UNAVAILABLE', detail: 'The buying agent is not set up on this server.' });
    const p = o.person(req);
    if (!p) return json(401, { error: 'SIGN_IN_REQUIRED', detail: 'Sign in to run the buying agent.' });
    const scopeParam = url.searchParams.get('scope');
    if (scopeParam !== null && scopeParam !== 'workspace') return json(400, { error: 'INVALID_SCOPE', detail: 'scope is "workspace" or absent.' });
    const scope = scopeParam === 'workspace';
    const id = m[1];
    const sub = m[2];

    if (!id) {
      if (req.method === 'POST') return scope ? json(400, { error: 'INVALID_SCOPE', detail: 'A run is started for yourself.' }) : start(req, agent, p);
      if (req.method !== 'GET') return notAllowed();
      if (!scope) return json(200, { runs: agent.store.list({ personId: p.id, workspaceId: p.workspaceId }).map((r) => publicRun(r, 'author')) });
      if (p.role !== 'owner') return json(403, { error: 'OWNER_ONLY', detail: 'Only the workspace’s owner sees everyone’s runs.' });
      const runs = agent.store.list({ workspaceId: p.workspaceId });
      const others = runs.filter((r) => r.by.personId !== p.id).length;
      if (others) o.log(`agent runs: the workspace's list (${others} run(s) of others) viewed by the owner ${p.label}`);
      return json(200, { runs: runs.map((r) => publicRun(r, r.by.personId === p.id ? 'author' : 'owner')) });
    }

    if (sub === 'keep') {
      if (req.method !== 'POST') return notAllowed();
      // Before reading the run: a member gets the same answer whether it exists or not.
      if (p.role !== 'owner') return json(403, { error: 'OWNER_ONLY', detail: 'Only the workspace’s owner keeps runs.' });
      const r = agent.store.get(id);
      if (!r || r.by.workspaceId !== p.workspaceId) return notFound();
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json(400, { error: 'INVALID_JSON' });
      }
      const kept = (body as { kept?: unknown } | null)?.kept;
      if (typeof kept !== 'boolean') return json(400, { error: 'INVALID_KEPT', detail: 'kept is true or false.' });
      let next: RunRecord;
      try {
        next = agent.store.update(id, { kept });
      } catch {
        return json(503, { error: 'STORAGE', detail: 'The run could not be saved; try again later.' });
      }
      o.log(`agent run ${id}: ${kept ? 'kept' : 'no longer kept'} by the owner ${p.label}`);
      return json(200, { run: publicRun(next, r.by.personId === p.id ? 'author' : 'owner') });
    }

    const r = agent.store.get(id);
    const as = r ? access(p, r, scope) : null;
    if (!r || !as) return notFound();

    if (sub === 'stop') {
      if (req.method !== 'POST') return notAllowed();
      if (!agent.stopRun(id)) return json(409, { error: 'NOT_RUNNING', detail: 'This run is not going on this server.' });
      if (as === 'owner') o.log(`agent run ${id}: stopped by the owner ${p.label}`);
      return json(202, { run: publicRun(agent.store.get(id)!, as) });
    }

    if (req.method !== 'GET') return notAllowed();
    if (as === 'owner') o.log(`agent run ${id}: viewed by the owner ${p.label}`);
    return json(200, { run: publicRun(r, as) });
  };
}
