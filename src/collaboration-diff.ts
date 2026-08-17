import type { VisualNotesFile } from './file-types';
import type { BoardOperationAction, JsonValue, OperationPathSegment } from './collaboration-operations';

const ROOT_IGNORED = new Set(['viewport', 'baseline', 'unreadable', 'recoveredFromNativeEdit']);
const MISSING = Symbol('missing');

/** Converts a board mutation into stable-ID operations suitable for a room. */
export function diffBoardOperations(before: VisualNotesFile, after: VisualNotesFile): BoardOperationAction[] {
  const actions: BoardOperationAction[] = [];
  diffValue(before, after, [], actions, true);
  return actions;
}

function diffValue(
  before: unknown,
  after: unknown,
  path: OperationPathSegment[],
  actions: BoardOperationAction[],
  root = false,
): void {
  if (equal(before, after)) return;
  if (isRecord(before) && isRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      if (root && ROOT_IGNORED.has(key)) continue;
      const left = own(before, key);
      const right = own(after, key);
      const childPath = [...path, key];
      if (right === MISSING) actions.push({ kind: 'delete', path: childPath });
      else if (left === MISSING) actions.push({ kind: 'set', path: childPath, value: toJson(right) });
      else diffValue(left, right, childPath, actions);
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after) && isIdCollection(before, after)) {
    diffIdCollection(before, after, path, actions);
    return;
  }
  actions.push({ kind: 'set', path, value: toJson(after) });
}

function diffIdCollection(
  before: unknown[],
  after: unknown[],
  path: OperationPathSegment[],
  actions: BoardOperationAction[],
): void {
  const beforeById = idMap(before);
  const afterById = idMap(after);
  for (const id of beforeById.keys()) {
    if (!afterById.has(id)) actions.push({ kind: 'delete', path: [...path, { id }] });
  }

  const beforeIds = ids(before);
  const afterIds = ids(after);
  const singleMoveId = beforeIds.length === afterIds.length
    && beforeById.size === afterById.size
    ? detectSingleMove(beforeIds, afterIds)
    : undefined;
  if (singleMoveId !== undefined) {
    for (const value of after) {
      if (!isRecord(value) || typeof value.id !== 'string') continue;
      diffValue(beforeById.get(value.id), value, [...path, { id: value.id }], actions);
    }
    const index = afterIds.indexOf(singleMoveId);
    actions.push({ kind: 'move', path, id: singleMoveId, afterId: index > 0 ? afterIds[index - 1] : undefined });
    return;
  }

  // Track the order the receiver will have while applying these actions. The
  // old implementation emitted a move for every surviving entity whenever
  // any one entity moved. On a Kanban column that meant one drag could become
  // dozens of acknowledged operations and dozens of full room persists.
  const currentOrder = ids(before).filter(id => afterById.has(id));
  let previousId: string | undefined;
  for (let desiredIndex = 0; desiredIndex < after.length; desiredIndex++) {
    const value = after[desiredIndex];
    if (!isRecord(value) || typeof value.id !== 'string') continue;
    const id = value.id;
    const old = beforeById.get(id);
    if (old === undefined) {
      const json = toJson(value);
      if (!isJsonRecordWithId(json)) throw new Error(`Inserted entity "${id}" is not JSON-safe.`);
      actions.push({ kind: 'insert', path, value: json, afterId: previousId });
      currentOrder.splice(desiredIndex, 0, id);
    } else {
      diffValue(old, value, [...path, { id }], actions);
      const currentIndex = currentOrder.indexOf(id);
      if (currentIndex !== desiredIndex) {
        actions.push({ kind: 'move', path, id, afterId: previousId });
        currentOrder.splice(currentIndex, 1);
        currentOrder.splice(desiredIndex, 0, id);
      }
    }
    previousId = id;
  }
}

/** Returns the one entity whose removal makes two unique-ID orders equal. */
function detectSingleMove(before: string[], after: string[]): string | undefined {
  if (equal(before, after)) return undefined;
  for (const id of before) {
    if (equal(before.filter(candidate => candidate !== id), after.filter(candidate => candidate !== id))) return id;
  }
  return undefined;
}

function ids(values: unknown[]): string[] {
  return values.flatMap(value => isRecord(value) && typeof value.id === 'string' ? [value.id] : []);
}

function toJson(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Collaboration values must contain finite numbers.');
    return value;
  }
  if (Array.isArray(value)) return value.map(toJson);
  if (isRecord(value)) {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, child] of Object.entries(value)) if (child !== undefined) out[key] = toJson(child);
    return out;
  }
  throw new Error('Collaboration values must be JSON-safe.');
}

function isJsonRecordWithId(value: JsonValue): value is { id: string; [key: string]: JsonValue } {
  return isRecord(value) && typeof value.id === 'string';
}

function isIdCollection(...arrays: unknown[][]): boolean {
  const values = arrays.flat();
  return values.length > 0 && values.every(value => isRecord(value) && typeof value.id === 'string');
}

function idMap(values: unknown[]): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const value of values) if (isRecord(value) && typeof value.id === 'string') out.set(value.id, value);
  return out;
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : MISSING;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => equal(value, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length
      && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && equal(a[key], b[key]));
  }
  return false;
}
