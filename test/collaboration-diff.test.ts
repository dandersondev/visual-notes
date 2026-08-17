import { describe, expect, it } from 'vitest';
import { diffBoardOperations } from '../src/collaboration-diff';
import { applyBoardOperation, createBoardOperation } from '../src/collaboration-operations';
import type { CollaborationIdentity } from '../src/collaboration-identity';
import type { StoryboardCard, StickyCard, VisualNotesFile } from '../src/file-types';

const identity: CollaborationIdentity = {
  clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', displayName: 'Alice', color: '#e57373',
};
const sticky = (id: string, text = id): StickyCard => ({ id, kind: 'sticky', text, color: '#fff' });
const board = (cards: VisualNotesFile['cards']): VisualNotesFile =>
  ({ version: 3, layout: 'freeform', cards, connections: [], drawings: [] });

function applyDiff(before: VisualNotesFile, after: VisualNotesFile): VisualNotesFile {
  let current = before;
  diffBoardOperations(before, after).forEach((action, index) => {
    const operation = createBoardOperation(identity, 'board', index + 1, action, {
      operationId: `op-${index}`, createdAt: index,
    });
    const result = applyBoardOperation(current, operation);
    expect(result.error).toBeUndefined();
    current = result.board;
  });
  return current;
}

describe('diffBoardOperations', () => {
  it('emits nothing for identical content or viewport-only changes', () => {
    const before = board([sticky('a')]);
    const after = structuredClone(before);
    after.viewport = { x: 20, y: 30, zoom: 2 };
    expect(diffBoardOperations(before, after)).toEqual([]);
  });

  it('updates one field without replacing the whole card collection', () => {
    const before = board([sticky('a', 'old'), sticky('b')]);
    const after = board([sticky('a', 'new'), sticky('b')]);
    expect(diffBoardOperations(before, after)).toEqual([
      { kind: 'set', path: ['cards', { id: 'a' }, 'text'], value: 'new' },
    ]);
    expect(applyDiff(before, after)).toEqual(after);
  });

  it('inserts, deletes, and reorders stable-ID cards', () => {
    const before = board([sticky('a'), sticky('b'), sticky('c')]);
    const after = board([sticky('c'), sticky('new'), sticky('a')]);
    expect(applyDiff(before, after)).toEqual(after);
  });

  it('inserts a new first entity at the beginning', () => {
    const before = board([sticky('a'), sticky('b')]);
    const after = board([sticky('new'), sticky('a'), sticky('b')]);
    expect(diffBoardOperations(before, after)).toEqual([
      { kind: 'insert', path: ['cards'], value: sticky('new'), afterId: undefined },
    ]);
    expect(applyDiff(before, after)).toEqual(after);
  });

  it('emits only the moves needed for a large item reorder', () => {
    const before = board(Array.from({ length: 20 }, (_, index) => sticky(String(index))));
    const afterCards = [...before.cards];
    afterCards.splice(2, 0, afterCards.splice(17, 1)[0]);
    const after = board(afterCards);
    const actions = diffBoardOperations(before, after);
    expect(actions).toEqual([
      { kind: 'move', path: ['cards'], id: '17', afterId: '1' },
    ]);
    expect(applyDiff(before, after)).toEqual(after);

    const movedDownCards = [...before.cards];
    movedDownCards.splice(17, 0, movedDownCards.splice(2, 1)[0]);
    const movedDown = board(movedDownCards);
    expect(diffBoardOperations(before, movedDown)).toEqual([
      { kind: 'move', path: ['cards'], id: '2', afterId: '17' },
    ]);
    expect(applyDiff(before, movedDown)).toEqual(movedDown);
  });

  it('addresses nested storyboard shots by stable ID', () => {
    const story = (): StoryboardCard => ({
      id: 'story', kind: 'storyboard', title: 'Scene', sections: [{ id: 'section', title: 'One', shots: [
        { id: 'shot', shot: '1', title: 'Old', aspectRatio: '16:9', objects: [], drawings: [] },
      ] }],
    });
    const before = board([story()]);
    const changed = story();
    changed.sections[0].shots[0].title = 'New';
    const after = board([changed]);
    expect(diffBoardOperations(before, after)).toContainEqual({
      kind: 'set',
      path: ['cards', { id: 'story' }, 'sections', { id: 'section' }, 'shots', { id: 'shot' }, 'title'],
      value: 'New',
    });
    expect(applyDiff(before, after)).toEqual(after);
  });
});
