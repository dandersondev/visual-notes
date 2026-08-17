export interface PrivateNetworkCollaborationInvite {
  version: 1;
  serverUrl: string;
  serverToken: string;
  inviteCode: string;
}

const INVITE_PREFIX = 'visual-notes-collab:v1:';

/** The SecretStorage entry holding the private-network server secret. */
export const PRIVATE_NETWORK_SECRET_ID = 'visual-notes-collaboration-server';

/** The subset of Obsidian's SecretStorage that collaboration actually uses. */
export interface CollaborationSecretStore {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

/**
 * Obsidian gained SecretStorage in 1.11.4, and it is the only place the
 * private-network server secret is allowed to live -- data.json and
 * localStorage are both plaintext on disk. Rather than raise the plugin's
 * minAppVersion to 1.11.4 for one opt-in feature, which would strand every
 * user below it on an old build forever, collaboration is detected at
 * runtime and simply stays unavailable where the API is missing.
 *
 * Returns undefined on any Obsidian that predates the API.
 */
export function collaborationSecretStore(app: unknown): CollaborationSecretStore | undefined {
  if (!app || typeof app !== 'object') return undefined;
  const storage: unknown = (app as { secretStorage?: unknown }).secretStorage;
  if (!storage || typeof storage !== 'object') return undefined;
  const candidate = storage as Partial<CollaborationSecretStore>;
  return typeof candidate.getSecret === 'function' && typeof candidate.setSecret === 'function'
    ? (storage as CollaborationSecretStore)
    : undefined;
}

export function generatePrivateNetworkServerToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A portable private-network invite. Treat the returned value like a password. */
export function encodePrivateNetworkInvite(
  serverUrl: string,
  serverToken: string,
  inviteCode: string,
): string {
  if (!isPrivateNetworkCollaborationUrl(serverUrl)) throw new Error('Private-network server URL is invalid or unsafe.');
  if (serverToken.trim().length < 24) throw new Error('Private-network server secret must contain at least 24 characters.');
  if (!inviteCode.trim()) throw new Error('Collaboration room invite code is missing.');
  const payload: PrivateNetworkCollaborationInvite = {
    version: 1,
    serverUrl: normalizeServerUrl(serverUrl),
    serverToken: serverToken.trim(),
    inviteCode: inviteCode.trim(),
  };
  return `${INVITE_PREFIX}${base64UrlEncode(JSON.stringify(payload))}`;
}

/** Returns undefined for legacy room codes, which remain valid for hosted development. */
export function decodePrivateNetworkInvite(value: string): PrivateNetworkCollaborationInvite | undefined {
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith(INVITE_PREFIX)) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(base64UrlDecode(trimmed.slice(INVITE_PREFIX.length))); }
  catch { throw new Error('Private-network invitation is invalid.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Private-network invitation is invalid.');
  const invite = parsed as Partial<PrivateNetworkCollaborationInvite>;
  if (invite.version !== 1 || typeof invite.serverUrl !== 'string'
    || typeof invite.serverToken !== 'string' || typeof invite.inviteCode !== 'string') {
    throw new Error('Private-network invitation is invalid.');
  }
  if (!isPrivateNetworkCollaborationUrl(invite.serverUrl)) throw new Error('Private-network invitation contains an unsafe server URL.');
  if (invite.serverToken.trim().length < 24 || !invite.inviteCode.trim()) {
    throw new Error('Private-network invitation is incomplete.');
  }
  return {
    version: 1,
    serverUrl: normalizeServerUrl(invite.serverUrl),
    serverToken: invite.serverToken.trim(),
    inviteCode: invite.inviteCode.trim(),
  };
}

/**
 * Unencrypted WebSockets are accepted only on addresses used by local and
 * overlay networks. wss:// remains valid for any host. Hostnames cannot be
 * resolved safely in the renderer, so private DNS uses .local or .ts.net.
 */
export function isPrivateNetworkCollaborationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
    if (url.protocol === 'wss:') return true;
    if (url.protocol !== 'ws:') return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.ts.net')) return true;
    if (isPrivateIpv4(host)) return true;
    return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8')
      || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb');
  } catch { return false; }
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function normalizeServerUrl(value: string): string {
  const url = new URL(value.trim());
  url.pathname = '/';
  return url.toString().replace(/\/$/, '');
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url.');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}
