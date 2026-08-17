import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createServiceAuthenticator, principalMatchesAccount, serviceAccountId,
} from '../collaboration-server/src/service-auth';

describe('collaboration service authentication boundary', () => {
  it('keeps loopback development mode simple and rejects the wrong token', async () => {
    const auth = createServiceAuthenticator({ VISUAL_NOTES_COLLAB_TOKEN: 'test-token' });
    await expect(auth.authorize('test-token')).resolves.toEqual({ kind: 'development' });
    await expect(auth.authorize('wrong')).resolves.toBeUndefined();
  });

  it('refuses a public binding with the well-known default token', () => {
    expect(() => createServiceAuthenticator({ VISUAL_NOTES_COLLAB_HOST: '0.0.0.0' }))
      .toThrow(/refusing.*default development token/i);
  });

  it('allows a non-loopback development binding when a non-default token is explicit', async () => {
    const auth = createServiceAuthenticator({
      VISUAL_NOTES_COLLAB_HOST: '0.0.0.0', VISUAL_NOTES_COLLAB_TOKEN: 'long-random-test-token',
    });
    await expect(auth.authorize('long-random-test-token')).resolves.toBeDefined();
  });

  it('fails closed when OIDC configuration is incomplete or insecure', () => {
    expect(() => createServiceAuthenticator({ VISUAL_NOTES_COLLAB_AUTH_MODE: 'oidc' }))
      .toThrow(/requires.*issuer.*audience/i);
    expect(() => createServiceAuthenticator({
      VISUAL_NOTES_COLLAB_AUTH_MODE: 'oidc',
      VISUAL_NOTES_COLLAB_OIDC_ISSUER: 'http://accounts.example.com',
      VISUAL_NOTES_COLLAB_OIDC_AUDIENCE: 'visual-notes',
    })).toThrow(/must use HTTPS/i);
  });

  it('namespaces production accounts by issuer and never treats a development request as that account', () => {
    const account = { kind: 'account' as const, issuer: 'https://accounts.example.com', subject: 'user-1' };
    const accountId = 'https://accounts.example.com\nuser-1';
    expect(serviceAccountId(account)).toBe(accountId);
    expect(principalMatchesAccount(account, accountId)).toBe(true);
    expect(principalMatchesAccount({ ...account, subject: 'user-2' }, accountId)).toBe(false);
    expect(principalMatchesAccount({ kind: 'development' }, accountId)).toBe(false);
    expect(principalMatchesAccount({ kind: 'development' }, undefined)).toBe(true);
  });
});

describe('OIDC service authentication', () => {
  let server: Server;
  let issuer = '';
  let privateKey: KeyLike;
  let unknownPrivateKey: KeyLike;

  beforeAll(async () => {
    const primary = await generateKeyPair('RS256');
    const unknown = await generateKeyPair('RS256');
    privateKey = primary.privateKey;
    unknownPrivateKey = unknown.privateKey;
    const publicJwk = await exportJWK(primary.publicKey);
    server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/.well-known/openid-configuration') {
        response.end(JSON.stringify({ issuer, jwks_uri: `${issuer}jwks` })); return;
      }
      if (request.url === '/jwks') {
        response.end(JSON.stringify({ keys: [{ ...publicJwk, kid: 'primary', alg: 'RS256', use: 'sig' }] })); return;
      }
      response.writeHead(404).end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test OIDC server did not bind.');
    issuer = `http://127.0.0.1:${address.port}/`;
  });

  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

  const authenticator = () => createServiceAuthenticator({
    VISUAL_NOTES_COLLAB_AUTH_MODE: 'oidc',
    VISUAL_NOTES_COLLAB_OIDC_ISSUER: issuer,
    VISUAL_NOTES_COLLAB_OIDC_AUDIENCE: 'visual-notes-collaboration',
    VISUAL_NOTES_COLLAB_OIDC_REQUIRED_SCOPE: 'visual-notes:collaborate',
    VISUAL_NOTES_COLLAB_ALLOW_INSECURE_OIDC: '1',
  });

  const token = async (options: {
    issuer?: string; audience?: string; expiresIn?: string | number; scope?: string; unknownKey?: boolean;
  } = {}) => new SignJWT({ scope: options.scope ?? 'openid visual-notes:collaborate' })
    .setProtectedHeader({ alg: 'RS256', kid: options.unknownKey ? 'unknown' : 'primary' })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? 'visual-notes-collaboration')
    .setSubject('account-123')
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '5m')
    .sign(options.unknownKey ? unknownPrivateKey : privateKey);

  it('discovers signing keys and accepts a correctly scoped account token', async () => {
    await expect(authenticator().authorize(await token())).resolves.toEqual({
      kind: 'account', issuer, subject: 'account-123',
    });
  });

  it('rejects wrong issuer, audience, expiry, key, and scope', async () => {
    const auth = authenticator();
    await expect(auth.authorize(await token({ issuer: `${issuer}/wrong` }))).resolves.toBeUndefined();
    await expect(auth.authorize(await token({ audience: 'another-service' }))).resolves.toBeUndefined();
    await expect(auth.authorize(await token({ expiresIn: -60 }))).resolves.toBeUndefined();
    await expect(auth.authorize(await token({ unknownKey: true }))).resolves.toBeUndefined();
    await expect(auth.authorize(await token({ scope: 'openid profile' }))).resolves.toBeUndefined();
  });
});
