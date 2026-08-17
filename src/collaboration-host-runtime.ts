import { Platform, requestUrl, type App } from 'obsidian';
import type { CollaborationHostRuntime, EmbeddedServerApi, NetworkInterfaceRecords } from './collaboration-host';

/**
 * Everything here runs on desktop only, behind Platform.isDesktopApp.
 *
 * Two rules shape this file:
 *
 * 1. **No `@types/node` in plugin source.** Obsidian's health check analyses
 *    the repo without installing dependencies, so `typeof import('node:os')`
 *    resolves to `any` there and the type-aware lint reports a cascade of
 *    no-unsafe-* against code that compiles cleanly here. The handful of Node
 *    shapes actually used are therefore declared locally, below.
 * 2. **Obsidian's API wherever it reaches.** Directory creation, file writes
 *    and the readiness probe all go through the vault adapter and requestUrl
 *    rather than node:fs and node:http. Both paths written to live inside the
 *    vault, so nothing here touches the filesystem outside it.
 *
 * What genuinely has no Obsidian equivalent -- enumerating network interfaces,
 * and loading the extracted server module -- goes through Electron's loader
 * and is confined to the bottom of the file.
 */

/** The part of Node's module loader used to load the extracted server. */
interface DesktopModuleLoader {
  (id: string): unknown;
  resolve(id: string): string;
  cache: Record<string, unknown>;
}

/** node:os, narrowed to the one call needed to list candidate host addresses. */
interface DesktopOsModule {
  networkInterfaces(): NetworkInterfaceRecords;
}

/** node:process, narrowed to the environment handed to the server module. */
interface DesktopProcessModule {
  env: Record<string, string | undefined>;
}

/** The contract the embedded server bundle exposes back to the plugin. */
interface EmbeddedServerModule extends EmbeddedServerApi {
  stopCollaborationServer(): Promise<void>;
}

interface CollaborationStorageBridge {
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

interface CollaborationServerGlobals {
  __visualNotesCollaborationStorage?: CollaborationStorageBridge;
  __visualNotesCollaborationRequest?: typeof requestUrl;
}

const READY_TIMEOUT_MS = 500;

export function createDesktopCollaborationHostRuntime(app: App): CollaborationHostRuntime {
  const adapter = app.vault.adapter;
  return {
    async ensureDirectory(vaultPath) {
      // mkdir on an existing folder is an error for some adapters, and this
      // runs on every host start, not only the first.
      if (!await adapter.exists(vaultPath)) await adapter.mkdir(vaultPath);
    },
    writeFile: (vaultPath, source) => adapter.write(vaultPath, source),
    resolvePath(vaultPath) {
      // getFullPath belongs to FileSystemAdapter; startPrivateNetworkHost has
      // already refused a non-local vault before reaching here. Checked by
      // shape rather than instanceof so this stays testable without
      // constructing a real adapter.
      const local = adapter as Partial<{ getFullPath(path: string): string }>;
      if (typeof local.getFullPath !== 'function') {
        throw new Error('Automatic hosting requires a local desktop vault.');
      }
      return local.getFullPath(vaultPath);
    },
    spawn(modulePath, environment) {
      // On `window`, not the ambient global: the embedded server is required
      // into this same window, so this is where it reads the bridges back off.
      const serverGlobals = window as Window & CollaborationServerGlobals;
      serverGlobals.__visualNotesCollaborationStorage = createStorageBridge(app);
      serverGlobals.__visualNotesCollaborationRequest = requestUrl;
      const processModule = requireDesktopModule<DesktopProcessModule>('node:process');
      const previous = new Map<string, string | undefined>();
      for (const [key, value] of Object.entries(environment)) {
        previous.set(key, processModule.env[key]);
        processModule.env[key] = value;
      }
      let serverModule: EmbeddedServerModule;
      try {
        const loader = desktopRequire();
        const resolved = loader.resolve(modulePath);
        // The bundle is rewritten on every start, so a cached copy from a
        // previous run would silently keep serving the old server.
        delete loader.cache[resolved];
        serverModule = loader(resolved) as EmbeddedServerModule;
      } catch (error) {
        delete serverGlobals.__visualNotesCollaborationStorage;
        delete serverGlobals.__visualNotesCollaborationRequest;
        throw error;
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete processModule.env[key];
          else processModule.env[key] = value;
        }
      }
      let exitCode: number | null = null;
      const exitListeners: Array<(code: number | null) => void> = [];
      const hosted = {
        get exitCode(): number | null { return exitCode; },
        kill(): boolean {
          if (exitCode !== null) return false;
          const finish = (): void => {
            delete serverGlobals.__visualNotesCollaborationStorage;
                delete serverGlobals.__visualNotesCollaborationRequest;
            exitCode = 0;
            for (const listener of exitListeners.splice(0)) listener(0);
          };
          void serverModule.stopCollaborationServer().then(finish, finish);
          return true;
        },
        once(event: 'exit' | 'error', listener: ((code: number | null) => void) | ((error: Error) => void)) {
          if (event === 'exit') {
            exitListeners.push(listener as (value: number | null) => void);
          }
          return hosted;
        },
        stderr: null,
        // Handed straight through so the plugin can reach the room store
        // without a network route -- see EmbeddedServerApi.
        api: serverModule,
      };
      return hosted;
    },
    ready: url => readinessRequest(url),
    delay: milliseconds => new Promise(resolve => window.setTimeout(resolve, milliseconds)),
  };
}

function createStorageBridge(app: App): CollaborationStorageBridge {
  const adapter = app.vault.adapter;
  return {
    exists: path => adapter.exists(path),
    mkdir: path => adapter.mkdir(path),
    list: path => adapter.list(path),
    read: path => adapter.read(path),
    readBinary: path => adapter.readBinary(path),
    write: (path, value) => adapter.write(path, value),
    writeBinary: (path, value) => adapter.writeBinary(path, value),
    rename: (from, to) => adapter.rename(from, to),
    remove: path => adapter.remove(path),
    async stat(path) {
      const details = await adapter.stat(path);
      return details ? { size: details.size } : null;
    },
  };
}

/**
 * requestUrl has no timeout of its own, and the caller polls this in a loop
 * while the server boots -- so a request that hangs would stall the whole
 * start sequence rather than failing the attempt.
 */
async function readinessRequest(url: string): Promise<boolean> {
  let timer: number | undefined;
  try {
    const timeout = new Promise<false>(resolve => {
      timer = window.setTimeout(() => resolve(false), READY_TIMEOUT_MS);
    });
    return await Promise.race([timeout, probe(url)]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

async function probe(url: string): Promise<boolean> {
  try {
    const response = await requestUrl({ url, method: 'GET', throw: false });
    return response.status === 200 && isCollaborationHostReadyPayload(response.json);
  } catch {
    return false;
  }
}

export function isCollaborationHostReadyPayload(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (value as { ok?: unknown }).ok === true;
}

export function desktopNetworkInterfaces(): NetworkInterfaceRecords {
  return requireDesktopModule<DesktopOsModule>('node:os').networkInterfaces();
}

/**
 * Obsidian desktop exposes Electron's Node loader on window; mobile never
 * reaches here. Node modules are loaded dynamically through this one function
 * -- never by static import -- so nothing Node-only is pulled into the module
 * graph on a platform that cannot provide it.
 */
function requireDesktopModule<T>(id: string): T {
  return desktopRequire()(id) as T;
}

function desktopRequire(): DesktopModuleLoader {
  // Callers are already desktop-gated; re-checking here keeps the guard next
  // to the load itself, so neither a reader nor a static analyser has to trace
  // back through call sites to establish it.
  if (!Platform.isDesktopApp) {
    throw new Error('Hosting a collaboration room is available on desktop. Mobile devices can join.');
  }
  const loader = (window as Window & { require?: DesktopModuleLoader }).require;
  if (!loader) throw new Error('Obsidian desktop did not expose its Node module loader.');
  return loader;
}
