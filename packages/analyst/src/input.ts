/**
 * The analyst's input from a case file as the merchant sees it (after PayPal's and MeterMCP's data are applied):
 * every document's text, one line per row, with the fragment key the web app highlights. Labels and captions are
 * left out so that only content decides the cache key.
 */
import type { CaseFile, Evidence } from '../../../apps/web/src/domain/types.ts';
import type { AnalysisDocument, AnalysisInput, DocLine } from './types.ts';

export function evidenceDocLines(e: Evidence): DocLine[] {
  const b = e.body;
  const lines: DocLine[] = [];
  // PayPal records carry the read time in `received`: it changes on every read, so it is not content.
  if (e.meta?.received && !e.paypalRecord) lines.push({ text: `Received: ${e.meta.received} (from ${e.meta.source})` });
  switch (b.kind) {
    case 'lines':
      for (const l of b.lines) lines.push(l.fragment ? { text: l.text, fragment: l.fragment } : { text: l.text });
      break;
    case 'mandate':
      lines.push({ text: b.headline });
      for (const r of b.rows) lines.push({ text: `${r.label}: ${r.value}`, fragment: r.fragment });
      break;
    case 'receipt':
      for (const c of b.calls) {
        lines.push({ text: `#${c.n} ${c.time} ${c.tool} ${c.price} ${b.currency} ${c.ok ? 'OK' : 'FAILED · not charged'} · request ${c.hash}`, fragment: c.fragment });
      }
      if (b.cap) lines.push({ text: `Approved budget ${b.cap} ${b.currency}` });
      break;
    case 'settlement':
      lines.push({ text: b.headline });
      for (const r of b.rows) lines.push({ text: `${r.label}: ${r.value}`, fragment: r.fragment });
      break;
  }
  return lines;
}

const TAG_BY_KIND: Record<string, string> = { mandate: 'PP', settlement: 'PP', receipt: 'MCP' };

export function evidenceDocument(e: Evidence): AnalysisDocument {
  return {
    id: e.id,
    title: e.title,
    type: e.meta?.type ?? (e.body.kind === 'lines' ? 'Document' : e.body.kind),
    source: e.meta?.source ?? (e.body.kind === 'mandate' || e.body.kind === 'settlement' ? 'PayPal' : 'MeterMCP'),
    tag: e.meta?.tag ?? TAG_BY_KIND[e.body.kind] ?? 'MCP',
    lines: evidenceDocLines(e),
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const pad = (n: number) => String(n).padStart(2, '0');
function utcText(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

/** PayPal's dispute record as a document ("D"): citable for the timeline, never shown as evidence. */
export function disputeDocument(c: CaseFile): AnalysisDocument {
  const s = c.summary;
  const opened = s.openedAt ? utcText(s.openedAt) : null;
  const lines: DocLine[] = [
    { text: `Dispute ${s.id} · reason ${s.reason}` },
    { text: `Reason as shown to the merchant: ${s.reasonText}` },
    { text: `Buyer-declared item type: ${s.buyerItemType}` },
    { text: `Disputed amount: ${s.amount} ${s.currency}` },
    ...(opened ? [{ text: `Opened: ${opened}` }] : []),
    ...(s.stage ? [{ text: `Stage: ${s.stage}` }] : []),
  ];
  return { id: 'D', title: `PayPal dispute ${s.id}`, type: 'Dispute record', source: 'PayPal', tag: 'PP', lines };
}

export interface InputOptions {
  /** Actions PayPal allows now (the latest read); defaults to the case's. */
  allowedActions?: readonly string[];
}

export function buildInput(c: CaseFile, o: InputOptions = {}): AnalysisInput {
  return {
    caseId: c.summary.id,
    caseKind: c.kind,
    dispute: {
      id: c.summary.id,
      reason: c.summary.reason,
      buyerItemType: c.summary.buyerItemType,
      amount: c.summary.amount,
      currency: c.summary.currency,
      allowedActions: [...(o.allowedActions ?? c.allowedActions)],
      requestedEvidence: c.requestedEvidenceType,
      evidenceOptions: c.evidenceTypes.map((t) => ({ type: t.type, satisfied: t.satisfied })),
    },
    documents: [disputeDocument(c), ...c.evidence.map(evidenceDocument)],
    merchantNotes: (c.merchantNotes ?? []).map((text, i) => ({ id: `N${i + 1}`, text })),
  };
}
