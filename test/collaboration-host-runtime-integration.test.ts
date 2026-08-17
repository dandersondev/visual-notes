import { afterEach, describe, expect, it, vi } from 'vitest';
// The runtime's readiness probe now goes through Obsidian's requestUrl, and
// the shared stub returns a canned 200 that would never report ready. This
// suite is the one place the probe must really reach a real server, so give
// it a requestUrl that performs the request.
vi.mock('obsidian', () => ({
  // The runtime refuses to load Node modules off desktop; this suite is
  // exercising exactly that desktop path.
  Platform: { isDesktopApp: true },
  async requestUrl(options: { url: string; method?: string }) {
    const response = await fetch(options.url, { method: options.method ?? 'GET' });
    const text = await response.text();
    let json: unknown = undefined;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, text, json, arrayBuffer: new ArrayBuffer(0) };
  },
}));
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import type { App } from 'obsidian';
import { CollaborationHostManager } from '../src/collaboration-host';
import { createDesktopCollaborationHostRuntime } from '../src/collaboration-host-runtime';

let temporaryDirectory: string | undefined;

/**
 * The runtime now creates and writes through Obsidian's vault adapter rather
 * than node:fs, so the fake stands in for the adapter and maps vault-relative
 * paths onto a real temporary vault. Everything past that -- extracting the
 * bundle, loading it, reaching readiness -- is still the real thing.
 */
function fakeApp(vaultRoot: string): App {
  const full = (vaultPath: string) => join(vaultRoot, vaultPath);
  const adapter = {
    getFullPath: full,
    exists: (vaultPath: string) => stat(full(vaultPath)).then(() => true, () => false),
    mkdir: (vaultPath: string) => mkdir(full(vaultPath), { recursive: true }).then(() => undefined),
    write: (vaultPath: string, data: string) => writeFile(full(vaultPath), data, 'utf8'),
  };
  return { vault: { adapter } } as unknown as App;
}

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

describe('embedded desktop host runtime', () => {
  it('starts and restarts the standalone server in-process and reaches readiness', async () => {
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { require: createRequire(import.meta.url), setTimeout, clearTimeout },
    });
    try {
      temporaryDirectory = await mkdtemp(join(tmpdir(), 'visual-notes-host-'));
      const port = await availablePort();
      const source = await readFile('collaboration-server/dist/server.cjs', 'utf8');
      const manager = new CollaborationHostManager(
        source, createDesktopCollaborationHostRuntime(fakeApp(temporaryDirectory)),
      );
      const options = {
        address: { address: '127.0.0.1', name: 'Test loopback', kind: 'private-lan' as const },
        port, token: 'worker-runtime-test-token-123456789',
        runtimeDirectory: 'runtime',
        dataDirectory: 'data',
      };
      const status = await manager.start(options);
      // Asserted before the state: the manager collapses every startup failure
      // into state 'error', so checking state alone reports "expected error to
      // be running" and hides the reason.
      expect(status.error).toBeUndefined();
      expect(status.state).toBe('running');
      await manager.stop();
      expect(manager.status()).toEqual({ state: 'stopped' });
      const restarted = await manager.start(options);
      expect(restarted.state).toBe('running');
      await manager.stop();
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    }
  });
});

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('Could not allocate test port.')); return; }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}
