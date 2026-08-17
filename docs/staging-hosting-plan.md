# Staging hosting plan for a possible future hosted service

> **Nothing in this document is built, deployed, or running.** It is an
> exploratory sketch of what a hosted Visual Notes collaboration service
> *could* look like, kept in the repo so the reasoning is not lost.
>
> **What actually ships today is private-network collaboration only**, described
> in the [README](../README.md). Visual Notes operates no collaboration cloud,
> creates no accounts, and receives no room data. There is no Auth0 tenant, no
> Supabase project, and no Render service associated with this plugin. If a
> hosted option is ever built, it will be opt-in, announced in the changelog,
> and documented before anyone can connect to it.

## Recommended first staging stack

Use three managed services, each for one job:

1. **Auth0 Free — accounts and browser login.** Create a Native application and
   a Visual Notes API audience. Auth0 supplies hosted Universal Login, standard
   OIDC discovery/JWKS, Authorization Code + PKCE, refresh tokens and a public
   client ID. Register the exact callback `obsidian://visual-notes-auth`. Never
   create or place a client secret in the plugin.
2. **Supabase Free — Postgres and shared-media object storage.** Use one private
   staging project. The collaboration server connects through Supavisor session
   mode and uses server-only S3-compatible Storage credentials. The plugin never
   receives the database password, service-role key or S3 secret.
3. **Render Free initially — Node/WebSocket staging runtime.** Deploy the private
   collaboration-server workspace as one Web Service with `GET /ready` as its
   health check. Render terminates TLS, so the plugin uses `wss://`. Free is
   suitable only for the first private test: it sleeps after inactivity and can
   take roughly a minute to wake. Move to a paid always-on instance before any
   external beta.

This split is deliberate. Auth0 avoids building and hosting a login/consent
website just to test accounts. Supabase keeps database and media in one project.
Render runs the existing long-lived Node WebSocket process without redesigning
it around a serverless runtime.

## Code/configuration still required after accounts exist

- Implement the Postgres `RoomDocumentStore` adapter and migrations.
- Implement the Supabase S3 `AssetBlobStore` adapter, including ranged reads.
- Select adapters only when all required environment variables are present;
  production must never fall back to local files.
- Configure the Auth0 issuer/audience and test the Obsidian callback on desktop
  and iPad.
- Add request/account rate limits, structured redacted logs and shutdown
  handling.
- Add staging backup/restore and deletion tests before inviting anyone else.
- Resolve refresh-token secure storage. Installation-local browser storage is
  acceptable only for this private experiment, not public release.

## Secrets and non-secrets

Safe to put in plugin settings/build configuration:

- Auth0 issuer/domain
- Auth0 public Native application client ID
- Visual Notes API audience/scope
- public `wss://` collaboration URL

Server-only Render secrets:

- Postgres connection string
- Supabase Storage S3 access key and secret
- Auth0 issuer/audience configuration (not secret, but authoritative server config)
- any future session-signing or webhook secrets

## Creation order

1. Create a free Auth0 tenant, Native application and API.
2. Prove browser sign-in returns to Obsidian on desktop and iPad.
3. Create a free Supabase staging project and private Storage bucket.
4. Implement/test the hosted persistence adapters locally against staging.
5. Create a private Render Web Service and add environment secrets.
6. Run two-device convergence, reconnect, media, nested-board, deletion and
   restore tests. Only then consider a paid always-on instance or outside beta.

Official references checked 2026-08-16:

- https://auth0.com/pricing
- https://auth0.com/docs/manage-users/sessions
- https://supabase.com/docs/guides/database/connecting-to-postgres
- https://supabase.com/docs/guides/storage/s3/authentication
- https://render.com/docs/websocket
- https://render.com/docs/free
- https://render.com/docs/configure-environment-variables
