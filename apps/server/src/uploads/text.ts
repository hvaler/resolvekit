/**
 * Pasted merchant text: redaction by offsets, line splitting, and the PDF that is stored and hashed as the evidence.
 * The text never reaches a log or an error message.
 */
import { createHash } from 'node:crypto';
import { writePdf } from '@resolvekit/pdf';
import { MAX_TEXT_CHARS } from './limits.ts';
import { UploadError } from './image.ts';

/** A span to remove, as UTF-16 offsets into the pasted text (`end` exclusive). */
export interface TextRemoval { start: number; end: number }

const MAX_LINE = 300;

function checkLength(text: string): void {
  if (text.length > MAX_TEXT_CHARS) throw new UploadError('TOO_LONG', `The text is longer than ${MAX_TEXT_CHARS} characters`);
}

/** Replace each removed span with `[redacted]`; overlapping or touching spans merge. */
export function redactText(text: string, removals: readonly TextRemoval[]): string {
  checkLength(text);
  for (const r of removals) {
    if (!Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start < 0 || r.end > text.length || r.start >= r.end) {
      throw new UploadError('BAD_REDACTION', 'A redaction span is out of range');
    }
  }
  const sorted = [...removals].sort((a, b) => a.start - b.start);
  let out = '', pos = 0;
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i]!.start;
    let end = sorted[i]!.end;
    while (i + 1 < sorted.length && sorted[i + 1]!.start <= end) end = Math.max(end, sorted[++i]!.end);
    out += text.slice(pos, start) + '[redacted]';
    pos = end;
  }
  return out + text.slice(pos);
}

/** Split on line breaks, trim the right side, drop trailing empty lines; lines over 300 characters wrap at a space. */
export function textLines(text: string): string[] {
  checkLength(text);
  const lines: string[] = [];
  for (let line of text.split(/\r\n|\r|\n/).map((l) => l.trimEnd())) {
    while (line.length > MAX_LINE) {
      const cut = line.lastIndexOf(' ', MAX_LINE);
      if (cut <= 0) { lines.push(line.slice(0, MAX_LINE)); line = line.slice(MAX_LINE); continue; }
      lines.push(line.slice(0, cut));
      line = line.slice(cut + 1);
    }
    lines.push(line);
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The evidence PDF for pasted text, with the SHA-256 of its bytes. */
export function pastedTextPdf(o: { title: string; by: string; lines: readonly string[] }): { pdf: Uint8Array; sha256: string } {
  const pdf = writePdf({ title: o.title, lines: o.lines, header: `PASTED BY THE MERCHANT · ${o.by}` });
  return { pdf, sha256: createHash('sha256').update(pdf).digest('hex') };
}
