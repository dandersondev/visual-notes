import { Platform } from 'obsidian';

interface NodeModuleLoader {
  (id: string): unknown;
}

declare global {
  var __visualNotesNodeRequire: NodeModuleLoader | undefined;
}

/**
 * Collaboration hosting is a desktop-only capability. Keeping every Node
 * module load behind this guard prevents the server code bundled into the
 * plugin from being evaluated on Obsidian mobile.
 */
export function requireDesktopNodeModule<T>(id: string): T {
  if (!Platform.isDesktopApp) {
    throw new Error('Hosting a collaboration room is available on desktop only.');
  }
  const browserLoader = typeof window === 'undefined'
    ? undefined
    : (window as Window & { require?: NodeModuleLoader }).require;
  const loader = globalThis.__visualNotesNodeRequire ?? browserLoader;
  if (!loader) throw new Error('The desktop Node module loader is unavailable.');
  return loader(id) as T;
}
