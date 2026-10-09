/**
 * Hosted mode: before the model sees an analysis input, check it against the server's own copy of the demo case.
 * Stored analyses can be looked up with any well-formed input (that only finds what already exists), but a live run
 * or a re-check only runs on content the server can vouch for:
 *
 * - the case id and kind are a demo case's, and the document list is exactly that case's (PayPal record D + E1…En);
 * - every merchant-side document (the synthetic case documents) is line for line the server's fixture;
 * - the merchant notes are the fixture's;
 * - the documents that carry PayPal or MeterMCP data (PayPal's dispute record D, the bound case's capture, the agent
 *   case's mandate, receipt, settlement and receipt PDF) are filled in by the browser from the latest PayPal /
 *   MeterMCP read; they are only shape-checked here (few, short lines), since the server would have to re-read PayPal
 *   and MeterMCP to rebuild them.
 *
 * So free text from a client can never reach the model; what can vary is bounded structured data, and only for users
 * who unlocked the demo, within the caps.
 */
import { evidenceDocument, type AnalysisInput } from '@resolvekit/analyst';
import { CASE_FILES } from './documents.ts';

/** Agent-case documents that the web app fills from the real MeterMCP session (see web domain/agentSession.ts). */
const METERMCP_DOCS = new Set(['E1', 'E2', 'E3', 'E4']);
const DATA_DOC_MAX_LINES = 40;
const DATA_LINE_MAX = 300;

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** null when the input may go to the model; otherwise why not. */
export function unanchoredInput(input: AnalysisInput): string | null {
  const c = CASE_FILES[input.caseId];
  if (!c) return `${input.caseId} is not a demo case`;
  if (input.caseKind !== c.kind) return 'caseKind is not the demo case’s';
  if (input.dispute.id !== input.caseId) return 'dispute.id is not the case id';
  const ids = input.documents.map((d) => d.id);
  const expected = ['D', ...c.evidence.map((e) => e.id)];
  if (!sameJson(ids, expected)) return `documents must be ${expected.join(', ')}`;
  if (!sameJson(input.merchantNotes.map((n) => n.text), c.merchantNotes ?? [])) return 'merchant notes are not the demo case’s';

  for (const doc of input.documents) {
    const e = c.evidence.find((x) => x.id === doc.id);
    const fromData = doc.id === 'D' || e?.paypalRecord === 'capture' || (c.kind === 'agent' && METERMCP_DOCS.has(doc.id));
    if (fromData) {
      if (doc.lines.length > DATA_DOC_MAX_LINES || doc.lines.some((l) => l.text.length > DATA_LINE_MAX)) return `document ${doc.id} is not PayPal/MeterMCP-shaped data`;
      continue;
    }
    const mine = evidenceDocument(e!);
    if (!sameJson({ ...doc }, { ...mine })) return `document ${doc.id} is not the demo case’s document`;
  }
  return null;
}
