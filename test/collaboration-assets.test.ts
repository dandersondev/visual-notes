// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requestUrl: vi.fn() }));
vi.mock('obsidian', async importOriginal => ({
  ...await importOriginal<typeof import('obsidian')>(),
  requestUrl: (...args: unknown[]) => mocks.requestUrl(...args),
}));

import { TFile, type App } from 'obsidian';
import { CollaborationAssetClient } from '../src/collaboration-assets';
import type { VideoCard, VisualNotesFile } from '../src/file-types';

const room = { roomId: 'private:ROOM', accessToken: 'room-access', role: 'editor' as const };
const identity = { clientId: 'client-a', displayName: 'Alice', color: '#e57373' };

describe('collaboration shared media client', () => {
  beforeEach(() => mocks.requestUrl.mockReset());

  it('uploads a vault video and attaches its content-addressed fallback', async () => {
    const file = new TFile();
    file.path = '_Assets/clip.mp4'; file.name = 'clip.mp4'; file.extension = 'mp4'; file.basename = 'clip';
    const bytes = new TextEncoder().encode('video bytes').buffer;
    const app = {
      vault: {
        getAbstractFileByPath: (path: string) => path === file.path ? file : null,
        readBinary: () => Promise.resolve(bytes),
      },
    } as unknown as App;
    mocks.requestUrl.mockResolvedValue({ status: 200, text: '', json: {}, arrayBuffer: new ArrayBuffer(0) });
    const card: VideoCard = { id: 'video', kind: 'video', source: { type: 'vault', path: file.path } };
    const board: VisualNotesFile = { version: 3, layout: 'freeform', cards: [card], connections: [], drawings: [] };

    const client = new CollaborationAssetClient(app, 'ws://127.0.0.1:8787', 'dev-token', identity, null);
    await expect(client.prepareBoard(board, room)).resolves.toBe(true);
    expect(card.source.sharedAsset).toMatchObject({ mimeType: 'video/mp4', size: bytes.byteLength, name: 'clip.mp4' });
    expect(card.source.sharedAsset?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(mocks.requestUrl).toHaveBeenCalledWith(expect.objectContaining({ method: 'PUT', body: bytes }));
  });

  it('requests and caches a playback ticket without exposing the room token in the URL', async () => {
    mocks.requestUrl.mockResolvedValue({
      status: 200, text: '', json: { ticket: 'short-lived-ticket' }, arrayBuffer: new ArrayBuffer(0),
    });
    const app = { vault: {} } as unknown as App;
    const client = new CollaborationAssetClient(app, 'wss://rooms.example.com', 'dev-token', identity, null);
    const asset = { hash: 'a'.repeat(64), mimeType: 'video/webm', size: 42, name: 'clip.webm' };
    const url = await client.ensureStreamUrl(room, asset);
    expect(url).toBe(`https://rooms.example.com/assets/${asset.hash}?ticket=short-lived-ticket`);
    expect(url).not.toContain(room.accessToken);
    await client.ensureStreamUrl(room, asset);
    expect(mocks.requestUrl).toHaveBeenCalledTimes(1);
  });

  it('obtains the current account token for each uncached asset request', async () => {
    mocks.requestUrl.mockResolvedValue({
      status: 200, text: '', json: { ticket: 'ticket' }, arrayBuffer: new ArrayBuffer(0),
    });
    const token = vi.fn().mockResolvedValueOnce('account-one').mockResolvedValueOnce('account-two');
    const client = new CollaborationAssetClient(
      { vault: {} } as unknown as App, 'wss://rooms.example.com', token, identity, null,
    );
    await client.ensureStreamUrl(room, { hash: 'a'.repeat(64), mimeType: 'video/mp4', size: 10 });
    await client.ensureStreamUrl(room, { hash: 'b'.repeat(64), mimeType: 'video/mp4', size: 10 });
    expect(mocks.requestUrl.mock.calls[0][0].headers.authorization).toBe('Bearer account-one');
    expect(mocks.requestUrl.mock.calls[1][0].headers.authorization).toBe('Bearer account-two');
  });
});
