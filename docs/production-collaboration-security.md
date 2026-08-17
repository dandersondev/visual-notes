# Identity and security design for a possible future hosted service

> **Design notes for something that does not exist yet.** The identity system
> described below is not built and not running; no accounts exist and no
> sign-in is reachable in the plugin.
>
> **What ships today is private-network collaboration only** — see the
> [README](../README.md). Authentication there is a single shared server secret
> held in Obsidian's SecretStorage, never an account. This document is kept in
> the repo to record the reasoning should a hosted option ever be built.

## The simple version

Visual Notes should not store passwords or invent its own login system. A
managed OpenID Connect provider will prove who a person is. The Obsidian plugin
will open the system browser, complete Authorization Code + PKCE, and return to
the plugin without ever containing a client secret. The collaboration service
will verify the provider's signed identity and issue a short-lived,
Visual-Notes-specific session. Room membership will belong to the account;
display colour and live cursor identity will remain device-specific.

The standards behind this are [OAuth for Native Apps (RFC 8252)](https://www.rfc-editor.org/info/rfc8252/),
[OAuth Security Best Current Practice (RFC 9700)](https://www.rfc-editor.org/info/rfc9700/),
and [OpenID Connect Discovery](https://openid.net/specs/openid-connect-discovery-1_0.html).

## Identities and credentials

| Thing | Purpose | Lifetime | Stored where |
| --- | --- | --- | --- |
| Account ID | Stable owner of rooms, memberships and subscription | Long-lived | Provider + service database |
| Device/client ID | Distinguishes installations for cursors and operation IDs | Long-lived | Installation-local plugin storage |
| Provider authorization code | One-time browser sign-in result protected by PKCE | Seconds | Memory only |
| Provider refresh token | Renews provider identity; rotation/reuse detection required | Provider policy | Currently installation-local browser storage; secure storage/token broker required before release |
| Visual Notes service session | Authorizes API and WebSocket connection for one account/device | About 15 minutes | Memory; refresh when needed |
| Room invite | Lets an authenticated account accept an editor/viewer role | Until used/replaced/expired | Hashed server-side |
| Media playback ticket | Authorizes one room asset without putting broader tokens in a URL | Minutes/hours | Memory only |

No password, OAuth client secret, raw invite, or raw room/session token belongs
inside a `.canvas` file. A desktop plugin is a public client: anything shipped
inside `main.js` must be treated as visible to everyone.

## Proposed sign-in sequence

1. The plugin generates a random PKCE verifier, its S256 challenge, `state`, and
   OpenID Connect `nonce`.
2. It opens the provider's authorization URL in the system browser and asks the
   provider to return to the registered `obsidian://visual-notes-auth` action.
   This avoids a Node-only loopback listener and works with Obsidian mobile.
3. The protocol callback accepts one matching response only. The plugin verifies state,
   then exchanges the code plus verifier with the provider.
4. In the current foundation, the plugin presents the provider access JWT
   directly to the Visual Notes service over TLS. The service verifies issuer,
   audience, expiry, signature, required scope, and the provider signing key
   discovered from `jwks_uri` before deriving the account ID.
5. Room operations still perform their own membership/role check. A later
   broker may exchange the provider assertion for a narrower, short-lived
   Visual Notes service session; that indirection is not implemented yet.
6. Provider refresh-token rotation renews the access token. Sign-out clears the
   local session; provider-side revocation/account disablement and forced socket
   closure remain staging work.

## Authorization model

- Accounts own root rooms; memberships are keyed by account ID, not display
  name or device ID.
- A device ID remains attached to operations and presence so two devices on one
  account are still distinguishable.
- Room and nested-tree roles remain owner/editor/viewer. The server checks the
  role for every operation, asset action and management request.
- Invites can only grant a role after authentication. Redeeming one attaches
  the account to the room; it does not become a permanent bearer credential.
- Subscription entitlement controls creation/limits, not access to local files
  or export of already-owned hosted data.

## Threats we explicitly design for

- A copied plugin bundle exposes configuration: therefore no client secret is
  shipped.
- A malicious app intercepts an authorization redirect: PKCE and exact state
  matching make the stolen code unusable.
- A token leaks through logs or URLs: tokens are redacted, HTTPS headers carry
  them, and media URLs contain narrow short-lived tickets only.
- A refresh token is replayed: rotation and reuse detection revoke the token
  family and require sign-in again.
- A removed member keeps an open socket: membership is rechecked and the socket
  is closed, including in nested rooms.
- A compromised room token reaches another room: service sessions identify the
  account, while every room request independently checks membership and role.
- Brute-force invites or endpoints: invite entropy, expiry, per-IP/account rate
  limits and structured security events make attacks costly and observable.
- Server/data loss: retained snapshots, tested backups, restore drills and the
  user's ordinary local Canvas remain independent recovery layers.

## Migration from development mode

Development mode remains loopback-only and continues to use the shared token so
local testing stays simple. Production mode must fail closed unless an HTTPS
OpenID issuer, audience, signing/session secrets, database and object storage
are configured. The modes use one `ServiceAuthenticator` boundary so production
routes cannot accidentally retain ad-hoc development-token checks.

Implementation order:

1. Centralise the development gate behind `ServiceAuthenticator` and reject
   unsafe/default-token public bindings. **Complete.**
2. Add OIDC discovery/JWKS verification and bind room membership to the
   verified provider account. **Complete on the server.**
3. Add browser PKCE sign-in and short-lived access/refresh handling.
   **Complete as an experimental client foundation.** Refresh tokens currently
   use installation-local browser storage because Obsidian exposes no public
   cross-platform keychain API; this is an explicit release blocker until a
   secure storage or hosted token-broker design is selected.
4. Migrate room membership from client IDs to account IDs while retaining
   device IDs for presence and operation attribution.
5. Move JSON room state and assets behind database/object-store interfaces,
   then deploy staging with logs, limits, backups and restore tests.
