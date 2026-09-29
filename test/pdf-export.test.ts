import { describe, it, expect } from 'vitest';
import { buildSingleImagePdf, dataUrlToBytes } from '../src/pdf-export';

// These tests parse the hand-written PDF back apart and check the exact
// invariants a PDF reader relies on (xref offsets pointing at real "N 0
// obj" lines, stream /Length matching actual byte length, startxref
// pointing at the real "xref" keyword) — the class of bug that's easy to
// get subtly wrong by hand and that a real PDF viewer would just reject
// outright with no useful error, so it's worth locking in directly rather
// than only eyeballing the output.

function textAt(bytes: Uint8Array, start: number, len: number): string {
  return new TextDecoder('latin1').decode(bytes.subarray(start, start + len));
}

describe('pdf-export: dataUrlToBytes', () => {
  it('decodes a base64 data URL back to the original bytes', () => {
    // "hi" base64-encoded, wrapped as a data URL like canvas.toDataURL() produces.
    const dataUrl = 'data:image/jpeg;base64,aGk=';
    const bytes = dataUrlToBytes(dataUrl);
    expect(new TextDecoder().decode(bytes)).toBe('hi');
  });
});

describe('pdf-export: buildSingleImagePdf', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 0xff, 0xd9]); // fake but non-trivial bytes
  const pdf = buildSingleImagePdf(jpeg, 800, 600);
  const text = new TextDecoder('latin1').decode(pdf);

  it('starts with a PDF header', () => {
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
  });

  it('writes clickable URI annotations with bottom-left PDF coordinates and valid xrefs', () => {
    const url = 'https://www.youtube.com/watch?v=abcdefghijk&t=12';
    const linked = buildSingleImagePdf(jpeg, 800, 600, [{ url, x: 40, y: 80, width: 320, height: 180 }]);
    const text = new TextDecoder('latin1').decode(linked);
    expect(text).toContain('/Annots [6 0 R]');
    expect(text).toContain('/Rect [30.00 255.00 270.00 390.00]');
    expect(text).toContain(`/URI <${Buffer.from(url).toString('hex')}>`);
    const xrefIdx = text.indexOf('xref\n');
    const tableStart = text.indexOf('\n', text.indexOf('\n', xrefIdx) + 1) + 1;
    for (let n = 1; n <= 6; n++) {
      const offset = Number(textAt(linked, tableStart + n * 20, 10));
      expect(textAt(linked, offset, `${n} 0 obj`.length)).toBe(`${n} 0 obj`);
    }
  });

  it('clips links to the page and omits unsafe URLs and invalid rectangles', () => {
    const link = { url: 'https://example.com/a(b)', x: -20, y: -10, width: 60, height: 50 };
    const bytes = buildSingleImagePdf(jpeg, 800, 600, [
      link, { ...link, url: 'javascript:alert(1)' }, { ...link, x: NaN }, { ...link, x: 900 },
    ]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('/Annots [6 0 R]');
    expect(text).toContain('/Rect [0.00 420.00 30.00 450.00]');
    expect(text).toContain(`/URI <${Buffer.from(link.url).toString('hex')}>`);
  });

  it('embeds the exact JPEG bytes with a matching /Length', () => {
    const idx = text.indexOf('/Filter /DCTDecode');
    expect(idx).toBeGreaterThan(-1);
    const lengthMatch = text.slice(idx, idx + 60).match(/\/Length (\d+)/);
    expect(lengthMatch).toBeTruthy();
    expect(Number(lengthMatch![1])).toBe(jpeg.length);

    const streamStart = text.indexOf('stream\n', idx) + 'stream\n'.length;
    const embedded = pdf.subarray(streamStart, streamStart + jpeg.length);
    expect(Array.from(embedded)).toEqual(Array.from(jpeg));
  });

  it('preserves full-resolution detail images without moving the links or breaking xrefs', () => {
    const detail = new Uint8Array([1, 2, 3, 4]);
    const bytes = buildSingleImagePdf(jpeg, 800, 600,
      [{ url: 'https://youtube.com', x: 40, y: 80, width: 320, height: 180 }],
      [{ bytes: detail, filter: 'FlateDecode', widthPx: 1800, heightPx: 2400, x: 400, y: 100, width: 150, height: 200 }]);
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).toContain('/Annots [6 0 R]');
    expect(text).toContain('/Im1 7 0 R');
    expect(text).toContain('/Width 1800 /Height 2400');
    expect(text).toContain('q 112.5000 0 0 150.0000 300.0000 225.0000 cm /Im1 Do Q');
    const start = text.indexOf('stream\n', text.indexOf('/Filter /FlateDecode')) + 7;
    expect(bytes.slice(start, start + detail.length)).toEqual(detail);
    const xrefIdx = text.indexOf('xref\n');
    const tableStart = text.indexOf('\n', text.indexOf('\n', xrefIdx) + 1) + 1;
    for (let n = 1; n <= 7; n++) {
      const offset = Number(textAt(bytes, tableStart + n * 20, 10));
      expect(textAt(bytes, offset, `${n} 0 obj`.length)).toBe(`${n} 0 obj`);
    }
  });

  it('sizes the page from pixels at 96dpi converted to points (72/96)', () => {
    const match = text.match(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/);
    expect(match).toBeTruthy();
    expect(Number(match![1])).toBeCloseTo(800 * 72 / 96, 2);
    expect(Number(match![2])).toBeCloseTo(600 * 72 / 96, 2);
  });

  it('every xref offset points at the start of its own "N 0 obj" line', () => {
    const xrefIdx = text.indexOf('xref\n');
    expect(xrefIdx).toBeGreaterThan(-1);
    // Skip "xref\n0 6\n" and the free entry, then read 5 twenty-byte entries.
    const tableStart = text.indexOf('\n', text.indexOf('\n', xrefIdx) + 1) + 1;
    for (let objNum = 1; objNum <= 5; objNum++) {
      const entryStart = tableStart + objNum * 20;
      const entry = textAt(pdf, entryStart, 20);
      expect(entry).toMatch(/^\d{10} \d{5} n \n$/);
      const offset = Number(entry.slice(0, 10));
      expect(textAt(pdf, offset, `${objNum} 0 obj`.length)).toBe(`${objNum} 0 obj`);
    }
  });

  it('startxref points at the real "xref" keyword', () => {
    const match = text.match(/startxref\n(\d+)\n%%EOF$/);
    expect(match).toBeTruthy();
    const offset = Number(match![1]);
    expect(textAt(pdf, offset, 4)).toBe('xref');
  });

  it('the content stream /Length matches its actual byte length', () => {
    const contentIdx = text.lastIndexOf('<< /Length');
    const lengthMatch = text.slice(contentIdx, contentIdx + 40).match(/\/Length (\d+)/);
    const declaredLen = Number(lengthMatch![1]);
    const streamStart = text.indexOf('stream\n', contentIdx) + 'stream\n'.length;
    const streamEnd = text.indexOf('\nendstream', streamStart);
    expect(streamEnd - streamStart).toBe(declaredLen);
  });
});
