// Guards against a board file losing everything in it.
//
// Written after a user reported a board that opened empty and dropped out of
// its parent's tile list, with no error shown, and which we could not
// reproduce. Every route to that outcome — whatever triggers it — ends at the
// same shape of event: a write that replaces a file full of nodes with one
// that has none. These test the guard at that choke point rather than at any
// single suspected cause, so they hold even if the trigger turns out to be
// something we haven't thought of.
import { describe, it, expect } from 'vitest';
import {
  readBoardFile, writeBoardFile, classifyCanvasFile, EMPTIED_BAK_SUFFIX, CONFLICT_BAK_SUFFIX,
} from '../src/file-io';
import { visualNotesToCanvas, canvasToVisualNotes } from '../src/canvas-format';
import { FakeVault } from './fake-vault';
import type { VisualNotesFile, StickyCard } from '../src/file-types';

function board(cards: VisualNotesFile['cards'] = []): VisualNotesFile {
  return { version: 3, layout: 'freeform', cards, connections: [], drawings: [] };
}

const sticky = (id: string): StickyCard => ({ id, kind: 'sticky', text: id, color: '#fff' });

/** A board file with two cards, as it would exist on disk. */
function vaultWithBoard(): { vault: FakeVault; file: ReturnType<FakeVault['putText']>; raw: string } {
  const vault = new FakeVault();
  const raw = JSON.stringify(visualNotesToCanvas(board([sticky('s1'), sticky('s2')])), null, 2);
  return { vault, file: vault.putText('Board.canvas', raw), raw };
}

describe('writeBoardFile: emptying a board that had cards', () => {
  it('snapshots the previous contents before the write lands', async () => {
    const { vault, file, raw } = vaultWithBoard();

    await writeBoardFile(vault.toApp(), file, board([]));

    expect(vault.has('Board.canvas' + EMPTIED_BAK_SUFFIX)).toBe(true);
    expect(vault.textAt('Board.canvas' + EMPTIED_BAK_SUFFIX)).toBe(raw);
  });

  it('still performs the write — clearing a board by hand must keep working', async () => {
    const { vault, file } = vaultWithBoard();

    await writeBoardFile(vault.toApp(), file, board([]));

    const after = JSON.parse(vault.textAt('Board.canvas')) as { nodes: unknown[] };
    expect(after.nodes).toHaveLength(0);
  });

  it('refreshes the snapshot, so it always holds the most recent full board', async () => {
    const { vault, file } = vaultWithBoard();
    await writeBoardFile(vault.toApp(), file, board([]));

    // Board rebuilt with different content, then emptied again.
    await writeBoardFile(vault.toApp(), file, board([sticky('later')]));
    await writeBoardFile(vault.toApp(), file, board([]));

    const backup = JSON.parse(vault.textAt('Board.canvas' + EMPTIED_BAK_SUFFIX)) as { nodes: { id: string }[] };
    expect(backup.nodes).toHaveLength(1);
    expect(backup.nodes[0].id).toBe('later');
  });

  it('does not snapshot when the board still has cards', async () => {
    const { vault, file } = vaultWithBoard();

    await writeBoardFile(vault.toApp(), file, board([sticky('s1')]));

    expect(vault.has('Board.canvas' + EMPTIED_BAK_SUFFIX)).toBe(false);
  });

  it('does not snapshot when the file on disk was already empty', async () => {
    const vault = new FakeVault();
    const file = vault.putText('Board.canvas', JSON.stringify(visualNotesToCanvas(board([]))));

    await writeBoardFile(vault.toApp(), file, board([]));

    expect(vault.has('Board.canvas' + EMPTIED_BAK_SUFFIX)).toBe(false);
  });
});

describe('writeBoardFile: a board that failed to read is never written back', () => {
  it('leaves the file untouched rather than overwriting it with the placeholder', async () => {
    const vault = new FakeVault();
    const original = '{ this is not valid JSON';
    const file = vault.putText('Board.canvas', original);

    // The full loop that used to destroy a board: read fails, the placeholder
    // renders as an empty board, and the next autosave writes it back out.
    const placeholder = await readBoardFile(vault.toApp(), file);
    await writeBoardFile(vault.toApp(), file, placeholder);

    expect(placeholder.unreadable).toBe(true);
    expect(vault.textAt('Board.canvas')).toBe(original);
  });

  it('does not leave a spurious empty-board snapshot behind either', async () => {
    const { vault, file } = vaultWithBoard();
    const placeholder = board([]);
    placeholder.unreadable = true;

    await writeBoardFile(vault.toApp(), file, placeholder);

    expect(vault.has('Board.canvas' + EMPTIED_BAK_SUFFIX)).toBe(false);
  });
});

// A renderer holds its whole board in memory from the moment it opens, so a
// save an hour later still carries that original snapshot. Writing it blindly
// overwrites anything that arrived in between — from another device, another
// pane, or a git pull. These cover the three-way rule that replaced the blind
// write, and the two cases that decide whether it is usable rather than merely
// correct: it must not fire on changes the user never made, and it must not
// see its own writes as somebody else's.
describe('writeBoardFile: a revision we did not expect is never destroyed', () => {
  /** Someone else's version of the same board, landing on disk underneath us. */
  function externalEdit(vault: FakeVault, ids: string[]): string {
    const raw = JSON.stringify(visualNotesToCanvas(board(ids.map(sticky))), null, 2);
    vault.putText('Board.canvas', raw);
    return raw;
  }

  it('round-trips a board back to identical text, which the whole guard rests on', () => {
    // If reading and re-serializing a board it never touched produced even
    // slightly different text, "we changed nothing" could never be detected
    // and every sync would raise a false conflict.
    const raw = JSON.stringify(visualNotesToCanvas(board([sticky('s1'), sticky('s2')])), null, 2);
    const round = JSON.stringify(visualNotesToCanvas(canvasToVisualNotes(JSON.parse(raw) as never)), null, 2);
    expect(round).toBe(raw);
  });

  it('writes normally when the file still holds the revision we loaded', async () => {
    const { vault, file } = vaultWithBoard();
    const loaded = await readBoardFile(vault.toApp(), file);
    loaded.cards.push(sticky('mine'));

    await writeBoardFile(vault.toApp(), file, loaded);

    expect(vault.has('Board.canvas' + CONFLICT_BAK_SUFFIX)).toBe(false);
    const after = JSON.parse(vault.textAt('Board.canvas')) as { nodes: { id: string }[] };
    expect(after.nodes.map(n => n.id)).toContain('mine');
  });

  it('preserves the other revision, and still saves ours', async () => {
    const { vault, file } = vaultWithBoard();
    const loaded = await readBoardFile(vault.toApp(), file);
    loaded.cards.push(sticky('mine'));
    const theirs = externalEdit(vault, ['theirs']);

    await writeBoardFile(vault.toApp(), file, loaded);

    // Their work is recoverable...
    expect(vault.textAt('Board.canvas' + CONFLICT_BAK_SUFFIX)).toBe(theirs);
    // ...and the user was not interrupted: their save landed.
    const after = JSON.parse(vault.textAt('Board.canvas')) as { nodes: { id: string }[] };
    expect(after.nodes.map(n => n.id)).toContain('mine');
  });

  it('leaves their revision alone entirely when we have nothing of our own to save', async () => {
    // Opening a board and touching nothing, while a sync lands. There is no
    // conflict here — only one person edited — so there should be no backup
    // and no overwrite.
    const { vault, file } = vaultWithBoard();
    const loaded = await readBoardFile(vault.toApp(), file);
    const theirs = externalEdit(vault, ['theirs']);

    await writeBoardFile(vault.toApp(), file, loaded);

    expect(vault.textAt('Board.canvas')).toBe(theirs);
    expect(vault.has('Board.canvas' + CONFLICT_BAK_SUFFIX)).toBe(false);
  });

  it('does not count panning as a change of ours', async () => {
    // Viewport lives in the file and panning schedules a save, so without
    // normalising it out, scrolling around a board would be enough to raise a
    // conflict over a change the user never made.
    const { vault, file } = vaultWithBoard();
    const loaded = await readBoardFile(vault.toApp(), file);
    loaded.viewport = { x: 500, y: 300, zoom: 2 };
    const theirs = externalEdit(vault, ['theirs']);

    await writeBoardFile(vault.toApp(), file, loaded);

    expect(vault.textAt('Board.canvas')).toBe(theirs);
    expect(vault.has('Board.canvas' + CONFLICT_BAK_SUFFIX)).toBe(false);
  });

  it('does not see its own previous write as somebody else`s change', async () => {
    // The regression that would make the guard unusable: without updating the
    // baseline after a successful write, every save from the second one on
    // would report a conflict and write a backup.
    const { vault, file } = vaultWithBoard();
    const loaded = await readBoardFile(vault.toApp(), file);

    loaded.cards.push(sticky('first'));
    await writeBoardFile(vault.toApp(), file, loaded);
    loaded.cards.push(sticky('second'));
    await writeBoardFile(vault.toApp(), file, loaded);

    expect(vault.has('Board.canvas' + CONFLICT_BAK_SUFFIX)).toBe(false);
    const after = JSON.parse(vault.textAt('Board.canvas')) as { nodes: { id: string }[] };
    expect(after.nodes.map(n => n.id)).toEqual(expect.arrayContaining(['first', 'second']));
  });

  it('writes a board that was never read from disk', async () => {
    // A seeded template or a brand-new board carries no baseline: there is no
    // earlier revision to protect, so the write is simply ours to make.
    const { vault, file } = vaultWithBoard();

    await writeBoardFile(vault.toApp(), file, board([sticky('fresh')]));

    expect(vault.has('Board.canvas' + CONFLICT_BAK_SUFFIX)).toBe(false);
    const after = JSON.parse(vault.textAt('Board.canvas')) as { nodes: { id: string }[] };
    expect(after.nodes.map(n => n.id)).toEqual(['fresh']);
  });

  it('refreshes the conflict copy rather than accumulating one per save', async () => {
    const { vault, file } = vaultWithBoard();
    const loaded = await readBoardFile(vault.toApp(), file);
    loaded.cards.push(sticky('mine'));

    externalEdit(vault, ['first-theirs']);
    await writeBoardFile(vault.toApp(), file, loaded);
    const latest = externalEdit(vault, ['second-theirs']);
    loaded.cards.push(sticky('more'));
    await writeBoardFile(vault.toApp(), file, loaded);

    // One file, holding their most recent work — which is the fullest.
    expect(vault.textAt('Board.canvas' + CONFLICT_BAK_SUFFIX)).toBe(latest);
  });

  it('keeps the emptying snapshot and the conflict copy apart', async () => {
    const { vault, file } = vaultWithBoard();
    const loaded = await readBoardFile(vault.toApp(), file);
    loaded.cards = [];                       // cleared here
    externalEdit(vault, ['theirs']);         // and edited there

    await writeBoardFile(vault.toApp(), file, loaded);

    expect(vault.has('Board.canvas' + EMPTIED_BAK_SUFFIX)).toBe(true);
    expect(vault.has('Board.canvas' + CONFLICT_BAK_SUFFIX)).toBe(true);
  });

  it('catches a revision that lands after the emptying read but before the write', async () => {
    // The window process() closes. snapshotIfEmptying reads the file, and only
    // then does the write happen — a plain read-then-write would compare
    // against that already-stale read and clobber whatever arrived in between.
    const { vault, file } = vaultWithBoard();
    const loaded = await readBoardFile(vault.toApp(), file);
    loaded.cards = [];

    let theirs = '';
    vault.onNextRead(() => { theirs = externalEdit(vault, ['slipped-in']); });

    await writeBoardFile(vault.toApp(), file, loaded);

    expect(theirs).not.toBe('');
    expect(vault.textAt('Board.canvas' + CONFLICT_BAK_SUFFIX)).toBe(theirs);
  });

  it('still writes nothing at all for a board that failed to read', async () => {
    const { vault, file, raw } = vaultWithBoard();
    const placeholder = board([]);
    placeholder.unreadable = true;
    placeholder.baseline = 'something stale';

    await writeBoardFile(vault.toApp(), file, placeholder);

    expect(vault.textAt('Board.canvas')).toBe(raw);
    expect(vault.has('Board.canvas' + CONFLICT_BAK_SUFFIX)).toBe(false);
  });
});

describe('readBoardFile: failures return a placeholder rather than throwing', () => {
  it('flags a board that could not be parsed', async () => {
    const vault = new FakeVault();
    const file = vault.putText('Board.canvas', 'not json at all');

    const out = await readBoardFile(vault.toApp(), file);

    expect(out.unreadable).toBe(true);
    expect(out.cards).toHaveLength(0);
  });

  it('flags a board that could not even be opened, instead of rejecting', async () => {
    const vault = new FakeVault();
    const file = vault.putText('Board.canvas', '{}');
    vault.remove('Board.canvas'); // the handle stays valid; the content is gone

    const out = await readBoardFile(vault.toApp(), file);

    expect(out.unreadable).toBe(true);
  });

  it('does not flag a board that read cleanly', async () => {
    const { vault, file } = vaultWithBoard();

    const out = await readBoardFile(vault.toApp(), file);

    expect(out.unreadable).toBeUndefined();
    expect(out.cards).toHaveLength(2);
  });
});

describe('classifyCanvasFile: unreadable is not the same as foreign', () => {
  it('recognises one of our own boards', async () => {
    const { vault, file } = vaultWithBoard();
    expect(await classifyCanvasFile(vault.toApp(), file)).toBe('ours');
  });

  it('recognises a plain native canvas as foreign', async () => {
    const vault = new FakeVault();
    const file = vault.putText('Native.canvas', JSON.stringify({
      nodes: [{ id: 'a', type: 'text', text: 'hi', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    }));

    expect(await classifyCanvasFile(vault.toApp(), file)).toBe('foreign');
  });

  it('reports a file it cannot parse as unreadable, NOT foreign', async () => {
    // The distinction that matters: `foreign` sends the file to Obsidian's
    // native Canvas view, which rewrites whatever it is given. Answering
    // `foreign` here is how a bad read becomes permanent damage.
    const vault = new FakeVault();
    const file = vault.putText('Broken.canvas', '{ truncated');

    expect(await classifyCanvasFile(vault.toApp(), file)).toBe('unreadable');
  });

  it('reports a file it cannot open as unreadable', async () => {
    const vault = new FakeVault();
    const file = vault.putText('Gone.canvas', '{}');
    vault.remove('Gone.canvas');

    expect(await classifyCanvasFile(vault.toApp(), file)).toBe('unreadable');
  });
});
