# CLAUDE.md

This file provides guidance to Claude Code and other AI coding agents when
working in this repository.

## What this is

This repo is the Missile Wars backend coordinator. It is the central control
plane for a distributed/community-hosted backend network.

The coordinator should know about all community servers, run global auth, publish
public JWT verification keys, issue short-lived server-scoped tokens, and relay
services that require protected global secrets, such as Firebase push.

It should not run live gameplay. Gameplay, WebSockets, local player state, local
databases, and local moderation belong to community servers.

## Current state

This repo is currently documentation/scaffold only. Before adding application
code, read `PLAN.md` and preserve the control-plane/data-plane split.

## Architecture rules

- Coordinator signs tokens; community servers verify tokens.
- Coordinator may hold Firebase, email, and JWT private-key secrets.
- Community servers must never receive Firebase admin credentials, email
  credentials, or JWT signing private keys.
- Community servers have their own local databases.
- User identity is global; gameplay state is per community server.
- The frontend signs in with the coordinator, then connects directly to the
  selected community server for gameplay.

## Preferred implementation direction

Use a small TypeScript HTTP API. Keep the first implementation boring and easy
to deploy.

Good default stack:

- TypeScript
- Hono, Express, or Fastify
- Prisma
- PostgreSQL
- `jose` for JWT/JWKS handling
- `zod` for request and environment validation

If a framework has already been chosen in this repo, follow the existing choice
instead of introducing another one.

## Planned commands

When code exists, prefer scripts with these names:

```bash
npm run dev
npm run build
npm start
npm run typecheck
npm run lint
npx prisma generate
npx prisma migrate dev
```

Do not invent deployment scripts until the hosting target is confirmed.

## Environment and secrets

Expected coordinator-only secrets:

- `DATABASE_URL`
- JWT signing private key
- Firebase admin credentials
- Email/SMTP credentials
- Admin API key

Never print secrets in logs or examples. Use `.env.example` with placeholder
values only.

## API conventions

Use clear route groups:

- `/auth/*` for user login, registration, refresh, and server selection.
- `/servers/*` for public server discovery.
- `/shards/*` for community-server authenticated calls.
- `/admin/*` for coordinator admin actions.
- `/.well-known/jwks.json` for public JWT keys.

Prefer JSON responses shaped like:

```json
{
  "ok": true,
  "data": {}
}
```

For errors:

```json
{
  "ok": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message"
  }
}
```

## Data model guidance

Start with:

- `User`
- `Shard`
- `ServerSelection` or `ServerSession`
- `PushRelayLog`

Store shard API keys as hashes only. Show raw API keys once at creation time.

## Auth guidance

User-facing auth should happen at the coordinator.

Community server tokens should be:

- Signed by the coordinator.
- Short-lived.
- Scoped to one server via the `aud` claim.
- Verifiable by community servers using the coordinator JWKS endpoint.

Avoid using mutable username as the primary identity. Prefer stable ids such as
Firebase UID or an internal user id.

## Integration with existing repos

The current gameplay backend lives in `../backend`.

Important files there:

- `../backend/util/auth.ts`
- `../backend/server-routes/authRoutes.ts`
- `../backend/server-routes/notificaitonApi.ts`
- `../backend/runners/NotificationService.ts`
- `../backend/server.ts`

The frontend lives in `../frontend`. It will eventually call this coordinator
for auth and server discovery, then send gameplay calls to the chosen community
server.

Shared message contracts live in `../middle-earth`.

## First milestone

Build the smallest useful coordinator before moving risky auth code:

1. `GET /health`
2. Register a community server.
3. Accept authenticated heartbeats.
4. Return active servers from `GET /servers`.
5. Issue a temporary server-scoped token for a selected server.

After that works, move Firebase/auth routes from the gameplay backend into this
repo.
