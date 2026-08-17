import type { CollaborationIdentity } from './collaboration-identity';
import { applyBoardOperation, type BoardOperation } from './collaboration-operations';
import type { VisualNotesFile } from './file-types';

export interface CollaborationPresence {
  clientId: string;
  displayName: string;
  color: string;
  cursor?: { x: number; y: number };
  selectedIds: string[];
  updatedAt: number;
}

export type CollaborationRole = 'owner' | 'editor' | 'viewer';

export interface CollaborationPresencePatch {
  cursor?: { x: number; y: number } | null;
  selectedIds?: string[];
}

export interface SequencedBoardOperation {
  sequence: number;
  operation: BoardOperation;
}

export interface CollaborationRoomSnapshot {
  roomId: string;
  boardId: string;
  board: VisualNotesFile;
  sequence: number;
  maxLogicalClock: number;
  collaborators: CollaborationPresence[];
  role?: CollaborationRole;
}

export interface CollaborationTransportHandlers {
  onOperation(message: SequencedBoardOperation): void;
  onPresence(collaborators: CollaborationPresence[]): void;
  onSnapshot?(snapshot: CollaborationRoomSnapshot): void;
  onConnectionState?(status: 'connecting' | 'connected' | 'disconnected', reason?: string): void;
  /**
   * A server-reported problem on a connection that is still open and joined.
   * Separate from onConnectionState because reporting one of these as a
   * disconnection is both untrue and unrecoverable: nothing has closed, so no
   * `close` event ever arrives and no reconnect is ever scheduled -- the
   * session simply reads "disconnected" forever while the socket is fine.
   */
  onError?(message: string): void;
  onCompatibility?(warnings: string[]): void;
}

export interface CollaborationConnectRequest {
  roomId: string;
  boardId: string;
  identity: CollaborationIdentity;
  initialBoard: VisualNotesFile;
}

export interface CollaborationPublishResult {
  accepted: boolean;
  sequence?: number;
  error?: string;
}

export interface CollaborationConnection {
  readonly roomId: string;
  readonly clientId: string;
  publish(operation: BoardOperation): Promise<CollaborationPublishResult>;
  updatePresence(patch: CollaborationPresencePatch): Promise<void>;
  disconnect(): Promise<void>;
}

export interface CollaborationConnectResult {
  connection: CollaborationConnection;
  snapshot: CollaborationRoomSnapshot;
}

export interface CollaborationTransport {
  connect(
    request: CollaborationConnectRequest,
    handlers: CollaborationTransportHandlers,
  ): Promise<CollaborationConnectResult>;
}

interface LoopbackMember {
  presence: CollaborationPresence;
  handlers: CollaborationTransportHandlers;
}

interface LoopbackRoom {
  boardId: string;
  board: VisualNotesFile;
  sequence: number;
  maxLogicalClock: number;
  operations: Map<string, SequencedBoardOperation>;
  members: Map<number, LoopbackMember>;
}

/**
 * Process-local transport used to exercise real room/session semantics with no
 * server and no network. A hosted transport can implement the same interface.
 */
export class LoopbackCollaborationTransport implements CollaborationTransport {
  private readonly rooms = new Map<string, LoopbackRoom>();
  private nextConnectionId = 1;

  constructor(private readonly now: () => number = () => Date.now()) {}

  connect(
    request: CollaborationConnectRequest,
    handlers: CollaborationTransportHandlers,
  ): Promise<CollaborationConnectResult> {
    let room = this.rooms.get(request.roomId);
    if (!room) {
      room = {
        boardId: request.boardId,
        board: structuredClone(request.initialBoard),
        sequence: 0,
        maxLogicalClock: 0,
        operations: new Map(),
        members: new Map(),
      };
      this.rooms.set(request.roomId, room);
    } else if (room.boardId !== request.boardId) {
      throw new Error(`Room "${request.roomId}" belongs to a different board.`);
    }

    const presence: CollaborationPresence = {
      clientId: request.identity.clientId,
      displayName: request.identity.displayName,
      color: request.identity.color,
      selectedIds: [],
      updatedAt: this.now(),
    };
    const connectionId = this.nextConnectionId++;
    room.members.set(connectionId, { presence, handlers });
    this.broadcastPresence(room);

    let connected = true;
    const connection: CollaborationConnection = {
      roomId: request.roomId,
      clientId: request.identity.clientId,
      publish: (operation) => {
        if (!connected) return Promise.resolve({ accepted: false, error: 'Connection is closed.' });
        if (operation.boardId !== room.boardId) return Promise.resolve({ accepted: false, error: 'Operation belongs to a different board.' });
        if (operation.clientId !== request.identity.clientId) return Promise.resolve({ accepted: false, error: 'Operation client does not match this connection.' });
        const duplicate = room.operations.get(operation.operationId);
        if (duplicate) return Promise.resolve({ accepted: true, sequence: duplicate.sequence });

        const applied = applyBoardOperation(room.board, operation);
        if (!applied.applied) return Promise.resolve({ accepted: false, error: applied.error ?? 'Operation was rejected.' });
        room.board = applied.board;
        room.sequence++;
        room.maxLogicalClock = Math.max(room.maxLogicalClock, operation.logicalClock);
        const message = { sequence: room.sequence, operation: structuredClone(operation) };
        room.operations.set(operation.operationId, message);
        for (const member of room.members.values()) member.handlers.onOperation(structuredClone(message));
        return Promise.resolve({ accepted: true, sequence: message.sequence });
      },
      updatePresence: (patch) => {
        if (!connected) return Promise.resolve();
        const member = room.members.get(connectionId);
        if (!member) return Promise.resolve();
        if (patch.cursor === null) delete member.presence.cursor;
        else if (patch.cursor !== undefined) member.presence.cursor = structuredClone(patch.cursor);
        if (patch.selectedIds !== undefined) member.presence.selectedIds = [...patch.selectedIds];
        member.presence.updatedAt = this.now();
        this.broadcastPresence(room);
        return Promise.resolve();
      },
      disconnect: () => {
        if (!connected) return Promise.resolve();
        connected = false;
        room.members.delete(connectionId);
        this.broadcastPresence(room);
        return Promise.resolve();
      },
    };

    return Promise.resolve({
      connection,
      snapshot: {
        roomId: request.roomId,
        boardId: room.boardId,
        board: structuredClone(room.board),
        sequence: room.sequence,
        maxLogicalClock: room.maxLogicalClock,
        collaborators: this.presenceList(room),
      },
    });
  }

  private broadcastPresence(room: LoopbackRoom): void {
    const collaborators = this.presenceList(room);
    for (const member of room.members.values()) member.handlers.onPresence(structuredClone(collaborators));
  }

  private presenceList(room: LoopbackRoom): CollaborationPresence[] {
    const byClient = new Map<string, CollaborationPresence>();
    for (const member of room.members.values()) {
      const current = byClient.get(member.presence.clientId);
      if (!current || current.updatedAt <= member.presence.updatedAt) byClient.set(member.presence.clientId, member.presence);
    }
    return [...byClient.values()]
      .map(presence => structuredClone(presence))
      .sort((a, b) => a.clientId.localeCompare(b.clientId));
  }
}
