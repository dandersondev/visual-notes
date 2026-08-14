// @vitest-environment jsdom
//
// A small smoke-test layer over real FreeformRenderer instances — drives
// actual pointer/keyboard events through the production code and asserts
// on the resulting board data, rather than testing pure functions in
// isolation like the rest of the suite. Needs the DOM polyfill (createDiv,
// addClass, …) and the Component/Modal/Menu stubs in obsidian-stub.ts —
// see both files' own comments for why those exist at all.
//
// jsdom has no real layout engine: every element's getBoundingClientRect()
// is zeros unless mocked, and elementFromPoint/elementsFromPoint aren't
// implemented. Tests here avoid depending on real layout (drag/resize read
// card data + write inline styles, not measure the DOM) except the
// connection test, which explicitly mocks elementsFromPoint — see its own
// comment.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FreeformRenderer } from '../src/freeform-view';
import { ContextBar } from '../src/context-bar';
import { resolveDefaultStickyColor, STICKY_COLORS, formatVideoTime } from '../src/freeform-view-shared';
import { TEXT_CARD_DEFAULT_FONT, TEXT_CARD_MIN_FONT } from '../src/file-types';
import { PenOptionsPanel, DEFAULT_PEN_DRAW_OPTIONS, type PenDrawOptions } from '../src/pen-options-panel';
import { visualNotesToCanvas, canvasToVisualNotes } from '../src/canvas-format';
import { fakeApp } from './fake-app';
import { FakeVault } from './fake-vault';
import { Platform, Menu } from 'obsidian';
import type {
  VisualNotesFile, StickyCard, TileCard, TableCard, CommentCard,
  CalloutCard, GroupCard, CalendarCard, ColumnCard, KanbanColumnCard,
  KanbanBoardCard, DrawingStroke, BookmarkCard, TextCard, Card,
} from '../src/file-types';

function setup(
  cards: VisualNotesFile['cards'], connections: VisualNotesFile['connections'] = [],
  mobileFabPosition: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' = 'bottom-right',
  // Cards that resolve a vault path (video, audio, image) need the file to
  // actually exist, or they render their "not found" state instead.
  vault: FakeVault = new FakeVault(),
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const board: VisualNotesFile = {
    version: 3, layout: 'freeform', cards, connections, drawings: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  const file = { path: 'Board.canvas', basename: 'Board', name: 'Board.canvas', extension: 'canvas' } as any;
  const renderer = new FreeformRenderer(
    fakeApp(vault), container, board, file, async () => {}, async () => {},
    30, undefined, 'left', undefined,
    false, // cardDragAnimationEnabled — skip the tilt rAF loop, irrelevant to data assertions
    1, false,
    false, // snapToGridEnabled — off, so drag/resize deltas below are exact rather than grid-snapped
    32, undefined, mobileFabPosition,
  );
  renderer.render();
  return { renderer, board, container };
}

function pointer(type: string, x: number, y: number, extra: Partial<PointerEventInit> = {}): PointerEvent {
  // buttons: 1 (primary button held) on every event by default — matches a
  // real drag, where the button stays down for pointerdown/pointermove and
  // pointerup fires while it's still logically "the button that's releasing".
  // Tests simulating a release with nothing held can override via `extra`.
  // isPrimary: true — real events from the primary pointer (the mouse, the
  // first touch) always carry it; jsdom's constructor defaults it to false,
  // which would trip the pen tool's secondary-touch (pinch-finger) guard.
  return new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, isPrimary: true, ...extra });
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('UI smoke: drag a card', () => {
  it('moving the pointer past the drag threshold updates the card\'s x/y in board data', () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'hi', color: '#fff' };
    const { renderer, board, container } = setup([sticky]);
    const el = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="s1"]')!;
    expect(el).toBeTruthy();

    el.dispatchEvent(pointer('pointerdown', 50, 50));
    el.dispatchEvent(pointer('pointermove', 90, 90)); // past DRAG_THRESHOLD (5px)
    el.dispatchEvent(pointer('pointerup', 90, 90));

    const moved = board.cards[0] as StickyCard;
    expect(moved.x).toBe(40); // +40,+40 from the pointer delta
    expect(moved.y).toBe(40);
    expect(renderer).toBeTruthy(); // keep the renderer reachable for lifecycle cleanup below
  });

  it('a tiny move under the drag threshold does not move the card', () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'hi', color: '#fff' };
    const { board, container } = setup([sticky]);
    const el = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="s1"]')!;

    el.dispatchEvent(pointer('pointerdown', 50, 50));
    el.dispatchEvent(pointer('pointermove', 52, 52)); // 2.8px — under the 5px threshold
    el.dispatchEvent(pointer('pointerup', 52, 52));

    expect((board.cards[0] as StickyCard).x).toBe(0);
    expect((board.cards[0] as StickyCard).y).toBe(0);
  });

  it('releasing off the card below the drag threshold does not leave it stuck dragging on the next hover', () => {
    // Regression test for a reported bug: pointer capture used to be
    // acquired only after the drag threshold was crossed, so a small
    // below-threshold nudge released off the card left its pointerup
    // listener never firing (never attached to `el` if the release lands
    // elsewhere). The stale pointermove listener then replayed on the very
    // next hover — no button held — and started a "drag" with nothing
    // pressed at all.
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'hi', color: '#fff' };
    const { board, container } = setup([sticky]);
    const el = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="s1"]')!;

    el.dispatchEvent(pointer('pointerdown', 50, 50));
    el.dispatchEvent(pointer('pointermove', 52, 52)); // under threshold — no drag started
    // Released somewhere that is not `el` itself.
    container.dispatchEvent(pointer('pointerup', 300, 300));

    // Hovering back over the card afterward, with no button held, must not
    // move it. A trailing pointerup forces the position write (normally
    // rAF-deferred) to flush synchronously so the assertion below can see
    // whether a drag was wrongly started, regardless of this test's own
    // timing — matching how the "past the drag threshold" test above
    // observes its result.
    el.dispatchEvent(pointer('pointermove', 500, 500, { buttons: 0 }));
    el.dispatchEvent(pointer('pointerup', 500, 500, { buttons: 0 }));

    expect((board.cards[0] as StickyCard).x).toBe(0);
    expect((board.cards[0] as StickyCard).y).toBe(0);
  });
});

describe('UI smoke: resize a card', () => {
  it('dragging the se resize handle grows the card\'s w/h in board data', () => {
    const tile: TileCard = {
      id: 't1', kind: 'tile', x: 0, y: 0, w: 200, h: 120, label: 'Tile', icon: 'star', color: '#3B82F6',
      target: { kind: 'note', path: 'X.md' },
    };
    const { board, container } = setup([tile]);
    const handle = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="t1"] .visual-notes-card-resize-handle--se')!;
    expect(handle).toBeTruthy();

    handle.dispatchEvent(pointer('pointerdown', 200, 120));
    handle.dispatchEvent(pointer('pointermove', 260, 170)); // +60 wide, +50 tall
    handle.dispatchEvent(pointer('pointerup', 260, 170));

    // applySnap always rounds to at least a 4px grid, even with
    // snapToGridEnabled off (see canvas.ts's applySnap) — 120+50=170 snaps
    // to 172, the nearest multiple of 4.
    const resized = board.cards[0] as TileCard;
    expect(resized.w).toBe(260);
    expect(resized.h).toBe(172);
  });
});

describe('UI smoke: connect two cards', () => {
  it('dragging from one card\'s connection handle onto another creates a connection', () => {
    const a: StickyCard = { id: 'a', kind: 'sticky', x: 0, y: 0, w: 200, h: 120, text: 'A', color: '#fff' };
    const b: StickyCard = { id: 'b', kind: 'sticky', x: 400, y: 0, w: 200, h: 120, text: 'B', color: '#fff' };
    const { board, container } = setup([a, b]);

    const handle = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="a"] .visual-notes-connection-handle-e')!;
    const targetEl = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="b"]')!;
    expect(handle).toBeTruthy();

    // jsdom has no real layout engine, so elementsFromPoint (used to detect
    // which card the connection is being dropped onto) always returns [] —
    // mock it to report the real target for the duration of this drag,
    // matching what a real browser's hit-test would return at that point.
    const spy = vi.spyOn(document, 'elementsFromPoint').mockReturnValue([targetEl]);

    handle.dispatchEvent(pointer('pointerdown', 200, 60));
    handle.dispatchEvent(pointer('pointermove', 400, 60));
    handle.dispatchEvent(pointer('pointerup', 400, 60));

    spy.mockRestore();

    expect(board.connections).toHaveLength(1);
    expect(board.connections[0]).toMatchObject({ fromCardId: 'a', toCardId: 'b' });
  });
});

describe('UI smoke: connection arrowhead pull-back (bug #6)', () => {
  // A filled arrowhead triangle's tip sits exactly at the connection's raw
  // endpoint, but tapers to zero width right there — a line as thick as
  // the shaft pokes out past the triangle's narrowing sides unless the
  // VISIBLE stroke (not the true geometry other things rely on) is
  // shortened first. buildConnectionPath (hit-testing, selection halo,
  // labels, bend handle) must stay exactly at the true endpoints;
  // buildVisibleConnectionPath (the colored stroke only) is what shortens;
  // computeArrowheadPolygons draws the triangle with its tip at the true
  // endpoint regardless of how short the visible stroke is.
  const from = { x: -300, y: -300 };
  const to = { x: 300, y: 300 }; // length 600√2 ≈ 848.5, comfortably longer than any arrowhead

  it('buildConnectionPath always returns the true, unshortened endpoints', () => {
    const { renderer } = setup([]);
    for (const arrowhead of ['none', 'end', 'both'] as const) {
      const d = renderer.buildConnectionPath({
        id: `t-${arrowhead}`, fromPoint: from, toPoint: to,
        routing: 'straight' as const, color: '#fff', style: 'solid' as const,
        arrowhead, thickness: 4 as const,
      });
      expect(d).toBe(`M ${from.x} ${from.y} L ${to.x} ${to.y}`);
    }
  });

  it('buildVisibleConnectionPath shortens the end with an arrowhead, leaves a no-arrowhead end untouched', () => {
    const { renderer } = setup([]);
    const conn = {
      id: 'c1', fromPoint: from, toPoint: to,
      routing: 'straight' as const, color: '#fff', style: 'solid' as const,
      arrowhead: 'end' as const, thickness: 4 as const,
    };
    const d = renderer.buildVisibleConnectionPath(conn)!;
    const [, x1, y1, x2, y2] = d.match(/M ([\d.-]+) ([\d.-]+) L ([\d.-]+) ([\d.-]+)/)!.map(Number);

    expect(x1).toBe(from.x); expect(y1).toBe(from.y); // start (no arrowhead): untouched
    // end (has the arrowhead): pulled back toward `from`, not sitting at `to`
    expect(x2).toBeLessThan(to.x);
    expect(y2).toBeLessThan(to.y);
  });

  it('buildVisibleConnectionPath shortens both ends when arrowhead is "both"', () => {
    const { renderer } = setup([]);
    const conn = {
      id: 'c2', fromPoint: from, toPoint: to,
      routing: 'straight' as const, color: '#fff', style: 'solid' as const,
      arrowhead: 'both' as const, thickness: 4 as const,
    };
    const d = renderer.buildVisibleConnectionPath(conn)!;
    const [, x1, y1, x2, y2] = d.match(/M ([\d.-]+) ([\d.-]+) L ([\d.-]+) ([\d.-]+)/)!.map(Number);

    expect(x1).toBeGreaterThan(from.x); expect(y1).toBeGreaterThan(from.y);
    expect(x2).toBeLessThan(to.x); expect(y2).toBeLessThan(to.y);
  });

  it('buildVisibleConnectionPath leaves both ends untouched when there is no arrowhead at all', () => {
    const { renderer } = setup([]);
    const conn = {
      id: 'c3', fromPoint: from, toPoint: to,
      routing: 'straight' as const, color: '#fff', style: 'solid' as const,
      arrowhead: 'none' as const, thickness: 4 as const,
    };
    const d = renderer.buildVisibleConnectionPath(conn)!;
    expect(d).toBe(`M ${from.x} ${from.y} L ${to.x} ${to.y}`);
  });

  it('buildVisibleConnectionPath pulls back further for a thicker line', () => {
    const { renderer } = setup([]);
    const thin = renderer.buildVisibleConnectionPath({
      id: 'c4', fromPoint: from, toPoint: to,
      routing: 'straight' as const, color: '#fff', style: 'solid' as const,
      arrowhead: 'end' as const, thickness: 2 as const,
    })!;
    const thick = renderer.buildVisibleConnectionPath({
      id: 'c5', fromPoint: from, toPoint: to,
      routing: 'straight' as const, color: '#fff', style: 'solid' as const,
      arrowhead: 'end' as const, thickness: 6 as const,
    })!;
    const endX = (d: string) => Number(d.match(/L ([\d.-]+)/)![1]);
    // Thicker line -> longer arrowhead -> pulled back further from `to`.
    expect(to.x - endX(thick)).toBeGreaterThan(to.x - endX(thin));
  });

  it('computeArrowheadPolygons puts the tip exactly at the true endpoint, base pulled back toward the approach point', () => {
    const { renderer } = setup([]);
    const conn = {
      id: 'c6', fromPoint: from, toPoint: to,
      routing: 'straight' as const, color: '#fff', style: 'solid' as const,
      arrowhead: 'both' as const, thickness: 4 as const,
    };
    const arrows = renderer.computeArrowheadPolygons(conn)!;
    expect(arrows.end).toBeTruthy();
    expect(arrows.start).toBeTruthy();
    const [endTip] = arrows.end!;
    const [startTip] = arrows.start!;
    // Tips land exactly on the connection's real endpoints...
    expect(endTip).toEqual(to);
    expect(startTip).toEqual(from);
    // ...while the two base corners (indices 1 and 2) sit strictly inside
    // the segment, not on top of the tip.
    expect(arrows.end![1]).not.toEqual(to);
    expect(arrows.end![2]).not.toEqual(to);
  });

  it('computeArrowheadPolygons returns null when there is no arrowhead', () => {
    const { renderer } = setup([]);
    const conn = {
      id: 'c7', fromPoint: from, toPoint: to,
      routing: 'straight' as const, color: '#fff', style: 'solid' as const,
      arrowhead: 'none' as const, thickness: 4 as const,
    };
    expect(renderer.computeArrowheadPolygons(conn)).toBeNull();
  });

  it('a bent connection\'s visible stroke lies exactly on the true curve (no separation from the hit path)', () => {
    // Regression: the first polygon-arrowhead fix rebuilt the shortened
    // stroke as a NEW curve from pulled-back endpoints with the same bend
    // value — a different curve, whose middle drifted away from the true
    // geometry that the hit area, selection outline, and bend handle all
    // follow. Reported as "the outline no longer follows the line, and
    // clicking the center at extreme bends misses". The visible stroke
    // must be an exact sub-segment of the true curve.
    const { renderer } = setup([]);
    const conn = {
      id: 'c8', fromPoint: from, toPoint: to,
      routing: 'straight' as const, bend: 250, color: '#fff', style: 'solid' as const,
      arrowhead: 'both' as const, thickness: 6 as const,
    };
    const quad = (d: string) => {
      const m = d.match(/M ([\d.-]+) ([\d.-]+) Q ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)/)!;
      const n = m.slice(1).map(Number);
      return [{ x: n[0], y: n[1] }, { x: n[2], y: n[3] }, { x: n[4], y: n[5] }] as const;
    };
    const bez = (p: readonly { x: number; y: number }[], t: number) => {
      const mt = 1 - t;
      return {
        x: mt * mt * p[0].x + 2 * mt * t * p[1].x + t * t * p[2].x,
        y: mt * mt * p[0].y + 2 * mt * t * p[1].y + t * t * p[2].y,
      };
    };
    const truePts = quad(renderer.buildConnectionPath(conn)!);
    const visPts = quad(renderer.buildVisibleConnectionPath(conn)!);
    // Every sampled point of the visible stroke must sit on the true
    // curve (within rounding), including its exact middle — the spot the
    // user aims at to select the connection.
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      const p = bez(visPts, u);
      let minDist = Infinity;
      // Dense sampling so the measured distance reflects the geometry,
      // not the gap between adjacent samples on this ~1100px curve.
      for (let t = 0; t <= 1.0001; t += 1 / 8000) {
        const b = bez(truePts, t);
        minDist = Math.min(minDist, Math.hypot(p.x - b.x, p.y - b.y));
      }
      expect(minDist).toBeLessThan(0.5);
    }
  });
});

describe('UI smoke: toolbar tool selection is exclusive', () => {
  // Regression test for a reported bug: Pen, Line (connect mode), and a
  // pending placement tool (Note/Sticky/Column/…) are three independent
  // state flags, each with its own toolbar highlight. Pen mode already
  // tore down the other two on entry; Line and the placement tools didn't
  // tear down Pen (or each other), so activating one could leave a
  // previous tool's button stuck showing "active" underneath it.
  it('activating a placement tool exits pen mode and connect mode', () => {
    const { renderer } = setup([]);
    renderer.togglePenMode();
    expect(renderer.penModeActive).toBe(true);

    const btn = document.createElement('div');
    renderer.activateTool('sticky', btn);

    expect(renderer.penModeActive).toBe(false);
    expect(renderer.connectMode).toBe(false);
    expect(renderer.pendingTool).toBe('sticky');
    expect(renderer.penToolBtn?.hasClass('is-active')).toBe(false);
  });

  it('entering connect mode (Line) exits pen mode and any pending tool', () => {
    const { renderer } = setup([]);
    renderer.togglePenMode();
    expect(renderer.penModeActive).toBe(true);

    renderer.toggleConnectMode();

    expect(renderer.connectMode).toBe(true);
    expect(renderer.penModeActive).toBe(false);
    expect(renderer.pendingTool).toBe(null);
    expect(renderer.penToolBtn?.hasClass('is-active')).toBe(false);
  });

  it('entering pen mode exits connect mode and any pending tool', () => {
    const { renderer } = setup([]);
    renderer.toggleConnectMode();
    expect(renderer.connectMode).toBe(true);

    renderer.togglePenMode();

    expect(renderer.penModeActive).toBe(true);
    expect(renderer.connectMode).toBe(false);
    expect(renderer.connectToolBtn?.hasClass('is-active')).toBe(false);
  });
});

describe('UI smoke: edit a table cell', () => {
  it('double-click to edit, typing, then blur writes the new value into the row data', () => {
    const table: TableCard = {
      id: 'tb1', kind: 'table', x: 0, y: 0, w: 340, h: 240, color: '#fff', title: 'T',
      columns: [{ id: 'c1', label: 'Name' }],
      rows: [{ id: 'r1', cells: { c1: 'old value' } }],
    };
    const { board, container } = setup([table]);

    const cellText = container.querySelector<HTMLElement>(
      '.visual-notes-freeform-card[data-id="tb1"] .visual-notes-table-cell[data-row="1"][data-col="0"] .visual-notes-table-cell-text'
    )!;
    expect(cellText).toBeTruthy();

    cellText.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    // jsdom doesn't compute the derived isContentEditable boolean from the
    // contentEditable attribute, so check the attribute production code
    // actually sets instead.
    expect(cellText.contentEditable).toBe('true');

    cellText.textContent = 'new value';
    cellText.dispatchEvent(new InputEvent('input', { bubbles: true }));
    cellText.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

    const row = (board.cards[0] as TableCard).rows[0];
    expect(row.cells.c1).toBe('new value');
    expect(cellText.contentEditable).toBe('false'); // demoted back on blur
  });
});

describe('UI smoke: un-resolving a comment restores full opacity (bug #9)', () => {
  it('toggling resolved off removes the is-resolved class, not just skips adding it', () => {
    // Regression test: renderCommentContent only ever did
    // `if (card.resolved) el.addClass('is-resolved')` — a one-way toggle
    // that added the class (driving the 0.6 opacity in styles.css) but
    // never removed it, so once a comment was marked resolved it stayed
    // visually transparent forever, even after toggling "Resolved" back off.
    const comment: CommentCard = {
      id: 'c1', kind: 'comment', x: 0, y: 0, w: 240, h: 160,
      text: 'hi', createdAt: Date.now(), replies: [], resolved: true,
    };
    const { renderer, container } = setup([comment]);
    const el = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="c1"]')!;
    expect(el.hasClass('is-resolved')).toBe(true);

    renderer.selection.select('c1');
    (renderer as any).handleCtxEvent({ type: 'comment-resolve' });

    expect((comment as CommentCard).resolved).toBe(false);
    expect(el.hasClass('is-resolved')).toBe(false);
  });
});

describe('UI smoke: board export bbox', () => {
  it('returns null for an empty board', () => {
    const { renderer } = setup([]);
    expect((renderer as any).computeExportBBox()).toBeNull();
  });

  it('matches the plain card bounding box when there are no drawings or free connection points', () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 10, y: 20, w: 100, h: 50, text: 'hi', color: '#fff' };
    const { renderer } = setup([sticky]);
    expect((renderer as any).computeExportBBox()).toEqual({ minX: 10, minY: 20, maxX: 110, maxY: 70 });
  });

  it('extends the bbox to cover ink drawing points outside every card', () => {
    // computeBoardBBox (used by the minimap / zoom-to-fit) only looks at
    // cards — fine for those callers, but a board export needs the full
    // extent, or a pen stroke off to the side would get cropped out.
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 100, h: 50, text: 'hi', color: '#fff' };
    const { renderer, board } = setup([sticky]);
    board.drawings.push({ id: 'd1', groupId: 'g1', color: '#000', width: 2, points: [{ x: -50, y: 300 }, { x: 10, y: 10 }] });
    const bbox = (renderer as any).computeExportBBox();
    expect(bbox).toEqual({ minX: -50, minY: 0, maxX: 100, maxY: 300 });
  });

  it('extends the bbox to cover a free-floating connection endpoint (not anchored to any card)', () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 100, h: 50, text: 'hi', color: '#fff' };
    const conn = {
      id: 'c1', toCardId: 's1', fromPoint: { x: -300, y: -300 },
      routing: 'straight', color: '#000', style: 'solid', arrowhead: 'end',
    };
    const { renderer } = setup([sticky], [conn as any]);
    const bbox = (renderer as any).computeExportBBox();
    expect(bbox.minX).toBe(-300);
    expect(bbox.minY).toBe(-300);
  });
});

describe('UI smoke: note top strip color (bug #8)', () => {
  it('setting a top strip color on a note inserts the strip after the shape-fill layer', () => {
    // Regression test: the shape-fill layer (.visual-notes-sticky-shape-fill)
    // is position:absolute with z-index:0, which establishes a stacking
    // context that paints above any plain in-flow sibling regardless of DOM
    // order — so a top strip with no stacking context of its own was
    // invisible no matter where it sat in the DOM (fixed with a CSS rule
    // giving the strip position:relative + a higher z-index inside notes).
    // The handler that creates the strip on first pick still inserted it as
    // el's very first child (before the shape-fill), inconsistent with the
    // initial-render order (shape-fill, then strip, then inner) — this test
    // locks in the now-consistent insertion point.
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'hi', color: '#fff' };
    const { renderer, board, container } = setup([sticky]);
    const el = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="s1"]')!;
    expect(el.querySelector('.visual-notes-card-top-strip')).toBeNull();

    renderer.selection.select('s1');
    (renderer as any).handleCtxEvent({ type: 'sticky-top-color', hex: '#ef4444' });

    expect((board.cards[0] as StickyCard).topColor).toBe('#ef4444');
    const children = Array.from(el.children).map(c => c.className);
    const fillIdx = children.findIndex(c => c.includes('visual-notes-sticky-shape-fill'));
    const stripIdx = children.findIndex(c => c.includes('visual-notes-card-top-strip'));
    const innerIdx = children.findIndex(c => c.includes('visual-notes-sticky-inner'));
    expect(fillIdx).toBeGreaterThanOrEqual(0);
    expect(stripIdx).toBeGreaterThan(fillIdx);
    expect(stripIdx).toBeLessThan(innerIdx);
  });

  it('the shape-fill layer no longer outranks the top strip in the stylesheet', () => {
    const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8');
    expect(css).toMatch(/\.visual-notes-freeform-sticky-card \.visual-notes-card-top-strip\s*\{[^}]*z-index:\s*1/);
  });
});

describe('UI smoke: note editor gets the text-format bubble menu (bug #8)', () => {
  it('wiring in TextFormatToolbar does not break editing or its blur-commit teardown', () => {
    // Every other inline text editor (checklist item, kanban item, …) shows
    // a selection-triggered Bold/Italic/Color/Highlight popup; the note
    // editor never did, and had no font-colour option at all. jsdom can't
    // simulate a real contenteditable selection to trigger the popup itself
    // (confirmed separately — focus()/activeElement don't work on
    // contenteditable here), so this just locks in that wiring
    // TextFormatToolbar into editStickyInline doesn't break editing or its
    // existing blur-commit flow.
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'hi', color: '#fff' };
    const { renderer, board, container } = setup([sticky]);
    const el = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="s1"]')!;

    expect(() => (renderer as any).editStickyInline(el, sticky)).not.toThrow();
    const editor = el.querySelector<HTMLElement>('.visual-notes-sticky-editor');
    expect(editor).toBeTruthy();
    editor!.innerHTML = 'edited';

    expect(() => editor!.dispatchEvent(new FocusEvent('blur'))).not.toThrow();
    expect((board.cards[0] as StickyCard).text).toBe('edited');
    expect(el.querySelector('.visual-notes-sticky-editor')).toBeNull();
  });
});

describe('UI smoke: sticky editor text colour', () => {
  afterEach(() => { document.body.removeClass('theme-dark'); });

  // Reported: editing a pale sticky under a dark theme turned the text
  // near-white and unreadable. renderStickyContent gives the *rendered* span an
  // inline auto-contrast color computed from the card's own background, but the
  // editor is created as a sibling of that span rather than a child, so it
  // inherited none of it and fell back to the theme's --text-normal.
  const openEditor = (color: string, textColor?: string) => {
    document.body.addClass('theme-dark');
    const sticky: StickyCard = {
      id: 's1', kind: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'hi', color,
      ...(textColor ? { textColor } : {}),
    };
    const { renderer, container } = setup([sticky]);
    const el = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="s1"]')!;
    const textEl = el.querySelector<HTMLElement>('.visual-notes-sticky-text')!;
    (renderer as any).editStickyInline(el, sticky);
    return { textEl, editor: el.querySelector<HTMLElement>('.visual-notes-sticky-editor')! };
  };

  it('gives the editor the same colour as the rendered text on a light sticky', () => {
    const { textEl, editor } = openEditor('#FDE68A');
    // Dark ink on a pale yellow background — the readable pairing.
    expect(textEl.style.color).toBeTruthy();
    expect(editor.style.color).toBe(textEl.style.color);
  });

  it('carries an explicit textColor into the editor too', () => {
    const { textEl, editor } = openEditor('#FDE68A', '#7f1d1d');
    expect(editor.style.color).toBe(textEl.style.color);
  });

  it('leaves the editor to CSS when the sticky uses a theme-driven colour', () => {
    // A blank Note's color is a var() reference, which has no meaningful
    // contrast value; those already pair correctly with --visual-notes-card-text,
    // so neither element should carry an inline colour.
    const { textEl, editor } = openEditor('var(--visual-notes-card-bg)');
    expect(textEl.style.color).toBe('');
    expect(editor.style.color).toBe('');
  });
});

describe('UI smoke: transparent cards and card fonts', () => {
  afterEach(() => { document.body.removeClass('theme-dark'); });

  const render = (extra: Partial<StickyCard>) => {
    const sticky: StickyCard = {
      id: 's1', kind: 'sticky', x: 0, y: 0, w: 240, h: 160,
      text: 'hi', color: '#FDE68A', ...extra,
    };
    const { renderer, board, container } = setup([sticky]);
    const el = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="s1"]')!;
    return { renderer, board, container, el, sticky };
  };

  it('paints no fill on a transparent card', () => {
    const { el } = render({ transparent: true });
    const fill = el.querySelector<HTMLElement>('.visual-notes-sticky-shape-fill')!;
    expect(el.hasClass('is-transparent')).toBe(true);
    expect(fill.style.backgroundColor).toBe('');
  });

  it('still paints the fill on an ordinary card', () => {
    const { el } = render({});
    const fill = el.querySelector<HTMLElement>('.visual-notes-sticky-shape-fill')!;
    expect(el.hasClass('is-transparent')).toBe(false);
    expect(fill.style.backgroundColor).toBeTruthy();
  });

  it('skips the auto-contrast text colour when transparent', () => {
    // With no fill the text sits on the canvas, so a colour contrasted against
    // `color` would be pairing with a background that never gets drawn — dark
    // ink derived from a pale card, floating on a dark canvas.
    document.body.addClass('theme-dark');
    const { el } = render({ transparent: true });
    const textEl = el.querySelector<HTMLElement>('.visual-notes-sticky-text')!;
    expect(textEl.style.color).toBe('');
  });

  it('honours an explicit textColor even when transparent', () => {
    const { el } = render({ transparent: true, textColor: '#7f1d1d' });
    const textEl = el.querySelector<HTMLElement>('.visual-notes-sticky-text')!;
    expect(textEl.style.color).toBeTruthy();
  });

  it('sets the font custom property on the card, not the text span', () => {
    // On the card so the rendered text and the editor both inherit it — the
    // editor is a sibling of the text span, which is what made the 1.1.19
    // colour bug possible in the first place.
    const { el } = render({ fontFamily: 'monospace' });
    expect(el.style.getPropertyValue('--vn-card-font')).toBe('var(--font-monospace)');
  });

  it('sets no font property when the card has no fontFamily', () => {
    const { el } = render({});
    expect(el.style.getPropertyValue('--vn-card-font')).toBe('');
  });

  it('round-trips transparent and fontFamily through the canvas format', () => {
    const { board } = render({ transparent: true, fontFamily: 'interface' });

    const round = canvasToVisualNotes(visualNotesToCanvas(board));
    const card = round.cards[0] as StickyCard;

    expect(card.transparent).toBe(true);
    expect(card.fontFamily).toBe('interface');
  });

  it('recomputes the auto-contrast colour when transparency is toggled', () => {
    // Turning the fill off has to drop the derived colour, and turning it back
    // on has to restore it — otherwise dark ink is stranded on the canvas.
    const { renderer, el, sticky } = render({});
    const textEl = el.querySelector<HTMLElement>('.visual-notes-sticky-text')!;
    expect(textEl.style.color).toBeTruthy();

    renderer.selection.select('s1');
    (renderer as any).handleCtxEvent({ type: 'sticky-transparent', transparent: true });
    expect(sticky.transparent).toBe(true);
    expect(el.hasClass('is-transparent')).toBe(true);
    expect(textEl.style.color).toBe('');

    (renderer as any).handleCtxEvent({ type: 'sticky-transparent', transparent: false });
    expect(el.hasClass('is-transparent')).toBe(false);
    expect(textEl.style.color).toBeTruthy();
  });

  it('sets and clears the font from the context bar', () => {
    const { renderer, el, sticky } = render({});

    renderer.selection.select('s1');
    (renderer as any).handleCtxEvent({ type: 'sticky-font', font: 'monospace' });
    expect(sticky.fontFamily).toBe('monospace');
    expect(el.style.getPropertyValue('--vn-card-font')).toBe('var(--font-monospace)');

    (renderer as any).handleCtxEvent({ type: 'sticky-font', font: null });
    expect(sticky.fontFamily).toBeUndefined();
    expect(el.style.getPropertyValue('--vn-card-font')).toBe('');
  });
});

describe('UI smoke: the Text tool', () => {
  const textCard = (extra: Partial<TextCard> = {}): TextCard => ({
    id: 't1', kind: 'text', x: 0, y: 0, w: 200, h: 100,
    text: 'hello', fontSize: 32, ...extra,
  });

  const mount = (card: TextCard) => {
    const { renderer, board, container } = setup([card]);
    const el = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="t1"]')!;
    return { renderer, board, container, el };
  };

  const dragCorner = (renderer: any, el: HTMLElement, card: Card, corner: string, dx: number) => {
    const handle = el.querySelector<HTMLElement>(`.visual-notes-card-resize-handle--${corner}`)!;
    renderer.startCardResize(pointer('pointerdown', 0, 0), handle, el, card);
    el.dispatchEvent(pointer('pointermove', dx, 0));
    el.dispatchEvent(pointer('pointerup', dx, 0));
  };

  it('creates a text card already in edit mode', () => {
    const { renderer, board, container } = setup([]);

    (renderer as any).addTextCardAt(40, 60);

    expect(board.cards).toHaveLength(1);
    const card = board.cards[0] as TextCard;
    expect(card.kind).toBe('text');
    expect(card.fontSize).toBe(TEXT_CARD_DEFAULT_FONT);
    const el = container.querySelector<HTMLElement>(`.visual-notes-freeform-card[data-id="${card.id}"]`)!;
    expect(el.querySelector('.visual-notes-text-editor')).not.toBeNull();
  });

  it('places a text card through the pending-tool flow', () => {
    const { renderer, board } = setup([]);
    renderer.pendingTool = 'text';

    (renderer as any).placePendingTool(100, 120);

    expect(board.cards).toHaveLength(1);
    expect(board.cards[0].kind).toBe('text');
  });

  it('leaves width and height to the content instead of writing them inline', () => {
    // Nothing wraps, so there is no width to impose — CSS sizes the box from
    // the font size. That is exactly what lets a resize predict the new size
    // rather than measuring it every frame.
    const { el } = mount(textCard());
    expect(el.style.width).toBe('');
    expect(el.style.height).toBe('');
  });

  it('renders the stored HTML directly, so editing and viewing match', () => {
    const { el } = mount(textCard({ text: 'a <strong>bold</strong> word' }));
    const body = el.querySelector<HTMLElement>('.visual-notes-text-body')!;
    expect(body.querySelector('strong')?.textContent).toBe('bold');
  });

  it('scales the font when a corner is dragged out', () => {
    const card = textCard();
    const { renderer, el } = mount(card);

    dragCorner(renderer, el, card, 'se', 100);

    // 200px wide dragged 100px right → 1.5× → 48px.
    expect(card.fontSize).toBeCloseTo(48, 5);
  });

  it('multiplies from the size the card is already at', () => {
    const card = textCard({ fontSize: 64 });
    const { renderer, el } = mount(card);

    dragCorner(renderer, el, card, 'se', 100);

    expect(card.fontSize).toBeCloseTo(96, 5);
  });

  it('has no practical ceiling, so the box drags as big as you want', () => {
    const card = textCard({ fontSize: 128 });
    const { renderer, el } = mount(card);

    dragCorner(renderer, el, card, 'se', 600);

    expect(card.fontSize).toBeCloseTo(512, 5);
  });

  it('clamps at the low end so a shrunk card stays grabbable', () => {
    const card = textCard();
    const { renderer, el } = mount(card);

    dragCorner(renderer, el, card, 'se', -500);

    expect(card.fontSize).toBe(TEXT_CARD_MIN_FONT);
  });

  it('pins the corner opposite the one being dragged', () => {
    const card = textCard({ x: 100, y: 50 });
    const { renderer, el } = mount(card);
    const rightBefore = card.x + card.w!, bottomBefore = card.y + card.h!;

    dragCorner(renderer, el, card, 'nw', -100);

    expect(card.x + card.w!).toBeCloseTo(rightBefore, 5);
    expect(card.y + card.h!).toBeCloseTo(bottomBefore, 5);
  });

  // The reported bug. Presets used to be multipliers capped at 3.6× while the
  // drag was open-ended, so picking one after dragging something large made it
  // abruptly smaller. Both now write the same px field, in the same unit.
  it('a preset sets exactly the px size it names, whatever the card was dragged to', () => {
    const card = textCard({ fontSize: 300 });
    const { renderer, el } = mount(card);

    renderer.selection.select('t1');
    (renderer as any).handleCtxEvent({ type: 'text-font-size', size: 128 });

    expect(card.fontSize).toBe(128);
    expect(el.querySelector<HTMLElement>('.visual-notes-text-body')!.style.fontSize).toBe('128px');
  });

  it('sets the font and colour from the context bar', () => {
    const card = textCard();
    const { renderer, el } = mount(card);
    renderer.selection.select('t1');

    (renderer as any).handleCtxEvent({ type: 'text-font', font: 'monospace' });
    expect(card.fontFamily).toBe('monospace');

    (renderer as any).handleCtxEvent({ type: 'text-color', hex: '#7f1d1d' });
    expect(card.color).toBe('#7f1d1d');
    expect(el.querySelector<HTMLElement>('.visual-notes-text-body')!.style.color).toBeTruthy();
  });

  it('round-trips through the canvas format, leaving plain words in the node', () => {
    const card = textCard({ text: 'line one<br>line two', fontSize: 48, fontFamily: 'interface' });
    const { board } = mount(card);

    const canvas = visualNotesToCanvas(board);
    const back = canvasToVisualNotes(canvas).cards[0] as TextCard;

    expect(back.kind).toBe('text');
    expect(back.fontSize).toBe(48);
    expect(back.fontFamily).toBe('interface');
    expect(back.text).toBe('line one<br>line two');
    // Native Canvas shows readable words, not markup.
    expect((canvas.nodes[0] as any).text).toBe('line one\nline two');
  });

  it('no longer scales an ordinary Note — that still reflows', () => {
    const note: StickyCard = { id: 'n1', kind: 'sticky', x: 0, y: 0, w: 200, h: 100, text: 'hi', color: '#FDE68A' };
    const { renderer, container } = setup([note]);
    const el = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="n1"]')!;

    dragCorner(renderer, el, note, 'se', 100);

    expect(note.w).toBe(300);
    expect((note as any).textScaleFactor).toBeUndefined();
  });
});

describe('UI smoke: context menu commits pending inline edits (bug #5)', () => {
  it('opening a context menu blurs whatever is currently focused, before any menu builds', () => {
    // Regression test for a reported bug: right-click (unlike left-click)
    // never blurs a focused input/contenteditable, so a card could still be
    // mid-edit when its context menu opens. Choosing "Delete" then removed
    // the card's element from the DOM, which force-blurred the still-focused
    // editor — reentrantly running its blur-commit handler against a card
    // already spliced out of the board, deep enough in the call stack
    // (undo push, markdown re-render) to throw. Obsidian's Menu only calls
    // hide() *after* the clicked item's callback returns, so a throw there
    // left the menu stuck open — reportedly for other cards' menus too,
    // since the same inline-edit-then-blur-commit pattern is used
    // throughout (checklist items, kanban items, table cells, …).
    //
    // jsdom doesn't support focus() on contenteditable elements (real
    // sticky/checklist/kanban editors), so a plain <input> stands in here
    // to prove the actual mechanism under test: a capture-phase listener
    // blurs activeElement before any bubble-phase per-card contextmenu
    // handler runs, so by the time a menu item's onClick can remove a
    // card's DOM, any pending edit has already committed safely — no
    // reentrant blur during the removal itself.
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'hi', color: '#fff' };
    const { container } = setup([sticky]);
    const el = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="s1"]')!;

    const input = document.createElement('input');
    el.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

    expect(document.activeElement).not.toBe(input);
  });
});

describe('UI smoke: deleting a card resets the floating format bar (bug #5)', () => {
  it('the context bar deactivates immediately on delete, without needing a click on the canvas', () => {
    // Regression test: archiveSelected() and duplicateSelected() both call
    // refreshSelectionVisuals() after clearing the selection, which is what
    // tells the floating per-card format bar (Bold/Italic/…) to hide itself
    // — but deleteSelected() cleared the selection directly and skipped that
    // call, so the bar (and its now-stale Bold/Italic buttons for the
    // just-deleted card) stayed visible until something else — e.g. clicking
    // the empty canvas — happened to refresh it.
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'hi', color: '#fff' };
    const { renderer, board, container } = setup([sticky]);

    renderer.selection.select('s1');
    renderer.refreshSelectionVisuals();
    const panel = container.querySelector<HTMLElement>('.visual-notes-ctx-bar-panel')!;
    expect(panel.querySelector('.visual-notes-tb-btn')).toBeTruthy(); // populated for the selected card

    renderer.deleteSelected();

    expect(board.cards).toHaveLength(0);
    expect(panel.hasClass('visual-notes-invisible')).toBe(true); // hidden immediately, not left showing stale buttons
  });
});

describe('UI smoke: keyboard shortcut', () => {
  it('Delete removes the selected card from board data', () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'hi', color: '#fff' };
    const { renderer, board } = setup([sticky]);

    renderer.selection.select('s1');
    renderer.refreshSelectionVisuals();

    renderer.outer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));

    expect(board.cards).toHaveLength(0);
  });

  it('Escape clears the selection without deleting anything', () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'hi', color: '#fff' };
    const { renderer, board } = setup([sticky]);

    renderer.selection.select('s1');
    renderer.outer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(board.cards).toHaveLength(1);
    expect(renderer.selection.isEmpty()).toBe(true);
  });

  it('undo (Ctrl+Z) still works when focus is on a toolbar/picker button, not the canvas itself', () => {
    // The toolbar and pen-picker are siblings of .outer under .container,
    // not descendants of it — clicking one moves focus there, which used
    // to mean shortcuts wired to a keydown listener on .outer alone (undo/
    // redo, delete, select-all…) went silent until you clicked back into
    // empty canvas space. Dispatching from the toolbar element itself
    // reproduces exactly that focus state.
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'hi', color: '#fff' };
    const { renderer, board } = setup([sticky]);

    renderer.selection.select('s1');
    renderer.refreshSelectionVisuals();
    renderer.outer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(board.cards).toHaveLength(0);

    renderer.toolbarEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    expect(board.cards).toHaveLength(1);
  });

  // The test above fixed that class of bug for onKeyDown's shortcuts in
  // 1.1.14, but four canvas-level ones kept their own, stricter gate:
  // `activeDocument.activeElement === this.outer`. They therefore died the
  // moment focus moved anywhere else and came back when you clicked empty
  // canvas — reported as "the space bar stops working randomly, and starts
  // working the same way". Clicking a card, a toolbar button, or a video with
  // native controls is enough to lose it.
  it('space-to-pan survives focus leaving the canvas element', () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'hi', color: '#fff' };
    const { renderer } = setup([sticky]);

    renderer.toolbarEl.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));

    expect(renderer.spaceDown).toBe(true);
  });

  it('does not arm space-to-pan while text is being typed', () => {
    // The gate that replaced the focus check has to keep this: a space typed
    // into a card is a space, not a pan.
    const { renderer, container } = setup([]);
    const input = container.createEl('input');
    input.focus();

    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));

    expect(renderer.spaceDown).toBe(false);
  });

  it('leaves keys alone when the event comes from another board entirely', () => {
    // The gate is "inside *this* board", not "inside any board" — two panes
    // open on two boards must not drive each other.
    const { renderer } = setup([]);
    const elsewhere = document.body.createDiv();

    elsewhere.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));

    expect(renderer.spaceDown).toBe(false);
    elsewhere.remove();
  });
});

// Asked for as "can we have an option to switch between pointer and hand like
// press H for hand and V for pointer" — from someone on a trackpad, where the
// middle/right-button pan is awkward at best.
describe('UI smoke: select / hand interaction modes', () => {
  it('starts in select mode', () => {
    expect(setup([]).renderer.interactionMode).toBe('select');
  });

  it('H switches to hand and V back to select', () => {
    const { renderer } = setup([]);

    renderer.outer.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }));
    expect(renderer.interactionMode).toBe('hand');

    renderer.outer.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', bubbles: true }));
    expect(renderer.interactionMode).toBe('select');
  });

  it('ignores h and v while typing', () => {
    const { renderer, container } = setup([]);
    const input = container.createEl('input');
    input.focus();

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }));

    expect(renderer.interactionMode).toBe('select');
    input.remove();
  });

  it('pans from a left-drag on a card, rather than moving it', () => {
    // The point of the mode: in select mode this same gesture drags the card.
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 100, y: 100, w: 240, h: 160, text: 'hi', color: '#fff' };
    const { renderer, board } = setup([sticky]);
    renderer.setInteractionMode('hand');
    const cardEl = renderer.cardEls.get('s1')!;

    cardEl.dispatchEvent(pointer('pointerdown', 50, 50));
    renderer.outer.dispatchEvent(pointer('pointermove', 150, 130));

    expect(board.cards[0].x).toBe(100);
    expect(board.cards[0].y).toBe(100);
    expect(renderer.isPanning).toBe(true);
  });

  it('Escape returns to select, so the mode is never a trap', () => {
    const { renderer } = setup([]);
    renderer.setInteractionMode('hand');

    renderer.outer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(renderer.interactionMode).toBe('select');
  });

  it('arming a placement tool leaves hand mode', () => {
    // Otherwise the click meant to place the card would be swallowed as a pan.
    const { renderer } = setup([]);
    renderer.setInteractionMode('hand');

    renderer.activateTool('sticky', renderer.textToolBtn!);

    expect(renderer.interactionMode).toBe('select');
  });
});

// There was no arrow-key handler at all before this, which is why the report
// of "arrow keys stop working randomly" was really the focused <video>
// seeking, not a board feature misbehaving.
describe('UI smoke: arrow-key nudge', () => {
  function withSticky() {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 100, y: 100, w: 240, h: 160, text: 'hi', color: '#fff' };
    const s = setup([sticky]);
    s.renderer.selection.select('s1');
    s.renderer.refreshSelectionVisuals();
    return s;
  }

  it('moves the selection one unit', () => {
    const { renderer, board } = withSticky();
    renderer.outer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(board.cards[0].x).toBe(101);

    renderer.outer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(board.cards[0].y).toBe(99);
  });

  it('takes a coarse step with Shift', () => {
    const { renderer, board } = withSticky();
    renderer.outer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
    expect(board.cards[0].y).toBe(110);
  });

  it('is undoable as one step', () => {
    const { renderer, board } = withSticky();
    renderer.outer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    renderer.undo();
    expect(board.cards[0].x).toBe(100);
  });

  it('leaves the keypress alone when nothing is selected', () => {
    // So an arrow key still reaches whatever else might want it.
    const { renderer, board } = withSticky();
    renderer.selection.clear();

    const e = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    renderer.outer.dispatchEvent(e);

    expect(board.cards[0].x).toBe(100);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('UI smoke: connection culling on large boards', () => {
  // jsdom has no layout engine, so getBoundingClientRect() is zeros by
  // default — mock a realistic viewport size so visibleCanvasBounds() has
  // something meaningful to compute against. Patches the shared prototype
  // (not the specific `outer` instance, which doesn't exist until render()
  // creates it) so it's already in effect for render()'s own initial cull.
  function mockViewportSize(w: number, h: number) {
    return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, width: w, height: h, top: 0, left: 0, right: w, bottom: h, toJSON: () => undefined,
    } as DOMRect);
  }

  function straightConn(id: string, fromCardId: string, toCardId: string) {
    return { id, fromCardId, toCardId, routing: 'straight' as const, color: '#000', style: 'solid' as const, arrowhead: 'end' as const, thickness: 2 as const };
  }

  it('only builds DOM for connections near the visible viewport at initial render', () => {
    const n1: StickyCard = { id: 'n1', kind: 'sticky', x: 0, y: 0, w: 200, h: 120, text: 'A', color: '#fff' };
    const n2: StickyCard = { id: 'n2', kind: 'sticky', x: 300, y: 0, w: 200, h: 120, text: 'B', color: '#fff' };
    const f1: StickyCard = { id: 'f1', kind: 'sticky', x: 10000, y: 10000, w: 200, h: 120, text: 'C', color: '#fff' };
    const f2: StickyCard = { id: 'f2', kind: 'sticky', x: 10300, y: 10000, w: 200, h: 120, text: 'D', color: '#fff' };

    const container = document.createElement('div');
    document.body.appendChild(container);
    const board: VisualNotesFile = {
      version: 3, layout: 'freeform', cards: [n1, n2, f1, f2],
      connections: [straightConn('c-near', 'n1', 'n2'), straightConn('c-far', 'f1', 'f2')],
      drawings: [], viewport: { x: 0, y: 0, zoom: 1 },
    };
    const file = { path: 'Board.canvas', basename: 'Board', name: 'Board.canvas', extension: 'canvas' } as any;
    const spy = mockViewportSize(800, 600);
    const renderer = new FreeformRenderer(fakeApp(), container, board, file, async () => {}, async () => {});
    renderer.render();
    spy.mockRestore();

    expect(renderer.connectionPaths.has('c-near')).toBe(true);
    expect(renderer.connectionPaths.has('c-far')).toBe(false);
  });

  it('refreshConnectionCulling promotes an off-screen connection once the viewport pans over it, and demotes it again on panning away', () => {
    // Both endpoints start far from the origin — isConnectionVisible is an
    // OR of the two ends, so if either one were near (0,0) it would already
    // be visible inside the initial mocked viewport regardless of the other.
    const a: StickyCard = { id: 'a', kind: 'sticky', x: 10000, y: 0, w: 200, h: 120, text: 'A', color: '#fff' };
    const b: StickyCard = { id: 'b', kind: 'sticky', x: 10300, y: 0, w: 200, h: 120, text: 'B', color: '#fff' };

    const container = document.createElement('div');
    document.body.appendChild(container);
    const board: VisualNotesFile = {
      version: 3, layout: 'freeform', cards: [a, b], connections: [straightConn('c1', 'a', 'b')],
      drawings: [], viewport: { x: 0, y: 0, zoom: 1 },
    };
    const file = { path: 'Board.canvas', basename: 'Board', name: 'Board.canvas', extension: 'canvas' } as any;
    const spy = mockViewportSize(800, 600);
    const renderer = new FreeformRenderer(fakeApp(), container, board, file, async () => {}, async () => {});
    renderer.render();

    expect(renderer.connectionPaths.has('c1')).toBe(false); // b is 10000px away — culled at load

    // Pan so both cards (and the connection between them) are on screen.
    // scheduleCullingRefresh's real trigger is rAF-batched (see canvas.ts);
    // calling the underlying refresh directly here tests its logic without
    // depending on jsdom's async rAF timing.
    renderer.vp = { x: -10000, y: 0, zoom: 1 };
    renderer.refreshConnectionCulling();
    expect(renderer.connectionPaths.has('c1')).toBe(true);

    // Pan back away — should be demoted (DOM removed) again.
    renderer.vp = { x: 0, y: 0, zoom: 1 };
    renderer.refreshConnectionCulling();
    expect(renderer.connectionPaths.has('c1')).toBe(false);

    spy.mockRestore();
  });

  it('updateConnectionsForCard is a no-op for a culled connection (no wasted path rebuild)', () => {
    // Both cards far from the origin: with the real (unmocked, all-zero)
    // jsdom rect, visibleCanvasBounds() is only the small margin around
    // (0,0) — a card actually AT the origin would still fall inside that
    // margin and not be culled, so both endpoints need to be well outside it.
    const a: StickyCard = { id: 'a', kind: 'sticky', x: 9000, y: 0, w: 200, h: 120, text: 'A', color: '#fff' };
    const b: StickyCard = { id: 'b', kind: 'sticky', x: 10000, y: 0, w: 200, h: 120, text: 'B', color: '#fff' };
    const { renderer } = setup([a, b], [straightConn('c1', 'a', 'b')]);
    expect(renderer.connectionPaths.has('c1')).toBe(false);

    expect(() => renderer.updateConnectionsForCard('a')).not.toThrow();
    expect(renderer.connectionPaths.has('c1')).toBe(false); // still not (re-)created
  });
});

describe('UI smoke: single-tap "Edit" for dblclick-gated card kinds (mobile UX phase 2)', () => {
  afterEach(() => { Platform.isPhone = false; });

  it('edit-card on a callout makes its text contentEditable and focuses it', () => {
    const callout: CalloutCard = { id: 'k1', kind: 'callout', x: 0, y: 0, w: 300, h: 100, text: 'hi', color: '#3b82f6' };
    const { renderer, container } = setup([callout]);
    const el = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="k1"]')!;
    const textEl = el.querySelector<HTMLElement>('.visual-notes-callout-text')!;
    // renderCalloutContent never sets contentEditable up front (only
    // editCalloutInline does, lazily, on first entry) — so the attribute
    // starts unset rather than explicitly 'false'.
    expect(textEl.contentEditable).not.toBe('true');

    renderer.selection.select('k1');
    (renderer as any).handleCtxEvent({ type: 'edit-card' });

    expect(textEl.contentEditable).toBe('true');
  });

  it('edit-card on a group swaps the label for a text input', () => {
    const group: GroupCard = { id: 'g1', kind: 'group', x: 0, y: 0, w: 300, h: 200, label: 'My Group' };
    const { renderer, container } = setup([group]);
    const el = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="g1"]')!;
    expect(el.querySelector('input')).toBeNull();

    renderer.selection.select('g1');
    (renderer as any).handleCtxEvent({ type: 'edit-card' });

    expect(el.querySelector('input.visual-notes-group-label-input')).not.toBeNull();
  });

  it('edit-card on a calendar card swaps its title span for a text input', () => {
    const cal: CalendarCard = { id: 'c1', kind: 'calendar', x: 0, y: 0, w: 400, h: 300, title: 'My Calendar' };
    const { renderer, container } = setup([cal]);
    const el = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="c1"]')!;
    expect(el.querySelector('input')).toBeNull();

    renderer.selection.select('c1');
    (renderer as any).handleCtxEvent({ type: 'edit-card' });

    expect(el.querySelector('input.visual-notes-dataview-title-input')).not.toBeNull();
  });

  it('edit-card on a column card swaps its title for a text input', () => {
    const col: ColumnCard = { id: 'co1', kind: 'column', x: 0, y: 0, w: 300, h: 400, title: 'My Column', children: [] };
    const { renderer, container } = setup([col]);
    const el = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="co1"]')!;
    expect(el.querySelector('input')).toBeNull();

    renderer.selection.select('co1');
    (renderer as any).handleCtxEvent({ type: 'edit-card' });

    expect(el.querySelector('input.visual-notes-kanban-title-input')).not.toBeNull();
  });

  it('a plain tap (no drag) on a kanban item opens its editor only when Platform.isPhone is true', () => {
    const kb: KanbanColumnCard = {
      id: 'kb1', kind: 'kanban-column', x: 0, y: 0, w: 260, h: 300, color: '#fff',
      items: [{ id: 'it1', text: 'Buy milk', done: false }],
    };
    const { container } = setup([kb]);
    const itemEl = container.querySelector<HTMLElement>('.visual-notes-kanban-item[data-item-id="it1"]')!;
    expect(itemEl).toBeTruthy();

    Platform.isPhone = false;
    itemEl.dispatchEvent(pointer('pointerdown', 50, 50));
    itemEl.dispatchEvent(pointer('pointerup', 50, 50));
    expect(itemEl.querySelector('.visual-notes-kanban-item-editor')).toBeNull();

    Platform.isPhone = true;
    itemEl.dispatchEvent(pointer('pointerdown', 50, 50));
    itemEl.dispatchEvent(pointer('pointerup', 50, 50));
    expect(itemEl.querySelector('.visual-notes-kanban-item-editor')).not.toBeNull();
  });

  // Reported: "You can add items but you can[']t tick it when a task's done."
  // The checkbox registered only a `click` listener. Every other control in
  // the kanban file — column menu, collapse, add-item, and the *subtask*
  // checkbox, which works — pairs `click` with a pointerdown stopPropagation
  // guard, because otherwise the event travels up to the card-level drag
  // machinery, which begins a card drag and swallows the click that would
  // have ticked the item.
  const kanbanWithItem = (): KanbanColumnCard => ({
    id: 'kb1', kind: 'kanban-column', x: 0, y: 0, w: 260, h: 300, color: '#fff',
    items: [{ id: 'it1', text: 'Buy milk', done: false }],
  });

  it('stops an item checkbox pointerdown before it reaches the card', () => {
    const kb = kanbanWithItem();
    const { container } = setup([kb]);
    const cardEl = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="kb1"]')!;
    const cb = container.querySelector<HTMLElement>('.visual-notes-kanban-item[data-item-id="it1"] .visual-notes-kanban-item-cb')!;
    expect(cb).toBeTruthy();

    let reachedCard = false;
    cardEl.addEventListener('pointerdown', () => { reachedCard = true; });

    cb.dispatchEvent(pointer('pointerdown', 10, 10));

    expect(reachedCard).toBe(false);
  });

  it('ticks the item when its checkbox is clicked', () => {
    const kb = kanbanWithItem();
    const { container } = setup([kb]);
    const itemEl = container.querySelector<HTMLElement>('.visual-notes-kanban-item[data-item-id="it1"]')!;
    const cb = itemEl.querySelector<HTMLElement>('.visual-notes-kanban-item-cb')!;

    cb.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(kb.items[0].done).toBe(true);
    expect(itemEl.hasClass('is-done')).toBe(true);
    expect(cb.hasClass('is-checked')).toBe(true);
  });
});

describe('UI smoke: mobile FAB (mobile UX phase 3)', () => {
  it('clicking the FAB toggles is-open on the toolbar and the icon between plus/x', () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 200, h: 120, text: 'hi', color: '#fff' };
    const { renderer } = setup([sticky]);
    const fab = renderer.fabEl!;
    expect(fab).toBeTruthy();
    expect(renderer.toolbarEl.hasClass('is-open')).toBe(false);

    fab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(renderer.toolbarEl.hasClass('is-open')).toBe(true);

    fab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(renderer.toolbarEl.hasClass('is-open')).toBe(false);
  });

  it('selecting a card closes the FAB sheet (closeFab runs from refreshSelectionVisuals)', () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 200, h: 120, text: 'hi', color: '#fff' };
    const { renderer } = setup([sticky]);
    renderer.fabEl!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(renderer.toolbarEl.hasClass('is-open')).toBe(true);

    renderer.selection.select('s1');
    renderer.refreshSelectionVisuals();

    expect(renderer.toolbarEl.hasClass('is-open')).toBe(false);
  });

  it('picking a tool from the sheet closes it (closeFab runs alongside activateTool)', () => {
    const { renderer, container } = setup([]);
    renderer.fabEl!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(renderer.toolbarEl.hasClass('is-open')).toBe(true);

    const stickyBtn = Array.from(container.querySelectorAll<HTMLElement>('.visual-notes-tb-btn'))
      .find(b => b.getAttribute('aria-label') === 'Sticky')!;
    expect(stickyBtn).toBeTruthy();
    stickyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(renderer.toolbarEl.hasClass('is-open')).toBe(false);
  });
});

describe('UI smoke: touch action sheet replaces desktop Menu on phone (mobile UX phase 5)', () => {
  afterEach(() => { Platform.isPhone = false; document.body.innerHTML = ''; });

  it('newMenu() returns a real desktop Menu when Platform.isPhone is false', () => {
    Platform.isPhone = false;
    const { renderer } = setup([]);
    const menu = (renderer as any).newMenu();
    expect(menu.constructor.name).toBe('Menu');
  });

  it('newMenu() returns a TouchActionSheet on phone, and showAtMouseEvent renders a bottom sheet with the added items', () => {
    Platform.isPhone = true;
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 200, h: 120, text: 'hi', color: '#fff' };
    const { renderer } = setup([sticky]);
    const el = document.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="s1"]')!;

    const menu = (renderer as any).newMenu();
    (renderer as any).populateCardMenu(menu, el, sticky);
    menu.showAtMouseEvent(new MouseEvent('contextmenu'));

    const sheet = document.querySelector('.visual-notes-touch-sheet');
    expect(sheet).not.toBeNull();
    const rowTitles = Array.from(sheet!.querySelectorAll('.visual-notes-touch-sheet-row-title')).map(n => n.textContent);
    expect(rowTitles).toContain('Delete');
    expect(rowTitles).toContain('Duplicate');
  });

  it('tapping a sheet row closes the sheet and runs the item\'s action', () => {
    Platform.isPhone = true;
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 200, h: 120, text: 'hi', color: '#fff' };
    const { renderer, board } = setup([sticky]);
    const el = document.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="s1"]')!;
    renderer.selection.select('s1');

    const menu = (renderer as any).newMenu();
    (renderer as any).populateCardMenu(menu, el, sticky);
    menu.showAtMouseEvent(new MouseEvent('contextmenu'));

    const rows = Array.from(document.querySelectorAll<HTMLElement>('.visual-notes-touch-sheet-row-title'));
    const deleteRow = rows.find(r => r.textContent === 'Delete')!.closest<HTMLElement>('.visual-notes-touch-sheet-row')!;
    deleteRow.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(document.querySelector('.visual-notes-touch-sheet-backdrop')).toBeNull();
    expect(board.cards).toHaveLength(0);
  });

  it('tapping the backdrop (outside the sheet) dismisses it without running any action', () => {
    Platform.isPhone = true;
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 200, h: 120, text: 'hi', color: '#fff' };
    const { renderer, board } = setup([sticky]);
    const el = document.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="s1"]')!;

    const menu = (renderer as any).newMenu();
    (renderer as any).populateCardMenu(menu, el, sticky);
    menu.showAtMouseEvent(new MouseEvent('contextmenu'));

    const backdrop = document.querySelector<HTMLElement>('.visual-notes-touch-sheet-backdrop')!;
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(document.querySelector('.visual-notes-touch-sheet-backdrop')).toBeNull();
    expect(board.cards).toHaveLength(1); // untouched
  });
});

describe('UI smoke: one-finger touch pan (canvas navigation)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a one-finger touch drag on empty canvas pans the viewport, after the 60ms no-second-finger debounce', async () => {
    const { renderer } = setup([]);
    const startX = renderer.vp.x, startY = renderer.vp.y;

    renderer.outer.dispatchEvent(pointer('pointerdown', 100, 100, { pointerType: 'touch' }));
    await vi.advanceTimersByTimeAsync(70); // past the 60ms debounce, no 2nd finger joined
    window.dispatchEvent(pointer('pointermove', 140, 130, { pointerType: 'touch' }));

    expect(renderer.vp.x).toBe(startX + 40);
    expect(renderer.vp.y).toBe(startY + 30);
  });

  it('does not start panning if a second finger joins within the 60ms debounce window (leaves room for pinch-zoom)', async () => {
    const { renderer } = setup([]);
    const startX = renderer.vp.x;

    renderer.outer.dispatchEvent(pointer('pointerdown', 100, 100, { pointerType: 'touch' }));
    renderer.activeTouches = 2; // normally set by the real touchstart handler
    await vi.advanceTimersByTimeAsync(70);
    window.dispatchEvent(pointer('pointermove', 200, 100, { pointerType: 'touch' }));

    expect(renderer.vp.x).toBe(startX); // pan never started
  });

  it('cancelActiveTouchPan (invoked when a 2nd finger lands mid-pan) stops further movement from panning', async () => {
    const { renderer } = setup([]);
    renderer.outer.dispatchEvent(pointer('pointerdown', 100, 100, { pointerType: 'touch' }));
    await vi.advanceTimersByTimeAsync(70);
    expect(renderer.cancelActiveTouchPan).not.toBeNull();

    const xAtCancel = renderer.vp.x;
    renderer.cancelActiveTouchPan!();
    expect(renderer.cancelActiveTouchPan).toBeNull();

    window.dispatchEvent(pointer('pointermove', 300, 100, { pointerType: 'touch' }));
    expect(renderer.vp.x).toBe(xAtCancel); // no longer tracking this finger
  });

  it('a mouse drag on empty canvas still rubber-band selects (marquee), not panning', () => {
    const { renderer } = setup([]);
    const startX = renderer.vp.x;

    // No pointerType — pointer() defaults to a plain mouse-style event.
    renderer.outer.dispatchEvent(pointer('pointerdown', 0, 0));
    renderer.outer.dispatchEvent(pointer('pointermove', 100, 100));

    expect(renderer.vp.x).toBe(startX); // unchanged — a marquee doesn't pan
    // jsdom has no real layout engine (every getBoundingClientRect() is
    // zeros), so overlap-based selection can't be asserted here — but the
    // marquee box itself becoming visible confirms this went through
    // startMarquee, not startTouchPan.
    expect(renderer.marqueeEl.style.display).not.toBe('none');

    renderer.outer.dispatchEvent(pointer('pointerup', 100, 100));
  });
});

describe('UI smoke: mobile FAB position (settings-driven corner)', () => {
  it('defaults to bottom-right when no setting is configured', () => {
    const { renderer } = setup([]);
    expect(renderer.toolbarEl.hasClass('fab-corner-bottom-right')).toBe(true);
    expect(renderer.container.hasClass('mobile-fab-bottom-right')).toBe(true);
  });

  it('applies a configured corner to both the toolbar and the container', () => {
    const { renderer } = setup([], [], 'top-left');
    expect(renderer.toolbarEl.hasClass('fab-corner-top-left')).toBe(true);
    expect(renderer.container.hasClass('mobile-fab-top-left')).toBe(true);
    expect(renderer.toolbarEl.hasClass('fab-corner-bottom-right')).toBe(false);
  });
});

describe('UI smoke: minimap/zoom/snap hide while the phone context bar is active', () => {
  it('hides when a single card is selected, and shows again once deselected', () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 100, h: 60, text: 'hi', color: '#fff' };
    const { renderer } = setup([sticky]);
    expect(renderer.zoomPill!.hasClass('is-hidden-for-ctx-bar')).toBe(false);
    expect(renderer.snapToggleBtn!.hasClass('is-hidden-for-ctx-bar')).toBe(false);
    expect(renderer.minimapEl!.hasClass('is-hidden-for-ctx-bar')).toBe(false);

    renderer.selection.select('s1');
    renderer.refreshSelectionVisuals();
    expect(renderer.zoomPill!.hasClass('is-hidden-for-ctx-bar')).toBe(true);
    expect(renderer.snapToggleBtn!.hasClass('is-hidden-for-ctx-bar')).toBe(true);
    expect(renderer.minimapEl!.hasClass('is-hidden-for-ctx-bar')).toBe(true);

    renderer.selection.clear();
    renderer.refreshSelectionVisuals();
    expect(renderer.zoomPill!.hasClass('is-hidden-for-ctx-bar')).toBe(false);
    expect(renderer.snapToggleBtn!.hasClass('is-hidden-for-ctx-bar')).toBe(false);
    expect(renderer.minimapEl!.hasClass('is-hidden-for-ctx-bar')).toBe(false);
  });

  it('stays visible when multiple cards are selected (no single-card context bar to conflict with)', () => {
    const a: StickyCard = { id: 'a', kind: 'sticky', x: 0, y: 0, w: 100, h: 60, text: 'A', color: '#fff' };
    const b: StickyCard = { id: 'b', kind: 'sticky', x: 200, y: 0, w: 100, h: 60, text: 'B', color: '#fff' };
    const { renderer } = setup([a, b]);
    renderer.selection.select('a'); renderer.selection.add('b');
    renderer.refreshSelectionVisuals();
    expect(renderer.zoomPill!.hasClass('is-hidden-for-ctx-bar')).toBe(false);
  });
});

describe('UI smoke: sticky/note text auto-contrast against background', () => {
  it('a pale background gets dark auto-contrast text', () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 200, h: 120, text: 'hi', color: '#FDE68A' };
    const { container } = setup([sticky]);
    const textEl = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="s1"] .visual-notes-sticky-text')!;
    expect(textEl.style.color).toBe('rgb(26, 26, 26)'); // #1a1a1a
  });

  it('a dark background gets light auto-contrast text', () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 200, h: 120, text: 'hi', color: '#1a1a2e' };
    const { container } = setup([sticky]);
    const textEl = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="s1"] .visual-notes-sticky-text')!;
    expect(textEl.style.color).toBe('rgb(255, 255, 255)'); // #ffffff
  });

  it('an explicit card.textColor overrides auto-contrast', () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 200, h: 120, text: 'hi', color: '#FDE68A', textColor: '#0000ff' };
    const { container } = setup([sticky]);
    const textEl = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="s1"] .visual-notes-sticky-text')!;
    expect(textEl.style.color).toBe('rgb(0, 0, 255)');
  });

  it('a theme-driven background (var(...)) is left to CSS, not JS-computed contrast', () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 200, h: 120, text: 'hi', color: 'var(--visual-notes-card-bg)' };
    const { container } = setup([sticky]);
    const textEl = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="s1"] .visual-notes-sticky-text')!;
    expect(textEl.style.color).toBe(''); // no inline override — var(--visual-notes-card-text) from the stylesheet applies
  });

  it('picking a new background color via the context bar recomputes text contrast', () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 200, h: 120, text: 'hi', color: '#FDE68A' };
    const { renderer, container } = setup([sticky]);
    renderer.selection.select('s1');
    (renderer as any).handleCtxEvent({ type: 'sticky-color', hex: '#1a1a2e' });

    const textEl = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="s1"] .visual-notes-sticky-text')!;
    expect(textEl.style.color).toBe('rgb(255, 255, 255)');
  });

  it('a blank Note defaults to a theme-following background, not a hardcoded near-white hex', () => {
    const { renderer, board } = setup([]);
    (renderer as any).addBlankCardAt(0, 0);
    const note = board.cards[0] as StickyCard;
    expect(note.color).toBe('var(--visual-notes-card-bg)');
  });
});

describe('UI smoke: pen default ink color follows the active theme', () => {
  afterEach(() => { document.body.removeClass('theme-dark'); });

  // A resolved hex computed once at construction (the old approach) never
  // adapted if the user switched theme mid-session — reported as new
  // strokes staying whatever color the board opened with. A literal CSS
  // variable reference re-resolves live with the theme, in either mode,
  // with no JS-side detection needed at all.
  it('defaults to a live-resolving CSS variable, not a hex baked in at construction time', () => {
    document.body.removeClass('theme-dark');
    const { renderer: light } = setup([]);
    expect(light.currentInkColor).toBe('var(--text-normal)');

    document.body.addClass('theme-dark');
    const { renderer: dark } = setup([]);
    expect(dark.currentInkColor).toBe('var(--text-normal)');
  });
});

describe('UI smoke: kanban/column header buttons stay clickable (delegated pointerdown regression)', () => {
  // bindDelegatedCardEvents' single pointerdown listener on the canvas
  // calls e.preventDefault() on every kanban/column/board card pointerdown
  // except a few explicitly exempted targets (titles) — and in a real
  // browser, preventDefault() on pointerdown suppresses the mousedown/click
  // that would otherwise follow for that same press. Every clickable header
  // button therefore needs its own pointerdown listener that stops
  // propagation before the event ever reaches the delegated handler
  // (matching the pre-existing lock-button/table-card pattern) — without
  // it, the button never receives a click in a real browser even though it
  // looks and behaves normally in code. jsdom doesn't synthesize click from
  // pointerdown/mousedown, so these tests assert the mechanism itself
  // (defaultPrevented stays false) rather than a real click firing.
  it('single-column kanban "Add item" button pointerdown does not reach the delegated handler', () => {
    const kb: KanbanColumnCard = { id: 'kb1', kind: 'kanban-column', x: 0, y: 0, w: 260, h: 300, color: '#fff', items: [] };
    const { container } = setup([kb]);
    const addBtn = container.querySelector<HTMLElement>('.visual-notes-kanban-add-btn')!;
    expect(addBtn).toBeTruthy();
    const ev = pointer('pointerdown', 50, 50);
    addBtn.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('kanban board "Add column" button pointerdown does not reach the delegated handler', () => {
    const board: KanbanBoardCard = {
      id: 'kbd1', kind: 'kanban-board', x: 0, y: 0, w: 500, h: 300,
      columns: [{ id: 'c1', title: 'To do', color: '#6b7280', items: [] }],
    };
    const { container } = setup([board]);
    const addColBtn = container.querySelector<HTMLElement>(
      '.visual-notes-kanban-board-add-col-btn:not(.visual-notes-kanban-board-remove-col-btn)',
    )!;
    expect(addColBtn).toBeTruthy();
    const ev = pointer('pointerdown', 50, 50);
    addColBtn.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('a kanban board column\'s "Add item" button pointerdown does not reach the delegated handler', () => {
    const board: KanbanBoardCard = {
      id: 'kbd1', kind: 'kanban-board', x: 0, y: 0, w: 500, h: 300,
      columns: [{ id: 'c1', title: 'To do', color: '#6b7280', items: [] }],
    };
    const { container } = setup([board]);
    const addBtn = container.querySelector<HTMLElement>('.visual-notes-kanban-board-column .visual-notes-kanban-add-btn')!;
    expect(addBtn).toBeTruthy();
    const ev = pointer('pointerdown', 50, 50);
    addBtn.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('a kanban board column\'s "…" options button pointerdown does not reach the delegated handler', () => {
    const board: KanbanBoardCard = {
      id: 'kbd1', kind: 'kanban-board', x: 0, y: 0, w: 500, h: 300,
      columns: [{ id: 'c1', title: 'To do', color: '#6b7280', items: [] }],
    };
    const { container } = setup([board]);
    const menuBtn = container.querySelector<HTMLElement>('.visual-notes-kanban-column-menu-btn')!;
    expect(menuBtn).toBeTruthy();
    const ev = pointer('pointerdown', 50, 50);
    menuBtn.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('a generic Column card title pointerdown does not reach the delegated handler, so dblclick rename still fires', () => {
    const col: ColumnCard = { id: 'co1', kind: 'column', x: 0, y: 0, w: 300, h: 400, title: 'My Column', children: [] };
    const { container } = setup([col]);
    const titleEl = container.querySelector<HTMLElement>('.visual-notes-column-title')!;
    expect(titleEl).toBeTruthy();
    const ev = pointer('pointerdown', 50, 50);
    titleEl.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  // A double-click is two real mousedown/mouseup/click pairs under the
  // hood. e.preventDefault() on pointerdown suppresses that whole
  // compatibility mousedown/click chain for the press it's called on — so a
  // header-level dblclick listener alone (below) is not enough on its own;
  // the browser must actually be *able* to produce click/dblclick events
  // for the header's background in the first place, not just the title
  // text. These check the pointerdown-level mechanism directly, since
  // jsdom (unlike a real browser) doesn't suppress a manually-dispatched
  // dblclick just because an earlier pointerdown called preventDefault.
  it('a pointerdown on the kanban header background (not the title) does not get preventDefault', () => {
    const kb: KanbanColumnCard = { id: 'kb1', kind: 'kanban-column', x: 0, y: 0, w: 260, h: 300, color: '#fff', items: [] };
    const { container } = setup([kb]);
    const header = container.querySelector<HTMLElement>('.visual-notes-kanban-header')!;
    const ev = pointer('pointerdown', 50, 50);
    header.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('a pointerdown on the kanban board titlebar background (not the title) does not get preventDefault', () => {
    const board: KanbanBoardCard = {
      id: 'kbd1', kind: 'kanban-board', x: 0, y: 0, w: 500, h: 300,
      columns: [{ id: 'c1', title: 'To do', color: '#6b7280', items: [] }],
    };
    const { container } = setup([board]);
    const titlebar = container.querySelector<HTMLElement>('.visual-notes-kanban-board-titlebar')!;
    const ev = pointer('pointerdown', 50, 50);
    titlebar.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('a pointerdown on a kanban board column\'s header background (not the title) does not get preventDefault', () => {
    const board: KanbanBoardCard = {
      id: 'kbd1', kind: 'kanban-board', x: 0, y: 0, w: 500, h: 300,
      columns: [{ id: 'c1', title: 'To do', color: '#6b7280', items: [] }],
    };
    const { container } = setup([board]);
    const header = container.querySelector<HTMLElement>('.visual-notes-kanban-board-column .visual-notes-kanban-header')!;
    const ev = pointer('pointerdown', 50, 50);
    header.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('a pointerdown on a generic Column card header background (not the title) does not get preventDefault', () => {
    const col: ColumnCard = { id: 'co1', kind: 'column', x: 0, y: 0, w: 300, h: 400, title: 'My Column', children: [] };
    const { container } = setup([col]);
    const header = container.querySelector<HTMLElement>('.visual-notes-column-header')!;
    const ev = pointer('pointerdown', 50, 50);
    header.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe('UI smoke: double-clicking the header (not just the title text) opens rename, incl. "Untitled" placeholders', () => {
  it('single-column kanban card: dblclick on the header background, not the title, renames an untitled card', () => {
    const kb: KanbanColumnCard = { id: 'kb1', kind: 'kanban-column', x: 0, y: 0, w: 260, h: 300, color: '#fff', items: [] };
    const { container } = setup([kb]);
    const titleEl = container.querySelector<HTMLElement>('.visual-notes-kanban-title')!;
    expect(titleEl.textContent).toBe('Untitled');
    const header = container.querySelector<HTMLElement>('.visual-notes-kanban-header')!;
    header.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(header.querySelector('input.visual-notes-kanban-title-input')).not.toBeNull();
  });

  it('kanban board: dblclick on the titlebar background, not the title, renames an untitled board', () => {
    const board: KanbanBoardCard = {
      id: 'kbd1', kind: 'kanban-board', x: 0, y: 0, w: 500, h: 300,
      columns: [{ id: 'c1', title: 'To do', color: '#6b7280', items: [] }],
    };
    const { container } = setup([board]);
    const titleEl = container.querySelector<HTMLElement>('.visual-notes-kanban-board-title')!;
    expect(titleEl.textContent).toBe('Untitled board');
    const titlebar = container.querySelector<HTMLElement>('.visual-notes-kanban-board-titlebar')!;
    titlebar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(titlebar.querySelector('input.visual-notes-kanban-title-input')).not.toBeNull();
  });

  it('kanban board column: dblclick on the column header background, not the title, renames an untitled column', () => {
    const board: KanbanBoardCard = {
      id: 'kbd1', kind: 'kanban-board', x: 0, y: 0, w: 500, h: 300,
      columns: [{ id: 'c1', color: '#6b7280', items: [] }],
    };
    const { container } = setup([board]);
    const titleEl = container.querySelector<HTMLElement>('.visual-notes-kanban-board-column .visual-notes-kanban-title')!;
    expect(titleEl.textContent).toBe('Untitled');
    const header = container.querySelector<HTMLElement>('.visual-notes-kanban-board-column .visual-notes-kanban-header')!;
    header.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(header.querySelector('input.visual-notes-kanban-title-input')).not.toBeNull();
  });

  it('generic Column card: dblclick on the header background, not the title, renames an untitled column', () => {
    const col: ColumnCard = { id: 'co1', kind: 'column', x: 0, y: 0, w: 300, h: 400, children: [] };
    const { container } = setup([col]);
    const titleEl = container.querySelector<HTMLElement>('.visual-notes-column-title')!;
    expect(titleEl.textContent).toBe('Untitled column');
    const header = container.querySelector<HTMLElement>('.visual-notes-column-header')!;
    header.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(header.querySelector('input.visual-notes-kanban-title-input')).not.toBeNull();
  });

  it('does not open rename when the dblclick lands on the collapse button', () => {
    const kb: KanbanColumnCard = { id: 'kb1', kind: 'kanban-column', x: 0, y: 0, w: 260, h: 300, color: '#fff', items: [] };
    const { container } = setup([kb]);
    const collapseBtn = container.querySelector<HTMLElement>('.visual-notes-kanban-collapse-btn')!;
    collapseBtn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(container.querySelector('input.visual-notes-kanban-title-input')).toBeNull();
  });
});

describe('UI smoke: "…" menu button offers a reliable Rename, not dependent on double-click at all', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  // MenuItemStub.setTitle() is a no-op in the test double (doesn't record
  // the label) — so rather than asserting on menu item text, these capture
  // the real Menu instance built by the click handler and trigger its first
  // (only) item directly, then assert on the resulting DOM change, which is
  // what actually matters: the button reliably gets you into rename mode.
  function captureMenu(): { get: () => InstanceType<typeof Menu> | null } {
    let captured: InstanceType<typeof Menu> | null = null;
    vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (this: InstanceType<typeof Menu>) {
      captured = this;
    });
    return { get: () => captured };
  }

  it('single-column kanban card: the "…" menu\'s first item renames it', () => {
    const kb: KanbanColumnCard = { id: 'kb1', kind: 'kanban-column', x: 0, y: 0, w: 260, h: 300, color: '#fff', items: [] };
    const { container } = setup([kb]);
    const menuBtn = container.querySelector<HTMLElement>('.visual-notes-kanban-header .visual-notes-kanban-column-menu-btn')!;
    expect(menuBtn).toBeTruthy();

    const menuBox = captureMenu();
    menuBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const menu = menuBox.get()!;
    expect(menu.items.length).toBeGreaterThan(0);
    (menu.items[0] as any).__trigger();

    expect(container.querySelector('input.visual-notes-kanban-title-input')).not.toBeNull();
  });

  it('kanban board: the titlebar "…" menu\'s first item renames the board', () => {
    const board: KanbanBoardCard = {
      id: 'kbd1', kind: 'kanban-board', x: 0, y: 0, w: 500, h: 300,
      columns: [{ id: 'c1', title: 'To do', color: '#6b7280', items: [] }],
    };
    const { container } = setup([board]);
    const menuBtn = container.querySelector<HTMLElement>('.visual-notes-kanban-board-menu-btn')!;
    expect(menuBtn).toBeTruthy();

    const menuBox = captureMenu();
    menuBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const menu = menuBox.get()!;
    expect(menu.items.length).toBeGreaterThan(0);
    (menu.items[0] as any).__trigger();

    expect(container.querySelector('.visual-notes-kanban-board-titlebar input.visual-notes-kanban-title-input')).not.toBeNull();
  });

  it('generic Column card: the "…" menu\'s first item renames it', () => {
    const col: ColumnCard = { id: 'co1', kind: 'column', x: 0, y: 0, w: 300, h: 400, title: 'My Column', children: [] };
    const { container } = setup([col]);
    const menuBtn = container.querySelector<HTMLElement>('.visual-notes-column-header .visual-notes-kanban-column-menu-btn')!;
    expect(menuBtn).toBeTruthy();

    const menuBox = captureMenu();
    menuBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const menu = menuBox.get()!;
    expect(menu.items.length).toBeGreaterThan(0);
    (menu.items[0] as any).__trigger();

    expect(container.querySelector('input.visual-notes-kanban-title-input')).not.toBeNull();
  });

  it('the new menu buttons stay clickable (pointerdown does not reach the delegated card handler)', () => {
    const kb: KanbanColumnCard = { id: 'kb1', kind: 'kanban-column', x: 0, y: 0, w: 260, h: 300, color: '#fff', items: [] };
    const { container } = setup([kb]);
    const menuBtn = container.querySelector<HTMLElement>('.visual-notes-kanban-header .visual-notes-kanban-column-menu-btn')!;
    const ev = pointer('pointerdown', 50, 50);
    menuBtn.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe('UI smoke: pen strokes only merge into one group when drawn close together', () => {
  // With the default viewport ({x:0, y:0, zoom:1}) and jsdom's zeroed
  // getBoundingClientRect(), screenToCanvas is an identity mapping — so
  // these client coordinates land at the same canvas coordinates, no
  // layout mocking required.
  function drawStroke(renderer: FreeformRenderer, sx: number, sy: number, ex: number, ey: number) {
    renderer.outer.dispatchEvent(pointer('pointerdown', sx, sy));
    document.dispatchEvent(pointer('pointerup', ex, ey));
  }

  it('two strokes drawn far apart in the same pen session get different groupIds', () => {
    const { renderer, board } = setup([]);
    renderer.enterPenMode();
    drawStroke(renderer, 0, 0, 20, 20);
    drawStroke(renderer, 500, 500, 520, 520);
    expect(board.drawings).toHaveLength(2);
    expect(board.drawings[0].groupId).not.toBe(board.drawings[1].groupId);
  });

  it('two strokes drawn close together in the same pen session share a groupId', () => {
    const { renderer, board } = setup([]);
    renderer.enterPenMode();
    drawStroke(renderer, 0, 0, 20, 20);
    drawStroke(renderer, 25, 25, 40, 40);
    expect(board.drawings).toHaveLength(2);
    expect(board.drawings[0].groupId).toBe(board.drawings[1].groupId);
  });

  it('grouping only tracks proximity to the most recently drawn stroke, not every earlier one', () => {
    const { renderer, board } = setup([]);
    renderer.enterPenMode();
    drawStroke(renderer, 0, 0, 20, 20);       // group A
    drawStroke(renderer, 500, 500, 520, 520); // group B (far from A) — now the "active" group
    drawStroke(renderer, 22, 22, 30, 30);     // near A's old location, but far from B
    expect(board.drawings).toHaveLength(3);
    // Gets its own fresh group rather than silently reattaching to A, which
    // was drawn several strokes ago and is no longer the active sketch.
    expect(board.drawings[2].groupId).not.toBe(board.drawings[0].groupId);
    expect(board.drawings[2].groupId).not.toBe(board.drawings[1].groupId);
  });

  it('a stroke starting inside another group\'s bounding box, but far from its actual line, does not merge with it', () => {
    // The old check treated "inside the group's bounding rectangle" as
    // "near it" — a big or diagonal shape's bbox can cover a lot of empty
    // space nothing was actually drawn in. A diagonal stroke corner-to-
    // corner has a bbox spanning the whole square; a new stroke starting
    // near the *opposite* corner is well within that bbox but nowhere near
    // the actual line, and should not be swept into the same group.
    const { renderer, board } = setup([]);
    renderer.enterPenMode();
    drawStroke(renderer, 0, 0, 500, 500);   // diagonal corner-to-corner, group A
    drawStroke(renderer, 450, 50, 480, 60); // inside A's bbox, ~450px from the actual line
    expect(board.drawings).toHaveLength(2);
    expect(board.drawings[1].groupId).not.toBe(board.drawings[0].groupId);
  });

  it('a new stroke force-closes any stroke still open from an unfinished previous tap, even when it reuses the same pointerId', () => {
    // A real sequential lift-then-touch-again always delivers a pointerup
    // before the next pointerdown — but hover-capable Apple Pencil (finger
    // touches were unaffected) can apparently miss that boundary, leaving
    // the previous stroke's listeners dangling and silently absorbing the
    // next stroke's events, which reads as the Pencil going unresponsive.
    // Critically, Apple Pencil is tracked as one persistent hoverable
    // device and reuses the *same* pointerId across separate taps (unlike
    // a finger touch, which always gets a fresh one) — so the two taps
    // here deliberately share an id, matching that behavior; a plain
    // pointerId filter alone can't distinguish them. startInkStroke now
    // force-aborts any still-open stroke before starting a new one.
    const { renderer, board } = setup([]);
    renderer.enterPenMode();

    renderer.outer.dispatchEvent(pointer('pointerdown', 0, 0, { pointerId: 1 }));
    document.dispatchEvent(pointer('pointermove', 10, 10, { pointerId: 1 })); // stroke 1 in progress, no pointerup yet

    // Stroke 2 starts on the *same* pointerId while stroke 1 is still open.
    renderer.outer.dispatchEvent(pointer('pointerdown', 500, 500, { pointerId: 1 }));
    document.dispatchEvent(pointer('pointerup', 510, 510, { pointerId: 1 }));

    expect(board.drawings).toHaveLength(1);
    for (const p of board.drawings[0].points) expect(p.x).toBeGreaterThan(400);
  });

  it('a Pencil stroke is not blocked from starting by incidental touches (palm resting nearby)', () => {
    // activeTouches counts contacts from the native touch pipeline, which
    // Apple Pencil itself never appears in — so a resting palm or
    // supporting finger during normal handwriting posture can put
    // activeTouches at 2 while drawing with the Pencil. The pinch-abort
    // guard exists to protect *finger*-drawn strokes from a real second
    // finger; it has no business over the Pencil just because a hand
    // happens to be resting on the glass.
    const { renderer, board } = setup([]);
    renderer.enterPenMode();
    renderer.activeTouches = 2; // palm already down before the Pencil touches
    renderer.outer.dispatchEvent(pointer('pointerdown', 0, 0, { pointerType: 'pen' }));
    document.dispatchEvent(pointer('pointerup', 100, 100, { pointerType: 'pen' }));
    expect(board.drawings).toHaveLength(1);
  });

  it('a Pencil stroke is not cancelled mid-draw when a palm/finger touch joins', () => {
    const { renderer, board } = setup([]);
    renderer.enterPenMode();
    renderer.outer.dispatchEvent(pointer('pointerdown', 0, 0, { pointerType: 'pen' }));
    renderer.activeTouches = 2; // palm settles onto the glass mid-stroke
    document.dispatchEvent(pointer('pointermove', 50, 50, { pointerType: 'pen' }));
    document.dispatchEvent(pointer('pointerup', 100, 100, { pointerType: 'pen' }));
    expect(board.drawings).toHaveLength(1);
    expect(board.drawings[0].points.some(p => p.x >= 50)).toBe(true);
  });

  it('a Pencil stroke still starts even when the event arrives with isPrimary: false', () => {
    // isPrimary is the browser's own "first contact of this pointer type"
    // flag — meaningful for fingers (a real second finger of a pinch gets
    // isPrimary: false), but there's no such thing as a second Apple
    // Pencil. WebKit's hover/touch bookkeeping around the lift-and-retouch
    // transition (the same quirk activeStrokeAbort defends against) could
    // still hand a Pencil pointerdown a false isPrimary with nothing else
    // touching the screen at all, which used to discard the stroke outright.
    const { renderer, board } = setup([]);
    renderer.enterPenMode();
    renderer.outer.dispatchEvent(pointer('pointerdown', 0, 0, { pointerType: 'pen', isPrimary: false }));
    document.dispatchEvent(pointer('pointerup', 100, 100, { pointerType: 'pen', isPrimary: false }));
    expect(board.drawings).toHaveLength(1);
  });

  it('a finger-drawn stroke still refuses to start with isPrimary: false (pinch protection preserved)', () => {
    const { renderer, board } = setup([]);
    renderer.enterPenMode();
    renderer.outer.dispatchEvent(pointer('pointerdown', 0, 0, { pointerType: 'touch', isPrimary: false }));
    document.dispatchEvent(pointer('pointerup', 100, 100, { pointerType: 'touch', isPrimary: false }));
    expect(board.drawings).toHaveLength(0);
  });

  it('a finger-drawn stroke still refuses to start with a second finger already down (pinch protection preserved)', () => {
    const { renderer, board } = setup([]);
    renderer.enterPenMode();
    renderer.activeTouches = 2;
    renderer.outer.dispatchEvent(pointer('pointerdown', 0, 0, { pointerType: 'touch' }));
    document.dispatchEvent(pointer('pointerup', 100, 100, { pointerType: 'touch' }));
    expect(board.drawings).toHaveLength(0);
  });

  it('a finger-drawn stroke is still cancelled when a second finger joins mid-draw (pinch protection preserved)', () => {
    const { renderer, board } = setup([]);
    renderer.enterPenMode();
    renderer.outer.dispatchEvent(pointer('pointerdown', 0, 0, { pointerType: 'touch' }));
    renderer.activeTouches = 2; // second finger lands mid-stroke
    document.dispatchEvent(pointer('pointermove', 50, 50, { pointerType: 'touch' }));
    document.dispatchEvent(pointer('pointerup', 100, 100, { pointerType: 'touch' }));
    expect(board.drawings).toHaveLength(0);
  });

  it('eraser swiped across the middle of a straight line erases it (segment hit, not just stored points)', () => {
    // A straight line is stored as only its two endpoints — the old eraser
    // measured distance to stored *points*, so criss-crossing its middle
    // (nowhere near either endpoint) never erased it.
    const { renderer, board } = setup([]);
    renderer.enterPenMode();
    drawStroke(renderer, 0, 100, 400, 100);
    expect(board.drawings).toHaveLength(1);
    renderer.penTool = 'eraser';
    renderer.outer.dispatchEvent(pointer('pointerdown', 200, 50));
    document.dispatchEvent(pointer('pointermove', 200, 150));
    document.dispatchEvent(pointer('pointerup', 200, 150));
    expect(board.drawings).toHaveLength(0);
  });

  it('pen strokes render as a filled tapered outline (perfect-freehand), not a stroked polyline', () => {
    const { renderer, board, container } = setup([]);
    renderer.enterPenMode();
    drawStroke(renderer, 0, 0, 100, 100);
    expect(board.drawings).toHaveLength(1);
    const path = container.querySelector<SVGPathElement>('.visual-notes-ink-svg path')!;
    expect(path.getAttribute('fill')).toBe(board.drawings[0].color);
    expect(path.getAttribute('stroke')).toBe('none');
    // Closed outline path — the ribbon shape, not an open centerline.
    expect(path.getAttribute('d')).toMatch(/Z$/);
  });

  it('a short stroke/dot renders at full width instead of collapsing to a hairline', () => {
    // perfect-freehand's outline construction goes unstable — the ribbon
    // collapses to a near-zero-width sliver across its *entire* length,
    // not a gradual thin-out — once a stroke's taper distance is close to
    // (not even necessarily longer than) its own total path length. A
    // short tap/dot with a fixed taper reliably collapses this way; the
    // fix skips tapering entirely for strokes that short.
    const { renderer, board, container } = setup([]);
    renderer.enterPenMode();
    drawStroke(renderer, 0, 0, 3, 0); // short, straight, horizontal — default width 3
    expect(board.drawings).toHaveLength(1);
    const d = container.querySelector<SVGPathElement>('.visual-notes-ink-svg path')!.getAttribute('d')!;
    const nums = d.match(/-?\d+\.?\d*/g)!.map(Number);
    const ys: number[] = [];
    for (let i = 1; i < nums.length; i += 2) ys.push(nums[i]);
    const perpendicularSpread = Math.max(...ys) - Math.min(...ys);
    // Full diameter is the fixed size (16); collapsed comes out at ~0.02 —
    // practically invisible.
    expect(perpendicularSpread).toBeGreaterThan(3);
  });

  it('pen strokes render at a fixed size regardless of stroke.width (Thin/Medium/Thick no longer changes the shape)', () => {
    // Deliberate simplification, not a bug — see buildPenOutlineD.
    const { renderer } = setup([]);
    const points = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }];
    const thin: DrawingStroke = { id: 't', groupId: 'g', points, color: '#000', width: 2 };
    const thick: DrawingStroke = { id: 'k', groupId: 'g', points, color: '#000', width: 8 };
    expect(renderer.buildPenOutlineD(thin)).toBe(renderer.buildPenOutlineD(thick));
  });

  it('preserves stylus pressure when a drawing is moved or resized', () => {
    const { renderer, board } = setup([]);
    const stroke: DrawingStroke = {
      id: 'pressure-stroke', groupId: 'pressure-group', color: '#000', width: 4,
      points: [{ x: 0, y: 0, p: 0.2 }, { x: 40, y: 20, p: 0.8 }],
    };
    board.drawings.push(stroke);
    renderer.renderSingleDrawing(stroke);

    const hit = renderer.inkHitPaths.get(stroke.id)!;
    hit.dispatchEvent(pointer('pointerdown', 0, 0));
    document.dispatchEvent(pointer('pointermove', 20, 10));
    document.dispatchEvent(pointer('pointerup', 20, 10));
    expect(stroke.points.map(p => p.p)).toEqual([0.2, 0.8]);

    renderer.startDrawingResize(pointer('pointerdown', 60, 30), stroke.groupId, 'se');
    document.dispatchEvent(pointer('pointermove', 80, 50));
    document.dispatchEvent(pointer('pointerup', 80, 50));
    expect(stroke.points.map(p => p.p)).toEqual([0.2, 0.8]);
  });
});

describe('UI smoke: pen/marker strokes support Shift/Ctrl multi-select', () => {
  function drawStroke(renderer: FreeformRenderer, sx: number, sy: number, ex: number, ey: number) {
    renderer.outer.dispatchEvent(pointer('pointerdown', sx, sy));
    document.dispatchEvent(pointer('pointerup', ex, ey));
  }

  function twoFarApartStrokes(renderer: FreeformRenderer) {
    renderer.enterPenMode();
    drawStroke(renderer, 0, 0, 20, 20);
    drawStroke(renderer, 500, 500, 520, 520);
    renderer.exitPenMode();
  }

  it('a plain click selects just the clicked stroke\'s group', () => {
    const { renderer, board } = setup([]);
    twoFarApartStrokes(renderer);
    const [s1] = board.drawings;
    const hit1 = renderer.inkHitPaths.get(s1.id)!;

    hit1.dispatchEvent(pointer('pointerdown', 10, 10));
    document.dispatchEvent(pointer('pointerup', 10, 10));

    expect(renderer.selectedDrawingIds.size).toBe(1);
    expect(renderer.selectedDrawingIds.has(s1.groupId)).toBe(true);
  });

  it('shift-clicking a second, far-away stroke adds it to the selection instead of replacing it', () => {
    const { renderer, board } = setup([]);
    twoFarApartStrokes(renderer);
    const [s1, s2] = board.drawings;
    const hit1 = renderer.inkHitPaths.get(s1.id)!;
    const hit2 = renderer.inkHitPaths.get(s2.id)!;

    hit1.dispatchEvent(pointer('pointerdown', 10, 10));
    document.dispatchEvent(pointer('pointerup', 10, 10));
    hit2.dispatchEvent(pointer('pointerdown', 510, 510, { shiftKey: true }));
    document.dispatchEvent(pointer('pointerup', 510, 510));

    expect(renderer.selectedDrawingIds.size).toBe(2);
    expect(renderer.selectedDrawingIds.has(s1.groupId)).toBe(true);
    expect(renderer.selectedDrawingIds.has(s2.groupId)).toBe(true);
  });

  it('ctrl-clicking an already-selected stroke removes just that one from the selection', () => {
    const { renderer, board } = setup([]);
    twoFarApartStrokes(renderer);
    const [s1, s2] = board.drawings;
    const hit1 = renderer.inkHitPaths.get(s1.id)!;
    const hit2 = renderer.inkHitPaths.get(s2.id)!;

    hit1.dispatchEvent(pointer('pointerdown', 10, 10));
    document.dispatchEvent(pointer('pointerup', 10, 10));
    hit2.dispatchEvent(pointer('pointerdown', 510, 510, { ctrlKey: true }));
    document.dispatchEvent(pointer('pointerup', 510, 510));
    expect(renderer.selectedDrawingIds.size).toBe(2);

    hit1.dispatchEvent(pointer('pointerdown', 10, 10, { ctrlKey: true }));
    document.dispatchEvent(pointer('pointerup', 10, 10));

    expect(renderer.selectedDrawingIds.size).toBe(1);
    expect(renderer.selectedDrawingIds.has(s2.groupId)).toBe(true);
  });

  it('deleting a multi-group selection removes every selected group\'s strokes', () => {
    const { renderer, board } = setup([]);
    twoFarApartStrokes(renderer);
    const [s1, s2] = board.drawings;
    renderer.selectedDrawingIds = new Set([s1.groupId, s2.groupId]);

    renderer.deleteSelectedDrawing();

    expect(board.drawings).toHaveLength(0);
    expect(renderer.selectedDrawingIds.size).toBe(0);
  });

  it('a plain click-and-drag on a stroke already part of a multi-selection moves every selected group', () => {
    const { renderer, board } = setup([]);
    twoFarApartStrokes(renderer);
    const [s1, s2] = board.drawings;
    renderer.selectedDrawingIds = new Set([s1.groupId, s2.groupId]);
    const hit1 = renderer.inkHitPaths.get(s1.id)!;

    hit1.dispatchEvent(pointer('pointerdown', 10, 10));
    document.dispatchEvent(pointer('pointermove', 30, 10)); // past DRAG_THRESHOLD
    document.dispatchEvent(pointer('pointerup', 30, 10));

    // Both groups' strokes shifted by the same delta — s2 (the one not
    // clicked) only moves if the drag carried the whole selection, not
    // just the clicked stroke's own group.
    expect(s1.points[0].x).toBeCloseTo(20, 5);
    expect(s2.points[0].x).toBeCloseTo(520, 5);
  });
});

describe('UI smoke: box-select (marquee) also catches pen/marker strokes', () => {
  // jsdom has no real layout engine — mock getBoundingClientRect per
  // element (via a Map keyed by element identity) so the marquee's
  // rectangle-overlap test against each stroke's hit path has real
  // geometry to compare, same technique the connection-culling tests use
  // but generalized to Element since ink hit paths are SVG, not HTML.
  function mockRectsFor(rects: Map<Element, DOMRect>) {
    return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return rects.get(this) ?? ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => undefined } as DOMRect);
    });
  }
  function rect(l: number, t: number, w: number, h: number): DOMRect {
    return { x: l, y: t, width: w, height: h, top: t, left: l, right: l + w, bottom: t + h, toJSON: () => undefined } as DOMRect;
  }

  afterEach(() => { vi.restoreAllMocks(); });

  it('a marquee dragged over two separate strokes selects both of their groups', () => {
    const { renderer, board } = setup([]);
    renderer.enterPenMode();
    renderer.outer.dispatchEvent(pointer('pointerdown', 0, 0));
    document.dispatchEvent(pointer('pointerup', 20, 20));
    renderer.outer.dispatchEvent(pointer('pointerdown', 100, 100));
    document.dispatchEvent(pointer('pointerup', 120, 120));
    renderer.exitPenMode();
    expect(board.drawings).toHaveLength(2);
    const [s1, s2] = board.drawings;

    const rects = new Map<Element, DOMRect>([
      [renderer.outer, rect(0, 0, 800, 600)],
      [renderer.inkHitPaths.get(s1.id)!, rect(0, 0, 20, 20)],
      [renderer.inkHitPaths.get(s2.id)!, rect(100, 100, 20, 20)],
    ]);
    mockRectsFor(rects);

    renderer.outer.dispatchEvent(pointer('pointerdown', -10, -10));
    renderer.outer.dispatchEvent(pointer('pointermove', 150, 150));
    renderer.outer.dispatchEvent(pointer('pointerup', 150, 150));

    expect(renderer.selectedDrawingIds.size).toBe(2);
    expect(renderer.selectedDrawingIds.has(s1.groupId)).toBe(true);
    expect(renderer.selectedDrawingIds.has(s2.groupId)).toBe(true);
  });
});

describe('UI smoke: pen/marker strokes are undoable', () => {
  // undoSnapshot()/applyUndoSnapshot() used to only capture cards and
  // connections — every pushUndo() call scattered through the ink code
  // (draw, erase, drag, resize, recolor) was pushing a snapshot that
  // silently couldn't restore a drawing at all, so Ctrl+Z never touched
  // pen/highlighter strokes no matter what you'd just done to one.
  function drawStroke(renderer: FreeformRenderer, sx: number, sy: number, ex: number, ey: number) {
    renderer.outer.dispatchEvent(pointer('pointerdown', sx, sy));
    document.dispatchEvent(pointer('pointerup', ex, ey));
  }

  it('undo removes a just-drawn stroke', () => {
    const { renderer, board } = setup([]);
    renderer.enterPenMode();
    drawStroke(renderer, 0, 0, 20, 20);
    expect(board.drawings).toHaveLength(1);

    renderer.undo();

    expect(board.drawings).toHaveLength(0);
  });

  it('redo brings a just-undone stroke back', () => {
    const { renderer, board } = setup([]);
    renderer.enterPenMode();
    drawStroke(renderer, 0, 0, 20, 20);
    const drawn = board.drawings[0];

    renderer.undo();
    expect(board.drawings).toHaveLength(0);
    renderer.redo();

    expect(board.drawings).toHaveLength(1);
    expect(board.drawings[0].id).toBe(drawn.id);
  });

  it('undo only removes the most recently drawn stroke, one step at a time', () => {
    const { renderer, board } = setup([]);
    renderer.enterPenMode();
    drawStroke(renderer, 0, 0, 20, 20);
    drawStroke(renderer, 500, 500, 520, 520);
    expect(board.drawings).toHaveLength(2);

    renderer.undo();
    expect(board.drawings).toHaveLength(1);
    expect(board.drawings[0].points[0].x).toBeCloseTo(0, 5);

    renderer.undo();
    expect(board.drawings).toHaveLength(0);
  });

  it('undo restores a deleted drawing group', () => {
    const { renderer, board } = setup([]);
    renderer.enterPenMode();
    drawStroke(renderer, 0, 0, 20, 20);
    const [s1] = board.drawings;
    renderer.exitPenMode();

    renderer.selectedDrawingIds = new Set([s1.groupId]);
    renderer.deleteSelectedDrawing();
    expect(board.drawings).toHaveLength(0);

    renderer.undo();

    expect(board.drawings).toHaveLength(1);
    expect(board.drawings[0].groupId).toBe(s1.groupId);
  });

  it('undoing a drawing change does not revert unrelated card edits pushed earlier', () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 200, h: 120, text: 'hi', color: '#fff' };
    const { renderer, board } = setup([sticky]);
    renderer.pushUndo();
    (board.cards[0] as StickyCard).text = 'changed';

    renderer.enterPenMode();
    drawStroke(renderer, 0, 0, 20, 20);
    expect(board.drawings).toHaveLength(1);

    renderer.undo(); // undoes the stroke
    expect(board.drawings).toHaveLength(0);
    expect((board.cards[0] as StickyCard).text).toBe('changed'); // card edit untouched

    renderer.undo(); // undoes the card edit
    expect((board.cards[0] as StickyCard).text).toBe('hi');
  });
});

describe('UI smoke: undo/redo buttons (bottom-left, above the trash zone)', () => {
  // Cmd/Ctrl+Z alone is undiscoverable on iPad — drawing with Apple Pencil
  // means there's usually no keyboard in reach — so these buttons are the
  // only on-screen affordance for undo/redo.
  function click(el: HTMLElement) { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }

  it('both buttons start disabled on a fresh board (nothing to undo or redo yet)', () => {
    const { renderer } = setup([]);
    expect(renderer.undoBtnEl!.hasClass('is-disabled')).toBe(true);
    expect(renderer.redoBtnEl!.hasClass('is-disabled')).toBe(true);
  });

  it('undo enables after an edit, redo stays disabled', () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 200, h: 120, text: 'hi', color: '#fff' };
    const { renderer } = setup([sticky]);
    renderer.pushUndo();

    expect(renderer.undoBtnEl!.hasClass('is-disabled')).toBe(false);
    expect(renderer.redoBtnEl!.hasClass('is-disabled')).toBe(true);
  });

  it('clicking undo reverts the change and flips the enabled button to redo', () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 200, h: 120, text: 'hi', color: '#fff' };
    const { renderer, board } = setup([sticky]);
    renderer.pushUndo();
    (board.cards[0] as StickyCard).text = 'changed';

    click(renderer.undoBtnEl!);

    expect((board.cards[0] as StickyCard).text).toBe('hi');
    expect(renderer.undoBtnEl!.hasClass('is-disabled')).toBe(true);
    expect(renderer.redoBtnEl!.hasClass('is-disabled')).toBe(false);
  });

  it('clicking redo re-applies the change and flips back to undo', () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 200, h: 120, text: 'hi', color: '#fff' };
    const { renderer, board } = setup([sticky]);
    renderer.pushUndo();
    (board.cards[0] as StickyCard).text = 'changed';
    click(renderer.undoBtnEl!);

    click(renderer.redoBtnEl!);

    expect((board.cards[0] as StickyCard).text).toBe('changed');
    expect(renderer.undoBtnEl!.hasClass('is-disabled')).toBe(false);
    expect(renderer.redoBtnEl!.hasClass('is-disabled')).toBe(true);
  });

  it('clicking a disabled undo button is a no-op', () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 200, h: 120, text: 'hi', color: '#fff' };
    const { renderer, board } = setup([sticky]);

    click(renderer.undoBtnEl!); // nothing pushed yet — stack is empty

    expect((board.cards[0] as StickyCard).text).toBe('hi');
    expect(renderer.undoBtnEl!.hasClass('is-disabled')).toBe(true);
  });

  it('undoing a pen stroke via the button works the same as Ctrl+Z', () => {
    const { renderer, board } = setup([]);
    renderer.enterPenMode();
    renderer.outer.dispatchEvent(pointer('pointerdown', 0, 0));
    document.dispatchEvent(pointer('pointerup', 20, 20));
    expect(board.drawings).toHaveLength(1);

    click(renderer.undoBtnEl!);

    expect(board.drawings).toHaveLength(0);
  });
});

describe('UI smoke: Safari content-visibility workaround (iPad flicker/disappear fix)', () => {
  afterEach(() => { Platform.isSafari = false; Platform.isIosApp = false; });

  it('marks the container is-safari under Platform.isSafari, so the CSS override applies', () => {
    Platform.isSafari = true;
    const { container } = setup([]);
    expect(container.hasClass('is-safari')).toBe(true);
  });

  it('also marks the container is-safari under Platform.isIosApp — confirmed on-device that isSafari alone does not fire inside Obsidian\'s iPadOS app, even though it renders with the same WebKit engine', () => {
    Platform.isSafari = false;
    Platform.isIosApp = true;
    const { container } = setup([]);
    expect(container.hasClass('is-safari')).toBe(true);
  });

  it('does not mark the container is-safari on other platforms', () => {
    Platform.isSafari = false;
    Platform.isIosApp = false;
    const { container } = setup([]);
    expect(container.hasClass('is-safari')).toBe(false);
  });
});

describe('UI smoke: card background color palette follows the active theme', () => {
  // The background-color picker (context bar "Color" button) previously
  // offered the same pale pastels — near-white, pale yellow, pale pink…
  // regardless of theme, which glare rather than blend in sitting on a
  // dark canvas. Under dark theme it should now offer a muted, deep
  // counterpart instead — same idea as the accent/line palettes, which
  // are already fully saturated and don't need one.
  afterEach(() => { document.body.removeClass('theme-dark'); });

  function hexToRgb(hex: string): string {
    const n = parseInt(hex.slice(1), 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
  }

  function bgSwatchColors(): string[] {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const bar = new ContextBar(document.createElement('div'), container, () => null, () => document.body.hasClass('theme-dark'), () => {});
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'hi', color: '#fff' };
    bar.show(sticky, document.createElement('div'));
    const colorBtn = Array.from(container.querySelectorAll<HTMLElement>('.visual-notes-tb-btn'))
      .find(b => b.getAttribute('aria-label') === 'Color')!;
    colorBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return Array.from(container.querySelectorAll<HTMLElement>('.visual-notes-ctx-color-swatch'))
      .map(sw => sw.style.background)
      .filter(bg => bg.length > 0);
  }

  it('offers the light pastel palette outside dark theme', () => {
    document.body.removeClass('theme-dark');
    expect(bgSwatchColors()).toContain(hexToRgb('#FFFFFF'));
  });

  it('offers a muted dark-friendly palette instead under dark theme', () => {
    document.body.addClass('theme-dark');
    const colors = bgSwatchColors();
    expect(colors).not.toContain(hexToRgb('#FFFFFF'));
    expect(colors).not.toContain(hexToRgb('#FEF9C3')); // pale yellow
    expect(colors).toContain(hexToRgb('#1F2937')); // its muted dark counterpart
  });
});

describe('UI smoke: sticky context bar no longer shows the broken Bold/Italic/Underline/Strike buttons', () => {
  // They called this.activeStickyApplyTag?.(cmd), which was only ever set
  // while the sticky was already in text-edit mode (it applied to the
  // editor's current text selection) — selecting the card without entering
  // edit mode left it null, so the buttons silently did nothing.
  // TextFormatToolbar already covers the same commands (plus Color/
  // Highlight) the instant text is actually selected, so removed as
  // duplicated, broken functionality rather than trying to make them work
  // on a whole-card selection.
  it('only shows Edit, Bullet, Size, Font and Color for a sticky, not the old format buttons', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const bar = new ContextBar(document.createElement('div'), container, () => null, () => document.body.hasClass('theme-dark'), () => {});
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'hi', color: '#fff' };
    bar.show(sticky, document.createElement('div'));
    const labels = Array.from(container.querySelectorAll<HTMLElement>('.visual-notes-tb-btn'))
      .map(b => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Edit', 'Bullet', 'Size', 'Font', 'Color', 'Delete']);
  });

  it('the Bullet button suppresses the default pointerdown, so the caret survives the click', () => {
    // Without this the click blurs the editor, and the sticky's blur handler
    // commits and tears it down before the bullet can be applied — the
    // button would appear to do nothing.
    const container = document.createElement('div');
    document.body.appendChild(container);
    const bar = new ContextBar(document.createElement('div'), container, () => null, () => document.body.hasClass('theme-dark'), () => {});
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'hi', color: '#fff' };
    bar.show(sticky, document.createElement('div'));

    const bulletBtn = Array.from(container.querySelectorAll<HTMLElement>('.visual-notes-tb-btn'))
      .find(b => b.getAttribute('aria-label') === 'Bullet')!;
    const ev = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
    bulletBtn.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(true);
  });
});

describe('UI smoke: board light/dark appearance', () => {
  afterEach(() => { document.body.removeClass('theme-dark'); });

  it("tracks Obsidian's theme", () => {
    // Boards could once pin their own surface via a canvas toggle. That was
    // removed — two independent places to set appearance confused people — so
    // the theme is now the only input.
    document.body.addClass('theme-dark');
    const { renderer } = setup([]);
    expect(renderer.boardIsDark()).toBe(true);

    document.body.removeClass('theme-dark');
    expect(renderer.boardIsDark()).toBe(false);
  });

  it('offers swatches matching the theme', () => {
    // Pale pastels on a dark canvas are the glare the dark palette exists to
    // avoid.
    document.body.addClass('theme-dark');
    const { renderer } = setup([]);
    expect(resolveDefaultStickyColor(undefined, renderer.boardIsDark()))
      .toBe(STICKY_COLORS(true)[0].color);
  });

  it('no longer renders an appearance toggle on the canvas', () => {
    const { container } = setup([]);
    expect(container.querySelector('.visual-notes-theme-toggle-btn')).toBeNull();
  });

  it('gives the light/dark button no board-level appearance state to set', () => {
    // The bottom-right sun/moon button is NOT the removed per-board toggle
    // coming back. That one gave each board its own appearance, so a board
    // could disagree with Obsidian — the two-sources-of-truth problem above.
    // This one changes Obsidian's setting and stores nothing on the board,
    // so there is still exactly one place appearance lives. Asserting the
    // board stays untouched is what keeps the distinction real rather than
    // just a claim in a comment.
    const { container, board, renderer } = setup([]);
    const btn = container.querySelector<HTMLElement>('.visual-notes-appearance-btn');
    expect(btn).not.toBeNull();

    btn!.click();

    expect(board.appearance).toBeUndefined();
    expect(renderer.boardIsDark()).toBe(document.body.hasClass('theme-dark'));
  });

  it('follows the theme rather than the click', () => {
    // The icon is refreshed by the workspace's css-change event, never by
    // the click handler, so a click Obsidian ignores leaves the button
    // showing the truth instead of a switch that never happened.
    document.body.removeClass('theme-dark');
    const { container } = setup([]);
    const btn = container.querySelector<HTMLElement>('.visual-notes-appearance-btn')!;
    const before = btn.getAttribute('aria-label');
    expect(before).toBe('Switch Obsidian to dark mode');

    // The stub App exposes no command surface, so nothing can have changed.
    btn.click();

    expect(btn.getAttribute('aria-label')).toBe(before);
  });

  it('preserves a legacy pinned appearance through a canvas round trip', () => {
    // The value is no longer read, but a board written by an older version
    // must not have it silently stripped out of the user's file on save.
    const { board } = setup([]);
    board.appearance = 'dark';

    const round = canvasToVisualNotes(visualNotesToCanvas(board));

    expect(round.appearance).toBe('dark');
  });
});

describe('UI smoke: per-card text size (Note/Card)', () => {
  // textScale shipped as a declared field that was read on render but never
  // written by anything — no menu item, button, or command set it, so the
  // only way to reach it was hand-editing the .canvas JSON. These lock in
  // the control that finally drives it.
  it('sets the multiplier CSS var on the card element, not the inner text', () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'hi', color: '#fff', textScale: 'xl' };
    const { container } = setup([sticky]);
    const el = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="s1"]')!;

    // Must land on the card itself: --vn-text-mult is declared there, and
    // custom properties inherit their already-computed value, so an override
    // further down would never re-enter that calc.
    expect(el.style.getPropertyValue('--vn-card-text-scale')).toBe('1.7');
  });

  it('leaves the var unset when the card has no textScale, falling back to the global setting', () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'hi', color: '#fff' };
    const { container } = setup([sticky]);
    const el = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="s1"]')!;

    expect(el.style.getPropertyValue('--vn-card-text-scale')).toBe('');
  });

  it('the context bar size sub-panel emits the chosen step', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const events: unknown[] = [];
    const bar = new ContextBar(document.createElement('div'), container, () => null, () => document.body.hasClass('theme-dark'), e => events.push(e));
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'hi', color: '#fff' };
    bar.show(sticky, document.createElement('div'));

    Array.from(container.querySelectorAll<HTMLElement>('.visual-notes-tb-btn'))
      .find(b => b.getAttribute('aria-label') === 'Size')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const steps = Array.from(container.querySelectorAll<HTMLElement>('.visual-notes-ctx-size-btn'));
    expect(steps.map(b => b.textContent)).toEqual(['XS', 'S', 'M', 'L', 'XL', '2X', '3X', '4X']);

    steps.find(b => b.textContent === '4X')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(events).toEqual([{ type: 'sticky-text-scale', scale: 'huge' }]);
  });

  it('applies the scale to the live card and persists it through a canvas round trip', () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'hi', color: '#fff' };
    const { renderer, board, container } = setup([sticky]);
    const el = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="s1"]')!;

    renderer.selection.select('s1');
    renderer.handleCtxEvent({ type: 'sticky-text-scale', scale: 'lg' });

    expect((board.cards[0] as StickyCard).textScale).toBe('lg');
    expect(el.style.getPropertyValue('--vn-card-text-scale')).toBe('1.3');

    // stashable() keeps every non-positional card field under the `vn` key,
    // so this needs no canvas-format change — assert that rather than trust it.
    const round = canvasToVisualNotes(visualNotesToCanvas(board));
    expect((round.cards[0] as StickyCard).textScale).toBe('lg');
  });
});

describe('UI smoke: floating context bar positions above the selected card', () => {
  function rect(l: number, t: number, w: number, h: number): DOMRect {
    return { x: l, y: t, width: w, height: h, top: t, left: l, right: l + w, bottom: t + h, toJSON: () => undefined } as DOMRect;
  }
  // Stubs the element's own getBoundingClientRect (an own-property override
  // always wins over the prototype one, so this works regardless of
  // anything else touching Element.prototype elsewhere in this file).
  function stubRect(el: Element, r: DOMRect): void {
    (el as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => r;
  }
  // applyPosition reads the panel's own size from offsetWidth/offsetHeight
  // (matching TextFormatToolbar.position's approach), not getBoundingClientRect.
  function stubSize(el: HTMLElement, w: number, h: number): void {
    Object.defineProperty(el, 'offsetWidth', { value: w, configurable: true });
    Object.defineProperty(el, 'offsetHeight', { value: h, configurable: true });
  }
  // position() defers to the next animation frame (avoids a flash at a
  // stale spot) — reposition() (drag/resize/pan) doesn't, so only tests
  // exercising the initial show() need this.
  function nextFrame(): Promise<void> {
    return new Promise(r => window.requestAnimationFrame(() => r()));
  }

  afterEach(() => { Platform.isPhone = false; });

  it('creates the panel in the container, not inside the toolbar element', () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'hi', color: '#fff' };
    const { renderer, container } = setup([sticky]);
    renderer.selection.select('s1');
    renderer.refreshSelectionVisuals();
    const panel = container.querySelector('.visual-notes-ctx-bar-panel');
    expect(panel).toBeTruthy();
    expect(renderer.toolbarEl.contains(panel)).toBe(false);
  });

  it('positions above the card when there is room', async () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'hi', color: '#fff' };
    const { renderer, container } = setup([sticky]);
    const cardEl = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="s1"]')!;
    const panel = container.querySelector<HTMLElement>('.visual-notes-ctx-bar-panel')!;
    stubRect(container, rect(0, 0, 1000, 800));
    stubRect(cardEl, rect(400, 300, 240, 160));
    stubSize(panel, 200, 44);
    stubRect(renderer.trashZoneEl!, rect(-1000, -1000, 10, 10)); // far away — never overlaps
    renderer.selection.select('s1');
    renderer.refreshSelectionVisuals();
    await nextFrame();
    // Above the card: bottom edge sits at cardTop(300) - gap(8) = 292.
    expect(parseFloat(panel.style.top)).toBeCloseTo(292 - 44, 1);
  });

  it('flips below the card when there is no room above', async () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'hi', color: '#fff' };
    const { renderer, container } = setup([sticky]);
    const cardEl = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="s1"]')!;
    const panel = container.querySelector<HTMLElement>('.visual-notes-ctx-bar-panel')!;
    stubRect(container, rect(0, 0, 1000, 800));
    stubRect(cardEl, rect(400, 10, 240, 160)); // near the very top — no room above
    stubSize(panel, 200, 44);
    stubRect(renderer.trashZoneEl!, rect(-1000, -1000, 10, 10));
    renderer.selection.select('s1');
    renderer.refreshSelectionVisuals();
    await nextFrame();
    // Below the card: top edge sits at cardBottom(170) + gap(8) = 178.
    expect(parseFloat(panel.style.top)).toBeCloseTo(178, 1);
  });

  it('reposition() re-measures the current card and updates the panel (what drag/resize/pan hook into)', async () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'hi', color: '#fff' };
    const { renderer, container } = setup([sticky]);
    const cardEl = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="s1"]')!;
    const panel = container.querySelector<HTMLElement>('.visual-notes-ctx-bar-panel')!;
    stubRect(container, rect(0, 0, 1000, 800));
    stubRect(cardEl, rect(400, 300, 240, 160));
    stubSize(panel, 200, 44);
    stubRect(renderer.trashZoneEl!, rect(-1000, -1000, 10, 10));
    renderer.selection.select('s1');
    renderer.refreshSelectionVisuals();
    await nextFrame();

    stubRect(cardEl, rect(600, 500, 240, 160)); // card "moved" (drag/pan/resize)
    renderer.contextBar.reposition();
    expect(parseFloat(panel.style.top)).toBeCloseTo(500 - 8 - 44, 1);
    expect(parseFloat(panel.style.left)).toBeCloseTo(600 + 240 / 2 - 200 / 2, 1);
  });

  it('dragging a selected card keeps the floating bar aligned with it', () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'hi', color: '#fff' };
    const { renderer, container } = setup([sticky]);
    const cardEl = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="s1"]')!;
    stubRect(container, rect(0, 0, 1000, 800));
    stubRect(cardEl, rect(0, 300, 240, 160));
    const spyReposition = vi.spyOn(renderer.contextBar, 'reposition');
    renderer.selection.select('s1');
    renderer.refreshSelectionVisuals();

    cardEl.dispatchEvent(pointer('pointerdown', 50, 350));
    cardEl.dispatchEvent(pointer('pointermove', 90, 390)); // past DRAG_THRESHOLD
    cardEl.dispatchEvent(pointer('pointerup', 90, 390)); // onUp flushes any pending rAF frame synchronously

    expect(spyReposition).toHaveBeenCalled();
  });

  it('panning the canvas repositions the shown context bar', () => {
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'hi', color: '#fff' };
    const { renderer, container } = setup([sticky]);
    const cardEl = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="s1"]')!;
    stubRect(container, rect(0, 0, 1000, 800));
    stubRect(cardEl, rect(400, 300, 240, 160));
    renderer.selection.select('s1');
    renderer.refreshSelectionVisuals();
    const spyReposition = vi.spyOn(renderer.contextBar, 'reposition');

    renderer.vp = { ...renderer.vp, x: renderer.vp.x - 50, y: renderer.vp.y - 50 };
    renderer.applyViewport();

    expect(spyReposition).toHaveBeenCalled();
  });

  it('falls back to the original docked toolbar behavior on phone, with no floating panel', () => {
    Platform.isPhone = true;
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 240, h: 160, text: 'hi', color: '#fff' };
    const { renderer, container } = setup([sticky]);
    renderer.selection.select('s1');
    renderer.refreshSelectionVisuals();
    expect(container.querySelector('.visual-notes-ctx-bar-panel')).toBeNull();
    expect(renderer.toolbarEl.hasClass('visual-notes-ctx-active')).toBe(true);
  });
});

describe('UI smoke: saved default sticky color re-maps to the active theme', () => {
  // A "default sticky color" saved from a past light-theme pick is a literal
  // hex (e.g. the bright yellow swatch) baked into settings. Naively
  // falling back to that stored hex under dark theme would keep new sticky
  // notes stuck bright forever, defeating the theme-aware palette entirely.
  afterEach(() => { document.body.removeClass('theme-dark'); });

  it('keeps the light swatch verbatim outside dark theme', () => {
    document.body.removeClass('theme-dark');
    expect(resolveDefaultStickyColor('#FDE68A')).toBe('#FDE68A');
  });

  it('re-maps a saved light-theme default to its dark counterpart', () => {
    document.body.addClass('theme-dark');
    expect(resolveDefaultStickyColor('#FDE68A')).toBe('#78350F');
  });

  it('falls back to the theme palette default when nothing is saved', () => {
    document.body.addClass('theme-dark');
    expect(resolveDefaultStickyColor(undefined)).toBe(STICKY_COLORS()[0].color);
  });
});

describe('UI smoke: pen size/color picker floats beside the toolbar instead of growing it', () => {
  // Reported: at 1920×1080 the picker's width/color rows ran under the
  // bottom-left trash zone, because the picker used to be an in-flow child
  // of the toolbar — a vertically-centered element (top: 50%;
  // translateY(-50%)), so growing it to fit the picker pushed its bottom
  // edge further down the screen every time Pen mode opened.
  function mockRectsFor(rects: Map<Element, DOMRect>) {
    return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return rects.get(this) ?? ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => undefined } as DOMRect);
    });
  }
  function rect(l: number, t: number, w: number, h: number): DOMRect {
    return { x: l, y: t, width: w, height: h, top: t, left: l, right: l + w, bottom: t + h, toJSON: () => undefined } as DOMRect;
  }

  afterEach(() => { vi.restoreAllMocks(); });

  it('the picker is not appended inside the toolbar element', () => {
    const { renderer } = setup([]);
    renderer.enterPenMode();
    expect(renderer.penColorPicker).not.toBeNull();
    expect(renderer.toolbarEl.contains(renderer.penColorPicker!)).toBe(false);
    expect(renderer.container.contains(renderer.penColorPicker!)).toBe(true);
  });

  it('entering Pen mode does not change the toolbar element\'s own children', () => {
    const { renderer } = setup([]);
    const before = renderer.toolbarEl.childElementCount;
    renderer.enterPenMode();
    expect(renderer.toolbarEl.childElementCount).toBe(before);
  });

  it('defaults pen thickness to Medium', () => {
    const { renderer } = setup([]);
    expect(renderer.currentInkWidth).toBe(4);
    renderer.enterPenMode();
    const mediumBtn = Array.from(renderer.penColorPicker!.querySelectorAll<HTMLElement>('.visual-notes-pen-width-btn'))
      .find(b => b.textContent === 'Medium')!;
    expect(mediumBtn.classList.contains('is-selected')).toBe(true);
  });

  it('moves the picker above the trash zone when the anchored position would overlap it', () => {
    const { renderer } = setup([]);
    renderer.enterPenMode();
    const picker = renderer.penColorPicker!;
    const anchor = renderer.penToolBtn!;
    const trash = renderer.trashZoneEl!;

    // A tall container (2000px) so the picker's anchored position doesn't
    // need any generic edge-clamping on its own (900 is well within
    // [8, 2000-8-110]) — isolates the trash-specific nudge from the
    // generic clamp, which would otherwise mask a missing nudge by
    // coincidentally also pulling the picker clear in a shorter container.
    const rects = new Map<Element, DOMRect>([
      [renderer.container, rect(0, 0, 1920, 2000)],
      [anchor, rect(20, 900, 56, 40)],
      [picker, rect(20, 900, 180, 110)], // anchored beside it, overlapping the trash row below
      [trash, rect(16, 950, 56, 100)], // deliberately overlaps the picker's own rect
    ]);
    mockRectsFor(rects);

    (renderer as any).positionPenPicker();

    const pickerTop = parseFloat(picker.style.top || '0');
    const pickerHeight = 110; // matches the mocked picker rect above
    const trashTopRelative = 950; // trash.top - container.top
    // No longer overlapping vertically — the picker's bottom edge must
    // clear the trash zone's top edge, not just its own top corner (which
    // stayed "above" the trash's top the whole time even while the two
    // rects overlapped, so it can't tell a real fix from a no-op nudge).
    expect(pickerTop + pickerHeight).toBeLessThanOrEqual(trashTopRelative);
  });
});

describe('UI smoke: PenOptionsPanel (draggable perfect-freehand tuning)', () => {
  function makePanel(overrides: Partial<PenDrawOptions> = {}) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const anchor = document.createElement('div');
    container.appendChild(anchor);
    const options: PenDrawOptions = { ...DEFAULT_PEN_DRAW_OPTIONS, ...overrides };
    const onLiveChange = vi.fn();
    const onCommit = vi.fn();
    const panel = new PenOptionsPanel(container, options, onLiveChange, onCommit);
    return { container, anchor, options, onLiveChange, onCommit, panel };
  }

  it('show() builds one row per control plus a draggable header', () => {
    const { container, anchor, panel } = makePanel();
    panel.show(anchor);
    const el = container.querySelector('.visual-notes-pen-options-panel')!;
    expect(el).toBeTruthy();
    // size, thinning, streamline, smoothing, taper start, taper end
    expect(el.querySelectorAll('.visual-notes-pen-options-slider')).toHaveLength(6);
    expect(el.querySelectorAll('.visual-notes-pen-options-toggle')).toHaveLength(2); // cap start/end
    expect(el.querySelector('.visual-notes-pen-options-select')).toBeTruthy(); // easing
    expect(el.querySelector('.visual-notes-pen-options-header.is-draggable')).toBeTruthy();
  });

  it('toggle() opens then closes the panel', () => {
    const { container, anchor, panel } = makePanel();
    expect(panel.isOpen()).toBe(false);
    panel.toggle(anchor);
    expect(panel.isOpen()).toBe(true);
    expect(container.querySelector('.visual-notes-pen-options-panel')).toBeTruthy();
    panel.toggle(anchor);
    expect(panel.isOpen()).toBe(false);
    expect(container.querySelector('.visual-notes-pen-options-panel')).toBeNull();
  });

  it('moving a slider updates the shared options object live, without committing until release', () => {
    const { container, anchor, options, onLiveChange, onCommit, panel } = makePanel();
    panel.show(anchor);
    const sizeSlider = container.querySelectorAll<HTMLInputElement>('.visual-notes-pen-options-slider')[0];
    sizeSlider.value = '40';
    sizeSlider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(options.size).toBe(40);
    expect(onLiveChange).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
    sizeSlider.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('clicking a cap toggle flips the boolean and commits immediately', () => {
    const { container, anchor, options, onLiveChange, onCommit, panel } = makePanel();
    panel.show(anchor);
    const capStartToggle = container.querySelectorAll<HTMLElement>('.visual-notes-pen-options-toggle')[0];
    expect(options.capStart).toBe(true);
    capStartToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(options.capStart).toBe(false);
    expect(onLiveChange).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('changing the easing dropdown updates options.easing and commits', () => {
    const { container, anchor, options, onCommit, panel } = makePanel();
    panel.show(anchor);
    const select = container.querySelector<HTMLSelectElement>('.visual-notes-pen-options-select')!;
    select.value = 'easeOut';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(options.easing).toBe('easeOut');
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('Reset restores every value to the defaults and commits', () => {
    const { container, anchor, options, onCommit, panel } = makePanel({ size: 40, thinning: -0.5, capStart: false });
    panel.show(anchor);
    const resetBtn = container.querySelector<HTMLElement>('.visual-notes-pen-options-reset')!;
    resetBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(options).toEqual(DEFAULT_PEN_DRAW_OPTIONS);
    expect(onCommit).toHaveBeenCalled();
  });

  it('the close button hides the panel', () => {
    const { container, anchor, panel } = makePanel();
    panel.show(anchor);
    const closeBtn = container.querySelector<HTMLElement>('.visual-notes-pen-options-close')!;
    closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(panel.isOpen()).toBe(false);
    expect(container.querySelector('.visual-notes-pen-options-panel')).toBeNull();
  });

  it('dragging the header by its pointer moves the panel within the container', () => {
    function mockRect(l: number, t: number, w: number, h: number): DOMRect {
      return { x: l, y: t, width: w, height: h, top: t, left: l, right: l + w, bottom: t + h, toJSON: () => undefined } as DOMRect;
    }
    const rects = new Map<Element, DOMRect>();
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return rects.get(this) ?? mockRect(0, 0, 0, 0);
    });
    const { container, anchor, panel } = makePanel();
    rects.set(container, mockRect(0, 0, 800, 600));
    rects.set(anchor, mockRect(10, 10, 20, 20));
    panel.show(anchor);
    const el = container.querySelector<HTMLElement>('.visual-notes-pen-options-panel')!;
    rects.set(el, mockRect(50, 50, 240, 200));
    const header = container.querySelector<HTMLElement>('.visual-notes-pen-options-header')!;

    header.dispatchEvent(pointer('pointerdown', 60, 60)); // 10px into the panel from its (50,50) corner
    document.dispatchEvent(pointer('pointermove', 160, 160)); // +100, +100
    document.dispatchEvent(pointer('pointerup', 160, 160));

    expect(el.style.left).toBe('150px');
    expect(el.style.top).toBe('150px');
    spy.mockRestore();
  });
});

describe('UI smoke: pen options gear icon integrates with the pen picker and rendering', () => {
  it('the gear icon only appears when the Pen tool (not Highlighter/Eraser) is selected', () => {
    const { renderer, container } = setup([]);
    renderer.enterPenMode();
    expect(container.querySelector('.visual-notes-pen-options-gear')).toBeTruthy();

    const highlighterBtn = Array.from(container.querySelectorAll<HTMLElement>('.visual-notes-pen-tool-btn'))
      .find(b => b.getAttribute('aria-label') === 'Highlighter')!;
    highlighterBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(container.querySelector('.visual-notes-pen-options-gear')).toBeNull();

    const eraserBtn = Array.from(container.querySelectorAll<HTMLElement>('.visual-notes-pen-tool-btn'))
      .find(b => b.getAttribute('aria-label') === 'Eraser')!;
    eraserBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(container.querySelector('.visual-notes-pen-options-gear')).toBeNull();
  });

  it('clicking the gear icon opens the pen options panel', () => {
    const { renderer, container } = setup([]);
    renderer.enterPenMode();
    const gearBtn = container.querySelector<HTMLElement>('.visual-notes-pen-options-gear')!;
    gearBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(renderer.penOptionsPanel?.isOpen()).toBe(true);
    expect(container.querySelector('.visual-notes-pen-options-panel')).toBeTruthy();
  });

  it('exiting Pen mode closes the options panel', () => {
    const { renderer, container } = setup([]);
    renderer.enterPenMode();
    const gearBtn = container.querySelector<HTMLElement>('.visual-notes-pen-options-gear')!;
    gearBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(renderer.penOptionsPanel?.isOpen()).toBe(true);
    renderer.exitPenMode();
    expect(renderer.penOptionsPanel?.isOpen()).toBe(false);
  });

  it('buildPenOutlineD reflects a live change to penDrawOptions.size', () => {
    const { renderer } = setup([]);
    const points = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }];
    const stroke: DrawingStroke = { id: 's', groupId: 'g', points, color: '#000', width: 4 };
    const before = renderer.buildPenOutlineD(stroke);
    renderer.penDrawOptions.size = 40;
    const after = renderer.buildPenOutlineD(stroke);
    expect(after).not.toBe(before);
  });
});

describe('UI smoke: "Save as template" moved out of the header into the "…" menu', () => {
  it('the toolbar overflow menu includes a Save as template item', () => {
    const { renderer, container } = setup([]);
    // The anchor only affects the popup's on-screen position, not its
    // contents — any element works here.
    (renderer as any).toggleOverflow(renderer.toolbarEl);
    const items = Array.from(container.querySelectorAll('.visual-notes-tb-overflow-item')).map(el => el.textContent);
    expect(items.some(t => t?.includes('Save as template'))).toBe(true);
  });
});

describe('UI smoke: calendar month/year jump and lock', () => {
  function calEl(container: HTMLElement, id: string): HTMLElement {
    return container.querySelector<HTMLElement>(`.visual-notes-freeform-card[data-id="${id}"]`)!;
  }
  function navBtn(el: HTMLElement, label: string): HTMLElement {
    return Array.from(el.querySelectorAll<HTMLElement>('.visual-notes-dataview-nav [aria-label]'))
      .find(b => b.getAttribute('aria-label') === label)!;
  }

  it('clicking the month label opens a month input seeded with the current anchor', () => {
    const cal: CalendarCard = { id: 'c1', kind: 'calendar', x: 0, y: 0, w: 460, h: 420, anchor: '2007-06-15' };
    const { container } = setup([cal]);
    const el = calEl(container, 'c1');
    const label = el.querySelector<HTMLElement>('.visual-notes-calendar-month-label')!;
    expect(label.hasClass('is-clickable')).toBe(true);

    label.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const input = el.querySelector<HTMLInputElement>('input.visual-notes-calendar-month-input')!;
    expect(input).not.toBeNull();
    expect(input.type).toBe('month');
    expect(input.value).toBe('2007-06');
  });

  it('committing a typed month/year jumps the anchor to the 1st of that month', () => {
    const cal: CalendarCard = { id: 'c1', kind: 'calendar', x: 0, y: 0, w: 460, h: 420, anchor: '2007-06-15' };
    const { board, container } = setup([cal]);
    const el = calEl(container, 'c1');
    el.querySelector<HTMLElement>('.visual-notes-calendar-month-label')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const input = el.querySelector<HTMLInputElement>('input.visual-notes-calendar-month-input')!;
    input.value = '1998-12';
    input.dispatchEvent(new Event('blur'));

    const saved = board.cards.find(c => c.id === 'c1') as CalendarCard;
    expect(saved.anchor).toBe('1998-12-01');
    expect(calEl(container, 'c1').querySelector('.visual-notes-calendar-month-label')!.textContent)
      .toContain('1998');
  });

  it('Escape cancels the month jump without changing the anchor', () => {
    const cal: CalendarCard = { id: 'c1', kind: 'calendar', x: 0, y: 0, w: 460, h: 420, anchor: '2007-06-15' };
    const { board, container } = setup([cal]);
    const el = calEl(container, 'c1');
    el.querySelector<HTMLElement>('.visual-notes-calendar-month-label')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const input = el.querySelector<HTMLInputElement>('input.visual-notes-calendar-month-input')!;
    input.value = '1998-12';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    const saved = board.cards.find(c => c.id === 'c1') as CalendarCard;
    expect(saved.anchor).toBe('2007-06-15');
    expect(calEl(container, 'c1').querySelector('input.visual-notes-calendar-month-input')).toBeNull();
  });

  it('the canvas right-click "Add" menu includes Calendar, wired to addCalendarAt', () => {
    const { renderer } = setup([]);
    let captured: InstanceType<typeof Menu> | null = null;
    vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (this: InstanceType<typeof Menu>) {
      captured = this;
    });
    const addSpy = vi.spyOn(renderer, 'addCalendarAt');

    renderer.outer.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    const menu = captured!;
    // Item order: Write(label)+5, Media & links(label)+6, Organize(label)+
    // Tile/Kanban board/Column/Group frame/Swatch/Checkers/Calendar — Calendar
    // is the 7th Organize entry, index 20 overall. The MenuItemStub doesn't
    // retain title text, so this asserts the click actually reaches
    // addCalendarAt rather than checking a label.
    expect(menu.items.length).toBeGreaterThan(20);
    (menu.items[20] as any).__trigger();
    expect(addSpy).toHaveBeenCalledTimes(1);
  });

  it('Previous/Today/Next and the month label are inert while locked, and unlocking restores them', () => {
    const cal: CalendarCard = { id: 'c1', kind: 'calendar', x: 0, y: 0, w: 460, h: 420, anchor: '2007-06-15', anchorLocked: true };
    const { board, container } = setup([cal]);
    let el = calEl(container, 'c1');

    const label = el.querySelector<HTMLElement>('.visual-notes-calendar-month-label')!;
    expect(label.hasClass('is-locked')).toBe(true);
    expect(label.hasClass('is-clickable')).toBe(false);
    label.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(el.querySelector('input.visual-notes-calendar-month-input')).toBeNull();

    navBtn(el, 'Previous').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    navBtn(el, 'Next').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const todayBtn = Array.from(el.querySelectorAll<HTMLElement>('.visual-notes-dataview-btn-text'))
      .find(b => b.textContent === 'Today')!;
    todayBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    let saved = board.cards.find(c => c.id === 'c1') as CalendarCard;
    expect(saved.anchor).toBe('2007-06-15');

    navBtn(el, 'Unlock month/year').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    saved = board.cards.find(c => c.id === 'c1') as CalendarCard;
    expect(saved.anchorLocked).toBe(false);

    el = calEl(container, 'c1');
    navBtn(el, 'Next').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    saved = board.cards.find(c => c.id === 'c1') as CalendarCard;
    expect(saved.anchor).not.toBe('2007-06-15');
  });
});

describe('UI smoke: YouTube embed play/pause (pointer-capture regression)', () => {
  // Reported by a user: the overlay's tooltip promised "Click to play", but a
  // plain click did nothing — only Shift-click started the video.
  //
  // Cause: bindDelegatedCardEvents calls el.setPointerCapture() on the card to
  // drive dragging, and pointer capture retargets the rest of that gesture —
  // the compatibility `click` included — at the capturing element. A click
  // listener on the overlay (a descendant) therefore never fired. The Shift
  // branch returns before capture is taken, which is exactly why Shift-click
  // was the one thing that worked.
  //
  // These tests drive pointerdown/pointerup only and never dispatch a click,
  // so they fail against any implementation that depends on one.
  const ytCard = (): BookmarkCard => ({
    id: 'yt1', kind: 'bookmark', x: 0, y: 0, w: 400, h: 240,
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  });

  // Commands the plugin sent to the player, oldest first. Filters out the
  // `listening` handshake, which is sent at render and isn't a command.
  function commandsSentTo(el: HTMLElement): string[] {
    const iframe = el.querySelector<HTMLIFrameElement>('.visual-notes-bookmark-youtube-iframe')!;
    const spy = (iframe.contentWindow!.postMessage as unknown as { mock?: { calls: unknown[][] } }).mock;
    return (spy?.calls ?? [])
      .map(c => { try { return JSON.parse(String(c[0])) as { event?: string; func?: string }; } catch { return {}; } })
      .filter(m => m.event === 'command')
      .map(m => m.func!)
      ;
  }

  function setupYt() {
    const ctx = setup([ytCard()]);
    const el = ctx.container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="yt1"]')!;
    const iframe = el.querySelector<HTMLIFrameElement>('.visual-notes-bookmark-youtube-iframe')!;
    vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {});
    const overlay = el.querySelector<HTMLElement>('.visual-notes-bookmark-youtube-overlay')!;
    return { ...ctx, el, overlay };
  }

  const press = (el: HTMLElement, overlay: HTMLElement) => {
    overlay.dispatchEvent(pointer('pointerdown', 50, 50));
    el.dispatchEvent(pointer('pointerup', 50, 50, { buttons: 0 }));
  };

  it('renders a live embed with a drag overlay for a YouTube URL', () => {
    const { el } = setupYt();
    expect(el.classList.contains('is-youtube-embed')).toBe(true);
    expect(el.querySelector('.visual-notes-bookmark-youtube-overlay')).toBeTruthy();
    expect(el.querySelector('.visual-notes-bookmark-youtube-iframe')).toBeTruthy();
  });

  it('a press that is not a drag plays the video — with no click event', () => {
    const { el, overlay } = setupYt();
    press(el, overlay);
    expect(commandsSentTo(el)).toEqual(['playVideo']);
  });

  it('does not need Shift held — the plain press is enough', () => {
    const { el, overlay } = setupYt();
    overlay.dispatchEvent(pointer('pointerdown', 50, 50, { shiftKey: false }));
    el.dispatchEvent(pointer('pointerup', 50, 50, { buttons: 0 }));
    expect(commandsSentTo(el)).toEqual(['playVideo']);
  });

  it('pressing again pauses, and again plays — one click each way', () => {
    const { el, overlay } = setupYt();
    press(el, overlay);
    press(el, overlay);
    press(el, overlay);
    expect(commandsSentTo(el)).toEqual(['playVideo', 'pauseVideo', 'playVideo']);
  });

  it('keeps the overlay on top after playing, so the card stays draggable', () => {
    // The whole point of driving playback through the API rather than
    // punching through: body-drag and canvas zoom keep working, and pausing
    // later costs one click rather than two.
    const { el, overlay, board } = setupYt();
    press(el, overlay);
    expect(el.classList.contains('is-embed-interactive')).toBe(false);

    overlay.dispatchEvent(pointer('pointerdown', 50, 50));
    el.dispatchEvent(pointer('pointermove', 140, 140));
    el.dispatchEvent(pointer('pointerup', 140, 140, { buttons: 0 }));
    expect(board.cards[0].x).not.toBe(0);
  });

  it('dragging the overlay moves the card instead of touching playback', () => {
    const { el, overlay, board } = setupYt();
    overlay.dispatchEvent(pointer('pointerdown', 50, 50));
    el.dispatchEvent(pointer('pointermove', 140, 140)); // past the drag threshold
    el.dispatchEvent(pointer('pointerup', 140, 140, { buttons: 0 }));

    expect(commandsSentTo(el)).toEqual([]);
    expect(board.cards[0].x).not.toBe(0);
  });

  it('a press elsewhere on the card does not touch playback', () => {
    const { el } = setupYt();
    el.dispatchEvent(pointer('pointerdown', 50, 50));
    el.dispatchEvent(pointer('pointerup', 50, 50, { buttons: 0 }));
    expect(commandsSentTo(el)).toEqual([]);
  });

  it('the controls button hands over to YouTube\'s own UI', () => {
    const { el } = setupYt();
    const btn = el.querySelector<HTMLElement>('.visual-notes-bookmark-youtube-controls-btn')!;
    expect(btn).toBeTruthy();
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(el.classList.contains('is-embed-interactive')).toBe(true);
  });

  it('while YouTube\'s own UI is exposed, presses are left to the player', () => {
    const { el, overlay } = setupYt();
    const btn = el.querySelector<HTMLElement>('.visual-notes-bookmark-youtube-controls-btn')!;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    press(el, overlay);
    expect(commandsSentTo(el)).toEqual([]);
  });
});

// Video cards, from an enhancement request: dragging a video onto a board gave
// a file card you had to open elsewhere, where Obsidian's own Canvas embeds a
// player you can scrub in place.
describe('UI smoke: video cards', () => {
  const CLIP = '_Assets/Video/clip.mp4';

  function withVideo(path = CLIP) {
    const vault = new FakeVault();
    vault.putText(path, 'not really binary, but enough to exist');
    const card = { id: 'v1', kind: 'video', x: 0, y: 0, w: 320, h: 180,
      source: { type: 'vault', path } } as unknown as Card;
    return { ...setup([card], [], 'bottom-right', vault), card };
  }

  // isDropAccepted runs on dragover, and returning false means preventDefault
  // is never called — at which point the browser refuses the drag outright and
  // fires no drop event at all. So an extension missing from this list makes
  // the matching branch in the drop handler unreachable, not merely unused.
  //
  // Video was added to the drop handler in 1.1.27 and missed here, so dragging
  // a video from the sidebar did nothing for three releases while the same
  // file dropped from the OS worked — an OS drag matches the 'Files' check
  // first and never reaches this list. Reported exactly that way.
  describe('the dragover gate', () => {
    function accepts(path: string): boolean {
      const vault = new FakeVault();
      const file = vault.putText(path, 'x');
      const { renderer } = setup([], [], 'bottom-right', vault);
      (renderer.app as unknown as { dragManager: unknown }).dragManager = {
        draggable: { type: 'file', file },
      };
      return renderer.isDropAccepted({ dataTransfer: { types: [] } } as unknown as DragEvent);
    }

    it.each(['clip.mp4', 'clip.webm', 'clip.mov', 'clip.m4v', 'clip.mkv', 'clip.avi', 'clip.ogv'])(
      'permits %s, so the drop handler can build a video card', (name) => {
        expect(accepts(name)).toBe(true);
      });

    it('still permits the kinds it always did', () => {
      expect(accepts('pic.png')).toBe(true);
      expect(accepts('song.mp3')).toBe(true);
      expect(accepts('note.md')).toBe(true);
      expect(accepts('board.canvas')).toBe(true);
    });

    it('still refuses what it has no card for', () => {
      expect(accepts('archive.zip')).toBe(false);
    });
  });

  describe('formatVideoTime', () => {
    it('reads as m:ss, padding the seconds', () => {
      expect(formatVideoTime(0)).toBe('0:00');
      expect(formatVideoTime(9)).toBe('0:09');
      expect(formatVideoTime(83)).toBe('1:23');
      expect(formatVideoTime(599)).toBe('9:59');
    });

    it('grows an hours field only once there are hours', () => {
      expect(formatVideoTime(3600)).toBe('1:00:00');
      expect(formatVideoTime(3661)).toBe('1:01:01');
      expect(formatVideoTime(3599)).toBe('59:59');
    });

    it('survives the duration a <video> reports before its metadata lands', () => {
      // NaN until loadedmetadata, and Infinity for a stream — both would
      // otherwise render as "NaN:NaN" on a card that has just appeared.
      expect(formatVideoTime(NaN)).toBe('0:00');
      expect(formatVideoTime(Infinity)).toBe('0:00');
      expect(formatVideoTime(-1)).toBe('0:00');
    });
  });

  it('renders a real player, not an icon', () => {
    const { container } = withVideo();
    const video = container.querySelector<HTMLVideoElement>('video.visual-notes-video-player');

    expect(video).not.toBeNull();
    expect(video!.getAttribute('src')).toBe(`fake-resource://${CLIP}`);
  });

  it('uses our own controls, not the browser\'s', () => {
    // Chromium's live in a closed shadow root, so no code here can tell
    // whether a press landed on them. That is what made the card drag and the
    // controls fight over the same gesture through 1.1.27, .28 and .29.
    const { container } = withVideo();
    expect(container.querySelector<HTMLVideoElement>('video')!.controls).toBe(false);
    expect(container.querySelector('.visual-notes-video-controls')).not.toBeNull();
    expect(container.querySelectorAll('.visual-notes-video-btn').length).toBe(3);
    expect(container.querySelector('.visual-notes-video-scrub')).not.toBeNull();
  });

  it('keeps focus off the video, so the board keeps its keyboard', () => {
    // A focused <video> eats space and the arrow keys for its own play/seek,
    // which is half of "the space bar stops working randomly".
    const { container } = withVideo();
    expect(container.querySelector('video')!.getAttribute('tabindex')).toBe('-1');
  });

  it('loads only metadata, so a board of clips does not read them all off disk', () => {
    const { container } = withVideo();
    expect(container.querySelector<HTMLVideoElement>('video')!.preload).toBe('metadata');
  });

  it('does not autoplay', () => {
    // Twenty moodboard cards playing at once is not a feature.
    expect(withVideo().container.querySelector<HTMLVideoElement>('video')!.autoplay).toBe(false);
  });

  // Two attempts to split a video card between "controls" and "picture" both
  // failed, because the browser draws the controls in a shadow root that can't
  // be hit-tested and whose height changes with the video's width — Chromium
  // uses two rows on a narrow clip, which is what a phone video is. Reported
  // as the player showing but not playing.
  //
  // There is no split any more. A press on a video is left completely alone
  // until it moves, so whatever it landed on receives it; only movement past
  // the threshold turns it into a drag. These pin that, because the failure
  // mode is a card that looks right and does nothing.
  function pressVideo(container: HTMLElement) {
    const cardEl = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="v1"]')!;
    const video = container.querySelector<HTMLElement>('video')!;
    const captured = vi.fn();
    cardEl.setPointerCapture = captured;
    const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 50, clientY: 50, buttons: 1 });
    video.dispatchEvent(down);
    return { cardEl, video, down, captured };
  }

  it('does not swallow a press on the video, so the controls get it', () => {
    // preventDefault would suppress the compatibility mouse events the
    // browser's own play/scrub/volume/fullscreen controls run on. This is the
    // whole bug: the player rendered, and nothing on it responded.
    const { down } = pressVideo(withVideo().container);
    expect(down.defaultPrevented).toBe(false);
  });

  it('does not capture the pointer until the press actually moves', () => {
    // Capture retargets every later pointer event at the card, so the controls
    // would never see the release however the press was classified.
    const { captured } = pressVideo(withVideo().container);
    expect(captured).not.toHaveBeenCalled();
  });

  it('captures and drags once the press moves past the threshold', () => {
    const { cardEl, captured } = pressVideo(withVideo().container);
    cardEl.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 200, clientY: 200, buttons: 1 }));

    expect(captured).toHaveBeenCalled();
  });

  // The report that finally identified the cause: the controls worked with a
  // mouse and did nothing on a trackpad. A trackpad click carries a few px of
  // travel between press and release, which crosses DRAG_THRESHOLD; the card
  // then takes pointer capture, every later event retargets to it, and the
  // control never sees the release. No threshold fixes that — jitter has no
  // upper bound. Controls we own do, because their pointerdown never reaches
  // the canvas at all.
  it('never starts a card drag from a press on the controls, however shaky', () => {
    const { container } = withVideo();
    const cardEl = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="v1"]')!;
    const captured = vi.fn();
    cardEl.setPointerCapture = captured;
    const playBtn = container.querySelector<HTMLElement>('.visual-notes-video-btn')!;

    playBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 50, clientY: 50, buttons: 1 }));
    // Far past the 5px threshold — a deliberate drag, let alone a wobble.
    cardEl.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 400, clientY: 400, buttons: 1 }));

    expect(captured).not.toHaveBeenCalled();
  });

  it('plays and pauses from the play button', () => {
    const { container } = withVideo();
    const video = container.querySelector<HTMLVideoElement>('video')!;
    // jsdom implements neither, and both are what the button is for.
    const play = vi.fn(() => Promise.resolve());
    const pause = vi.fn();
    video.play = play; video.pause = pause;
    const playBtn = container.querySelector<HTMLElement>('.visual-notes-video-btn')!;

    Object.defineProperty(video, 'paused', { value: true, configurable: true });
    playBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(play).toHaveBeenCalled();

    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    playBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(pause).toHaveBeenCalled();
  });

  it('still plays from a click on the video body', () => {
    // Kept from the native-controls behaviour: this is what the reporter had
    // to fall back on while the buttons were dead, and removing it now would
    // read as another regression.
    const { container } = withVideo();
    const video = container.querySelector<HTMLVideoElement>('video')!;
    const play = vi.fn(() => Promise.resolve());
    video.play = play; video.pause = vi.fn();
    Object.defineProperty(video, 'paused', { value: true, configurable: true });

    video.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(play).toHaveBeenCalled();
  });

  it('still moves the card when dragged by its video', () => {
    // The regression that started all of this: the video covers nearly the
    // whole card, so if it can't be dragged by the picture it can't be moved.
    const { renderer, board, container } = withVideo();
    renderer.selection.select('v1');
    const cardEl = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="v1"]')!;
    const video = container.querySelector<HTMLElement>('video')!;
    const before = board.cards[0].x ?? 0;

    video.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 0, clientY: 0, buttons: 1 }));
    cardEl.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 120, clientY: 0, buttons: 1 }));
    cardEl.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 120, clientY: 0, buttons: 0 }));

    expect(board.cards[0].x).not.toBe(before);
  });

  // A vertical phone clip at a fixed 320 wide came out 569 tall — most of a
  // screen for one card, and the reporter said as much. A freshly dropped card
  // is fitted inside a box instead, but only while it is still at the size it
  // was created at, so this can never resize something by hand.
  function loadMetadata(container: HTMLElement, vw: number, vh: number) {
    const video = container.querySelector<HTMLVideoElement>('video')!;
    Object.defineProperty(video, 'videoWidth', { value: vw, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: vh, configurable: true });
    video.dispatchEvent(new Event('loadedmetadata'));
  }

  it('fits a vertical clip into the box rather than making it 569 tall', () => {
    const { container, board } = withVideo();
    loadMetadata(container, 1080, 1920);

    const card = board.cards[0];
    expect(card.h).toBe(360);
    expect(card.w).toBe(203); // 1080 * (360/1920)
  });

  it('leaves a 16:9 clip exactly where it already was', () => {
    // The box is chosen so landscape lands on the old default untouched —
    // this change is meant to fix vertical video, not move everything.
    const { container, board } = withVideo();
    loadMetadata(container, 1920, 1080);

    expect([board.cards[0].w, board.cards[0].h]).toEqual([320, 180]);
  });

  it('keeps the width on a card that has been resized, and only fixes its height', () => {
    // Refitting a card someone has already sized would undo their work every
    // time the board reopened.
    const { container, board } = withVideo();
    board.cards[0].w = 640;
    board.cards[0].h = 100;
    loadMetadata(container, 1080, 1920);

    expect(board.cards[0].w).toBe(640);
    expect(board.cards[0].h).toBe(1138); // 640 * (1920/1080)
  });

  it('leaves every other card kind capturing immediately, as before', () => {
    // The deferral is scoped to videos on purpose: immediate capture is what
    // guarantees a below-threshold nudge released off the card still reaches
    // onUp, and unpicking that for every card is not a change worth making on
    // the back of a video bug.
    const sticky: StickyCard = { id: 's1', kind: 'sticky', x: 0, y: 0, w: 200, h: 120, text: 'hi', color: '#fff' };
    const { container } = setup([sticky]);
    const cardEl = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="s1"]')!;
    const captured = vi.fn();
    cardEl.setPointerCapture = captured;

    const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 5, clientY: 5, buttons: 1 });
    cardEl.dispatchEvent(down);

    expect(captured).toHaveBeenCalled();
    expect(down.defaultPrevented).toBe(true);
  });

  it('offers a way out when the format cannot be decoded', () => {
    // mkv and avi generally can't be played by Electron's Chromium, and mov
    // depends on its codec. A dead black rectangle would be worse than the
    // file card this replaced, so failure has to land somewhere useful.
    const { container } = withVideo();
    container.querySelector<HTMLElement>('video')!.dispatchEvent(new Event('error'));

    const fallback = container.querySelector('.visual-notes-video-fallback');
    expect(fallback).not.toBeNull();
    expect(container.querySelector('video')).toBeNull();
    expect(fallback!.textContent).toContain('Open externally');
  });

  it('says so when the file is gone rather than showing a broken player', () => {
    const card = { id: 'v1', kind: 'video', x: 0, y: 0, w: 320, h: 180,
      source: { type: 'vault', path: 'missing.mp4' } } as unknown as Card;
    const { container } = setup([card]);

    expect(container.querySelector('.visual-notes-video-missing')).not.toBeNull();
    expect(container.querySelector('video')).toBeNull();
  });

  it('survives a canvas round trip as a plain file node', () => {
    // A file node is what Obsidian's own Canvas renders as a video player, so
    // the board stays playable in both viewers rather than becoming ours-only.
    const { board } = withVideo();
    const node = visualNotesToCanvas(board).nodes.find(n => n.id === 'v1')!;
    expect(node.type).toBe('file');
    expect(node.file).toBe(CLIP);

    const back = canvasToVisualNotes(visualNotesToCanvas(board));
    expect(back.cards[0].kind).toBe('video');
  });
});

describe('UI smoke: converting an existing video file card', () => {
  // Boards built before video cards existed are full of file cards pointing at
  // videos, and nothing upgrades them on its own — which would leave the
  // person who asked for this staring at the same board as before.
  function fileCardMenu(path: string) {
    const vault = new FakeVault();
    vault.putText(path, 'x');
    const card = { id: 'f1', kind: 'file', x: 10, y: 20, w: 260, h: 300, z: 3, path } as unknown as Card;
    const { renderer, board, container } = setup([card], [], 'bottom-right', vault);
    const el = container.querySelector<HTMLElement>('.visual-notes-freeform-card[data-id="f1"]')!;
    const menu = (renderer as any).newMenu();
    (renderer as any).populateCardMenu(menu, el, card);
    return { menu, board };
  }

  it('converts in place, keeping id, position and size', () => {
    const { menu, board } = fileCardMenu('_Assets/Video/old.mp4');
    menu.items.find((i: { title: string }) => i.title === 'Play on canvas').__trigger();

    expect(board.cards).toHaveLength(1);
    const card = board.cards[0] as unknown as { kind: string; id: string; x: number; y: number; w: number; h: number; z: number; source: { path: string } };
    expect(card.kind).toBe('video');
    expect(card.id).toBe('f1');
    expect([card.x, card.y, card.w, card.h, card.z]).toEqual([10, 20, 260, 300, 3]);
    expect(card.source.path).toBe('_Assets/Video/old.mp4');
  });

  it('is not offered for a file that is not a video', () => {
    const { menu } = fileCardMenu('Docs/report.pdf');
    expect(menu.items.some((i: { title: string }) => i.title === 'Play on canvas')).toBe(false);
  });
});
