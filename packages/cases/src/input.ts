/**
 * The case as the merchant sees it, and the analyst's input built from it. One function for both sides: the web app
 * shows `caseView(…)`, and apps/server builds the analyst's input with `caseInput(…)` from its own fixtures, its own
 * PayPal read and its own MeterMCP read, so the two cannot drift apart.
 */
import { buildInput, canonicalJson, type AnalysisInput } from '@resolvekit/analyst';
import type { ActionCode, CaseFile, DisputeSnapshot } from '../../../apps/web/src/domain/types.ts';
import { withMeterMcp } from './agent.ts';
import { caseAllowedActions, withPayPal, type PayPalSource } from './paypal.ts';

/** The demo case with PayPal's fields (bound case) and, for the agent case, the MeterMCP session applied. */
export function caseView(demo: CaseFile, source: PayPalSource): CaseFile {
  return withMeterMcp(withPayPal(demo, source), source);
}

/** Whether the documents are final: simulated, or bound and read from PayPal. Before that there is nothing to analyse. */
export const documentsFinal = (source: PayPalSource) => source.kind === 'simulated' || source.kind === 'live';

/**
 * The analyst's input for a case as shown. `simulated` is the simulator's snapshot of an unbound case (its allowed
 * actions); the server passes none and gets the demo case's initial ones, which is what the simulator starts with.
 */
export function caseInput(demo: CaseFile, source: PayPalSource, simulated?: DisputeSnapshot): AnalysisInput {
  // Appeal is not an analyst recommendation: filtered out so the analysis keys stay stable when PayPal offers it.
  const allowed: readonly ActionCode[] = caseAllowedActions(source, simulated, demo.allowedActions).filter((a) => a !== 'appeal');
  return buildInput(caseView(demo, source), { allowedActions: allowed });
}

/**
 * The input with the dispute's allowed actions blanked: what decides whether the documents changed. PayPal's allowed
 * actions change once the seller's evidence is in; the documents do not, and neither should the analysis on screen.
 */
export const documentsSignature = (i: AnalysisInput): string => canonicalJson({ ...i, dispute: { ...i.dispute, allowedActions: [] } });
