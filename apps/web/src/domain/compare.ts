import { EVIDENCE_TYPE_LABEL } from './evidenceTypes';
import { formatCount } from './draft';
import type { EvidenceSubmission, RecordedEvidence } from './types';

export interface ComparisonRow {
  field: string;
  sent: string;
  recorded: string;
  match: boolean;
}

export interface Comparison {
  rows: ComparisonRow[];
  matched: number;
  total: number;
  allMatch: boolean;
}

const NOT_RECORDED = 'Not recorded';

/**
 * Field-by-field comparison between what we sent and what PayPal reports when the dispute is read
 * back. A field only matches if PayPal's copy is identical; notes are compared on the full text,
 * not only on length.
 */
export function compareSentRecorded(sent: EvidenceSubmission, recorded: RecordedEvidence | null, sentAt: string): Comparison {
  const r = recorded;
  const sentFiles = sent.files.map((f) => f.name);
  const rows: ComparisonRow[] = [
    {
      field: 'Evidence type',
      sent: EVIDENCE_TYPE_LABEL[sent.evidenceType],
      recorded: r ? r.evidenceType : NOT_RECORDED,
      match: !!r && r.evidenceType === sent.evidenceType,
    },
    // Evidence without tracking (type OTHER: notes and documents) has no carrier or tracking to compare.
    ...(sent.carrier || sent.tracking
      ? [
          { field: 'Carrier', sent: sent.carrier, recorded: r ? r.carrier : NOT_RECORDED, match: !!r && r.carrier === sent.carrier },
          { field: 'Tracking number', sent: sent.tracking, recorded: r ? r.tracking : NOT_RECORDED, match: !!r && r.tracking === sent.tracking },
        ]
      : []),
    {
      field: 'Files',
      sent: sentFiles.join('\n'),
      recorded: r ? r.files.join('\n') : NOT_RECORDED,
      match: !!r && sameSet(sentFiles, r.files),
    },
    {
      field: 'Notes',
      sent: `${formatCount(sent.notes.length)} characters`,
      recorded: r ? `${formatCount(r.notes.length)} characters` : NOT_RECORDED,
      match: !!r && r.notes === sent.notes,
    },
    { field: 'Submitted', sent: sentAt, recorded: r ? `Stored ${r.storedAt}` : NOT_RECORDED, match: !!r },
  ];
  const matched = rows.filter((x) => x.match).length;
  return { rows, matched, total: rows.length, allMatch: matched === rows.length };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(b);
  return a.every((x) => s.has(x));
}
