import { requestUrl } from 'obsidian';
import type { VisualNotesFile } from './file-types';
import type { CollaborationIdentity } from './collaboration-identity';
import type { CollaborationRole } from './collaboration-transport';

export type CollaborationServiceToken = string | (() => Promise<string>);

export interface CollaborationRoomCredentials {
  roomId: string;
  accessToken: string;
  role: CollaborationRole;
  inviteCode?: string;
  viewerInviteCode?: string;
}

export interface CollaborationRoomMember {
  clientId: string;
  displayName: string;
  role: CollaborationRole;
}

export interface CollaborationRoomStorage {
  usedBytes: number;
  limitBytes: number;
  activeBytes: number;
  orphanedBytes: number;
  orphanedCount: number;
  cleanupEligibleCount: number;
  graceMs: number;
}

export interface CollaborationRoomTreeEntry {
  roomId: string;
  parentRoomId?: string;
  depth: number;
  cardCount: number;
  assetBytes: number;
}

export interface CollaborationChildRoomOpen {
  room: CollaborationRoomCredentials;
  board: VisualNotesFile;
}

export interface CollaborationAccountRoom {
  roomId: string;
  role: CollaborationRole;
  cardCount: number;
  childCount: number;
  sequence: number;
}

export interface CollaborationAccountRoomOpen {
  room: CollaborationRoomCredentials;
  board: VisualNotesFile;
}

interface RoomServiceResponse {
  roomId?: unknown;
  inviteCode?: unknown;
  viewerInviteCode?: unknown;
  accessToken?: unknown;
  role?: unknown;
  error?: unknown;
}

export async function createCollaborationRoom(
  websocketUrl: string,
  serviceToken: CollaborationServiceToken,
  initialBoard: VisualNotesFile,
  identity: CollaborationIdentity,
  label?: string,
): Promise<CollaborationRoomCredentials> {
  // The board's name travels with the room so the host can recognise it
  // later. A room ID is random and a private room's boardId is the room ID
  // again, so without this there is nothing human to show.
  return roomRequest(websocketUrl, '/rooms', serviceToken, { initialBoard, identity, label });
}

export async function resolveCollaborationRoom(
  websocketUrl: string,
  serviceToken: CollaborationServiceToken,
  inviteCode: string,
  identity: CollaborationIdentity,
): Promise<CollaborationRoomCredentials> {
  return roomRequest(websocketUrl, '/rooms/resolve', serviceToken, {
    inviteCode: normalizeInviteCode(inviteCode), identity,
  });
}

export async function listCollaborationAccountRooms(
  websocketUrl: string,
  serviceToken: CollaborationServiceToken,
): Promise<CollaborationAccountRoom[]> {
  const payload = await roomServiceRequest(websocketUrl, '/account/rooms', serviceToken, {});
  if (!Array.isArray(payload.rooms)) throw new Error('Room service returned an invalid account room list.');
  return payload.rooms.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Room service returned an invalid account room.');
    const room = value as Record<string, unknown>;
    if (typeof room.roomId !== 'string' || (room.role !== 'owner' && room.role !== 'editor' && room.role !== 'viewer')
      || typeof room.cardCount !== 'number' || typeof room.childCount !== 'number' || typeof room.sequence !== 'number') {
      throw new Error('Room service returned an invalid account room.');
    }
    return {
      roomId: room.roomId, role: room.role,
      cardCount: room.cardCount, childCount: room.childCount, sequence: room.sequence,
    };
  });
}

export async function openCollaborationAccountRoom(
  websocketUrl: string,
  serviceToken: CollaborationServiceToken,
  roomId: string,
  identity: CollaborationIdentity,
): Promise<CollaborationAccountRoomOpen> {
  const payload = await roomServiceRequest(websocketUrl, '/account/rooms/open', serviceToken, { roomId, identity });
  const room = credentialsFromPayload(payload);
  const board = validateRoomBoard(payload.board);
  return { room, board };
}

export async function createCollaborationChildRoom(
  websocketUrl: string,
  serviceToken: CollaborationServiceToken,
  parent: CollaborationRoomCredentials,
  childKey: string,
  initialBoard: VisualNotesFile,
  identity: CollaborationIdentity,
): Promise<CollaborationRoomCredentials> {
  return roomRequest(websocketUrl, '/rooms/children', serviceToken, {
    parentRoomId: parent.roomId, accessToken: parent.accessToken,
    clientId: identity.clientId, identity, childKey, initialBoard,
  });
}

export async function openCollaborationChildRoom(
  websocketUrl: string,
  serviceToken: CollaborationServiceToken,
  parent: CollaborationRoomCredentials,
  childRoomId: string,
  identity: CollaborationIdentity,
): Promise<CollaborationChildRoomOpen> {
  const payload = await roomServiceRequest(websocketUrl, '/rooms/children/open', serviceToken, {
    parentRoomId: parent.roomId, childRoomId, accessToken: parent.accessToken,
    clientId: identity.clientId, identity,
  });
  const room = credentialsFromPayload(payload);
  return { room, board: validateRoomBoard(payload.board) };
}

export function normalizeInviteCode(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

export async function listCollaborationRoomMembers(
  websocketUrl: string,
  serviceToken: CollaborationServiceToken,
  room: CollaborationRoomCredentials,
  clientId: string,
): Promise<CollaborationRoomMember[]> {
  const payload = await roomServiceRequest(websocketUrl, '/rooms/manage', serviceToken, ownerBody(room, clientId));
  if (!Array.isArray(payload.members)) throw new Error('Room service returned an invalid member list.');
  return payload.members.map(value => {
    if (!value || typeof value !== 'object') throw new Error('Room service returned an invalid member.');
    const member = value as Record<string, unknown>;
    if (typeof member.clientId !== 'string' || typeof member.displayName !== 'string'
      || (member.role !== 'owner' && member.role !== 'editor' && member.role !== 'viewer')) {
      throw new Error('Room service returned an invalid member.');
    }
    return { clientId: member.clientId, displayName: member.displayName, role: member.role };
  });
}

export async function getCollaborationRoomStorage(
  websocketUrl: string,
  serviceToken: CollaborationServiceToken,
  room: CollaborationRoomCredentials,
  clientId: string,
): Promise<CollaborationRoomStorage> {
  const payload = await roomServiceRequest(websocketUrl, '/rooms/manage', serviceToken, ownerBody(room, clientId));
  if (!payload.storage || typeof payload.storage !== 'object') throw new Error('Room service returned invalid storage usage.');
  const storage = payload.storage as Record<string, unknown>;
  if (typeof storage.usedBytes !== 'number' || typeof storage.limitBytes !== 'number'
    || typeof storage.activeBytes !== 'number' || typeof storage.orphanedBytes !== 'number'
    || typeof storage.orphanedCount !== 'number' || typeof storage.cleanupEligibleCount !== 'number'
    || typeof storage.graceMs !== 'number') {
    throw new Error('Room service returned invalid storage usage.');
  }
  return {
    usedBytes: storage.usedBytes, limitBytes: storage.limitBytes,
    activeBytes: storage.activeBytes, orphanedBytes: storage.orphanedBytes,
    orphanedCount: storage.orphanedCount, cleanupEligibleCount: storage.cleanupEligibleCount, graceMs: storage.graceMs,
  };
}

export async function getCollaborationRoomTree(
  websocketUrl: string,
  serviceToken: CollaborationServiceToken,
  room: CollaborationRoomCredentials,
  clientId: string,
): Promise<CollaborationRoomTreeEntry[]> {
  const payload = await roomServiceRequest(websocketUrl, '/rooms/manage', serviceToken, ownerBody(room, clientId));
  if (!Array.isArray(payload.tree)) throw new Error('Room service returned an invalid board tree.');
  return payload.tree.map(value => {
    if (!value || typeof value !== 'object') throw new Error('Room service returned an invalid board tree entry.');
    const entry = value as Record<string, unknown>;
    if (typeof entry.roomId !== 'string' || (entry.parentRoomId !== undefined && typeof entry.parentRoomId !== 'string')
      || typeof entry.depth !== 'number' || typeof entry.cardCount !== 'number' || typeof entry.assetBytes !== 'number') {
      throw new Error('Room service returned an invalid board tree entry.');
    }
    return {
      roomId: entry.roomId, parentRoomId: entry.parentRoomId,
      depth: entry.depth, cardCount: entry.cardCount, assetBytes: entry.assetBytes,
    };
  });
}

export async function cleanupCollaborationRoomAssets(
  websocketUrl: string, serviceToken: CollaborationServiceToken, room: CollaborationRoomCredentials, clientId: string,
): Promise<{ removedFromRoom: number; deletedFiles: number }> {
  const payload = await roomServiceRequest(websocketUrl, '/rooms/assets/cleanup', serviceToken, ownerBody(room, clientId));
  if (typeof payload.removedFromRoom !== 'number' || typeof payload.deletedFiles !== 'number') {
    throw new Error('Room service returned an invalid cleanup result.');
  }
  return { removedFromRoom: payload.removedFromRoom, deletedFiles: payload.deletedFiles };
}

export async function exportCollaborationRoom(
  websocketUrl: string, serviceToken: CollaborationServiceToken, room: CollaborationRoomCredentials, clientId: string,
): Promise<Record<string, unknown>> {
  const payload = await roomServiceRequest(websocketUrl, '/rooms/export', serviceToken, ownerBody(room, clientId));
  if (!payload.export || typeof payload.export !== 'object' || Array.isArray(payload.export)) {
    throw new Error('Room service returned an invalid export.');
  }
  return payload.export as Record<string, unknown>;
}

export async function deleteCollaborationRoom(
  websocketUrl: string, serviceToken: CollaborationServiceToken, room: CollaborationRoomCredentials, clientId: string,
): Promise<void> {
  await roomServiceRequest(websocketUrl, '/rooms/delete', serviceToken, ownerBody(room, clientId));
}

export async function rotateCollaborationRoomInvite(
  websocketUrl: string,
  serviceToken: CollaborationServiceToken,
  room: CollaborationRoomCredentials,
  clientId: string,
  role: 'editor' | 'viewer',
): Promise<string> {
  const payload = await roomServiceRequest(websocketUrl, '/rooms/invites/rotate', serviceToken, {
    ...ownerBody(room, clientId), role,
  });
  if (typeof payload.inviteCode !== 'string') throw new Error('Room service returned an invalid invite code.');
  return payload.inviteCode;
}

export async function removeCollaborationRoomMember(
  websocketUrl: string,
  serviceToken: CollaborationServiceToken,
  room: CollaborationRoomCredentials,
  clientId: string,
  memberClientId: string,
): Promise<void> {
  await roomServiceRequest(websocketUrl, '/rooms/members/remove', serviceToken, {
    ...ownerBody(room, clientId), memberClientId,
  });
}

export function collaborationHttpBase(websocketUrl: string): string {
  const url = new URL(websocketUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

async function roomRequest(
  websocketUrl: string,
  path: string,
  serviceToken: CollaborationServiceToken,
  body: Record<string, unknown>,
): Promise<CollaborationRoomCredentials> {
  const payload = await roomServiceRequest(websocketUrl, path, serviceToken, body) as RoomServiceResponse;
  return credentialsFromPayload(payload);
}

function credentialsFromPayload(payload: RoomServiceResponse): CollaborationRoomCredentials {
  if (typeof payload.roomId !== 'string' || typeof payload.accessToken !== 'string'
    || (payload.role !== 'owner' && payload.role !== 'editor' && payload.role !== 'viewer')) {
    throw new Error('Room service returned invalid credentials.');
  }
  return {
    roomId: payload.roomId, accessToken: payload.accessToken, role: payload.role,
    inviteCode: typeof payload.inviteCode === 'string' ? payload.inviteCode : undefined,
    viewerInviteCode: typeof payload.viewerInviteCode === 'string' ? payload.viewerInviteCode : undefined,
  };
}

function validateRoomBoard(value: unknown): VisualNotesFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Room service returned an invalid board.');
  const board = value as Partial<VisualNotesFile>;
  if ((board.version !== 2 && board.version !== 3) || board.layout !== 'freeform'
    || !Array.isArray(board.cards) || !Array.isArray(board.connections) || !Array.isArray(board.drawings)) {
    throw new Error('Room service returned an invalid board.');
  }
  return board as VisualNotesFile;
}

async function roomServiceRequest(
  websocketUrl: string,
  path: string,
  serviceToken: CollaborationServiceToken,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const token = typeof serviceToken === 'string' ? serviceToken : await serviceToken();
  const response = await requestUrl({
    url: `${collaborationHttpBase(websocketUrl)}${path}`,
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    throw: false,
  });
  const payload = response.json as Record<string, unknown>;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : `Room service returned ${response.status}.`);
  }
  return payload;
}

function ownerBody(room: CollaborationRoomCredentials, clientId: string): Record<string, unknown> {
  return { roomId: room.roomId, accessToken: room.accessToken, clientId };
}

export function loadBoardRoom(storage: Storage, vaultName: string, boardPath: string): CollaborationRoomCredentials | undefined {
  try {
    const raw = storage.getItem(roomStorageKey(vaultName, boardPath));
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<CollaborationRoomCredentials>;
    if (typeof value.roomId !== 'string' || typeof value.accessToken !== 'string'
      || (value.role !== 'owner' && value.role !== 'editor' && value.role !== 'viewer')) return undefined;
    return {
      roomId: value.roomId, accessToken: value.accessToken, role: value.role,
      inviteCode: typeof value.inviteCode === 'string' ? value.inviteCode : undefined,
      viewerInviteCode: typeof value.viewerInviteCode === 'string' ? value.viewerInviteCode : undefined,
    };
  } catch { return undefined; }
}

export function saveBoardRoom(
  storage: Storage,
  vaultName: string,
  boardPath: string,
  room: CollaborationRoomCredentials | undefined,
): void {
  const key = roomStorageKey(vaultName, boardPath);
  if (room) storage.setItem(key, JSON.stringify(room));
  else storage.removeItem(key);
}

export function findBoardPathForRoom(storage: Storage, vaultName: string, roomId: string): string | undefined {
  const prefix = `visual-notes:collaboration-room:${encodeURIComponent(vaultName)}:`;
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    try {
      const value = JSON.parse(storage.getItem(key) ?? '') as Partial<CollaborationRoomCredentials>;
      if (value.roomId === roomId) return decodeURIComponent(key.slice(prefix.length));
    } catch { /* ignore corrupt or unrelated localStorage entries */ }
  }
  return undefined;
}

function roomStorageKey(vaultName: string, boardPath: string): string {
  return `visual-notes:collaboration-room:${encodeURIComponent(vaultName)}:${encodeURIComponent(boardPath)}`;
}
