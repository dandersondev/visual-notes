export interface CollaborationHostAddress {
  address: string;
  name: string;
  kind: 'tailscale' | 'private-lan' | 'private-ipv6';
}

export interface CollaborationHostStatus {
  state: 'stopped' | 'starting' | 'running' | 'error';
  address?: CollaborationHostAddress;
  port?: number;
  error?: string;
}

interface NetworkAddressRecord {
  address: string;
  family: string | number;
  internal: boolean;
}

export type NetworkInterfaceRecords = Record<string, NetworkAddressRecord[] | undefined>;

/** Spelled out rather than NodeJS.Signals, which needs @types/node. */
type HostedProcessSignal = 'SIGTERM' | 'SIGKILL';

interface HostedProcess {
  readonly exitCode: number | null;
  kill(signal?: HostedProcessSignal): boolean;
  once(event: 'exit', listener: (code: number | null) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  stderr?: { on(event: 'data', listener: (chunk: unknown) => void): void } | null;
}

export interface CollaborationHostRuntime {
  /** Paths are vault-relative, so the adapter can create and write them. */
  ensureDirectory(vaultPath: string): Promise<void>;
  writeFile(vaultPath: string, source: string): Promise<void>;
  /** Vault-relative to absolute, for loading the extracted server module. */
  resolvePath(vaultPath: string): string;
  spawn(modulePath: string, environment: Record<string, string>): HostedProcess;
  ready(url: string): Promise<boolean>;
  delay(milliseconds: number): Promise<void>;
}

export interface CollaborationHostStartOptions {
  address: CollaborationHostAddress;
  port: number;
  token: string;
  /** Vault-relative. Persistence stays behind the Obsidian adapter bridge. */
  runtimeDirectory: string;
  dataDirectory: string;
}

export class CollaborationHostManager {
  private process?: HostedProcess;
  private current: CollaborationHostStatus = { state: 'stopped' };
  private stderr = '';
  private generation = 0;

  constructor(private readonly serverSource: string, private readonly runtime: CollaborationHostRuntime) {}

  status(): CollaborationHostStatus { return { ...this.current }; }

  async start(options: CollaborationHostStartOptions): Promise<CollaborationHostStatus> {
    await this.stop();
    validateStartOptions(options);
    const generation = ++this.generation;
    this.current = { state: 'starting', address: options.address, port: options.port };
    this.stderr = '';
    try {
      await this.runtime.ensureDirectory(options.runtimeDirectory);
      await this.runtime.ensureDirectory(options.dataDirectory);
      const modulePath = joinWindowsSafe(options.runtimeDirectory, 'collaboration-server.cjs');
      await this.runtime.writeFile(modulePath, this.serverSource);
      // The module must be loaded by absolute path. Its data path deliberately
      // remains vault-relative and is resolved only by the adapter bridge.
      const child = this.runtime.spawn(this.runtime.resolvePath(modulePath), {
        VISUAL_NOTES_COLLAB_AUTH_MODE: 'development',
        VISUAL_NOTES_COLLAB_HOST: options.address.address,
        VISUAL_NOTES_COLLAB_PORT: String(options.port),
        VISUAL_NOTES_COLLAB_TOKEN: options.token,
        VISUAL_NOTES_COLLAB_DATA: options.dataDirectory,
      });
      this.process = child;
      child.stderr?.on('data', chunk => { this.stderr = `${this.stderr}${String(chunk)}`.slice(-2000); });
      child.once('error', error => this.failIfCurrent(generation, error.message));
      child.once('exit', code => {
        if (generation !== this.generation || this.current.state === 'stopped') return;
        this.process = undefined;
        this.current = { ...this.current, state: 'error', error: this.stderr.trim() || `Host process exited (${code ?? 'unknown'}).` };
      });
      const readyUrl = `http://${httpHost(options.address.address)}:${options.port}/ready`;
      for (let attempt = 0; attempt < 30; attempt++) {
        if (generation !== this.generation) return this.status();
        if (child.exitCode !== null) break;
        if (await this.runtime.ready(readyUrl)) {
          this.current = { state: 'running', address: options.address, port: options.port };
          return this.status();
        }
        await this.runtime.delay(100);
      }
      throw new Error(this.stderr.trim() || 'Private collaboration host did not become ready.');
    } catch (error) {
      if (generation === this.generation) {
        this.process?.kill();
        this.process = undefined;
        this.current = {
          state: 'error', address: options.address, port: options.port,
          error: error instanceof Error ? error.message : 'Could not start private collaboration host.',
        };
      }
      return this.status();
    }
  }

  async stop(): Promise<void> {
    this.generation++;
    const child = this.process;
    this.process = undefined;
    this.current = { state: 'stopped' };
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await Promise.race([
      exited,
      this.runtime.delay(1000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); }),
    ]);
  }

  private failIfCurrent(generation: number, error: string): void {
    if (generation !== this.generation) return;
    this.current = { ...this.current, state: 'error', error };
  }
}

export function discoverCollaborationHostAddresses(interfaces: NetworkInterfaceRecords): CollaborationHostAddress[] {
  const found: CollaborationHostAddress[] = [];
  for (const [name, records] of Object.entries(interfaces)) {
    for (const record of records ?? []) {
      if (record.internal) continue;
      const kind = addressKind(record.address, record.family);
      if (kind) found.push({ address: stripIpv6Scope(record.address), name, kind });
    }
  }
  const rank = { tailscale: 0, 'private-lan': 1, 'private-ipv6': 2 } as const;
  return found.sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name));
}

function addressKind(address: string, family: string | number): CollaborationHostAddress['kind'] | undefined {
  const host = stripIpv6Scope(address).toLowerCase();
  const ipv4 = family === 'IPv4' || family === 4;
  if (ipv4) {
    const parts = host.split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
    const [a, b] = parts;
    if (a === 100 && b >= 64 && b <= 127) return 'tailscale';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
      return 'private-lan';
    }
    return undefined;
  }
  if (host.startsWith('fc') || host.startsWith('fd') || /^fe[89ab]/.test(host)) return 'private-ipv6';
  return undefined;
}

function validateStartOptions(options: CollaborationHostStartOptions): void {
  if (!options.address.address) throw new Error('Choose a private network address.');
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) throw new Error('Host port must be between 1024 and 65535.');
  if (options.token.trim().length < 24) throw new Error('Private-network server secret must contain at least 24 characters.');
  if (!options.runtimeDirectory || !options.dataDirectory) throw new Error('Host storage directory is unavailable.');
}

function stripIpv6Scope(address: string): string { return address.replace(/%.+$/, ''); }
function httpHost(address: string): string { return address.includes(':') ? `[${stripIpv6Scope(address)}]` : address; }
function joinWindowsSafe(parent: string, child: string): string { return `${parent.replace(/[\\/]+$/, '')}/${child}`; }
