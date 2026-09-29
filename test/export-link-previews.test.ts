// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookmarkCard, ColumnCard } from '../src/file-types';
import { collectExportLinks } from '../src/export-link-previews';

const { capture, request, deliver } = vi.hoisted(() => ({ capture: vi.fn(), request: vi.fn(), deliver: vi.fn() }));
vi.mock('html-to-image', () => ({
  toCanvas: async (root: HTMLElement, options: { width: number; height: number; pixelRatio: number }) => {
    const result = await capture(root, options);
    return typeof result === 'string' ? {
      width: Math.floor(options.width * options.pixelRatio), height: Math.floor(options.height * options.pixelRatio),
      toDataURL: () => result,
    } : result;
  },
}));
vi.mock('../src/asset-manager', async importOriginal => ({
  ...await importOriginal<object>(), deliverExport: deliver,
}));
vi.mock('obsidian', async () => ({
  ...await vi.importActual<object>('./obsidian-stub'),
  Notice: class { hide() {} },
  requestUrl: request,
  arrayBufferToBase64: (buf: ArrayBuffer) => Buffer.from(buf).toString('base64'),
}));
const { overlaysMethods } = await import('../src/freeform-view-overlays');

const bookmark: BookmarkCard = { kind: 'bookmark', id: 'yt', url: 'https://youtu.be/abcdefghijk', x: 0, y: 0, w: 320, h: 180 };

function setup() {
  const outer = document.createElement('div');
  const inner = outer.createDiv();
  const card = inner.createDiv({ cls: 'visual-notes-freeform-card is-selected' });
  card.dataset.id = 'yt';
  const body = card.createDiv('visual-notes-bookmark-youtube-body');
  const iframe = body.createEl('iframe', { cls: 'visual-notes-bookmark-youtube-iframe' });
  iframe.src = 'https://www.youtube.com/embed/abcdefghijk?enablejsapi=1';
  const overlay = body.createDiv('visual-notes-bookmark-youtube-overlay');
  document.body.appendChild(outer);
  const renderer = {
    inner, outer, cardEls: new Map([['yt', card]]), vp: { zoom: 0.5 },
    file: { basename: 'Board' }, app: {},
    board: { cards: [bookmark], connections: [], drawings: [] },
    computeExportBBox: () => ({ minX: 0, minY: 0, maxX: 320, maxY: 180 }),
  };
  return { renderer, inner, card, iframe, overlay };
}

describe('YouTube board export', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
    request.mockResolvedValue({ headers: { 'content-type': 'image/jpeg' }, arrayBuffer: new Uint8Array([1, 2, 3]).buffer });
  });

  it('captures an inlined thumbnail for a selected card, then restores the live player', async () => {
    const { renderer, inner, card, iframe, overlay } = setup();
    const other = inner.createDiv('visual-notes-freeform-card');
    other.dataset.id = 'other';
    capture.mockImplementation(async (_root, options) => {
      expect(inner.querySelector('img')?.src).toBe('data:image/jpeg;base64,AQID');
      expect(options.filter(iframe)).toBe(false);
      expect(options.filter(overlay)).toBe(false);
      expect(options.filter(card)).toBe(true);
      expect(options.filter(other)).toBe(false);
      expect(card.classList.contains('is-selected')).toBe(false);
      return 'data:image/png;base64,AQID';
    });
    await overlaysMethods.exportBoard.call(renderer as never, 'png', new Set(['yt']));
    expect(request).toHaveBeenCalledExactlyOnceWith({ url: 'https://img.youtube.com/vi/abcdefghijk/maxresdefault.jpg' });
    expect(deliver).toHaveBeenCalledOnce();
    expect(inner.querySelector('img')).toBeNull();
    expect(inner.querySelector('iframe')).toBe(iframe);
    expect(card.classList.contains('is-selected')).toBe(true);
    expect(inner.classList.contains('visual-notes-exporting')).toBe(false);
  });

  it('falls back to an available thumbnail when larger sizes are missing', async () => {
    const { renderer, inner } = setup();
    request.mockRejectedValueOnce(new Error('404')).mockRejectedValueOnce(new Error('404'))
      .mockResolvedValueOnce({ status: 404, headers: {} });
    capture.mockImplementation(async () => {
      expect(inner.querySelector('img')?.src).toBe('data:image/jpeg;base64,AQID');
      return 'data:image/png;base64,AQID';
    });
    await overlaysMethods.exportBoard.call(renderer as never, 'png');
    expect(request.mock.calls.map(([arg]) => arg.url)).toEqual([
      'https://img.youtube.com/vi/abcdefghijk/maxresdefault.jpg',
      'https://img.youtube.com/vi/abcdefghijk/hq720.jpg',
      'https://img.youtube.com/vi/abcdefghijk/sddefault.jpg',
      'https://img.youtube.com/vi/abcdefghijk/hqdefault.jpg',
    ]);
    expect(deliver).toHaveBeenCalledOnce();
    expect(inner.querySelector('img')).toBeNull();
  });

  it('removes capture posters and restores selection when rasterisation fails', async () => {
    const { renderer, inner, card, iframe } = setup();
    capture.mockRejectedValue(new Error('render failed'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await overlaysMethods.exportBoard.call(renderer as never, 'png');
      expect(deliver).not.toHaveBeenCalled();
      expect(inner.querySelector('img')).toBeNull();
      expect(inner.querySelector('iframe')).toBe(iframe);
      expect(card.classList.contains('is-selected')).toBe(true);
      expect(inner.classList.contains('visual-notes-exporting')).toBe(false);
    } finally { log.mockRestore(); }
  });

  it('maps zoomed nested bookmark bounds to image pixels and honours selection', () => {
    const { inner, card } = setup();
    const column: ColumnCard = { kind: 'column', id: 'column', children: [bookmark] };
    delete card.dataset.id;
    card.dataset.childId = 'yt';
    vi.spyOn(inner, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 0, 0));
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(new DOMRect(125, 250, 160, 90));
    expect(collectExportLinks(inner, [column], 0.5, 40, 40, 2, new Set(['column']))).toEqual([
      { url: bookmark.url, x: 180, y: 280, width: 640, height: 360 },
    ]);
    expect(collectExportLinks(inner, [column], 0.5, 40, 40, 2, new Set(['other']))).toEqual([]);
  });

  it('accounts for display scaling in addition to the board zoom', () => {
    const { inner, card } = setup();
    vi.spyOn(inner, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 0, 0));
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(new DOMRect(175, 350, 240, 135));
    const create = inner.createDiv.bind(inner);
    vi.spyOn(inner, 'createDiv').mockImplementation(() => {
      const probe = create();
      vi.spyOn(probe, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 75, 75));
      return probe;
    });
    expect(collectExportLinks(inner, [bookmark], 0.5, 40, 40, 2)).toEqual([
      { url: bookmark.url, x: 280, y: 480, width: 640, height: 360 },
    ]);
    expect(inner.children).toHaveLength(1);
  });

  it('clips link areas to the visible portion of a scrolling column', () => {
    const { inner, card } = setup();
    const parent = inner.createDiv();
    parent.style.overflowY = 'auto';
    parent.append(card);
    Object.defineProperty(parent, 'clientHeight', { value: 150 });
    vi.spyOn(inner, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 0, 0));
    vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 160, 75));
    const rect = vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(new DOMRect(125, 250, 160, 90));
    expect(collectExportLinks(inner, [bookmark], 0.5, 40, 40, 2)[0]).toEqual({
      url: bookmark.url, x: 180, y: 280, width: 640, height: 100,
    });
    rect.mockReturnValue(new DOMRect(125, 300, 160, 90));
    expect(collectExportLinks(inner, [bookmark], 0.5, 40, 40, 2)).toEqual([]);
  });

  it('uses the actual captured image dimensions for PDF link placement', async () => {
    const { renderer, inner, card } = setup();
    vi.spyOn(inner, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 0, 0));
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 160, 90));
    const toDataURL = vi.fn(() => 'data:image/jpeg;base64,AQID');
    // Exercise a raster smaller than the requested 800 x 520 pixels.
    capture.mockResolvedValue({ width: 400, height: 260, toDataURL });
    await overlaysMethods.exportBoard.call(renderer as never, 'pdf');
    expect(deliver).toHaveBeenCalledOnce();
    const pdf = new TextDecoder().decode(deliver.mock.calls[0][1]);
    expect(pdf).toContain('/MediaBox [0 0 300.00 195.00]');
    expect(pdf).toContain('/Rect [30.00 30.00 270.00 165.00]');
    expect(toDataURL).toHaveBeenCalledWith('image/jpeg', 0.92);
  });

  it('reduces very large exports below 1x so they stay within the canvas limit', async () => {
    const { renderer } = setup();
    renderer.computeExportBBox = () => ({ minX: 0, minY: 0, maxX: 20000, maxY: 10000 });
    capture.mockImplementation(async (_root, options) => {
      expect(options.pixelRatio).toBeLessThan(1);
      expect(options.width * options.pixelRatio).toBeLessThanOrEqual(8000);
      expect(options.height * options.pixelRatio).toBeLessThanOrEqual(8000);
      return 'data:image/png;base64,AQID';
    });
    await overlaysMethods.exportBoard.call(renderer as never, 'png');
    expect(deliver).toHaveBeenCalledOnce();
  });
});
