import type { VisualNotesFile } from './file-types';

export interface BoardMergeConflict {
  path: string;
  reason: 'both-changed' | 'delete-vs-edit';
}

export interface BoardMergeResult {
  board: VisualNotesFile;
  conflicts: BoardMergeConflict[];
}

const MISSING = Symbol('missing');

/**
 * Three-way merges two board revisions derived from the same base.
 *
 * Arrays of stable-id objects are treated as collections, which lets edits
 * to different cards, shots, comments, table rows, strokes, and connections
 * combine recursively. True same-field conflicts prefer the local value;
 * callers can preserve the remote revision as a conflict backup.
 */
export function mergeBoards(
  base: VisualNotesFile,
  ours: VisualNotesFile,
  theirs: VisualNotesFile,
): BoardMergeResult {
  const conflicts: BoardMergeConflict[] = [];
  const merged = mergeValue(base, ours, theirs, '$', conflicts);
  const board = merged === MISSING ? ours : merged as VisualNotesFile;

  // Viewport is personal, view-only state rather than shared board content.
  // Keep this pane's view and never turn two people panning into a conflict.
  board.viewport = ours.viewport;
  delete board.baseline;
  delete board.unreadable;
  delete board.recoveredFromNativeEdit;
  return { board, conflicts };
}

function mergeValue(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  path: string,
  conflicts: BoardMergeConflict[],
): unknown {
  if (equal(ours, theirs)) return ours;
  if (equal(ours, base)) return theirs;
  if (equal(theirs, base)) return ours;

  if (ours === MISSING || theirs === MISSING) {
    conflicts.push({ path, reason: 'delete-vs-edit' });
    // Preserve edited content rather than allowing a concurrent deletion to
    // erase it. The conflict backup still retains the complete remote file.
    return ours === MISSING ? theirs : ours;
  }

  if (isRecord(ours) && isRecord(theirs) && (base === MISSING || isRecord(base))) {
    return mergeRecord(base === MISSING ? undefined : base, ours, theirs, path, conflicts);
  }

  if (Array.isArray(ours) && Array.isArray(theirs) && (base === MISSING || Array.isArray(base))) {
    const baseArray = base === MISSING ? [] : base;
    if (isIdCollection(baseArray, ours, theirs)) {
      return mergeIdArray(baseArray, ours, theirs, path, conflicts);
    }
    if (isUniquePrimitiveArray(baseArray) && isUniquePrimitiveArray(ours) && isUniquePrimitiveArray(theirs)) {
      return mergePrimitiveArray(baseArray, ours, theirs);
    }
  }

  conflicts.push({ path, reason: 'both-changed' });
  return ours;
}

function mergeRecord(
  base: Record<string, unknown> | undefined,
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
  path: string,
  conflicts: BoardMergeConflict[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(ours), ...Object.keys(theirs)]);
  for (const key of keys) {
    const value = mergeValue(
      own(base, key),
      own(ours, key),
      own(theirs, key),
      `${path}.${key}`,
      conflicts,
    );
    if (value !== MISSING) out[key] = value;
  }
  return out;
}

function mergeIdArray(
  base: unknown[],
  ours: unknown[],
  theirs: unknown[],
  path: string,
  conflicts: BoardMergeConflict[],
): unknown[] {
  const baseById = idMap(base);
  const oursById = idMap(ours);
  const theirsById = idMap(theirs);
  const order = [...ids(ours), ...ids(theirs).filter(id => !oursById.has(id))];
  const out: unknown[] = [];
  for (const id of order) {
    const value = mergeValue(
      baseById.get(id) ?? MISSING,
      oursById.get(id) ?? MISSING,
      theirsById.get(id) ?? MISSING,
      `${path}[id=${id}]`,
      conflicts,
    );
    if (value !== MISSING) out.push(value);
  }
  return out;
}

function mergePrimitiveArray(base: unknown[], ours: unknown[], theirs: unknown[]): unknown[] {
  const candidates = [...ours, ...theirs.filter(value => !ours.includes(value))];
  return candidates.filter(value => {
    const inBase = base.includes(value);
    const inOurs = ours.includes(value);
    const inTheirs = theirs.includes(value);
    if (inOurs === inTheirs) return inOurs;
    return inOurs === inBase ? inTheirs : inOurs;
  });
}

function isIdCollection(...arrays: unknown[][]): boolean {
  const values = arrays.flat();
  return values.length > 0 && values.every(value => isRecord(value) && typeof value.id === 'string');
}

function idMap(values: unknown[]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const value of values) if (isRecord(value) && typeof value.id === 'string') out.set(value.id, value);
  return out;
}

function ids(values: unknown[]): string[] {
  return values.flatMap(value => isRecord(value) && typeof value.id === 'string' ? [value.id] : []);
}

function isUniquePrimitiveArray(values: unknown[]): boolean {
  if (!values.every(value => value === null || ['string', 'number', 'boolean'].includes(typeof value))) return false;
  return new Set(values).size === values.length;
}

function own(value: Record<string, unknown> | undefined, key: string): unknown {
  return value && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : MISSING;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function equal(a: unknown, b: unknown): boolean {
  if (a === MISSING || b === MISSING) return a === b;
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => equal(value, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return aKeys.length === bKeys.length && aKeys.every(key => Object.prototype.hasOwnProperty.call(b, key) && equal(a[key], b[key]));
  }
  return false;
}
