import { requestUrl } from 'obsidian';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { requireDesktopNodeModule } from './desktop-node';

const { createHash, timingSafeEqual } = requireDesktopNodeModule<typeof import('node:crypto')>('node:crypto');

export interface ServicePrincipal {
  kind: 'development' | 'account';
  issuer?: string;
  subject?: string;
}

export interface ServiceAuthenticator {
  readonly mode: 'development' | 'oidc';
  authorize(credential: string | undefined): Promise<ServicePrincipal | undefined>;
  ready(): Promise<void>;
}

export function serviceAccountId(principal: ServicePrincipal): string | undefined {
  return principal.kind === 'account' && principal.issuer && principal.subject
    ? `${principal.issuer}\n${principal.subject}` : undefined;
}

export function principalMatchesAccount(principal: ServicePrincipal, accountId: string | undefined): boolean {
  const authenticatedAccount = serviceAccountId(principal);
  return authenticatedAccount === undefined ? accountId === undefined : authenticatedAccount === accountId;
}

export interface ServiceAuthEnvironment {
  VISUAL_NOTES_COLLAB_AUTH_MODE?: string;
  VISUAL_NOTES_COLLAB_TOKEN?: string;
  VISUAL_NOTES_COLLAB_HOST?: string;
  VISUAL_NOTES_COLLAB_ALLOW_INSECURE_DEVELOPMENT?: string;
  VISUAL_NOTES_COLLAB_OIDC_ISSUER?: string;
  VISUAL_NOTES_COLLAB_OIDC_AUDIENCE?: string;
  VISUAL_NOTES_COLLAB_OIDC_REQUIRED_SCOPE?: string;
  VISUAL_NOTES_COLLAB_ALLOW_INSECURE_OIDC?: string;
}

const DEFAULT_DEVELOPMENT_TOKEN = 'visual-notes-local-dev';

export function createServiceAuthenticator(environment: ServiceAuthEnvironment): ServiceAuthenticator {
  const mode = environment.VISUAL_NOTES_COLLAB_AUTH_MODE?.trim() || 'development';
  if (mode === 'oidc') return createOidcAuthenticator(environment);
  if (mode !== 'development') throw new Error(`Unsupported collaboration authentication mode "${mode}".`);
  const token = environment.VISUAL_NOTES_COLLAB_TOKEN ?? DEFAULT_DEVELOPMENT_TOKEN;
  if (!token.trim()) throw new Error('VISUAL_NOTES_COLLAB_TOKEN cannot be empty in development mode.');
  const host = environment.VISUAL_NOTES_COLLAB_HOST ?? '127.0.0.1';
  if (!isLoopbackHost(host)
    && token === DEFAULT_DEVELOPMENT_TOKEN
    && environment.VISUAL_NOTES_COLLAB_ALLOW_INSECURE_DEVELOPMENT !== '1') {
    throw new Error(
      'Refusing to expose the collaboration server beyond loopback with the default development token. '
      + 'Set a strong VISUAL_NOTES_COLLAB_TOKEN; the insecure override is for isolated test networks only.',
    );
  }
  return {
    mode: 'development',
    authorize: credential => Promise.resolve(
      credential !== undefined && constantTimeEqual(credential, token) ? { kind: 'development' } : undefined,
    ),
    ready: () => Promise.resolve(),
  };
}

/**
 * The shared secret is compared on every connection attempt, so compare it in
 * time independent of how many leading characters happen to match. `===`
 * returns early on the first differing byte.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would leak the length
  // through the exception; hash first so both sides are always 32 bytes.
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function createOidcAuthenticator(environment: ServiceAuthEnvironment): ServiceAuthenticator {
  // Issuer identifiers are exact, opaque values. Auth0 commonly includes a
  // trailing slash in both discovery and JWT `iss`; removing it makes every
  // otherwise-valid Auth0 access token fail exact issuer verification.
  const issuer = environment.VISUAL_NOTES_COLLAB_OIDC_ISSUER?.trim();
  const audience = environment.VISUAL_NOTES_COLLAB_OIDC_AUDIENCE?.trim();
  if (!issuer || !audience) {
    throw new Error('OIDC mode requires VISUAL_NOTES_COLLAB_OIDC_ISSUER and VISUAL_NOTES_COLLAB_OIDC_AUDIENCE.');
  }
  const issuerUrl = parseUrl(issuer, 'OIDC issuer');
  const allowInsecure = environment.VISUAL_NOTES_COLLAB_ALLOW_INSECURE_OIDC === '1';
  assertSecureOidcUrl(issuerUrl, allowInsecure);
  const requiredScope = environment.VISUAL_NOTES_COLLAB_OIDC_REQUIRED_SCOPE?.trim();
  let verificationKey: Promise<JWTVerifyGetKey> | undefined;

  const getVerificationKey = (): Promise<JWTVerifyGetKey> => {
    verificationKey ??= discoverVerificationKey(issuer, allowInsecure);
    return verificationKey;
  };

  return {
    mode: 'oidc',
    ready: async () => { await getVerificationKey(); },
    async authorize(credential): Promise<ServicePrincipal | undefined> {
      if (!credential) return undefined;
      try {
        const key = await getVerificationKey();
        const { payload } = await jwtVerify(credential, key, {
          issuer, audience, algorithms: ['RS256', 'ES256', 'EdDSA'], clockTolerance: 5,
        });
        if (typeof payload.sub !== 'string' || !payload.sub) return undefined;
        if (requiredScope && !tokenScopes(payload.scope).has(requiredScope)) return undefined;
        return { kind: 'account', issuer, subject: payload.sub };
      } catch { return undefined; }
    },
  };
}

async function discoverVerificationKey(issuer: string, allowInsecure: boolean): Promise<JWTVerifyGetKey> {
  const discoveryUrl = new URL(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`);
  const response = await requestUrl({ url: discoveryUrl.toString(), headers: { accept: 'application/json' }, throw: false });
  if (response.status < 200 || response.status >= 300) throw new Error(`OIDC discovery failed with ${response.status}.`);
  const value: unknown = response.json;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('OIDC discovery document is invalid.');
  const discovery = value as Record<string, unknown>;
  if (discovery.issuer !== issuer || typeof discovery.jwks_uri !== 'string') {
    throw new Error('OIDC discovery issuer or JWKS URL is invalid.');
  }
  const jwksUrl = parseUrl(discovery.jwks_uri, 'OIDC JWKS URL');
  assertSecureOidcUrl(jwksUrl, allowInsecure);
  return createRemoteJWKSet(jwksUrl);
}

function tokenScopes(value: unknown): Set<string> {
  if (typeof value === 'string') return new Set(value.split(/\s+/).filter(Boolean));
  if (Array.isArray(value) && value.every(scope => typeof scope === 'string')) return new Set(value);
  return new Set();
}

function parseUrl(value: string, label: string): URL {
  try { return new URL(value); }
  catch { throw new Error(`${label} must be an absolute URL.`); }
}

function assertSecureOidcUrl(url: URL, allowInsecure: boolean): void {
  if (url.protocol === 'https:') return;
  if (allowInsecure && url.protocol === 'http:' && isLoopbackHost(url.hostname)) return;
  throw new Error('OIDC issuer and JWKS URLs must use HTTPS. Insecure OIDC is allowed only on loopback for automated tests.');
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}
