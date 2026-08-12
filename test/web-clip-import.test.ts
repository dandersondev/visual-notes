// The web-clip importer. Its defining property is idempotence: a startup
// reconcile, a manual command and (later) a live vault listener all call the
// same function, and none of them knows what the others did. Most of what is
// tested here is that running it twice is the same as running it once.
import { describe, it, expect } from 'vitest';
import {
  isInClipFolder, nextClipPositions, missingClipPaths, buildClipCards,
  addClipsToBoard, clipImportNotice, shouldQueueClip,
  clipMetaFromFrontmatter, stripFrontmatter, displayDomain,
} from '../src/web-clip-import';
import { visualNotesToCanvas, canvasToVisualNotes } from '../src/canvas-format';
import { FakeVault } from './fake-vault';
import type { VisualNotesFile, NoteLinkCard, StickyCard, Card } from '../src/file-types';

function board(cards: Card[] = [], layout: 'freeform' | 'grid' = 'freeform'): VisualNotesFile {
  return { version: 3, layout, cards, connections: [], drawings: [] };
}
const noteLink = (id: string, path: string): NoteLinkCard =>
  ({ id, kind: 'note-link', path, displayMode: 'preview', x: 0, y: 0, w: 280, h: 240 });

/** Nothing is open, so the importer should take the on-disk route. */
const nothingOpen = () => Promise.resolve(null);

describe('isInClipFolder', () => {
  it('matches a file directly inside the folder', () => {
    expect(isInClipFolder('Clippings/article.md', 'Clippings')).toBe(true);
  });

  it('matches a file nested deeper', () => {
    expect(isInClipFolder('Clippings/2026/article.md', 'Clippings')).toBe(true);
  });

  it('does NOT match a folder that merely starts with the same text', () => {
    // The reason this compares path segments rather than doing a string
    // prefix test: "Clippings-old" starts with "Clippings".
    expect(isInClipFolder('Clippings-old/article.md', 'Clippings')).toBe(false);
    expect(isInClipFolder('ClippingsArchive/a.md', 'Clippings')).toBe(false);
  });

  it('tolerates a trailing slash on the configured folder', () => {
    expect(isInClipFolder('Clippings/article.md', 'Clippings/')).toBe(true);
  });

  it('matches nothing when no folder is configured', () => {
    // An unset folder means the feature is off — emphatically not "the whole
    // vault", which would sweep every note onto the board.
    expect(isInClipFolder('Clippings/article.md', undefined)).toBe(false);
    expect(isInClipFolder('anything.md', '')).toBe(false);
    expect(isInClipFolder('anything.md', '/')).toBe(false);
  });
});

describe('nextClipPositions', () => {
  it('starts at the origin on an empty board', () => {
    expect(nextClipPositions([], 1, { w: 100, h: 100 })[0]).toEqual({ x: 0, y: 0 });
  });

  it('places clips below everything already on the board', () => {
    const existing: Card[] = [{ ...noteLink('a', 'x.md'), x: 40, y: 0, w: 100, h: 200 }];
    const [first] = nextClipPositions(existing, 1, { w: 100, h: 100 });
    expect(first.y).toBeGreaterThanOrEqual(200);
    expect(first.x).toBe(40); // aligned with the leftmost existing card
  });

  it('lays clips out in rows and wraps', () => {
    const at = nextClipPositions([], 5, { w: 100, h: 100 });
    expect(at[0].y).toBe(at[3].y);           // first four share a row
    expect(at[4].y).toBeGreaterThan(at[0].y); // fifth wraps
    expect(at[4].x).toBe(at[0].x);
  });

  it('never overlaps two clips in the same batch', () => {
    const size = { w: 100, h: 100 };
    const at = nextClipPositions([], 9, size);
    for (let i = 0; i < at.length; i++) {
      for (let j = i + 1; j < at.length; j++) {
        const overlaps = at[i].x < at[j].x + size.w && at[i].x + size.w > at[j].x
                      && at[i].y < at[j].y + size.h && at[i].y + size.h > at[j].y;
        expect(overlaps).toBe(false);
      }
    }
  });
});

describe('missingClipPaths', () => {
  it('skips paths a note-link card already points at', () => {
    const b = board([noteLink('n1', 'Clippings/a.md')]);
    expect(missingClipPaths(b, ['Clippings/a.md', 'Clippings/b.md'])).toEqual(['Clippings/b.md']);
  });

  it('deduplicates within the batch itself', () => {
    // The same path can arrive from the reconcile pass and a live event at
    // once; adding it twice would be as bad as adding it on every launch.
    expect(missingClipPaths(board(), ['a.md', 'a.md'])).toEqual(['a.md']);
  });

  it('ignores cards of other kinds that happen to carry a path', () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', text: 'hi', color: '#fff' };
    expect(missingClipPaths(board([sticky]), ['Clippings/a.md'])).toEqual(['Clippings/a.md']);
  });
});

describe('addClipsToBoard: on-disk route', () => {
  async function vaultWith(b: VisualNotesFile) {
    const vault = new FakeVault();
    const file = vault.putText('Inbox.canvas', JSON.stringify(visualNotesToCanvas(b), null, 2));
    return { vault, file };
  }

  it('adds every clip and writes the board exactly once', async () => {
    const { vault } = await vaultWith(board());
    let writes = 0;
    const app = vault.toApp();
    const realModify = app.vault.modify.bind(app.vault) as typeof app.vault.modify;
    app.vault.modify = (async (f, c: string) => { writes++; return realModify(f, c); }) as typeof app.vault.modify;

    const result = await addClipsToBoard(app, 'Inbox.canvas', ['C/a.md', 'C/b.md', 'C/c.md'], nothingOpen);

    expect(result).toEqual({ added: 3, alreadyPresent: 0 });
    // A write per clip would be slower and could leave a half-imported board.
    expect(writes).toBe(1);
  });

  it('is idempotent — running it twice adds nothing the second time', async () => {
    const { vault } = await vaultWith(board());
    const app = vault.toApp();
    await addClipsToBoard(app, 'Inbox.canvas', ['C/a.md', 'C/b.md'], nothingOpen);
    const second = await addClipsToBoard(app, 'Inbox.canvas', ['C/a.md', 'C/b.md'], nothingOpen);

    expect(second).toEqual({ added: 0, alreadyPresent: 2 });
    const after = canvasToVisualNotes(JSON.parse(vault.textAt('Inbox.canvas')) as never);
    expect(after.cards.filter(c => c.kind === 'note-link')).toHaveLength(2);
  });

  it('writes clips as ordinary Canvas file nodes', async () => {
    const { vault } = await vaultWith(board());
    await addClipsToBoard(vault.toApp(), 'Inbox.canvas', ['C/a.md'], nothingOpen);

    const raw = JSON.parse(vault.textAt('Inbox.canvas')) as { nodes: { type: string; file?: string }[] };
    expect(raw.nodes).toHaveLength(1);
    expect(raw.nodes[0].type).toBe('file');
    expect(raw.nodes[0].file).toBe('C/a.md');
  });

  it('round-trips the clip metadata through the file', async () => {
    // stashable() preserves any non-positional field, but "it should work"
    // is not the same as "it does" — the format is where board data goes to
    // die silently.
    const { vault } = await vaultWith(board());
    await addClipsToBoard(vault.toApp(), 'Inbox.canvas', ['C/a.md'], nothingOpen);

    const after = canvasToVisualNotes(JSON.parse(vault.textAt('Inbox.canvas')) as never);
    const card = after.cards[0] as NoteLinkCard;
    expect(card.kind).toBe('note-link');
    expect(typeof card.clipImportedAt).toBe('number');
  });

  it('keeps existing cards and puts clips below them', async () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', text: 'hi', color: '#fff', x: 0, y: 0, w: 200, h: 150 };
    const { vault } = await vaultWith(board([sticky]));
    await addClipsToBoard(vault.toApp(), 'Inbox.canvas', ['C/a.md'], nothingOpen);

    const after = canvasToVisualNotes(JSON.parse(vault.textAt('Inbox.canvas')) as never);
    expect(after.cards).toHaveLength(2);
    const clip = after.cards.find(c => c.kind === 'note-link')!;
    expect(clip.y ?? 0).toBeGreaterThanOrEqual(150);
  });
});

describe('addClipsToBoard: refusals', () => {
  it('refuses when no board is configured', async () => {
    const vault = new FakeVault();
    const r = await addClipsToBoard(vault.toApp(), undefined, ['a.md'], nothingOpen);
    expect(r.added).toBe(0);
    expect(r.refusal).toMatch(/No board/i);
  });

  it('refuses when the board file is gone', async () => {
    const vault = new FakeVault();
    const r = await addClipsToBoard(vault.toApp(), 'Missing.canvas', ['a.md'], nothingOpen);
    expect(r.refusal).toMatch(/no longer exists/i);
  });

  it('refuses a canvas that is not a Visual Notes board', async () => {
    const vault = new FakeVault();
    vault.putText('Native.canvas', JSON.stringify({ nodes: [], edges: [] }));
    const r = await addClipsToBoard(vault.toApp(), 'Native.canvas', ['a.md'], nothingOpen);
    expect(r.refusal).toMatch(/isn.t a Visual Notes board/i);
  });

  it('refuses an unreadable board rather than overwriting it', async () => {
    const vault = new FakeVault();
    vault.putText('Broken.canvas', '{ truncated');
    const r = await addClipsToBoard(vault.toApp(), 'Broken.canvas', ['a.md'], nothingOpen);
    expect(r.added).toBe(0);
    expect(vault.textAt('Broken.canvas')).toBe('{ truncated');
  });

  it('refuses a grid board, which has no place to put a card', async () => {
    const vault = new FakeVault();
    vault.putText('Grid.canvas', JSON.stringify(visualNotesToCanvas(board([], 'grid'))));
    const r = await addClipsToBoard(vault.toApp(), 'Grid.canvas', ['a.md'], nothingOpen);
    expect(r.refusal).toMatch(/grid board/i);
  });

  it('does nothing, quietly, when there are no clips', async () => {
    const vault = new FakeVault();
    vault.putText('Inbox.canvas', JSON.stringify(visualNotesToCanvas(board())));
    expect(await addClipsToBoard(vault.toApp(), 'Inbox.canvas', [], nothingOpen))
      .toEqual({ added: 0, alreadyPresent: 0 });
  });
});

describe('addClipsToBoard: open-board route', () => {
  it('hands off to the live renderer instead of writing the file', async () => {
    // Writing the file while a view holds the board in memory is how the
    // import would get silently undone by that view's next save.
    const vault = new FakeVault();
    const original = JSON.stringify(visualNotesToCanvas(board()), null, 2);
    vault.putText('Inbox.canvas', original);

    let handedOff = false;
    const result = await addClipsToBoard(vault.toApp(), 'Inbox.canvas', ['C/a.md', 'C/b.md'], (path, add) => {
      handedOff = true;
      expect(path).toBe('Inbox.canvas');
      return Promise.resolve(add(board()).length);
    });

    expect(handedOff).toBe(true);
    expect(result).toEqual({ added: 2, alreadyPresent: 0 });
    expect(vault.textAt('Inbox.canvas')).toBe(original); // untouched on disk
  });

  it('falls back to disk when the open view cannot take the cards', async () => {
    const vault = new FakeVault();
    vault.putText('Inbox.canvas', JSON.stringify(visualNotesToCanvas(board())));
    const result = await addClipsToBoard(vault.toApp(), 'Inbox.canvas', ['C/a.md'], () => Promise.resolve(null));
    expect(result.added).toBe(1);
  });
});

describe('shouldQueueClip: which vault events become an import', () => {
  const on = { clipFolder: 'Clippings', clipBoardPath: 'Inbox.canvas' };

  it('queues a markdown file inside the clippings folder', () => {
    expect(shouldQueueClip('Clippings/a.md', 'md', on)).toBe(true);
  });

  it('ignores files elsewhere in the vault', () => {
    expect(shouldQueueClip('Notes/a.md', 'md', on)).toBe(false);
    expect(shouldQueueClip('Clippings-old/a.md', 'md', on)).toBe(false);
  });

  it('ignores non-markdown files dropped in the folder', () => {
    // Web Clipper saves images alongside the note when configured to.
    expect(shouldQueueClip('Clippings/screenshot.png', 'png', on)).toBe(false);
    expect(shouldQueueClip('Clippings/Sub.canvas', 'canvas', on)).toBe(false);
  });

  it('stays quiet until both the folder and the board are set', () => {
    expect(shouldQueueClip('Clippings/a.md', 'md', { clipFolder: 'Clippings' })).toBe(false);
    expect(shouldQueueClip('Clippings/a.md', 'md', { clipBoardPath: 'Inbox.canvas' })).toBe(false);
    expect(shouldQueueClip('Clippings/a.md', 'md', {})).toBe(false);
  });

  it('honours the auto-import toggle', () => {
    expect(shouldQueueClip('Clippings/a.md', 'md', { ...on, clipAutoImport: false })).toBe(false);
    // Unset means on — the toggle defaults to enabled once a folder is chosen.
    expect(shouldQueueClip('Clippings/a.md', 'md', { ...on, clipAutoImport: undefined })).toBe(true);
  });
});

describe('clipMetaFromFrontmatter', () => {
  it('reads the properties Obsidian Web Clipper writes', () => {
    const meta = clipMetaFromFrontmatter({
      title: 'Why Things Break: A Guide',
      source: 'https://example.com/why-things-break',
      description: 'A short piece about failure modes.',
    });
    expect(meta.title).toBe('Why Things Break: A Guide');
    expect(meta.sourceUrl).toBe('https://example.com/why-things-break');
    expect(meta.description).toBe('A short piece about failure modes.');
  });

  it('accepts the other key names different tools use for the source', () => {
    expect(clipMetaFromFrontmatter({ url: 'https://a.com' }).sourceUrl).toBe('https://a.com');
    expect(clipMetaFromFrontmatter({ source_url: 'https://b.com' }).sourceUrl).toBe('https://b.com');
    expect(clipMetaFromFrontmatter({ original: 'https://c.com' }).sourceUrl).toBe('https://c.com');
  });

  it('refuses a source that is not a web URL', () => {
    // Frontmatter on a shared board is a string someone else wrote, and this
    // value ends up behind a click.
    expect(clipMetaFromFrontmatter({ source: 'javascript:alert(1)' }).sourceUrl).toBeUndefined();
    expect(clipMetaFromFrontmatter({ source: 'file:///etc/passwd' }).sourceUrl).toBeUndefined();
    expect(clipMetaFromFrontmatter({ source: 'Some Book, page 42' }).sourceUrl).toBeUndefined();
  });

  it('ignores properties of the wrong type', () => {
    expect(clipMetaFromFrontmatter({ title: 42, source: ['https://a.com'] })).toEqual({
      title: undefined, sourceUrl: undefined, description: undefined, image: undefined,
    });
  });

  it('survives a note with no frontmatter at all', () => {
    expect(clipMetaFromFrontmatter(undefined)).toEqual({});
    expect(clipMetaFromFrontmatter({})).toEqual({
      title: undefined, sourceUrl: undefined, description: undefined, image: undefined,
    });
  });
});

describe('stripFrontmatter', () => {
  it('removes a leading YAML block', () => {
    expect(stripFrontmatter('---\ntitle: A\nsource: https://a.com\n---\nBody text'))
      .toBe('Body text');
  });

  it('handles CRLF line endings', () => {
    expect(stripFrontmatter('---\r\ntitle: A\r\n---\r\nBody')).toBe('Body');
  });

  it('leaves a note without frontmatter untouched', () => {
    expect(stripFrontmatter('# Heading\n\nBody')).toBe('# Heading\n\nBody');
  });

  it('does not strip a horizontal rule further down the note', () => {
    // Frontmatter is only frontmatter on line one; a --- mid-document is an
    // <hr> and removing content after it would eat the article.
    const body = '# Heading\n\nSome text\n\n---\n\nMore text';
    expect(stripFrontmatter(body)).toBe(body);
  });

  it('handles an empty frontmatter block', () => {
    expect(stripFrontmatter('---\n---\nBody')).toBe('Body');
  });
});

describe('displayDomain', () => {
  it('strips the scheme and www', () => {
    expect(displayDomain('https://www.example.com/a/b?c=d')).toBe('example.com');
    expect(displayDomain('http://sub.example.co.uk/x')).toBe('sub.example.co.uk');
  });

  it('returns nothing for a non-URL', () => {
    expect(displayDomain('not a url')).toBeUndefined();
    expect(displayDomain(undefined)).toBeUndefined();
  });
});

describe('clipImportNotice', () => {
  it('reports what was added and what was skipped', () => {
    expect(clipImportNotice({ added: 17, alreadyPresent: 183 })).toBe(
      'Visual Notes: added 17 clips; 183 already there.',
    );
  });

  it('says so plainly when everything was already there', () => {
    expect(clipImportNotice({ added: 0, alreadyPresent: 4 })).toMatch(/no new clips/i);
  });

  it('uses the singular for one clip', () => {
    expect(clipImportNotice({ added: 1, alreadyPresent: 0 })).toBe('Visual Notes: added 1 clip.');
  });

  it('passes a refusal through as the message', () => {
    expect(clipImportNotice({ added: 0, alreadyPresent: 0, refusal: 'Board is gone.' }))
      .toBe('Visual Notes: Board is gone.');
  });
});
