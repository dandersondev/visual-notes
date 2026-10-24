import { describe, expect, it, vi } from 'vitest';
import { convertNativeCanvasFile, isVisualNotesOwnedFile, readBoardFile, writeBoardFile } from '../src/file-io';
import { FakeVault } from './fake-vault';

const nativeCanvas = {
  nodes: [
    { id: 'text', type: 'text', text: 'Hello **canvas**', x: -100, y: 20, width: 240, height: 160 },
    { id: 'note', type: 'file', file: 'Notes/Example.md', x: 200, y: 20, width: 300, height: 200 },
    { id: 'group', type: 'group', label: 'Ideas', x: -150, y: -30, width: 700, height: 350 },
    { id: 'link', type: 'link', url: 'https://example.com', x: 200, y: 400, width: 300, height: 200 },
    { id: 'image', type: 'file', file: 'Assets/photo.png', x: 600, y: 400, width: 300, height: 200 },
  ],
  edges: [{ id: 'edge', fromNode: 'text', toNode: 'note', fromSide: 'right', toSide: 'left', label: 'Related' }],
};

describe('convertNativeCanvasFile', () => {
  it('keeps native content and extension fields through conversion, editing and subsequent saves', async () => {
    const vault = new FakeVault();
    const native = {
      ...nativeCanvas,
      customBoard: { title: 'Original board info' },
      nodes: nativeCanvas.nodes.map(node => ({
        ...node,
        customNode: { important: 'Keep me' },
        ...(node.id === 'note' ? { subpath: '#Important section' } : {}),
        ...(node.id === 'group' ? { background: 'Assets/background.png', backgroundStyle: 'ratio' } : {}),
      })),
      edges: nativeCanvas.edges.map(edge => ({ ...edge, toEnd: 'none', customEdge: { weight: 5 } })),
    };
    const source = vault.putText('Ideas.canvas', JSON.stringify(native));
    const app = vault.toApp();
    const { converted } = await convertNativeCanvasFile(app, source);
    const imported = JSON.parse(vault.textAt(converted.path));
    expect(imported).toMatchObject(native);
    const board = await readBoardFile(app, converted);
    expect(board.cards.find(card => card.id === 'note')).toMatchObject({ subpath: '#Important section' });
    expect(board.cards.find(card => card.id === 'group')).toMatchObject({ background: 'Assets/background.png', backgroundStyle: 'ratio' });
    const text = board.cards.find(card => card.kind === 'sticky')!;
    if (text.kind === 'sticky') text.text = 'Edited text';
    board.cards = board.cards.filter(card => card.id !== 'image');
    await writeBoardFile(app, converted, board);
    const saved = JSON.parse(vault.textAt(converted.path));
    expect(saved.customBoard).toEqual(native.customBoard);
    expect(saved.nodes.find((node: { id: string }) => node.id === 'text')).toMatchObject({ text: 'Edited text', customNode: { important: 'Keep me' } });
    expect(saved.nodes.find((node: { id: string }) => node.id === 'image')).toBeUndefined();
    expect(saved.nodes.find((node: { id: string }) => node.id === 'note')).toMatchObject({ subpath: '#Important section' });
    expect(saved.nodes.find((node: { id: string }) => node.id === 'group')).toMatchObject({ background: 'Assets/background.png', backgroundStyle: 'ratio' });
    expect(saved.edges[0]).toMatchObject(native.edges[0]);
    expect(vault.textAt(source.path)).toBe(JSON.stringify(native));
  });

  it('keeps the original untouched and creates only one marked board in the same folder', async () => {
    const vault = new FakeVault();
    const raw = JSON.stringify(nativeCanvas, null, '\t') + '\n';
    const source = vault.putText('Projects/Ideas.canvas', raw);
    const app = vault.toApp();
    const { converted } = await convertNativeCanvasFile(app, source);

    expect(converted.path).toBe('Projects/Ideas (Visual Notes).canvas');
    expect(vault.textAt(source.path)).toBe(raw);
    expect(app.vault.getFiles().map(file => file.path).sort()).toEqual([
      'Projects/Ideas (Visual Notes).canvas', 'Projects/Ideas.canvas',
    ]);
    expect(await isVisualNotesOwnedFile(app, source)).toBe(false);
    expect(await isVisualNotesOwnedFile(app, converted)).toBe(true);
    const board = await readBoardFile(app, converted);
    expect(board.layout).toBe('freeform');
    expect(board.cards).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'text', kind: 'sticky', text: 'Hello **canvas**', x: -100, y: 20, w: 240, h: 160 }),
      expect.objectContaining({ id: 'note', kind: 'note-link', path: 'Notes/Example.md' }),
      expect.objectContaining({ id: 'group', kind: 'group', label: 'Ideas' }),
      expect.objectContaining({ id: 'link', kind: 'bookmark', url: 'https://example.com' }),
      expect.objectContaining({ id: 'image', kind: 'image', source: { type: 'vault', path: 'Assets/photo.png' } }),
    ]));
    expect(board.connections[0]).toMatchObject({
      id: 'edge', fromCardId: 'text', toCardId: 'note', label: 'Related',
      fromAnchor: { side: 'e', t: 0.5 }, toAnchor: { side: 'w', t: 0.5 },
    });
  });

  it('uses numbered filenames on repeated conversions without replacing existing boards', async () => {
    const vault = new FakeVault();
    const source = vault.putText('Ideas.canvas', JSON.stringify(nativeCanvas));
    const app = vault.toApp();
    const first = await convertNativeCanvasFile(app, source);
    const firstRaw = vault.textAt(first.converted.path);
    const second = await convertNativeCanvasFile(app, source);
    expect(second.converted.path).toBe('Ideas (Visual Notes) 1.canvas');
    expect(vault.textAt(first.converted.path)).toBe(firstRaw);
    expect(vault.textAt(source.path)).toBe(JSON.stringify(nativeCanvas));
    expect(app.vault.getFiles()).toHaveLength(3);
  });

  it('creates a recognizable Visual Notes board even for an empty native canvas', async () => {
    const vault = new FakeVault();
    const source = vault.putText('Empty.canvas', '{"nodes":[],"edges":[]}');
    const app = vault.toApp();
    const { converted } = await convertNativeCanvasFile(app, source);
    expect(await isVisualNotesOwnedFile(app, converted)).toBe(true);
  });

  it.each(['broken JSON', 'null', '{}', '{"nodes":[]}', '{"nodes":[null],"edges":[]}'])('creates no files for invalid input: %s', async raw => {
    const vault = new FakeVault();
    const source = vault.putText('Broken.canvas', raw);
    const app = vault.toApp();
    await expect(convertNativeCanvasFile(app, source)).rejects.toThrow();
    expect(app.vault.getFiles()).toHaveLength(1);
    expect(vault.textAt(source.path)).toBe(raw);
  });

  it('does not convert an already converted board', async () => {
    const vault = new FakeVault();
    const source = vault.putText('Board.canvas', '{"nodes":[],"edges":[],"vn":{"version":1,"layout":"freeform"}}');
    const app = vault.toApp();
    await expect(convertNativeCanvasFile(app, source)).rejects.toThrow('already a Visual Notes canvas');
    expect(app.vault.getFiles()).toHaveLength(1);
  });

  it('keeps the source untouched if creating the converted board fails', async () => {
    const vault = new FakeVault();
    const raw = JSON.stringify(nativeCanvas);
    const source = vault.putText('Ideas.canvas', raw);
    const app = vault.toApp();
    const create = vi.spyOn(app.vault, 'create').mockRejectedValue(new Error('Disk full'));
    await expect(convertNativeCanvasFile(app, source)).rejects.toThrow('Disk full');
    expect(create).toHaveBeenCalledTimes(1);
    expect(app.vault.getFiles()).toHaveLength(1);
    expect(vault.textAt(source.path)).toBe(raw);
  });
});
