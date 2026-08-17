// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestUrl = vi.hoisted(() => vi.fn());
vi.mock('obsidian', () => ({ requestUrl }));

import { listCollaborationAccountRooms, openCollaborationAccountRoom } from '../src/collaboration-rooms';

const identity = { clientId: 'client-new', displayName: 'Alice laptop', color: '#81c784' };
const board = { version: 3 as const, layout: 'freeform' as const, cards: [], connections: [], drawings: [] };

describe('collaboration account rooms client', () => {
  beforeEach(() => requestUrl.mockReset());

  it('lists validated rooms with a current account token', async () => {
    requestUrl.mockResolvedValue({ status: 200, json: { rooms: [
      { roomId: 'private:ONE', role: 'owner', cardCount: 3, childCount: 2, sequence: 9 },
    ] } });
    const token = vi.fn().mockResolvedValue('fresh-account-token');
    await expect(listCollaborationAccountRooms('wss://rooms.example.com', token)).resolves.toEqual([
      { roomId: 'private:ONE', role: 'owner', cardCount: 3, childCount: 2, sequence: 9 },
    ]);
    expect(requestUrl).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://rooms.example.com/account/rooms',
      headers: expect.objectContaining({ authorization: 'Bearer fresh-account-token' }),
    }));
  });

  it('opens an account room for a new installation and validates its board', async () => {
    requestUrl.mockResolvedValue({ status: 200, json: {
      roomId: 'private:ONE', accessToken: 'new-device-room-token', role: 'editor', board,
    } });
    await expect(openCollaborationAccountRoom(
      'wss://rooms.example.com', 'account-token', 'private:ONE', identity,
    )).resolves.toEqual({
      room: { roomId: 'private:ONE', accessToken: 'new-device-room-token', role: 'editor' }, board,
    });
  });

  it('rejects malformed room lists instead of trusting hosted data', async () => {
    requestUrl.mockResolvedValue({ status: 200, json: { rooms: [{ roomId: 'private:ONE', role: 'admin' }] } });
    await expect(listCollaborationAccountRooms('wss://rooms.example.com', 'token'))
      .rejects.toThrow('invalid account room');
  });
});
