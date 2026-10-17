/**
 * The evidence PDFs are built here, on the server, from the synthetic case files the web app shows. The browser
 * only names the files; it never uploads bytes, so what reaches PayPal is exactly the case's own document.
 */
import { createHash } from 'node:crypto';
import type { EvidenceFile } from '@resolvekit/paypal';
import type { Evidence, SubmissionFile } from '../../web/src/domain/types.ts';
import { CASE_FILES } from '@resolvekit/cases';
import { writePdf } from '@resolvekit/pdf';

export const SYNTHETIC_HEADER = 'SYNTHETIC TEST DOCUMENT';

export { CASE_FILES };

/** The document's content as plain text lines, whatever its layout in the web app. */
export function evidenceLines(e: Evidence): string[] {
  const b = e.body;
  switch (b.kind) {
    case 'lines':
      return b.lines.map((l) => l.text);
    case 'mandate':
      return [b.headline, `Session ${b.sessionId}`, ...b.rows.map((r) => `${r.label}: ${r.value}`)];
    case 'receipt':
      return [
        ...b.calls.map((c) => `#${c.n} ${c.time} ${c.tool} ${c.price} ${b.currency} ${c.ok ? 'OK' : 'FAILED (not charged)'} ${c.hash}`),
        ...(b.cap ? [`Approved budget ${b.cap} ${b.currency}`] : []),
      ];
    case 'settlement':
      return [b.headline, `Captured ${b.captured}`, `Released ${b.released}`, `Cap ${b.cap}`, ...b.rows.map((r) => `${r.label}: ${r.value}`)];
  }
}

export class UnknownFileError extends Error {
  readonly file: string;
  constructor(file: string) {
    super(`File ${file} is not a document of this case`);
    this.name = 'UnknownFileError';
    this.file = file;
  }
}

/**
 * Build the PDFs named in the submission from the case's documents, each with the SHA-256 of its bytes (the build is
 * deterministic: the same case gives the same bytes, so the approval can cover them). Unknown names are refused,
 * never invented.
 */
export function buildAttachments(caseId: string, files: readonly SubmissionFile[]): (EvidenceFile & { sha256: string })[] {
  const c = CASE_FILES[caseId];
  return files.map((f) => {
    const att = c?.attachments.find((a) => a.name === f.name);
    const ev = att && c?.evidence.find((e) => e.id === att.fromEvidenceId);
    if (!ev) throw new UnknownFileError(f.name);
    const lines = [
      `Case ${caseId} · ${ev.id} · ${ev.title}`,
      'All names, addresses and identifiers in this document are fictional.',
      '',
      ...evidenceLines(ev),
    ];
    const data = writePdf({ header: SYNTHETIC_HEADER, title: ev.title, lines });
    return { name: f.name, type: 'application/pdf', data, sha256: createHash('sha256').update(data).digest('hex') };
  });
}
