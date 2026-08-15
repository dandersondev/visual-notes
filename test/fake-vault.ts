// A minimal in-memory stand-in for Obsidian's Vault/FileManager, covering
// only the methods file-io.ts and asset-manager.ts actually call
// (getAbstractFileByPath, getFiles, read, modify, create, createBinary,
// createFolder, fileManager.renameFile). Shared across their test files so
// each one isn't hand-rolling its own fake Vault.
import { TFile, TFolder, type App } from 'obsidian';

export interface FakeFile {
  path: string; name: string; basename: string; extension: string;
  // Real TFiles carry this, and production code reads it — renderFileContent
  // shows a file's size, and the explorer decorator keys its cache on mtime.
  // Without it those paths throw on a file that exists, which is a fake
  // problem rather than a real one.
  stat: { ctime: number; mtime: number; size: number };
}
export interface FakeFolder { path: string; name: string; }

// A real instance of the stubbed TFile class (not a plain object) — some
// production code (installStarterTemplate) does `existing instanceof TFile`,
// which a plain duck-typed object would always fail.
function makeFile(path: string): FakeFile {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  const basename = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot + 1) : '';
  const file = new TFile() as unknown as FakeFile;
  Object.assign(file, { path, name, basename, extension, stat: { ctime: 0, mtime: 0, size: 0 } });
  return file;
}

// Same reasoning as makeFile — production code does `instanceof TFolder`
// (see saveBoardAsTemplate), which a plain duck-typed object would always fail.
function makeFolder(path: string): FakeFolder {
  const name = path.split('/').pop() ?? path;
  const folder = new TFolder() as unknown as FakeFolder;
  Object.assign(folder, { path, name });
  return folder;
}

export class FakeVault {
  private entries = new Map<string, { file: FakeFile; content: string | ArrayBuffer }>();
  private folders = new Set<string>();

  putText(path: string, content: string): FakeFile {
    const file = makeFile(path);
    file.stat.size = content.length;
    this.entries.set(path, { file, content });
    return file;
  }

  textAt(path: string): string {
    const entry = this.entries.get(path);
    if (!entry) throw new Error(`FakeVault: no such file ${path}`);
    return entry.content as string;
  }

  /** The counterpart of textAt for anything written through createBinary. */
  binaryAt(path: string): ArrayBuffer {
    const entry = this.entries.get(path);
    if (!entry) throw new Error(`FakeVault: no such file ${path}`);
    return entry.content as ArrayBuffer;
  }

  has(path: string): boolean {
    return this.entries.has(path) || this.folders.has(path);
  }

  // Lets a test hold a valid TFile whose content is gone, which is how a read
  // failure is simulated — vault.read throws for anything not in the map.
  remove(path: string): void {
    this.entries.delete(path);
  }

  private nextReadHook: (() => void) | null = null;

  /**
   * Runs `fn` once, immediately after the next `read()` returns its content —
   * so the read sees the old text and anything `fn` writes lands just after.
   *
   * That models a real window in writeBoardFile: snapshotIfEmptying reads the
   * file, and only then does process() run. A test can drop a competing
   * revision into that gap and check the guard still catches it, which is the
   * property `process()` buys over a plain read-then-write.
   */
  onNextRead(fn: () => void): void {
    this.nextReadHook = fn;
  }

  toApp(): App {
    const vault = {
      getAbstractFileByPath: (path: string) => {
        const entry = this.entries.get(path);
        if (entry) return entry.file;
        if (this.folders.has(path)) return makeFolder(path);
        return null;
      },
      getFiles: () => Array.from(this.entries.values()).map(e => e.file),
      read: async (file: FakeFile) => {
        const entry = this.entries.get(file.path);
        if (!entry) throw new Error(`FakeVault: no such file ${file.path}`);
        const content = entry.content as string;
        const hook = this.nextReadHook;
        this.nextReadHook = null;
        hook?.();
        return content;
      },
      // Obsidian's atomic read-modify-write. Faithful in the one way that
      // matters here: the callback is handed the content as it is at call
      // time, synchronously, and whatever it returns is what lands — there is
      // no gap in between for anything else to slip through.
      process: async (file: FakeFile, fn: (data: string) => string) => {
        const entry = this.entries.get(file.path);
        if (!entry) throw new Error(`FakeVault: no such file ${file.path}`);
        const next = fn(entry.content as string);
        entry.content = next;
        return next;
      },
      modify: async (file: FakeFile, content: string) => {
        const entry = this.entries.get(file.path);
        if (!entry) throw new Error(`FakeVault: no such file ${file.path}`);
        entry.content = content;
      },
      create: async (path: string, content: string) => {
        if (this.entries.has(path)) throw new Error(`FakeVault: ${path} already exists`);
        return this.putText(path, content);
      },
      createBinary: async (path: string, data: ArrayBuffer) => {
        if (this.entries.has(path)) throw new Error(`FakeVault: ${path} already exists`);
        const file = makeFile(path);
        this.entries.set(path, { file, content: data });
        return file;
      },
      createFolder: async (path: string) => { this.folders.add(path); },
      getAllLoadedFiles: () => [
        ...Array.from(this.entries.values()).map(e => e.file),
        ...Array.from(this.folders).map(p => makeFolder(p)),
      ],
    };
    const fileManager = {
      renameFile: async (file: FakeFile, newPath: string) => {
        const entry = this.entries.get(file.path);
        if (!entry) throw new Error(`FakeVault: no such file ${file.path}`);
        this.entries.delete(file.path);
        entry.file = makeFile(newPath);
        this.entries.set(newPath, entry);
      },
    };
    return { vault, fileManager } as unknown as App;
  }
}
