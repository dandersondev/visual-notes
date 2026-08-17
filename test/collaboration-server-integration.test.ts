// @vitest-environment jsdom
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import { CollaborationSession } from '../src/collaboration-session';
import {
  WebSocketCollaborationTransport,
  type CollaborationWebSocket,
} from '../src/collaboration-websocket-transport';
import type { CollaborationIdentity } from '../src/collaboration-identity';
import type { StickyCard, VisualNotesFile } from '../src/file-types';

const projectRoot = join(__dirname, '..');
const dataDirectory = mkdtempSync(join(tmpdir(), 'visual-notes-collab-'));
const port = 20_000 + (process.pid % 10_000);
const url = `ws://127.0.0.1:${port}`;
const token = 'integration-test-token';
const compatibility = { pluginVersion: '1.2.4', obsidianVersion: '1.6.5', supportedBoardVersions: [2, 3] };
let server: ChildProcess;

const alice: CollaborationIdentity = {
  clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', displayName: 'Alice', color: '#e57373',
};
const bob: CollaborationIdentity = {
  clientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', displayName: 'Bob', color: '#4fc3f7',
};

function board(): VisualNotesFile {
  return {
    version: 3, layout: 'freeform', cards: [
      { id: 'a', kind: 'sticky', text: 'A', color: '#fff' },
      { id: 'b', kind: 'sticky', text: 'B', color: '#fff' },
    ], connections: [], drawings: [],
  };
}

function transport(authToken = token): WebSocketCollaborationTransport {
  return new WebSocketCollaborationTransport({
    url, token: authToken, compatibility,
    socketFactory: socketUrl => new NodeWebSocket(socketUrl) as unknown as CollaborationWebSocket,
    reconnectDelaysMs: [20], heartbeatMs: 60_000,
  });
}

function privateTransport(
  accessToken: string,
  clientCompatibility = compatibility,
): WebSocketCollaborationTransport {
  return new WebSocketCollaborationTransport({
    url, token, accessToken, compatibility: clientCompatibility,
    socketFactory: socketUrl => new NodeWebSocket(socketUrl) as unknown as CollaborationWebSocket,
    reconnectDelaysMs: [20], heartbeatMs: 60_000,
  });
}

function session(identity: CollaborationIdentity): CollaborationSession {
  return new CollaborationSession({
    roomId: 'integration-room', boardId: 'integration-board', identity,
    initialBoard: board(), transport: transport(),
  });
}

beforeAll(async () => { server = await startServer(); }, 15_000);
afterAll(async () => {
  await stopServer(server);
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe('local collaboration development server', () => {
  it('connects separate clients, broadcasts edits, and persists through restart', async () => {
    const a = session(alice);
    const b = session(bob);
    await Promise.all([a.connect(), b.connect()]);
    await a.submit({ kind: 'set', path: ['cards', { id: 'a' }, 'text'], value: 'Across a real socket' });
    await waitFor(() => (b.getState().board.cards[0] as StickyCard).text === 'Across a real socket');
    await Promise.all([
      a.submit({ kind: 'set', path: ['cards', { id: 'a' }, 'text'], value: 'Concurrent Alice' }),
      b.submit({ kind: 'set', path: ['cards', { id: 'b' }, 'text'], value: 'Concurrent Bob' }),
    ]);
    await waitFor(() => (a.getState().board.cards[1] as StickyCard).text === 'Concurrent Bob');
    await waitFor(() => (b.getState().board.cards[0] as StickyCard).text === 'Concurrent Alice');
    expect(a.getState().collaborators.map(person => person.displayName).sort()).toEqual(['Alice', 'Bob']);
    await Promise.all([a.disconnect(), b.disconnect()]);

    await stopServer(server);
    server = await startServer();
    const restored = session(bob);
    await restored.connect();
    expect((restored.getState().board.cards[0] as StickyCard).text).toBe('Concurrent Alice');
    expect((restored.getState().board.cards[1] as StickyCard).text).toBe('Concurrent Bob');
    await restored.disconnect();
  }, 15_000);

  it('rejects an invalid development token', async () => {
    const invalid = new CollaborationSession({
      roomId: 'private-room', boardId: 'integration-board', identity: alice,
      initialBoard: board(), transport: transport('wrong-token'),
    });
    await expect(invalid.connect()).rejects.toThrow(/unauthorized|token/i);
  });

  it('shares deduplicated room images without exposing them across rooms or to viewer uploads', async () => {
    const created = await roomRequest<{
      roomId: string; accessToken: string; role: 'owner'; viewerInviteCode: string;
    }>('/rooms', { initialBoard: board(), identity: alice });
    const bytes = Buffer.from('a small pretend png');
    const assetHash = createHash('sha256').update(bytes).digest('hex');
    const ownerHeaders = assetHeaders(created.roomId, alice.clientId, created.accessToken, 'image/png');
    const upload = await fetch(`http://127.0.0.1:${port}/assets/${assetHash}`, {
      method: 'PUT', headers: ownerHeaders, body: bytes,
    });
    expect(upload.status).toBe(200);
    const duplicate = await fetch(`http://127.0.0.1:${port}/assets/${assetHash}`, {
      method: 'PUT', headers: ownerHeaders, body: bytes,
    });
    expect(duplicate.status).toBe(200);
    const extra = Buffer.from('0123456789');
    const extraHash = createHash('sha256').update(extra).digest('hex');
    const overQuota = await fetch(`http://127.0.0.1:${port}/assets/${extraHash}`, {
      method: 'PUT', headers: ownerHeaders, body: extra,
    });
    expect(overQuota.status).toBe(400);
    await expect(overQuota.json()).resolves.toMatchObject({ error: expect.stringMatching(/storage limit/i) });
    const download = await fetch(`http://127.0.0.1:${port}/assets/${assetHash}`, {
      headers: assetHeaders(created.roomId, alice.clientId, created.accessToken),
    });
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);

    const viewerIdentity = { ...bob, clientId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', displayName: 'Asset viewer' };
    const viewer = await roomRequest<{ accessToken: string }>(
      '/rooms/resolve', { inviteCode: created.viewerInviteCode, identity: viewerIdentity },
    );
    const viewerDownload = await fetch(`http://127.0.0.1:${port}/assets/${assetHash}`, {
      headers: assetHeaders(created.roomId, viewerIdentity.clientId, viewer.accessToken),
    });
    expect(viewerDownload.status).toBe(200);
    const viewerUpload = await fetch(`http://127.0.0.1:${port}/assets/${assetHash}`, {
      method: 'PUT', headers: assetHeaders(created.roomId, viewerIdentity.clientId, viewer.accessToken, 'image/png'), body: bytes,
    });
    expect(viewerUpload.status).toBe(403);

    const other = await roomRequest<{ roomId: string; accessToken: string }>(
      '/rooms', { initialBoard: board(), identity: bob },
    );
    const crossRoom = await fetch(`http://127.0.0.1:${port}/assets/${assetHash}`, {
      headers: assetHeaders(other.roomId, bob.clientId, other.accessToken),
    });
    expect(crossRoom.status).toBe(404);

    const management = await roomRequest<{ storage: { usedBytes: number; limitBytes: number } }>(
      '/rooms/manage', { roomId: created.roomId, clientId: alice.clientId, accessToken: created.accessToken },
    );
    expect(management.storage).toMatchObject({ usedBytes: bytes.byteLength, limitBytes: 24 });
    const preflight = await fetch(`http://127.0.0.1:${port}/assets/${assetHash}`, {
      method: 'OPTIONS', headers: { origin: 'app://obsidian.md', 'access-control-request-method': 'PUT' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toContain('PUT');
  });

  it('issues room-scoped video tickets and streams byte ranges', async () => {
    const created = await roomRequest<{
      roomId: string; accessToken: string; role: 'owner'; viewerInviteCode: string;
    }>('/rooms', { initialBoard: board(), identity: alice });
    const video = Buffer.from('0123456789abcdef');
    const videoHash = createHash('sha256').update(video).digest('hex');
    const credentials = assetHeaders(created.roomId, alice.clientId, created.accessToken, 'video/mp4');
    const upload = await fetch(`http://127.0.0.1:${port}/assets/${videoHash}`, {
      method: 'PUT', headers: credentials, body: video,
    });
    expect(upload.status).toBe(200);

    const ticketResponse = await fetch(`http://127.0.0.1:${port}/assets/${videoHash}/ticket`, {
      method: 'POST', headers: assetHeaders(created.roomId, alice.clientId, created.accessToken),
    });
    expect(ticketResponse.status).toBe(200);
    const { ticket } = await ticketResponse.json() as { ticket: string };
    const range = await fetch(`http://127.0.0.1:${port}/assets/${videoHash}?ticket=${encodeURIComponent(ticket)}`, {
      headers: { range: 'bytes=2-6' },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get('accept-ranges')).toBe('bytes');
    expect(range.headers.get('content-range')).toBe(`bytes 2-6/${video.length}`);
    expect(Buffer.from(await range.arrayBuffer()).toString()).toBe('23456');

    const invalidRange = await fetch(`http://127.0.0.1:${port}/assets/${videoHash}?ticket=${encodeURIComponent(ticket)}`, {
      headers: { range: 'bytes=999-' },
    });
    expect(invalidRange.status).toBe(416);
    const invalidTicket = await fetch(`http://127.0.0.1:${port}/assets/${videoHash}?ticket=wrong`);
    expect(invalidTicket.status).toBe(403);

    const viewerIdentity = { ...bob, clientId: '12121212-1212-4212-8212-121212121212', displayName: 'Video viewer' };
    const viewer = await roomRequest<{ accessToken: string }>(
      '/rooms/resolve', { inviteCode: created.viewerInviteCode, identity: viewerIdentity },
    );
    const viewerTicket = await fetch(`http://127.0.0.1:${port}/assets/${videoHash}/ticket`, {
      method: 'POST', headers: assetHeaders(created.roomId, viewerIdentity.clientId, viewer.accessToken),
    });
    expect(viewerTicket.status).toBe(200);
  });

  it('creates parent-authorized child rooms and revokes inherited access', async () => {
    const parent = await roomRequest<{
      roomId: string; accessToken: string; role: 'owner'; inviteCode: string; viewerInviteCode: string;
    }>('/rooms', { initialBoard: board(), identity: alice });
    const bobParent = await roomRequest<{ roomId: string; accessToken: string; role: 'editor' }>(
      '/rooms/resolve', { inviteCode: parent.inviteCode, identity: bob },
    );
    const childBoard = board();
    (childBoard.cards[0] as StickyCard).text = 'Nested board';
    const child = await roomRequest<{ roomId: string; accessToken: string; role: 'owner' }>(
      '/rooms/children', {
        parentRoomId: parent.roomId, clientId: alice.clientId, accessToken: parent.accessToken,
        identity: alice, childKey: 'first-child', initialBoard: childBoard,
      },
    );
    expect(child.roomId).toMatch(/^private:/);
    expect(child.accessToken).toBe(parent.accessToken);

    const retriedChild = await roomRequest<{ roomId: string; accessToken: string; role: 'owner' }>(
      '/rooms/children', {
        parentRoomId: parent.roomId, clientId: alice.clientId, accessToken: parent.accessToken,
        identity: alice, childKey: 'first-child', initialBoard: board(),
      },
    );
    expect(retriedChild.roomId).toBe(child.roomId);

    const opened = await roomRequest<{ roomId: string; accessToken: string; role: 'editor'; board: VisualNotesFile }>(
      '/rooms/children/open', {
        parentRoomId: parent.roomId, childRoomId: child.roomId,
        clientId: bob.clientId, accessToken: bobParent.accessToken, identity: bob,
      },
    );
    expect(opened).toMatchObject({ roomId: child.roomId, role: 'editor' });
    expect((opened.board.cards[0] as StickyCard).text).toBe('Nested board');

    const grandchild = await roomRequest<{ roomId: string; accessToken: string; role: 'owner' }>(
      '/rooms/children', {
        parentRoomId: child.roomId, clientId: alice.clientId, accessToken: parent.accessToken,
        identity: alice, childKey: 'grandchild', initialBoard: board(),
      },
    );
    expect(grandchild.roomId).not.toBe(child.roomId);
    await expect(roomRequest('/rooms/children/open', {
      parentRoomId: grandchild.roomId, childRoomId: parent.roomId,
      clientId: alice.clientId, accessToken: parent.accessToken, identity: alice,
    })).resolves.toMatchObject({ roomId: parent.roomId, role: 'owner' });
    await expect(roomRequest('/rooms/children/open', {
      parentRoomId: parent.roomId, childRoomId: grandchild.roomId,
      clientId: bob.clientId, accessToken: bobParent.accessToken, identity: bob,
    })).resolves.toMatchObject({ roomId: grandchild.roomId, role: 'editor' });

    const managedTree = await roomRequest<{ tree: Array<{ roomId: string; parentRoomId?: string; depth: number }> }>(
      '/rooms/manage', { roomId: parent.roomId, clientId: alice.clientId, accessToken: parent.accessToken },
    );
    expect(managedTree.tree).toEqual(expect.arrayContaining([
      expect.objectContaining({ roomId: parent.roomId, depth: 0 }),
      expect.objectContaining({ roomId: child.roomId, parentRoomId: parent.roomId, depth: 1 }),
      expect.objectContaining({ roomId: grandchild.roomId, parentRoomId: child.roomId, depth: 2 }),
    ]));
    const exportedTree = await roomRequest<{ export: { tree: Array<{ roomId: string }> } }>(
      '/rooms/export', { roomId: parent.roomId, clientId: alice.clientId, accessToken: parent.accessToken },
    );
    expect(exportedTree.export.tree.map(entry => entry.roomId)).toEqual(
      expect.arrayContaining([parent.roomId, child.roomId, grandchild.roomId]),
    );

    const ownerSession = new CollaborationSession({
      roomId: child.roomId, boardId: child.roomId, identity: alice,
      initialBoard: childBoard, transport: privateTransport(parent.accessToken),
    });
    const editorSession = new CollaborationSession({
      roomId: child.roomId, boardId: child.roomId, identity: bob,
      initialBoard: opened.board, transport: privateTransport(bobParent.accessToken),
    });
    await Promise.all([ownerSession.connect(), editorSession.connect()]);
    await editorSession.submit({ kind: 'set', path: ['cards', { id: 'a' }, 'text'], value: 'Edited inside child' });
    await waitFor(() => (ownerSession.getState().board.cards[0] as StickyCard).text === 'Edited inside child');

    const viewerIdentity = { ...bob, clientId: '56565656-5656-4565-8565-565656565656', displayName: 'Nested viewer' };
    const viewerParent = await roomRequest<{ accessToken: string; role: 'viewer' }>(
      '/rooms/resolve', { inviteCode: parent.viewerInviteCode, identity: viewerIdentity },
    );
    await expect(roomRequest('/rooms/children/open', {
      parentRoomId: parent.roomId, childRoomId: child.roomId,
      clientId: viewerIdentity.clientId, accessToken: viewerParent.accessToken, identity: viewerIdentity,
    })).resolves.toMatchObject({ role: 'viewer' });

    await roomRequest('/rooms/members/remove', {
      roomId: parent.roomId, clientId: alice.clientId, accessToken: parent.accessToken,
      memberClientId: bob.clientId,
    });
    await editorSession.updatePresence({ selectedIds: ['a'] });
    await waitFor(() => editorSession.getState().status === 'disconnected');
    const reopened = new CollaborationSession({
      roomId: child.roomId, boardId: child.roomId, identity: bob,
      initialBoard: opened.board, transport: privateTransport(bobParent.accessToken),
    });
    await expect(reopened.connect()).rejects.toThrow(/forbidden|revoked|access/i);
    await ownerSession.disconnect();

    await expect(roomRequest('/rooms/delete', {
      roomId: parent.roomId, clientId: alice.clientId, accessToken: parent.accessToken,
    })).resolves.toMatchObject({ deleted: true, deletedRooms: 3 });
    await expect(roomRequest('/rooms/children/open', {
      parentRoomId: parent.roomId, childRoomId: grandchild.roomId,
      clientId: alice.clientId, accessToken: parent.accessToken, identity: alice,
    })).rejects.toThrow(/no room|invite/i);
  });

  it('retains orphaned media for recovery and only deletes globally unregistered files', async () => {
    const bytes = Buffer.from('lifecycle');
    const assetHash = createHash('sha256').update(bytes).digest('hex');
    const asset = { hash: assetHash, mimeType: 'image/png', size: bytes.byteLength, name: 'lifecycle.png' };
    const mediaCard = {
      id: 'media', kind: 'image' as const, source: { type: 'vault' as const, path: '_Assets/lifecycle.png', sharedAsset: asset },
      captionHidden: true,
    };
    const initial = board(); initial.cards = [mediaCard];
    const first = await roomRequest<{ roomId: string; accessToken: string; role: 'owner' }>(
      '/rooms', { initialBoard: initial, identity: alice },
    );
    const upload = await fetch(`http://127.0.0.1:${port}/assets/${assetHash}`, {
      method: 'PUT', headers: assetHeaders(first.roomId, alice.clientId, first.accessToken, 'image/png'), body: bytes,
    });
    expect(upload.status).toBe(200);
    const firstCredentials = { roomId: first.roomId, clientId: alice.clientId, accessToken: first.accessToken };
    await expect(roomRequest<{ storage: { activeBytes: number; orphanedCount: number } }>('/rooms/manage', firstCredentials))
      .resolves.toMatchObject({ storage: { activeBytes: bytes.byteLength, orphanedCount: 0 } });

    const live = new CollaborationSession({
      roomId: first.roomId, boardId: first.roomId, identity: alice, initialBoard: initial,
      transport: privateTransport(first.accessToken),
    });
    await live.connect();
    await live.submit({ kind: 'delete', path: ['cards', { id: 'media' }] });
    await expect(roomRequest<{ storage: { orphanedCount: number } }>('/rooms/manage', firstCredentials))
      .resolves.toMatchObject({ storage: { orphanedCount: 1 } });
    await live.submit({ kind: 'insert', path: ['cards'], value: mediaCard });
    await expect(roomRequest<{ storage: { activeBytes: number; orphanedCount: number } }>('/rooms/manage', firstCredentials))
      .resolves.toMatchObject({ storage: { activeBytes: bytes.byteLength, orphanedCount: 0 } });

    const secondIdentity = { ...bob, clientId: '34343434-3434-4434-8434-343434343434', displayName: 'Second owner' };
    const second = await roomRequest<{ roomId: string; accessToken: string; role: 'owner' }>(
      '/rooms', { initialBoard: initial, identity: secondIdentity },
    );
    const secondUpload = await fetch(`http://127.0.0.1:${port}/assets/${assetHash}`, {
      method: 'PUT', headers: assetHeaders(second.roomId, secondIdentity.clientId, second.accessToken, 'image/png'), body: bytes,
    });
    expect(secondUpload.status).toBe(200);

    await live.submit({ kind: 'delete', path: ['cards', { id: 'media' }] });
    await new Promise(resolve => setTimeout(resolve, 75));
    const cleaned = await roomRequest<{ removedFromRoom: number; deletedFiles: number }>(
      '/rooms/assets/cleanup', firstCredentials,
    );
    expect(cleaned).toEqual({ removedFromRoom: 1, deletedFiles: 0 });
    expect(existsSync(join(dataDirectory, 'assets', assetHash))).toBe(true);
    const secondDownload = await fetch(`http://127.0.0.1:${port}/assets/${assetHash}`, {
      headers: assetHeaders(second.roomId, secondIdentity.clientId, second.accessToken),
    });
    expect(secondDownload.status).toBe(200);

    const exported = await roomRequest<{ export: { board: VisualNotesFile; assets: unknown[] } }>(
      '/rooms/export', { roomId: second.roomId, clientId: secondIdentity.clientId, accessToken: second.accessToken },
    );
    expect(exported.export.board.cards).toHaveLength(1);
    expect(exported.export.assets).toHaveLength(1);
    const deleted = await roomRequest<{ deleted: boolean; deletedFiles: number }>(
      '/rooms/delete', { roomId: second.roomId, clientId: secondIdentity.clientId, accessToken: second.accessToken },
    );
    expect(deleted).toEqual({ deleted: true, deletedRooms: 1, deletedFiles: 1 });
    expect(existsSync(join(dataDirectory, 'assets', assetHash))).toBe(false);
    await live.disconnect();
  });

  it('creates an invite-only room whose clients may use different local board paths', async () => {
    const created = await roomRequest<{
      roomId: string; accessToken: string; role: 'owner'; inviteCode: string; viewerInviteCode: string;
    }>('/rooms', { initialBoard: board(), identity: alice });
    expect(created.roomId).toMatch(/^private:/);
    expect(created.inviteCode).toMatch(/^VN2-[A-Z2-9]{10}-[A-Z2-9]{12}$/);
    expect(created.viewerInviteCode).toMatch(/^VN2-[A-Z2-9]{10}-[A-Z2-9]{12}$/);

    const resolved = await roomRequest<{ roomId: string; accessToken: string; role: 'editor' }>(
      '/rooms/resolve', { inviteCode: created.inviteCode, identity: bob },
    );
    expect(resolved).toMatchObject({ roomId: created.roomId, role: 'editor' });

    const a = new CollaborationSession({
      roomId: created.roomId, boardId: created.roomId, identity: alice,
      initialBoard: board(), transport: privateTransport(created.accessToken),
    });
    const b = new CollaborationSession({
      roomId: created.roomId, boardId: created.roomId, identity: bob,
      initialBoard: board(), transport: privateTransport(resolved.accessToken),
    });
    await Promise.all([a.connect(), b.connect()]);
    await a.submit({ kind: 'set', path: ['cards', { id: 'a' }, 'text'], value: 'Different vault path' });
    await waitFor(() => (b.getState().board.cards[0] as StickyCard).text === 'Different vault path');

    const newerIdentity = { ...bob, clientId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', displayName: 'Newer client' };
    const newerAccess = await roomRequest<{ roomId: string; accessToken: string; role: 'editor' }>(
      '/rooms/resolve', { inviteCode: created.inviteCode, identity: newerIdentity },
    );
    const newer = new CollaborationSession({
      roomId: created.roomId, boardId: created.roomId,
      identity: newerIdentity,
      initialBoard: board(),
      transport: privateTransport(newerAccess.accessToken, { ...compatibility, pluginVersion: '1.2.5' }),
    });
    await newer.connect();
    await waitFor(() => a.getState().compatibilityWarnings.length === 1);
    expect(a.getState().compatibilityWarnings[0]).toMatch(/different Visual Notes versions.*1\.2\.4.*1\.2\.5/i);
    await newer.disconnect();
    await Promise.all([a.disconnect(), b.disconnect()]);

    const forbidden = new CollaborationSession({
      roomId: created.roomId, boardId: created.roomId, identity: alice,
      initialBoard: board(), transport: privateTransport('wrong-access-token'),
    });
    await expect(forbidden.connect()).rejects.toThrow(/forbidden|invite/i);

    const incompatible = new CollaborationSession({
      roomId: created.roomId, boardId: created.roomId, identity: alice,
      initialBoard: board(),
      transport: privateTransport(created.accessToken, {
        pluginVersion: '0.9.0', obsidianVersion: '1.5.0', supportedBoardVersions: [2],
      }),
    });
    await expect(incompatible.connect()).rejects.toThrow(/incompatible|schema|support/i);

    const viewerIdentity = { ...bob, clientId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', displayName: 'Viewer' };
    const viewerAccess = await roomRequest<{ roomId: string; accessToken: string; role: 'viewer' }>(
      '/rooms/resolve', { inviteCode: created.viewerInviteCode, identity: viewerIdentity },
    );
    const viewer = new CollaborationSession({
      roomId: created.roomId, boardId: created.roomId, identity: viewerIdentity,
      initialBoard: board(), transport: privateTransport(viewerAccess.accessToken),
    });
    await viewer.connect();
    expect(viewer.getState().role).toBe('viewer');
    await expect(viewer.submit({ kind: 'set', path: ['cards', { id: 'a' }, 'text'], value: 'Forbidden viewer edit' }))
      .resolves.toBeDefined();
    await waitFor(() => viewer.getState().pendingOperations > 0);

    const ownerCredentials = { roomId: created.roomId, clientId: alice.clientId, accessToken: created.accessToken };
    const managed = await roomRequest<{ members: Array<{ clientId: string; role: string }> }>(
      '/rooms/manage', ownerCredentials,
    );
    expect(managed.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ clientId: alice.clientId, role: 'owner' }),
      expect.objectContaining({ clientId: viewerIdentity.clientId, role: 'viewer' }),
    ]));

    const rotated = await roomRequest<{ inviteCode: string }>(
      '/rooms/invites/rotate', { ...ownerCredentials, role: 'editor' },
    );
    const anotherIdentity = { ...bob, clientId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', displayName: 'Another editor' };
    await expect(roomRequest('/rooms/resolve', { inviteCode: created.inviteCode, identity: anotherIdentity }))
      .rejects.toThrow(/revoked|invalid/i);
    await expect(roomRequest('/rooms/resolve', { inviteCode: rotated.inviteCode, identity: anotherIdentity }))
      .resolves.toMatchObject({ role: 'editor' });

    await roomRequest('/rooms/members/remove', { ...ownerCredentials, memberClientId: viewerIdentity.clientId });
    await waitFor(() => viewer.getState().status === 'disconnected');
    const removedViewer = new CollaborationSession({
      roomId: created.roomId, boardId: created.roomId, identity: viewerIdentity,
      initialBoard: board(), transport: privateTransport(viewerAccess.accessToken),
    });
    await expect(removedViewer.connect()).rejects.toThrow(/forbidden|access|removed/i);
  });
});

async function roomRequest<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Room request failed (${response.status}).`);
  return payload;
}

function assetHeaders(roomId: string, clientId: string, accessToken: string, mimeType?: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'x-visual-notes-room': roomId,
    'x-visual-notes-client': clientId,
    'x-visual-notes-access': accessToken,
    ...(mimeType ? { 'content-type': mimeType } : {}),
  };
}

async function startServer(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['collaboration-server/dist/server.mjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      VISUAL_NOTES_COLLAB_PORT: String(port),
      VISUAL_NOTES_COLLAB_TOKEN: token,
      VISUAL_NOTES_COLLAB_DATA: dataDirectory,
      VISUAL_NOTES_COLLAB_MAX_ROOM_ASSETS: '24',
      VISUAL_NOTES_COLLAB_ASSET_GRACE_MS: '50',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr?.on('data', chunk => { errors += String(chunk); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Collaboration server exited early: ${errors}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return child;
    } catch { /* server is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Collaboration server did not start: ${errors}`);
}

// The port is derived from the pid and so is stable across runs on one
// machine. A server that outlives its suite therefore doesn't just leak, it
// makes the NEXT run fail to bind -- which is how this file failed once with
// every test skipped. Escalate to SIGKILL and wait for the exit rather than
// racing a timeout and walking away from a process still holding the port.
async function stopServer(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill();
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (graceful) return;
  child.kill('SIGKILL');
  await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 2_000))]);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for collaboration state.');
}
