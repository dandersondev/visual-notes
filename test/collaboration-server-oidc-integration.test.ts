import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const projectRoot = join(__dirname, '..');
const dataDirectory = mkdtempSync(join(tmpdir(), 'visual-notes-collab-oidc-'));
const collaborationPort = 31_000 + (process.pid % 1_000);
const audience = 'visual-notes-collaboration';
let issuerServer: Server;
let collaborationServer: ChildProcess;
let issuer = '';
let privateKey: KeyLike;

const alice = { clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', displayName: 'Alice', color: '#e57373' };
const bob = { clientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', displayName: 'Bob', color: '#4fc3f7' };
const board = { version: 3, layout: 'freeform', cards: [], connections: [], drawings: [] };

beforeAll(async () => {
  const keys = await generateKeyPair('RS256');
  privateKey = keys.privateKey;
  const publicJwk = await exportJWK(keys.publicKey);
  issuerServer = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/.well-known/openid-configuration') {
      response.end(JSON.stringify({ issuer, jwks_uri: `${issuer}jwks` })); return;
    }
    if (request.url === '/jwks') {
      response.end(JSON.stringify({ keys: [{ ...publicJwk, kid: 'test', alg: 'RS256', use: 'sig' }] })); return;
    }
    response.writeHead(404).end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>(resolve => issuerServer.listen(0, '127.0.0.1', resolve));
  const address = issuerServer.address();
  if (!address || typeof address === 'string') throw new Error('OIDC issuer did not bind.');
  issuer = `http://127.0.0.1:${address.port}/`;
  collaborationServer = await startCollaborationServer();
}, 15_000);

afterAll(async () => {
  await stopProcess(collaborationServer);
  await new Promise<void>(resolve => issuerServer.close(() => resolve()));
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe('OIDC collaboration server', () => {
  it('reports OIDC discovery and persistence readiness without exposing configuration', async () => {
    const response = await fetch(`http://127.0.0.1:${collaborationPort}/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, authMode: 'oidc' });
  });

  it('binds room access to the verified account rather than a claimed device ID', async () => {
    const aliceJwt = await accountToken('account-alice');
    const bobJwt = await accountToken('account-bob');
    const created = await roomRequest<{
      roomId: string; accessToken: string; inviteCode: string;
    }>('/rooms', { initialBoard: board, identity: alice }, aliceJwt);

    await expect(roomRequest('/rooms/manage', {
      roomId: created.roomId, clientId: alice.clientId, accessToken: created.accessToken,
    }, aliceJwt)).resolves.toMatchObject({ members: [expect.objectContaining({ role: 'owner' })] });

    // Bob knows Alice's public device ID and this test deliberately hands him
    // the room bearer token. His independently verified account still cannot
    // impersonate Alice because the membership is account-bound.
    await expect(roomRequest('/rooms/manage', {
      roomId: created.roomId, clientId: alice.clientId, accessToken: created.accessToken,
    }, bobJwt)).rejects.toThrow(/only the room owner/i);

    const bobRoom = await roomRequest<{ accessToken: string; role: string }>(
      '/rooms/resolve', { inviteCode: created.inviteCode, identity: bob }, bobJwt,
    );
    expect(bobRoom.role).toBe('editor');

    const wrongAudience = await accountToken('account-alice', 'another-service');
    await expect(roomRequest('/rooms', { initialBoard: board, identity: alice }, wrongAudience))
      .rejects.toThrow(/service authentication is invalid/i);
  });

  it('discovers account-owned root rooms and authorizes a new device without an old room token', async () => {
    const aliceJwt = await accountToken('account-discovery-alice');
    const bobJwt = await accountToken('account-discovery-bob');
    const created = await roomRequest<{
      roomId: string; accessToken: string; inviteCode: string;
    }>('/rooms', { initialBoard: board, identity: alice }, aliceJwt);

    await expect(roomRequest<{ rooms: unknown[] }>('/account/rooms', {}, aliceJwt)).resolves.toEqual({
      rooms: [{ roomId: created.roomId, role: 'owner', cardCount: 0, childCount: 0, sequence: 0 }],
    });
    await expect(roomRequest('/account/rooms/open', {
      roomId: created.roomId, identity: bob,
    }, bobJwt)).rejects.toThrow(/does not belong/i);

    const newAliceDevice = {
      clientId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', displayName: 'Alice laptop', color: '#81c784',
    };
    const opened = await roomRequest<{
      roomId: string; accessToken: string; role: string; board: typeof board;
    }>('/account/rooms/open', { roomId: created.roomId, identity: newAliceDevice }, aliceJwt);
    expect(opened).toMatchObject({ roomId: created.roomId, role: 'owner', board });
    expect(opened.accessToken).toMatch(/^[A-Za-z0-9_-]+$/);
    await expect(roomRequest('/rooms/manage', {
      roomId: created.roomId, clientId: newAliceDevice.clientId, accessToken: opened.accessToken,
    }, aliceJwt)).resolves.toMatchObject({
      members: expect.arrayContaining([expect.objectContaining({ clientId: newAliceDevice.clientId, role: 'owner' })]),
    });
  });
});

async function accountToken(subject: string, tokenAudience = audience): Promise<string> {
  return new SignJWT({ scope: 'openid visual-notes:collaborate' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(issuer).setAudience(tokenAudience).setSubject(subject)
    .setIssuedAt().setExpirationTime('5m').sign(privateKey);
}

async function roomRequest<T>(path: string, body: Record<string, unknown>, token: string): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${collaborationPort}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Room request failed (${response.status}).`);
  return payload;
}

async function startCollaborationServer(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['collaboration-server/dist/server.mjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      VISUAL_NOTES_COLLAB_PORT: String(collaborationPort),
      VISUAL_NOTES_COLLAB_DATA: dataDirectory,
      VISUAL_NOTES_COLLAB_AUTH_MODE: 'oidc',
      VISUAL_NOTES_COLLAB_OIDC_ISSUER: issuer,
      VISUAL_NOTES_COLLAB_OIDC_AUDIENCE: audience,
      VISUAL_NOTES_COLLAB_OIDC_REQUIRED_SCOPE: 'visual-notes:collaborate',
      VISUAL_NOTES_COLLAB_ALLOW_INSECURE_OIDC: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr?.on('data', chunk => { errors += String(chunk); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`OIDC collaboration server exited early: ${errors}`);
    try {
      const response = await fetch(`http://127.0.0.1:${collaborationPort}/health`);
      if (response.ok) return child;
    } catch { /* still starting */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`OIDC collaboration server did not start: ${errors}`);
}

async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill();
  await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 2_000))]);
}
