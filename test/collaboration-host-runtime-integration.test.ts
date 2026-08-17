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
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
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
    read: (vaultPath: string) => readFile(full(vaultPath), 'utf8'),
    readBinary: (vaultPath: string) => readFile(full(vaultPath)).then(bytes => exactArrayBuffer(bytes)),
    writeBinary: (vaultPath: string, data: ArrayBuffer) => writeFile(full(vaultPath), new Uint8Array(data)),
    rename: (from: string, to: string) => rename(full(from), full(to)),
    remove: (vaultPath: string) => unlink(full(vaultPath)),
    list: async (vaultPath: string) => {
      const entries = await readdir(full(vaultPath), { withFileTypes: true });
      return {
        files: entries.filter(entry => entry.isFile()).map(entry => `${vaultPath}/${entry.name}`),
        folders: entries.filter(entry => entry.isDirectory()).map(entry => `${vaultPath}/${entry.name}`),
      };
    },
    stat: (vaultPath: string) => stat(full(vaultPath)).then(details => ({
      type: details.isDirectory() ? 'folder' : 'file', ctime: details.ctimeMs, mtime: details.mtimeMs, size: details.size,
    }), () => null),
  };
  return { vault: { adapter } } as unknown as App;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
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

  // The in-process API is what lets an owner who left recover their own room,
  // and it is unreachable over the network by design -- so this is the only
  // place it can be exercised at all.
  it('names hosted rooms so a person can tell them apart', async () => {
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
      const token = 'worker-runtime-test-token-123456789';
      const status = await manager.start({
        address: { address: '127.0.0.1', name: 'Test loopback', kind: 'private-lan' as const },
        port, token, runtimeDirectory: 'runtime', dataDirectory: 'data',
      });
      expect(status.state).toBe('running');
      const identity = { clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', displayName: 'Alice', color: '#e57373' };
      const board = (text: string) => ({
        version: 3, layout: 'freeform', connections: [], drawings: [],
        cards: [{ id: 'a', kind: 'sticky', text, color: '#fff' }],
      });

      const named = await createRoom(port, token, { initialBoard: board('ignored'), identity, label: 'Trip planning' });
      // A room made before rooms carried a name falls back to its contents,
      // which is what every existing room will do.
      const unnamed = await createRoom(port, token, { initialBoard: board('Rooftop scene'), identity });
      // Several card kinds hold their text as HTML, because they are edited in
      // a contentEditable -- so the raw value put <div> and <br> into names.
      const markup = await createRoom(port, token, {
        initialBoard: board('<div>Weekly&nbsp;plan<br>second line</div>'), identity,
      });

      const rooms = await manager.serverApi()!.listHostedCollaborationRooms();
      const byId = new Map(rooms.map(room => [room.roomId, room]));
      expect(byId.get(named.roomId)?.title).toBe('Trip planning');
      expect(byId.get(unnamed.roomId)?.title).toBe('Rooftop scene');
      expect(byId.get(markup.roomId)?.title).toBe('Weekly plan second line');
      // Never the raw identifier, which is the whole complaint.
      expect(byId.get(unnamed.roomId)?.title).not.toContain('private:');
      expect(byId.get(named.roomId)?.memberNames).toEqual(['Alice']);
      expect(byId.get(named.roomId)?.updatedAt).toBeGreaterThan(0);
      // Card IDs are canvas node IDs, which is how the plugin recognises the
      // board an older room came from and titles it with that board's name.
      expect(byId.get(unnamed.roomId)?.cardIds).toEqual(['a']);
      expect(byId.get(named.roomId)?.label).toBe('Trip planning');
      expect(byId.get(unnamed.roomId)?.label).toBeUndefined();

      // And the recovery itself: a fresh owner token for the same client.
      const claimed = await manager.serverApi()!.claimHostedRoomOwnership(named.roomId, identity);
      expect(claimed.role).toBe('owner');
      expect(claimed.accessToken).not.toBe(named.accessToken);

      // Clearing out a room takes it off the host for good.
      const deleted = await manager.serverApi()!.deleteHostedCollaborationRoom(markup.roomId);
      expect(deleted.deletedRooms).toBe(1);
      const remaining = await manager.serverApi()!.listHostedCollaborationRooms();
      expect(remaining.map(room => room.roomId)).not.toContain(markup.roomId);
      expect(remaining).toHaveLength(2);

      await manager.stop();
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    }
  });
});

async function createRoom(
  port: number, token: string, body: Record<string, unknown>,
): Promise<{ roomId: string; accessToken: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Create room failed: ${response.status} ${await response.text()}`);
  return await response.json() as { roomId: string; accessToken: string };
}

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
