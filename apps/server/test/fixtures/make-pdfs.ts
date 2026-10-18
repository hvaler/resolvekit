/**
 * Test PDFs built in code (no binary fixtures): plain text pages of any size, too many pages, an encrypted file,
 * broken files, and a page hiding things a viewer does not show (white text, metadata, an attachment, an annotation).
 * Every function returns fresh bytes. All strings are latin1, so string length is the byte offset.
 */
import { createHash } from 'node:crypto';

export const A4 = { w: 595, h: 842 };
export const A3_LANDSCAPE = { w: 1191, h: 842 };
/** The largest page PDF allows without UserUnit: 200 inches on a side. */
export const HUGE = { w: 14400, h: 14400 };

export type FixturePage = { w: number; h: number; lines: readonly string[] };

const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));
const hex = (b: Uint8Array) => `<${Buffer.from(b).toString('hex')}>`;

/** Assemble objects 1..n (index 0 unused) with an xref table and the given trailer entries. */
function assemble(objects: readonly string[], trailer: string): Uint8Array {
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} ${trailer} >>\nstartxref\n${xref}\n%%EOF\n`;
  return bytes(out);
}

const stream = (dict: string, body: string) => `<< ${dict} /Length ${body.length} >>\nstream\n${body}\nendstream`;

/** Text lines drawn in black Helvetica 12 from the top left, one per line. */
function content(p: FixturePage): string {
  const ops = ['BT', '/F1 12 Tf'];
  p.lines.forEach((l, i) => ops.push(`1 0 0 1 40 ${p.h - 60 - i * 20} Tm`, `(${esc(l)}) Tj`));
  ops.push('ET');
  return ops.join('\n');
}

/** Objects for a catalog (1), pages (2), font (3) and each page (4, 6, ...) followed by its content. */
function pageObjects(pages: readonly FixturePage[]): string[] {
  const objects: string[] = [];
  const ids = pages.map((_, i) => 4 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${ids.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  pages.forEach((p, i) => {
    const id = ids[i]!;
    objects[id] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.w} ${p.h}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`;
    objects[id + 1] = stream('', content(p));
  });
  return objects;
}

export function textPdf(pages: readonly FixturePage[]): Uint8Array {
  return assemble(pageObjects(pages), '/Root 1 0 R');
}

/** `n` A4 pages, page k reading `Page k of n` and `Fixture line k`. */
export function pagesPdf(n: number, size = A4): Uint8Array {
  return textPdf(Array.from({ length: n }, (_, i) => ({ ...size, lines: [`Page ${i + 1} of ${n}`, `Fixture line ${i + 1}`] })));
}

/** A catalog whose page tree is empty. */
export function zeroPagePdf(): Uint8Array {
  return assemble(['', '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>'], '/Root 1 0 R');
}

/** A PDF header followed by bytes that are no PDF structure at all. */
export function corruptPdf(): Uint8Array {
  return bytes('%PDF-1.4\n' + 'this is not a pdf body '.repeat(40) + '\n%%EOF\n');
}

const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
    out[k] = data[k]! ^ s[(s[i]! + s[j]!) & 255]!;
  }
  return out;
}

/**
 * A one-page PDF under the Standard security handler (RC4 40-bit, R2). With `userPassword: false` the empty user
 * password opens it (an owner-password-only file: viewers open it without asking, but it is still encrypted); with
 * `true` the stored U value does not match the empty password, so a password is needed.
 */
export function encryptedPdf(o: { userPassword: boolean }): Uint8Array {
  const id = createHash('md5').update('resolvekit-fixture').digest();
  const ownerKey = createHash('md5').update(Buffer.concat([Buffer.from('owner'), PAD]).subarray(0, 32)).digest().subarray(0, 5);
  const O = rc4(ownerKey, PAD);
  const P = -4;
  const p = Buffer.alloc(4);
  p.writeInt32LE(P);
  const key = createHash('md5').update(Buffer.concat([PAD, O, p, id])).digest().subarray(0, 5);
  const U = o.userPassword ? rc4(createHash('md5').update('not the empty password').digest().subarray(0, 5), PAD) : rc4(key, PAD);
  // The content stays plain: with RC4 the reader decrypts it into noise, which is fine for these tests.
  const objects = pageObjects([{ ...A4, lines: ['Encrypted fixture'] }]);
  objects.push(`<< /Filter /Standard /V 1 /R 2 /O ${hex(O)} /U ${hex(U)} /P ${P} >>`);
  return assemble(objects, `/Root 1 0 R /Encrypt ${objects.length - 1} 0 R /ID [${hex(id)} ${hex(id)}]`);
}

/** Strings planted in `hiddenPdf`, for tests that check none of them travels further. */
export const HIDDEN = {
  visible: 'Visible order 4471',
  white: 'Hidden white text 9052',
  title: 'Secret title 3318',
  xmp: 'Secret XMP 7724',
  attachment: 'Secret attachment 6603',
  annotation: 'Secret annotation 5190',
};

/**
 * One A4 page showing one black line, with a white line under it (in the text layer, invisible on white), an Info
 * title, an XMP metadata stream, an embedded file and a text annotation.
 */
export function hiddenPdf(): Uint8Array {
  const objects = pageObjects([{ ...A4, lines: [HIDDEN.visible] }]);
  const n = objects.length;
  const [info, xmp, file, spec, annot] = [n, n + 1, n + 2, n + 3, n + 4];
  objects[info] = `<< /Title (${HIDDEN.title}) /Author (${HIDDEN.title}) >>`;
  objects[xmp] = stream('/Type /Metadata /Subtype /XML', `<x:xmpmeta xmlns:x="adobe:ns:meta/"><dc:title>${HIDDEN.xmp}</dc:title></x:xmpmeta>`);
  objects[file] = stream('/Type /EmbeddedFile', HIDDEN.attachment);
  objects[spec] = `<< /Type /Filespec /F (notes.txt) /UF (notes.txt) /EF << /F ${file} 0 R >> >>`;
  objects[annot] = `<< /Type /Annot /Subtype /Text /Rect [400 700 420 720] /Contents (${HIDDEN.annotation}) /Open false >>`;
  const page = 4;
  objects[page] = objects[page]!.replace(/>>$/, `/Annots [${annot} 0 R] >>`);
  objects[page + 1] = stream('', `${content({ ...A4, lines: [HIDDEN.visible] })}\nBT /F1 12 Tf 1 1 1 rg 1 0 0 1 40 760 Tm (${HIDDEN.white}) Tj ET`);
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /Metadata ${xmp} 0 R /Names << /EmbeddedFiles << /Names [(notes.txt) ${spec} 0 R] >> >> >>`;
  return assemble(objects, `/Root 1 0 R /Info ${info} 0 R`);
}
