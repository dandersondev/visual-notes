// A fake App good enough to construct and drive a real FreeformRenderer —
// built on top of FakeVault (vault.read/modify/create/…) plus the extra
// surface FreeformRenderer touches at construction/render time
// (vault.on, workspace, metadataCache). Extend as new UI tests need more.
import type { App } from 'obsidian';
import { FakeVault } from './fake-vault';

export function fakeApp(vault: FakeVault = new FakeVault()): App {
  const base = vault.toApp();
  return {
    ...base,
    vault: {
      ...base.vault,
      cachedRead: base.vault.read,
      on: (_event: string, _cb: (...args: unknown[]) => void) => ({}),
      off: () => {},
      getResourcePath: (file: { path: string }) => `fake-resource://${file.path}`,
      adapter: { getResourcePath: (path: string) => `fake-resource://${path}` },
    },
    workspace: {
      getActiveViewOfType: () => null,
      on: () => ({}),
      off: () => {},
      offref: () => {},
      getLeaf: () => ({ openFile: async () => {} }),
    },
    metadataCache: {
      getFileCache: () => null,
      on: () => ({}),
    },
  } as unknown as App;
}
