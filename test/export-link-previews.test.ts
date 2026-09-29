// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookmarkCard, ColumnCard } from '../src/file-types';
import { collectExportLinks } from '../src/export-link-previews';

const { capture, request, deliver } = vi.hoisted(() => ({ capture: vi.fn(), request: vi.fn(), deliver: vi.fn() }));
vi.mock('html-to-image', () => ({ toPng: capture }));
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
    expect(request).toHaveBeenCalledWith({ url: 'https://img.youtube.com/vi/abcdefghijk/mqdefault.jpg' });
    expect(deliver).toHaveBeenCalledOnce();
    expect(inner.querySelector('img')).toBeNull();
    expect(inner.querySelector('iframe')).toBe(iframe);
    expect(card.classList.contains('is-selected')).toBe(true);
    expect(inner.classList.contains('visual-notes-exporting')).toBe(false);
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
    vi.spyOn(inner, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 200 } as DOMRect);
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({ left: 125, top: 250, width: 160, height: 90 } as DOMRect);
    expect(collectExportLinks(inner, [column], 0.5, 40, 40, 2, new Set(['column']))).toEqual([
      { url: bookmark.url, x: 180, y: 280, width: 640, height: 360 },
    ]);
    expect(collectExportLinks(inner, [column], 0.5, 40, 40, 2, new Set(['other']))).toEqual([]);
  });
});
