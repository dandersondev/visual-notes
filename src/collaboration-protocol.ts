import type { CollaborationIdentity } from './collaboration-identity';
import type { BoardOperation, BoardOperationAction, OperationPathSegment } from './collaboration-operations';
import type { CollaborationPresence, CollaborationRole, CollaborationRoomSnapshot, SequencedBoardOperation } from './collaboration-transport';
import type { VisualNotesFile } from './file-types';

export const COLLABORATION_PROTOCOL_VERSION = 1;

export interface CollaborationClientCompatibility {
  pluginVersion: string;
  obsidianVersion: string;
  supportedBoardVersions: number[];
}

export type CollaborationClientMessage =
  | {
      type: 'join'; protocolVersion: 1; token: string; roomId: string; boardId: string;
      identity: CollaborationIdentity; initialBoard: VisualNotesFile; inviteCode?: string;
      accessToken?: string;
      compatibility: CollaborationClientCompatibility;
    }
  | { type: 'operation'; operation: BoardOperation }
  | { type: 'presence'; cursor?: { x: number; y: number } | null; selectedIds?: string[] }
  | { type: 'heartbeat'; sentAt: number };

export type CollaborationServerMessage =
  | { type: 'joined'; protocolVersion: 1; snapshot: CollaborationRoomSnapshot }
  | { type: 'operation'; message: SequencedBoardOperation }
  | { type: 'operation-accepted'; operationId: string; sequence: number }
  | { type: 'operation-rejected'; operationId: string; error: string }
  | { type: 'presence'; collaborators: CollaborationPresence[] }
  | { type: 'heartbeat-ack'; sentAt: number; serverTime: number }
  | { type: 'compatibility'; warnings: string[] }
  | { type: 'error'; code: string; message: string };

export function decodeClientMessage(raw: string): CollaborationClientMessage {
  return parseClientMessage(parseJson(raw));
}

export function decodeServerMessage(raw: string): CollaborationServerMessage {
  return parseServerMessage(parseJson(raw));
}

export function encodeCollaborationMessage(message: CollaborationClientMessage | CollaborationServerMessage): string {
  return JSON.stringify(message);
}

function parseClientMessage(value: unknown): CollaborationClientMessage {
  const message = record(value, 'Client message');
  const type = string(message.type, 'Client message type');
  if (type === 'join') {
    if (message.protocolVersion !== COLLABORATION_PROTOCOL_VERSION) throw new Error('Unsupported collaboration protocol version.');
    return {
      type, protocolVersion: 1,
      token: nonEmptyString(message.token, 'Join token'),
      roomId: boundedString(message.roomId, 'Room ID', 200),
      boardId: boundedString(message.boardId, 'Board ID', 500),
      identity: parseIdentity(message.identity),
      initialBoard: parseBoard(message.initialBoard),
      inviteCode: optionalBoundedString(message.inviteCode, 'Invite code', 100),
      accessToken: optionalBoundedString(message.accessToken, 'Room access token', 500),
      compatibility: parseCompatibility(message.compatibility),
    };
  }
  if (type === 'operation') return { type, operation: parseOperation(message.operation) };
  if (type === 'presence') return { type, ...parsePresencePatch(message) };
  if (type === 'heartbeat') return { type, sentAt: finiteNumber(message.sentAt, 'Heartbeat timestamp') };
  throw new Error(`Unknown client message type "${type}".`);
}

function parseServerMessage(value: unknown): CollaborationServerMessage {
  const message = record(value, 'Server message');
  const type = string(message.type, 'Server message type');
  if (type === 'joined') {
    if (message.protocolVersion !== COLLABORATION_PROTOCOL_VERSION) throw new Error('Unsupported collaboration protocol version.');
    return { type, protocolVersion: 1, snapshot: parseSnapshot(message.snapshot) };
  }
  if (type === 'operation') return { type, message: parseSequencedOperation(message.message) };
  if (type === 'operation-accepted') return {
    type, operationId: nonEmptyString(message.operationId, 'Operation ID'),
    sequence: nonNegativeInteger(message.sequence, 'Operation sequence'),
  };
  if (type === 'operation-rejected') return {
    type, operationId: nonEmptyString(message.operationId, 'Operation ID'), error: string(message.error, 'Operation error'),
  };
  if (type === 'presence') {
    if (!Array.isArray(message.collaborators)) throw new Error('Presence collaborators must be an array.');
    return { type, collaborators: message.collaborators.map(parsePresence) };
  }
  if (type === 'heartbeat-ack') return {
    type, sentAt: finiteNumber(message.sentAt, 'Heartbeat timestamp'), serverTime: finiteNumber(message.serverTime, 'Server time'),
  };
  if (type === 'compatibility') {
    if (!Array.isArray(message.warnings) || !message.warnings.every(value => typeof value === 'string')) {
      throw new Error('Compatibility warnings must be strings.');
    }
    return { type, warnings: message.warnings.slice(0, 20).map(value => value.slice(0, 500)) };
  }
  if (type === 'error') return {
    type, code: boundedString(message.code, 'Error code', 100), message: boundedString(message.message, 'Error message', 1000),
  };
  throw new Error(`Unknown server message type "${type}".`);
}

function parseSnapshot(value: unknown): CollaborationRoomSnapshot {
  const snapshot = record(value, 'Room snapshot');
  if (!Array.isArray(snapshot.collaborators)) throw new Error('Snapshot collaborators must be an array.');
  return {
    roomId: boundedString(snapshot.roomId, 'Room ID', 200),
    boardId: boundedString(snapshot.boardId, 'Board ID', 500),
    board: parseBoard(snapshot.board),
    sequence: nonNegativeInteger(snapshot.sequence, 'Snapshot sequence'),
    maxLogicalClock: nonNegativeInteger(snapshot.maxLogicalClock, 'Snapshot logical clock'),
    collaborators: snapshot.collaborators.map(parsePresence),
    role: snapshot.role === undefined ? undefined : parseRole(snapshot.role),
  };
}

function parseSequencedOperation(value: unknown): SequencedBoardOperation {
  const message = record(value, 'Sequenced operation');
  return {
    sequence: nonNegativeInteger(message.sequence, 'Operation sequence'),
    operation: parseOperation(message.operation),
  };
}

function parseOperation(value: unknown): BoardOperation {
  const operation = record(value, 'Operation');
  if (operation.schemaVersion !== 1) throw new Error('Unsupported operation schema version.');
  return {
    schemaVersion: 1,
    operationId: boundedString(operation.operationId, 'Operation ID', 200),
    boardId: boundedString(operation.boardId, 'Board ID', 500),
    clientId: boundedString(operation.clientId, 'Client ID', 200),
    actor: parseActor(operation.actor),
    logicalClock: positiveInteger(operation.logicalClock, 'Logical clock'),
    createdAt: finiteNumber(operation.createdAt, 'Operation timestamp'),
    action: parseAction(operation.action),
  };
}

function parseAction(value: unknown): BoardOperationAction {
  const action = record(value, 'Operation action');
  const kind = string(action.kind, 'Operation action kind');
  const path = parsePath(action.path);
  if (kind === 'set') return { kind, path, value: jsonValue(action.value, 'Set value') };
  if (kind === 'delete') return { kind, path };
  if (kind === 'insert') {
    const inserted = record(jsonValue(action.value, 'Inserted value'), 'Inserted value');
    const id = boundedString(inserted.id, 'Inserted ID', 200);
    return { kind, path, value: { ...inserted, id }, afterId: optionalString(action.afterId, 'After ID') };
  }
  if (kind === 'move') return {
    kind, path, id: boundedString(action.id, 'Moved ID', 200), afterId: optionalString(action.afterId, 'After ID'),
  };
  throw new Error(`Unknown operation action "${kind}".`);
}

function parsePath(value: unknown): OperationPathSegment[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 30) throw new Error('Operation path is invalid.');
  return value.map(segment => {
    if (typeof segment === 'string' && segment.length > 0 && segment.length <= 200) {
      if (['__proto__', 'prototype', 'constructor'].includes(segment)) throw new Error('Operation path contains an unsafe field.');
      return segment;
    }
    const selector = record(segment, 'Path selector');
    return { id: boundedString(selector.id, 'Path selector ID', 200) };
  });
}

function parseIdentity(value: unknown): CollaborationIdentity {
  const identity = record(value, 'Identity');
  return {
    clientId: boundedString(identity.clientId, 'Client ID', 200),
    displayName: boundedString(identity.displayName, 'Display name', 100),
    color: color(identity.color),
  };
}

function parseRole(value: unknown): CollaborationRole {
  if (value === 'owner' || value === 'editor' || value === 'viewer') return value;
  throw new Error('Collaboration role is invalid.');
}

function parseCompatibility(value: unknown): CollaborationClientCompatibility {
  const compatibility = record(value, 'Client compatibility');
  if (!Array.isArray(compatibility.supportedBoardVersions)
    || !compatibility.supportedBoardVersions.every(version => Number.isSafeInteger(version))) {
    throw new Error('Supported board versions must be integers.');
  }
  return {
    pluginVersion: boundedString(compatibility.pluginVersion, 'Plugin version', 100),
    obsidianVersion: boundedString(compatibility.obsidianVersion, 'Obsidian version', 100),
    supportedBoardVersions: [...new Set(compatibility.supportedBoardVersions as number[])].slice(0, 20),
  };
}

function parseActor(value: unknown): BoardOperation['actor'] {
  const actor = record(value, 'Operation actor');
  return { displayName: boundedString(actor.displayName, 'Actor name', 100), color: color(actor.color) };
}

function parsePresence(value: unknown): CollaborationPresence {
  const presence = record(value, 'Presence');
  if (!Array.isArray(presence.selectedIds) || !presence.selectedIds.every(id => typeof id === 'string')) {
    throw new Error('Presence selected IDs must be strings.');
  }
  const cursor = presence.cursor === undefined ? undefined : parseCursor(presence.cursor);
  return {
    clientId: boundedString(presence.clientId, 'Presence client ID', 200),
    displayName: boundedString(presence.displayName, 'Presence display name', 100),
    color: color(presence.color), cursor,
    selectedIds: presence.selectedIds.slice(0, 500),
    updatedAt: finiteNumber(presence.updatedAt, 'Presence timestamp'),
  };
}

function parsePresencePatch(value: Record<string, unknown>): Omit<Extract<CollaborationClientMessage, { type: 'presence' }>, 'type'> {
  const out: Omit<Extract<CollaborationClientMessage, { type: 'presence' }>, 'type'> = {};
  if (value.cursor === null) out.cursor = null;
  else if (value.cursor !== undefined) out.cursor = parseCursor(value.cursor);
  if (value.selectedIds !== undefined) {
    if (!Array.isArray(value.selectedIds) || !value.selectedIds.every(id => typeof id === 'string')) {
      throw new Error('Selected IDs must be strings.');
    }
    out.selectedIds = value.selectedIds.slice(0, 500);
  }
  return out;
}

function parseCursor(value: unknown): { x: number; y: number } {
  const cursor = record(value, 'Cursor');
  return { x: finiteNumber(cursor.x, 'Cursor x'), y: finiteNumber(cursor.y, 'Cursor y') };
}

function parseBoard(value: unknown): VisualNotesFile {
  const board = record(value, 'Board');
  if ((board.version !== 2 && board.version !== 3) || (board.layout !== 'grid' && board.layout !== 'freeform')) {
    throw new Error('Board version or layout is invalid.');
  }
  if (!Array.isArray(board.cards) || !Array.isArray(board.connections) || !Array.isArray(board.drawings)) {
    throw new Error('Board collections are invalid.');
  }
  return structuredClone(value) as VisualNotesFile;
}

function jsonValue(value: unknown, label: string): import('./collaboration-operations').JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(child => jsonValue(child, label));
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: import('./collaboration-operations').JsonValue } = {};
    for (const [key, child] of Object.entries(value)) out[key] = jsonValue(child, label);
    return out;
  }
  throw new Error(`${label} is not JSON-safe.`);
}

function parseJson(raw: string): unknown {
  try { return JSON.parse(raw) as unknown; }
  catch { throw new Error('Collaboration message is not valid JSON.'); }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  return value;
}

function nonEmptyString(value: unknown, label: string): string { return boundedString(value, label, 10_000); }
function boundedString(value: unknown, label: string, max: number): string {
  const out = string(value, label);
  if (out.length === 0 || out.length > max) throw new Error(`${label} has an invalid length.`);
  return out;
}
function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : boundedString(value, label, 200);
}
function optionalBoundedString(value: unknown, label: string, max: number): string | undefined {
  return value === undefined ? undefined : boundedString(value, label, max);
}
function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  return value;
}
function nonNegativeInteger(value: unknown, label: string): number {
  const out = finiteNumber(value, label);
  if (!Number.isSafeInteger(out) || out < 0) throw new Error(`${label} must be a non-negative integer.`);
  return out;
}
function positiveInteger(value: unknown, label: string): number {
  const out = nonNegativeInteger(value, label);
  if (out < 1) throw new Error(`${label} must be positive.`);
  return out;
}
function color(value: unknown): string {
  const out = string(value, 'Colour');
  if (!/^#[0-9a-f]{6}$/i.test(out)) throw new Error('Colour must be a six-digit hex value.');
  return out;
}
