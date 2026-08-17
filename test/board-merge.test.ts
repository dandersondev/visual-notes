import { describe, expect, it } from 'vitest';
import { mergeBoards } from '../src/board-merge';
import type { StoryboardCard, StickyCard, VisualNotesFile } from '../src/file-types';

const sticky = (id: string, text = id): StickyCard => ({ id, kind: 'sticky', text, color: '#fff' });

function board(cards: VisualNotesFile['cards']): VisualNotesFile {
  return { version: 3, layout: 'freeform', cards, connections: [], drawings: [] };
}

describe('mergeBoards', () => {
  it('combines cards independently added on both sides', () => {
    const result = mergeBoards(board([]), board([sticky('ours')]), board([sticky('theirs')]));
    expect(result.board.cards.map(card => card.id)).toEqual(['ours', 'theirs']);
    expect(result.conflicts).toEqual([]);
  });

  it('combines edits to different cards and different fields on one card', () => {
    const base = board([sticky('a', 'old'), sticky('b', 'old')]);
    const ours = board([{ ...sticky('a', 'mine'), x: 10 }, sticky('b', 'old')]);
    const theirs = board([sticky('a', 'old'), sticky('b', 'theirs')]);
    const result = mergeBoards(base, ours, theirs);
    expect(result.board.cards).toMatchObject([
      { id: 'a', text: 'mine', x: 10 },
      { id: 'b', text: 'theirs' },
    ]);
    expect(result.conflicts).toEqual([]);
  });

  it('keeps the local value and reports a true same-field collision', () => {
    const result = mergeBoards(
      board([sticky('a', 'old')]),
      board([sticky('a', 'mine')]),
      board([sticky('a', 'theirs')]),
    );
    expect(result.board.cards[0]).toMatchObject({ text: 'mine' });
    expect(result.conflicts).toEqual([{ path: '$.cards[id=a].text', reason: 'both-changed' }]);
  });

  it('honours deletion against an unchanged item, but preserves an item edited concurrently', () => {
    const base = board([sticky('gone'), sticky('edited', 'old')]);
    const ours = board([]);
    const theirs = board([sticky('gone'), sticky('edited', 'new')]);
    const result = mergeBoards(base, ours, theirs);
    expect(result.board.cards.map(card => card.id)).toEqual(['edited']);
    expect(result.conflicts).toEqual([{ path: '$.cards[id=edited]', reason: 'delete-vs-edit' }]);
  });

  it('merges stable-id objects nested inside a storyboard', () => {
    const storyboard = (): StoryboardCard => ({
      id: 'story', kind: 'storyboard', title: 'Scene', view: 'filmstrip', previewSize: 'md',
      sections: [{ id: 'section', title: 'One', shots: [
        { id: 'shot-a', shot: '1', title: 'A', duration: 1, notes: '', aspectRatio: '16:9', objects: [], drawings: [] },
      ] }],
    });
    const baseCard = storyboard();
    const oursCard = structuredClone(baseCard);
    oursCard.sections[0].shots[0].notes = 'Camera note';
    const theirsCard = structuredClone(baseCard);
    theirsCard.sections[0].shots.push({
      id: 'shot-b', shot: '2', title: 'B', duration: 2, notes: '', aspectRatio: '16:9', objects: [], drawings: [],
    });
    const result = mergeBoards(board([baseCard]), board([oursCard]), board([theirsCard]));
    const merged = result.board.cards[0] as StoryboardCard;
    expect(merged.sections[0].shots.map(shot => shot.id)).toEqual(['shot-a', 'shot-b']);
    expect(merged.sections[0].shots[0].notes).toBe('Camera note');
    expect(result.conflicts).toEqual([]);
  });

  it('merges independent primitive reaction additions', () => {
    const base = board([{ ...sticky('a'), reactions: ['👍'] }]);
    const ours = board([{ ...sticky('a'), reactions: ['👍', '❤️'] }]);
    const theirs = board([{ ...sticky('a'), reactions: ['👍', '🎉'] }]);
    const result = mergeBoards(base, ours, theirs);
    expect(result.board.cards[0].reactions).toEqual(['👍', '❤️', '🎉']);
    expect(result.conflicts).toEqual([]);
  });
});
