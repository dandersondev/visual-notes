// @vitest-environment jsdom
//
// The cache behind the file-explorer tint.
//
// Telling a Visual Notes board apart from a plain Obsidian canvas means
// reading the file — the only difference is the marker inside it. That makes
// caching the difference between "read each canvas once" and "read every
// canvas on every scroll", so the invalidation rule is the part worth
// pinning down: a canvas can stop being one of ours, or become one, through
// an edit made anywhere, including Obsidian's own Canvas view rewriting it.
import { describe, it, expect, vi } from 'vitest';
import { BoardClassCache, ExplorerDecorator, BOARD_ROW_CLASS } from '../src/explorer-decor';
import { FakeVault } from './fake-vault';
import type { App } from 'obsidian';

const BOARD = JSON.stringify({ nodes: [], edges: [], vn: { version: 1, layout: 'freeform' } });
const NATIVE = JSON.stringify({ nodes: [], edges: [] });

/** A file explorer with the given rows, wired to a vault holding those files. */
function explorer(files: Record<string, string>) {
  const vault = new FakeVault();
  const containerEl = document.createElement('div');
  document.body.appendChild(containerEl);

  const addRow = (path: string) => {
    const row = document.createElement('div');
    row.className = 'nav-file-title';
    row.setAttribute('data-path', path);
    containerEl.appendChild(row);
    return row;
  };

  for (const [path, content] of Object.entries(files)) vault.putText(path, content);
  const app = {
    ...vault.toApp(),
    workspace: { getLeavesOfType: () => [{ view: { containerEl } }] },
  } as unknown as App;

  return { app, addRow, containerEl };
}

// Reported after 1.1.27 shipped: the tag flashed orange "CANVAS" before
// settling to blue "VISUAL", "like it's loading". It was — telling a board
// from a plain canvas means reading the file, and every row waited on that
// read plus a 120ms debounce, even rows whose answer was already known.
// Anything already in the cache is now marked synchronously, inside the
// MutationObserver callback, which runs before the browser paints.
describe('ExplorerDecorator: a known row is marked without waiting', () => {
  it('marks a board row once it has read the file', async () => {
    const { app, addRow } = explorer({ 'Board.canvas': BOARD });
    const row = addRow('Board.canvas');

    const dec = new ExplorerDecorator(app);
    dec.start();
    await vi.waitFor(() => expect(row.hasClass(BOARD_ROW_CLASS)).toBe(true));
    dec.stop();
  });

  it('marks a recycled row synchronously, with no read and no await', () => {
    // The flash, precisely: the explorer recycles rows as you scroll, so a row
    // that was marked a moment ago comes back bare. If that had to wait for
    // the async pass again it would flash every time — which is what a warm
    // cache exists to prevent, and what this asserts it does.
    const { app, addRow } = explorer({ 'Board.canvas': BOARD });
    const dec = new ExplorerDecorator(app);
    dec.start(); // applyCached is inert until started, as the observer is
    const cache = (dec as unknown as { cache: BoardClassCache }).cache;
    cache.set('Board.canvas', 0, true); // FakeVault files carry mtime 0

    const row = addRow('Board.canvas');
    (dec as unknown as { applyCached(): void }).applyCached();

    expect(row.hasClass(BOARD_ROW_CLASS)).toBe(true);
    dec.stop();
  });

  it('leaves a row it has no answer for exactly as it found it', () => {
    // Clearing an unclassified row would be the flash by another name: every
    // scroll would strip the class and put it back a frame later.
    const { app, addRow } = explorer({ 'Board.canvas': BOARD });
    const dec = new ExplorerDecorator(app);
    dec.start();
    (dec as unknown as { cache: BoardClassCache }).cache.clear(); // cold again
    const row = addRow('Board.canvas');
    row.addClass(BOARD_ROW_CLASS); // as a previous pass left it

    (dec as unknown as { applyCached(): void }).applyCached();

    expect(row.hasClass(BOARD_ROW_CLASS)).toBe(true);
    dec.stop();
  });

  // The tests above prove applyCached works; these prove it is actually
  // reached. Both callers were removed as a mutation and every behavioural
  // test still passed, which is exactly the gap that would let the flash come
  // back unnoticed.
  it('runs the synchronous pass as soon as it starts', () => {
    const { app } = explorer({ 'Board.canvas': BOARD });
    const dec = new ExplorerDecorator(app);
    const spy = vi.spyOn(dec as unknown as { applyCached(): void }, 'applyCached');

    dec.start();

    expect(spy).toHaveBeenCalled();
    dec.stop();
  });

  it('runs the synchronous pass when the explorer changes, before the debounce', async () => {
    // A MutationObserver callback is a microtask, so it lands before the
    // debounced scan's timer ever fires — which is the whole reason a row can
    // be marked in the frame it appears rather than a beat later.
    const { app, addRow } = explorer({ 'Board.canvas': BOARD });
    const dec = new ExplorerDecorator(app);
    dec.start();
    const spy = vi.spyOn(dec as unknown as { applyCached(): void }, 'applyCached');

    addRow('Board.canvas');
    await Promise.resolve();
    await Promise.resolve();

    expect(spy).toHaveBeenCalled();
    dec.stop();
  });

  it('does not mark a plain native canvas', () => {
    const { app, addRow } = explorer({ 'Native.canvas': NATIVE });
    const dec = new ExplorerDecorator(app);
    dec.start();
    const cache = (dec as unknown as { cache: BoardClassCache }).cache;
    cache.set('Native.canvas', 0, false);

    const row = addRow('Native.canvas');
    (dec as unknown as { applyCached(): void }).applyCached();

    expect(row.hasClass(BOARD_ROW_CLASS)).toBe(false);
    dec.stop();
  });
});

describe('BoardClassCache', () => {
  it('returns nothing for a path it has never seen', () => {
    expect(new BoardClassCache().get('Board.canvas', 1)).toBeUndefined();
  });

  it('returns what it was told, for the same modification time', () => {
    const c = new BoardClassCache();
    c.set('Board.canvas', 100, true);
    c.set('Native.canvas', 100, false);
    expect(c.get('Board.canvas', 100)).toBe(true);
    expect(c.get('Native.canvas', 100)).toBe(false);
  });

  it('treats a changed modification time as unknown, not as the old answer', () => {
    // The case that matters: Obsidian's native Canvas rewriting a board
    // strips its marker, so a file that WAS ours no longer is. Trusting a
    // stale entry would leave it tinted and claiming to be something it is
    // not.
    const c = new BoardClassCache();
    c.set('Board.canvas', 100, true);
    expect(c.get('Board.canvas', 101)).toBeUndefined();
  });

  it('distinguishes false from unknown', () => {
    // Both are falsy, and conflating them would re-read every plain canvas
    // on every scan — precisely the cost the cache exists to avoid.
    const c = new BoardClassCache();
    c.set('Native.canvas', 100, false);
    expect(c.get('Native.canvas', 100)).toBe(false);
    expect(c.get('Native.canvas', 100)).not.toBeUndefined();
  });

  it('forgets a single path on request', () => {
    const c = new BoardClassCache();
    c.set('A.canvas', 1, true);
    c.set('B.canvas', 1, true);
    c.forget('A.canvas');
    expect(c.get('A.canvas', 1)).toBeUndefined();
    expect(c.get('B.canvas', 1)).toBe(true);
  });

  it('forgetting an unknown path is harmless', () => {
    const c = new BoardClassCache();
    expect(() => c.forget('never-seen.canvas')).not.toThrow();
  });

  it('clears everything, for teardown', () => {
    const c = new BoardClassCache();
    c.set('A.canvas', 1, true);
    c.set('B.canvas', 1, false);
    c.clear();
    expect(c.size).toBe(0);
    expect(c.get('A.canvas', 1)).toBeUndefined();
  });

  it('replaces rather than accumulates entries for one path', () => {
    const c = new BoardClassCache();
    c.set('A.canvas', 1, true);
    c.set('A.canvas', 2, false);
    expect(c.size).toBe(1);
    expect(c.get('A.canvas', 2)).toBe(false);
  });
});
