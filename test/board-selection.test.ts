// @vitest-environment jsdom
//
// A rebuild is a re-render, not a deselection. Undo/redo route through
// rebuildCards(), which used to clear the selection along with the DOM.
import { afterEach, describe, expect, it } from 'vitest';
import { FreeformRenderer } from '../src/freeform-view';
import { DEFAULT_PEN_DRAW_OPTIONS } from '../src/pen-options-panel';
import { fakeApp } from './fake-app';
import type { VisualNotesFile } from '../src/file-types';

const live: FreeformRenderer[] = [];
afterEach(async () => {
  for (const renderer of live.splice(0)) await renderer.destroy();
  document.body.innerHTML = '';
});

function makeBoard(): FreeformRenderer {
  const container = document.body.createDiv();
  const board: VisualNotesFile = {
    version: 3, layout: 'freeform', viewport: { x: 0, y: 0, zoom: 1 },
    cards: [
      { id: 'a', kind: 'sticky', x: 20, y: 20, w: 200, h: 140, text: 'A', color: '#fff' },
      { id: 'b', kind: 'sticky', x: 300, y: 20, w: 200, h: 140, text: 'B', color: '#fff' },
    ],
    connections: [], drawings: [],
  };
  const file = { path: 'Board.canvas', basename: 'Board', name: 'Board.canvas', extension: 'canvas' } as never;
  const renderer = new FreeformRenderer(
    fakeApp(), container, board, file, async () => {}, async () => {},
    30, undefined, 'left', undefined, false, 1, false, false, 32, undefined, 'bottom-right',
    { ...DEFAULT_PEN_DRAW_OPTIONS }, undefined, 'middle', true, undefined,
  );
  renderer.render();
  live.push(renderer);
  return renderer;
}

describe('selection survives a rebuild', () => {
  it('keeps the selection through undo, so a nudge can be repeated', () => {
    const board = makeBoard();
    board.selection.select('a');
    board.refreshSelectionVisuals();

    // What an arrow-key nudge does: one undo step, then move.
    board.pushUndo();
    board.board.cards[0].x = 30;

    board.undo();

    expect(board.board.cards[0].x).toBe(20);
    expect(board.selection.has('a')).toBe(true);
    expect(board.cardEls.get('a')?.hasClass('is-selected')).toBe(true);
  });

  it('keeps a multi-card selection through redo', () => {
    const board = makeBoard();
    board.selection.select('a');
    board.selection.add('b');
    board.pushUndo();
    board.board.cards[0].x = 30;
    board.undo();
    board.redo();

    expect(board.board.cards[0].x).toBe(30);
    expect(board.selection.getIds().sort()).toEqual(['a', 'b']);
  });

  it('drops cards an undo removed rather than keeping dangling ids', () => {
    const board = makeBoard();
    // Adding a card, selecting it, then undoing the addition.
    board.pushUndo();
    board.board.cards.push({ id: 'c', kind: 'sticky', x: 600, y: 20, w: 200, h: 140, text: 'C', color: '#fff' });
    board.rebuildCards();
    board.selection.select('c');
    board.selection.add('a');

    board.undo();

    expect(board.board.cards.some(card => card.id === 'c')).toBe(false);
    expect(board.selection.has('c')).toBe(false);
    expect(board.selection.has('a')).toBe(true);
  });
});
