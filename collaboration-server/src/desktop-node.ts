import { Platform } from 'obsidian';

interface NodeModuleLoader {
  (id: string): unknown;
}

declare global {
  interface Window {
    /** Electron's module loader, exposed by Obsidian on desktop only. */
    require?: NodeModuleLoader;
  }
}

/**
 * Collaboration hosting is a desktop-only capability. Keeping every Node
 * module load behind this guard prevents the server code bundled into the
 * plugin from being evaluated on Obsidian mobile.
 *
 * This is the embedded implementation, which runs inside Obsidian's window and
 * so reads the loader from `window` rather than the ambient global object.
 * The standalone development server has no window at all; its build
 * substitutes a createRequire-based version of this module -- see esbuild.mjs.
 */
export function requireDesktopNodeModule<T>(id: string): T {
  if (!Platform.isDesktopApp) {
    throw new Error('Hosting a collaboration room is available on desktop only.');
  }
  const loader = window.require;
  if (!loader) throw new Error('The desktop Node module loader is unavailable.');
  return loader(id) as T;
}
