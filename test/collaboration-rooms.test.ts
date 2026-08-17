// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  collaborationHttpBase, findBoardPathForRoom, loadBoardRoom, normalizeInviteCode, saveBoardRoom,
} from '../src/collaboration-rooms';

describe('private collaboration room helpers', () => {
  it('maps secure and loopback WebSocket URLs to their HTTP room service', () => {
    expect(collaborationHttpBase('ws://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(collaborationHttpBase('wss://rooms.example.com/socket')).toBe('https://rooms.example.com/socket');
  });

  it('normalises pasted invite codes', () => {
    expect(normalizeInviteCode('  vn-abcd-efgh-jklm  ')).toBe('VN-ABCD-EFGH-JKLM');
  });

  it('keeps each vault and board room association installation-local', () => {
    const room = {
      roomId: 'private:abc', accessToken: 'owner-token', role: 'owner' as const,
      inviteCode: 'VN2-ABCDEFGHJK-ZYXWVUTSRQPN', viewerInviteCode: 'VN2-ABCDEFGHJK-23456789ABCD',
    };
    saveBoardRoom(localStorage, 'Vault A', 'Boards/One.canvas', room);
    expect(loadBoardRoom(localStorage, 'Vault A', 'Boards/One.canvas')).toEqual(room);
    expect(findBoardPathForRoom(localStorage, 'Vault A', room.roomId)).toBe('Boards/One.canvas');
    expect(findBoardPathForRoom(localStorage, 'Vault B', room.roomId)).toBeUndefined();
    expect(loadBoardRoom(localStorage, 'Vault B', 'Boards/One.canvas')).toBeUndefined();
    saveBoardRoom(localStorage, 'Vault A', 'Boards/One.canvas', undefined);
    expect(loadBoardRoom(localStorage, 'Vault A', 'Boards/One.canvas')).toBeUndefined();
  });
});
