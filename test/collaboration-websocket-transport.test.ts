// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketCollaborationTransport, isSafeCollaborationServerUrl, type CollaborationWebSocket } from '../src/collaboration-websocket-transport';
import type { CollaborationServerMessage } from '../src/collaboration-protocol';
import { encodeCollaborationMessage } from '../src/collaboration-protocol';
import type { CollaborationTransportHandlers } from '../src/collaboration-transport';
import type { BoardOperation } from '../src/collaboration-operations';
import type { VisualNotesFile } from '../src/file-types';

class FakeSocket extends EventTarget implements CollaborationWebSocket {
  readyState = 0;
  sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent('close', { code, reason }));
  }
  open(): void { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  receive(message: CollaborationServerMessage): void {
    this.dispatchEvent(new MessageEvent('message', { data: encodeCollaborationMessage(message) }));
  }
}

const board: VisualNotesFile = { version: 3, layout: 'freeform', cards: [], connections: [], drawings: [] };
const compatibility = { pluginVersion: '1.2.4', obsidianVersion: '1.6.5', supportedBoardVersions: [2, 3] };
const snapshot = (sequence = 0) => ({ roomId: 'room', boardId: 'board', board, sequence, maxLogicalClock: sequence, collaborators: [] });

afterEach(() => vi.useRealTimers());

describe('WebSocketCollaborationTransport', () => {
  it('only permits insecure WebSockets on loopback hosts', () => {
    expect(isSafeCollaborationServerUrl('ws://127.0.0.1:8787')).toBe(true);
    expect(isSafeCollaborationServerUrl('ws://localhost:8787')).toBe(true);
    expect(isSafeCollaborationServerUrl('wss://collab.example.com')).toBe(true);
    expect(isSafeCollaborationServerUrl('ws://collab.example.com')).toBe(false);
    expect(isSafeCollaborationServerUrl('https://example.com')).toBe(false);
  });

  it('joins, publishes with acknowledgement, and forwards operations', async () => {
    const sockets: FakeSocket[] = [];
    const handlers: CollaborationTransportHandlers = { onOperation: vi.fn(), onPresence: vi.fn() };
    const transport = new WebSocketCollaborationTransport({
      url: 'ws://localhost:8787', token: 'token', inviteCode: 'VN-ABCD-EFGH-JKLM', compatibility, socketFactory: () => {
        const socket = new FakeSocket(); sockets.push(socket); return socket;
      }, heartbeatMs: 60_000,
    });
    const connecting = transport.connect({
      roomId: 'room', boardId: 'board', initialBoard: board,
      identity: { clientId: 'client', displayName: 'Alice', color: '#abcdef' },
    }, handlers);
    sockets[0].open();
    expect(JSON.parse(sockets[0].sent[0]) as { type: string }).toMatchObject({
      type: 'join', inviteCode: 'VN-ABCD-EFGH-JKLM',
    });
    sockets[0].receive({ type: 'joined', protocolVersion: 1, snapshot: snapshot() });
    const result = await connecting;

    const operation: BoardOperation = {
      schemaVersion: 1, operationId: 'op', boardId: 'board', clientId: 'client',
      actor: { displayName: 'Alice', color: '#abcdef' }, logicalClock: 1, createdAt: 1,
      action: { kind: 'set', path: ['layout'], value: 'freeform' },
    };
    const publishing = result.connection.publish(operation);
    sockets[0].receive({ type: 'operation-accepted', operationId: 'op', sequence: 1 });
    await expect(publishing).resolves.toEqual({ accepted: true, sequence: 1 });
    sockets[0].receive({ type: 'operation', message: { sequence: 1, operation } });
    expect(handlers.onOperation).toHaveBeenCalledWith({ sequence: 1, operation });
    await result.connection.disconnect();
  });

  // Regression: hosting a room and moving a card showed "disconnected" with no
  // error. Nothing had disconnected. The server rejects a bad message by
  // sending {type:'error'} on a socket it deliberately leaves open, and the
  // client reported every one of those as a disconnection. Because no close
  // event follows, scheduleReconnect() never ran either, so the session stayed
  // "disconnected" while the socket was healthy the whole time.
  it('reports a post-join server error without claiming to be disconnected', async () => {
    const sockets: FakeSocket[] = [];
    const handlers: CollaborationTransportHandlers = {
      onOperation: vi.fn(), onPresence: vi.fn(), onConnectionState: vi.fn(), onError: vi.fn(),
    };
    const transport = new WebSocketCollaborationTransport({
      url: 'ws://localhost:8787', token: 'token', compatibility, socketFactory: () => {
        const socket = new FakeSocket(); sockets.push(socket); return socket;
      }, heartbeatMs: 60_000,
    });
    const connecting = transport.connect({
      roomId: 'room', boardId: 'board', initialBoard: board,
      identity: { clientId: 'client', displayName: 'Alice', color: '#abcdef' },
    }, handlers);
    sockets[0].open();
    sockets[0].receive({ type: 'joined', protocolVersion: 1, snapshot: snapshot() });
    const result = await connecting;
    vi.mocked(handlers.onConnectionState!).mockClear();

    sockets[0].receive({ type: 'error', code: 'invalid-message', message: 'Room storage failed.' });

    expect(handlers.onError).toHaveBeenCalledWith('invalid-message: Room storage failed.');
    expect(handlers.onConnectionState).not.toHaveBeenCalledWith('disconnected', expect.anything());
    // Still joined, so the next edit still publishes rather than being told
    // the server is offline.
    expect(sockets[0].readyState).toBe(1);
    await result.connection.disconnect();
  });

  it('still treats an error before joining as fatal', async () => {
    const sockets: FakeSocket[] = [];
    const handlers: CollaborationTransportHandlers = {
      onOperation: vi.fn(), onPresence: vi.fn(), onConnectionState: vi.fn(), onError: vi.fn(),
    };
    const transport = new WebSocketCollaborationTransport({
      url: 'ws://localhost:8787', token: 'token', compatibility, socketFactory: () => {
        const socket = new FakeSocket(); sockets.push(socket); return socket;
      }, heartbeatMs: 60_000,
    });
    const connecting = transport.connect({
      roomId: 'room', boardId: 'board', initialBoard: board,
      identity: { clientId: 'client', displayName: 'Alice', color: '#abcdef' },
    }, handlers);
    sockets[0].open();
    sockets[0].receive({ type: 'error', code: 'unauthorized', message: 'Server access secret is invalid.' });
    await expect(connecting).rejects.toThrow(/unauthorized/);
    expect(handlers.onConnectionState).toHaveBeenCalledWith('disconnected', expect.stringContaining('unauthorized'));
  });

  it('reconnects and delivers the new authoritative snapshot', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const handlers: CollaborationTransportHandlers = {
      onOperation: vi.fn(), onPresence: vi.fn(), onSnapshot: vi.fn(), onConnectionState: vi.fn(),
    };
    const transport = new WebSocketCollaborationTransport({
      url: 'ws://localhost:8787', token: 'token', compatibility, socketFactory: () => {
        const socket = new FakeSocket(); sockets.push(socket); return socket;
      }, reconnectDelaysMs: [10], heartbeatMs: 60_000,
    });
    const connecting = transport.connect({
      roomId: 'room', boardId: 'board', initialBoard: board,
      identity: { clientId: 'client', displayName: 'Alice', color: '#abcdef' },
    }, handlers);
    sockets[0].open();
    sockets[0].receive({ type: 'joined', protocolVersion: 1, snapshot: snapshot() });
    const result = await connecting;
    sockets[0].close(1006, 'network lost');
    await vi.advanceTimersByTimeAsync(10);
    sockets[1].open();
    sockets[1].receive({ type: 'joined', protocolVersion: 1, snapshot: snapshot(4) });

    expect(handlers.onSnapshot).toHaveBeenCalledWith(snapshot(4));
    expect(handlers.onConnectionState).toHaveBeenLastCalledWith('connected');
    await result.connection.disconnect();
  });

  it('gets a fresh service token for the initial join and every reconnect', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const token = vi.fn()
      .mockResolvedValueOnce('account-token-one')
      .mockResolvedValueOnce('account-token-two');
    const transport = new WebSocketCollaborationTransport({
      url: 'ws://localhost:8787', token, compatibility, socketFactory: () => {
        const socket = new FakeSocket(); sockets.push(socket); return socket;
      }, reconnectDelaysMs: [10], heartbeatMs: 60_000,
    });
    const connecting = transport.connect({
      roomId: 'room', boardId: 'board', initialBoard: board,
      identity: { clientId: 'client', displayName: 'Alice', color: '#abcdef' },
    }, { onOperation: vi.fn(), onPresence: vi.fn() });
    sockets[0].open();
    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(1));
    expect(JSON.parse(sockets[0].sent[0]) as { token: string }).toMatchObject({ token: 'account-token-one' });
    sockets[0].receive({ type: 'joined', protocolVersion: 1, snapshot: snapshot() });
    const result = await connecting;
    sockets[0].close(1006, 'network lost');
    await vi.advanceTimersByTimeAsync(10);
    sockets[1].open();
    await vi.waitFor(() => expect(sockets[1].sent).toHaveLength(1));
    expect(JSON.parse(sockets[1].sent[0]) as { token: string }).toMatchObject({ token: 'account-token-two' });
    expect(token).toHaveBeenCalledTimes(2);
    await result.connection.disconnect();
  });
});
