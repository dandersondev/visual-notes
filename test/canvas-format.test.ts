import { describe, it, expect } from 'vitest';
import { visualNotesToCanvas, canvasToVisualNotes, isVisualNotesCanvas, type CanvasData } from '../src/canvas-format';
import type {
  VisualNotesFile, TileCard, StickyCard, ChecklistCard, KanbanBoardCard, GroupCard, Connection, StoryboardCard,
} from '../src/file-types';

function board(cards: VisualNotesFile['cards'], connections: Connection[] = []): VisualNotesFile {
  return { version: 3, layout: 'freeform', cards, connections, drawings: [], viewport: { x: 0, y: 0, zoom: 1 } };
}

describe('canvas-format round trips', () => {
  it('round-trips a storyboard as one node with nested sections, shots, ink, and objects', () => {
    const storyboard: StoryboardCard = {
      id: 'sb1', kind: 'storyboard', title: 'Opening', view: 'filmstrip', previewSize: 'lg', x: 10, y: 20, w: 640, h: 380,
      sections: [{ id: 'section1', title: 'Arrival', shots: [{
        id: 'panel1', shot: '1.1', title: 'Wide', duration: 4, aspectRatio: '16:9', notes: 'Hold on the door',
        background: { type: 'vault', path: 'Assets/door.png' },
        drawings: [{ id: 'stroke1', color: '#ef4444', width: 5, brush: 'marker', opacity: .8, smoothing: .65, pressureEnabled: true, simulatePressure: false, points: [{ x: .1, y: .2, p: .2 }, { x: .5, y: .7, p: .9 }] }],
        objects: [
          { id: 'text1', kind: 'text', x: .2, y: .3, text: 'ENTER', size: 24 },
          { id: 'arrow1', kind: 'arrow', x: .1, y: .8, x2: .8, y2: .3, bend: .18, color: '#2563eb', width: 6 },
        ],
      }] }],
    };
    const canvas = visualNotesToCanvas(board([storyboard]));
    expect(canvas.nodes).toHaveLength(1);
    expect(canvas.nodes[0].type).toBe('text');
    expect((canvas.nodes[0] as { text: string }).text).toContain('1.1 — Wide — 4s');
    const out = canvasToVisualNotes(canvas);
    expect(out.cards[0]).toEqual(storyboard);
  });

  it('preserves id, kind, and content fields across every basic card kind', () => {
    const tile: TileCard = {
      id: 't1', kind: 'tile', x: 10, y: 20, w: 200, h: 120,
      label: 'My Tile', icon: 'star', color: '#3B82F6', target: { kind: 'note', path: 'Notes/Foo.md' },
    };
    const sticky: StickyCard = {
      id: 's1', kind: 'sticky', x: 300, y: 20, w: 240, h: 200, text: 'Hello **world**', color: '#FDE68A',
    };
    const checklist: ChecklistCard = {
      id: 'c1', kind: 'checklist', x: 10, y: 200, w: 280, h: 260, color: '#ffffff',
      title: 'Todo', items: [
        { id: 'i1', text: 'First', done: true },
        { id: 'i2', text: 'Second', done: false },
      ],
    };
    const src = board([tile, sticky, checklist]);

    const canvas = visualNotesToCanvas(src);
    const out = canvasToVisualNotes(canvas);

    expect(out.cards).toHaveLength(3);
    const outTile = out.cards.find(c => c.id === 't1') as TileCard;
    expect(outTile).toMatchObject({ kind: 'tile', label: 'My Tile', icon: 'star', color: '#3B82F6', x: 10, y: 20, w: 200, h: 120 });
    expect(outTile.target).toEqual({ kind: 'note', path: 'Notes/Foo.md' });

    const outSticky = out.cards.find(c => c.id === 's1') as StickyCard;
    expect(outSticky).toMatchObject({ kind: 'sticky', text: 'Hello **world**', color: '#FDE68A' });

    const outChecklist = out.cards.find(c => c.id === 'c1') as ChecklistCard;
    expect(outChecklist.items).toEqual(checklist.items);
  });

  it('round-trips a multi-column kanban board including item done-state via native text sync', () => {
    const kanban: KanbanBoardCard = {
      id: 'kb1', kind: 'kanban-board', x: 0, y: 0, w: 580, h: 420, title: 'Sprint',
      columns: [
        { id: 'col1', title: 'To do', color: '#eee', items: [{ id: 'it1', text: 'Write tests', done: false }] },
        { id: 'col2', title: 'Done', color: '#cfc', items: [{ id: 'it2', text: 'Ship it', done: true }] },
      ],
    };
    const out = canvasToVisualNotes(visualNotesToCanvas(board([kanban])));
    const outKanban = out.cards.find(c => c.id === 'kb1') as KanbanBoardCard;
    expect(outKanban.columns).toHaveLength(2);
    expect(outKanban.columns[0].items).toEqual([{ id: 'it1', text: 'Write tests', done: false }]);
    expect(outKanban.columns[1].items).toEqual([{ id: 'it2', text: 'Ship it', done: true }]);
  });

  it('round-trips a connection between two cards with full styling', () => {
    const a: GroupCard = { id: 'a', kind: 'group', x: 0, y: 0, w: 100, h: 100, label: 'A' };
    const b: GroupCard = { id: 'b', kind: 'group', x: 300, y: 0, w: 100, h: 100, label: 'B' };
    const conn: Connection = {
      id: 'conn1', fromCardId: 'a', toCardId: 'b', routing: 'elbow', elbowOrientation: 'horizontal-first',
      bend: 12, label: 'flows to', labelSize: 16, color: '#ff0000', style: 'dashed', arrowhead: 'both', thickness: 4,
    };
    const out = canvasToVisualNotes(visualNotesToCanvas(board([a, b], [conn])));
    expect(out.connections).toHaveLength(1);
    expect(out.connections[0]).toEqual(conn);
  });

  it('round-trips a free-floating (non-card-anchored) line via vn.freeLines', () => {
    const a: GroupCard = { id: 'a', kind: 'group', x: 0, y: 0, w: 100, h: 100 };
    const freeLine: Connection = {
      id: 'fl1', fromCardId: 'a', toPoint: { x: 500, y: 500 },
      routing: 'straight', color: '#000000', style: 'solid', arrowhead: 'end', thickness: 2,
    };
    const out = canvasToVisualNotes(visualNotesToCanvas(board([a], [freeLine])));
    expect(out.connections).toEqual([freeLine]);
  });

  it('drops a free line whose only card end no longer exists', () => {
    const freeLine: Connection = {
      id: 'fl1', fromCardId: 'missing-card', toPoint: { x: 500, y: 500 },
      routing: 'straight', color: '#000000', style: 'solid', arrowhead: 'end', thickness: 2,
    };
    const out = canvasToVisualNotes(visualNotesToCanvas(board([], [freeLine])));
    expect(out.connections).toEqual([]);
  });

  it('fully round-trips archived cards, including z-index (not stripped like live cards)', () => {
    const archivedCard: StickyCard = { id: 'arch1', kind: 'sticky', x: 1, y: 2, w: 3, h: 4, z: 99, text: 'old', color: '#fff' };
    const src = board([]);
    src.archived = [archivedCard];
    const out = canvasToVisualNotes(visualNotesToCanvas(src));
    expect(out.archived).toEqual([archivedCard]);
  });

  it('preserves z-index on live (non-archived) cards', () => {
    // z has no top-level equivalent in the JSON Canvas node spec (unlike
    // x/y/w/h), so it can only survive via `vn` — stashable() must not
    // strip it the way it strips the positional fields.
    const s: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 1, h: 1, z: 42, text: 'x', color: '#fff' };
    const out = canvasToVisualNotes(visualNotesToCanvas(board([s])));
    expect(out.cards[0].z).toBe(42);
  });

  it('preserves board-level metadata (viewport, dotsHidden, layout)', () => {
    const src = board([]);
    src.dotsHidden = true;
    src.viewport = { x: 123, y: -45, zoom: 1.5 };
    const out = canvasToVisualNotes(visualNotesToCanvas(src));
    expect(out.layout).toBe('freeform');
    expect(out.dotsHidden).toBe(true);
    expect(out.viewport).toEqual({ x: 123, y: -45, zoom: 1.5 });
  });
});

describe('canvas-format: foreign / native-Canvas content', () => {
  it('synthesizes a sensible card from a plain native image node with no vn tag', () => {
    const data: CanvasData = {
      nodes: [{ id: 'n1', type: 'file', x: 0, y: 0, width: 200, height: 150, file: 'Attachments/photo.png' }],
      edges: [],
    };
    const out = canvasToVisualNotes(data);
    expect(out.cards).toHaveLength(1);
    expect(out.cards[0]).toMatchObject({ kind: 'image', id: 'n1' });
  });

  it('never drops a node type it does not recognize — preserved verbatim in foreignNodes', () => {
    const weirdNode = { id: 'n1', type: 'file', x: 0, y: 0, width: 100, height: 100, file: 'weird.xyz', vn: { kind: 'nonexistent-kind-from-a-future-version' } };
    const data: CanvasData = { nodes: [weirdNode as never], edges: [] };
    expect(() => canvasToVisualNotes(data)).not.toThrow();
  });

  it('drops an edge referencing a card id that does not exist into foreignEdges instead of crashing', () => {
    const data: CanvasData = {
      nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'A' }],
      edges: [{ id: 'e1', fromNode: 'a', toNode: 'does-not-exist' }],
    };
    const out = canvasToVisualNotes(data);
    expect(out.connections).toEqual([]);
    expect(out.foreignEdges).toHaveLength(1);
  });

  it('re-emits unrecognized foreign nodes/edges byte-for-byte on the next export', () => {
    const foreignNode = { id: 'x1', type: 'text', x: 5, y: 5, width: 50, height: 50, text: 'plain native note' };
    const src = board([]);
    src.foreignNodes = [foreignNode as never];
    const canvas = visualNotesToCanvas(src);
    expect(canvas.nodes).toContainEqual(foreignNode);
  });

  it('isVisualNotesCanvas is true only for boards carrying our version marker', () => {
    expect(isVisualNotesCanvas({ nodes: [], edges: [], vn: { version: 1, layout: 'freeform' } })).toBe(true);
    expect(isVisualNotesCanvas({ nodes: [], edges: [] })).toBe(false);
    expect(isVisualNotesCanvas({ nodes: [], edges: [], vn: {} as never })).toBe(false);
  });
});

describe('canvas-format: malformed/corrupt input resilience', () => {
  it('handles a totally empty canvas without throwing', () => {
    expect(() => canvasToVisualNotes({ nodes: [], edges: [] })).not.toThrow();
    const out = canvasToVisualNotes({ nodes: [], edges: [] });
    expect(out.cards).toEqual([]);
    expect(out.connections).toEqual([]);
  });

  it('handles a node with a non-object vn value by treating it as a foreign node', () => {
    const data: CanvasData = {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'hi', vn: 'not-an-object' as never }],
      edges: [],
    };
    expect(() => canvasToVisualNotes(data)).not.toThrow();
    const out = canvasToVisualNotes(data);
    // Falls through to native synthesis for a plain text node.
    expect(out.cards[0]).toMatchObject({ kind: 'sticky', id: 'n1' });
  });

  it('handles nodes missing expected numeric fields without throwing', () => {
    const data = {
      nodes: [{ id: 'n1', type: 'text', text: 'no coords here' }],
      edges: [],
    } as unknown as CanvasData;
    expect(() => canvasToVisualNotes(data)).not.toThrow();
  });

  it('handles vn.freeLines being absent, null-ish, or malformed without throwing', () => {
    expect(() => canvasToVisualNotes({ nodes: [], edges: [], vn: { version: 1, layout: 'freeform' } })).not.toThrow();
  });
});

// ── Surviving Obsidian's native Canvas view ──────────────────────────────
//
// Native Canvas rebuilds a file from its own {nodes, edges} model whenever it
// saves. Per-node extra keys ride along in Obsidian's `unknownData`
// passthrough; root-level extra keys have nowhere to go and are dropped.
// Reported in the wild as boards losing their kanban/checklist/sticky content
// "forever" after being opened from the file explorer with canvas-patching
// plugins installed (those save on load, before Visual Notes takes the leaf).
function stripRootMeta(data: CanvasData): CanvasData {
  return { nodes: data.nodes.map(n => ({ ...n })), edges: data.edges.map(e => ({ ...e })) };
}

function stripAllStashes(data: CanvasData): CanvasData {
  return {
    nodes: data.nodes.map(n => { const c = { ...n } as Record<string, unknown>; delete c.vn; delete c.ib; return c as CanvasData['nodes'][number]; }),
    edges: data.edges.map(e => ({ ...e })),
  };
}

describe('native Canvas round-trip damage', () => {
  const kanban: KanbanBoardCard = {
    id: 'kb1', kind: 'kanban-board', x: 0, y: 0, w: 580, h: 420,
    columns: [
      { id: 'c1', title: 'To do', items: [{ id: 'i1', text: 'Buy milk' }, { id: 'i2', text: 'Walk dog' }] },
      { id: 'c2', title: 'Done', items: [{ id: 'i3', text: 'Ship it' }] },
    ],
  };

  it('still recognises a board whose root vn was stripped', () => {
    const damaged = stripRootMeta(visualNotesToCanvas(board([kanban])));
    // Without this the board is disowned permanently: the file-open takeover
    // skips it and the manual switch refuses it, with the cards still intact.
    expect(isVisualNotesCanvas(damaged)).toBe(true);
  });

  it('recovers the cards from a root-stripped board', () => {
    const damaged = stripRootMeta(visualNotesToCanvas(board([kanban])));
    const out = canvasToVisualNotes(damaged);
    const kb = out.cards.find(c => c.id === 'kb1');
    expect(kb?.kind).toBe('kanban-board');
    expect(kb?.kind === 'kanban-board' && kb.columns.flatMap(c => c.items)).toHaveLength(3);
  });

  it('never deletes kanban sub-nodes whose parent lost its vn stash', () => {
    const saved = visualNotesToCanvas(board([kanban]));
    const damaged = stripAllStashes(saved);
    const idsOnDisk = damaged.nodes.map(n => n.id).sort();

    // Read it back and save it again — the destructive path, since the parent
    // can no longer rebuild its items and the sub-nodes used to be skipped.
    const resaved = visualNotesToCanvas(canvasToVisualNotes(damaged));
    expect(resaved.nodes.map(n => n.id).sort()).toEqual(idsOnDisk);
  });

  it('leaves an undamaged board alone', () => {
    const healthy = visualNotesToCanvas(board([kanban]));
    const out = canvasToVisualNotes(healthy);
    // Sub-nodes are still absorbed by the parent, not duplicated as foreign.
    expect(out.foreignNodes ?? []).toHaveLength(0);
    expect(out.cards).toHaveLength(1);
  });

  it('does not claim ownership of a genuinely native canvas', () => {
    expect(isVisualNotesCanvas({
      nodes: [{ id: 'n1', type: 'text', text: 'plain', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    })).toBe(false);
  });
});

// ── Legacy `ib` key compatibility ────────────────────────────────────────
//
// Boards written before the plugin was renamed off "Icon Board" stash their
// data under `ib` instead of `vn`. That spelling is read forever and never
// written: dropping it would disown every board authored before the rename,
// which is the same permanent-loss failure as the native-Canvas strip above
// but self-inflicted and universal. These tests are the guard on that.
describe('legacy ib key', () => {
  const legacyBoard = (): CanvasData => ({
    nodes: [
      {
        id: 's1', type: 'text', x: 10, y: 20, width: 240, height: 200, text: 'hi', color: '#FDE68A',
        ib: { kind: 'sticky', id: 's1', text: 'hi', color: '#FDE68A', z: 7 },
      } as never,
    ],
    edges: [
      { id: 'e1', fromNode: 's1', toNode: 's1', ib: { routing: 'elbow', thickness: 4, arrowhead: 'both' } } as never,
    ],
    ib: { version: 1, layout: 'grid', dotsHidden: true, viewport: { x: 1, y: 2, zoom: 3 } },
  });

  it('is still recognised as a Visual Notes board', () => {
    expect(isVisualNotesCanvas(legacyBoard())).toBe(true);
  });

  it('reads root metadata from the legacy key', () => {
    const out = canvasToVisualNotes(legacyBoard());
    expect(out.layout).toBe('grid');
    expect(out.dotsHidden).toBe(true);
    expect(out.viewport).toEqual({ x: 1, y: 2, zoom: 3 });
  });

  it('reads card and connection stashes from the legacy key', () => {
    const out = canvasToVisualNotes(legacyBoard());
    expect(out.cards[0]).toMatchObject({ kind: 'sticky', id: 's1', text: 'hi', z: 7 });
    expect(out.connections[0]).toMatchObject({ routing: 'elbow', thickness: 4, arrowhead: 'both' });
  });

  it('migrates to the new key on save, leaving no ib behind', () => {
    const resaved = visualNotesToCanvas(canvasToVisualNotes(legacyBoard()));
    const json = JSON.stringify(resaved);
    expect(json).not.toContain('"ib"');
    expect(resaved.vn?.layout).toBe('grid');
    expect(resaved.nodes[0].vn).toMatchObject({ kind: 'sticky', z: 7 });
  });

  it('prefers vn when a file somehow carries both', () => {
    const both: CanvasData = {
      nodes: [], edges: [],
      vn: { version: 1, layout: 'freeform' },
      ib: { version: 1, layout: 'grid' },
    };
    expect(canvasToVisualNotes(both).layout).toBe('freeform');
  });
});
