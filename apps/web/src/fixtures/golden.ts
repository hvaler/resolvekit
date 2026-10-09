import type { CaseAnalysis } from '@resolvekit/analyst';

/**
 * Golden analyses: made by the real model on the demo cases' documents and committed with their provenance
 * (model, date, prompt version, key). The app shows one only when its key matches the documents on screen, so it
 * works without the server or a model key, and it is labelled as cached.
 */
const files = import.meta.glob<CaseAnalysis>('../../../../packages/analyst/golden/*.json', { eager: true, import: 'default' });

export const goldenAnalyses: Readonly<Record<string, CaseAnalysis>> = Object.fromEntries(Object.values(files).map((a) => [a.caseId, a]));
