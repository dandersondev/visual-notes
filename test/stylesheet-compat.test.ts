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

// Obsidian's CSS lint flags every !important and tells you to raise
// specificity instead. This stylesheet had said the same thing to itself for
// far longer — see the comments on .visual-notes-container and on the card
// z-index — and 1.1.27 broke it anyway, in the one place that had to outrank a
// theme. Repeating a marker class gets the same win without the warning, so
// there is no case left where !important is the answer.
describe('stylesheet: no !important', () => {
  it('declares none', () => {
    // Blanks comments in place rather than deleting them, so the reported
    // line numbers still point at the real file — `declarations` above
    // collapses them and would send you to the wrong line.
    const blanked = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    const offenders = blanked
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => line.includes('!important'));

    expect(
      offenders.map(o => `styles.css:${o.n}  ${o.line}`),
      'Obsidian\'s CSS lint warns on each of these. Raise the selector\'s ' +
      'specificity instead — repeating the rule\'s own marker class is what ' +
      'the rest of this file does.',
    ).toEqual([]);
  });
});

// Both halves of the explorer tag came out of one bug: the 1.1.26 tint
// looked like it had never applied. It had — Blue Topaz ends its canvas rule
// with `filter: hue-rotate(180deg)`, which rotated our blue into the same
// orange we were trying to be distinguishable from. Overriding the colour
// settles nothing while a filter is still spinning the result, so the fix is
// a rule that cancels the filter and a word no hue rotation can undo.
//
// The weight these rules need is the other half. Blue Topaz's selector is
// (0,4,1); ours has to beat it, and did so with !important until Obsidian's
// CSS lint flagged that in 1.1.27. Three copies of the marker class puts
// these at (0,5,0), so the class count wins instead.
const MARK = String.raw`\.visual-notes-explorer-board`;
const ROWS = (suffix: string) => new RegExp(
  String.raw`\.nav-file-title(${MARK}){3} \.nav-file-tag${suffix},\s*` +
  String.raw`\.tree-item-self(${MARK}){3} \.nav-file-tag${suffix} \{([^}]*)\}`,
);

describe('stylesheet: the explorer board tag survives a theme that styles canvas files', () => {
  const tag = declarations.match(ROWS(''))?.[0] ?? '';
  const after = declarations.match(ROWS('::after'))?.[0] ?? '';

  it('still has both rules to constrain', () => {
    // Also the specificity assertion: ROWS only matches with the marker class
    // repeated three times, so dropping the repetition fails here rather than
    // silently losing to the theme at runtime.
    expect(tag).not.toBe('');
    expect(after).not.toBe('');
  });

  it('cancels any filter the theme put on the tag', () => {
    expect(tag).toMatch(/filter:\s*none/);
  });

  it('hides the real extension text without collapsing the pill', () => {
    // transparent, not display:none or font-size:0 — the theme's own padding
    // and radius stay, and the overlay lands on a box that still has a size.
    expect(tag).toMatch(/color:\s*transparent/);
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

// iOS/iPadOS hands a touch to its own scroll gesture unless the element opts
// out, then fires pointercancel and stops sending pointermove. Without this
// declaration nothing could be dragged out of the toolbar onto the canvas on
// an iPad, for any card type, while the same gesture worked on desktop.
// It looks like a cosmetic line and deletes cleanly, so it is pinned here.
describe('stylesheet: the toolbar buttons opt out of the OS touch gesture', () => {
  const rule = declarations.match(/\.visual-notes-tb-btn\s*\{[^}]*\}/)?.[0] ?? '';

  it('has a .visual-notes-tb-btn rule at all', () => {
    expect(rule).not.toBe('');
  });

  it('sets touch-action: none, or a toolbar drag cannot start on iPad', () => {
    expect(rule).toMatch(/touch-action\s*:\s*none/);
  });

  // The phone layout turns the same panel into a scrolling bottom sheet that
  // these buttons fill, so there the rule has to be given back or the sheet
  // cannot be scrolled at all.
  it('gives the gesture back to the scrolling phone bottom sheet', () => {
    const phone = declarations.match(/@media \(max-width: 540px\)[\s\S]*$/)?.[0] ?? '';
    const sheetBtn = phone.match(/\.is-open \.visual-notes-add-panel \.visual-notes-tb-btn\s*\{[^}]*\}/)?.[0] ?? '';
    expect(sheetBtn).toMatch(/touch-action\s*:\s*auto/);
  });
});

describe('stylesheet: Storyboard remains editable on narrow screens', () => {
  const mobile = declarations.match(/@media \(max-width: 800px\)[\s\S]*$/)?.[0] ?? '';

  it('provides the mobile pane navigation', () => {
    expect(mobile).toMatch(/\.visual-notes-storyboard-mobile-nav\s*\{[^}]*display:\s*flex/);
  });

  it.each(['sections', 'stage', 'inspector'])('has a %s pane state', pane => {
    expect(mobile).toContain(`[data-mobile-pane="${pane}"]`);
  });

  it('does not unconditionally hide both metadata panes', () => {
    expect(mobile).not.toMatch(/\.visual-notes-storyboard-sections\s*,\s*\.visual-notes-storyboard-inspector\s*\{[^}]*display:\s*none/);
  });
});

describe('stylesheet: Storyboard grid preview uses transformed-card-safe wrapping', () => {
  for (const [size, width] of [['sm', '110px'], ['md', '160px'], ['lg', '240px']] as const) {
    it(`defines an explicit ${size} flex basis`, () => {
      expect(declarations).toMatch(new RegExp(
        `\\.visual-notes-storyboard-preview\\.is-grid\\.is-size-${size}\\s*\\{[^}]*` +
        `--vn-storyboard-grid-basis:\\s*${width}`,
      ));
    });
  }

  it('wraps with flex instead of CSS Grid inside a transformed canvas card', () => {
    const rule = declarations.match(/\.visual-notes-storyboard-preview\.is-grid\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toMatch(/display:\s*flex/);
    expect(rule).toMatch(/flex-wrap:\s*wrap/);
    expect(rule).not.toMatch(/display:\s*grid/);
  });
});
