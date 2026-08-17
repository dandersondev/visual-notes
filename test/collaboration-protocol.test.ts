import { describe, expect, it } from 'vitest';
import {
  decodeClientMessage, decodeServerMessage, encodeCollaborationMessage,
  type CollaborationClientMessage, type CollaborationServerMessage,
} from '../src/collaboration-protocol';
import type { VisualNotesFile } from '../src/file-types';

const board: VisualNotesFile = { version: 3, layout: 'freeform', cards: [], connections: [], drawings: [] };

describe('collaboration wire protocol', () => {
  it('round-trips a valid join message through runtime validation', () => {
    const message: CollaborationClientMessage = {
      type: 'join', protocolVersion: 1, token: 'dev-token', roomId: 'room', boardId: 'board',
      identity: { clientId: 'client', displayName: 'Alice', color: '#abcdef' }, initialBoard: board,
      inviteCode: 'VN-ABCD-EFGH-JKLM',
      compatibility: { pluginVersion: '1.2.4', obsidianVersion: '1.6.5', supportedBoardVersions: [2, 3] },
    };
    expect(decodeClientMessage(encodeCollaborationMessage(message))).toEqual(message);
  });

  it('rejects unknown versions, malformed actions, and non-JSON text', () => {
    expect(() => decodeClientMessage('{')).toThrow(/valid JSON/);
    expect(() => decodeClientMessage(JSON.stringify({
      type: 'join', protocolVersion: 99, token: 'x', roomId: 'x', boardId: 'x', identity: {}, initialBoard: board,
    }))).toThrow(/protocol version/);
    expect(() => decodeClientMessage(JSON.stringify({
      type: 'operation', operation: {
        schemaVersion: 1, operationId: 'x', boardId: 'b', clientId: 'c', actor: { displayName: 'A', color: '#abcdef' },
        logicalClock: 1, createdAt: 1, action: { kind: 'explode', path: ['cards'] },
      },
    }))).toThrow(/Unknown operation action/);
    expect(() => decodeClientMessage(JSON.stringify({
      type: 'operation', operation: {
        schemaVersion: 1, operationId: 'x', boardId: 'b', clientId: 'c', actor: { displayName: 'A', color: '#abcdef' },
        logicalClock: 1, createdAt: 1, action: { kind: 'set', path: ['__proto__'], value: {} },
      },
    }))).toThrow(/unsafe field/);
  });

  it('validates server snapshots and presence rather than trusting the socket', () => {
    const message: CollaborationServerMessage = {
      type: 'joined', protocolVersion: 1,
      snapshot: { roomId: 'room', boardId: 'board', board, sequence: 0, maxLogicalClock: 0, collaborators: [] },
    };
    expect(decodeServerMessage(encodeCollaborationMessage(message))).toEqual(message);
    expect(() => decodeServerMessage(JSON.stringify({ type: 'presence', collaborators: [{ clientId: 4 }] }))).toThrow();
  });
});
