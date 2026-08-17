import { requestUrl } from 'obsidian';

const PENDING_MAX_AGE_MS = 10 * 60 * 1000;
const REFRESH_EARLY_MS = 60 * 1000;

export interface CollaborationOidcConfig {
  issuer: string;
  clientId: string;
  redirectUri?: string;
  scope?: string;
  audience?: string;
}

export interface CollaborationOidcDiscovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

interface PendingAuthorization {
  state: string;
  nonce: string;
  codeVerifier: string;
  issuer: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  tokenEndpoint: string;
  createdAt: number;
}

export interface CollaborationAuthSession {
  issuer: string;
  clientId: string;
  tokenEndpoint: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
}

export interface CollaborationAuthStatus {
  signedIn: boolean;
  expiresAt?: number;
  issuer?: string;
}

export interface CollaborationAuthOptions {
  storage: Storage;
  namespace: string;
  now?: () => number;
  allowInsecureLoopbackIssuer?: boolean;
}

interface TokenPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

/** Browser-based OAuth/OIDC session manager for Obsidian desktop and mobile. */
export class CollaborationAuthClient {
  private readonly now: () => number;
  private refreshInFlight?: Promise<string>;

  constructor(private readonly options: CollaborationAuthOptions) {
    this.now = options.now ?? Date.now;
  }

  async begin(config: CollaborationOidcConfig): Promise<string> {
    const normalized = normalizeConfig(config);
    assertIssuerUrl(normalized.issuer, this.options.allowInsecureLoopbackIssuer === true);
    const discovery = await discover(normalized.issuer);
    if (discovery.issuer !== normalized.issuer) throw new Error('Identity provider returned a different issuer.');
    assertHttpsUrl(discovery.authorizationEndpoint, 'authorization endpoint');
    assertHttpsUrl(discovery.tokenEndpoint, 'token endpoint');

    const codeVerifier = randomBase64Url(32);
    const state = randomBase64Url(32);
    const nonce = randomBase64Url(32);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
    const codeChallenge = bytesBase64Url(new Uint8Array(digest));
    const pending: PendingAuthorization = {
      state, nonce, codeVerifier,
      issuer: normalized.issuer,
      clientId: normalized.clientId,
      redirectUri: normalized.redirectUri,
      scope: normalized.scope,
      tokenEndpoint: discovery.tokenEndpoint,
      createdAt: this.now(),
    };
    this.options.storage.setItem(this.pendingKey(), JSON.stringify(pending));

    const url = new URL(discovery.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', normalized.clientId);
    url.searchParams.set('redirect_uri', normalized.redirectUri);
    url.searchParams.set('scope', normalized.scope);
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (normalized.audience) url.searchParams.set('audience', normalized.audience);
    return url.toString();
  }

  async complete(params: Record<string, string>): Promise<CollaborationAuthSession> {
    const pending = this.readPending();
    // A callback is consumable once, including failed callbacks. This stops a
    // captured authorization code or state value being replayed later.
    this.options.storage.removeItem(this.pendingKey());
    if (!pending) throw new Error('No sign-in attempt is waiting for this callback.');
    if (this.now() - pending.createdAt > PENDING_MAX_AGE_MS) throw new Error('The sign-in attempt expired. Please try again.');
    if (!params.state || !constantTimeEqual(params.state, pending.state)) throw new Error('The sign-in callback state did not match.');
    if (params.error) throw new Error(params.error_description || `Sign-in failed: ${params.error}`);
    if (!params.code) throw new Error('The sign-in callback did not contain an authorization code.');

    const token = await tokenRequest(pending.tokenEndpoint, {
      grant_type: 'authorization_code',
      code: params.code,
      client_id: pending.clientId,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.codeVerifier,
    });
    const session = sessionFromToken(token, pending, this.now());
    this.saveSession(session);
    return session;
  }

  status(): CollaborationAuthStatus {
    const session = this.readSession();
    return session
      ? { signedIn: true, expiresAt: session.expiresAt, issuer: session.issuer }
      : { signedIn: false };
  }

  async accessToken(): Promise<string> {
    const session = this.readSession();
    if (!session) throw new Error('Sign in to collaboration first.');
    if (session.expiresAt > this.now() + REFRESH_EARLY_MS) return session.accessToken;
    if (!session.refreshToken) {
      this.clearSession();
      throw new Error('Your collaboration sign-in expired. Please sign in again.');
    }
    return this.refreshInFlight ??= this.refresh(session).finally(() => { this.refreshInFlight = undefined; });
  }

  signOut(): void {
    this.options.storage.removeItem(this.pendingKey());
    this.clearSession();
  }

  private readPending(): PendingAuthorization | undefined {
    return parseStored<PendingAuthorization>(this.options.storage.getItem(this.pendingKey()), value =>
      typeof value.state === 'string' && typeof value.codeVerifier === 'string'
      && typeof value.issuer === 'string' && typeof value.clientId === 'string'
      && typeof value.redirectUri === 'string' && typeof value.scope === 'string'
      && typeof value.tokenEndpoint === 'string' && typeof value.createdAt === 'number'
      && typeof value.nonce === 'string');
  }

  private readSession(): CollaborationAuthSession | undefined {
    return parseStored<CollaborationAuthSession>(this.options.storage.getItem(this.sessionKey()), value =>
      typeof value.issuer === 'string' && typeof value.clientId === 'string'
      && typeof value.tokenEndpoint === 'string' && typeof value.accessToken === 'string'
      && typeof value.expiresAt === 'number'
      && (value.refreshToken === undefined || typeof value.refreshToken === 'string'));
  }

  private saveSession(session: CollaborationAuthSession): void {
    this.options.storage.setItem(this.sessionKey(), JSON.stringify(session));
  }

  private async refresh(session: CollaborationAuthSession): Promise<string> {
    const token = await tokenRequest(session.tokenEndpoint, {
      grant_type: 'refresh_token', refresh_token: session.refreshToken!, client_id: session.clientId,
    });
    const refreshed = sessionFromToken(token, session, this.now(), session.refreshToken);
    this.saveSession(refreshed);
    return refreshed.accessToken;
  }

  private clearSession(): void { this.options.storage.removeItem(this.sessionKey()); }
  private pendingKey(): string { return `visual-notes:collaboration-auth:pending:${encodeURIComponent(this.options.namespace)}`; }
  private sessionKey(): string { return `visual-notes:collaboration-auth:session:${encodeURIComponent(this.options.namespace)}`; }
}

async function discover(issuer: string): Promise<CollaborationOidcDiscovery> {
  const response = await requestUrl({
    url: `${issuer}/.well-known/openid-configuration`, method: 'GET', throw: false,
  });
  if (response.status < 200 || response.status >= 300) throw new Error(`Could not discover the identity provider (${response.status}).`);
  const value = response.json as Record<string, unknown>;
  if (typeof value.issuer !== 'string' || typeof value.authorization_endpoint !== 'string'
    || typeof value.token_endpoint !== 'string') throw new Error('Identity provider discovery response is invalid.');
  return { issuer: trimTrailingSlash(value.issuer), authorizationEndpoint: value.authorization_endpoint, tokenEndpoint: value.token_endpoint };
}

async function tokenRequest(endpoint: string, values: Record<string, string>): Promise<TokenPayload> {
  const response = await requestUrl({
    url: endpoint, method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values).toString(), throw: false,
  });
  const payload = response.json as TokenPayload & { error?: unknown; error_description?: unknown };
  if (response.status < 200 || response.status >= 300) {
    const message = typeof payload.error_description === 'string' ? payload.error_description
      : typeof payload.error === 'string' ? payload.error : `Identity provider returned ${response.status}.`;
    throw new Error(message);
  }
  return payload;
}

function sessionFromToken(
  token: TokenPayload,
  source: Pick<CollaborationAuthSession, 'issuer' | 'clientId' | 'tokenEndpoint'> & { scope?: string },
  now: number,
  previousRefreshToken?: string,
): CollaborationAuthSession {
  if (typeof token.access_token !== 'string' || !token.access_token) throw new Error('Identity provider did not return an access token.');
  if (typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer') throw new Error('Identity provider returned an unsupported token type.');
  if (typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
    throw new Error('Identity provider did not return a valid token lifetime.');
  }
  return {
    issuer: source.issuer, clientId: source.clientId, tokenEndpoint: source.tokenEndpoint,
    accessToken: token.access_token,
    refreshToken: typeof token.refresh_token === 'string' && token.refresh_token ? token.refresh_token : previousRefreshToken,
    expiresAt: now + token.expires_in * 1000,
    scope: typeof token.scope === 'string' ? token.scope : source.scope,
  };
}

function normalizeConfig(config: CollaborationOidcConfig): Required<CollaborationOidcConfig> {
  const issuer = trimTrailingSlash(config.issuer.trim());
  const clientId = config.clientId.trim();
  if (!issuer) throw new Error('Enter the identity provider issuer URL.');
  if (!clientId) throw new Error('Enter the identity provider client ID.');
  return {
    issuer, clientId,
    redirectUri: config.redirectUri?.trim() || 'obsidian://visual-notes-auth',
    scope: config.scope?.trim() || 'openid profile email offline_access',
    audience: config.audience?.trim() || '',
  };
}

function assertIssuerUrl(value: string, allowInsecureLoopback: boolean): void {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('Identity provider issuer URL is invalid.');
  if (url.protocol === 'https:') return;
  if (allowInsecureLoopback && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return;
  throw new Error('Identity provider issuer must use HTTPS.');
}

function assertHttpsUrl(value: string, label: string): void {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error(`Identity provider ${label} must use HTTPS.`);
}

function randomBase64Url(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesBase64Url(bytes);
}

function bytesBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function parseStored<T extends object>(raw: string | null, valid: (value: Record<string, unknown>) => boolean): T | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) && valid(value as Record<string, unknown>) ? value as T : undefined;
  } catch { return undefined; }
}

function trimTrailingSlash(value: string): string { return value.replace(/\/+$/, ''); }
