import { notesText } from './draft';
import type { CaseFile, EvidenceSubmission, EvidenceType, SentenceView } from './types';

/** Build exactly what will go to PayPal from the approved draft. */
export function buildSubmission(c: CaseFile, views: readonly SentenceView[], evidenceType: EvidenceType): EvidenceSubmission {
  return {
    disputeId: c.summary.id,
    action: 'provide_evidence',
    evidenceType,
    carrier: c.fulfillment.carrier,
    tracking: c.fulfillment.tracking,
    notes: notesText(views),
    files: c.attachments.map((a) => ({ name: a.name, size: a.size })),
  };
}

/** Sum of file sizes written like "112 KB". */
export function totalSize(files: readonly { size: string }[]): string {
  const kb = files.reduce((n, f) => n + (Number.parseFloat(f.size) || 0), 0);
  return `${kb} KB`;
}
