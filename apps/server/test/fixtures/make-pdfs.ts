/**
 * Test PDFs built in code (no binary fixtures): plain text pages of any size, too many pages, an encrypted file,
 * broken files, and a page hiding things a viewer does not show (white text, metadata, an attachment, an annotation).
 * Every function returns fresh bytes. All strings are latin1, so string length is the byte offset.
 */
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createDeflate } from 'node:zlib';

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

/**
 * A FlateDecode stream that decodes to `decodedBytes` zeros (about 1000:1), compressed in 1 MiB steps so building it
 * holds no more than that.
 */
async function zeros(decodedBytes: number): Promise<Buffer> {
  const z = createDeflate({ level: 9 });
  const out: Buffer[] = [];
  z.on('data', (b: Buffer) => out.push(b));
  const chunk = Buffer.alloc(1024 * 1024);
  for (let left = decodedBytes; left > 0; left -= chunk.length) {
    if (!z.write(left >= chunk.length ? chunk : chunk.subarray(0, left))) await once(z, 'drain');
  }
  z.end();
  await once(z, 'end');
  return Buffer.concat(out);
}

/**
 * A one-page PDF with a decompression bomb of `decodedMiB` in its XMP `/Metadata`, its page content stream (zeros
 * are whitespace to the content parser) or an embedded TrueType font file.
 */
export async function bombPdf(where: 'metadata' | 'content' | 'font', decodedMiB: number): Promise<Uint8Array> {
  const z = await zeros(decodedMiB * 1024 * 1024);
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  let length = parts[0]!.length;
  const offsets: number[] = [];
  const add = (...chunks: (string | Buffer)[]) => {
    offsets.push(length);
    for (const c of [`${offsets.length} 0 obj\n`, ...chunks, '\nendobj\n']) {
      const b = typeof c === 'string' ? Buffer.from(c, 'latin1') : c;
      parts.push(b);
      length += b.length;
    }
  };
  const bomb = (dict: string) => [`<< ${dict} /Filter /FlateDecode /Length ${z.length} >>\nstream\n`, z, '\nendstream'];
  const text = 'BT /F1 12 Tf 1 0 0 1 40 780 Tm (Bomb fixture) Tj ET';
  add(`<< /Type /Catalog /Pages 2 0 R${where === 'metadata' ? ' /Metadata 5 0 R' : ''} >>`);
  add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 6 0 R >> >> /Contents 4 0 R >>');
  if (where === 'content') add(...bomb(''));
  else add(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  if (where === 'metadata') add(...bomb('/Type /Metadata /Subtype /XML'));
  else add('<< /Type /Metadata /Subtype /XML /Length 0 >>\nstream\n\nendstream');
  if (where === 'font') {
    add('<< /Type /Font /Subtype /TrueType /BaseFont /Bomb /FirstChar 32 /LastChar 126 /FontDescriptor 7 0 R >>');
    add('<< /Type /FontDescriptor /FontName /Bomb /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 8 0 R >>');
    add(...bomb(''));
  } else add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const xref = length;
  let tail = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) tail += `${String(o).padStart(10, '0')} 00000 n \n`;
  tail += `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  parts.push(Buffer.from(tail, 'latin1'));
  return new Uint8Array(Buffer.concat(parts));
}

/**
 * One A4 page using every external resource pdf.js could ask for: a non-embedded CJK font with a predefined CMap
 * (UniJIS-UCS2-H, read from the CMap folder) showing `あ`, an image in an ICCBased colour space, and a JPEG 2000
 * image (decoded with the WASM decoder; its data is junk, so it is skipped after the decoder loads).
 */
export function resourcesPdf(): Uint8Array {
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objects[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 8 0 R /Im2 10 0 R >> >> /Contents 4 0 R >>';
  objects[4] = stream('', 'BT /F1 24 Tf 1 0 0 1 40 780 Tm <3042> Tj ET\nq 100 0 0 100 40 600 cm /Im1 Do Q\nq 100 0 0 100 200 600 cm /Im2 Do Q');
  objects[5] = '<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPr6N-Regular /Encoding /UniJIS-UCS2-H /DescendantFonts [6 0 R] >>';
  objects[6] = '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPr6N-Regular /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor 7 0 R >>';
  objects[7] = '<< /Type /FontDescriptor /FontName /KozMinPr6N-Regular /Flags 4 /FontBBox [0 -120 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>';
  objects[8] = stream('/Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace [/ICCBased 9 0 R]', '\x80\x40\x20');
  objects[9] = stream('/N 3 /Alternate /DeviceRGB', 'not a real ICC profile');
  // A JPEG 2000 codestream: SOC, then SIZ for one 1x1 8-bit component, then junk where the tiles should be.
  const siz = [0xff, 0x4f, 0xff, 0x51, 0, 41, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 7, 1, 1];
  objects[10] = stream('/Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceGray /Filter /JPXDecode', `${String.fromCharCode(...siz)}junk`);
  return assemble(objects, '/Root 1 0 R');
}
