/**
 * The run loop: a model decides, code validates, MeterMCP meters the money.
 *
 * Each turn the model gets the goal, the tools it is offered (the paid tools, price_list, get_balance, finish) and
 * the observations so far, and answers one action. Code checks the run limits before asking, then the action: one
 * call, a tool that is offered, arguments that fit its schema, a price within the cap or the remaining balance. Only
 * then does it call MeterMCP. The first paid call that fits opens the budget (open_budget) and waits for the person's
 * approval in PayPal; the model never sees open_budget, close_session or get_receipt. Whatever ends the run, code
 * closes the session and reads the receipt: the settlement is only ever what that receipt says.
 */
import { ModelError } from '@resolvekit/analyst/node';
import type { MeterAnswer, MeterConnection, MeterTool } from './meter.ts';
import { goalEntry, systemPrompt } from './prompt.ts';
import { validate } from './schema.ts';
import { estimateTokens, type AgentModel, type FunctionDecl, type JsonSchema, type ModelCall, type ModelTurn, type TranscriptEntry, type TurnRequest } from './types.ts';

export interface RunLimits {
  maxActions: number;
  maxAgentMs: number;
  approvalTimeoutMs: number;
  maxModelCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  runTokenBudget: number;
}

export const DEFAULT_LIMITS: RunLimits = {
  maxActions: 8,
  maxAgentMs: 180_000,
  approvalTimeoutMs: 900_000,
  maxModelCalls: 12,
  maxInputTokens: 8000,
  maxOutputTokens: 1024,
  runTokenBudget: 60_000,
};

const LIMIT_ENV: Record<keyof RunLimits, string> = {
  maxActions: 'AGENT_MAX_ACTIONS',
  maxAgentMs: 'AGENT_MAX_MS',
  approvalTimeoutMs: 'AGENT_APPROVAL_TIMEOUT_MS',
  maxModelCalls: 'AGENT_MAX_MODEL_CALLS',
  maxInputTokens: 'AGENT_MAX_INPUT_TOKENS',
  maxOutputTokens: 'AGENT_MAX_OUTPUT_TOKENS',
  runTokenBudget: 'AGENT_RUN_TOKEN_BUDGET',
};

/** The limits from AGENT_* variables; a missing or malformed value (not a positive integer) keeps the default. */
export function limitsFromEnv(env: Record<string, string | undefined>): RunLimits {
  const out = { ...DEFAULT_LIMITS };
  for (const k of Object.keys(LIMIT_ENV) as Array<keyof RunLimits>) {
    const v = env[LIMIT_ENV[k]]?.trim();
    if (v && /^\d+$/.test(v) && Number(v) > 0) out[k] = Number(v);
  }
  return out;
}

export interface RunInput {
  goal: string;
  cap: string;
  failFirst: string[];
  returnTo?: string;
}

export type Outcome = 'done' | 'cannot_do' | 'out_of_budget' | 'stopped' | 'model_unavailable' | 'not_approved' | 'interrupted';
export type StopReason = 'max_actions' | 'max_time' | 'max_model_calls' | 'model_budget' | 'invalid_action' | 'approval_timeout' | 'persistence' | 'budget_unavailable';
export type Settlement = 'none' | 'unverified' | 'open' | 'captured' | 'capture_pending' | 'capture_declined' | 'voided' | 'failed' | 'not_approved';

export interface Step {
  n: number;
  at: string;
  /** pending: announced before its MeterMCP call (write-ahead); done: answered; uncertain: set by the server's recovery. */
  state: 'pending' | 'done' | 'uncertain';
  kind: 'call' | 'free' | 'finish' | 'invalid' | 'insufficient_balance';
  tool: string | null;
  arguments: Record<string, unknown> | null;
  reason: string;
  /** One line for the page, e.g. 'Quote 412.37 USD · limits: current quote only…' or the refusal. */
  summary: string;
  metering: { status: 'OK' | 'FAILED'; price: string; charged: boolean; remaining: string; injected: 'run' | 'server' | null } | null;
}

export type RunEvent =
  | { type: 'step_started'; step: Step }
  | { type: 'step'; step: Step }
  | { type: 'awaiting_approval'; approvalUrl: string; sessionId: string; orderId: string; cap: string }
  | { type: 'approved'; cap: string }
  | { type: 'usage'; provider: string; model: string; modelCalls: number; inputTokens: number; outputTokens: number; reported: boolean };

export interface RunResult {
  outcome: Outcome;
  stopReason: StopReason | null;
  answer: string | null;
  steps: Step[];
  provider: string | null;
  model: string | null;
  usage: { modelCalls: number; inputTokens: number; outputTokens: number; reported: boolean };
  sessionId: string | null;
  orderId: string | null;
  captureId: string | null;
  settlement: Settlement;
  receipt: Record<string, any> | null;
  receiptSha256: string | null;
}

/** The free tools the model may call; MeterMCP's other free tools (open_budget, close_session, get_receipt) are code's. */
const FREE_OFFERED = new Set(['price_list', 'get_balance']);
const FINISH_OUTCOMES = ['done', 'cannot_do', 'out_of_budget'] as const;
const REASON_MAX = 200;
const POLL_MS = 3000;
const RETRIES = 2;
const BACKOFF_MS = [1000, 4000];
const RETRY_AFTER_MAX_MS = 20_000;
/** Below this many output tokens left, a turn cannot hold a full action: the run stops (model_budget). */
const MIN_OUTPUT_TOKENS = 64;
const SETTLEMENTS: ReadonlySet<string> = new Set(['open', 'captured', 'capture_pending', 'capture_declined', 'voided', 'failed', 'not_approved']);
/** open_budget refusals that say for sure no budget was opened for this run (Ruling A8). */
const BUDGET_REFUSALS: ReadonlySet<string> = new Set(['demo_code_required', 'daily_cap', 'caps_unavailable', 'paypal_unavailable', 'invalid_cap', 'budget_exists']);
const UNCERTAIN_SUMMARY = 'Result unknown: the call may have been charged; the receipt will show it.';
const BALANCE_UNREAD = 'The balance could not be read; the call was not made.';
const RUN_INJECTED = 'injected for this run';
const SERVER_INJECTED = 'METERMCP_FAIL_FIRST test switch';

const REASON_PARAM = { type: 'string', description: `Why this action, in one short sentence (at most ${REASON_MAX} characters).` };

const FINISH: FunctionDecl = {
  name: 'finish',
  description: 'End the run: done when the goal is met, cannot_do when the tools cannot meet it, out_of_budget when the budget left cannot pay for what is needed (free).',
  parameters: {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: [...FINISH_OUTCOMES], description: 'How the run ends' },
      answer: { type: 'string', description: 'What was found for the goal, and what is missing' },
      reason: REASON_PARAM,
    },
    required: ['outcome', 'answer', 'reason'],
    additionalProperties: false,
  },
};

/** A tool's MCP input schema as the model's parameters: plus the required reason, without $schema. */
function withReason(schema: JsonSchema): JsonSchema {
  const { $schema: _drop, ...rest } = schema as Record<string, any>;
  return { ...rest, type: 'object', properties: { ...(rest.properties ?? {}), reason: REASON_PARAM }, required: [...(rest.required ?? []), 'reason'] };
}

/** Decimal USD string → cents; null when malformed. */
function toCents(v: unknown): number | null {
  return typeof v === 'string' && /^\d{1,6}(\.\d{1,2})?$/.test(v) ? Math.round(Number(v) * 100) : null;
}
const usd = (c: number) => (c / 100).toFixed(2);

function oneLine(s: unknown, max = 240): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  const chars = [...t];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : t;
}

/** One line from a MeterMCP answer, for the page and the CLI. */
function summarize(tool: string, a: MeterAnswer): string {
  const b = a.body;
  if (a.isError) return oneLine(b.message ? `${b.error ? `${b.error}: ` : ''}${b.message}` : (b.error ?? 'MeterMCP answered an error'));
  if (tool === 'price_list') return oneLine(`Price list: ${(Array.isArray(b.tools) ? b.tools : []).map((t: any) => `${t?.name} ${t?.price}`).join(', ')} USD`);
  if (tool === 'get_balance') return b.status === 'none' ? 'Balance: no budget yet' : oneLine(`Balance: ${b.status} · ${b.remaining} of ${b.cap} USD left`);
  const r = (b.result ?? {}) as Record<string, any>;
  const head = r.quote != null ? `Quote ${r.quote} ${r.currency ?? 'USD'}` : r.checksum != null ? `${r.rows} rows of ${r.dataset} · checksum ${r.checksum}` : typeof r.summary === 'string' ? r.summary : 'OK';
  const limits = Array.isArray(r.limits) && r.limits.length ? ` · limits: ${r.limits.join(' ')}` : '';
  return oneLine(head + limits);
}

/** Where an injected failure came from, read from MeterMCP's own failure text. */
function injectedOf(body: Record<string, any>): 'run' | 'server' | null {
  const text = `${body.message ?? ''} ${JSON.stringify(body.metering ?? {})}`;
  return text.includes(RUN_INJECTED) ? 'run' : text.includes(SERVER_INJECTED) ? 'server' : null;
}

const isToolUseFailed = (e: unknown) => e instanceof ModelError && /tool_use_failed/.test(e.message);

const duration = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

/** One line per step, as the CLI prints it: `#3 deep_report · 0.40 USD · FAILED (injected for this run, not charged) · "<reason>"`. */
export function formatStep(step: Step): string {
  const parts = [`#${step.n} ${step.tool ?? step.kind}`];
  if (step.state === 'pending') parts.push('in progress');
  else if (step.state === 'uncertain') parts.push('result unknown', oneLine(step.summary));
  else if (step.metering) {
    const m = step.metering;
    const how = m.injected === 'run' ? 'injected for this run, ' : m.injected === 'server' ? 'injected by the server test switch, ' : '';
    parts.push(`${m.price} USD`, m.status === 'OK' ? 'OK (charged)' : `FAILED (${how}not charged)`);
  } else {
    if (step.kind === 'invalid') parts.push('INVALID');
    else if (step.kind === 'insufficient_balance') parts.push('not called: insufficient balance');
    else if (step.kind === 'free') parts.push('free');
    if (step.summary) parts.push(oneLine(step.summary));
  }
  parts.push(`"${oneLine(step.reason)}"`);
  return parts.join(' · ');
}

type End = { outcome: Outcome; stopReason: StopReason | null };
const end = (outcome: Outcome, stopReason: StopReason | null = null): End => ({ outcome, stopReason });

export async function runAgent(o: {
  input: RunInput;
  meter: MeterConnection;
  models: { primary: AgentModel; fallback: AgentModel | null };
  limits?: RunLimits;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (e: RunEvent) => void | Promise<void>;
  /** Aborted by the server on shutdown: the loop stops as 'interrupted' and still tries to settle. */
  signal?: AbortSignal;
}): Promise<RunResult> {
  const { input, meter, signal } = o;
  const L = o.limits ?? DEFAULT_LIMITS;
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const result: RunResult = {
    outcome: 'stopped',
    stopReason: null,
    answer: null,
    steps: [],
    provider: null,
    model: null,
    usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, reported: false },
    sessionId: null,
    orderId: null,
    captureId: null,
    settlement: 'none',
    receipt: null,
    receiptSha256: null,
  };
  const usage = result.usage;
  /** Every figure so far is the provider's own; false once an attempt is counted by estimate. */
  let allReported = true;
  /** onEvent threw or rejected (the run could not be saved): no further tool call. */
  let persistFailed = false;
  const started = now().getTime();
  let approvalWaitMs = 0;
  const agentMs = () => now().getTime() - started - approvalWaitMs;

  /** A copy goes out (steps change after step_started); a throw or rejection is a persistence failure. */
  const emit = async (e: RunEvent) => {
    if (!o.onEvent) return;
    try {
      await o.onEvent(structuredClone(e));
    } catch {
      persistFailed = true;
    }
  };

  /** Sleep unless aborted; false when the signal ended the wait. */
  const pause = async (ms: number): Promise<boolean> => {
    if (signal?.aborted) return false;
    if (!signal) {
      await sleep(ms);
      return true;
    }
    let onAbort = () => {};
    const aborted = new Promise<void>((r) => (onAbort = r));
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await Promise.race([sleep(ms), aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    return !signal.aborted;
  };

  /** A MeterMCP call whose transport failure becomes an error answer (the receipt tells whether a paid call ran). */
  const callMeter = async (name: string, args: Record<string, unknown>): Promise<MeterAnswer> => {
    try {
      return await meter.call(name, args);
    } catch (e) {
      return { isError: true, body: { error: 'meter_unreachable', message: `MeterMCP did not answer (${e instanceof Error ? e.message : String(e)}); the receipt shows whether this call ran.` } };
    }
  };

  const tools = await meter.listTools();
  const known = new Set(tools.map((t) => t.name));
  const offered = new Map<string, MeterTool>(tools.filter((t) => t.price !== null || FREE_OFFERED.has(t.name)).map((t) => [t.name, t]));
  // The agent adds `reason` to every offered tool and strips it before calling MeterMCP: a tool with its own reason
  // parameter would lose it, so it is refused before anything runs.
  for (const t of offered.values()) {
    const props = (t.inputSchema as { properties?: Record<string, unknown> }).properties;
    if (props && Object.hasOwn(props, 'reason')) throw new Error(`MeterMCP tool ${t.name} declares its own reason parameter, which the agent reserves`);
  }
  const decls: FunctionDecl[] = [...[...offered.values()].map((t) => ({ name: t.name, description: t.description, parameters: withReason(t.inputSchema) })), FINISH];
  const system = systemPrompt();
  const transcript: TranscriptEntry[] = [{ role: 'user', text: goalEntry(input.goal, input.cap, [...offered.values()]) }];
  const capCents = toCents(input.cap) ?? 0;
  /** From the last metering or get_balance; null before any budget. */
  let remainingCents: number | null = null;
  /**
   * open_budget was called and its answer was not a definitive refusal, but no session id came back (lost answer,
   * unexpected shape): a session may exist on this MCP connection, so settlement still closes and reads its receipt.
   */
  let budgetUnknown = false;
  let fixed: AgentModel | null = null;
  let stepN = 0;
  let actions = 0;
  let invalidInRow = 0;
  let finished: End | null = null;

  const limitStop = (): End | null => {
    if (signal?.aborted) return end('interrupted');
    if (persistFailed) return end('stopped', 'persistence');
    if (actions >= L.maxActions) return end('stopped', 'max_actions');
    if (agentMs() >= L.maxAgentMs) return end('stopped', 'max_time');
    if (usage.modelCalls >= L.maxModelCalls) return end('stopped', 'max_model_calls');
    return null;
  };

  const emitUsage = (m: AgentModel) =>
    emit({ type: 'usage', provider: m.provider, model: m.model, modelCalls: usage.modelCalls, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, reported: allReported });

  /**
   * One model turn. The first turn tries the primary (with retries), then the fallback, which then stays the
   * provider; after the first answer the provider is fixed. Every attempt counts toward usage: its estimated input,
   * or the provider's reported figures when an answer came.
   */
  const ask = async (): Promise<{ kind: 'turn'; turn: ModelTurn } | { kind: 'unreadable' } | { kind: 'stop'; end: End }> => {
    const candidates = fixed ? [fixed] : [o.models.primary, ...(o.models.fallback ? [o.models.fallback] : [])];
    for (const m of candidates) {
      for (let attempt = 0; ; attempt++) {
        const stop = limitStop();
        if (stop) return { kind: 'stop', end: stop };
        const req: TurnRequest = { system, transcript: [...transcript], tools: decls, maxOutputTokens: L.maxOutputTokens };
        const est = estimateTokens(req);
        if (est > L.maxInputTokens) return { kind: 'stop', end: end('stopped', 'model_budget') };
        const left = L.runTokenBudget - usage.inputTokens - usage.outputTokens;
        if (est + req.maxOutputTokens > left) {
          req.maxOutputTokens = left - est;
          if (req.maxOutputTokens < MIN_OUTPUT_TOKENS) return { kind: 'stop', end: end('stopped', 'model_budget') };
        }
        usage.modelCalls += 1;
        let turn: ModelTurn;
        try {
          turn = await m.turn(req);
        } catch (e) {
          usage.inputTokens += est;
          allReported = false;
          await emitUsage(m);
          if (isToolUseFailed(e)) {
            // The model answered, with an action that could not be read: an invalid turn, not an unavailable model.
            fixed = m;
            result.provider = m.provider;
            result.model = m.model;
            return { kind: 'unreadable' };
          }
          if (e instanceof ModelError && e.retryable && attempt < RETRIES) {
            const wait = e.retryAfterMs != null ? Math.min(e.retryAfterMs, RETRY_AFTER_MAX_MS) : BACKOFF_MS[attempt]!;
            if (!(await pause(wait))) return { kind: 'stop', end: end('interrupted') };
            continue;
          }
          break;
        }
        if (turn.usage.reported) {
          usage.inputTokens += turn.usage.inputTokens;
          usage.outputTokens += turn.usage.outputTokens;
        } else {
          // Not reported: counted as the estimate in and the most it could have written out.
          usage.inputTokens += est;
          usage.outputTokens += req.maxOutputTokens;
          allReported = false;
        }
        fixed = m;
        result.provider = m.provider;
        result.model = m.model;
        await emitUsage(m);
        return { kind: 'turn', turn };
      }
    }
    return { kind: 'stop', end: end('model_unavailable') };
  };

  const newStep = (kind: Step['kind'], tool: string | null, args: Record<string, unknown> | null, reason: string): Step => ({
    n: ++stepN,
    at: now().toISOString(),
    state: 'pending',
    kind,
    tool,
    arguments: args,
    reason,
    summary: '',
    metering: null,
  });

  /** Announce a step before its first MeterMCP call (write-ahead). False (and the run ends) when it must not run. */
  const begin = async (step: Step): Promise<boolean> => {
    if (signal?.aborted) {
      finished = end('interrupted');
      return false;
    }
    await emit({ type: 'step_started', step });
    if (persistFailed) {
      finished = end('stopped', 'persistence');
      return false;
    }
    return true;
  };

  /** Record a step as answered (an uncertain paid call stays uncertain). */
  const done = async (step: Step) => {
    if (step.state === 'pending') step.state = 'done';
    result.steps.push(step);
    await emit({ type: 'step', step });
  };

  /** The model's call and what came back, for the next turn. */
  const observe = (c: ModelCall, body: unknown) => {
    transcript.push({ role: 'model', call: { name: c.name, arguments: c.arguments }, ...(c.providerData !== undefined ? { providerData: c.providerData } : {}) });
    transcript.push({ role: 'tool', name: c.name, result: body });
  };

  /** An invalid action: told to the model once; the second in a row ends the run. */
  const invalid = async (c: ModelCall | null, reason: string, summary: string) => {
    const step = newStep('invalid', c ? oneLine(c.name, 64) : null, null, reason);
    step.summary = summary;
    if (c) observe(c, { error: 'invalid_action', message: summary });
    else transcript.push({ role: 'user', text: `Observation (from the agent's code): ${summary}` });
    await done(step);
    invalidInRow += 1;
    if (invalidInRow >= 2) finished = end('stopped', 'invalid_action');
  };

  const insufficient = async (step: Step, c: ModelCall, tool: MeterTool, availableCents: number) => {
    step.kind = 'insufficient_balance';
    step.summary = `${tool.name} costs ${tool.price} USD; only ${usd(availableCents)} USD is available. Not called.`;
    observe(c, { error: 'insufficient_balance', price: tool.price, available: usd(availableCents) });
    await done(step);
  };

  /** open_budget for the requested cap, then wait for the person's approval. null once active, else how the run ends. */
  const openBudget = async (): Promise<{ end: End; summary: string } | null> => {
    const a = await callMeter('open_budget', { cap: input.cap, fail_first: input.failFirst, ...(input.returnTo ? { return_to: input.returnTo } : {}) });
    if (a.isError || typeof a.body.session_id !== 'string') {
      const why = a.body.message ? ` (${oneLine(a.body.message, 160)})` : '';
      const code = typeof a.body.error === 'string' ? a.body.error : null;
      // budget_exists: a session does exist on this connection, so it is settled like an unknown one.
      if (code && BUDGET_REFUSALS.has(code) && a.body.session_id === undefined) {
        if (code === 'budget_exists') budgetUnknown = true;
        return { end: end('stopped', 'budget_unavailable'), summary: `Budget not opened: ${code}${why}. Not called.` };
      }
      budgetUnknown = true;
      return { end: end('stopped', 'budget_unavailable'), summary: `Budget state unknown: ${code ?? 'no session id in the answer'}${why}. Not called; the receipt will show whether a budget was opened.` };
    }
    result.sessionId = a.body.session_id;
    result.orderId = typeof a.body.order_id === 'string' ? a.body.order_id : null;
    await emit({ type: 'awaiting_approval', approvalUrl: String(a.body.approval_url ?? ''), sessionId: a.body.session_id, orderId: result.orderId ?? '', cap: String(a.body.cap ?? input.cap) });
    const waitStart = now().getTime();
    try {
      for (;;) {
        if (signal?.aborted) return { end: end('interrupted'), summary: 'Interrupted while waiting for approval. Not called.' };
        if (persistFailed) return { end: end('stopped', 'persistence'), summary: 'The run could not be saved. Not called.' };
        const b = await callMeter('get_balance', {});
        if (!b.isError && b.body.status === 'active') break;
        // A MeterMCP error while polling is transient; any status but pending_approval is final.
        if (!b.isError && b.body.status !== 'pending_approval') return { end: end('not_approved'), summary: `Budget not approved (${oneLine(b.body.status, 40)}). Not called.` };
        if (now().getTime() - waitStart >= L.approvalTimeoutMs) return { end: end('stopped', 'approval_timeout'), summary: `Not approved within ${duration(L.approvalTimeoutMs)}. Not called.` };
        if (!(await pause(POLL_MS))) return { end: end('interrupted'), summary: 'Interrupted while waiting for approval. Not called.' };
      }
    } finally {
      approvalWaitMs += now().getTime() - waitStart;
    }
    await emit({ type: 'approved', cap: input.cap });
    if (signal?.aborted) return { end: end('interrupted'), summary: 'Interrupted after approval, before the call. Not called.' };
    if (persistFailed) return { end: end('stopped', 'persistence'), summary: 'The run could not be saved. Not called.' };
    return null;
  };

  /** Make the paid call the step stands for and record its metering. */
  const pay = async (step: Step, c: ModelCall, tool: MeterTool, args: Record<string, unknown>) => {
    const a = await callMeter(tool.name, args);
    const m = a.body.metering as Record<string, any> | undefined;
    // An answer is MeterMCP's metering, or a refusal with an error code; anything else leaves the charge unknown.
    const answered = (m && (m.status === 'OK' || m.status === 'FAILED')) || (a.isError && typeof a.body.error === 'string' && a.body.error !== 'meter_unreachable');
    if (!answered) {
      step.state = 'uncertain';
      step.summary = UNCERTAIN_SUMMARY;
      remainingCents = null;
      observe(c, { error: 'result_unknown', message: UNCERTAIN_SUMMARY });
      await done(step);
      return;
    }
    if (m && (m.status === 'OK' || m.status === 'FAILED')) {
      step.metering = { status: m.status, price: String(m.price ?? tool.price), charged: m.status === 'OK', remaining: String(m.remaining), injected: m.status === 'FAILED' ? injectedOf(a.body) : null };
    }
    const rem = toCents(m?.remaining ?? a.body.remaining);
    if (rem != null) remainingCents = rem;
    step.summary = summarize(tool.name, a);
    observe(c, a.body);
    await done(step);
  };

  const act = async (c: ModelCall) => {
    const reason = typeof c.arguments.reason === 'string' ? [...c.arguments.reason].slice(0, REASON_MAX).join('') : '';
    if ('__unparsed' in c.arguments) return invalid(c, reason, `The arguments of ${oneLine(c.name, 64)} could not be read as JSON.`);
    if (c.name === 'finish') {
      const errors = validate(FINISH.parameters, c.arguments);
      if (errors.length) return invalid(c, reason, `Invalid arguments for finish: ${oneLine(errors.join('; '), 200)}.`);
      const outcome = c.arguments.outcome as (typeof FINISH_OUTCOMES)[number];
      const answer = String(c.arguments.answer);
      const step = newStep('finish', null, { outcome, answer }, reason);
      step.summary = oneLine(`Finished: ${outcome} · ${answer}`);
      result.answer = answer;
      await done(step);
      finished = end(outcome);
      return;
    }
    const tool = offered.get(c.name);
    if (!tool) {
      const name = oneLine(c.name, 64);
      return invalid(c, reason, known.has(c.name) ? `${name} is not offered to the agent: budgets and settlement are done by code. Use one of the offered tools.` : `${name} is unknown: use one of the offered tools.`);
    }
    const { reason: _r, ...args } = c.arguments;
    const errors = [...(c.arguments.reason === undefined ? ['reason is required'] : typeof c.arguments.reason !== 'string' ? ['reason must be a string'] : []), ...validate(tool.inputSchema, args)];
    if (errors.length) return invalid(c, reason, `Invalid arguments for ${tool.name}: ${oneLine(errors.join('; '), 200)}.`);
    invalidInRow = 0;
    actions += 1;
    const step = newStep(tool.price === null ? 'free' : 'call', tool.name, args, reason);

    if (tool.price === null) {
      if (!(await begin(step))) return;
      const a = await callMeter(tool.name, args);
      if (tool.name === 'get_balance' && !a.isError && a.body.status === 'active') {
        const rem = toCents(a.body.remaining);
        if (rem != null) remainingCents = rem;
      }
      step.summary = summarize(tool.name, a);
      observe(c, a.body);
      await done(step);
      return;
    }

    const price = toCents(tool.price) ?? Infinity;
    if (result.sessionId === null) {
      // Before any budget: the price must fit the cap, or nothing is opened in PayPal.
      if (price > capCents) return insufficient(step, c, tool, capCents);
      if (!(await begin(step))) return;
      const stop = await openBudget();
      if (stop) {
        step.summary = stop.summary;
        await done(step);
        finished = stop.end;
        return;
      }
      const b = await callMeter('get_balance', {});
      const rem = b.isError || b.body.status !== 'active' ? null : toCents(b.body.remaining);
      if (rem == null) {
        // Not an invalid action: the model chose well, the balance could not be checked.
        step.summary = BALANCE_UNREAD;
        observe(c, { error: 'balance_unavailable', message: BALANCE_UNREAD });
        await done(step);
        return;
      }
      remainingCents = rem;
      if (price > remainingCents) return insufficient(step, c, tool, remainingCents);
      // As begin: no paid call once aborted or not saved.
      const late = signal?.aborted ? end('interrupted') : persistFailed ? end('stopped', 'persistence') : null;
      if (late) {
        step.summary = late.outcome === 'interrupted' ? 'Interrupted after approval, before the call. Not called.' : 'The run could not be saved. Not called.';
        await done(step);
        finished = late;
        return;
      }
      return pay(step, c, tool, args);
    }
    if (remainingCents !== null && price > remainingCents) return insufficient(step, c, tool, remainingCents);
    if (!(await begin(step))) return;
    return pay(step, c, tool, args);
  };

  try {
    while (!finished) {
      const stop = limitStop();
      if (stop) {
        finished = stop;
        break;
      }
      const asked = await ask();
      if (asked.kind === 'stop') {
        finished = asked.end;
        break;
      }
      // Aborted or not saved while the model answered: its action is not carried out.
      if (signal?.aborted) finished = end('interrupted');
      else if (persistFailed) finished = end('stopped', 'persistence');
      else if (asked.kind === 'unreadable') await invalid(null, '', "The model's tool call could not be read; one valid action is required.");
      else if (asked.turn.calls.length !== 1) {
        const n = asked.turn.calls.length;
        await invalid(null, '', n === 0 ? 'The model returned no action.' : `The model returned ${n} actions; one is required.`);
      } else await act(asked.turn.calls[0]!);
    }
  } finally {
    await settle();
  }
  result.outcome = finished.outcome;
  result.stopReason = finished.stopReason;
  usage.reported = usage.modelCalls > 0 && allReported;
  return result;

  /**
   * Close the session and read its receipt; the settlement is only what a receipt of this session says. 'none' only
   * when no budget was ever asked for, or MeterMCP definitively refused it.
   */
  async function settle() {
    if (!result.sessionId && !budgetUnknown) return;
    try {
      await meter.call('close_session', {});
    } catch {
      /* the receipt says what happened */
    }
    let r: MeterAnswer | null = null;
    try {
      r = await meter.call('get_receipt', {});
    } catch {
      r = null;
    }
    const rc = r && !r.isError ? r.body : null;
    const status = rc?.settlement?.status;
    // The receipt must be this run's session; with no id known yet, the connection's own session is the run's.
    const sameSession = result.sessionId ? rc?.session?.id === result.sessionId : typeof rc?.session?.id === 'string';
    if (rc && sameSession && typeof status === 'string' && SETTLEMENTS.has(status)) {
      result.sessionId = rc.session.id;
      result.settlement = status as Settlement;
      result.receipt = rc;
      result.receiptSha256 = typeof rc.receipt_sha256 === 'string' ? rc.receipt_sha256 : null;
      result.captureId = typeof rc.settlement.capture_id === 'string' ? rc.settlement.capture_id : null;
      if (typeof rc.mandate?.order_id === 'string') result.orderId = rc.mandate.order_id;
    } else result.settlement = 'unverified';
  }
}
