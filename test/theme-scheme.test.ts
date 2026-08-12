// Switching Obsidian's base colour scheme.
//
// This is the plugin's only use of undocumented API, which changes what the
// tests are for. They cannot prove the commands exist — only a running
// Obsidian can do that — so instead they pin the things that would break
// silently on our side: the exact command ids, the order the two routes are
// tried in, and the guarantee that a missing internal returns false rather
// than throwing inside a click handler.
import { describe, it, expect, vi } from 'vitest';
import type { App } from 'obsidian';
import {
  SCHEME_COMMAND, SCHEME_THEME_NAME, applyColorScheme, otherScheme, schemeOf,
} from '../src/theme-scheme';

/** An App exposing whichever internals a given test wants to offer. */
function fakeApp(parts: Record<string, unknown>): App {
  return parts as unknown as App;
}

describe('schemeOf / otherScheme', () => {
  it('reads the body flag as a scheme', () => {
    expect(schemeOf(true)).toBe('dark');
    expect(schemeOf(false)).toBe('light');
  });

  it('flips to the other scheme', () => {
    expect(otherScheme('dark')).toBe('light');
    expect(otherScheme('light')).toBe('dark');
  });

  it('is its own inverse, so a toggle always returns where it started', () => {
    expect(otherScheme(otherScheme('dark'))).toBe('dark');
    expect(otherScheme(otherScheme('light'))).toBe('light');
  });
});

describe('the command ids', () => {
  // Spelled out rather than compared to the constant: a test that read the
  // same value it asserts would pass just as happily on a typo.
  it('are the base-colour-scheme commands Obsidian registers', () => {
    expect(SCHEME_COMMAND.light).toBe('theme:use-light');
    expect(SCHEME_COMMAND.dark).toBe('theme:use-dark');
  });

  it('name the built-in themes for the fallback route', () => {
    expect(SCHEME_THEME_NAME.light).toBe('moonstone');
    expect(SCHEME_THEME_NAME.dark).toBe('obsidian');
  });
});

describe('applyColorScheme', () => {
  it('runs the matching command and reports success', () => {
    const executeCommandById = vi.fn().mockReturnValue(true);
    expect(applyColorScheme(fakeApp({ commands: { executeCommandById } }), 'dark')).toBe(true);
    expect(executeCommandById).toHaveBeenCalledWith('theme:use-dark');

    expect(applyColorScheme(fakeApp({ commands: { executeCommandById } }), 'light')).toBe(true);
    expect(executeCommandById).toHaveBeenLastCalledWith('theme:use-light');
  });

  it('prefers the command over changeTheme when both exist', () => {
    // The command is what Obsidian's own Appearance setting runs, so it is
    // the route most likely to keep behaving like the setting does.
    const executeCommandById = vi.fn().mockReturnValue(true);
    const changeTheme = vi.fn();
    applyColorScheme(fakeApp({ commands: { executeCommandById }, changeTheme }), 'dark');
    expect(executeCommandById).toHaveBeenCalled();
    expect(changeTheme).not.toHaveBeenCalled();
  });

  it('falls back to changeTheme when the command is missing', () => {
    const changeTheme = vi.fn();
    expect(applyColorScheme(fakeApp({ changeTheme }), 'light')).toBe(true);
    expect(changeTheme).toHaveBeenCalledWith('moonstone');
  });

  it('falls back when the command exists but declines to run', () => {
    // executeCommandById returns false for an id it doesn't know — which is
    // exactly what a renamed command would look like.
    const changeTheme = vi.fn();
    const app = fakeApp({ commands: { executeCommandById: () => false }, changeTheme });
    expect(applyColorScheme(app, 'dark')).toBe(true);
    expect(changeTheme).toHaveBeenCalledWith('obsidian');
  });

  it('falls back when the command throws rather than letting it escape', () => {
    // An internal that exists but throws is the case a plain feature-check
    // would miss: `commands.executeCommandById` is present, so optional
    // chaining alone would not have saved the click handler.
    const changeTheme = vi.fn();
    const app = fakeApp({
      commands: { executeCommandById: () => { throw new Error('gone'); } },
      changeTheme,
    });
    expect(applyColorScheme(app, 'dark')).toBe(true);
    expect(changeTheme).toHaveBeenCalledWith('obsidian');
  });

  it('reports failure instead of throwing when Obsidian offers no route', () => {
    // The whole point of the boolean: the caller shows a Notice pointing at
    // Appearance settings, rather than the button doing nothing at all.
    expect(applyColorScheme(fakeApp({}), 'dark')).toBe(false);
    expect(applyColorScheme(fakeApp({ commands: {} }), 'dark')).toBe(false);
    expect(applyColorScheme(fakeApp({ changeTheme: 'not a function' }), 'dark')).toBe(false);
  });

  it('reports failure when both routes throw', () => {
    const app = fakeApp({
      commands: { executeCommandById: () => { throw new Error('gone'); } },
      changeTheme: () => { throw new Error('gone too'); },
    });
    expect(applyColorScheme(app, 'light')).toBe(false);
  });
});
