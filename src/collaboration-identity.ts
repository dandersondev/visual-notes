import type { VisualNotesSettings } from './types';

export interface CollaborationIdentity {
  clientId: string;
  displayName: string;
  color: string;
}

export const COLLABORATOR_COLORS = [
  '#e57373', '#f06292', '#ba68c8', '#7986cb',
  '#4fc3f7', '#4db6ac', '#81c784', '#ffb74d',
] as const;
export const COLLABORATION_CLIENT_STORAGE_KEY = 'visual-notes:collaboration-client-id';

export interface CollaborationIdentityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Ensures this installation has a durable, local-only device identity. */
export function ensureCollaborationIdentity(
  settings: VisualNotesSettings,
  generateId: () => string = () => crypto.randomUUID(),
  localStorage?: CollaborationIdentityStorage,
  vaultScope?: string,
): { identity: CollaborationIdentity; changed: boolean } {
  let changed = false;
  const localClientId = readLocalClientId(localStorage, vaultScope);
  if (localStorage && localClientId === undefined) {
    // Deliberately ignore a settings ID here: data.json may have arrived from
    // another device through vault sync. Installation-local storage is what
    // makes two synced devices distinguishable.
    settings.collaborationClientId = generateId();
    writeLocalClientId(localStorage, settings.collaborationClientId, vaultScope);
    changed = true;
  } else if (localClientId !== undefined && settings.collaborationClientId !== localClientId) {
    settings.collaborationClientId = localClientId;
    changed = true;
  } else if (!isClientId(settings.collaborationClientId)) {
    settings.collaborationClientId = generateId();
    writeLocalClientId(localStorage, settings.collaborationClientId, vaultScope);
    changed = true;
  }
  if (!isHexColor(settings.collaborationColor)) {
    settings.collaborationColor = colorForClient(settings.collaborationClientId);
    changed = true;
  }
  return {
    identity: {
      clientId: settings.collaborationClientId,
      displayName: settings.collaborationDisplayName?.trim() || 'Anonymous',
      color: settings.collaborationColor,
    },
    changed,
  };
}

export function regenerateCollaborationClientId(
  settings: VisualNotesSettings,
  generateId: () => string = () => crypto.randomUUID(),
  localStorage?: CollaborationIdentityStorage,
  vaultScope?: string,
): CollaborationIdentity {
  settings.collaborationClientId = generateId();
  writeLocalClientId(localStorage, settings.collaborationClientId, vaultScope);
  settings.collaborationColor = colorForClient(settings.collaborationClientId);
  return ensureCollaborationIdentity(settings, generateId).identity;
}

function readLocalClientId(storage: CollaborationIdentityStorage | undefined, vaultScope?: string): string | undefined {
  if (!storage) return undefined;
  try {
    const value = storage.getItem(clientStorageKey(vaultScope));
    return isClientId(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeLocalClientId(storage: CollaborationIdentityStorage | undefined, clientId: string, vaultScope?: string): void {
  if (!storage) return;
  try { storage.setItem(clientStorageKey(vaultScope), clientId); } catch { /* best effort */ }
}

function clientStorageKey(vaultScope?: string): string {
  return vaultScope
    ? `${COLLABORATION_CLIENT_STORAGE_KEY}:${encodeURIComponent(vaultScope)}`
    : COLLABORATION_CLIENT_STORAGE_KEY;
}

export function isClientId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value);
}

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

function colorForClient(clientId: string): string {
  let hash = 0;
  for (const char of clientId) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
  return COLLABORATOR_COLORS[hash % COLLABORATOR_COLORS.length];
}
