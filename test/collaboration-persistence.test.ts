import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

vi.mock('obsidian', () => {
  globalThis.__visualNotesNodeRequire = createRequire(import.meta.url);
  return { Platform: { isDesktopApp: true } };
});
import { FileAssetBlobStore, FileRoomDocumentStore } from '../collaboration-server/src/persistence';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('collaboration persistence boundaries', () => {
  it('atomically saves, lists, reloads and deletes room documents', async () => {
    const directory = temporaryDirectory();
    const store = new FileRoomDocumentStore<{ roomId: string; value: number }>(
      directory,
      value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)
          || typeof (value as { roomId?: unknown }).roomId !== 'string'
          || typeof (value as { value?: unknown }).value !== 'number') throw new Error('invalid');
        return value as { roomId: string; value: number };
      },
      roomId => `${roomId}.json`,
    );
    await store.save('one', { roomId: 'one', value: 1 });
    await store.save('one', { roomId: 'one', value: 2 });
    await expect(store.load('one')).resolves.toEqual({ roomId: 'one', value: 2 });
    await expect(store.list()).resolves.toEqual([{ roomId: 'one', value: 2 }]);
    await store.delete('one');
    await expect(store.load('one')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('deduplicates content-addressed blobs and supports ranged reads', async () => {
    const store = new FileAssetBlobStore(temporaryDirectory());
    await store.putIfAbsent('asset', Buffer.from('0123456789'));
    await store.putIfAbsent('asset', Buffer.from('replacement must not win'));
    await expect(store.size('asset')).resolves.toBe(10);
    await expect(store.read('asset', { start: 2, end: 5 }).then(bytes => Buffer.from(bytes).toString('utf8'))).resolves.toBe('2345');
    await store.delete('asset');
    await expect(store.size('asset')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'visual-notes-persistence-'));
  directories.push(directory);
  return directory;
}
