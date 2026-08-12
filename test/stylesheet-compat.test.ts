// Obsidian's plugin health check lints styles.css against browser-support
// data and warns on anything marked "partially supported", judging by the
// caniuse *feature*, not by the specific value you wrote. `text-indent` is
// the case that caught us in 1.1.21: the feature is partial only because of
// the `hanging` and `each-line` keywords, while the plain length we used has
// been universally supported for decades. The warning is still a warning, and
// a clean health check is worth more than one line of CSS.
//
// This runs on the raw stylesheet rather than the DOM because jsdom has no
// layout engine and would happily accept anything.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8');
// Comments discuss these properties by name — match declarations only.
const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '');

// Property names Obsidian's checker flags. Add to this list as the checker
// reports them; each entry needs a supported alternative, not a suppression.
const FLAGGED = ['text-indent'];

describe('stylesheet: no browser features Obsidian flags as partial', () => {
  for (const prop of FLAGGED) {
    it(`declares no ${prop}`, () => {
      const found = declarations.match(new RegExp(`(^|[;{\\s])${prop}\\s*:`, 'g'));
      expect(found).toBe(null);
    });
  }
});

// This span shares a flex row with the Browse/Create buttons, so its
// min-content width is what decides whether the buttons can squeeze it into a
// vertical column. break-all puts that minimum at a single character, which is
// how "New board from label" came to render one letter per line; break-word
// leaves it at the longest word. overflow-wrap: anywhere looks like the same
// fix but shrinks min-content the same way break-all does, so it is barred too.
describe('stylesheet: the modal path display cannot collapse to a vertical column', () => {
  const rule = declarations.match(/\.visual-notes-modal-path-display\s*\{[^}]*\}/)?.[0] ?? '';

  it('still has a rule to constrain', () => {
    expect(rule).not.toBe('');
  });

  it('never breaks at arbitrary characters', () => {
    expect(rule).not.toMatch(/word-break:\s*break-all/);
    expect(rule).not.toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('still wraps a long vault path rather than overflowing the modal', () => {
    expect(rule).toMatch(/overflow-wrap:\s*break-word/);
  });
});

// Both halves of the explorer tag came out of one bug: the 1.1.26 tint
// looked like it had never applied. It had — Blue Topaz ends its canvas rule
// with `filter: hue-rotate(180deg)`, which rotated our blue into the same
// orange we were trying to be distinguishable from. !important settles
// specificity but says nothing about a filter, so the colour was overridden
// and then spun back. Hence a rule that cannot be undone by a hue rotation
// and a colour that is no longer rotated at all.
describe('stylesheet: the explorer board tag survives a theme that styles canvas files', () => {
  const tag = declarations.match(
    /\.nav-file-title\.visual-notes-explorer-board \.nav-file-tag,\s*\.tree-item-self\.visual-notes-explorer-board \.nav-file-tag \{([^}]*)\}/,
  )?.[0] ?? '';
  const after = declarations.match(
    /\.nav-file-title\.visual-notes-explorer-board \.nav-file-tag::after,\s*\.tree-item-self\.visual-notes-explorer-board \.nav-file-tag::after \{([^}]*)\}/,
  )?.[0] ?? '';

  it('still has both rules to constrain', () => {
    expect(tag).not.toBe('');
    expect(after).not.toBe('');
  });

  it('cancels any filter the theme put on the tag', () => {
    expect(tag).toMatch(/filter:\s*none\s*!important/);
  });

  it('hides the real extension text without collapsing the pill', () => {
    // transparent, not display:none or font-size:0 — the theme's own padding
    // and radius stay, and the overlay lands on a box that still has a size.
    expect(tag).toMatch(/color:\s*transparent\s*!important/);
  });

  it('names the owning plugin in a way no colour filter can undo', () => {
    expect(after).toMatch(/content:\s*'VISUAL'/);
  });

  it('keeps the label to CANVAS\'s own width', () => {
    // The pill is still sized by the transparent text underneath, so a label
    // longer than CANVAS spills past the coloured background it sits on.
    const label = /content:\s*'([^']*)'/.exec(after)?.[1] ?? '';
    expect(label.length).toBeGreaterThan(0);
    expect(label.length).toBeLessThanOrEqual('CANVAS'.length);
  });

  it('gives the overlay its own colour rather than inheriting', () => {
    // The parent is transparent by design; an inherited colour would make
    // the replacement text invisible too.
    expect(after).toMatch(/color:\s*var\(--vn-explorer-board-tint\)/);
  });

  it('positions the overlay with longhand offsets, not inset', () => {
    // Same reasoning as the text-indent removal above: a shorthand Obsidian's
    // checker may call partial is not worth one line of CSS.
    expect(after).not.toMatch(/(^|[;{\s])inset\s*:/);
    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(after).toMatch(new RegExp(`${side}:\\s*0`));
    }
  });
});

describe('stylesheet: bullet hanging indent survives without text-indent', () => {
  // The indent is what keeps continuation lines (Shift+Enter, natural wraps,
  // a multi-paragraph item) under the text instead of under the marker. It is
  // now built from two halves that only work as a pair, so assert both: the
  // <li> pads the text across, and the marker alone is pulled back out of
  // that padding by exactly the same distance.
  it('pads the item across by the full indent', () => {
    expect(declarations).toMatch(
      /\.visual-notes-sticky-editor li \{[^}]*padding-left:\s*var\(--vn-bullet-indent\)/,
    );
  });

  it('pulls the marker back out of the padding by the same distance', () => {
    expect(declarations).toMatch(
      /\.visual-notes-sticky-editor li::before \{[^}]*margin-left:\s*calc\(-1 \* var\(--vn-bullet-indent\)\)/,
    );
  });

  it('derives the indent from the two tunable knobs', () => {
    expect(declarations).toMatch(
      /--vn-bullet-indent:\s*calc\(var\(--vn-bullet-w\) \+ var\(--vn-bullet-gap\)\)/,
    );
  });
});
