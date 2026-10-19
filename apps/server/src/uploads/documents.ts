/**
 * Confirmed uploads as the analyst's documents: one line per confirmed line, with the fragment key the web app
 * highlights (`E7.l3`; on a PDF, scoped by its page of the original document: `E7.p8.l3`) and, on a line the person
 * corrected or transcribed by hand, who did it (the prompt marks such a line outside its text; a sentence resting on
 * it needs its own confirmation, see apps/web/src/domain/draft.ts).
 */
import type { AnalysisDocument, DocLine } from '@resolvekit/analyst';
import type { UploadRecord } from './store.ts';

const evidenceNumber = (id: string | null) => Number(/^E(\d+)$/.exec(id ?? '')?.[1] ?? 0);
/** The document head carries the source as a quoted attribute: a person's name cannot close it. */
const attr = (s: string) => s.replace(/["<>]/g, '');

/**
 * The file name PayPal receives for a confirmed upload: `<evidenceId>-upload.png` (image; `.jpg` for a covered JPEG
 * photo), `<evidenceId>-upload.pdf` (PDF, rebuilt from its covered pages) or `<evidenceId>-pasted.pdf` (pasted text).
 * The uploaded name never leaves this server (it can hold what the person did not cover, an account number say); only
 * the workspace sees it.
 */
export function uploadFileName(r: Pick<UploadRecord, 'evidenceId' | 'kind' | 'mime'>): string {
  if (r.kind === 'text') return `${r.evidenceId}-pasted.pdf`;
  if (r.kind === 'pdf') return `${r.evidenceId}-upload.pdf`;
  return `${r.evidenceId}-upload.${r.mime === 'image/jpeg' ? 'jpg' : 'png'}`;
}

const TITLES: Record<UploadRecord['kind'], { title: string; type: string }> = {
  image: { title: 'Uploaded screenshot', type: 'Merchant upload · image' },
  text: { title: 'Pasted text', type: 'Merchant upload · pasted text' },
  pdf: { title: 'Uploaded PDF', type: 'Merchant upload · PDF' },
};

/** The title of an upload's document for the model and inside its PDF: by kind, never the uploaded name. */
export const uploadTitle = (kind: UploadRecord['kind']): string => TITLES[kind].title;

const ocrLine = (l: UploadRecord['lines'][number], fragment: string): DocLine => ({ text: l.text, fragment, ...(l.correctedBy ? { corrected: l.correctedBy } : {}) });

/**
 * A PDF's lines, page after page as confirmed: each page's read lines (`E7.p<orig>.l1`…), then its transcribed ones
 * numbered after them. A page with no lines contributes nothing.
 */
function pdfLines(id: string, r: UploadRecord): DocLine[] {
  return (r.pdf?.pages ?? []).flatMap((p) => [
    ...p.lines.map((l, i) => ocrLine(l, `${id}.p${p.original}.l${i + 1}`)),
    ...p.added.map((a, j) => ({ text: a.text, fragment: `${id}.p${p.original}.l${p.lines.length + j + 1}`, transcribed: a.by })),
  ]);
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
        ...TITLES[r.kind],
        source: `Uploaded by ${attr(r.uploadedBy.name)}`,
        tag: 'UPL',
        lines: r.kind === 'pdf' ? pdfLines(id, r) : r.lines.map((l, i) => ocrLine(l, `${id}.l${i + 1}`)),
      };
    });
}
