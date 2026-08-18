import { describe, expect, it } from 'vitest';
import type { CollaborationIdentity } from '../src/collaboration-identity';
import { CollaborationSession } from '../src/collaboration-session';
import { createBoardOperation } from '../src/collaboration-operations';
import {
  LoopbackCollaborationTransport,
  type CollaborationConnectRequest,
  type CollaborationConnectResult,
  type CollaborationTransport,
  type CollaborationTransportHandlers,
  type SequencedBoardOperation,
} from '../src/collaboration-transport';
import type { StickyCard, VisualNotesFile } from '../src/file-types';

const identity = (clientId: string, displayName: string, color: string): CollaborationIdentity =>
  ({ clientId, displayName, color });
const alice = identity('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Alice', '#e57373');
const bob = identity('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Bob', '#4fc3f7');

function board(): VisualNotesFile {
  return {
    version: 3,
    layout: 'freeform',
    cards: [
      { id: 'a', kind: 'sticky', text: 'A', color: '#fff' },
      { id: 'b', kind: 'sticky', text: 'B', color: '#fff' },
    ],
    connections: [],
    drawings: [],
  };
}

function session(
  transport: LoopbackCollaborationTransport,
  who: CollaborationIdentity,
  roomId = 'room-1',
): CollaborationSession {
  let sequence = 0;
  return new CollaborationSession({
    roomId,
    boardId: 'board-1',
    identity: who,
    initialBoard: board(),
    transport,
    createOperationId: () => `${who.clientId}-${++sequence}`,
    now: () => 1000 + sequence,
  });
}

function text(state: ReturnType<CollaborationSession['getState']>, id: string): string {
  return (state.board.cards.find(card => card.id === id) as StickyCard).text;
}

describe('loopback collaboration sessions', () => {
  it('joins a room and shows distinct collaborator identities to everyone', async () => {
    const transport = new LoopbackCollaborationTransport(() => 500);
    const a = session(transport, alice);
    const b = session(transport, bob);
    await a.connect();
    await b.connect();

    expect(a.getState().collaborators.map(person => person.displayName)).toEqual(['Alice', 'Bob']);
    expect(b.getState().collaborators.map(person => person.clientId)).toEqual([alice.clientId, bob.clientId]);
    expect(a.getState().status).toBe('connected');
  });

  it('broadcasts a durable edit and advances the receiving logical clock', async () => {
    const transport = new LoopbackCollaborationTransport();
    const a = session(transport, alice);
    const b = session(transport, bob);
    await a.connect();
    await b.connect();

    const fromAlice = await a.submit({ kind: 'set', path: ['cards', { id: 'a' }, 'text'], value: 'Alice edit' });
    const fromBob = await b.submit({ kind: 'set', path: ['cards', { id: 'b' }, 'text'], value: 'Bob edit' });

    expect(fromAlice.logicalClock).toBe(1);
    expect(fromBob.logicalClock).toBe(2);
    for (const current of [a, b]) {
      expect(text(current.getState(), 'a')).toBe('Alice edit');
      expect(text(current.getState(), 'b')).toBe('Bob edit');
      expect(current.getState().lastSequence).toBe(2);
    }
  });

  it('broadcasts cursor and selection presence without writing it into the board', async () => {
    const transport = new LoopbackCollaborationTransport(() => 700);
    const a = session(transport, alice);
    const b = session(transport, bob);
    await a.connect();
    await b.connect();
    await a.updatePresence({ cursor: { x: 12, y: 34 }, selectedIds: ['a'] });

    const seen = b.getState().collaborators.find(person => person.clientId === alice.clientId);
    expect(seen).toMatchObject({ cursor: { x: 12, y: 34 }, selectedIds: ['a'], updatedAt: 700 });
    expect(a.getState().board).toEqual(board());
  });

  it('announces leave events and makes disconnect idempotent', async () => {
    const transport = new LoopbackCollaborationTransport();
    const a = session(transport, alice);
    const b = session(transport, bob);
    await a.connect();
    await b.connect();
    await b.disconnect();
    await b.disconnect();

    expect(a.getState().collaborators.map(person => person.displayName)).toEqual(['Alice']);
    expect(b.getState()).toMatchObject({ status: 'disconnected', collaborators: [] });
  });

  it('keeps multiple views from one device connected as one collaborator', async () => {
    const transport = new LoopbackCollaborationTransport();
    const first = session(transport, alice);
    const second = session(transport, alice);
    await first.connect();
    await second.connect();
    expect(first.getState().collaborators).toHaveLength(1);

    await first.submit({ kind: 'set', path: ['cards', { id: 'a' }, 'text'], value: 'From first view' });
    expect(text(second.getState(), 'a')).toBe('From first view');
    await second.disconnect();
    expect(first.getState().collaborators).toHaveLength(1);
  });

  it('queues offline edits, catches up, and converges after reconnect', async () => {
    const transport = new LoopbackCollaborationTransport();
    const a = session(transport, alice);
    const b = session(transport, bob);
    await a.connect();
    await b.connect();
    await b.disconnect();

    await a.submit({ kind: 'set', path: ['cards', { id: 'a' }, 'text'], value: 'While Bob was away' });
    await b.submit({ kind: 'set', path: ['cards', { id: 'b' }, 'text'], value: 'Bob offline' });
    expect(b.getState().pendingOperations).toBe(1);

    await b.connect();
    expect(b.getState().pendingOperations).toBe(0);
    for (const current of [a, b]) {
      expect(text(current.getState(), 'a')).toBe('While Bob was away');
      expect(text(current.getState(), 'b')).toBe('Bob offline');
    }
  });

  it('gives a late joiner the authoritative room snapshot', async () => {
    const transport = new LoopbackCollaborationTransport();
    const a = session(transport, alice);
    await a.connect();
    await a.submit({ kind: 'set', path: ['cards', { id: 'a' }, 'text'], value: 'Already changed' });

    const b = session(transport, bob);
    await b.connect();
    expect(text(b.getState(), 'a')).toBe('Already changed');
    expect(b.getState().lastSequence).toBe(1);
  });

  it('keeps rooms isolated even when they represent the same board', async () => {
    const transport = new LoopbackCollaborationTransport();
    const a = session(transport, alice, 'room-a');
    const b = session(transport, bob, 'room-b');
    await a.connect();
    await b.connect();
    await a.submit({ kind: 'set', path: ['cards', { id: 'a' }, 'text'], value: 'Private to room A' });

    expect(text(a.getState(), 'a')).toBe('Private to room A');
    expect(text(b.getState(), 'a')).toBe('A');
    expect(a.getState().collaborators).toHaveLength(1);
    expect(b.getState().collaborators).toHaveLength(1);
  });

  it('rejects a room ID reused for a different board', async () => {
    const transport = new LoopbackCollaborationTransport();
    const a = session(transport, alice);
    await a.connect();
    const incompatible = new CollaborationSession({
      roomId: 'room-1', boardId: 'another-board', identity: bob,
      initialBoard: board(), transport,
    });
    await expect(incompatible.connect()).rejects.toThrow(/different board/);
    expect(incompatible.getState().status).toBe('disconnected');
  });

  it('buffers out-of-order delivery and ignores repeated sequences', async () => {
    class ControlledTransport implements CollaborationTransport {
      handlers?: CollaborationTransportHandlers;
      connect(request: CollaborationConnectRequest, handlers: CollaborationTransportHandlers): Promise<CollaborationConnectResult> {
        this.handlers = handlers;
        return Promise.resolve({
          connection: {
            roomId: request.roomId, clientId: request.identity.clientId,
            publish: () => Promise.resolve({ accepted: true }),
            updatePresence: () => Promise.resolve(),
            disconnect: () => Promise.resolve(),
          },
          snapshot: {
            roomId: request.roomId, boardId: request.boardId, board: request.initialBoard,
            sequence: 0, maxLogicalClock: 0, collaborators: [],
          },
        });
      }
      deliver(message: SequencedBoardOperation): void { this.handlers?.onOperation(message); }
    }

    const transport = new ControlledTransport();
    const current = new CollaborationSession({
      roomId: 'ordered', boardId: 'board-1', identity: alice, initialBoard: board(), transport,
    });
    await current.connect();
    const first = createBoardOperation(bob, 'board-1', 1, {
      kind: 'set', path: ['cards', { id: 'a' }, 'text'], value: 'first',
    }, { operationId: 'first', createdAt: 1 });
    const second = createBoardOperation(bob, 'board-1', 2, {
      kind: 'set', path: ['cards', { id: 'b' }, 'text'], value: 'second',
    }, { operationId: 'second', createdAt: 2 });

    transport.deliver({ sequence: 2, operation: second });
    expect(text(current.getState(), 'b')).toBe('B');
    transport.deliver({ sequence: 1, operation: first });
    transport.deliver({ sequence: 1, operation: first });
    expect(text(current.getState(), 'a')).toBe('first');
    expect(text(current.getState(), 'b')).toBe('second');
    expect(current.getState().lastSequence).toBe(2);
  });

  it('applies a peer edit that was still in flight when the local edit was acknowledged', async () => {
    // A real socket acknowledges a publish before a peer's broadcast arrives.
    // LoopbackCollaborationTransport delivers both synchronously inside
    // publish(), so only a transport that holds messages in flight can put the
    // acknowledgement ahead of the peer operation it raced.
    class InFlightRoom implements CollaborationTransport {
      private readonly members: CollaborationTransportHandlers[] = [];
      private readonly inFlight: { handlers: CollaborationTransportHandlers; message: SequencedBoardOperation }[] = [];
      private sequence = 0;

      connect(
        request: CollaborationConnectRequest,
        handlers: CollaborationTransportHandlers,
      ): Promise<CollaborationConnectResult> {
        this.members.push(handlers);
        return Promise.resolve({
          connection: {
            roomId: request.roomId,
            clientId: request.identity.clientId,
            publish: (operation) => {
              const message = { sequence: ++this.sequence, operation: structuredClone(operation) };
              for (const member of this.members) this.inFlight.push({ handlers: member, message: structuredClone(message) });
              return Promise.resolve({ accepted: true, sequence: message.sequence });
            },
            updatePresence: () => Promise.resolve(),
            disconnect: () => Promise.resolve(),
          },
          snapshot: {
            roomId: request.roomId, boardId: request.boardId, board: board(),
            sequence: 0, maxLogicalClock: 0, collaborators: [],
          },
        });
      }

      deliverAll(): void {
        for (const item of this.inFlight.splice(0, this.inFlight.length)) item.handlers.onOperation(item.message);
      }
    }

    const transport = new InFlightRoom();
    const peer = (who: CollaborationIdentity): CollaborationSession => {
      let count = 0;
      return new CollaborationSession({
        roomId: 'race', boardId: 'board-1', identity: who, initialBoard: board(), transport,
        createOperationId: () => `${who.clientId}-${++count}`,
      });
    };
    const a = peer(alice);
    const b = peer(bob);
    await a.connect();
    await b.connect();

    await a.submit({ kind: 'set', path: ['cards', { id: 'a' }, 'text'], value: 'Alice edit' });
    await b.submit({ kind: 'set', path: ['cards', { id: 'b' }, 'text'], value: 'Bob edit' });
    transport.deliverAll();

    for (const current of [a, b]) {
      expect(text(current.getState(), 'a')).toBe('Alice edit');
      expect(text(current.getState(), 'b')).toBe('Bob edit');
    }
  });
});
