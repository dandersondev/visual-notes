import type { AssetBlobStore, RoomDocumentStore } from './persistence-contract';

export interface ObsidianCollaborationStorageBridge {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<ArrayBuffer>;
  write(path: string, value: string): Promise<void>;
  writeBinary(path: string, value: ArrayBuffer): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  stat(path: string): Promise<{ size: number } | null>;
}

declare global {
  interface Window {
    // Set by the desktop-only plugin host immediately before the embedded
    // server is loaded. The server cannot start on mobile. It lives on
    // `window` rather than the ambient global because this module is only ever
    // bundled into the embedded build, which runs inside Obsidian's window.
    __visualNotesCollaborationStorage?: ObsidianCollaborationStorageBridge;
  }
}

const storage = requireStorageBridge();

export class ObsidianRoomDocumentStore<T> implements RoomDocumentStore<T> {
  constructor(
    private readonly directory: string,
    private readonly validate: (value: unknown) => T,
    private readonly fileName: (roomId: string) => string,
  ) {}

  async ready(): Promise<void> { await ensureDirectory(this.directory); }

  async load(roomId: string): Promise<T> {
    const path = this.path(roomId);
    if (!await storage.exists(path)) throw missingFile(path);
    const value: unknown = JSON.parse(await storage.read(path));
    return this.validate(value);
  }

  async save(roomId: string, value: T): Promise<void> {
    await this.ready();
    const target = this.path(roomId);
    const temporary = `${target}.${randomSuffix()}.tmp`;
    await storage.write(temporary, JSON.stringify(value));
    await storage.rename(temporary, target);
  }

  async delete(roomId: string): Promise<void> {
    const path = this.path(roomId);
    if (!await storage.exists(path)) throw missingFile(path);
    await storage.remove(path);
  }

  async list(): Promise<T[]> {
    await this.ready();
    const values: T[] = [];
    for (const path of (await storage.list(this.directory)).files) {
      if (!path.endsWith('.json')) continue;
      const value: unknown = JSON.parse(await storage.read(path));
      values.push(this.validate(value));
    }
    return values;
  }

  private path(roomId: string): string { return joinPath(this.directory, this.fileName(roomId)); }
}

export class ObsidianAssetBlobStore implements AssetBlobStore {
  constructor(private readonly directory: string) {}

  async ready(): Promise<void> { await ensureDirectory(this.directory); }

  async putIfAbsent(hash: string, bytes: Uint8Array): Promise<void> {
    await this.ready();
    const path = this.path(hash);
    if (await storage.exists(path)) return;
    await storage.writeBinary(path, exactArrayBuffer(bytes));
  }

  async size(hash: string): Promise<number> {
    const path = this.path(hash);
    const details = await storage.stat(path);
    if (!details) throw missingFile(path);
    return details.size;
  }

  async read(hash: string, range?: { start: number; end: number }): Promise<Uint8Array> {
    const path = this.path(hash);
    if (!await storage.exists(path)) throw missingFile(path);
    const bytes = new Uint8Array(await storage.readBinary(path));
    return range ? bytes.subarray(range.start, range.end + 1) : bytes;
  }

  async delete(hash: string): Promise<void> {
    const path = this.path(hash);
    if (!await storage.exists(path)) throw missingFile(path);
    await storage.remove(path);
  }

  private path(hash: string): string { return joinPath(this.directory, hash); }
}

export { ObsidianRoomDocumentStore as RoomDocumentStore, ObsidianAssetBlobStore as AssetBlobStore };

export function joinPath(parent: string, child: string): string {
  return `${parent.replace(/[\\/]+$/, '')}/${child.replace(/^[\\/]+/, '')}`;
}

async function ensureDirectory(path: string): Promise<void> {
  if (await storage.exists(path)) return;
  const parent = path.replace(/[\\/][^\\/]+$/, '');
  if (parent && parent !== path) await ensureDirectory(parent);
  if (!await storage.exists(path)) await storage.mkdir(path);
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function randomSuffix(): string {
  const bytes = new Uint8Array(8);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function missingFile(path: string): Error & { code: string } {
  return Object.assign(new Error(`No such file: ${path}`), { code: 'ENOENT' });
}

function requireStorageBridge(): ObsidianCollaborationStorageBridge {
  const bridge = window.__visualNotesCollaborationStorage;
  if (!bridge) throw new Error('The Obsidian collaboration storage bridge is unavailable.');
  return bridge;
}
