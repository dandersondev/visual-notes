// Minimal single-page, single-image PDF writer.
//
// Board export only ever needs to wrap one already-rendered raster image
// into one PDF page — a full PDF library (jsPDF, the obvious choice, pulls
// in html2canvas + canvg + dompurify as hard dependencies of its bundle
// even though we'd never call any of the HTML/SVG features that need them;
// together they added ~1.4MB unminified to main.js for zero functional
// benefit here) is unwarranted. JPEG bytes drop directly into a PDF's
// DCTDecode image stream with no re-encoding, so the whole format reduces
// to a handful of fixed objects — small enough to hand-write and unit-test
// directly rather than take on that dependency weight.
//
// PDF object layout (all fixed, one of each):
//   1 Catalog → 2 Pages → 3 Page → 4 Image XObject (the JPEG) → 5 Content stream

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  const base64 = comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface PdfLink {
  url: string;
  /** Rectangle in exported image pixels, measured from the top left. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export function buildSingleImagePdf(jpegBytes: Uint8Array, widthPx: number, heightPx: number, links: PdfLink[] = []): Uint8Array {
  // PDF page geometry is in points (1/72"); treat exported pixels as 96dpi.
  const pageW = (widthPx * 72 / 96).toFixed(2);
  const pageH = (heightPx * 72 / 96).toFixed(2);

  const enc = new TextEncoder();
  const annotations = links.flatMap(link => {
    try {
      const url = new URL(link.url);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return [];
      if (![link.x, link.y, link.width, link.height].every(Number.isFinite)) return [];
      const left = Math.max(0, link.x), top = Math.max(0, link.y);
      const right = Math.min(widthPx, link.x + link.width), bottom = Math.min(heightPx, link.y + link.height);
      if (right <= left || bottom <= top) return [];
      const rect = [left, heightPx - bottom, right, heightPx - top].map(n => (n * 72 / 96).toFixed(2)).join(' ');
      // A hex string cannot be terminated by parentheses or backslashes in a URL.
      const uri = Array.from(enc.encode(url.href), b => b.toString(16).padStart(2, '0')).join('');
      return [{ rect, uri }];
    } catch { return []; }
  });
  const parts: Uint8Array[] = [];
  const offsets: number[] = [0]; // 1-indexed; offsets[0] unused
  let pos = 0;

  const pushBytes = (bytes: Uint8Array) => { parts.push(bytes); pos += bytes.length; };
  const pushText = (s: string) => pushBytes(enc.encode(s));
  const startObj = (n: number) => { offsets[n] = pos; pushText(`${n} 0 obj\n`); };
  const endObj = () => pushText('endobj\n');

  pushText('%PDF-1.4\n');

  startObj(1); pushText('<< /Type /Catalog /Pages 2 0 R >>\n'); endObj();
  startObj(2); pushText('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n'); endObj();

  startObj(3);
  pushText(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
    `/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R ` +
    (annotations.length ? `/Annots [${annotations.map((_, i) => `${i + 6} 0 R`).join(' ')}] ` : '') + '>>\n'
  );
  endObj();

  startObj(4);
  pushText(
    `<< /Type /XObject /Subtype /Image /Width ${widthPx} /Height ${heightPx} ` +
    `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`
  );
  pushBytes(jpegBytes);
  pushText('\nendstream\n');
  endObj();

  // Content stream: scale the unit square to the full page, then paint Im0.
  const content = `q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q`;
  startObj(5);
  pushText(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\n`);
  endObj();

  annotations.forEach(({ rect, uri }, i) => {
    startObj(i + 6);
    pushText(`<< /Type /Annot /Subtype /Link /Rect [${rect}] /Border [0 0 0] /A << /S /URI /URI <${uri}> >> >>\n`);
    endObj();
  });

  const xrefStart = pos;
  const objCount = 6 + annotations.length;
  pushText(`xref\n0 ${objCount}\n`);
  pushText('0000000000 65535 f \n');
  for (let i = 1; i < objCount; i++) {
    pushText(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }
  pushText(`trailer\n<< /Size ${objCount} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
