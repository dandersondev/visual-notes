// Round-trip invariant for the JSON Canvas interop layer.
//
// This is the file that caused permanent data loss in 1.1.0: a card kind whose
// serialise/parse path nobody exercised was silently dropped on save. The
// specific bug is fixed and unit-tested, but the *class* of bug is "some card
// kind doesn't survive a round trip", and the only durable defence is to run
// every kind through the cycle.
//
// The corpus is the 16 real starter templates rather than hand-written card
// literals: they cover 18 of the 19 kinds, they're the boards users actually
// start from, and they stay current as templates change instead of drifting
// from the types the way a fixture would.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { canvasToVisualNotes, visualNotesToCanvas } from '../src/canvas-format';
import type { CanvasData } from '../src/canvas-format';
import type { Card } from '../src/file-types';

const TEMPLATES = join(__dirname, '..', 'templates-src');

// Every kind in the `Card` union in file-types.ts. Listed literally so adding
// a kind to the union without giving it round-trip coverage fails here.
const ALL_KINDS = [
  'tile', 'sticky', 'checklist', 'comment', 'table',
  'image', 'audio', 'video', 'note-link', 'bookmark',
  'kanban-column', 'kanban-board', 'column', 'map', 'swatch', 'file', 'callout',
  'group', 'calendar', 'checkers',
] as const;

const templateFiles = readdirSync(TEMPLATES).filter(f => f.endsWith('.canvas')).sort();
const load = (f: string) => JSON.parse(readFileSync(join(TEMPLATES, f), 'utf8')) as CanvasData;

const kindsIn = (cards: Card[]): Set<string> => {
  const out = new Set<string>();
  const walk = (list: Card[]) => {
    for (const c of list) {
      out.add(c.kind);
      // Kanban boards carry their columns/items as sub-structures, not as
      // separate top-level cards.
      const nested = (c as { columns?: unknown }).columns;
      if (Array.isArray(nested)) for (const col of nested) out.add((col as Card).kind ?? 'kanban-column');
    }
  };
  walk(cards);
  return out;
};

describe('canvas round trip', () => {
  it('finds the starter templates', () => {
    // Guards the corpus: an empty list would make every case below vacuous.
    expect(templateFiles.length).toBeGreaterThan(10);
  });

  describe.each(templateFiles)('%s', (file) => {
    it('is recognised as a Visual Notes board', () => {
      // If a template stops being recognised, opening it would treat every
      // card as foreign — the 1.1.0 failure mode.
      const board = canvasToVisualNotes(load(file));
      expect(board.cards.length).toBeGreaterThan(0);
    });

    it('reaches a fixpoint through canvas -> board -> canvas -> board', () => {
      // Once-through can legitimately normalise (defaults filled in), so the
      // invariant is that a SECOND pass changes nothing. Anything dropped or
      // corrupted by serialisation shows up as a difference here.
      const first = canvasToVisualNotes(load(file));
      const second = canvasToVisualNotes(visualNotesToCanvas(first));
      expect(second).toEqual(first);
    });

    it('keeps every card and connection across a save', () => {
      const first = canvasToVisualNotes(load(file));
      const second = canvasToVisualNotes(visualNotesToCanvas(first));
      expect(second.cards.map(c => c.id).sort()).toEqual(first.cards.map(c => c.id).sort());
      expect(second.connections.length).toBe(first.connections.length);
      // Connections surviving while cards vanish was the diagnostic tell for
      // the 1.1.0 data loss, so assert cards explicitly rather than trusting
      // the deep-equal above to be read carefully.
      expect(second.cards.length).toBe(first.cards.length);
    });

    it('survives a re-save of the serialised form byte-for-byte', () => {
      const board = canvasToVisualNotes(load(file));
      const once = JSON.stringify(visualNotesToCanvas(board));
      const twice = JSON.stringify(visualNotesToCanvas(canvasToVisualNotes(JSON.parse(once) as CanvasData)));
      expect(twice).toBe(once);
    });
  });

  it('exercises every card kind across the corpus', () => {
    const seen = new Set<string>();
    for (const f of templateFiles) for (const k of kindsIn(canvasToVisualNotes(load(f)).cards)) seen.add(k);
    const missing = ALL_KINDS.filter(k => !seen.has(k));
    expect(
      missing,
      `No template round-trips these kinds, so a regression in them would go unnoticed. ` +
      `Add one to templates-src/, or extend this test: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
