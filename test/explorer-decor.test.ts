// The cache behind the file-explorer tint.
//
// Telling a Visual Notes board apart from a plain Obsidian canvas means
// reading the file — the only difference is the marker inside it. That makes
// caching the difference between "read each canvas once" and "read every
// canvas on every scroll", so the invalidation rule is the part worth
// pinning down: a canvas can stop being one of ours, or become one, through
// an edit made anywhere, including Obsidian's own Canvas view rewriting it.
import { describe, it, expect } from 'vitest';
import { BoardClassCache } from '../src/explorer-decor';

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
