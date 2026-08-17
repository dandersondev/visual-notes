import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { CollaborationHostManager } from '../src/collaboration-host';
import { createDesktopCollaborationHostRuntime } from '../src/collaboration-host-runtime';

let temporaryDirectory: string | undefined;

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

describe('embedded desktop host runtime', () => {
  it('starts and restarts the standalone server in-process and reaches readiness', async () => {
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { require: createRequire(import.meta.url), setTimeout },
    });
    try {
      temporaryDirectory = await mkdtemp(join(tmpdir(), 'visual-notes-host-'));
      const port = await availablePort();
      const source = await readFile('collaboration-server/dist/server.cjs', 'utf8');
      const manager = new CollaborationHostManager(source, createDesktopCollaborationHostRuntime());
      const status = await manager.start({
        address: { address: '127.0.0.1', name: 'Test loopback', kind: 'private-lan' },
        port, token: 'worker-runtime-test-token-123456789',
        runtimeDirectory: join(temporaryDirectory, 'runtime'),
        dataDirectory: join(temporaryDirectory, 'data'),
      });
      expect(status.state).toBe('running');
      await manager.stop();
      expect(manager.status()).toEqual({ state: 'stopped' });
      const restarted = await manager.start({
        address: { address: '127.0.0.1', name: 'Test loopback', kind: 'private-lan' },
        port, token: 'worker-runtime-test-token-123456789',
        runtimeDirectory: join(temporaryDirectory, 'runtime'),
        dataDirectory: join(temporaryDirectory, 'data'),
      });
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
