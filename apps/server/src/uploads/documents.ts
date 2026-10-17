/**
 * Confirmed uploads as the analyst's documents: one line per confirmed line, with the fragment key the web app
 * highlights (`E7.l3`) and, on a line the person corrected, who corrected it (the prompt marks such a line outside
 * its text; a sentence resting on it needs its own confirmation, see apps/web/src/domain/draft.ts).
 */
import type { AnalysisDocument } from '@resolvekit/analyst';
import type { UploadRecord } from './store.ts';

const evidenceNumber = (id: string | null) => Number(/^E(\d+)$/.exec(id ?? '')?.[1] ?? 0);
/** The document head carries title and source as quoted attributes: an uploaded name cannot close them. */
const attr = (s: string) => s.replace(/["<>]/g, '');

/**
 * The file name PayPal receives for a confirmed upload: `<evidenceId>-<name>.<png|pdf>`, the uploaded name (without
 * its extension) reduced to [A-Za-z0-9._-] and at most 60 characters, so no other text of the person's reaches PayPal
 * as a file name.
 */
export function uploadFileName(r: Pick<UploadRecord, 'evidenceId' | 'name' | 'mime'>): string {
  const base =
    r.name
      .replace(/\.[A-Za-z0-9]{1,5}$/, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 60)
      .replace(/[-.]+$/, '') || 'upload';
  return `${r.evidenceId}-${base}.${r.mime === 'application/pdf' ? 'pdf' : 'png'}`;
}

/** Confirmed uploads with an evidence id, in evidence order; anything else is not a document. */
export function uploadDocuments(records: UploadRecord[]): AnalysisDocument[] {
  return records
    .filter((r) => r.status === 'confirmed' && evidenceNumber(r.evidenceId) > 0)
    .sort((a, b) => evidenceNumber(a.evidenceId) - evidenceNumber(b.evidenceId))
    .map((r) => {
      const id = r.evidenceId!;
      return {
        id,
        title: attr(r.name),
        type: r.kind === 'image' ? 'Merchant upload · image' : 'Merchant upload · pasted text',
        source: `Uploaded by ${attr(r.uploadedBy.name)}`,
        tag: 'UPL',
        lines: r.lines.map((l, i) => ({ text: l.text, fragment: `${id}.l${i + 1}`, ...(l.correctedBy ? { corrected: l.correctedBy } : {}) })),
      };
    });
}
