export * from './paypal.ts';
export * from './agent.ts';
export * from './input.ts';
import type { CaseFile } from '../../../apps/web/src/domain/types.ts';
import { agentCase } from './fixtures/agentCase.ts';
import { standardCase } from './fixtures/standardCase.ts';

export { agentCase, standardCase };

/** The demo cases with a full case file, by case id. */
export const CASE_FILES: Readonly<Record<string, CaseFile>> = {
  [standardCase.summary.id]: standardCase,
  [agentCase.summary.id]: agentCase,
};
