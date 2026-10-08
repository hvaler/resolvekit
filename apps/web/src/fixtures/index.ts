import type { CaseFile, DisputeSnapshot } from '../domain/types';
import { agentCase } from './agentCase';
import { DEMO_NOW, inbox, processingDispute, processingOpening } from './inbox';
import { standardCase } from './standardCase';

export { agentCase, DEMO_NOW, inbox, processingDispute, processingOpening, standardCase };

export const caseFiles: Readonly<Record<string, CaseFile>> = {
  [standardCase.summary.id]: standardCase,
  [agentCase.summary.id]: agentCase,
};

/** Initial PayPal state of every dispute, as the simulated gateway serves it. */
export const initialSnapshots: DisputeSnapshot[] = [
  ...Object.values(caseFiles).map((c) => ({
    id: c.summary.id,
    status: c.summary.status,
    allowedActions: [...c.allowedActions],
    evidences: [],
    readAt: '',
  })),
  { id: processingDispute.id, status: processingDispute.status, allowedActions: [], evidences: [], readAt: '' },
];
