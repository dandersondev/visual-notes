// Switching Obsidian's base colour scheme (Appearance → Base color scheme)
// from inside a board.
//
// There is no public API for this. `App` in obsidian.d.ts exposes workspace,
// vault, metadataCache, fileManager, keymap and scope — nothing that touches
// appearance — so every route to it is undocumented. That is worth stating
// plainly rather than burying: this is the one piece of the plugin that asks
// Obsidian for something it has not promised to keep offering.
//
// What follows from that is the shape of the code, not just a warning:
//
//   - Two routes are tried, because they have failed independently before.
//     The command ids are the primary route (they are what the Appearance
//     setting itself runs, and what Obsidian's own hotkeys bind to);
//     changeTheme is the older one, kept as a fallback.
//   - Nothing is assumed to exist. Every hop is optional-chained, so a
//     future Obsidian that drops both leaves us returning false rather than
//     throwing inside a click handler.
//   - Failure is reported, never swallowed. A toggle that silently does
//     nothing is worse than no toggle, because the user cannot tell whether
//     they missed the button or the feature is broken.
//   - Nothing here reads or writes the DOM, so all of it is testable. The
//     caller supplies the current scheme; see schemeOf.
import { App } from 'obsidian';

export type ColorScheme = 'light' | 'dark';

/**
 * The commands behind Appearance → Base color scheme. Exported so the tests
 * can assert the exact ids: they are the load-bearing strings in this file,
 * and a typo in one would fail in a way that looks identical to Obsidian
 * having removed it.
 */
export const SCHEME_COMMAND: Record<ColorScheme, string> = {
  light: 'theme:use-light',
  dark: 'theme:use-dark',
};

/** Obsidian's internal names for its two built-in schemes, for the fallback route. */
export const SCHEME_THEME_NAME: Record<ColorScheme, string> = {
  light: 'moonstone',
  dark: 'obsidian',
};

/** Which scheme a `theme-dark` body class means. Pure, so the DOM read stays at the call site. */
export function schemeOf(isDark: boolean): ColorScheme {
  return isDark ? 'dark' : 'light';
}

/** The scheme a toggle would move to from here. */
export function otherScheme(scheme: ColorScheme): ColorScheme {
  return scheme === 'dark' ? 'light' : 'dark';
}

// The two undocumented surfaces, described as narrowly as we actually use
// them. Deliberately an interface of optional members rather than `any`:
// every access below is then checked by the compiler, and the optionality is
// the honest description of something Obsidian never promised us.
interface AppearanceHost {
  commands?: { executeCommandById?(id: string): boolean };
  changeTheme?(name: string): void;
}

/**
 * Asks Obsidian to switch to `scheme`, returning false if it offers no way
 * to do so.
 *
 * A `true` return means a route was found and invoked, not that the screen
 * has finished changing — callers should let the workspace's `css-change`
 * event drive their UI rather than assuming the switch landed. That split
 * matters: it keeps a button honest if Obsidian ever accepts the call and
 * then ignores it, since the button only moves when the theme really does.
 */
export function applyColorScheme(app: App, scheme: ColorScheme): boolean {
  const host = app as unknown as AppearanceHost;

  try {
    if (host.commands?.executeCommandById?.(SCHEME_COMMAND[scheme])) return true;
  } catch {
    // An internal that exists but throws is exactly why there is a second
    // route; fall through to it rather than surfacing this.
  }

  try {
    if (typeof host.changeTheme === 'function') {
      host.changeTheme(SCHEME_THEME_NAME[scheme]);
      return true;
    }
  } catch { /* no route left; the caller tells the user */ }

  return false;
}
