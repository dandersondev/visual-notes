# Internal development collaboration server

This package is an unreleased development tool. It is not production hosting,
does not implement real accounts, and must not be exposed directly to the
public internet.

## Start locally

From the plugin repository root:

```powershell
npm run collab:build
$env:VISUAL_NOTES_COLLAB_TOKEN='choose-a-development-token'
npm run collab:start
```

Defaults:

- WebSocket: `ws://127.0.0.1:8787`
- Health check: `http://127.0.0.1:8787/health`
- Room files: `collaboration-server/.data/`
- Development token when the environment variable is absent:
  `visual-notes-local-dev`

Optional environment variables:

```text
VISUAL_NOTES_COLLAB_HOST
VISUAL_NOTES_COLLAB_PORT
VISUAL_NOTES_COLLAB_AUTH_MODE
VISUAL_NOTES_COLLAB_TOKEN
VISUAL_NOTES_COLLAB_OIDC_ISSUER
VISUAL_NOTES_COLLAB_OIDC_AUDIENCE
VISUAL_NOTES_COLLAB_OIDC_REQUIRED_SCOPE
VISUAL_NOTES_COLLAB_DATA
VISUAL_NOTES_COLLAB_MAX_PAYLOAD
VISUAL_NOTES_COLLAB_MAX_ASSET
VISUAL_NOTES_COLLAB_MAX_VIDEO_ASSET
VISUAL_NOTES_COLLAB_MAX_ROOM_ASSETS
VISUAL_NOTES_COLLAB_ASSET_GRACE_MS
VISUAL_NOTES_COLLAB_TICKET_TTL_MS
```

`VISUAL_NOTES_COLLAB_AUTH_MODE` accepts `development` (the default) or `oidc`.
OIDC mode requires an HTTPS issuer and audience, uses provider discovery/JWKS,
and can optionally require one access-token scope. Incomplete or insecure
configuration fails at startup rather than falling back to development auth.
`VISUAL_NOTES_COLLAB_ALLOW_INSECURE_OIDC=1` permits an HTTP loopback issuer only
for automated tests and must never be deployed.

Development mode refuses a non-loopback host when the default token is in use.
Set a strong explicit token for controlled LAN/TLS tests. The
`VISUAL_NOTES_COLLAB_ALLOW_INSECURE_DEVELOPMENT=1` escape hatch exists only for
isolated testing and must never appear in a hosted deployment.

`GET /health` is a liveness check. `GET /ready` checks the data directory and,
in OIDC mode, provider discovery. Both report the authentication mode but never
return issuer details, tokens, room data, or other credentials.

Keep the host at `127.0.0.1` for normal development. Binding to a LAN address
is only appropriate for a controlled multi-device test network; the shared
development token is not production authentication.

## Connect the plugin

1. Enable **Experimental collaboration** in Visual Notes settings.
2. Select **Development WebSocket** as the experimental transport.
3. Set the URL to `ws://127.0.0.1:8787`.
4. Enter the same development token used by the server.
5. Reopen the board.
6. Use **Create room** on the first board, copy its invite code, then use
   **Join room** on the second board.

For two desktop Obsidian processes, use two installations/vaults and give each
installation a different collaborator name. Private rooms use a server-issued
room ID, so the vault names and board paths do not need to match. The
installation-local room association is kept in localStorage rather than in
the canvas file; leaving a room removes that association without deleting the
hosted room.

Creating a room now establishes a persisted owner membership and generates
separate editor and viewer invitations. Redeeming an invitation issues a
room-scoped access token bound to that vault's collaboration client ID. The
server enforces roles on every published operation; owners can replace either
invite or remove an existing member. Replacing an invite invalidates the old
code for future joins, while removing a member disconnects them and revokes
their saved access token.

These are room memberships, not production user accounts. The development
token is still a temporary server-administration gate, and access tokens are
stored in installation-local plugin storage. A hosted release still needs a
real sign-in provider, account recovery, secure token storage/rotation, audit
logging, and abuse controls.

Rooms created by the earlier single-invite prototype do not contain membership
records and must be recreated for role testing.

For another physical device on the LAN, bind the development server to the
computer's private LAN or overlay-network address and set a unique, high-entropy
`VISUAL_NOTES_COLLAB_TOKEN`. Select **Private network** in the plugin and enter
that same address and secret. This mode accepts unencrypted `ws://` only for
loopback, RFC1918/link-local addresses, Tailscale's `100.64.0.0/10` range,
private IPv6, `.local`, and `.ts.net`; the physical LAN or VPN is responsible
for transport protection. Public endpoints must use `wss://`.

Private-network invitations contain the server address, server secret, and
room invitation in a versioned envelope. Treat the complete invitation like a
password. It contains no VPN account, VPN key, or provider credential. The
recipient must already be connected through the chosen LAN/VPN provider.

## Persistence and reset

Every room is stored as an atomically replaced JSON file named by a SHA-256
hash of its room ID. It contains the canonical board snapshot, server sequence,
logical clock, and accepted operation IDs/log. Presence is never persisted.

Shared raster images are stored once by SHA-256 under `.data/assets/`; room
JSON stores only that room's authorization metadata for those hashes. The
default per-image limit is 20 MB and can be changed with
`VISUAL_NOTES_COLLAB_MAX_ASSET` (bytes). PNG, JPEG, GIF, WebP, and AVIF are
accepted; SVG is intentionally excluded from this first security boundary.

MP4 and WebM video cards use the same content-addressed store, with a separate
250 MB default controlled by `VISUAL_NOTES_COLLAB_MAX_VIDEO_ASSET`. Playback
uses short-lived room-scoped tickets (four hours by default, controlled by
`VISUAL_NOTES_COLLAB_TICKET_TTL_MS`) and standard HTTP byte ranges. Permanent
room access tokens are never placed in media URLs, and membership is checked
again for every streamed request.

Each room also has a 2 GB shared-media allowance by default, configured with
`VISUAL_NOTES_COLLAB_MAX_ROOM_ASSETS`. The server counts deduplicated assets
registered to that room and rejects a new upload before storing it when the
limit would be exceeded. The owner management response reports used and limit
bytes; a richer storage-management UI belongs to the cleanup milestone.

## Test shared images

1. Restart the development server after rebuilding it.
2. Open the joined room in two vaults with sync disabled.
3. In vault A, drag a PNG, JPEG, or WebP image onto the canvas. It should
   appear in vault B after a short loading state even though the file does not
   exist there.
4. Add the same image as a Storyboard shot background and confirm it renders
   in the card, playback, and editor in vault B.
5. Close and reopen vault B's board. The images should download again and
   render; the cache is intentionally memory-only.
6. Join with a viewer invite. Existing images should render, while viewer
   edits and uploads remain blocked.

## Test shared video

1. Use a small MP4 or WebM whose codec already plays in Obsidian.
2. Drag it into vault A's joined board and wait for the card to appear in
   vault B after the **Loading shared video…** state.
3. Play, pause, seek near the end, mute, and enter fullscreen in vault B.
4. Confirm seeking starts promptly rather than waiting for a full-file
   download.
5. Reopen vault B's board and repeat playback to exercise a fresh ticket.
6. Confirm a viewer can play the video but cannot add one.

During image or video upload, the collaboration bar shows preparation followed
by transferred percentage. **Cancel** aborts the active HTTP request and leaves
the local card intact; **Retry** starts sharing that still-local media again.
Room owners can open **Manage** to see deduplicated shared-media usage against
the configured room allowance.

## Test collaborative nested boards

1. Rebuild and restart the development server, then reload the plugin in both
   test vaults. Open the same parent room in both vaults with sync disabled.
2. In vault A, use a card's context menu to create a nested board. The source
   card should gain its normal nested-board chip and vault B should receive it.
   Also create a Tile whose type is **Visual Notes board**; its board target
   should follow the same hosted-child flow.
3. Click that chip in vault B. Even though the `.canvas` file does not exist in
   that vault yet, Visual Notes should create it at the linked vault-relative
   path, open it, and show **Development server** with both collaborators.
4. Add and move cards inside the child board from each vault. Changes should
   appear live in the other vault just as they do in the parent.
5. Repeat with nested links created from a Column child, a Kanban item, a
   Calendar note, and a decorated Calendar day.
6. Test adoption: create a local nested board before the parent joins a room,
   then join the parent and click the existing nested link in vault A. The first
   open should register it as a hosted child; vault B should then materialise
   and join that same child when its chip is clicked.
7. Join the parent with a viewer invite. The viewer should be able to open the
   child and see live changes, but edits in both parent and child must remain
   blocked.
8. Remove an editor from the parent while their child board is open. The child
   session should disconnect and a later attempt to reopen it should fail.
9. Create a child inside that child. Confirm both vaults can traverse parent →
   child → grandchild and use the seeded **Parent board** tile to travel upward,
   even when the parent board uses a different local path in each vault.
10. Open **Manage** as the owner. The Board tree section should show all three
    levels. Export JSON should contain a `tree` array with every canonical board.
11. In a disposable room tree, delete the hosted parent. Every open descendant
    session should disconnect and none of the hosted rooms should reopen, while
    all local `.canvas` files remain present.

Each child remains an ordinary local `.canvas` file. The parent board stores a
child room identifier beside the vault-relative path, but never an access token.
Room credentials stay installation-local. Room-aware links resolve that ID to
the path already associated with the board in each vault, so the two vaults do
not need to use matching paths.

## Asset lifecycle

Deleting the last board reference does not immediately delete shared media.
The room marks it recoverable for seven days by default; configure the window
in milliseconds with `VISUAL_NOTES_COLLAB_ASSET_GRACE_MS`. Undoing the deletion
or otherwise restoring the shared reference clears the orphan marker.

After the grace window, the owner can use **Manage → Clean up**. Cleanup first
removes the expired registration from that room, then scans every persisted
room before deleting the content-addressed file. A file used by another room
is retained. **Export JSON** downloads the canonical board and asset manifest,
without credentials or media bytes. **Delete hosted room** requires explicit
confirmation, disconnects members, removes hosted room state, and preserves
the local Canvas in every vault.

To reset development rooms, stop the server and remove only the explicit
`collaboration-server/.data/` directory. Never point
`VISUAL_NOTES_COLLAB_DATA` at a vault or broad user directory.

## Before production hosting

- Replace the shared development administration token with real account auth.
- Exchange room access credentials for short-lived, refreshable session tokens.
- Add operation-log compaction and retained snapshots.
- Add quotas, rate limits, structured logs, metrics, backups, and deletion.
- Move room coordination to the selected production runtime.
- Complete a security review and separate staging/production data.
