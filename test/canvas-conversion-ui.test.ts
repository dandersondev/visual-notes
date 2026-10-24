// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FreeformRenderer } from '../src/freeform-view';
import { canvasToVisualNotes, type CanvasData } from '../src/canvas-format';
import { fakeApp } from './fake-app';
import { FakeVault } from './fake-vault';
import { MarkdownRenderer } from 'obsidian';

const renderers: FreeformRenderer[] = [];
afterEach(async () => {
  for (const renderer of renderers.splice(0)) await renderer.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function openNativeCanvas(viewport?: { x: number; y: number; zoom: number }) {
  const data: CanvasData = {
    nodes: [{ id: 'text', type: 'text', text: 'Original **content**\n![[./photo.png]]', x: -1240, y: -300, width: 250, height: 160 }],
    edges: [],
  };
  const board = canvasToVisualNotes(data);
  board.viewport = viewport;
  const vault = new FakeVault();
  const file = vault.putText('Folder/Imported.canvas', '') as any;
  const container = document.body.createDiv();
  const renderer = new FreeformRenderer(fakeApp(vault), container, board, file, async () => {}, async () => {});
  renderers.push(renderer);
  renderer.render();
  return { renderer, board };
}

function viewportSize(width: number, height: number) {
  return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}),
  });
}

describe('opening converted native canvases', () => {
  it('renders imported section embeds and group backgrounds', () => {
    viewportSize(800, 600);
    const vault = new FakeVault();
    vault.putText('Notes/Example.md', '# Important\nKeep this section');
    const file = vault.putText('Folder/Imported.canvas', '') as any;
    const board = canvasToVisualNotes({
      nodes: [
        { id: 'note', type: 'file', file: 'Notes/Example.md', subpath: '#Important', x: 0, y: 0, width: 250, height: 160 },
        { id: 'group', type: 'group', label: 'Original group', background: 'Assets/background.png', backgroundStyle: 'ratio', x: -50, y: -50, width: 400, height: 300 },
      ],
      edges: [],
    });
    const markdown = vi.spyOn(MarkdownRenderer, 'render');
    const renderer = new FreeformRenderer(fakeApp(vault), document.body.createDiv(), board, file, async () => {}, async () => {});
    renderers.push(renderer);
    renderer.render();
    expect(markdown).toHaveBeenCalledWith(expect.anything(), '![[Notes/Example.md#Important]]', expect.anything(), 'Folder/Imported.canvas', renderer);
    const group = renderer.cardEls.get('group')!;
    expect(group.style.backgroundImage).toContain('Assets/background.png');
    expect(group.style.backgroundSize).toBe('contain');
  });

  it('brings negative-coordinate content into view without moving the original cards', () => {
    viewportSize(800, 600);
    const markdown = vi.spyOn(MarkdownRenderer, 'render');
    const { renderer, board } = openNativeCanvas();
    const card = board.cards[0];
    expect(card).toMatchObject({ x: -1240, y: -300, w: 250, h: 160 });
    const { x, y, zoom } = renderer.vp;
    expect(card.x! * zoom + x).toBeGreaterThanOrEqual(0);
    expect(card.y! * zoom + y).toBeGreaterThanOrEqual(0);
    expect((card.x! + card.w!) * zoom + x).toBeLessThanOrEqual(800);
    expect((card.y! + card.h!) * zoom + y).toBeLessThanOrEqual(600);
    expect(board.viewport).toEqual(renderer.vp);
    expect(markdown).toHaveBeenCalledWith(expect.anything(), 'Original **content**\n![[./photo.png]]', expect.anything(), 'Folder/Imported.canvas', renderer);
  });

  it('waits for a hidden pane to get a size before fitting', () => {
    const size = viewportSize(0, 0);
    let notify: () => void = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { notify = callback; }
      observe() {}
      disconnect = disconnect;
    });
    const { renderer, board } = openNativeCanvas();
    expect(board.viewport).toBeUndefined();
    expect(renderer.vp).toEqual({ x: 0, y: 0, zoom: 1 });
    size.mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON: () => ({}) });
    notify();
    expect(board.viewport).toEqual(renderer.vp);
    expect(renderer.vp.x).toBeGreaterThan(0);
    expect(disconnect).toHaveBeenCalled();
  });

  it('keeps a viewport that the user has already saved', () => {
    viewportSize(800, 600);
    const viewport = { x: 10, y: 20, zoom: 0.5 };
    const { renderer } = openNativeCanvas(viewport);
    expect(renderer.vp).toEqual(viewport);
  });
});
