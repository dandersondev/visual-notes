import type { AssetBlobStore, RoomDocumentStore } from './persistence-contract';
import { requireDesktopNodeModule } from './desktop-node';

// Held as namespaces rather than destructured. Pulling a member off a module
// separates it from its object, so it is called with an unbound `this` -- which
// the type-aware lint reports, and which is a real hazard for any member that
// turns out to use `this`.
const nodeCrypto = requireDesktopNodeModule<typeof import('node:crypto')>('node:crypto');
const nodeFs = requireDesktopNodeModule<typeof import('node:fs/promises')>('node:fs/promises');
const nodePath = requireDesktopNodeModule<typeof import('node:path')>('node:path');

/** Local development adapter. Hosted adapters can implement the same boundary. */
export class FileRoomDocumentStore<T> implements RoomDocumentStore<T> {
  constructor(
    private readonly directory: string,
    private readonly validate: (value: unknown) => T,
    private readonly fileName: (roomId: string) => string,
  ) {}

  async ready(): Promise<void> { await nodeFs.mkdir(this.directory, { recursive: true }); }

  async load(roomId: string): Promise<T> {
    const value: unknown = JSON.parse(await nodeFs.readFile(this.path(roomId), 'utf8'));
    return this.validate(value);
  }

  async save(roomId: string, value: T): Promise<void> {
    await this.ready();
    const target = this.path(roomId);
    const temporary = `${target}.${process.pid}.${nodeCrypto.randomBytes(6).toString('hex')}.tmp`;
    await nodeFs.writeFile(temporary, JSON.stringify(value), 'utf8');
    await nodeFs.rename(temporary, target);
  }

  async delete(roomId: string): Promise<void> { await nodeFs.unlink(this.path(roomId)); }

  async list(): Promise<T[]> {
    await this.ready();
    const values: T[] = [];
    for (const entry of await nodeFs.readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const value: unknown = JSON.parse(await nodeFs.readFile(nodePath.resolve(this.directory, entry.name), 'utf8'));
      values.push(this.validate(value));
    }
    return values;
  }

  private path(roomId: string): string { return nodePath.resolve(this.directory, this.fileName(roomId)); }
}

/** Content-addressed local blob adapter used only by the development runtime. */
export class FileAssetBlobStore implements AssetBlobStore {
  constructor(private readonly directory: string) {}

  async ready(): Promise<void> { await nodeFs.mkdir(this.directory, { recursive: true }); }

  async putIfAbsent(hash: string, bytes: Uint8Array): Promise<void> {
    await this.ready();
    try { await nodeFs.writeFile(this.path(hash), bytes, { flag: 'wx' }); }
    catch (error) { if (!isAlreadyExists(error)) throw error; }
  }

  async size(hash: string): Promise<number> { return (await nodeFs.stat(this.path(hash))).size; }

  async read(hash: string, range?: { start: number; end: number }): Promise<Uint8Array> {
    const bytes = await nodeFs.readFile(this.path(hash));
    return range ? bytes.subarray(range.start, range.end + 1) : bytes;
  }

  async delete(hash: string): Promise<void> { await nodeFs.unlink(this.path(hash)); }

  private path(hash: string): string { return nodePath.resolve(this.directory, hash); }
}

export { FileRoomDocumentStore as RoomDocumentStore, FileAssetBlobStore as AssetBlobStore };
export function joinPath(parent: string, child: string): string { return nodePath.resolve(parent, child); }

function isAlreadyExists(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST';
}
