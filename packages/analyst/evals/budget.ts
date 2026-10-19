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
 * All three count against the limit. The limit is a local guard on list-price estimates, not a guarantee of the
 * provider's invoice.
 */
import { ModelError, type AnalystModel, type ModelRequest } from '../src/model.ts';
import type { CallUsage } from '../src/types.ts';

export const LIST_PRICE = { inputPerM: 0.75, outputPerM: 3.75 };
/** The input estimate: ceil(chars / 4) tokens, times a 25 % margin. */
export const CHARS_PER_TOKEN = 4;
export const INPUT_MARGIN = 1.25;

export const BUDGET_NOTE = "The limit is a local guard on list-price estimates, not a guarantee of the provider's invoice.";

export interface Ledger {
  provider: string;
  limitUsd: number;
  observedUsd: number;
  estimatedUsd: number;
  unknownUsd: number;
  /** Guard checks (one per HTTP attempt asked for) and how many were refused. */
  checks: number;
  refusals: number;
  /** Set by the first refusal: every later call is refused too, so a refusal the pipeline swallows still stops the batch. */
  stopped: boolean;
  note: string;
}

export const newLedger = (provider: string, limitUsd: number): Ledger => ({ provider, limitUsd, observedUsd: 0, estimatedUsd: 0, unknownUsd: 0, checks: 0, refusals: 0, stopped: false, note: BUDGET_NOTE });

/** Everything counted against the limit. */
export const committedUsd = (l: Ledger) => l.observedUsd + l.estimatedUsd + l.unknownUsd;

const usd = (inputTokens: number, outputTokens: number) => (inputTokens * LIST_PRICE.inputPerM + outputTokens * LIST_PRICE.outputPerM) / 1e6;

/**
 * The worst case of one request: input estimated from everything sent (system, user and the response schema), the
 * whole output cap, plus the thinking reservation (billed as output).
 */
export function reservationUsd(req: ModelRequest, thinkingReserveTokens: number): { inputTokens: number; outputTokens: number; usd: number } {
  const chars = req.system.length + req.user.length + JSON.stringify(req.schema).length;
  const inputTokens = Math.ceil(Math.ceil(chars / CHARS_PER_TOKEN) * INPUT_MARGIN);
  const outputTokens = req.maxOutputTokens + thinkingReserveTokens;
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
  | { kind: 'refused'; needUsd: number; remainingUsd: number };

/** Wraps the RAW provider model (below withRetries), so each HTTP attempt is guarded and counted. */
export function budgetGuard(model: AnalystModel, o: { ledger: Ledger; thinkingReserveTokens: number; onEvent?: (e: GuardEvent) => void; onChange?: (l: Ledger) => void }): AnalystModel {
  const l = o.ledger;
  return {
    provider: model.provider,
    model: model.model,
    async generate(req) {
      // Reserve synchronously, before the first await: calls the pipeline makes in parallel see each other.
      const need = reservationUsd(req, o.thinkingReserveTokens).usd;
      const remaining = l.limitUsd - committedUsd(l);
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
