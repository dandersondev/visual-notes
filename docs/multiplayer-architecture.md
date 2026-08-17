# Experimental collaboration architecture

> Engineering document. The private-network path is preparing for an experimental release; hosted-cloud and account paths remain dormant development foundations.

Visual Notes collaboration is split into two deliberately separate layers.
The board stays a normal, portable `.canvas` file in both layers; using a
hosted service must never be required to open, edit, export, or keep a board.

## Included local collaboration foundation

The plugin now performs a stable-ID three-way merge whenever the file on disk
has changed since the open board was loaded. It compares:

- **Base:** the exact revision this editor loaded or last saved
- **Ours:** the current in-memory board
- **Theirs:** the revision now on disk

Independent changes to cards, connections, drawings, Storyboard sections and
shots, comment replies, table rows, checklist items, and other stable-ID data
merge recursively. Independent fields on the same object also merge. If both
sides change the same field differently, the local value wins and the full
remote file is refreshed at `<board>.canvas.conflict.bak`. A deletion made on
one side does not erase content concurrently edited on the other.

This works with any mechanism that puts a changed file into the vault:
Obsidian Sync, Git, Dropbox, iCloud, Syncthing, or another pane. It is not
real-time collaboration: there are no accounts, live cursors, presence, or
shared sessions yet.

## Optional hosted multiplayer

A paid hosted service can add immediacy and coordination without owning the
user's underlying documents. The natural paid value is operating the service,
not locking the file format:

- accounts, teams, invitations, and workspace membership
- live rooms over WebSocket with reconnect and offline replay
- presence, names, selections, viewports, and live cursors
- viewer, commenter, editor, and owner permissions
- revision history, restore points, and an audit trail
- managed storage for the operation log and room metadata
- rate limits, abuse controls, monitoring, backups, and support
- subscriptions, seat limits, trials, invoices, and entitlement checks

Ephemeral presence data should never be written into the `.canvas` file.
Durable edits should be applied locally and continue to save to Canvas, making
the vault copy the portable source of truth and the hosted operation stream the
low-latency coordination layer.

## Privacy and product rules

- Hosted collaboration is opt-in per board; local-only remains the default.
- A board can leave a room and remain fully usable as a normal Canvas file.
- Disconnecting or cancelling a subscription does not remove local content.
- Export and deletion controls cover hosted room data and account data.
- Authentication tokens live in Obsidian's plugin data, never inside boards.
- Presence payloads are short-lived and contain no board content beyond what
  is required to identify the active selection.
- The client validates permissions, but the server is authoritative for every
  room operation; client-only permission checks are not security.

## Implementation sequence

1. **Three-way file merge — complete.** Stable-ID merge, collision reporting,
   atomic writes, and conflict backups provide the offline safety net.
2. **Identity and operation envelope — complete foundation.** Each installation
   has an ID held in installation-local storage so syncing plugin settings
   cannot make two devices impersonate one another. Display name and colour
   are managed under an explicitly experimental settings section. Versioned operations carry `operationId`,
   `boardId`, `clientId`, actor name/colour, logical clock, timestamp, target ID,
   operation kind, and payload. The immutable reducer resolves stable-ID paths,
   supports set/delete/insert, deterministically orders replay, rejects stale
   paths, and deduplicates retried operation IDs. It is not connected to normal
   board edits or a network yet.
3. **Transport boundary and loopback sessions — complete foundation.** The
   transport contract covers connect, disconnect, publish, authoritative room
   snapshots, and ephemeral presence. The process-local loopback transport
   supports isolated rooms, stable server sequence numbers, idempotent
   operation publication, join/leave events, cursors, selections, and late
   join snapshots. Client sessions advance logical clocks, buffer out-of-order
   delivery, ignore duplicates, queue offline operations, and rebase/replay
   them over the current room snapshot on reconnect. Nothing is connected to
   ordinary board gestures or a network yet.
4. **Experimental live collaboration UI and board adapter — complete for
   loopback.** When the experimental setting is enabled, freeform views of the
   same board join its process-local room. Stable-ID diffs translate ordinary
   saves into set/insert/delete/move operations; incoming snapshots update the
   renderer and persist through the normal save queue without echo loops.
   A compact local-session indicator shows named/coloured collaborator avatars,
   while ephemeral presence renders remote cursors and card selections. The
   lifecycle flushes pending local operations and leaves the room when a view
   closes. This is deliberately limited to views in the same running Obsidian
   process until the hosted transport exists.
5. **Hosted room service — local development foundation complete.** A separate
   server workspace now implements the shared runtime-validated protocol over
   real WebSockets. It binds to loopback by default, requires a development
   token, owns room sequencing, validates identity/board consistency, persists
   canonical snapshots and accepted operation IDs atomically, restores rooms
   after restart, and exposes a health endpoint. The matching plugin transport
   supports acknowledgements, heartbeats, reconnect backoff, authoritative
   reconnect snapshots, and offline queue handoff. Production authentication,
   deployment, authorization, compaction, observability, and backups remain.
6. **Permissions and invitations — development foundation complete.** Private
   rooms persist owner/editor/viewer membership, issue separate editor and
   viewer invites, enforce viewer restrictions server-side, and let owners
   rotate invites or remove members. Real accounts and short-lived production
   sessions remain future work.
7. **Shared media assets — development foundation complete.** Image-card files,
   Storyboard backgrounds, and MP4/WebM video cards retain their ordinary
   vault path but may also carry a content-addressed room fallback. Editors
   upload missing media before publishing the board reference; collaborators
   use their own vault file when present and otherwise load an authenticated
   room copy. Images use a renderer-lifetime object-URL cache. Videos use
   short-lived room playback tickets and HTTP byte ranges so seeking does not
   download the entire file. The service verifies SHA-256, deduplicates
   storage, enforces 20 MB image and 250 MB video defaults, permits viewer
   playback/download but not uploads, rechecks membership on video range
   requests, and prevents cross-room access.
8. **Transfer UX and storage quotas — development foundation complete.** The
   collaboration bar reports media preparation and real upload progress, with
   cancellation and retry. The asset endpoint supports the preflight needed
   by Obsidian's progress-capable upload request. Rooms enforce a configurable
   deduplicated storage allowance (2 GB by default), and owners can inspect
   used/limit values in room management. Resumable/chunked uploads remain a
   future improvement for unreliable networks and very large files.
9. **Asset lifecycle cleanup — development foundation complete.** Canonical
   board operations reconcile image, Storyboard, and video references. Media
   losing its final room reference becomes recoverable for seven days by
   default; restoring the card during that window makes it active again.
   Owner-triggered cleanup removes only expired room registrations and scans
   every persisted room before deleting globally deduplicated bytes. Room
   management reports active/recoverable storage, exports the canonical board
   plus its asset manifest, and offers confirmed hosted-room deletion while
   leaving the local Canvas untouched. Production still needs scheduled
   cleanup, downloadable media bundles, audit logs, and backup integration.
10. **Collaborative nested boards — development foundation complete.** A nested
   Visual Notes board is a separate hosted child document rather than content
   embedded into its parent room. The parent stores only the child room ID next
   to the normal vault-relative path; credentials remain installation-local.
   New nested boards are registered with the room service automatically, while
   an existing local nested board is adopted the first time an editor opens it
   from a collaborative parent. A collaborator who does not have the child file
   receives the canonical snapshot, materialises a normal local `.canvas` file,
   saves its local room association, and then joins the child room. Roles are
   inherited from the parent and are rechecked by the server, including during
   an already-open child WebSocket session. Top-level cards, Column children,
   Kanban items, Calendar notes, and decorated Calendar days all persist the
   child identifier. Ordinary Tile-card board targets use the same child-room
   mechanism, including boards created directly from the Tile editor. The
   hardened tree layer gives creation a stable idempotency key, resolves room
   IDs back to each installation's own vault path, supports navigation to both
   descendants and ancestors, shows the complete hierarchy in room management,
   exports the whole tree, and recursively deletes hosted descendants while
   leaving local Canvas files untouched.
11. **Commercial layer.** Entitlements and billing sit around hosted rooms, not
   around local editing or the Canvas serializer. Decide limits only after
   measuring connection minutes, stored history, bandwidth, and support cost.
12. **Hardening.** Multi-client simulation, dropped/duplicated/out-of-order
   operation tests, schema migrations, load tests, security review, backups,
   retention controls, and iPad/manual network-loss testing.
13. **Production authentication preparation — server verifier complete.** Every HTTP,
   asset and WebSocket entry point now passes through one server authenticator.
   Development mode retains the loopback token workflow, rejects an empty
   token, refuses a non-loopback bind using the well-known default token, and
   fails closed on incomplete or insecure OIDC configuration. Production mode
   discovers the provider's JWKS, verifies JWT signature/algorithm, exact issuer,
   audience, expiry and optional required scope, and binds room membership to
   the verified issuer+subject rather than a client-supplied device ID. Health
   and readiness endpoints expose the selected mode but no credentials. The
   account/session design and threat model live in
   `docs/production-collaboration-security.md`.
14. **Native browser sign-in foundation — complete behind the experiment.** The
   plugin now discovers an HTTPS OIDC provider, opens Authorization Code + PKCE
   sign-in in the browser, and accepts a one-use `obsidian://visual-notes-auth`
   callback protected by exact state matching and a ten-minute deadline. It
   stores an installation-local session, refreshes access tokens early,
   preserves refresh-token rotation, coalesces simultaneous refresh attempts,
   and clears the session on sign-out. Room HTTP requests, assets, initial
   WebSocket joins and reconnects all obtain the current account token through
   one provider. Development-token mode remains the default and is unaffected.
   The account configuration, controls, and locally stored sessions are removed
   from the experimental private-network release UI. Before any hosted release, choose/configure
   the hosted provider, validate its custom-scheme callback on desktop and iPad,
   and replace localStorage refresh-token persistence with an approved secure
   storage or hosted token-broker design.
15. **Account room discovery and persistence boundary — complete foundation.**
   An authenticated account can list its root rooms and register a fresh device
   against an existing account membership without copying an old vault's room
   bearer token. The server refuses room-ID probing by unrelated accounts and
   returns only validated summaries. Room JSON and content-addressed asset bytes
   now sit behind independent document/blob interfaces; the local adapters keep
   atomic replacement, deduplication and ranged video streams. This is the seam
   for Postgres and S3-compatible staging adapters. The private provider choice,
   secret inventory and deployment order live in `docs/staging-hosting-plan.md`.

16. **Provider-neutral private-network boundary — foundation complete.** A
   separate Private network transport uses the installation-local participant
   identity and never requests an Auth0/OIDC session. Physical LAN, Tailscale,
   ZeroTier, WireGuard, Headscale and other networks all reduce to a private
   WebSocket endpoint; Tailscale is a guided test target, not a dependency.
   Versioned invitations carry the private endpoint, a high-entropy server
   access secret and the room-scoped invitation, while legacy room codes remain
   valid in hosted-development mode. Cloud authentication stays implemented
   behind the separate Development WebSocket path for future staging work.
17. **Automatic desktop private host — implementation complete and manually
   verified on Windows/Tailscale.** The release build embeds a standalone server artifact inside
   `main.js`, so Obsidian's three-file plugin distribution remains sufficient.
   Desktop users can select a detected RFC1918, Tailscale CGNAT, link-local or
   private IPv6 interface and start/stop the host without Node, npm, PowerShell
   or Docker. The embedded CommonJS server runs inside Obsidian's desktop Node
   context (Electron child mode and worker threads are unavailable in supported
   Obsidian builds), receives a generated high-entropy secret,
   writes room data beneath `.obsidian/visual-notes-collaboration`, reports
   readiness before the UI calls it running, and is stopped when the plugin
   unloads. Mobile remains join-only. Manual testing must cover Windows
   Firewall consent, host sleep/restart, Tailscale direct/relayed connections,
   port conflicts and clean shutdown before this is release-ready.

## Next engineering milestone

The next code milestone needs private staging provider configuration: implement
Postgres and S3-compatible adapters against the new persistence interfaces,
then add rate limiting, structured observability, backup/restore and a Render
staging deployment. Billing still comes later; first prove desktop/iPad sign-in,
convergence, reconnect and recovery against staging while the three-way file
merge remains the final safety net.
