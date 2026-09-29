import { toSvg } from 'html-to-image';
import { measureExportScale } from './export-link-previews';
import type { PdfExportPreview } from './export-pdf-previews';
import { dataUrlToBytes, type PdfImagePatch } from './pdf-export';

type Options = NonNullable<Parameters<typeof toSvg>[1]>;

/** Preserve document detail without allocating an enormous whole-board canvas.
 * Crop the complete board composition, not the PDF image alone: overlapping
 * cards, column clipping and annotations must remain exactly as captured.
 */
export async function capturePdfDetails(
  root: HTMLElement, previews: PdfExportPreview[], options: Options & { width: number; height: number },
  zoom: number, originX: number, originY: number,
): Promise<PdfImagePatch[]> {
  if (!previews.length) return [];
  const { bounds, scaleX, scaleY } = measureExportScale(root, zoom);
  const regions = previews.flatMap(preview => {
    const rect = preview.element.getBoundingClientRect();
    const w = rect.width / scaleX, h = rect.height / scaleY;
    if (w <= 0 || h <= 0) return [];
    const left = (rect.left - bounds.left) / scaleX + originX;
    const top = (rect.top - bounds.top) / scaleY + originY;
    const x = Math.max(0, left), y = Math.max(0, top);
    const width = Math.min(options.width, left + w) - x;
    const height = Math.min(options.height, top + h) - y;
    if (width <= 0 || height <= 0) return [];
    const ratio = Math.min(Math.max(preview.width / w, preview.height / h), 4096 / Math.max(width, height));
    return [{ x, y, width, height, ratio }];
  });
  if (!regions.length) return [];
  const svgUrl = await toSvg(root, options);
  const svg = new DOMParser().parseFromString(decodeURIComponent(svgUrl.slice(svgUrl.indexOf(',') + 1)), 'image/svg+xml');
  const foreignObject = svg.documentElement.firstElementChild;
  foreignObject?.setAttribute('width', String(options.width));
  foreignObject?.setAttribute('height', String(options.height));
  const patches: PdfImagePatch[] = [];
  const canvas = root.createEl('canvas');
  canvas.setCssStyles({ display: 'none' });
  try {
    for (const region of regions) {
      canvas.width = Math.max(1, Math.ceil(region.width * region.ratio));
      canvas.height = Math.max(1, Math.ceil(region.height * region.ratio));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas unavailable');
      // Change only the outer SVG viewport. The cloned board keeps its full
      // layout dimensions, avoiding reflow when capturing a small region.
      svg.documentElement.setAttribute('viewBox', `${region.x} ${region.y} ${region.width} ${region.height}`);
      svg.documentElement.setAttribute('width', String(canvas.width));
      svg.documentElement.setAttribute('height', String(canvas.height));
      svg.documentElement.setAttribute('preserveAspectRatio', 'none');
      const image = root.createEl('img');
      image.setCssStyles({ display: 'none' });
      try {
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
        await image.decode();
        ctx.fillStyle = options.backgroundColor || '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0);
      } finally { image.remove(); }
      let bytes: Uint8Array;
      let filter: PdfImagePatch['filter'];
      if (typeof CompressionStream !== 'undefined') {
        const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const rgb = new Uint8Array(canvas.width * canvas.height * 3);
        for (let i = 0, j = 0; i < rgba.length; i += 4) {
          rgb[j++] = rgba[i]; rgb[j++] = rgba[i + 1]; rgb[j++] = rgba[i + 2];
        }
        const stream = new Blob([rgb]).stream().pipeThrough(new CompressionStream('deflate'));
        bytes = new Uint8Array(await new Response(stream).arrayBuffer());
        filter = 'FlateDecode';
      } else {
        bytes = dataUrlToBytes(canvas.toDataURL('image/jpeg', 1));
        filter = 'DCTDecode';
      }
      patches.push({ bytes, filter, widthPx: canvas.width, heightPx: canvas.height, ...region });
    }
  } finally {
    canvas.width = canvas.height = 1;
    canvas.remove();
  }
  return patches;
}
