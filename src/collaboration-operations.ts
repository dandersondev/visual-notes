import type { CollaborationIdentity } from './collaboration-identity';
import type { VisualNotesFile } from './file-types';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type OperationPathSegment = string | { id: string };

export type BoardOperationAction =
  | { kind: 'set'; path: OperationPathSegment[]; value: JsonValue }
  | { kind: 'delete'; path: OperationPathSegment[] }
  | { kind: 'insert'; path: OperationPathSegment[]; value: { id: string; [key: string]: JsonValue }; afterId?: string }
  | { kind: 'move'; path: OperationPathSegment[]; id: string; afterId?: string };

export interface BoardOperation {
  schemaVersion: 1;
  operationId: string;
  boardId: string;
  clientId: string;
  actor: { displayName: string; color: string };
  logicalClock: number;
  createdAt: number;
  action: BoardOperationAction;
}

export interface OperationApplyResult {
  board: VisualNotesFile;
  applied: boolean;
  error?: string;
}

export interface OperationReplayResult {
  board: VisualNotesFile;
  appliedOperationIds: string[];
  rejected: { operationId: string; error: string }[];
}

export function createBoardOperation(
  identity: CollaborationIdentity,
  boardId: string,
  logicalClock: number,
  action: BoardOperationAction,
  options: { operationId?: string; createdAt?: number } = {},
): BoardOperation {
  if (!Number.isSafeInteger(logicalClock) || logicalClock < 1) throw new Error('logicalClock must be a positive integer');
  return {
    schemaVersion: 1,
    operationId: options.operationId ?? crypto.randomUUID(),
    boardId,
    clientId: identity.clientId,
    actor: { displayName: identity.displayName, color: identity.color },
    logicalClock,
    createdAt: options.createdAt ?? Date.now(),
    action,
  };
}

/** Applies one immutable operation. Invalid or stale paths are rejected safely. */
export function applyBoardOperation(board: VisualNotesFile, operation: BoardOperation): OperationApplyResult {
  const next = structuredClone(board);
  try {
    if (operation.schemaVersion !== 1) throw new Error(`Unsupported operation schema ${String(operation.schemaVersion)}`);
    if (operation.action.kind === 'insert') applyInsert(next, operation.action);
    else if (operation.action.kind === 'move') applyMove(next, operation.action);
    else if (operation.action.kind === 'set') applySet(next, operation.action.path, operation.action.value);
    else applyDelete(next, operation.action.path);
    return { board: next, applied: true };
  } catch (error) {
    return { board, applied: false, error: error instanceof Error ? error.message : 'Invalid operation' };
  }
}

/**
 * Replays operations in a deterministic total order. Duplicate operation IDs
 * are idempotent, which makes reconnect/retry delivery safe.
 */
export function replayBoardOperations(board: VisualNotesFile, operations: BoardOperation[]): OperationReplayResult {
  const ordered = [...operations].sort(compareOperations);
  const seen = new Set<string>();
  const appliedOperationIds: string[] = [];
  const rejected: OperationReplayResult['rejected'] = [];
  let current = board;
  for (const operation of ordered) {
    if (seen.has(operation.operationId)) continue;
    seen.add(operation.operationId);
    const result = applyBoardOperation(current, operation);
    if (result.applied) {
      current = result.board;
      appliedOperationIds.push(operation.operationId);
    } else {
      rejected.push({ operationId: operation.operationId, error: result.error ?? 'Invalid operation' });
    }
  }
  return { board: current, appliedOperationIds, rejected };
}

export function compareOperations(a: BoardOperation, b: BoardOperation): number {
  return a.logicalClock - b.logicalClock
    || a.clientId.localeCompare(b.clientId)
    || a.operationId.localeCompare(b.operationId);
}

function applySet(root: VisualNotesFile, path: OperationPathSegment[], value: JsonValue): void {
  const { parent, key } = resolveParent(root, path);
  if (typeof key === 'string') {
    if (!isRecord(parent)) throw new Error('Set target is not an object');
    parent[key] = structuredClone(value);
    return;
  }
  if (!Array.isArray(parent)) throw new Error('Set selector parent is not an array');
  const index = parent.findIndex(item => isRecord(item) && item.id === key.id);
  if (index < 0) throw new Error(`No entity with id "${key.id}"`);
  parent[index] = structuredClone(value);
}

function applyDelete(root: VisualNotesFile, path: OperationPathSegment[]): void {
  const { parent, key } = resolveParent(root, path);
  if (typeof key === 'string') {
    if (!isRecord(parent) || !Object.prototype.hasOwnProperty.call(parent, key)) throw new Error('Delete target does not exist');
    delete parent[key];
    return;
  }
  if (!Array.isArray(parent)) throw new Error('Delete selector parent is not an array');
  const index = parent.findIndex(item => isRecord(item) && item.id === key.id);
  if (index < 0) throw new Error(`No entity with id "${key.id}"`);
  parent.splice(index, 1);
}

function applyInsert(root: VisualNotesFile, action: Extract<BoardOperationAction, { kind: 'insert' }>): void {
  const target = resolvePath(root, action.path);
  if (!Array.isArray(target)) throw new Error('Insert target is not an array');
  if (target.some(item => isRecord(item) && item.id === action.value.id)) return;
  const value = structuredClone(action.value);
  if (action.afterId === undefined) target.unshift(value);
  else {
    const index = target.findIndex(item => isRecord(item) && item.id === action.afterId);
    if (index < 0) target.push(value);
    else target.splice(index + 1, 0, value);
  }
}

function applyMove(root: VisualNotesFile, action: Extract<BoardOperationAction, { kind: 'move' }>): void {
  const target = resolvePath(root, action.path);
  if (!Array.isArray(target)) throw new Error('Move target is not an array');
  const from = target.findIndex(item => isRecord(item) && item.id === action.id);
  if (from < 0) throw new Error(`No entity with id "${action.id}"`);
  const value: unknown = target[from];
  target.splice(from, 1);
  if (action.afterId === undefined) target.unshift(value);
  else {
    const after = target.findIndex(item => isRecord(item) && item.id === action.afterId);
    if (after < 0) target.push(value);
    else target.splice(after + 1, 0, value);
  }
}

function resolveParent(root: VisualNotesFile, path: OperationPathSegment[]): { parent: unknown; key: OperationPathSegment } {
  if (path.length === 0) throw new Error('Operation path cannot be empty');
  return { parent: resolvePath(root, path.slice(0, -1)), key: path[path.length - 1] };
}

function resolvePath(root: VisualNotesFile, path: OperationPathSegment[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (typeof segment === 'string') {
      if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
        throw new Error(`Path field "${segment}" does not exist`);
      }
      current = current[segment];
    } else {
      if (!Array.isArray(current)) throw new Error(`Selector "${segment.id}" does not address an array`);
      const found: unknown = current.find(item => isRecord(item) && item.id === segment.id);
      if (found === undefined) throw new Error(`No entity with id "${segment.id}"`);
      current = found;
    }
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
