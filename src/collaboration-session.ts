import type { CollaborationIdentity } from './collaboration-identity';
import {
  applyBoardOperation,
  createBoardOperation,
  type BoardOperation,
  type BoardOperationAction,
} from './collaboration-operations';
import type {
  CollaborationConnection,
  CollaborationPresence,
  CollaborationPresencePatch,
  CollaborationTransport,
  SequencedBoardOperation,
} from './collaboration-transport';
import type { VisualNotesFile } from './file-types';

export type CollaborationSessionStatus = 'disconnected' | 'connecting' | 'connected';

export interface CollaborationSessionState {
  status: CollaborationSessionStatus;
  board: VisualNotesFile;
  collaborators: CollaborationPresence[];
  pendingOperations: number;
  lastSequence: number;
  compatibilityWarnings: string[];
  role: import('./collaboration-transport').CollaborationRole;
}

export interface CollaborationSessionOptions {
  roomId: string;
  boardId: string;
  identity: CollaborationIdentity;
  initialBoard: VisualNotesFile;
  transport: CollaborationTransport;
  createOperationId?: () => string;
  now?: () => number;
  initialRole?: import('./collaboration-transport').CollaborationRole;
}

type StateListener = (state: CollaborationSessionState) => void;
type ErrorListener = (message: string) => void;

/** Client-side room state with offline editing and reconnect replay. */
export class CollaborationSession {
  private board: VisualNotesFile;
  private status: CollaborationSessionStatus = 'disconnected';
  private collaborators: CollaborationPresence[] = [];
  private connection?: CollaborationConnection;
  private logicalClock = 0;
  private lastSequence = 0;
  private pending: BoardOperation[] = [];
  private compatibilityWarnings: string[] = [];
  private role: import('./collaboration-transport').CollaborationRole = 'editor';
  private readonly incomingBySequence = new Map<number, SequencedBoardOperation>();
  private readonly seenOperationIds = new Set<string>();
  private readonly stateListeners = new Set<StateListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly now: () => number;
  private readonly createOperationId: () => string;

  constructor(private readonly options: CollaborationSessionOptions) {
    this.board = structuredClone(options.initialBoard);
    this.role = options.initialRole ?? 'editor';
    this.now = options.now ?? (() => Date.now());
    this.createOperationId = options.createOperationId ?? (() => crypto.randomUUID());
  }

  getState(): CollaborationSessionState {
    return {
      status: this.status,
      board: structuredClone(this.board),
      collaborators: structuredClone(this.collaborators),
      pendingOperations: this.pending.length,
      lastSequence: this.lastSequence,
      compatibilityWarnings: [...this.compatibilityWarnings],
      role: this.role,
    };
  }

  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.getState());
    return () => this.stateListeners.delete(listener);
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  async connect(): Promise<void> {
    if (this.status !== 'disconnected') return;
    this.status = 'connecting';
    this.emitState();
    try {
      const result = await this.options.transport.connect({
        roomId: this.options.roomId,
        boardId: this.options.boardId,
        identity: this.options.identity,
        initialBoard: this.options.initialBoard,
      }, {
        onOperation: message => this.receiveOperation(message),
        onPresence: collaborators => {
          this.collaborators = collaborators;
          this.emitState();
        },
        onSnapshot: snapshot => this.adoptRoomSnapshot(snapshot),
        onConnectionState: (status, reason) => {
          if (status === 'connecting') this.status = 'connecting';
          else if (status === 'disconnected') {
            this.status = 'disconnected';
            this.collaborators = [];
            if (reason) this.emitError(reason);
          } else {
            this.status = 'connected';
            if (this.connection) void this.flushPending();
          }
          this.emitState();
        },
        onError: message => this.emitError(message),
        onCompatibility: warnings => {
          this.compatibilityWarnings = [...warnings];
          this.emitState();
        },
      });
      this.connection = result.connection;
      this.adoptRoomSnapshot(result.snapshot);
      this.status = 'connected';
      this.emitState();
      await this.flushPending();
    } catch (error) {
      this.connection = undefined;
      this.status = 'disconnected';
      this.emitState();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.status = 'disconnected';
    this.collaborators = [];
    if (connection) await connection.disconnect();
    this.emitState();
  }

  async submit(action: BoardOperationAction): Promise<BoardOperation> {
    this.logicalClock++;
    const operation = createBoardOperation(
      this.options.identity,
      this.options.boardId,
      this.logicalClock,
      action,
      { operationId: this.createOperationId(), createdAt: this.now() },
    );
    const applied = applyBoardOperation(this.board, operation);
    if (!applied.applied) throw new Error(applied.error ?? 'Operation could not be applied.');
    this.board = applied.board;
    this.seenOperationIds.add(operation.operationId);
    if (!this.connection || this.status !== 'connected') {
      this.pending.push(operation);
      this.emitState();
      return operation;
    }
    this.emitState();
    await this.publish(operation);
    return operation;
  }

  async updatePresence(patch: CollaborationPresencePatch): Promise<void> {
    if (!this.connection || this.status !== 'connected') return;
    await this.connection.updatePresence(patch);
  }

  private receiveOperation(message: SequencedBoardOperation): void {
    this.logicalClock = Math.max(this.logicalClock, message.operation.logicalClock);
    if (message.sequence <= this.lastSequence || this.incomingBySequence.has(message.sequence)) return;
    this.incomingBySequence.set(message.sequence, message);
    if (this.status === 'connected') this.drainIncoming();
  }

  private adoptRoomSnapshot(snapshot: import('./collaboration-transport').CollaborationRoomSnapshot): void {
    this.board = structuredClone(snapshot.board);
    this.lastSequence = snapshot.sequence;
    this.logicalClock = Math.max(this.logicalClock, snapshot.maxLogicalClock);
    this.collaborators = structuredClone(snapshot.collaborators);
    this.role = snapshot.role ?? this.role;
    for (const sequence of this.incomingBySequence.keys()) {
      if (sequence <= this.lastSequence) this.incomingBySequence.delete(sequence);
    }
    this.drainIncoming();

    // Reapply edits made while disconnected on top of the current room
    // snapshot before publishing them. Their IDs are already in seen from
    // the initial local application, so self-echoes remain idempotent.
    const acceptedPending: BoardOperation[] = [];
    for (const operation of this.pending) {
      const applied = applyBoardOperation(this.board, operation);
      if (applied.applied) {
        this.board = applied.board;
        acceptedPending.push(operation);
      } else {
        this.emitError(`Could not replay offline operation ${operation.operationId}: ${applied.error ?? 'invalid operation'}`);
      }
    }
    this.pending = acceptedPending;
    this.emitState();
  }

  private drainIncoming(): void {
    let message = this.incomingBySequence.get(this.lastSequence + 1);
    while (message) {
      this.incomingBySequence.delete(message.sequence);
      this.lastSequence = message.sequence;
      if (!this.seenOperationIds.has(message.operation.operationId)) {
        const applied = applyBoardOperation(this.board, message.operation);
        if (applied.applied) {
          this.seenOperationIds.add(message.operation.operationId);
          this.board = applied.board;
        } else {
          this.emitError(`Could not apply operation ${message.operation.operationId}: ${applied.error ?? 'invalid operation'}`);
        }
      }
      message = this.incomingBySequence.get(this.lastSequence + 1);
    }
    this.emitState();
  }

  private async flushPending(): Promise<void> {
    const queued = [...this.pending];
    this.pending = [];
    for (const operation of queued) await this.publish(operation);
    this.emitState();
  }

  private async publish(operation: BoardOperation): Promise<void> {
    const connection = this.connection;
    if (!connection || this.status !== 'connected') {
      this.pending.push(operation);
      return;
    }
    const result = await connection.publish(operation);
    if (!result.accepted) {
      this.pending.push(operation);
      this.emitError(`Operation ${operation.operationId} was not accepted: ${result.error ?? 'unknown error'}`);
    } else if (result.sequence !== undefined) {
      this.lastSequence = Math.max(this.lastSequence, result.sequence);
    }
  }

  private emitState(): void {
    const state = this.getState();
    for (const listener of this.stateListeners) listener(state);
  }

  private emitError(message: string): void {
    for (const listener of this.errorListeners) listener(message);
  }
}
