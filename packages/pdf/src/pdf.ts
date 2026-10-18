/**
 * A tiny PDF writer, shared by apps/server (evidence documents) and apps/metermcp (session receipts): one or more
 * A4 pages of Helvetica text. It writes real PDF 1.4 (objects, xref table with byte offsets, trailer, %%EOF) and no more than that.
 */

import { deflateSync } from 'node:zlib';

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

export interface ImagePage {
  width: number;
  height: number;
  /** width * height * 3 bytes, 8-bit RGB, row by row. */
  rgb: Uint8Array;
}

/** Points with at most 4 decimals, no trailing zeros. */
function pt(n: number): string {
  return String(Number(n.toFixed(4)));
}

/**
 * Image-only PDF: one full-page DeviceRGB image per page (FlateDecode, level 9), sized from `dpi`. Only catalog, pages,
 * Info (/Title, /Producer) and the page drawing; no fonts, annotations, attachments, scripts or XMP. Deterministic.
 */
export function writeImagePdf(o: { title: string; pages: readonly ImagePage[]; dpi: number }): Uint8Array {
  // Objects: 1 catalog, 2 pages, 3 info, then (page, image, content) triples. Streams are binary, so offsets count bytes.
  const pageId = (i: number) => 4 + i * 3;
  const objects: Buffer[] = [];
  const text = (s: string) => Buffer.from(s, 'latin1');
  const streamObj = (dict: string, data: Uint8Array) =>
    Buffer.concat([text(`<< ${dict ? `${dict} ` : ''}/Length ${data.length} >>\nstream\n`), data, text('\nendstream')]);
  objects[1] = text('<< /Type /Catalog /Pages 2 0 R >>');
  objects[2] = text(`<< /Type /Pages /Kids [${o.pages.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] /Count ${o.pages.length} >>`);
  objects[3] = text(`<< /Title (${pdfText(o.title)}) /Producer (ResolveKit) >>`);
  o.pages.forEach((p, i) => {
    const w = pt((p.width * 72) / o.dpi);
    const h = pt((p.height * 72) / o.dpi);
    const id = pageId(i);
    objects[id] = text(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${id + 1} 0 R >> >> /Contents ${id + 2} 0 R >>`);
    objects[id + 1] = streamObj(
      `/Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
      deflateSync(p.rgb, { level: 9 }),
    );
    objects[id + 2] = streamObj('', text(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`));
  });

  const chunks: Buffer[] = [text('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')];
  let size = chunks[0]!.length;
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = size;
    const chunk = Buffer.concat([text(`${id} 0 obj\n`), objects[id]!, text('\nendobj\n')]);
    chunks.push(chunk);
    size += chunk.length;
  }
  let tail = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) tail += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  tail += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${size}\n%%EOF\n`;
  chunks.push(text(tail));
  return new Uint8Array(Buffer.concat(chunks));
}
