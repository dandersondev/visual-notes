// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capturePdfDetails } from '../src/export-pdf-details';

const { svg } = vi.hoisted(() => ({ svg: vi.fn() }));
vi.mock('html-to-image', () => ({ toSvg: svg }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function setup() {
  const root = document.body.createDiv();
  const element = root.createEl('img');
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 0, 0));
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(125, 250, 150, 200));
  svg.mockResolvedValue('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1000"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">Entire board, including overlapping cards</div></foreignObject></svg>'));
  const sources: string[] = [];
  Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, value: vi.fn(function (this: HTMLImageElement) {
    sources.push(decodeURIComponent(this.src.split(',')[1])); return Promise.resolve();
  }) });
  const context = { fillRect: vi.fn(), drawImage: vi.fn(), fillStyle: '' };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,AQID');
  vi.stubGlobal('CompressionStream', undefined);
  return { root, element, sources, context, previews: [{ element, width: 1800, height: 2400 }] };
}

describe('PDF export detail regions', () => {
  it('preserves high-resolution regions and the full board layout under zoom', async () => {
    const { root, previews, sources } = setup();
    const patches = await capturePdfDetails(root, previews, { width: 2000, height: 1000, pixelRatio: 0.25 }, 0.5, 40, 40);
    expect(patches[0]).toMatchObject({ x: 90, y: 140, width: 300, height: 400, widthPx: 1800, heightPx: 2400 });
    expect(sources[0]).toContain('viewBox="90 140 300 400"');
    expect(sources[0]).toContain('<foreignObject width="2000" height="1000">');
    expect(sources[0]).toContain('including overlapping cards');
    expect(root.querySelector('canvas')).toBeNull();
    expect(root.querySelectorAll('img')).toHaveLength(1);
  });

  it('clips details to the export bounds without stretching the board', async () => {
    const { root, previews } = setup();
    const patches = await capturePdfDetails(root, previews, { width: 200, height: 200 }, 0.5, -100, -150);
    expect(patches[0]).toMatchObject({ x: 0, y: 0, width: 200, height: 200, widthPx: 1200, heightPx: 1200 });
  });

  it('releases temporary elements if the detailed capture fails', async () => {
    const { root, previews } = setup();
    vi.mocked(HTMLImageElement.prototype.decode).mockRejectedValue(new Error('decode failed'));
    await expect(capturePdfDetails(root, previews, { width: 2000, height: 1000 }, 0.5, 0, 0)).rejects.toThrow('decode failed');
    expect(root.querySelector('canvas')).toBeNull();
    expect(root.querySelectorAll('img')).toHaveLength(1);
  });
});
