// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  bindStoryboardPointerGesture, roundStoryboardPoint, storyboardArrowGeometry, storyboardDuration, storyboardExportBaseName,
  storyboardShotListMarkdown, storyboardStrokePath,
} from '../src/freeform-view-cards-storyboard';
import type { StoryboardCard, StoryboardStroke } from '../src/file-types';

const card = (): StoryboardCard => ({
  id: 'board', kind: 'storyboard', title: 'Night exterior', view: 'filmstrip',
  x: 0, y: 0, w: 900, h: 540, z: 1,
  sections: [{ id: 'section', title: 'Rooftop', shots: [
    { id: 'a', shot: '1.1', title: 'Wide', duration: 2.5, aspectRatio: '16:9', notes: 'City reveal', objects: [], drawings: [], status: 'idea' },
    { id: 'b', shot: '1.2', title: 'Close-up', duration: 1.25, aspectRatio: '4:3', objects: [], drawings: [], status: 'idea' },
  ] }],
});

describe('storyboard pointer gesture cleanup', () => {
  it.each(['pointerup', 'pointercancel'] as const)('finishes and detaches on %s', endType => {
    const target = document.createElement('div');
    const move = vi.fn();
    const complete = vi.fn();
    bindStoryboardPointerGesture(target, move, complete);

    target.dispatchEvent(new Event('pointermove'));
    target.dispatchEvent(new Event(endType));
    target.dispatchEvent(new Event('pointermove'));
    target.dispatchEvent(new Event(endType));

    expect(move).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe('storyboard preview controls', () => {
  it('uses the established Obsidian grid icon name', () => {
    const source = readFileSync(join(__dirname, '../src/freeform-view-cards-storyboard.ts'), 'utf8');
    expect(source).toContain("'layout-grid'");
    expect(source).not.toContain("'grid-2x2'");
  });
});

describe('storyboard compact persistence and exports', () => {
  it('rounds normalized pointer samples to four decimal places', () => {
    expect(roundStoryboardPoint({ x: 0.43286071726438696, y: 0.46735905044510384, p: 0.50000001 }))
      .toEqual({ x: 0.4329, y: 0.4674, p: 0.5 });
    expect(roundStoryboardPoint({ x: 1 / 3, y: 2 / 3 })).toEqual({ x: 0.3333, y: 0.6667 });
  });

  it('totals duration and creates a readable Markdown shot list', () => {
    const storyboard = card();
    expect(storyboardDuration(storyboard)).toBe(3.75);
    const markdown = storyboardShotListMarkdown(storyboard);
    expect(markdown).toContain('# Night exterior');
    expect(markdown).toContain('## Rooftop');
    expect(markdown).toContain('1.1');
    expect(markdown).toContain('City reveal');
    expect(markdown).toContain('Total duration:** 0:04');
  });

  it('creates safe export filenames', () => {
    expect(storyboardExportBaseName(' Scene: 12 / Rooftop? ')).toBe('Scene- 12 - Rooftop-');
    expect(storyboardExportBaseName('...')).toBe('Storyboard');
    expect(storyboardExportBaseName()).toBe('Storyboard');
  });

  it('renders deterministic pressure-sensitive brush outlines', () => {
    const stroke: StoryboardStroke = {
      id: 'ink', brush: 'pencil', color: '#222222', width: 8, opacity: .7,
      smoothing: .4, pressureEnabled: true, simulatePressure: false,
      points: [{ x: .1, y: .2, p: .1 }, { x: .5, y: .4, p: .5 }, { x: .9, y: .7, p: 1 }],
    };
    const pressured = storyboardStrokePath(stroke);
    expect(pressured).toBe(storyboardStrokePath(stroke));
    expect(pressured).toMatch(/^M /);
    expect(pressured).not.toContain('NaN');
    const pen = { ...stroke, brush: 'pen' as const };
    expect(storyboardStrokePath(pen)).not.toBe(storyboardStrokePath({ ...pen, pressureEnabled: false }));
  });

  it('uses the canvas arrow geometry with a trimmed shaft and optional bend', () => {
    const straight = storyboardArrowGeometry({ id: 'arrow', kind: 'arrow', x: .1, y: .5, x2: .9, y2: .5, width: 5 });
    expect(straight).toEqual({ path: 'M 100 500 L 860 500', tip: '900,500 860,517 860,483' });
    const curved = storyboardArrowGeometry({ id: 'curve', kind: 'arrow', x: .1, y: .5, x2: .9, y2: .5, bend: .2, width: 5 });
    expect(curved?.path).toContain(' Q ');
    expect(curved?.path).not.toContain(' 900 500');
    expect(storyboardArrowGeometry({ id: 'dot', kind: 'arrow', x: .5, y: .5, x2: .5, y2: .5 })).toBeNull();
  });
});
