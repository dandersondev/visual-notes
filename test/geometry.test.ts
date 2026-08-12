import { describe, it, expect } from 'vitest';
import {
  pullBackPoint, curveControlPoint, buildCurvedPath, arrowheadPoints,
  buildTrimmedStraightPath, buildTrimmedCurvedPath, buildTrimmedElbowPath,
  buildElbowPath, quadBezierPoint,
  anchorPoint, pinPositions, straightAnchors, elbowAnchors, resolveOrientation,
} from '../src/canvas/geometry';
import { isOnVideoControls } from '../src/freeform-view-shared';

describe('pullBackPoint', () => {
  it('moves the point back toward `from` by the given distance', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 100, y: 0 };
    expect(pullBackPoint(from, to, 20)).toEqual({ x: 80, y: 0 });
  });

  it('works along a diagonal', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 30, y: 40 }; // 3-4-5 triangle, length 50
    const p = pullBackPoint(from, to, 10);
    expect(p.x).toBeCloseTo(24, 5);
    expect(p.y).toBeCloseTo(32, 5);
  });

  it('degenerates to `from` when the segment is shorter than the pull-back distance', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 5, y: 0 }; // shorter than the 20px pull-back
    expect(pullBackPoint(from, to, 20)).toEqual({ x: 0, y: 0 });
  });

  it('degenerates to `from` when the segment length is exactly the pull-back distance', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 20, y: 0 };
    expect(pullBackPoint(from, to, 20)).toEqual({ x: 0, y: 0 });
  });
});

describe('curveControlPoint', () => {
  it('matches the control point buildCurvedPath derives internally', () => {
    const src = { x: 0, y: 0 };
    const tgt = { x: 100, y: 0 };
    const offset = 30;
    const ctrl = curveControlPoint(src, tgt, offset);
    // buildCurvedPath's path string embeds the same control point (rounded
    // to 2 decimals) as its "Q" command — parse it back out and compare.
    const d = buildCurvedPath(src, tgt, offset);
    const match = d.match(/Q ([\d.-]+) ([\d.-]+)/);
    expect(match).toBeTruthy();
    expect(Number(match![1])).toBeCloseTo(ctrl.x, 2);
    expect(Number(match![2])).toBeCloseTo(ctrl.y, 2);
  });
});

describe('arrowheadPoints', () => {
  it('puts the tip exactly at `tip`, base corners `length` back toward `from`, `halfWidth` to each side', () => {
    // from -> tip pointing straight along +x, so the base sits on a
    // vertical line and the perpendicular offset is purely in y.
    const from = { x: 0, y: 0 };
    const tip = { x: 100, y: 0 };
    const [tipPt, c1, c2] = arrowheadPoints(tip, from, 10, 4);

    expect(tipPt).toEqual(tip);
    // Both base corners sit 10px back from the tip along the tip direction...
    expect(c1.x).toBeCloseTo(90, 5);
    expect(c2.x).toBeCloseTo(90, 5);
    // ...and 4px to either side, perpendicular to it.
    expect([c1.y, c2.y].sort()).toEqual([-4, 4]);
  });

  it('rotates correctly for a diagonal direction', () => {
    const from = { x: 0, y: 0 };
    const tip = { x: 30, y: 40 }; // 3-4-5 triangle, length 50
    const [tipPt, c1, c2] = arrowheadPoints(tip, from, 10, 5);

    expect(tipPt).toEqual(tip);
    // Base center is 10px back toward `from` along the tip direction:
    // (30,40) - 10*(30/50, 40/50) = (30-6, 40-8) = (24, 32).
    const baseCenter = { x: (c1.x + c2.x) / 2, y: (c1.y + c2.y) / 2 };
    expect(baseCenter.x).toBeCloseTo(24, 5);
    expect(baseCenter.y).toBeCloseTo(32, 5);
    // The two base corners are equidistant from that center and from the tip.
    const distTipToC1 = Math.hypot(tipPt.x - c1.x, tipPt.y - c1.y);
    const distTipToC2 = Math.hypot(tipPt.x - c2.x, tipPt.y - c2.y);
    expect(distTipToC1).toBeCloseTo(distTipToC2, 5);
  });

  it('degenerates to `from` when tip and from coincide, without throwing', () => {
    const p = { x: 5, y: 5 };
    expect(() => arrowheadPoints(p, p, 10, 4)).not.toThrow();
  });
});

function parseQuad(d: string): [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }] {
  const m = d.match(/M ([\d.-]+) ([\d.-]+) Q ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)/)!;
  const n = m.slice(1).map(Number);
  return [{ x: n[0], y: n[1] }, { x: n[2], y: n[3] }, { x: n[4], y: n[5] }];
}

describe('buildTrimmedStraightPath', () => {
  it('trims both ends along the segment', () => {
    expect(buildTrimmedStraightPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 10, 20)).toBe('M 10 0 L 80 0');
  });

  it('returns null when the trims consume the whole segment', () => {
    expect(buildTrimmedStraightPath({ x: 0, y: 0 }, { x: 25, y: 0 }, 15, 15)).toBeNull();
  });
});

describe('buildTrimmedCurvedPath', () => {
  const src = { x: 0, y: 0 };
  const tgt = { x: 400, y: 0 };
  const offset = 150; // extreme bend — where sub-segment correctness matters most

  it('with zero trims produces the same path as buildCurvedPath', () => {
    expect(buildTrimmedCurvedPath(src, tgt, offset, 0, 0)).toBe(buildCurvedPath(src, tgt, offset));
  });

  it('every point of the trimmed curve lies exactly on the untrimmed curve', () => {
    const d = buildTrimmedCurvedPath(src, tgt, offset, 22, 22)!;
    const [q0, q1, q2] = parseQuad(d);
    const ctrl = curveControlPoint(src, tgt, offset);
    // Sample the trimmed sub-curve; every sample must sit on (within
    // rounding of) the original curve — the invariant whose violation
    // made the visible stroke separate from the hit path/selection
    // outline at extreme bends.
    for (const u of [0, 0.2, 0.4, 0.5, 0.6, 0.8, 1]) {
      const p = quadBezierPoint(q0, q1, q2, u);
      let minDist = Infinity;
      // Dense enough (~0.07px between samples on this curve) that the
      // measured distance reflects the geometry, not the sampling grid.
      for (let t = 0; t <= 1.0001; t += 1 / 8000) {
        const b = quadBezierPoint(src, ctrl, tgt, t);
        minDist = Math.min(minDist, Math.hypot(p.x - b.x, p.y - b.y));
      }
      expect(minDist).toBeLessThan(0.35);
    }
  });

  it('trims roughly the requested arc length off each end', () => {
    const d = buildTrimmedCurvedPath(src, tgt, offset, 20, 20)!;
    const [q0, , q2] = parseQuad(d);
    const startGap = Math.hypot(q0.x - src.x, q0.y - src.y);
    const endGap = Math.hypot(q2.x - tgt.x, q2.y - tgt.y);
    // Chord distance ≤ arc distance, and the local-speed approximation is
    // good to well within 2× for arrowhead-scale trims.
    expect(startGap).toBeGreaterThan(10); expect(startGap).toBeLessThan(40);
    expect(endGap).toBeGreaterThan(10); expect(endGap).toBeLessThan(40);
  });

  it('returns null when the trims meet in the middle', () => {
    expect(buildTrimmedCurvedPath({ x: 0, y: 0 }, { x: 10, y: 0 }, 4, 300, 300)).toBeNull();
  });
});

describe('buildTrimmedElbowPath', () => {
  it('horizontal-first: keeps the untrimmed elbow\'s corners, retracts only the segment tips', () => {
    const src = { x: 0, y: 0 }, tgt = { x: 200, y: 100 };
    expect(buildElbowPath(src, tgt, 'horizontal-first')).toBe('M 0 0 H 100 V 100 H 200');
    expect(buildTrimmedElbowPath(src, tgt, 'horizontal-first', 12, 12)).toBe('M 12 0 H 100 V 100 H 188');
  });

  it('vertical-first: keeps the untrimmed elbow\'s corners, retracts only the segment tips', () => {
    const src = { x: 0, y: 0 }, tgt = { x: 100, y: 200 };
    expect(buildElbowPath(src, tgt, 'vertical-first')).toBe('M 0 0 V 100 H 100 V 200');
    expect(buildTrimmedElbowPath(src, tgt, 'vertical-first', 12, 12)).toBe('M 0 12 V 100 H 100 V 188');
  });

  it('clamps a trim at its corner when the outer segment is shorter than the trim', () => {
    const src = { x: 0, y: 0 }, tgt = { x: 10, y: 100 }; // first segment only 5px long
    expect(buildTrimmedElbowPath(src, tgt, 'horizontal-first', 20, 0)).toBe('M 5 0 H 5 V 100 H 10');
  });
});

// ── Pinned connection anchors ────────────────────────────────────

describe('anchorPoint', () => {
  const rect = { x: 100, y: 200, w: 300, h: 400 };

  it('places each side\'s anchor at the given fraction along that side', () => {
    expect(anchorPoint(rect, { side: 'n', t: 0.5 })).toEqual({ x: 250, y: 200 });
    expect(anchorPoint(rect, { side: 's', t: 0.25 })).toEqual({ x: 175, y: 600 });
    expect(anchorPoint(rect, { side: 'w', t: 0.5 })).toEqual({ x: 100, y: 400 });
    expect(anchorPoint(rect, { side: 'e', t: 0.75 })).toEqual({ x: 400, y: 500 });
  });

  it('clamps t outside 0..1 to the side\'s ends', () => {
    expect(anchorPoint(rect, { side: 'n', t: -3 })).toEqual({ x: 100, y: 200 });
    expect(anchorPoint(rect, { side: 'n', t: 9 })).toEqual({ x: 400, y: 200 });
  });

  it('is proportional, so a pin keeps its relative place when the card resizes', () => {
    const grown = { ...rect, h: 800 };
    expect(anchorPoint(rect, { side: 'e', t: 0.25 }).y).toBe(300);
    expect(anchorPoint(grown, { side: 'e', t: 0.25 }).y).toBe(400);
  });
});

describe('pinPositions', () => {
  it('offers more pins on a longer edge', () => {
    expect(pinPositions(80)).toHaveLength(1);
    expect(pinPositions(200)).toHaveLength(3);
    expect(pinPositions(300)).toHaveLength(5);
    expect(pinPositions(900)).toHaveLength(7);
  });

  it('always includes the edge midpoint, at every size', () => {
    for (const len of [50, 80, 120, 239, 240, 399, 400, 1200]) {
      expect(pinPositions(len)).toContain(0.5);
    }
  });

  it('spaces pins evenly and keeps them strictly inside the edge', () => {
    expect(pinPositions(300)).toEqual([1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6]);
    for (const t of pinPositions(900)) {
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThan(1);
    }
  });
});

describe('straightAnchors with pinned ends', () => {
  const from = { x: 0, y: 0, w: 100, h: 100 };
  const to = { x: 300, y: 0, w: 100, h: 100 };

  it('reproduces the original edge-exit geometry when nothing is pinned', () => {
    expect(straightAnchors(from, to)).toEqual({
      src: { x: 100, y: 50 },
      tgt: { x: 300, y: 50 },
    });
    // Explicit nulls must behave identically to omitting the arguments.
    expect(straightAnchors(from, to, null, null)).toEqual(straightAnchors(from, to));
  });

  it('uses the exact pinned point for a pinned end', () => {
    const { src } = straightAnchors(from, to, { side: 'n', t: 0.25 });
    expect(src).toEqual({ x: 25, y: 0 });
  });

  it('aims a free end at the far end\'s pin rather than the far card\'s center', () => {
    // `to` is pinned to its own top-left corner, well above the center line
    // the unpinned case would have aimed at, so the free `src` must ride up
    // the source card's edge to face it.
    const pinnedTgt = straightAnchors(from, to, null, { side: 'n', t: 0 });
    expect(pinnedTgt.tgt).toEqual({ x: 300, y: 0 });
    expect(pinnedTgt.src.y).toBeLessThan(50);

    const unpinned = straightAnchors(from, to);
    expect(unpinned.src.y).toBe(50);
  });

  it('honours both pins at once and ignores the cards\' relative positions', () => {
    expect(straightAnchors(from, to, { side: 'w', t: 0 }, { side: 'e', t: 1 })).toEqual({
      src: { x: 0, y: 0 },
      tgt: { x: 400, y: 100 },
    });
  });
});

describe('resolveOrientation with pinned ends', () => {
  const from = { x: 0, y: 0, w: 100, h: 100 };
  const to = { x: 0, y: 300, w: 100, h: 100 };

  it('falls back to relative position when neither end is pinned', () => {
    // Cards are stacked vertically, so 'auto' picks vertical-first.
    expect(resolveOrientation(from, to, 'auto')).toBe('vertical-first');
  });

  it('follows the axis the pinned side faces, overriding relative position', () => {
    expect(resolveOrientation(from, to, 'auto', { side: 'e', t: 0.5 })).toBe('horizontal-first');
    expect(resolveOrientation(from, to, 'auto', { side: 'n', t: 0.5 })).toBe('vertical-first');
  });

  it('lets the `from` pin win when the two ends disagree', () => {
    expect(resolveOrientation(from, to, 'auto', { side: 'w', t: 0.5 }, { side: 's', t: 0.5 }))
      .toBe('horizontal-first');
  });

  it('never overrides an explicit (non-auto) orientation', () => {
    expect(resolveOrientation(from, to, 'vertical-first', { side: 'e', t: 0.5 })).toBe('vertical-first');
  });
});

describe('elbowAnchors with pinned ends', () => {
  const from = { x: 0, y: 0, w: 100, h: 100 };
  const to = { x: 300, y: 0, w: 100, h: 100 };

  it('reproduces the original side-midpoint geometry when nothing is pinned', () => {
    expect(elbowAnchors(from, to, 'horizontal-first')).toEqual({
      src: { x: 100, y: 50 },
      tgt: { x: 300, y: 50 },
    });
  });

  it('replaces only the pinned end, leaving the free end on its side midpoint', () => {
    expect(elbowAnchors(from, to, 'horizontal-first', { side: 's', t: 0.5 })).toEqual({
      src: { x: 50, y: 100 },
      tgt: { x: 300, y: 50 },
    });
  });
});

// Splitting a video card between its controls and its picture.
//
// Both halves matter and they only work as a pair: the controls need the
// press, but taking every press left the card undraggable by its video, which
// is nearly all of it. Pure arithmetic rather than a DOM measurement so it is
// testable at all — jsdom reports every rect as zeros.
describe('isOnVideoControls', () => {
  const rect = { bottom: 180, height: 180 }; // a 320x180 card at the origin

  it('claims the bottom strip for the controls', () => {
    expect(isOnVideoControls(rect, 179)).toBe(true);
    expect(isOnVideoControls(rect, 145)).toBe(true); // 180 - 40 + 5
  });

  it('leaves the picture to the canvas, so the card can be dragged', () => {
    expect(isOnVideoControls(rect, 0)).toBe(false);
    expect(isOnVideoControls(rect, 90)).toBe(false);
    expect(isOnVideoControls(rect, 139)).toBe(false);
  });

  it('never gives the controls more than 40% of a short card', () => {
    // A 60px-tall card would otherwise be two thirds control bar, which is
    // undraggable again by a different route.
    const short = { bottom: 60, height: 60 };
    expect(isOnVideoControls(short, 30)).toBe(false); // above the 24px strip
    expect(isOnVideoControls(short, 50)).toBe(true);
  });

  it('treats an unlaid-out element as all picture rather than all controls', () => {
    // jsdom, and a card rendered before layout: guessing "controls" there
    // would make the card undraggable for reasons impossible to see.
    expect(isOnVideoControls({ bottom: 0, height: 0 }, 0)).toBe(false);
  });
});
