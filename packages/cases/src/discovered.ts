import type { CaseFile } from '../../../apps/web/src/domain/types.ts';
import { agentCase } from './fixtures/agentCase.ts';
import { SETTLEMENT_CASE_ID } from './fixtures/settlementCase.ts';
import { standardCase } from './fixtures/standardCase.ts';
import { CASE_FILES } from './index.ts';

/** Which fixed case a discovered dispute is cloned from. */
export type CaseTemplate = 'standard' | 'settlement' | 'agent';

export const TEMPLATE_CASE_IDS: Readonly<Record<CaseTemplate, string>> = {
  standard: standardCase.summary.id,
  settlement: SETTLEMENT_CASE_ID,
  agent: agentCase.summary.id,
};

const STANDARD = /^rk-std-[A-Za-z0-9_-]+$/;
const SETTLEMENT = /^rk-stl-[A-Za-z0-9_-]+$/;
const AGENT = /^mm-sess-[0-9a-f]{32}-settle$/;

/** The template for an order's invoice id (its reference), or null when the order is not a ResolveKit one. */
export function templateForOrderRef(invoiceId: string | null | undefined): { template: CaseTemplate; orderRef: string } | null {
  if (!invoiceId) return null;
  if (STANDARD.test(invoiceId)) return { template: 'standard', orderRef: invoiceId };
  if (SETTLEMENT.test(invoiceId)) return { template: 'settlement', orderRef: invoiceId };
  if (AGENT.test(invoiceId)) return { template: 'agent', orderRef: invoiceId };
  return null;
}

/** A copy of the template's case file under the discovered dispute's id; everything else is unchanged. */
export function discoveredCaseFile(template: CaseTemplate, caseId: string): CaseFile {
  const clone = structuredClone(CASE_FILES[TEMPLATE_CASE_IDS[template]]!);
  clone.summary.id = caseId;
  return clone;
}

/** The case file for a case id: a fixed one first, else the discovered clone, else null. */
export function caseFileOf(caseId: string, templateOf: (caseId: string) => CaseTemplate | null): CaseFile | null {
  if (Object.hasOwn(CASE_FILES, caseId)) return CASE_FILES[caseId]!;
  const template = templateOf(caseId);
  return template ? discoveredCaseFile(template, caseId) : null;
}
