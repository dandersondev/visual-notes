import { describe, expect, it } from 'vitest';
import {
  canUsePrivateNetworkCollaboration,
  collaborationSecretStore,
  decodePrivateNetworkInvite,
  encodePrivateNetworkInvite,
  generatePrivateNetworkServerToken,
  isPrivateNetworkCollaborationUrl,
  isUsablePrivateNetworkSecret,
  PRIVATE_NETWORK_SECRET_MIN_LENGTH,
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

// Regression: switching collaboration on stopped every board from opening on
// iPad. Enabling it forces the private-network transport, and the default
// endpoint (ws://127.0.0.1:8787) is a perfectly valid private-network URL --
// so the readiness gate said yes on URL alone, the board eagerly built its
// collaboration options, and reading the server token threw because no secret
// existed. Mobile cannot host, so it has no secret until it accepts an
// invitation: every board on the device was dead until the toggle went off.
describe('private-network readiness', () => {
  const secret = 'a'.repeat(32);
  const url = 'ws://100.90.80.70:8787';

  it('is not ready without a secret, however valid the endpoint', () => {
    expect(canUsePrivateNetworkCollaboration(undefined, 'ws://127.0.0.1:8787')).toBe(false);
    expect(canUsePrivateNetworkCollaboration(undefined, url)).toBe(false);
  });

  it('is not ready with a secret too short for the server to accept', () => {
    // The gate and the token reader used different rules -- non-empty here,
    // 24 characters there -- so a short secret passed the gate and then threw.
    expect(canUsePrivateNetworkCollaboration('short', url)).toBe(false);
    expect(canUsePrivateNetworkCollaboration('   ', url)).toBe(false);
    expect(isUsablePrivateNetworkSecret('short')).toBe(false);
  });

  it('is ready only when a usable secret and a private endpoint agree', () => {
    expect(canUsePrivateNetworkCollaboration(secret, url)).toBe(true);
    expect(canUsePrivateNetworkCollaboration(secret, 'ws://8.8.8.8:8787')).toBe(false);
  });

  it('accepts exactly the secret length the server enforces', () => {
    expect(isUsablePrivateNetworkSecret('b'.repeat(PRIVATE_NETWORK_SECRET_MIN_LENGTH))).toBe(true);
    expect(isUsablePrivateNetworkSecret('b'.repeat(PRIVATE_NETWORK_SECRET_MIN_LENGTH - 1))).toBe(false);
    // The invite encoder rejects at the same boundary; if these ever diverge,
    // a device can be "ready" and still fail to produce a usable invitation.
    expect(() => encodePrivateNetworkInvite(url, 'b'.repeat(PRIVATE_NETWORK_SECRET_MIN_LENGTH), 'VN2-ROOM'))
      .not.toThrow();
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
