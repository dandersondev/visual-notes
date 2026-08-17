import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { applyBoardOperation, type BoardOperation } from '../../src/collaboration-operations';
import {
  COLLABORATION_PROTOCOL_VERSION,
  decodeClientMessage,
  encodeCollaborationMessage,
  type CollaborationServerMessage,
  type CollaborationClientCompatibility,
} from '../../src/collaboration-protocol';
import type { CollaborationIdentity } from '../../src/collaboration-identity';
import type { CollaborationPresence, CollaborationRole, CollaborationRoomSnapshot, SequencedBoardOperation } from '../../src/collaboration-transport';
import type { VisualNotesFile } from '../../src/file-types';
import {
  createServiceAuthenticator, principalMatchesAccount, serviceAccountId, type ServicePrincipal,
} from './service-auth';
import { AssetBlobStore, RoomDocumentStore, joinPath } from './persistence-selected';
import { requireDesktopNodeModule } from './desktop-node';

const { createHash, randomBytes } = requireDesktopNodeModule<typeof import('node:crypto')>('node:crypto');
const { createServer } = requireDesktopNodeModule<typeof import('node:http')>('node:http');

const host = process.env.VISUAL_NOTES_COLLAB_HOST ?? '127.0.0.1';
const port = numberEnv('VISUAL_NOTES_COLLAB_PORT', numberEnv('PORT', 8787));
const serviceAuthenticator = createServiceAuthenticator(process.env);
// The plugin always passes an explicit directory; the bare fallback is for
// `npm run collab:start`. It is '.data', not 'collaboration-server/.data':
// npm runs a workspace script with the workspace folder as cwd, so the longer
// path resolved to a nested collaboration-server/collaboration-server/.data
// that quietly accumulated real room JSON and transferred assets.
const dataDirectory = process.env.VISUAL_NOTES_COLLAB_DATA ?? '.data';
const maxPayload = numberEnv('VISUAL_NOTES_COLLAB_MAX_PAYLOAD', 4 * 1024 * 1024);
const maxAssetSize = numberEnv('VISUAL_NOTES_COLLAB_MAX_ASSET', 20 * 1024 * 1024);
const maxVideoAssetSize = numberEnv('VISUAL_NOTES_COLLAB_MAX_VIDEO_ASSET', 250 * 1024 * 1024);
const maxRoomAssetBytes = numberEnv('VISUAL_NOTES_COLLAB_MAX_ROOM_ASSETS', 2 * 1024 * 1024 * 1024);
const assetOrphanGraceMs = numberEnv('VISUAL_NOTES_COLLAB_ASSET_GRACE_MS', 7 * 24 * 60 * 60 * 1000);
const allowedAssetTypes = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm',
]);
const playbackTicketLifetimeMs = numberEnv('VISUAL_NOTES_COLLAB_TICKET_TTL_MS', 4 * 60 * 60 * 1000);
const maxRetainedOperations = numberEnv('VISUAL_NOTES_COLLAB_RETAINED_OPERATIONS', 2_000);

interface PersistedRoom {
  formatVersion: 1 | 2 | 3;
  roomId: string;
  boardId: string;
  board: VisualNotesFile;
  sequence: number;
  maxLogicalClock: number;
  operations: SequencedBoardOperation[];
  inviteHash?: string;
  memberships?: Record<string, PersistedMembership>;
  invites?: PersistedInvite[];
  assets?: Record<string, PersistedAsset>;
  parentRoomId?: string;
  childKey?: string;
  /** The board's name when the room was created. Rooms made before this
   *  existed have none, and fall back to a summary of their contents. */
  label?: string;
}

interface PersistedAsset { mimeType: string; size: number; name?: string; createdAt: number; orphanedAt?: number }

interface PersistedMembership {
  role: CollaborationRole;
  accessTokenHash: string;
  displayName: string;
  joinedAt: number;
  accountId?: string;
}

interface PersistedInvite {
  id: string;
  codeHash: string;
  role: Exclude<CollaborationRole, 'owner'>;
  revoked: boolean;
  createdAt: number;
}

const roomDocuments = new RoomDocumentStore<PersistedRoom>(
  dataDirectory, validatePersistedRoom,
  roomId => `${createHash('sha256').update(roomId).digest('hex')}.json`,
);
const assetBlobs = new AssetBlobStore(joinPath(dataDirectory, 'assets'));

interface Member {
  socket: WebSocket;
  identity: CollaborationIdentity;
  presence: CollaborationPresence;
  compatibility: CollaborationClientCompatibility;
  role: CollaborationRole;
  accessToken?: string;
  servicePrincipal: ServicePrincipal;
}

class HostedRoom {
  readonly members = new Map<WebSocket, Member>();
  readonly operationsById = new Map<string, SequencedBoardOperation>();
  private publishChain: Promise<void> = Promise.resolve();

  constructor(private state: PersistedRoom) {
    for (const operation of state.operations) this.operationsById.set(operation.operation.operationId, operation);
    this.reconcileAssets();
  }

  static async loadOrCreate(roomId: string, boardId: string, initialBoard: VisualNotesFile): Promise<HostedRoom> {
    try {
      const persisted = await roomDocuments.load(roomId);
      if (persisted.roomId !== roomId || persisted.boardId !== boardId) throw new Error('Room belongs to a different board.');
      return new HostedRoom(persisted);
    } catch (error) {
      if (isMissingFile(error)) {
        const state: PersistedRoom = {
          formatVersion: 1, roomId, boardId, board: structuredClone(initialBoard),
          sequence: 0, maxLogicalClock: 0, operations: [],
        };
        const room = new HostedRoom(state);
        await room.persist();
        return room;
      }
      throw error;
    }
  }

  static async createPrivate(
    owner: CollaborationIdentity,
    initialBoard: VisualNotesFile,
    principal: ServicePrincipal,
    label?: string,
  ): Promise<{ room: HostedRoom; accessToken: string; editorInviteCode: string; viewerInviteCode: string }> {
    const locator = randomCode(10);
    const roomId = `private:${locator}`;
    const accessToken = createAccessToken();
    const editorInviteCode = createInviteCode(locator);
    const viewerInviteCode = createInviteCode(locator);
    const state: PersistedRoom = {
      formatVersion: 3, roomId, boardId: roomId, board: structuredClone(initialBoard),
      sequence: 0, maxLogicalClock: 0, operations: [],
      ...(label ? { label } : {}),
      memberships: {
        [owner.clientId]: {
          role: 'owner', accessTokenHash: hash(accessToken), displayName: owner.displayName, joinedAt: Date.now(),
          ...(serviceAccountId(principal) ? { accountId: serviceAccountId(principal) } : {}),
        },
      },
      invites: [
        { id: cryptoId(), codeHash: hash(editorInviteCode), role: 'editor', revoked: false, createdAt: Date.now() },
        { id: cryptoId(), codeHash: hash(viewerInviteCode), role: 'viewer', revoked: false, createdAt: Date.now() },
      ],
      assets: {},
    };
    const room = new HostedRoom(state);
    await room.persist();
    return { room, accessToken, editorInviteCode, viewerInviteCode };
  }

  static async loadExisting(roomId: string): Promise<HostedRoom> {
    const persisted = await roomDocuments.load(roomId);
    if (persisted.roomId !== roomId) throw new Error('Room ID does not match its stored data.');
    return new HostedRoom(persisted);
  }

  static async loadOrCreateChild(
    parentRoomId: string,
    childKey: string,
    identity: CollaborationIdentity,
    role: CollaborationRole,
    accessToken: string,
    initialBoard: VisualNotesFile,
    principal: ServicePrincipal,
  ): Promise<HostedRoom> {
    const roomId = childRoomId(parentRoomId, childKey);
    try {
      const persisted = await roomDocuments.load(roomId);
      if (persisted.parentRoomId !== parentRoomId || persisted.childKey !== childKey) {
        throw new Error('Nested room identity collides with different room data.');
      }
      return new HostedRoom(persisted);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    const state: PersistedRoom = {
      formatVersion: 3, roomId, boardId: roomId, parentRoomId, childKey,
      board: structuredClone(initialBoard), sequence: 0, maxLogicalClock: 0, operations: [],
      memberships: {
        [identity.clientId]: {
          role, accessTokenHash: hash(accessToken), displayName: identity.displayName, joinedAt: Date.now(),
          ...(serviceAccountId(principal) ? { accountId: serviceAccountId(principal) } : {}),
        },
      },
      invites: [], assets: {},
    };
    const room = new HostedRoom(state);
    await room.persist();
    return room;
  }

  acceptsInvite(inviteCode: string | undefined): boolean {
    return this.state.inviteHash === undefined || (inviteCode !== undefined && hash(normalizeInviteCode(inviteCode)) === this.state.inviteHash);
  }

  async redeemInvite(inviteCode: string, identity: CollaborationIdentity, principal: ServicePrincipal): Promise<{ accessToken: string; role: CollaborationRole }> {
    const invite = this.state.invites?.find(candidate => !candidate.revoked && candidate.codeHash === hash(inviteCode));
    if (!invite) throw new Error('Invite code is invalid or has been revoked.');
    const existing = this.state.memberships?.[identity.clientId];
    if (existing && !principalMatchesAccount(principal, existing.accountId)) {
      throw new Error('This collaboration device ID is already registered to another account.');
    }
    if (existing?.role === 'owner') throw new Error('The room owner should reconnect with their saved owner access.');
    const accessToken = createAccessToken();
    const role = existing?.role === 'editor' ? 'editor' : invite.role;
    (this.state.memberships ??= {})[identity.clientId] = {
      role, accessTokenHash: hash(accessToken), displayName: identity.displayName,
      joinedAt: existing?.joinedAt ?? Date.now(),
      ...(serviceAccountId(principal) ? { accountId: serviceAccountId(principal) } : {}),
    };
    await this.persist();
    return { accessToken, role };
  }

  /** See claimHostedRoomOwnership -- callable only from the host's own process. */
  async grantOwnership(identity: CollaborationIdentity): Promise<{ accessToken: string; role: CollaborationRole }> {
    const accessToken = createAccessToken();
    const existing = this.state.memberships?.[identity.clientId];
    (this.state.memberships ??= {})[identity.clientId] = {
      ...existing,
      role: 'owner',
      accessTokenHash: hash(accessToken),
      displayName: identity.displayName,
      joinedAt: existing?.joinedAt ?? Date.now(),
    };
    await this.persist();
    return { accessToken, role: 'owner' };
  }

  authenticate(clientId: string, accessToken: string | undefined, principal?: ServicePrincipal): CollaborationRole | undefined {
    if (!accessToken) return undefined;
    const membership = this.state.memberships?.[clientId];
    return membership && membership.accessTokenHash === hash(accessToken)
      && (!principal || principalMatchesAccount(principal, membership.accountId)) ? membership.role : undefined;
  }

  accountRole(principal: ServicePrincipal): CollaborationRole | undefined {
    const accountId = serviceAccountId(principal);
    if (!accountId) return undefined;
    const roles = Object.values(this.state.memberships ?? {})
      .filter(membership => membership.accountId === accountId)
      .map(membership => membership.role);
    return strongestRole(roles);
  }

  async openForAccount(
    identity: CollaborationIdentity,
    principal: ServicePrincipal,
  ): Promise<{ accessToken: string; role: CollaborationRole; board: VisualNotesFile }> {
    const accountId = serviceAccountId(principal);
    if (!accountId) throw new Error('Account sign-in is required to discover rooms.');
    const role = this.accountRole(principal);
    if (!role) throw new Error('This room does not belong to the signed-in account.');
    const existing = this.state.memberships?.[identity.clientId];
    if (existing?.accountId && existing.accountId !== accountId) {
      throw new Error('This collaboration device ID is already registered to another account.');
    }
    const accessToken = createAccessToken();
    (this.state.memberships ??= {})[identity.clientId] = {
      role, accessTokenHash: hash(accessToken), displayName: identity.displayName,
      joinedAt: existing?.joinedAt ?? Date.now(), accountId,
    };
    await this.persist();
    return { accessToken, role, board: this.boardSnapshot() };
  }

  get parentRoomId(): string | undefined { return this.state.parentRoomId; }

  async grantInherited(identity: CollaborationIdentity, role: CollaborationRole, accessToken: string, principal: ServicePrincipal): Promise<void> {
    const existing = this.state.memberships?.[identity.clientId];
    if (existing && !principalMatchesAccount(principal, existing.accountId)) {
      throw new Error('This collaboration device ID is already registered to another account.');
    }
    (this.state.memberships ??= {})[identity.clientId] = {
      role, accessTokenHash: hash(accessToken), displayName: identity.displayName,
      joinedAt: existing?.joinedAt ?? Date.now(),
      ...(serviceAccountId(principal) ? { accountId: serviceAccountId(principal) } : {}),
    };
    await this.persist();
  }

  boardSnapshot(): VisualNotesFile { return structuredClone(this.state.board); }

  asset(hashValue: string): PersistedAsset | undefined { return this.state.assets?.[hashValue]; }

  assertAssetCapacity(hashValue: string, size: number): void {
    if (this.state.assets?.[hashValue]) return;
    const used = Object.values(this.state.assets ?? {}).reduce((total, asset) => total + asset.size, 0);
    if (used + size > maxRoomAssetBytes) throw new Error('This room has reached its shared-media storage limit.');
  }

  async registerAsset(hashValue: string, asset: PersistedAsset): Promise<void> {
    const referenced = boardAssetHashes(this.state.board).has(hashValue);
    (this.state.assets ??= {})[hashValue] = { ...asset, ...(referenced ? {} : { orphanedAt: Date.now() }) };
    this.state.formatVersion = 3;
    await this.persist();
  }

  async rotateInvite(
    ownerClientId: string,
    accessToken: string,
    role: Exclude<CollaborationRole, 'owner'>,
  ): Promise<string> {
    if (this.authenticate(ownerClientId, accessToken) !== 'owner') throw new Error('Only the room owner can replace invites.');
    for (const invite of this.state.invites ?? []) if (invite.role === role) invite.revoked = true;
    const locator = this.state.roomId.replace(/^private:/, '');
    const inviteCode = createInviteCode(locator);
    (this.state.invites ??= []).push({
      id: cryptoId(), codeHash: hash(inviteCode), role, revoked: false, createdAt: Date.now(),
    });
    await this.persist();
    return inviteCode;
  }

  async removeMembership(ownerClientId: string, accessToken: string, clientId: string): Promise<void> {
    if (this.authenticate(ownerClientId, accessToken) !== 'owner') throw new Error('Only the room owner can remove members.');
    if (clientId === ownerClientId) throw new Error('The room owner cannot remove themselves.');
    if (!this.state.memberships?.[clientId]) throw new Error('Room member was not found.');
    delete this.state.memberships[clientId];
    await this.persist();
    for (const member of this.members.values()) {
      if (member.identity.clientId === clientId) member.socket.close(4004, 'Removed from room');
    }
  }

  managementSnapshot(ownerClientId: string, accessToken: string): {
    members: Array<{ clientId: string; displayName: string; role: CollaborationRole }>;
    storage: { usedBytes: number; limitBytes: number; activeBytes: number; orphanedBytes: number; orphanedCount: number; cleanupEligibleCount: number; graceMs: number };
  } {
    if (this.authenticate(ownerClientId, accessToken) !== 'owner') throw new Error('Only the room owner can manage members.');
    return {
      members: Object.entries(this.state.memberships ?? {}).map(([clientId, membership]) => ({
        clientId, displayName: membership.displayName, role: membership.role,
      })).sort((a, b) => a.displayName.localeCompare(b.displayName)),
      storage: this.storageSnapshot(),
    };
  }

  exportSnapshot(ownerClientId: string, accessToken: string): Record<string, unknown> {
    if (this.authenticate(ownerClientId, accessToken) !== 'owner') throw new Error('Only the room owner can export this room.');
    return {
      formatVersion: 1, exportedAt: Date.now(), roomId: this.state.roomId,
      board: structuredClone(this.state.board),
      assets: Object.entries(this.state.assets ?? {}).map(([assetHash, asset]) => ({ hash: assetHash, ...asset })),
    };
  }

  async cleanupAssets(ownerClientId: string, accessToken: string): Promise<string[]> {
    if (this.authenticate(ownerClientId, accessToken) !== 'owner') throw new Error('Only the room owner can clean up media.');
    this.reconcileAssets();
    const cutoff = Date.now() - assetOrphanGraceMs;
    const removed: string[] = [];
    for (const [assetHash, asset] of Object.entries(this.state.assets ?? {})) {
      if (asset.orphanedAt !== undefined && asset.orphanedAt <= cutoff) {
        delete this.state.assets?.[assetHash]; removed.push(assetHash);
      }
    }
    if (removed.length > 0) await this.persist();
    return removed;
  }

  authorizeDeletion(ownerClientId: string, accessToken: string): string[] {
    if (this.authenticate(ownerClientId, accessToken) !== 'owner') throw new Error('Only the room owner can delete this room.');
    return Object.keys(this.state.assets ?? {});
  }

  assetHashes(): string[] { return Object.keys(this.state.assets ?? {}); }

  closeForDeletion(): void {
    for (const member of this.members.values()) member.socket.close(4004, 'Room deleted');
    this.members.clear();
  }

  get roomId(): string { return this.state.roomId; }

  join(
    socket: WebSocket,
    identity: CollaborationIdentity,
    compatibility: CollaborationClientCompatibility,
    role: CollaborationRole = 'editor',
    accessToken?: string,
    servicePrincipal: ServicePrincipal = { kind: 'development' },
  ): CollaborationRoomSnapshot {
    this.members.set(socket, {
      socket, identity, compatibility, role, accessToken, servicePrincipal,
      presence: {
        clientId: identity.clientId, displayName: identity.displayName, color: identity.color,
        selectedIds: [], updatedAt: Date.now(),
      },
    });
    this.broadcastPresence();
    this.broadcastCompatibility();
    return this.snapshot(role);
  }

  compatibilityError(compatibility: CollaborationClientCompatibility): string | undefined {
    if (!compatibility.supportedBoardVersions.includes(this.state.board.version)) {
      return `This room uses board schema ${this.state.board.version}, which Visual Notes ${compatibility.pluginVersion} does not support.`;
    }
    return undefined;
  }

  leave(socket: WebSocket): void {
    if (!this.members.delete(socket)) return;
    this.broadcastPresence();
    this.broadcastCompatibility();
  }

  publish(member: Member, operation: BoardOperation): Promise<void> {
    const result = this.publishChain.then(() => this.publishNow(member, operation));
    this.publishChain = result.catch(() => { /* keep later room operations flowing */ });
    return result;
  }

  private async publishNow(member: Member, operation: BoardOperation): Promise<void> {
    if (member.role === 'viewer') return send(member.socket, rejection(operation.operationId, 'Viewers cannot edit this room.'));
    if (operation.boardId !== this.state.boardId) return send(member.socket, rejection(operation.operationId, 'Operation belongs to a different board.'));
    if (operation.clientId !== member.identity.clientId) return send(member.socket, rejection(operation.operationId, 'Operation client does not match the authenticated connection.'));
    if (operation.actor.displayName !== member.identity.displayName || operation.actor.color !== member.identity.color) {
      return send(member.socket, rejection(operation.operationId, 'Operation actor does not match the authenticated connection.'));
    }
    const duplicate = this.operationsById.get(operation.operationId);
    if (duplicate) {
      send(member.socket, { type: 'operation-accepted', operationId: operation.operationId, sequence: duplicate.sequence });
      return;
    }
    const applied = applyBoardOperation(this.state.board, operation);
    if (!applied.applied) return send(member.socket, rejection(operation.operationId, applied.error ?? 'Operation was rejected.'));

    this.state.board = applied.board;
    this.reconcileAssets();
    this.state.sequence++;
    this.state.maxLogicalClock = Math.max(this.state.maxLogicalClock, operation.logicalClock);
    const message: SequencedBoardOperation = { sequence: this.state.sequence, operation: structuredClone(operation) };
    this.state.operations.push(message);
    this.operationsById.set(operation.operationId, message);
    while (this.state.operations.length > maxRetainedOperations) {
      const removed = this.state.operations.shift();
      if (removed) this.operationsById.delete(removed.operation.operationId);
    }
    await this.persist();
    this.broadcast({ type: 'operation', message });
    send(member.socket, { type: 'operation-accepted', operationId: operation.operationId, sequence: message.sequence });
  }

  updatePresence(socket: WebSocket, patch: { cursor?: { x: number; y: number } | null; selectedIds?: string[] }): void {
    const member = this.members.get(socket);
    if (!member) return;
    if (patch.cursor === null) delete member.presence.cursor;
    else if (patch.cursor !== undefined) member.presence.cursor = structuredClone(patch.cursor);
    if (patch.selectedIds !== undefined) member.presence.selectedIds = [...patch.selectedIds];
    member.presence.updatedAt = Date.now();
    this.broadcastPresence();
  }

  member(socket: WebSocket): Member | undefined { return this.members.get(socket); }

  private snapshot(role?: CollaborationRole): CollaborationRoomSnapshot {
    return {
      roomId: this.state.roomId, boardId: this.state.boardId, board: structuredClone(this.state.board),
      sequence: this.state.sequence, maxLogicalClock: this.state.maxLogicalClock,
      collaborators: this.presenceList(),
      role,
    };
  }

  private broadcastPresence(): void {
    this.broadcast({ type: 'presence', collaborators: this.presenceList() });
  }

  private broadcastCompatibility(): void {
    const versions = new Set([...this.members.values()].map(member => member.compatibility.pluginVersion));
    const warning = versions.size > 1
      ? [`Collaborators are using different Visual Notes versions (${[...versions].sort().join(', ')}). The shared schema is compatible, but matching versions are recommended.`]
      : [];
    for (const member of this.members.values()) send(member.socket, { type: 'compatibility', warnings: warning });
  }

  private presenceList(): CollaborationPresence[] {
    const byClient = new Map<string, CollaborationPresence>();
    for (const member of this.members.values()) {
      const existing = byClient.get(member.identity.clientId);
      if (!existing || existing.updatedAt <= member.presence.updatedAt) byClient.set(member.identity.clientId, member.presence);
    }
    return [...byClient.values()].map(value => structuredClone(value)).sort((a, b) => a.clientId.localeCompare(b.clientId));
  }

  private broadcast(message: CollaborationServerMessage): void {
    for (const member of this.members.values()) send(member.socket, message);
  }

  private async persist(): Promise<void> {
    await roomDocuments.save(this.state.roomId, this.state);
  }

  private reconcileAssets(now = Date.now()): void {
    const referenced = boardAssetHashes(this.state.board);
    for (const [assetHash, asset] of Object.entries(this.state.assets ?? {})) {
      if (referenced.has(assetHash)) delete asset.orphanedAt;
      else asset.orphanedAt ??= now;
    }
  }

  private storageSnapshot(): {
    usedBytes: number; limitBytes: number; activeBytes: number; orphanedBytes: number; orphanedCount: number; cleanupEligibleCount: number; graceMs: number;
  } {
    let activeBytes = 0; let orphanedBytes = 0; let orphanedCount = 0; let cleanupEligibleCount = 0;
    const cutoff = Date.now() - assetOrphanGraceMs;
    for (const asset of Object.values(this.state.assets ?? {})) {
      if (asset.orphanedAt === undefined) activeBytes += asset.size;
      else {
        orphanedBytes += asset.size; orphanedCount++;
        if (asset.orphanedAt <= cutoff) cleanupEligibleCount++;
      }
    }
    return {
      usedBytes: activeBytes + orphanedBytes, limitBytes: maxRoomAssetBytes,
      activeBytes, orphanedBytes, orphanedCount, cleanupEligibleCount, graceMs: assetOrphanGraceMs,
    };
  }
}

const rooms = new Map<string, Promise<HostedRoom>>();
const playbackTickets = new Map<string, {
  roomId: string; assetHash: string; clientId: string; accessToken: string;
  servicePrincipal: ServicePrincipal; expiresAt: number;
}>();
function getRoom(roomId: string, boardId: string, initialBoard: VisualNotesFile): Promise<HostedRoom> {
  let room = rooms.get(roomId);
  if (!room) {
    room = HostedRoom.loadOrCreate(roomId, boardId, initialBoard);
    rooms.set(roomId, room);
    void room.catch(() => rooms.delete(roomId));
  }
  return room;
}

function getPrivateRoom(roomId: string): Promise<HostedRoom> {
  let room = rooms.get(roomId);
  if (!room) {
    room = HostedRoom.loadExisting(roomId);
    rooms.set(roomId, room);
    void room.catch(() => rooms.delete(roomId));
  }
  return room;
}

function getOrCreateChildRoom(
  parentRoomId: string, childKey: string, identity: CollaborationIdentity,
  role: CollaborationRole, accessToken: string, initialBoard: VisualNotesFile, principal: ServicePrincipal,
): Promise<HostedRoom> {
  const roomId = childRoomId(parentRoomId, childKey);
  let room = rooms.get(roomId);
  if (!room) {
    room = HostedRoom.loadOrCreateChild(parentRoomId, childKey, identity, role, accessToken, initialBoard, principal);
    rooms.set(roomId, room);
    void room.catch(() => rooms.delete(roomId));
  }
  return room;
}

async function authenticateHostedRoom(
  room: HostedRoom, clientId: string, accessToken: string | undefined, principal: ServicePrincipal,
): Promise<CollaborationRole | undefined> {
  const direct = room.authenticate(clientId, accessToken, principal);
  if (!room.parentRoomId) return direct;
  const parent = await getPrivateRoom(room.parentRoomId);
  return authenticateHostedRoom(parent, clientId, accessToken, principal);
}

async function roomTreeRoot(room: HostedRoom): Promise<string> {
  const seen = new Set<string>();
  let current = room;
  while (current.parentRoomId) {
    if (!seen.add(current.roomId)) throw new Error('Collaboration room tree contains a cycle.');
    current = await getPrivateRoom(current.parentRoomId);
  }
  return current.roomId;
}

async function roomsShareTree(left: HostedRoom, right: HostedRoom): Promise<boolean> {
  return await roomTreeRoot(left) === await roomTreeRoot(right);
}

async function persistedRooms(): Promise<PersistedRoom[]> {
  return roomDocuments.list();
}

async function accountRoomSummaries(principal: ServicePrincipal): Promise<Array<{
  roomId: string; role: CollaborationRole; cardCount: number; childCount: number; sequence: number;
}>> {
  const accountId = serviceAccountId(principal);
  if (!accountId) throw new Error('Account sign-in is required to discover rooms.');
  const states = await persistedRooms();
  return states.flatMap(state => {
    if (state.parentRoomId) return [];
    const role = strongestRole(Object.values(state.memberships ?? {})
      .filter(membership => membership.accountId === accountId)
      .map(membership => membership.role));
    return role ? [{
      roomId: state.roomId, role, cardCount: state.board.cards.length,
      childCount: Math.max(0, roomSubtree(states, state.roomId).length - 1), sequence: state.sequence,
    }] : [];
  }).sort((left, right) => left.roomId.localeCompare(right.roomId));
}

function roomSubtree(states: PersistedRoom[], rootRoomId: string): PersistedRoom[] {
  const children = new Map<string, PersistedRoom[]>();
  for (const state of states) {
    if (!state.parentRoomId) continue;
    const list = children.get(state.parentRoomId) ?? [];
    list.push(state); children.set(state.parentRoomId, list);
  }
  const root = states.find(state => state.roomId === rootRoomId);
  if (!root) return [];
  const output: PersistedRoom[] = [];
  const visit = (state: PersistedRoom) => {
    output.push(state);
    for (const child of (children.get(state.roomId) ?? []).sort((a, b) => a.roomId.localeCompare(b.roomId))) visit(child);
  };
  visit(root);
  return output;
}

async function collaborationTree(room: HostedRoom): Promise<Array<{
  roomId: string; parentRoomId?: string; depth: number; cardCount: number; assetBytes: number;
}>> {
  const rootId = await roomTreeRoot(room);
  const states = roomSubtree(await persistedRooms(), rootId);
  const depthById = new Map<string, number>([[rootId, 0]]);
  return states.map(state => {
    const depth = state.parentRoomId ? (depthById.get(state.parentRoomId) ?? -1) + 1 : 0;
    depthById.set(state.roomId, depth);
    return {
      roomId: state.roomId, ...(state.parentRoomId ? { parentRoomId: state.parentRoomId } : {}), depth,
      cardCount: state.board.cards.length,
      assetBytes: Object.values(state.assets ?? {}).reduce((total, asset) => total + asset.size, 0),
    };
  });
}

async function exportCollaborationTree(room: HostedRoom, clientId: string, accessToken: string): Promise<Record<string, unknown>> {
  const rootExport = room.exportSnapshot(clientId, accessToken);
  const rootId = await roomTreeRoot(room);
  const states = roomSubtree(await persistedRooms(), rootId);
  return {
    ...rootExport,
    tree: states.map(state => ({
      roomId: state.roomId, parentRoomId: state.parentRoomId,
      board: structuredClone(state.board),
      assets: Object.entries(state.assets ?? {}).map(([assetHash, asset]) => ({ hash: assetHash, ...asset })),
    })),
  };
}

async function deleteCollaborationSubtree(roomId: string): Promise<{ deletedRooms: number; deletedFiles: number }> {
  const states = roomSubtree(await persistedRooms(), roomId);
  const assetHashes = new Set<string>();
  for (const state of [...states].reverse()) {
    const room = await getPrivateRoom(state.roomId);
    room.assetHashes().forEach(value => assetHashes.add(value));
    room.closeForDeletion();
    await roomDocuments.delete(state.roomId);
    rooms.delete(state.roomId);
    for (const [ticket, value] of playbackTickets) if (value.roomId === state.roomId) playbackTickets.delete(ticket);
  }
  return { deletedRooms: states.length, deletedFiles: await purgeUnregisteredAssets([...assetHashes]) };
}

const httpServer = createServer((request, response) => { void (async () => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, protocolVersion: COLLABORATION_PROTOCOL_VERSION, authMode: serviceAuthenticator.mode }));
    return;
  }
  if (request.method === 'GET' && request.url === '/ready') {
    try {
      await roomDocuments.ready();
      await assetBlobs.ready();
      await serviceAuthenticator.ready();
      jsonResponse(response, 200, { ok: true, authMode: serviceAuthenticator.mode });
    } catch (error) {
      jsonResponse(response, 503, { ok: false, error: error instanceof Error ? error.message : 'Service is not ready.' });
    }
    return;
  }
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (requestUrl.pathname.startsWith('/assets/')) {
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-expose-headers', 'accept-ranges, content-length, content-range');
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-methods': 'GET, HEAD, POST, PUT, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, x-visual-notes-room, x-visual-notes-client, x-visual-notes-access, x-visual-notes-asset-name',
        'access-control-max-age': '600',
      });
      response.end(); return;
    }
  }
  const ticketMatch = /^\/assets\/([0-9a-f]{64})\/ticket$/.exec(requestUrl.pathname);
  if (ticketMatch && request.method === 'POST') {
    const servicePrincipal = await authorizeHttpRequest(request.headers.authorization);
    if (!servicePrincipal) { jsonResponse(response, 401, { error: 'Service authentication is invalid.' }); return; }
    try {
      const roomId = singleHeader(request.headers['x-visual-notes-room']);
      const clientId = singleHeader(request.headers['x-visual-notes-client']);
      const accessToken = singleHeader(request.headers['x-visual-notes-access']);
      if (!roomId || !clientId || !accessToken) throw new Error('Room asset credentials are required.');
      const room = await getPrivateRoom(roomId);
      const role = await authenticateHostedRoom(room, clientId, accessToken, servicePrincipal);
      if (!role) { jsonResponse(response, 403, { error: 'Room access is invalid or has been revoked.' }); return; }
      const assetHash = ticketMatch[1];
      const asset = room.asset(assetHash);
      if (!asset || !asset.mimeType.startsWith('video/')) { jsonResponse(response, 404, { error: 'Video is not available in this room.' }); return; }
      const ticket = randomBytes(32).toString('base64url');
      playbackTickets.set(ticket, {
        roomId, assetHash, clientId, accessToken, servicePrincipal, expiresAt: Date.now() + playbackTicketLifetimeMs,
      });
      jsonResponse(response, 200, { ticket, expiresAt: Date.now() + playbackTicketLifetimeMs });
    } catch (error) {
      jsonResponse(response, isMissingFile(error) ? 404 : 400, { error: error instanceof Error ? error.message : 'Playback authorization failed.' });
    }
    return;
  }
  const assetMatch = /^\/assets\/([0-9a-f]{64})$/.exec(requestUrl.pathname);
  if (assetMatch && (request.method === 'PUT' || request.method === 'GET' || request.method === 'HEAD')) {
    const assetHash = assetMatch[1];
    const ticketValue = requestUrl.searchParams.get('ticket');
    if (ticketValue && (request.method === 'GET' || request.method === 'HEAD')) {
      const ticket = playbackTickets.get(ticketValue);
      if (!ticket || ticket.expiresAt < Date.now() || ticket.assetHash !== assetHash) {
        playbackTickets.delete(ticketValue); jsonResponse(response, 403, { error: 'Video playback authorization has expired.' }); return;
      }
      const room = await getPrivateRoom(ticket.roomId);
      if (!await authenticateHostedRoom(room, ticket.clientId, ticket.accessToken, ticket.servicePrincipal)) {
        playbackTickets.delete(ticketValue); jsonResponse(response, 403, { error: 'Room access has been revoked.' }); return;
      }
      const asset = room.asset(assetHash);
      if (!asset) { jsonResponse(response, 404, { error: 'Asset is not available in this room.' }); return; }
      await serveAsset(request, response, assetHash, asset, request.method === 'HEAD');
      return;
    }
    const servicePrincipal = await authorizeHttpRequest(request.headers.authorization);
    if (!servicePrincipal) { jsonResponse(response, 401, { error: 'Service authentication is invalid.' }); return; }
    try {
      const roomId = singleHeader(request.headers['x-visual-notes-room']);
      const clientId = singleHeader(request.headers['x-visual-notes-client']);
      const accessToken = singleHeader(request.headers['x-visual-notes-access']);
      if (!roomId || !clientId || !accessToken) throw new Error('Room asset credentials are required.');
      const room = await getPrivateRoom(roomId);
      const role = await authenticateHostedRoom(room, clientId, accessToken, servicePrincipal);
      if (!role) { jsonResponse(response, 403, { error: 'Room access is invalid or has been revoked.' }); return; }
      if (request.method === 'PUT') {
        if (role === 'viewer') { jsonResponse(response, 403, { error: 'Viewers cannot upload room assets.' }); return; }
        const mimeType = (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (!allowedAssetTypes.has(mimeType)) throw new Error('This media type is not supported for collaboration.');
        const bytes = await readBinaryBody(request, mimeType.startsWith('video/') ? maxVideoAssetSize : maxAssetSize);
        if (hashBytes(bytes) !== assetHash) throw new Error('Asset hash does not match its content.');
        room.assertAssetCapacity(assetHash, bytes.byteLength);
        await assetBlobs.putIfAbsent(assetHash, bytes);
        const rawName = singleHeader(request.headers['x-visual-notes-asset-name']);
        await room.registerAsset(assetHash, {
          mimeType, size: bytes.byteLength,
          name: rawName ? decodeURIComponent(rawName).slice(0, 255) : undefined,
          createdAt: Date.now(),
        });
        jsonResponse(response, 200, { hash: assetHash, stored: true });
      } else {
        const asset = room.asset(assetHash);
        if (!asset) { jsonResponse(response, 404, { error: 'Asset is not available in this room.' }); return; }
        await serveAsset(request, response, assetHash, asset, request.method === 'HEAD');
      }
    } catch (error) {
      jsonResponse(response, isMissingFile(error) ? 404 : 400, { error: error instanceof Error ? error.message : 'Asset request failed.' });
    }
    return;
  }
  if (request.method === 'POST' && [
    '/rooms', '/rooms/resolve', '/rooms/manage', '/rooms/invites/rotate', '/rooms/members/remove',
    '/rooms/assets/cleanup', '/rooms/export', '/rooms/delete', '/rooms/children', '/rooms/children/open',
    '/account/rooms', '/account/rooms/open',
  ].includes(request.url ?? '')) {
    const servicePrincipal = await authorizeHttpRequest(request.headers.authorization);
    if (!servicePrincipal) {
      jsonResponse(response, 401, { error: 'Service authentication is invalid.' });
      return;
    }
    try {
      const body = await readJsonBody(request);
      if (request.url === '/account/rooms') {
        jsonResponse(response, 200, { rooms: await accountRoomSummaries(servicePrincipal) });
      } else if (request.url === '/account/rooms/open') {
        if (typeof body.roomId !== 'string') throw new Error('Room ID is required.');
        const identity = validateIdentity(body.identity);
        const room = await getPrivateRoom(body.roomId);
        if (room.parentRoomId) throw new Error('Open the account room from its root board.');
        const opened = await room.openForAccount(identity, servicePrincipal);
        jsonResponse(response, 200, {
          roomId: room.roomId, accessToken: opened.accessToken, role: opened.role, board: opened.board,
        });
      } else if (request.url === '/rooms') {
        const initialBoard = validateInitialBoard(body.initialBoard);
        const identity = validateIdentity(body.identity);
        const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 120) : undefined;
        const created = await HostedRoom.createPrivate(identity, initialBoard, servicePrincipal, label);
        rooms.set(created.room.roomId, Promise.resolve(created.room));
        jsonResponse(response, 201, {
          roomId: created.room.roomId, accessToken: created.accessToken, role: 'owner',
          inviteCode: created.editorInviteCode, viewerInviteCode: created.viewerInviteCode,
        });
      } else if (request.url === '/rooms/resolve') {
        if (typeof body.inviteCode !== 'string') throw new Error('Invite code is required.');
        const inviteCode = normalizeInviteCode(body.inviteCode);
        const identity = validateIdentity(body.identity);
        const roomId = privateRoomId(inviteCode);
        const room = await getPrivateRoom(roomId);
        const membership = await room.redeemInvite(inviteCode, identity, servicePrincipal);
        jsonResponse(response, 200, {
          roomId, accessToken: membership.accessToken, role: membership.role,
        });
      } else if (request.url === '/rooms/children') {
        if (typeof body.parentRoomId !== 'string' || typeof body.childKey !== 'string'
          || typeof body.clientId !== 'string' || typeof body.accessToken !== 'string') {
          throw new Error('Parent room credentials are required.');
        }
        if (!body.childKey || body.childKey.length > 256) throw new Error('Nested board key is invalid.');
        const initialBoard = validateInitialBoard(body.initialBoard);
        const identity = validateIdentity(body.identity);
        if (identity.clientId !== body.clientId) throw new Error('Collaboration identity does not match the room access request.');
        const parent = await getPrivateRoom(body.parentRoomId);
        const role = await authenticateHostedRoom(parent, body.clientId, body.accessToken, servicePrincipal);
        if (!role || role === 'viewer') throw new Error('Only an owner or editor can create a nested board.');
        const child = await getOrCreateChildRoom(
          body.parentRoomId, body.childKey, identity, role, body.accessToken, initialBoard, servicePrincipal,
        );
        await child.grantInherited(identity, role, body.accessToken, servicePrincipal);
        jsonResponse(response, 201, { roomId: child.roomId, accessToken: body.accessToken, role });
      } else if (request.url === '/rooms/children/open') {
        if (typeof body.parentRoomId !== 'string' || typeof body.childRoomId !== 'string'
          || typeof body.clientId !== 'string' || typeof body.accessToken !== 'string') {
          throw new Error('Parent and child room credentials are required.');
        }
        const identity = validateIdentity(body.identity);
        if (identity.clientId !== body.clientId) throw new Error('Collaboration identity does not match the room access request.');
        const current = await getPrivateRoom(body.parentRoomId);
        const role = await authenticateHostedRoom(current, body.clientId, body.accessToken, servicePrincipal);
        if (!role) throw new Error('Current room access is invalid or has been revoked.');
        const child = await getPrivateRoom(body.childRoomId);
        if (!await roomsShareTree(current, child)) throw new Error('Target board does not belong to this collaboration tree.');
        await child.grantInherited(identity, role, body.accessToken, servicePrincipal);
        jsonResponse(response, 200, {
          roomId: child.roomId, accessToken: body.accessToken, role, board: child.boardSnapshot(),
        });
      } else {
        if (typeof body.roomId !== 'string' || typeof body.clientId !== 'string' || typeof body.accessToken !== 'string') {
          throw new Error('Room owner credentials are required.');
        }
        const room = await getPrivateRoom(body.roomId);
        const managementRole = await authenticateHostedRoom(room, body.clientId, body.accessToken, servicePrincipal);
        if (managementRole !== 'owner') throw new Error('Only the room owner can manage this room.');
        if (request.url === '/rooms/manage') {
          jsonResponse(response, 200, {
            ...room.managementSnapshot(body.clientId, body.accessToken),
            tree: await collaborationTree(room),
          });
        } else if (request.url === '/rooms/invites/rotate') {
          if (body.role !== 'editor' && body.role !== 'viewer') throw new Error('Invite role is invalid.');
          const inviteCode = await room.rotateInvite(body.clientId, body.accessToken, body.role);
          jsonResponse(response, 200, { inviteCode, role: body.role });
        } else if (request.url === '/rooms/members/remove') {
          if (typeof body.memberClientId !== 'string') throw new Error('Member client ID is required.');
          await room.removeMembership(body.clientId, body.accessToken, body.memberClientId);
          jsonResponse(response, 200, { removed: true });
        } else if (request.url === '/rooms/assets/cleanup') {
          const removed = await room.cleanupAssets(body.clientId, body.accessToken);
          const deletedFiles = await purgeUnregisteredAssets(removed);
          jsonResponse(response, 200, { removedFromRoom: removed.length, deletedFiles });
        } else if (request.url === '/rooms/export') {
          jsonResponse(response, 200, { export: await exportCollaborationTree(room, body.clientId, body.accessToken) });
        } else {
          room.authorizeDeletion(body.clientId, body.accessToken);
          const deleted = await deleteCollaborationSubtree(body.roomId);
          jsonResponse(response, 200, { deleted: true, ...deleted });
        }
      }
    } catch (error) {
      jsonResponse(response, isMissingFile(error) ? 404 : 400, {
        error: isMissingFile(error) ? 'No room matches that invite code.' : error instanceof Error ? error.message : 'Invalid room request.',
      });
    }
    return;
  }
  response.writeHead(404).end();
})().catch(error => jsonResponse(response, 500, { error: error instanceof Error ? error.message : 'Room service failed.' })); });
const webSockets = new WebSocketServer({ server: httpServer, maxPayload });

webSockets.on('connection', socket => {
  let room: HostedRoom | undefined;
  socket.on('message', (data: RawData, binary: boolean) => { void (async () => {
    try {
      if (binary) throw new Error('Binary messages are not supported.');
      const message = decodeClientMessage(data.toString());
      if (message.type === 'join') {
        if (room) throw new Error('Connection has already joined a room.');
        const servicePrincipal = await serviceAuthenticator.authorize(message.token);
        if (!servicePrincipal) {
          send(socket, { type: 'error', code: 'unauthorized', message: 'Server access secret is invalid.' });
          socket.close(4001, 'Unauthorized');
          return;
        }
        room = message.roomId.startsWith('private:')
          ? await getPrivateRoom(message.roomId)
          : await getRoom(message.roomId, message.boardId, message.initialBoard);
        const role = message.roomId.startsWith('private:')
          ? await authenticateHostedRoom(room, message.identity.clientId, message.accessToken, servicePrincipal)
          : 'editor';
        if (!role) {
          send(socket, { type: 'error', code: 'forbidden', message: 'Room access is invalid or has been revoked.' });
          socket.close(4001, 'Forbidden');
          return;
        }
        const compatibilityError = room.compatibilityError(message.compatibility);
        if (compatibilityError) {
          send(socket, { type: 'error', code: 'incompatible-client', message: compatibilityError });
          socket.close(4003, 'Incompatible client');
          return;
        }
        const snapshot = room.join(socket, message.identity, message.compatibility, role, message.accessToken, servicePrincipal);
        send(socket, { type: 'joined', protocolVersion: 1, snapshot });
        return;
      }
      if (!room) throw new Error('Join a room before sending other messages.');
      const activeMember = room.member(socket);
      if (!activeMember) throw new Error('Room membership is missing.');
      if (room.parentRoomId && !await authenticateHostedRoom(
        room, activeMember.identity.clientId, activeMember.accessToken, activeMember.servicePrincipal,
      )) {
        socket.close(4004, 'Parent room access was revoked'); return;
      }
      if (message.type === 'operation') {
        await room.publish(activeMember, message.operation);
      } else if (message.type === 'presence') {
        room.updatePresence(socket, message);
      } else {
        send(socket, { type: 'heartbeat-ack', sentAt: message.sentAt, serverTime: Date.now() });
      }
    } catch (error) {
      send(socket, { type: 'error', code: 'invalid-message', message: error instanceof Error ? error.message : 'Invalid message.' });
    }
  })(); });
  socket.on('close', () => room?.leave(socket));
});

httpServer.listen(port, host);

// The desktop plugin's embedded host loads this bundle into Obsidian's
// Node-enabled process. Exported shutdown is what makes Stop hosting and
// plugin unload release the socket without terminating Obsidian itself.
export async function stopCollaborationServer(): Promise<void> {
  for (const socket of webSockets.clients) socket.terminate();
  await new Promise<void>(resolve => webSockets.close(() => resolve()));
  await new Promise<void>(resolve => httpServer.close(() => resolve()));
}

export interface HostedRoomSummary {
  roomId: string;
  boardId: string;
  /** What to show a person: the board's name, or a summary of its contents. */
  title: string;
  memberNames: string[];
  memberCount: number;
  cardCount: number;
  parentRoomId?: string;
}

/**
 * Rooms this host holds on disk. Deliberately NOT an HTTP route: reaching it
 * means running inside the host's own process, which is the only proof of
 * ownership that means anything here. The server secret cannot be the gate --
 * a complete invitation contains it, so every editor and viewer holds one.
 */
export async function listHostedCollaborationRooms(): Promise<HostedRoomSummary[]> {
  const documents = await roomDocuments.list();
  return documents
    .filter(state => !state.parentRoomId)
    .map(state => ({
      roomId: state.roomId,
      boardId: state.boardId,
      title: state.label?.trim() || describeBoard(state.board),
      memberNames: Object.values(state.memberships ?? {}).map(member => member.displayName).filter(Boolean),
      memberCount: Object.keys(state.memberships ?? {}).length,
      cardCount: state.board.cards.length,
      ...(state.parentRoomId ? { parentRoomId: state.parentRoomId } : {}),
    }));
}

/**
 * A name for a room created before rooms carried one. The room ID is random,
 * and a private room's boardId is just the room ID again, so the only thing
 * left that a person can recognise is what is actually on the board.
 */
function describeBoard(board: VisualNotesFile): string {
  const words: string[] = [];
  for (const card of board.cards) {
    const value = card as Partial<Record<'title' | 'label' | 'text' | 'caption' | 'name', unknown>>;
    for (const key of ['title', 'label', 'text', 'caption', 'name'] as const) {
      const candidate = value[key];
      if (typeof candidate !== 'string') continue;
      const cleaned = candidate.replace(/\s+/g, ' ').trim();
      if (cleaned) { words.push(cleaned.slice(0, 40)); break; }
    }
    if (words.length === 3) break;
  }
  if (words.length === 0) return `Untitled board (${board.cards.length} cards)`;
  return words.join(' · ');
}

/**
 * Re-issues owner access for a room this host stores.
 *
 * Leaving a room deletes the only copy of its access token, and redeemInvite
 * refuses to hand an owner a new one -- so before this existed, an owner who
 * left was locked out of their own room permanently while its data sat intact
 * on their disk. Existing members keep their access; only the caller's own
 * membership is rewritten.
 */
export async function claimHostedRoomOwnership(
  roomId: string, identity: CollaborationIdentity,
): Promise<{ accessToken: string; role: CollaborationRole }> {
  const room = await getPrivateRoom(roomId);
  return room.grantOwnership(identity);
}

function send(socket: WebSocket, message: CollaborationServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(encodeCollaborationMessage(message));
}

function rejection(operationId: string, error: string): CollaborationServerMessage {
  return { type: 'operation-rejected', operationId, error };
}

function boardAssetHashes(board: VisualNotesFile): Set<string> {
  const hashes = new Set<string>();
  for (const card of [...board.cards, ...(board.archived ?? [])]) {
    if (card.kind === 'image') {
      if (card.source.type === 'vault' && card.source.sharedAsset) hashes.add(card.source.sharedAsset.hash);
      if (card.originalSource?.type === 'vault' && card.originalSource.sharedAsset) hashes.add(card.originalSource.sharedAsset.hash);
    } else if (card.kind === 'video' && card.source.sharedAsset) {
      hashes.add(card.source.sharedAsset.hash);
    } else if (card.kind === 'storyboard') {
      for (const section of card.sections) for (const shot of section.shots) {
        if (shot.background?.type === 'vault' && shot.background.sharedAsset) hashes.add(shot.background.sharedAsset.hash);
      }
    }
  }
  return hashes;
}

async function purgeUnregisteredAssets(hashes: string[]): Promise<number> {
  let deleted = 0;
  for (const assetHash of new Set(hashes)) {
    if (await assetRegisteredInAnyRoom(assetHash)) continue;
    try { await assetBlobs.delete(assetHash); deleted++; }
    catch (error) { if (!isMissingFile(error)) throw error; }
  }
  return deleted;
}

async function assetRegisteredInAnyRoom(assetHash: string): Promise<boolean> {
  // Cleanup fails closed when any room document cannot be listed, while a
  // valid registration in any room always retains the shared bytes.
  try {
    return (await persistedRooms()).some(room => Object.prototype.hasOwnProperty.call(room.assets ?? {}, assetHash));
  } catch { return true; }
}

async function serveAsset(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
  assetHash: string,
  asset: PersistedAsset,
  headOnly: boolean,
): Promise<void> {
  const fileSize = await assetBlobs.size(assetHash);
  const common = {
    'content-type': asset.mimeType,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
  };
  const range = parseByteRange(singleHeader(request.headers.range), fileSize);
  if (range === 'invalid') {
    response.writeHead(416, { ...common, 'content-range': `bytes */${fileSize}` }); response.end(); return;
  }
  if (range) {
    response.writeHead(206, {
      ...common, 'content-range': `bytes ${range.start}-${range.end}/${fileSize}`,
      'content-length': range.end - range.start + 1,
    });
    if (headOnly) { response.end(); return; }
    response.end(Buffer.from(await assetBlobs.read(assetHash, { start: range.start, end: range.end })));
    return;
  }
  response.writeHead(200, { ...common, 'content-length': fileSize });
  if (headOnly) { response.end(); return; }
  response.end(Buffer.from(await assetBlobs.read(assetHash)));
}

function parseByteRange(value: string | undefined, size: number): { start: number; end: number } | 'invalid' | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return 'invalid';
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return 'invalid';
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashBytes(value: Buffer): string { return createHash('sha256').update(value).digest('hex'); }

function privateRoomId(inviteCode: string): string {
  const match = /^VN2-([A-Z2-9]{10})-[A-Z2-9]{12}$/.exec(normalizeInviteCode(inviteCode));
  if (!match) throw new Error('Invite code has an invalid format.');
  return `private:${match[1]}`;
}

function childRoomId(parentRoomId: string, childKey: string): string {
  return `private:${hash(`${parentRoomId}\0${childKey}`).slice(0, 10).toUpperCase()}`;
}

function normalizeInviteCode(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

function createInviteCode(locator: string): string {
  return `VN2-${locator}-${randomCode(12)}`;
}

function randomCode(length: number): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  const characters = [...bytes].map(value => alphabet[value % alphabet.length]).join('');
  return characters;
}

function createAccessToken(): string {
  return randomBytes(32).toString('base64url');
}

function cryptoId(): string {
  return randomBytes(16).toString('hex');
}

async function readJsonBody(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += buffer.length;
    if (length > maxPayload) throw new Error('Room request is too large.');
    chunks.push(buffer);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Room request must be an object.');
  return value as Record<string, unknown>;
}

async function readBinaryBody(request: import('node:http').IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += buffer.length;
    if (length > limit) throw new Error(`Room assets cannot exceed ${Math.floor(limit / 1024 / 1024)} MB.`);
    chunks.push(buffer);
  }
  if (length === 0) throw new Error('Asset is empty.');
  return Buffer.concat(chunks);
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function authorizeHttpRequest(value: string | undefined): Promise<ServicePrincipal | undefined> {
  const match = /^Bearer\s+(.+)$/i.exec(value ?? '');
  return serviceAuthenticator.authorize(match?.[1]);
}

function validateInitialBoard(value: unknown): VisualNotesFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Initial board is invalid.');
  const board = value as Partial<VisualNotesFile>;
  if ((board.version !== 2 && board.version !== 3) || board.layout !== 'freeform'
    || !Array.isArray(board.cards) || !Array.isArray(board.connections) || !Array.isArray(board.drawings)) {
    throw new Error('Initial board is invalid.');
  }
  return structuredClone(board as VisualNotesFile);
}

function validateIdentity(value: unknown): CollaborationIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Collaboration identity is invalid.');
  const identity = value as Partial<CollaborationIdentity>;
  if (typeof identity.clientId !== 'string' || typeof identity.displayName !== 'string'
    || typeof identity.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(identity.color)) {
    throw new Error('Collaboration identity is invalid.');
  }
  return { clientId: identity.clientId, displayName: identity.displayName, color: identity.color };
}

function jsonResponse(response: import('node:http').ServerResponse, status: number, body: Record<string, unknown>): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function validatePersistedRoom(value: unknown): PersistedRoom {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Persisted room is invalid.');
  const room = value as Partial<PersistedRoom>;
  if ((room.formatVersion !== 1 && room.formatVersion !== 2 && room.formatVersion !== 3) || typeof room.roomId !== 'string' || typeof room.boardId !== 'string'
    || !room.board || typeof room.sequence !== 'number' || typeof room.maxLogicalClock !== 'number'
    || !Array.isArray(room.operations)) throw new Error('Persisted room is invalid.');
  return room as PersistedRoom;
}

function strongestRole(roles: CollaborationRole[]): CollaborationRole | undefined {
  if (roles.includes('owner')) return 'owner';
  if (roles.includes('editor')) return 'editor';
  return roles.includes('viewer') ? 'viewer' : undefined;
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}
