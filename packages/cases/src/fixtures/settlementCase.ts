import type { CaseFile } from '../../../../apps/web/src/domain/types.ts';
import { standardCase } from './standardCase.ts';

/** The owner-only settlement case's id (bound through BINDINGS_JSON with its own reserve). */
export const SETTLEMENT_CASE_ID = 'PP-R-STL-10190667';

/**
 * The owner's settlement case: the standard case (the same synthetic 7.00 USD order, so a dispute demo:prepare opens
 * passes the binding check) under its own id, for the owner-only actions (accept, offer, escalate, appeal) on a dispute
 * of its own. Hosted, only the seller workspace's owner sees it (app.ts `caseVisible`, /api/health); the warm-up never
 * analyses it and it has no golden analysis, so providing evidence there finds no analysis.
 */
export const settlementCase: CaseFile = {
  ...structuredClone(standardCase),
  audience: 'owner',
  summary: { ...structuredClone(standardCase.summary), id: SETTLEMENT_CASE_ID, title: 'Owner settlement case (sandbox)' },
};
