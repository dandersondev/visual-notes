// @vitest-environment jsdom
//
// Adding a Kanban item mutated the board and appended straight to the DOM
// without asking for a save. Closing the board without some other edit lost
// the item; in a collaboration room the unpublished change also held every
// incoming operation back, so one added item froze everyone's view.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FreeformRenderer } from '../src/freeform-view';
import { LoopbackCollaborationTransport } from '../src/collaboration-transport';
import { DEFAULT_PEN_DRAW_OPTIONS } from '../src/pen-options-panel';
import { fakeApp } from './fake-app';
import type { CollaborationIdentity } from '../src/collaboration-identity';
import type { KanbanBoardCard, VisualNotesFile } from '../src/file-types';

const live: FreeformRenderer[] = [];
afterEach(async () => {
  for (const renderer of live.splice(0)) await renderer.destroy();
  document.body.innerHTML = '';
});

const alice: CollaborationIdentity = {
  clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', displayName: 'Alice', color: '#e57373',
};
const bob: CollaborationIdentity = {
  clientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', displayName: 'Bob', color: '#4fc3f7',
};

function kanbanBoard(): VisualNotesFile {
  return {
    version: 3, layout: 'freeform', viewport: { x: 0, y: 0, zoom: 1 },
    cards: [{
      id: 'kb', kind: 'kanban-board', x: 20, y: 20, w: 900, h: 600, title: 'Sprint',
      columns: [
        { id: 'todo', title: 'To do', color: '#888', items: [{ id: 'i1', text: 'First', done: false }] },
        { id: 'done', title: 'Done', color: '#888', items: [] },
      ],
    }],
    connections: [], drawings: [],
  };
}

function makeRenderer(transport?: LoopbackCollaborationTransport, identity?: CollaborationIdentity): FreeformRenderer {
  const container = document.body.createDiv();
  const file = { path: 'Board.canvas', basename: 'Board', name: 'Board.canvas', extension: 'canvas' } as never;
  const renderer = new FreeformRenderer(
    fakeApp(), container, kanbanBoard(), file, async () => {}, async () => {},
    30, undefined, 'left', undefined, false, 1, false, false, 32, undefined, 'bottom-right',
    { ...DEFAULT_PEN_DRAW_OPTIONS }, undefined, 'middle', true,
    transport && identity ? { transport, identity } : undefined,
  );
  renderer.render();
  live.push(renderer);
  return renderer;
}

/** The "Add item" button for a column, as the user would press it. */
function addItemButton(renderer: FreeformRenderer, columnId: string): HTMLElement {
  const itemsEl = renderer.container.querySelector<HTMLElement>(`[data-owner-column-id="${columnId}"]`);
  if (!itemsEl) throw new Error(`no items element for column ${columnId}`);
  const owner = renderer.resolveKanbanItemsOwner(itemsEl);
  if (!owner) throw new Error(`no owner for column ${columnId}`);
  return { click: () => renderer.addItemToOwner(owner, itemsEl) } as unknown as HTMLElement;
}

const columns = (r: FreeformRenderer): KanbanBoardCard['columns'] =>
  (r.board.cards[0] as KanbanBoardCard).columns;

describe('adding a Kanban item', () => {
  it('asks for a save, so the item survives closing the board', () => {
    const renderer = makeRenderer();
    expect(renderer.saveQueue.hasPendingWork).toBe(false);

    (addItemButton(renderer, 'todo') as unknown as { click: () => void }).click();

    expect(columns(renderer)[0].items).toHaveLength(2);
    // Without this the board holds an item nothing has been asked to write,
    // and destroy() sees no pending work to flush.
    expect(renderer.saveQueue.hasPendingWork).toBe(true);
  });

  it('reaches the other people in the room', async () => {
    const transport = new LoopbackCollaborationTransport();
    const a = makeRenderer(transport, alice);
    const b = makeRenderer(transport, bob);
    await vi.waitFor(() => expect(a.container.querySelectorAll('.visual-notes-collaboration-avatar')).toHaveLength(2));

    // Deliberately not flushed by hand: asking for the flush is the exact
    // step that was missing, so a test that calls it tests nothing.
    (addItemButton(a, 'todo') as unknown as { click: () => void }).click();

    await vi.waitFor(() => expect(columns(b)[0].items).toHaveLength(2));
    expect(columns(b)[0].items[1].text).toBe('Item 2');
  });

  it('does not block edits arriving from everyone else', async () => {
    const transport = new LoopbackCollaborationTransport();
    const a = makeRenderer(transport, alice);
    const b = makeRenderer(transport, bob);
    await vi.waitFor(() => expect(a.container.querySelectorAll('.visual-notes-collaboration-avatar')).toHaveLength(2));

    // Bob adds an item, then Alice renames one of hers. Bob's unpublished add
    // used to hold Alice's rename back until Bob happened to save.
    (addItemButton(b, 'done') as unknown as { click: () => void }).click();

    columns(a)[0].items[0].text = 'Renamed by Alice';
    await a.flushCollaborationSync();

    await vi.waitFor(() => expect(columns(b)[0].items[0].text).toBe('Renamed by Alice'));
  });
});
