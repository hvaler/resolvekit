/**
 * The buying agent's runs as the `/agent` page shows them (`/api/agent/runs`, apps/server/src/agent/routes.ts). Pure:
 * the words for each outcome, settlement and step, the model usage line, two runs side by side, and when to read a
 * run again. The types mirror the server's `PublicRun` and @resolvekit/agent's Step (the web app does not import the
 * engine package, which runs on Node).
 *
 * Honesty rules: a run that stopped or was interrupted is never called done; a settlement says only what MeterMCP's
 * receipt said (`unverified`: nothing is implied); an injected failure is marked injected, never an outage.
 */
import { utcStamp } from './time';

export type Outcome = 'done' | 'cannot_do' | 'out_of_budget' | 'stopped' | 'model_unavailable' | 'not_approved' | 'interrupted';
export type RunState = 'running' | 'awaiting_approval' | Outcome;
export const STOP_REASONS = [
  'max_actions',
  'max_time',
  'max_model_calls',
  'model_budget',
  'invalid_action',
  'approval_timeout',
  'persistence',
  'budget_unavailable',
  'meter_unavailable',
  'internal_error',
] as const;
export type StopReason = (typeof STOP_REASONS)[number];
export type Settlement = 'none' | 'unverified' | 'open' | 'captured' | 'capture_pending' | 'capture_declined' | 'voided' | 'failed' | 'not_approved';

export interface AgentStep {
  n: number;
  at: string;
  /** pending: announced before its MeterMCP call; done: answered; uncertain: the server restarted during the call. */
  state: 'pending' | 'done' | 'uncertain';
  kind: 'call' | 'free' | 'finish' | 'invalid' | 'insufficient_balance';
  tool: string | null;
  arguments: Record<string, unknown> | null;
  reason: string;
  summary: string;
  metering: { status: 'OK' | 'FAILED'; price: string; charged: boolean; remaining: string; injected: 'run' | 'server' | null } | null;
}

/** A run as the API answers it. Seen by the workspace's owner (`viewedAs`), it has no approval link, order or session id. */
export interface AgentRun {
  id: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  by: { label: string; workspaceId: string };
  goal: string;
  cap: string;
  failFirst: string[];
  state: RunState;
  stopReason: StopReason | null;
  answer: string | null;
  steps: AgentStep[];
  provider: string | null;
  model: string | null;
  usage: { modelCalls: number; inputTokens: number; outputTokens: number; reported: boolean };
  captureId: string | null;
  settlement: Settlement;
  receiptSha256: string | null;
  kept: boolean;
  /** The author's only. */
  approvalUrl?: string | null;
  orderId?: string | null;
  sessionId?: string | null;
  viewedAs?: 'owner';
  /** The run's action limit, when the record carries it (it does not yet: the default 8 is shown). */
  maxActions?: number;
}

/** The engine's default action limit (DEFAULT_LIMITS.maxActions). */
const DEFAULT_MAX_ACTIONS = 8;

export const isLive = (s: RunState): boolean => s === 'running' || s === 'awaiting_approval';

/** Settlements MeterMCP's reconcile sweep may still change (the server's UNSETTLED). */
const UNSETTLED: ReadonlySet<Settlement> = new Set(['open', 'capture_pending', 'failed', 'unverified']);

const STOP_TEXT: Record<Exclude<StopReason, 'max_actions'>, string> = {
  max_time: 'Stopped: time limit',
  max_model_calls: 'Stopped: model call limit',
  model_budget: 'Stopped: model token budget',
  invalid_action: 'Stopped: the model gave invalid actions',
  approval_timeout: 'Stopped: PayPal approval timed out',
  persistence: 'Stopped: the run could not be saved',
  budget_unavailable: 'Stopped: MeterMCP did not open a budget',
  meter_unavailable: 'Stopped: MeterMCP unreachable',
  internal_error: 'Stopped: internal error',
};

/** The run's state in words, while it goes on; see {@link outcomeText} for how it ended. */
export function stateText(s: RunState): string {
  if (s === 'running') return 'Running';
  if (s === 'awaiting_approval') return 'Waiting for approval in PayPal';
  return outcomeText({ state: s, stopReason: null });
}

/** How the run ended (or that it still runs). Never «done» unless the model finished with `done`. */
export function outcomeText(run: Pick<AgentRun, 'state' | 'stopReason' | 'maxActions'>): string {
  switch (run.state) {
    case 'running':
    case 'awaiting_approval':
      return stateText(run.state);
    case 'done':
      return 'Done';
    case 'cannot_do':
      return 'The tools cannot meet this goal';
    case 'out_of_budget':
      return 'Out of budget';
    case 'model_unavailable':
      return 'Model unavailable';
    case 'not_approved':
      return 'Not approved in PayPal';
    // A Stop click, a shutdown and a restart all end a run interrupted; the record does not say which.
    case 'interrupted':
      return 'Interrupted (stopped or server restart)';
    case 'stopped':
      if (run.stopReason === 'max_actions') return `Stopped: action limit (${run.maxActions ?? DEFAULT_MAX_ACTIONS})`;
      return run.stopReason ? STOP_TEXT[run.stopReason] : 'Stopped';
  }
}

const toCents = (v: string): number => Math.round(Number.parseFloat(v) * 100);
const usd = (c: number) => (c / 100).toFixed(2);

/** What the run's steps say was charged (OK calls), not charged (failed calls) and unknown (restart mid-call). */
export function runTotals(run: Pick<AgentRun, 'steps' | 'cap'>): { charged: string; okCalls: number; notCharged: number; uncertain: number; cap: string } {
  let cents = 0;
  let okCalls = 0;
  let notCharged = 0;
  let uncertain = 0;
  for (const s of run.steps) {
    if (s.state === 'uncertain') uncertain++;
    else if (s.metering?.charged) {
      okCalls++;
      cents += toCents(s.metering.price);
    } else if (s.metering) notCharged++;
  }
  return { charged: usd(cents), okCalls, notCharged, uncertain, cap: run.cap };
}

/** The PayPal side, as MeterMCP's receipt last said it. */
export function settlementText(run: Pick<AgentRun, 'settlement' | 'steps' | 'cap'>): string {
  switch (run.settlement) {
    case 'none':
      return 'Nothing opened in PayPal';
    case 'unverified':
      return 'Not verified yet';
    case 'open':
      return 'Budget open in PayPal (not settled yet)';
    case 'captured': {
      const t = runTotals(run);
      if (t.uncertain) return 'Captured in PayPal (amount on the MeterMCP receipt: a call’s result is unknown here)';
      return `Captured ${t.charged} USD · ${usd(Math.max(0, toCents(t.cap) - toCents(t.charged)))} released`;
    }
    case 'capture_pending':
      return 'Capture pending at PayPal (not final)';
    case 'capture_declined':
      return 'Capture declined by PayPal: nothing charged';
    case 'voided':
      return 'Voided: nothing charged';
    case 'failed':
      return 'Settlement failed: nothing charged as far as MeterMCP knows; will be retried';
    case 'not_approved':
      return 'Not approved in PayPal: nothing charged';
  }
}

/** One line per step: `#2 deep_report · 0.40 USD · FAILED, not charged · <result>`. The reason is shown apart. */
export function stepLine(step: AgentStep): string {
  // A step without a tool is an invalid action (no call could be read); its kind stands in for the tool.
  const parts: string[] = [`#${step.n} ${step.tool ?? (step.kind === 'invalid' ? 'invalid action' : step.kind)}`];
  if (step.state === 'pending') parts.push('in progress…');
  else if (step.state === 'uncertain') parts.push(step.summary);
  else if (step.metering) parts.push(`${step.metering.price} USD`, step.metering.status === 'OK' ? 'OK, charged' : 'FAILED, not charged', step.summary);
  else {
    if (step.kind === 'invalid' && step.tool) parts.push('invalid action');
    else if (step.kind === 'insufficient_balance') parts.push('not called: insufficient balance');
    else if (step.kind === 'free') parts.push('free');
    parts.push(step.summary);
  }
  return parts.filter(Boolean).join(' · ');
}

export type StepBadge = 'injected' | 'not charged' | 'uncertain';

/** The badges beside a step: an injected failure is «injected» and «not charged»; a restart mid-call «uncertain». */
export function stepBadges(step: AgentStep): StepBadge[] {
  if (step.state === 'uncertain') return ['uncertain'];
  const m = step.metering;
  if (!m || m.status === 'OK') return [];
  return m.injected ? ['injected', 'not charged'] : ['not charged'];
}

/** The model's use, which the person's PayPal budget never pays for. */
export function usageText(run: Pick<AgentRun, 'provider' | 'model' | 'usage'>): string {
  const tail = 'not charged to the PayPal budget';
  if (!run.provider) return `Model: none used · ${tail}`;
  const u = run.usage;
  return `Model: ${run.provider} ${run.model ?? ''} · ${u.modelCalls} ${u.modelCalls === 1 ? 'call' : 'calls'} · ${u.inputTokens} in / ${u.outputTokens} out tokens (${u.reported ? 'provider-reported' : 'estimated'}) · ${tail}`;
}

/** Two runs step by step, aligned by step number (a gap where one has no such step). */
export function compareRows(a: Pick<AgentRun, 'steps'>, b: Pick<AgentRun, 'steps'>): Array<{ n: number; left: AgentStep | null; right: AgentStep | null }> {
  const ns = [...new Set([...a.steps, ...b.steps].map((s) => s.n))].sort((x, y) => x - y);
  return ns.map((n) => ({ n, left: a.steps.find((s) => s.n === n) ?? null, right: b.steps.find((s) => s.n === n) ?? null }));
}

const POLL_MAX_MS = 30_000;
/** A finished run whose settlement MeterMCP may still change is read again at this pace. */
const SETTLING_MS = 15_000;

/**
 * When to read the run again: 2 s while it runs, 4 s while it waits for PayPal, 15 s while it is over but its settlement
 * is not; doubled after each failed read in a row (`errors`), up to 30 s. Null: nothing will change any more.
 */
export function pollDelay(run: Pick<AgentRun, 'state' | 'settlement'>, errors: number): number | null {
  const base = run.state === 'running' ? 2000 : run.state === 'awaiting_approval' ? 4000 : UNSETTLED.has(run.settlement) ? SETTLING_MS : null;
  if (base == null) return null;
  return Math.min(POLL_MAX_MS, base * 2 ** Math.max(0, errors));
}

function resetText(resetsAt: unknown): string | null {
  if (typeof resetsAt !== 'string') return null;
  const d = new Date(resetsAt);
  return Number.isNaN(d.getTime()) ? null : utcStamp(d);
}

const ERROR_TEXT: Record<string, string> = {
  RUN_IN_PROGRESS: 'You already have a run going: wait for it to end, or stop it.',
  BUSY: 'The server is running as many agent runs as it allows; try again in a few minutes.',
  MODEL_UNAVAILABLE: 'No AI model is configured on this server, so the agent cannot run.',
  CAPS_UNAVAILABLE: 'The demo cannot record this run’s use right now, so it was not started; try again later.',
  STOPPING: 'The server is restarting; try again in a minute.',
  STORAGE: 'The run could not be saved; try again later.',
  INVALID_GOAL: 'The goal is 1 to 300 characters of plain text.',
  INVALID_CAP: 'The cap is an amount in USD from 0.50 to 5.00, e.g. 2.50.',
  SIGN_IN_REQUIRED: 'Sign in to run the buying agent.',
  SELLER_WORKSPACE_ONLY: 'On this public demo only the seller’s workspace starts agent runs.',
  AGENT_UNAVAILABLE: 'The buying agent is not set up on this server.',
  OWNER_ONLY: 'Only the workspace’s owner can do this.',
  NOT_FOUND: 'This run is not one you can see.',
  SERVER_UNREACHABLE: 'The ResolveKit server could not be reached; try again.',
};

/** A refusal by the agent routes, in a short sentence: `code` is the answer's `error`, `body` the rest of it. */
export function agentErrorText(code: string, body: { detail?: unknown; resetsAt?: unknown; retryAfterSec?: unknown }): string {
  if (code === 'DAILY_CAP') {
    const at = resetText(body.resetsAt);
    return `The demo’s daily agent runs are used up; ${at ? `they reset at ${at}` : 'try again tomorrow'}.`;
  }
  if (code === 'PERSON_CAP') {
    const sec = typeof body.retryAfterSec === 'number' && body.retryAfterSec > 0 ? body.retryAfterSec : null;
    return `You have used your agent runs for today; try again ${sec ? `in ${Math.ceil(sec / 3600)} h` : 'tomorrow'}.`;
  }
  return ERROR_TEXT[code] ?? (typeof body.detail === 'string' && body.detail ? body.detail : `The request was refused (${code}).`);
}
