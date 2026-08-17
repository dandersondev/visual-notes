import type { CollaborationHostRuntime, NetworkInterfaceRecords } from './collaboration-host';

export function createDesktopCollaborationHostRuntime(): CollaborationHostRuntime {
  const { mkdir, writeFile } = requireDesktopModule<typeof import('node:fs/promises')>('node:fs/promises');
  const http = requireDesktopModule<typeof import('node:http')>('node:http');
  const https = requireDesktopModule<typeof import('node:https')>('node:https');
  return {
    ensureDirectory: path => mkdir(path, { recursive: true }).then(() => undefined),
    writeFile: (path, source) => writeFile(path, source, { encoding: 'utf8', mode: 0o600 }),
    spawn(modulePath, environment) {
      const processModule = requireDesktopModule<typeof import('node:process')>('node:process');
      const previous = new Map<string, string | undefined>();
      for (const [key, value] of Object.entries(environment)) {
        previous.set(key, processModule.env[key]);
        processModule.env[key] = value;
      }
      let serverModule: { stopCollaborationServer(): Promise<void> };
      try {
        const loader = desktopRequire();
        const resolved = loader.resolve(modulePath);
        delete loader.cache[resolved];
        serverModule = loader(resolved) as { stopCollaborationServer(): Promise<void> };
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
          void serverModule.stopCollaborationServer().then(() => {
            exitCode = 0;
            for (const listener of exitListeners.splice(0)) listener(0);
          });
          return true;
        },
        once(event: 'exit' | 'error', listener: ((code: number | null) => void) | ((error: Error) => void)) {
          if (event === 'exit') {
            exitListeners.push(listener as (value: number | null) => void);
          }
          return hosted;
        },
        stderr: null,
      };
      return hosted;
    },
    async ready(url) {
      return nodeReadinessRequest(url, http, https);
    },
    delay: milliseconds => new Promise(resolve => window.setTimeout(resolve, milliseconds)),
  };
}

function nodeReadinessRequest(
  url: string,
  http: typeof import('node:http'),
  https: typeof import('node:https'),
): Promise<boolean> {
  return new Promise(resolve => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, { timeout: 500 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body = `${body}${String(chunk)}`.slice(0, 4096); });
      response.on('end', () => {
        if (response.statusCode !== 200) { resolve(false); return; }
        try { resolve(isCollaborationHostReadyPayload(JSON.parse(body) as unknown)); }
        catch { resolve(false); }
      });
    });
    request.once('timeout', () => { request.destroy(); resolve(false); });
    request.once('error', () => resolve(false));
  });
}

export function isCollaborationHostReadyPayload(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (value as { ok?: unknown }).ok === true;
}

export function desktopNetworkInterfaces(): NetworkInterfaceRecords {
  const { networkInterfaces } = requireDesktopModule<typeof import('node:os')>('node:os');
  return networkInterfaces();
}

/** Obsidian desktop exposes Electron's Node loader on window; mobile never calls this path. */
function requireDesktopModule<T>(id: string): T {
  return desktopRequire()(id) as T;
}

function desktopRequire(): NodeRequire {
  const loader = (window as Window & { require?: NodeRequire }).require;
  if (!loader) throw new Error('Obsidian desktop did not expose its Node module loader.');
  return loader;
}
