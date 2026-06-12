# Missile Wars Backend Coordinator

Central coordinator service for the distributed/community-hosted Missile Wars
backend network.

This server is the control plane. It does not run live gameplay loops. Community
servers connect to it so players can discover trusted servers, sign in once, and
then connect to the server they want to play on.

## Core idea

- The coordinator knows about every registered community server.
- The coordinator owns global auth, account identity, server discovery, and trust.
- Community servers own their own databases, gameplay state, push-notification
  requests, moderation, and local game operations.
- Users sign in through the coordinator, then choose or are routed to a community
  server.

## Planned responsibilities

- User login, registration, OAuth login, token refresh, and password reset.
- Server registry for community/shared servers.
- Server health checks and heartbeat tracking.
- Server discovery so users can pick a server manually or use a best-server flow.
- Public JWT key publishing through JWKS.
- Issuing short-lived, shard-scoped auth tokens for selected servers.
- Push-notification relay so community servers do not need Firebase admin
  secrets.
- Admin tools for approving, delisting, rotating, or disabling servers.

## What this server should not do

- It should not store live gameplay state.
- It should not own a community server's local game database.
- It should not be in the hot path for WebSocket gameplay.
- It should not give community servers Firebase admin credentials, email
  credentials, or JWT signing keys.

## Related docs

- [PLAN.md](PLAN.md) - implementation plan for this coordinator repo.
- [CLAUDE.md](CLAUDE.md) - guidance for AI/code agents working in this repo.
