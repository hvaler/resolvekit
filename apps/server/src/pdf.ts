/**
 * A tiny PDF writer for the synthetic evidence documents: one or more A4 pages of Helvetica text. It writes
 * real PDF 1.4 (objects, xref table with byte offsets, trailer, %%EOF) and no more than that.
 */

// Characters the fixtures use beyond ASCII, in WinAnsiEncoding (the standard Helvetica encoding).
const WIN_ANSI: Readonly<Record<string, number>> = {
  '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '•': 0x95, '–': 0x96, '—': 0x97, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94,
  '™': 0x99, '·': 0xb7, '×': 0xd7, '°': 0xb0, '±': 0xb1, '→': 0x3e,
};

/** Encode text as a PDF literal string body in WinAnsi (bytes as latin1 chars), escaping \, ( and ). */
function pdfText(s: string): string {
  let out = '';
  for (const ch of s) {
    let code = WIN_ANSI[ch] ?? ch.codePointAt(0)!;
    if (code > 0xff || (code >= 0x80 && code < 0xa0 && !(ch in WIN_ANSI))) code = 0x3f; // '?'
    const c = String.fromCharCode(code);
    out += c === '\\' || c === '(' || c === ')' ? `\\${c}` : c;
  }
  return out;
}

/** Hard-wrap a line at about `max` characters, on spaces where possible. */
function wrap(line: string, max = 92): string[] {
  const out: string[] = [];
  let rest = line;
  while (rest.length > max) {
    const cut = rest.lastIndexOf(' ', max);
    const at = cut > 20 ? cut : max;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  out.push(rest);
  return out;
}

export interface PdfDocument {
  /** Shown in bold under the header, and as the document title. */
  title: string;
  lines: readonly string[];
  /** Bold header line at the top of every page. */
  header?: string;
}

const PAGE_W = 595;
const PAGE_H = 842;
const LINES_PER_PAGE = 50;

export function writePdf(doc: PdfDocument): Uint8Array {
  const body = doc.lines.flatMap((l) => wrap(l));
  const pages: string[][] = [];
  for (let i = 0; i < Math.max(1, body.length); i += LINES_PER_PAGE) pages.push(body.slice(i, i + LINES_PER_PAGE));

  // Objects: 1 catalog, 2 pages, 3 Helvetica, 4 Helvetica-Bold, 5 info, then (page, content) pairs.
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 6 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objects[5] = `<< /Title (${pdfText(doc.title)}) /Producer (ResolveKit) >>`;
  pages.forEach((lines, i) => {
    const ops: string[] = ['BT'];
    let y = PAGE_H - 56;
    const at = (font: string, size: number, text: string, gap: number) => {
      ops.push(`/${font} ${size} Tf`, `1 0 0 1 56 ${y} Tm`, `(${pdfText(text)}) Tj`);
      y -= gap;
    };
    if (doc.header) at('F2', 12, doc.header, 20);
    at('F2', 11, i === 0 ? doc.title : `${doc.title} (continued)`, 22);
    for (const l of lines) at('F1', 10, l, 14);
    ops.push('ET');
    const stream = ops.join('\n');
    objects[pageIds[i]!] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageIds[i]! + 1} 0 R >>`;
    objects[pageIds[i]! + 1] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });

  // Every string above is latin1 (one byte per char), so string length is the byte offset.
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}
