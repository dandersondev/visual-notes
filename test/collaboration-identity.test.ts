import { describe, expect, it } from 'vitest';
import {
  COLLABORATION_CLIENT_STORAGE_KEY,
  ensureCollaborationIdentity,
  isHexColor,
  regenerateCollaborationClientId,
} from '../src/collaboration-identity';
import { DEFAULT_SETTINGS, type VisualNotesSettings } from '../src/types';

const settings = (over: Partial<VisualNotesSettings> = {}): VisualNotesSettings => ({ ...DEFAULT_SETTINGS, ...over });

describe('local collaboration identity', () => {
  it('creates a durable ID and deterministic colour without inventing a user name', () => {
    const value = settings();
    const first = ensureCollaborationIdentity(value, () => '12345678-1234-4123-8123-123456789abc');
    const second = ensureCollaborationIdentity(value, () => '87654321-4321-4321-8321-cba987654321');
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.identity).toEqual(first.identity);
    expect(first.identity.displayName).toBe('Anonymous');
    expect(isHexColor(first.identity.color)).toBe(true);
  });

  it('uses the configured display name and colour', () => {
    const result = ensureCollaborationIdentity(settings({
      collaborationClientId: '12345678-1234-4123-8123-123456789abc',
      collaborationDisplayName: '  Daniel  ',
      collaborationColor: '#abcdef',
    }));
    expect(result.identity).toMatchObject({ displayName: 'Daniel', color: '#abcdef' });
    expect(result.changed).toBe(false);
  });

  it('regenerates both the device ID and its derived colour', () => {
    const value = settings({
      collaborationClientId: '12345678-1234-4123-8123-123456789abc',
      collaborationColor: '#abcdef',
    });
    const identity = regenerateCollaborationClientId(value, () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(identity.clientId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(identity.color).not.toBe('#abcdef');
  });

  it('does not adopt a client ID synced from another device', () => {
    const synced = settings({ collaborationClientId: '12345678-1234-4123-8123-123456789abc' });
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const result = ensureCollaborationIdentity(
      synced,
      () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      storage,
    );
    expect(result.identity.clientId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(values.get(COLLABORATION_CLIENT_STORAGE_KEY)).toBe(result.identity.clientId);
  });

  it('restores the installation-local ID after settings sync changes it', () => {
    const values = new Map([[COLLABORATION_CLIENT_STORAGE_KEY, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']]);
    const value = settings({ collaborationClientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    const result = ensureCollaborationIdentity(value, () => 'unused', {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, stored) => { values.set(key, stored); },
    });
    expect(result.identity.clientId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it('gives separate vaults on one installation distinct test identities', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, stored: string) => { values.set(key, stored); },
    };
    const ids = [
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ];
    const first = ensureCollaborationIdentity(settings(), () => ids.shift()!, storage, 'Vault One');
    const second = ensureCollaborationIdentity(settings(), () => ids.shift()!, storage, 'Vault Two');

    expect(first.identity.clientId).not.toBe(second.identity.clientId);
    expect(values.size).toBe(2);
  });
});
