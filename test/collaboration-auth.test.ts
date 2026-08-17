import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestUrl = vi.hoisted(() => vi.fn());
vi.mock('obsidian', () => ({ requestUrl }));

import { CollaborationAuthClient } from '../src/collaboration-auth';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const discovery = {
  status: 200,
  json: {
    issuer: 'https://identity.example',
    authorization_endpoint: 'https://identity.example/authorize',
    token_endpoint: 'https://identity.example/token',
  },
};

describe('CollaborationAuthClient', () => {
  let storage: MemoryStorage;
  let now: number;
  let auth: CollaborationAuthClient;

  beforeEach(() => {
    requestUrl.mockReset();
    storage = new MemoryStorage();
    now = 1_800_000_000_000;
    auth = new CollaborationAuthClient({ storage, namespace: 'Test vault', now: () => now });
  });

  it('creates an external-browser authorization URL with PKCE and OIDC state', async () => {
    requestUrl.mockResolvedValueOnce(discovery);
    const value = await auth.begin({
      issuer: 'https://identity.example/', clientId: 'visual-notes', audience: 'https://rooms.example.com',
    });
    const url = new URL(value);
    expect(url.origin + url.pathname).toBe('https://identity.example/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('obsidian://visual-notes-auth');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('audience')).toBe('https://rooms.example.com');
  });

  it('exchanges a code once and saves a renewable session', async () => {
    requestUrl.mockResolvedValueOnce(discovery);
    const url = new URL(await auth.begin({ issuer: 'https://identity.example', clientId: 'visual-notes' }));
    requestUrl.mockResolvedValueOnce({ status: 200, json: {
      access_token: 'access-one', refresh_token: 'refresh-one', token_type: 'Bearer', expires_in: 3600,
    } });
    const session = await auth.complete({ code: 'one-use-code', state: url.searchParams.get('state')! });
    expect(session.accessToken).toBe('access-one');
    const exchange = requestUrl.mock.calls[1][0];
    expect(exchange.body).toContain('grant_type=authorization_code');
    expect(exchange.body).toContain('code_verifier=');
    await expect(auth.complete({ code: 'one-use-code', state: url.searchParams.get('state')! }))
      .rejects.toThrow('No sign-in attempt');
  });

  it('consumes and rejects a mismatched or expired state', async () => {
    requestUrl.mockResolvedValueOnce(discovery);
    await auth.begin({ issuer: 'https://identity.example', clientId: 'visual-notes' });
    await expect(auth.complete({ code: 'code', state: 'wrong' })).rejects.toThrow('state did not match');
    expect(requestUrl).toHaveBeenCalledTimes(1);

    requestUrl.mockResolvedValueOnce(discovery);
    const second = new URL(await auth.begin({ issuer: 'https://identity.example', clientId: 'visual-notes' }));
    now += 10 * 60 * 1000 + 1;
    await expect(auth.complete({ code: 'code', state: second.searchParams.get('state')! })).rejects.toThrow('expired');
  });

  it('refreshes early and keeps or rotates refresh tokens', async () => {
    requestUrl.mockResolvedValueOnce(discovery);
    const url = new URL(await auth.begin({ issuer: 'https://identity.example', clientId: 'visual-notes' }));
    requestUrl.mockResolvedValueOnce({ status: 200, json: {
      access_token: 'access-one', refresh_token: 'refresh-one', token_type: 'Bearer', expires_in: 61,
    } });
    await auth.complete({ code: 'code', state: url.searchParams.get('state')! });
    expect(await auth.accessToken()).toBe('access-one');
    now += 2_000;
    requestUrl.mockResolvedValueOnce({ status: 200, json: {
      access_token: 'access-two', token_type: 'Bearer', expires_in: 3600,
    } });
    expect(await auth.accessToken()).toBe('access-two');
    now += 3_600_000;
    requestUrl.mockResolvedValueOnce({ status: 200, json: {
      access_token: 'access-three', refresh_token: 'refresh-three', token_type: 'Bearer', expires_in: 3600,
    } });
    expect(await auth.accessToken()).toBe('access-three');
    expect(requestUrl.mock.calls.at(-1)?.[0].body).toContain('refresh_token=refresh-one');
  });

  it('coalesces simultaneous refreshes so a rotating token is only spent once', async () => {
    requestUrl.mockResolvedValueOnce(discovery);
    const url = new URL(await auth.begin({ issuer: 'https://identity.example', clientId: 'visual-notes' }));
    requestUrl.mockResolvedValueOnce({ status: 200, json: {
      access_token: 'short', refresh_token: 'refresh-one', token_type: 'Bearer', expires_in: 1,
    } });
    await auth.complete({ code: 'code', state: url.searchParams.get('state')! });
    requestUrl.mockResolvedValueOnce({ status: 200, json: {
      access_token: 'renewed', refresh_token: 'refresh-two', token_type: 'Bearer', expires_in: 3600,
    } });
    await expect(Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()]))
      .resolves.toEqual(['renewed', 'renewed', 'renewed']);
    expect(requestUrl).toHaveBeenCalledTimes(3);
  });

  it('clears an expired non-renewable session and signs out locally', async () => {
    requestUrl.mockResolvedValueOnce(discovery);
    const url = new URL(await auth.begin({ issuer: 'https://identity.example', clientId: 'visual-notes' }));
    requestUrl.mockResolvedValueOnce({ status: 200, json: {
      access_token: 'short', token_type: 'Bearer', expires_in: 1,
    } });
    await auth.complete({ code: 'code', state: url.searchParams.get('state')! });
    await expect(auth.accessToken()).rejects.toThrow('expired');
    expect(auth.status().signedIn).toBe(false);
    auth.signOut();
    expect(auth.status().signedIn).toBe(false);
  });

  it('rejects non-HTTPS issuers before discovery', async () => {
    await expect(auth.begin({ issuer: 'http://identity.example', clientId: 'visual-notes' }))
      .rejects.toThrow('must use HTTPS');
    expect(requestUrl).not.toHaveBeenCalled();
  });
});
