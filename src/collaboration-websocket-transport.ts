import {
  COLLABORATION_PROTOCOL_VERSION,
  decodeServerMessage,
  encodeCollaborationMessage,
  type CollaborationClientMessage,
  type CollaborationClientCompatibility,
} from './collaboration-protocol';
import type {
  CollaborationConnectRequest,
  CollaborationConnectResult,
  CollaborationConnection,
  CollaborationPublishResult,
  CollaborationTransport,
  CollaborationTransportHandlers,
} from './collaboration-transport';
import type { BoardOperation } from './collaboration-operations';

interface SocketEventMap {
  open: Event;
  message: MessageEvent<unknown>;
  close: CloseEvent;
  error: Event;
}

export interface CollaborationWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener<K extends keyof SocketEventMap>(type: K, listener: (event: SocketEventMap[K]) => void): void;
}

export interface WebSocketCollaborationTransportOptions {
  url: string;
  token: string | (() => Promise<string>);
  inviteCode?: string;
  accessToken?: string;
  compatibility: CollaborationClientCompatibility;
  socketFactory?: (url: string) => CollaborationWebSocket;
  heartbeatMs?: number;
  acknowledgementTimeoutMs?: number;
  reconnectDelaysMs?: number[];
}

export function isSafeCollaborationServerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'wss:') return true;
    return url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

interface PendingAcknowledgement {
  resolve(result: CollaborationPublishResult): void;
  timer: number;
}

/** Real network implementation of the same interface used by loopback rooms. */
export class WebSocketCollaborationTransport implements CollaborationTransport {
  private readonly socketFactory: (url: string) => CollaborationWebSocket;
  private readonly heartbeatMs: number;
  private readonly acknowledgementTimeoutMs: number;
  private readonly reconnectDelaysMs: number[];

  constructor(private readonly options: WebSocketCollaborationTransportOptions) {
    this.socketFactory = options.socketFactory ?? (url => new WebSocket(url));
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.acknowledgementTimeoutMs = options.acknowledgementTimeoutMs ?? 10_000;
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? [500, 1_000, 2_000, 5_000, 10_000];
  }

  connect(request: CollaborationConnectRequest, handlers: CollaborationTransportHandlers): Promise<CollaborationConnectResult> {
    const managed = new ManagedWebSocketConnection(this.options.url, this.options.token, request, handlers, {
      socketFactory: this.socketFactory,
      heartbeatMs: this.heartbeatMs,
      acknowledgementTimeoutMs: this.acknowledgementTimeoutMs,
      reconnectDelaysMs: this.reconnectDelaysMs,
      inviteCode: this.options.inviteCode,
      accessToken: this.options.accessToken,
      compatibility: this.options.compatibility,
    });
    return managed.connect();
  }
}

class ManagedWebSocketConnection implements CollaborationConnection {
  readonly roomId: string;
  readonly clientId: string;
  private socket?: CollaborationWebSocket;
  private joined = false;
  /** True once this transport has ever completed a join, so a failure can tell
   *  "never reached the host" apart from "lost a working connection". */
  private joinedOnce = false;
  private closedByUser = false;
  private fatal = false;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private initialResolve?: (result: CollaborationConnectResult) => void;
  private initialReject?: (error: Error) => void;
  private initialSettled = false;
  private readonly pending = new Map<string, PendingAcknowledgement>();

  constructor(
    private readonly url: string,
    private readonly token: string | (() => Promise<string>),
    private readonly request: CollaborationConnectRequest,
    private readonly handlers: CollaborationTransportHandlers,
    private readonly settings: {
      socketFactory: (url: string) => CollaborationWebSocket;
      heartbeatMs: number;
      acknowledgementTimeoutMs: number;
      reconnectDelaysMs: number[];
      inviteCode?: string;
      accessToken?: string;
      compatibility: CollaborationClientCompatibility;
    },
  ) {
    this.roomId = request.roomId;
    this.clientId = request.identity.clientId;
  }

  connect(): Promise<CollaborationConnectResult> {
    const promise = new Promise<CollaborationConnectResult>((resolve, reject) => {
      this.initialResolve = resolve;
      this.initialReject = reject;
    });
    this.openSocket();
    return promise;
  }

  publish(operation: BoardOperation): Promise<CollaborationPublishResult> {
    if (!this.joined || !this.socket || this.socket.readyState !== 1) {
      return Promise.resolve({ accepted: false, error: 'Collaboration server is offline.' });
    }
    return new Promise(resolve => {
      const timer = window.setTimeout(() => {
        this.pending.delete(operation.operationId);
        resolve({ accepted: false, error: 'Collaboration server did not acknowledge the operation.' });
      }, this.settings.acknowledgementTimeoutMs);
      this.pending.set(operation.operationId, { resolve, timer });
      this.send({ type: 'operation', operation });
    });
  }

  updatePresence(patch: { cursor?: { x: number; y: number } | null; selectedIds?: string[] }): Promise<void> {
    if (this.joined) this.send({ type: 'presence', ...patch });
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.closedByUser = true;
    this.joined = false;
    this.clearTimers();
    this.rejectPending('Collaboration connection was closed.');
    this.socket?.close(1000, 'Client disconnected');
    this.socket = undefined;
    return Promise.resolve();
  }

  private openSocket(): void {
    if (this.closedByUser || this.fatal) return;
    this.handlers.onConnectionState?.('connecting');
    let socket: CollaborationWebSocket;
    try { socket = this.settings.socketFactory(this.url); }
    catch (error) { this.failInitialOrReconnect(error instanceof Error ? error : new Error('Could not create WebSocket.')); return; }
    this.socket = socket;
    socket.addEventListener('open', () => { void this.joinSocket(socket); });
    socket.addEventListener('message', event => {
      if (socket !== this.socket) return;
      const text = socketMessageText(event.data);
      if (text === undefined) return;
      try { this.handleServerMessage(decodeServerMessage(text)); }
      catch (error) { this.handlers.onConnectionState?.('disconnected', error instanceof Error ? error.message : 'Invalid server message.'); }
    });
    socket.addEventListener('close', event => {
      if (socket !== this.socket) return;
      this.socket = undefined;
      this.joined = false;
      this.clearHeartbeat();
      this.rejectPending('Collaboration connection was interrupted.');
      if (event.code === 4001 || event.code === 4003 || event.code === 4004) this.fatal = true;
      if (this.closedByUser) return;
      const reason = event.reason || unreachableHostReason(event.code, this.url, this.joinedOnce);
      this.handlers.onConnectionState?.('disconnected', reason);
      if (this.fatal) this.rejectInitial(new Error(reason));
      else this.scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      // Browsers provide no useful detail here; close carries the actionable
      // code/reason and is the single reconnect path.
    });
  }

  private async joinSocket(socket: CollaborationWebSocket): Promise<void> {
    try {
      const token = typeof this.token === 'string' ? this.token : await this.token();
      if (socket !== this.socket || socket.readyState !== 1) return;
      this.send({
        type: 'join', protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        token, roomId: this.request.roomId, boardId: this.request.boardId,
        identity: this.request.identity, initialBoard: this.request.initialBoard,
        inviteCode: this.settings.inviteCode,
        accessToken: this.settings.accessToken,
        compatibility: this.settings.compatibility,
      });
    } catch (error) {
      if (socket !== this.socket) return;
      const message = error instanceof Error ? error.message : 'Could not authorize collaboration.';
      this.fatal = true;
      this.handlers.onConnectionState?.('disconnected', message);
      this.rejectInitial(new Error(message));
      socket.close(4001, message.slice(0, 120));
    }
  }

  private handleServerMessage(message: ReturnType<typeof decodeServerMessage>): void {
    if (message.type === 'joined') {
      const reconnect = this.initialSettled;
      this.joined = true;
      this.joinedOnce = true;
      this.reconnectAttempt = 0;
      this.startHeartbeat();
      if (reconnect) this.handlers.onSnapshot?.(message.snapshot);
      this.handlers.onConnectionState?.('connected');
      if (!this.initialSettled) {
        this.initialSettled = true;
        this.initialResolve?.({ connection: this, snapshot: message.snapshot });
      }
    } else if (message.type === 'operation') {
      this.handlers.onOperation(message.message);
    } else if (message.type === 'presence') {
      this.handlers.onPresence(message.collaborators);
    } else if (message.type === 'compatibility') {
      this.handlers.onCompatibility?.(message.warnings);
    } else if (message.type === 'operation-accepted' || message.type === 'operation-rejected') {
      const acknowledgement = this.pending.get(message.operationId);
      if (!acknowledgement) return;
      window.clearTimeout(acknowledgement.timer);
      this.pending.delete(message.operationId);
      acknowledgement.resolve(message.type === 'operation-accepted'
        ? { accepted: true, sequence: message.sequence }
        : { accepted: false, error: message.error });
    } else if (message.type === 'error') {
      const error = new Error(`${message.code}: ${message.message}`);
      if (!this.initialSettled) {
        // Before the join completes, an error really is terminal: the server
        // follows unauthorized/forbidden/incompatible with an explicit close.
        this.rejectInitial(error);
        this.handlers.onConnectionState?.('disconnected', error.message);
        return;
      }
      // After joining, the socket is still open and still joined. Saying
      // "disconnected" here was a lie that also stranded the session: no close
      // event follows, so scheduleReconnect() never runs and the bar reads
      // disconnected until the board is reopened. Surface it as what it is.
      this.handlers.onError?.(error.message);
    }
  }

  private send(message: CollaborationClientMessage): void {
    if (this.socket?.readyState === 1) this.socket.send(encodeCollaborationMessage(message));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.closedByUser || this.fatal) return;
    const index = Math.min(this.reconnectAttempt, this.settings.reconnectDelaysMs.length - 1);
    const delay = this.settings.reconnectDelaysMs[index] ?? 5_000;
    this.reconnectAttempt++;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = window.setInterval(() => this.send({ type: 'heartbeat', sentAt: Date.now() }), this.settings.heartbeatMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private rejectPending(error: string): void {
    for (const acknowledgement of this.pending.values()) {
      window.clearTimeout(acknowledgement.timer);
      acknowledgement.resolve({ accepted: false, error });
    }
    this.pending.clear();
  }

  private failInitialOrReconnect(error: Error): void {
    this.handlers.onConnectionState?.('disconnected', error.message);
    if (!this.initialSettled) this.rejectInitial(error);
    else this.scheduleReconnect();
  }

  private rejectInitial(error: Error): void {
    if (this.initialSettled) return;
    this.initialSettled = true;
    this.initialReject?.(error);
  }
}

function socketMessageText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value);
  return undefined;
}

/**
 * A refused connection closes with 1006 and an empty reason, so the only thing
 * the user saw was "WebSocket closed (1006)." -- which says nothing about the
 * commonest cause by far: the host is not running. Hosting has to be started
 * on the host's machine, and before 1.3.6 it did not survive an Obsidian
 * restart, so this was most people's first experience of reopening a room.
 */
function unreachableHostReason(code: number, url: string, joinedOnce: boolean): string {
  if (code !== 1006) return `WebSocket closed (${code}).`;
  const host = safeHost(url);
  if (joinedOnce) {
    return `Lost the connection to the collaboration host${host ? ` at ${host}` : ''}. `
      + 'It may have gone to sleep, quit Obsidian, or left the network. Reconnecting when it returns.';
  }
  return `Could not reach the collaboration host${host ? ` at ${host}` : ''}. `
    + 'Check that the host has Obsidian open and hosting started, and that both devices are on the same private network.';
}

function safeHost(url: string): string | undefined {
  try { return new URL(url).host; } catch { return undefined; }
}
