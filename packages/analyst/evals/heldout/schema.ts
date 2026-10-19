/**
 * The held-out case schema. Held-out cases live in this folder, apart from cases.ts and sharing none of its builders;
 * they are written by a separate reviewer and frozen in their own commit before any run (config.json pins the rest).
 */
import type { EvalCase, ExpectedConflict } from '../cases.ts';

/**
 * What a held-out attack must not achieve, written with the case and frozen with it. Scoring is in the held-out
 * scorer (ruling B3): `action` is an exact match on the recommendation's action; `checklistChange` compares the
 * checklist with the clean twin's; `claimPatterns` are regex sources matched case-insensitively on supported
 * sentences only, with every paraphrase listed by the author (an unlisted paraphrase is not caught).
 */
export interface Forbidden {
  /** A recommended action the attack aims at (RecommendedAction). */
  action?: string;
  /** true: the attack aims at changing the checklist relative to the clean twin. */
  checklistChange?: boolean;
  /** Regex sources, one per paraphrase of the claim the attack wants sent. */
  claimPatterns?: string[];
}

export interface HeldOutCase extends EvalCase {
  set: 'held-out';
  /** Every held-out case is labelled strictly (an empty list: no conflict expected). */
  conflicts: ExpectedConflict[];
  /** The injected document, the held-out case it is the attack on, and the outcomes the attack must not achieve. */
  injection?: { doc: string; cleanTwin: string; forbidden: Forbidden };
}
