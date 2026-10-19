/**
 * The held-out batch's budget guard. It wraps the RAW provider model (below withRetries), so every HTTP attempt,
 * retries included, is checked and counted. Before each attempt it reserves the worst case at list price and refuses
 * the call (BudgetExceeded, before anything is sent) when that does not fit what is left; after it, it settles:
 *
 * - observed: the provider reported usage, at list price (thinking counted as output);
 * - unknown: the call failed after being sent with no usage reported, so its whole reservation stays counted, never
 *   released (a failure cannot tell whether anything was billed);
 * - estimated: a reservation not settled yet (a call in flight, or a process that died mid-call).
 *
 * All three count against the limit. A call that reports more input than its input estimate, or more output +
 * thinking than it reserved (rulings B12, B22), stops the batch: its cost could not be bounded, so no further call is
 * started. The limit is a local guard on list-price estimates, not a guarantee of the provider's invoice.
 *
 * A ledger with no limit (limitUsd null: Groq, ruling B22) is not USD-guarded: nothing is refused for money and an
 * exceeded reservation is counted without stopping; reservations and settlements are still recorded, for accounting,
 * at the same (Gemini) list price, which is not a Groq price. Such a batch stops on its quota or provider errors only.
 */
import { ModelError, type AnalystModel, type ModelRequest } from '../src/model.ts';
import type { CallUsage } from '../src/types.ts';

export const LIST_PRICE = { inputPerM: 0.75, outputPerM: 3.75 };
/**
 * The least output a provider may produce whatever the request asks: GroqModel floors max_completion_tokens at 1024
 * (providers.ts), so a smaller cap is reserved as 1024.
 */
export const OUTPUT_FLOOR_TOKENS: Readonly<Record<string, number>> = { groq: 1024 };
export const RESERVATION_EXCEEDED = 'reservation exceeded: the cost of a call could not be bounded';

/** The input estimate: ceil(chars / 4) tokens, times a 25 % margin. */
export const CHARS_PER_TOKEN = 4;
export const INPUT_MARGIN = 1.25;

export const BUDGET_NOTE = "The limit is a local guard on list-price estimates, not a guarantee of the provider's invoice.";
/** The words every Groq money figure carries (ruling B22). */
export const NOT_A_GROQ_PRICE = 'estimated at Gemini list price, not a Groq price';
export const UNGUARDED_NOTE = `Not USD-guarded (ruling B22): the USD figures are ${NOT_A_GROQ_PRICE}, kept for accounting only; the batch runs within the provider's free quota and stops on a 429 or a provider error.`;
/** The note a ledger and its attempts carry: the guard's, or, with no limit, the unguarded one. */
export const budgetNote = (limitUsd: number | null) => (limitUsd === null ? UNGUARDED_NOTE : BUDGET_NOTE);

/** Why a batch stopped (ruling B22): every stop is recorded in the ledger with its reason. */
export interface StopRecord {
  kind: 'budget' | 'quota' | 'provider';
  reason: string;
  case: string;
  run: number;
  at: string;
}

export interface Ledger {
  provider: string;
  /** Null: not USD-guarded (Groq, ruling B22). */
  limitUsd: number | null;
  observedUsd: number;
  estimatedUsd: number;
  unknownUsd: number;
  /** Guard checks (one per HTTP attempt asked for) and how many were refused. */
  checks: number;
  refusals: number;
  /** Set by the first refusal (or exceeded reservation): every later call is refused too, so a refusal the pipeline swallows still stops the batch. */
  stopped: boolean;
  /** Calls that reported more input, or more output + thinking, than their reservation (each one stops a guarded batch). */
  exceeded: number;
  /** The freeze the first batch ran on (rulings B14, B22): every later batch must run on the same one. */
  freeze?: { commit: string; hash: string; casesHash: string };
  /** Every time a batch stopped, with its reason (ruling B22). */
  stops: StopRecord[];
  note: string;
}

export const newLedger = (provider: string, limitUsd: number | null): Ledger => ({ provider, limitUsd, observedUsd: 0, estimatedUsd: 0, unknownUsd: 0, checks: 0, refusals: 0, stopped: false, exceeded: 0, stops: [], note: budgetNote(limitUsd) });

/** Everything counted against the limit. */
export const committedUsd = (l: Ledger) => l.observedUsd + l.estimatedUsd + l.unknownUsd;

const usd = (inputTokens: number, outputTokens: number) => (inputTokens * LIST_PRICE.inputPerM + outputTokens * LIST_PRICE.outputPerM) / 1e6;

/**
 * The worst case of one request: input estimated from everything sent (system, user and the response schema), the
 * whole output cap, plus the thinking reservation (billed as output).
 */
export function reservationUsd(req: ModelRequest, thinkingReserveTokens: number, outputFloorTokens = 0): { inputTokens: number; outputTokens: number; usd: number } {
  const chars = req.system.length + req.user.length + JSON.stringify(req.schema).length;
  const inputTokens = Math.ceil(Math.ceil(chars / CHARS_PER_TOKEN) * INPUT_MARGIN);
  const outputTokens = Math.max(req.maxOutputTokens, outputFloorTokens) + thinkingReserveTokens;
  return { inputTokens, outputTokens, usd: usd(inputTokens, outputTokens) };
}

/** A reported call at list price: thinking tokens are billed as output. */
export const usageUsd = (u: CallUsage) => usd(u.inputTokens, u.outputTokens + u.thinkingTokens);

export class BudgetExceeded extends ModelError {
  constructor(needUsd: number, remainingUsd: number) {
    // Not retryable: withRetries rethrows it at once, without sleeping or asking again.
    super(`budget: the next call could cost up to ${needUsd.toFixed(4)} USD and ${Math.max(0, remainingUsd).toFixed(4)} USD is left. ${BUDGET_NOTE}`, { retryable: false });
    this.name = 'BudgetExceeded';
  }
}

/** What happened to one HTTP attempt, for the attempt's own usage record. */
export type GuardEvent =
  | { kind: 'observed'; usage: CallUsage; usd: number }
  | { kind: 'unknown'; usd: number; error: unknown }
  | { kind: 'refused'; needUsd: number; remainingUsd: number }
  | { kind: 'exceeded'; reservedOutputTokens: number; reportedOutputTokens: number; reservedInputTokens: number; reportedInputTokens: number };

/** Wraps the RAW provider model (below withRetries), so each HTTP attempt is guarded and counted. */
export function budgetGuard(model: AnalystModel, o: { ledger: Ledger; thinkingReserveTokens: number; onEvent?: (e: GuardEvent) => void; onChange?: (l: Ledger) => void }): AnalystModel {
  const l = o.ledger;
  return {
    provider: model.provider,
    model: model.model,
    async generate(req) {
      // Reserve synchronously, before the first await: calls the pipeline makes in parallel see each other.
      const reserved = reservationUsd(req, o.thinkingReserveTokens, OUTPUT_FLOOR_TOKENS[model.provider] ?? 0);
      const need = reserved.usd;
      // No limit (B22): nothing is refused for money; a stopped ledger still refuses.
      const remaining = l.limitUsd === null ? Infinity : l.limitUsd - committedUsd(l);
      l.checks++;
      if (l.stopped || need > remaining) {
        l.refusals++;
        l.stopped = true;
        o.onEvent?.({ kind: 'refused', needUsd: need, remainingUsd: remaining });
        o.onChange?.(l);
        throw new BudgetExceeded(need, remaining);
      }
      l.estimatedUsd += need;
      o.onChange?.(l);
      try {
        const r = await model.generate(req);
        const cost = usageUsd(r.usage);
        l.estimatedUsd -= need;
        l.observedUsd += cost;
        o.onEvent?.({ kind: 'observed', usage: r.usage, usd: cost });
        const reported = r.usage.outputTokens + r.usage.thinkingTokens;
        if (reported > reserved.outputTokens || r.usage.inputTokens > reserved.inputTokens) {
          // The bound did not hold: start nothing more (the answer itself is returned and counted as observed).
          // Without a limit it is only counted (B22).
          l.exceeded++;
          if (l.limitUsd !== null) l.stopped = true;
          o.onEvent?.({ kind: 'exceeded', reservedOutputTokens: reserved.outputTokens, reportedOutputTokens: reported, reservedInputTokens: reserved.inputTokens, reportedInputTokens: r.usage.inputTokens });
        }
        return r;
      } catch (e) {
        l.estimatedUsd -= need;
        l.unknownUsd += need;
        o.onEvent?.({ kind: 'unknown', usd: need, error: e });
        throw e;
      } finally {
        // Float residue from adding and removing the same reservation is not money.
        if (Math.abs(l.estimatedUsd) < 1e-12) l.estimatedUsd = 0;
        o.onChange?.(l);
      }
    },
  };
}
