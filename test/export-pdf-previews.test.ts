// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TFile, type App } from 'obsidian';
import type { Card } from '../src/file-types';

const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('obsidian', async () => ({ ...await vi.importActual<object>('./obsidian-stub'), loadPdfJs: load }));
import { preparePdfExport } from '../src/export-pdf-previews';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); document.body.replaceChildren(); });

function setup() {
  const root = document.body.createDiv();
  const el = root.createDiv({ attr: { 'data-id': 'pdf' } });
  const body = el.createDiv('visual-notes-file-body');
  Object.defineProperties(body, { clientWidth: { value: 300 }, clientHeight: { value: 400 } });
  const iframe = body.createEl('iframe', { cls: 'visual-notes-file-iframe' });
  const file = Object.assign(new TFile(), { path: 'Guide.pdf', extension: 'pdf' });
  const app = { vault: { getAbstractFileByPath: () => file, readBinary: vi.fn(async () => new Uint8Array([1, 2]).buffer) } };
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  const getPage = vi.fn(async () => ({ getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }), render }));
  const destroy = vi.fn(async () => {});
  const getDocument = vi.fn(() => ({ promise: Promise.resolve({ getPage }), destroy }));
  load.mockResolvedValue({ getDocument });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AQID');
  const cards: Card[] = [{ kind: 'file', id: 'pdf', path: file.path }];
  return { root, el, body, iframe, app: app as unknown as App, cards, render, getPage, destroy, getDocument };
}

describe('PDF file cards in board exports', () => {
  it('renders the first page at export resolution and restores the live iframe', async () => {
    const { root, iframe, app, cards, render, getPage, destroy } = setup();
    const result = await preparePdfExport(root, app, cards, 2);
    expect(getPage).toHaveBeenCalledWith(1);
    expect(render.mock.calls[0][0].viewport).toEqual({ width: 600, height: 800 });
    expect(root.querySelector('img')?.src).toBe('data:image/png;base64,AQID');
    expect(root.querySelector('iframe')).toBe(iframe);
    expect(root.querySelector('canvas')).toBeNull();
    expect(destroy).toHaveBeenCalledOnce();
    expect(result.failed).toEqual([]);
    result.restore();
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('iframe')).toBe(iframe);
  });

  it('includes PDFs in selected columns and skips unselected PDF cards', async () => {
    const { root, el, app, cards, getDocument } = setup();
    (await preparePdfExport(root, app, cards, 2, new Set(['other']))).restore();
    expect(getDocument).not.toHaveBeenCalled();
    el.dataset.childId = 'pdf'; delete el.dataset.id;
    const column: Card = { kind: 'column', id: 'column', children: cards as never };
    const result = await preparePdfExport(root, app, [column], 2, new Set(['column']));
    expect(getDocument).toHaveBeenCalledOnce();
    result.restore();
  });

  it('shows a readable placeholder and reports failures instead of silently omitting a PDF', async () => {
    const { root, iframe, app, cards, getPage, destroy } = setup();
    getPage.mockRejectedValue(new Error('Encrypted PDF'));
    const result = await preparePdfExport(root, app, cards, 2);
    expect(result.failed).toEqual(['Guide.pdf']);
    expect(root.textContent).toContain('PDF preview unavailable: Guide.pdf');
    expect(destroy).toHaveBeenCalledOnce();
    result.restore();
    expect(root.textContent).toBe('');
    expect(root.querySelector('iframe')).toBe(iframe);
  });

  it('times out a stuck document load and destroys the loading task', async () => {
    const { root, app, cards, getDocument, destroy } = setup();
    vi.useFakeTimers();
    getDocument.mockReturnValue({ promise: new Promise(() => {}), destroy });
    const pending = preparePdfExport(root, app, cards, 2);
    await vi.advanceTimersByTimeAsync(15001);
    const result = await pending;
    expect(result.failed).toEqual(['Guide.pdf']);
    expect(destroy).toHaveBeenCalledOnce();
    result.restore();
  });
});
