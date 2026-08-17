import { beforeAll, describe, expect, it } from 'vitest';

const text = new Map<string, string>();
const binary = new Map<string, ArrayBuffer>();
const folders = new Set<string>();

beforeAll(() => {
  // The bridge lives on window, matching where the plugin installs it and
  // where persistence-obsidian.ts reads it.
  window.__visualNotesCollaborationStorage = {
    exists: path => Promise.resolve(folders.has(path) || text.has(path) || binary.has(path)),
    mkdir: path => { folders.add(path); return Promise.resolve(); },
    list: path => Promise.resolve({
      files: [...text.keys(), ...binary.keys()].filter(file => file.startsWith(`${path}/`)),
      folders: [...folders].filter(folder => folder.startsWith(`${path}/`)),
    }),
    read: path => text.has(path) ? Promise.resolve(text.get(path)!) : Promise.reject(missing(path)),
    readBinary: path => binary.has(path) ? Promise.resolve(binary.get(path)!) : Promise.reject(missing(path)),
    write: (path, value) => { text.set(path, value); return Promise.resolve(); },
    writeBinary: (path, value) => { binary.set(path, value); return Promise.resolve(); },
    // Obsidian's adapter refuses to rename onto an existing path, unlike
    // POSIX rename. The fake used to overwrite silently, which is why a store
    // that could only ever save once passed its tests: the second save threw
    // in the real app and not here. Model the real constraint.
    rename: (from, to) => {
      if (text.has(to) || binary.has(to)) {
        return Promise.reject(new Error(`File already exists: ${to}`));
      }
      if (text.has(from)) { text.set(to, text.get(from)!); text.delete(from); }
      else if (binary.has(from)) { binary.set(to, binary.get(from)!); binary.delete(from); }
      else return Promise.reject(missing(from));
      return Promise.resolve();
    },
    remove: path => { text.delete(path); binary.delete(path); return Promise.resolve(); },
    stat: path => Promise.resolve(binary.has(path) ? { size: binary.get(path)!.byteLength } : null),
  };
});

describe('Obsidian collaboration persistence', () => {
  it('stores rooms and ranged assets entirely through the adapter bridge', async () => {
    const { ObsidianAssetBlobStore, ObsidianRoomDocumentStore } = await import('../collaboration-server/src/persistence-obsidian');
    const rooms = new ObsidianRoomDocumentStore<{ roomId: string; value: number }>(
      '.obsidian/collaboration', value => value as { roomId: string; value: number }, roomId => `${roomId}.json`,
    );
    await rooms.save('one', { roomId: 'one', value: 1 });
    await rooms.save('one', { roomId: 'one', value: 2 });
    await expect(rooms.load('one')).resolves.toEqual({ roomId: 'one', value: 2 });
    await expect(rooms.list()).resolves.toEqual([{ roomId: 'one', value: 2 }]);

    const assets = new ObsidianAssetBlobStore('.obsidian/collaboration/assets');
    await assets.putIfAbsent('hash', new TextEncoder().encode('0123456789'));
    await assets.putIfAbsent('hash', new TextEncoder().encode('replacement'));
    await expect(assets.size('hash')).resolves.toBe(10);
    await expect(assets.read('hash', { start: 2, end: 5 }).then(value => new TextDecoder().decode(value))).resolves.toBe('2345');
  });
});

function missing(path: string): Error & { code: string } {
  return Object.assign(new Error(`Missing ${path}`), { code: 'ENOENT' });
}
