import { describe, expect, it } from 'vitest';
import {
  collaborationSecretStore,
  decodePrivateNetworkInvite,
  encodePrivateNetworkInvite,
  generatePrivateNetworkServerToken,
  isPrivateNetworkCollaborationUrl,
} from '../src/collaboration-private-network';

describe('private-network collaboration', () => {
  it('round-trips a portable invitation without exposing VPN credentials', () => {
    const token = generatePrivateNetworkServerToken();
    const encoded = encodePrivateNetworkInvite('ws://100.90.80.70:8787', token, 'VN2-ROOM-SECRET');
    expect(encoded).toMatch(/^visual-notes-collab:v1:/);
    expect(encoded).not.toContain('100.90.80.70');
    expect(decodePrivateNetworkInvite(encoded)).toEqual({
      version: 1,
      serverUrl: 'ws://100.90.80.70:8787',
      serverToken: token,
      inviteCode: 'VN2-ROOM-SECRET',
    });
  });

  it('leaves legacy hosted room codes for the existing resolver', () => {
    expect(decodePrivateNetworkInvite('VN2-ROOM-SECRET')).toBeUndefined();
  });

  it.each([
    'ws://127.0.0.1:8787',
    'ws://192.168.1.8:8787',
    'ws://172.20.1.8:8787',
    'ws://10.1.2.3:8787',
    'ws://100.100.1.2:8787',
    'ws://host.local:8787',
    'ws://host.example-tailnet.ts.net:8787',
    'wss://private.example.com',
  ])('accepts private or encrypted endpoint %s', endpoint => {
    expect(isPrivateNetworkCollaborationUrl(endpoint)).toBe(true);
  });

  it.each([
    'ws://8.8.8.8:8787',
    'ws://public.example.com:8787',
    'http://192.168.1.8:8787',
    'ws://user:password@192.168.1.8:8787',
    'ws://192.168.1.8:8787/not-root',
  ])('rejects unsafe endpoint %s', endpoint => {
    expect(isPrivateNetworkCollaborationUrl(endpoint)).toBe(false);
  });

  it('rejects short server secrets and malformed envelopes', () => {
    expect(() => encodePrivateNetworkInvite('ws://10.0.0.2:8787', 'short', 'VN2-ROOM')).toThrow(/24 characters/);
    expect(() => decodePrivateNetworkInvite('visual-notes-collab:v1:not-json')).toThrow(/invalid/i);
  });
});

// SecretStorage arrived in Obsidian 1.11.4 and is the only place the server
// secret may live. Detecting it at runtime is what lets minAppVersion stay at
// 1.7.2: older installs lose collaboration alone, not every future release.
describe('SecretStorage capability detection', () => {
  const store = { getSecret: () => null, setSecret: () => undefined };

  it('finds a usable store on an Obsidian that has one', () => {
    expect(collaborationSecretStore({ secretStorage: store })).toBe(store);
  });

  it.each([
    ['an Obsidian predating the API', {}],
    ['an undefined property', { secretStorage: undefined }],
    ['a null property', { secretStorage: null }],
    ['a non-object property', { secretStorage: 'nope' }],
    ['a partial API missing setSecret', { secretStorage: { getSecret: () => null } }],
    ['a partial API missing getSecret', { secretStorage: { setSecret: () => undefined } }],
    ['no app at all', undefined],
  ])('reports collaboration unavailable for %s', (_label, app) => {
    expect(collaborationSecretStore(app)).toBeUndefined();
  });
});
