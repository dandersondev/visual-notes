import { describe, expect, it } from 'vitest';
import {
  applyBoardOperation,
  createBoardOperation,
  replayBoardOperations,
  type BoardOperationAction,
} from '../src/collaboration-operations';
import type { CollaborationIdentity } from '../src/collaboration-identity';
import type { StickyCard, VisualNotesFile } from '../src/file-types';

const identity = (clientId: string, displayName: string): CollaborationIdentity => ({ clientId, displayName, color: '#7986cb' });
const sticky = (id: string, text = id): StickyCard => ({ id, kind: 'sticky', text, color: '#fff' });
const board = (): VisualNotesFile => ({ version: 3, layout: 'freeform', cards: [sticky('a', 'old')], connections: [], drawings: [] });
const operation = (clientId: string, clock: number, action: BoardOperationAction, operationId = `${clientId}-${clock}`) =>
  createBoardOperation(identity(clientId, clientId), 'board-1', clock, action, { operationId, createdAt: 1000 });

describe('collaboration operation envelope', () => {
  it('captures stable client and actor identity', () => {
    const out = operation('client-a', 3, { kind: 'set', path: ['cards', { id: 'a' }, 'text'], value: 'new' });
    expect(out).toMatchObject({
      schemaVersion: 1, operationId: 'client-a-3', boardId: 'board-1', clientId: 'client-a',
      actor: { displayName: 'client-a', color: '#7986cb' }, logicalClock: 3, createdAt: 1000,
    });
  });

  it('sets nested fields through stable IDs without mutating the input board', () => {
    const input = board();
    const result = applyBoardOperation(input, operation('a', 1, {
      kind: 'set', path: ['cards', { id: 'a' }, 'text'], value: 'changed',
    }));
    expect((result.board.cards[0] as StickyCard).text).toBe('changed');
    expect((input.cards[0] as StickyCard).text).toBe('old');
  });

  it('inserts and deletes stable-ID entities', () => {
    const inserted = applyBoardOperation(board(), operation('a', 1, {
      kind: 'insert', path: ['cards'], afterId: 'a',
      value: { id: 'b', kind: 'sticky', text: 'B', color: '#fff' },
    }));
    const deleted = applyBoardOperation(inserted.board, operation('a', 2, {
      kind: 'delete', path: ['cards', { id: 'a' }],
    }));
    expect(deleted.board.cards.map(card => card.id)).toEqual(['b']);
  });

  it('moves a stable-ID entity relative to another entity', () => {
    const input = board();
    input.cards.push(sticky('b'), sticky('c'));
    const result = applyBoardOperation(input, operation('a', 1, {
      kind: 'move', path: ['cards'], id: 'c', afterId: 'a',
    }));
    expect(result.board.cards.map(card => card.id)).toEqual(['a', 'c', 'b']);
  });

  it('replays out-of-order delivery deterministically and ignores duplicate IDs', () => {
    const early = operation('client-a', 1, { kind: 'set', path: ['cards', { id: 'a' }, 'text'], value: 'early' }, 'one');
    const late = operation('client-b', 2, { kind: 'set', path: ['cards', { id: 'a' }, 'text'], value: 'late' }, 'two');
    const result = replayBoardOperations(board(), [late, early, late]);
    expect((result.board.cards[0] as StickyCard).text).toBe('late');
    expect(result.appliedOperationIds).toEqual(['one', 'two']);
  });

  it('uses client and operation IDs as deterministic concurrent tie-breakers', () => {
    const fromB = operation('b', 1, { kind: 'set', path: ['cards', { id: 'a' }, 'text'], value: 'B' }, 'b-op');
    const fromA = operation('a', 1, { kind: 'set', path: ['cards', { id: 'a' }, 'text'], value: 'A' }, 'a-op');
    const first = replayBoardOperations(board(), [fromB, fromA]);
    const second = replayBoardOperations(board(), [fromA, fromB]);
    expect(first.board).toEqual(second.board);
  });

  it('rejects stale paths without partially changing the board', () => {
    const input = board();
    const result = applyBoardOperation(input, operation('a', 1, {
      kind: 'set', path: ['cards', { id: 'missing' }, 'text'], value: 'lost',
    }));
    expect(result.applied).toBe(false);
    expect(result.board).toBe(input);
    expect(result.error).toMatch(/missing/);
  });
});
