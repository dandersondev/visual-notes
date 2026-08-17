import { describe, expect, it, vi } from 'vitest';
import {
  CollaborationHostManager, discoverCollaborationHostAddresses,
  type CollaborationHostRuntime,
} from '../src/collaboration-host';
import { isCollaborationHostReadyPayload } from '../src/collaboration-host-runtime';

function hostProcess() {
  const listeners = new Map<string, (value: never) => void>();
  return {
    exitCode: null as number | null,
    kill: vi.fn(() => true),
    once: vi.fn(function (this: unknown, event: string, listener: (value: never) => void) {
      listeners.set(event, listener); return this;
    }),
    stderr: { on: vi.fn() },
    listeners,
  };
}

describe('desktop private-network host', () => {
  it('recognises the server readiness contract', () => {
    expect(isCollaborationHostReadyPayload({ ok: true, authMode: 'development' })).toBe(true);
    expect(isCollaborationHostReadyPayload({ ready: true })).toBe(false);
    expect(isCollaborationHostReadyPayload({ ok: false })).toBe(false);
  });
  it('prefers overlay and private addresses while excluding public interfaces', () => {
    expect(discoverCollaborationHostAddresses({
      Ethernet: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
      Tailscale: [{ address: '100.88.1.2', family: 4, internal: false }],
      Public: [{ address: '8.8.8.8', family: 'IPv4', internal: false }],
      Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      PrivateV6: [{ address: 'fd7a:115c:a1e0::1%4', family: 'IPv6', internal: false }],
    })).toEqual([
      { address: '100.88.1.2', name: 'Tailscale', kind: 'tailscale' },
      { address: '192.168.1.20', name: 'Ethernet', kind: 'private-lan' },
      { address: 'fd7a:115c:a1e0::1', name: 'PrivateV6', kind: 'private-ipv6' },
    ]);
  });

  it('writes, launches, and readiness-checks the embedded server', async () => {
    const child = hostProcess();
    const runtime: CollaborationHostRuntime = {
      ensureDirectory: vi.fn(() => Promise.resolve()),
      writeFile: vi.fn(() => Promise.resolve()),
      spawn: vi.fn(() => child),
      ready: vi.fn(() => Promise.resolve(true)),
      delay: vi.fn(() => Promise.resolve()),
    };
    const manager = new CollaborationHostManager('server source', runtime);
    const status = await manager.start({
      address: { address: '100.88.1.2', name: 'Tailscale', kind: 'tailscale' },
      port: 8787, token: 'a'.repeat(32), runtimeDirectory: 'C:/plugin/runtime', dataDirectory: 'C:/vault/data',
    });
    expect(status).toEqual({
      state: 'running', address: { address: '100.88.1.2', name: 'Tailscale', kind: 'tailscale' }, port: 8787,
    });
    expect(runtime.writeFile).toHaveBeenCalledWith('C:/plugin/runtime/collaboration-server.cjs', 'server source');
    expect(runtime.spawn).toHaveBeenCalledWith('C:/plugin/runtime/collaboration-server.cjs', expect.objectContaining({
      VISUAL_NOTES_COLLAB_HOST: '100.88.1.2', VISUAL_NOTES_COLLAB_PORT: '8787',
      VISUAL_NOTES_COLLAB_TOKEN: 'a'.repeat(32), VISUAL_NOTES_COLLAB_DATA: 'C:/vault/data',
    }));
    expect(runtime.ready).toHaveBeenCalledWith('http://100.88.1.2:8787/ready');
  });

  it('fails before spawning when its secret or port is unsafe', async () => {
    const runtime: CollaborationHostRuntime = {
      ensureDirectory: vi.fn(() => Promise.resolve()), writeFile: vi.fn(() => Promise.resolve()),
      spawn: vi.fn(() => hostProcess()), ready: vi.fn(() => Promise.resolve(true)), delay: vi.fn(() => Promise.resolve()),
    };
    const manager = new CollaborationHostManager('source', runtime);
    await expect(manager.start({
      address: { address: '192.168.1.2', name: 'LAN', kind: 'private-lan' },
      port: 80, token: 'short', runtimeDirectory: 'runtime', dataDirectory: 'data',
    })).rejects.toThrow(/port/);
    expect(runtime.spawn).not.toHaveBeenCalled();
  });
});
