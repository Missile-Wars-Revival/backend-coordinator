# Backend Coordinator Plan

## Goal

Build the main coordinator server for the distributed Missile Wars backend.

All community/shared servers connect to this coordinator. The coordinator knows
which servers exist, handles global user authentication, and lets users choose
which community server they want to connect to. Community servers still run their
own databases and local game systems.

Short version:

- Coordinator = auth, identity, server registry, discovery, trust, token minting.
- Community server = local DB, gameplay, WebSockets, local moderation, push
  notification requests, local operations.
- Frontend = signs in with coordinator, then connects directly to the chosen
  community server.

## System shape

```text
Frontend app
  |
  | login/register/discover servers
  v
Coordinator server
  - knows all registered community servers
  - owns global auth and account identity
  - issues short-lived tokens for selected servers
  - publishes public JWT verification keys
  - receives heartbeats from community servers
  - relays push notifications
  |
  | selected server URL + scoped auth token
  v
Community server
  - has its own database
  - runs gameplay and WebSockets
  - stores local world/player state
  - sends heartbeat/load info to coordinator
  - asks coordinator to relay push notifications
```

## Important design decisions

### Central auth, distributed data

The coordinator runs auth for the network. A user should have one global account
identity, then choose which server to play on.

Each community server has its own database and local game world. This keeps live
gameplay fast because the WebSocket and Prisma/database hot path stay local to
that server.

### Coordinator knows every community server

Every community/shared server must register with the coordinator before it can be
shown to users.

The coordinator should track:

- Server id
- Public name
- Region or approximate location
- Public API/WebSocket URL
- Owner/admin contact
- API key hash
- Last heartbeat time
- Current player count
- Version/build hash
- Status: pending, active, disabled, outdated, offline

### Community servers do not get global secrets

Community servers should never receive:

- Firebase admin credentials
- Email credentials
- JWT signing private keys
- A shared production database URL

They may hold:

- Their own local database credentials
- A revocable server API key
- Public JWT verification keys

### Users can pick a server

The frontend should support both:

- Manual server selection from a coordinator-provided list.
- Automatic selection using region, load, health, and version compatibility.

The chosen server should be persisted locally so the app reconnects to the same
community unless the server becomes unavailable.

## API plan

### Public/user endpoints

- `GET /health`
  - Basic coordinator health check.

- `GET /servers`
  - Return active community servers that users are allowed to choose.

- `GET /servers/best?lat=&lon=`
  - Return a recommended community server based on region, load, health, and
    compatibility.

- `POST /auth/register`
  - Create or link a global account.

- `POST /auth/login`
  - Verify Firebase/OAuth credentials and return coordinator session data.

- `POST /auth/oauth-login`
  - OAuth login flow for mobile clients.

- `POST /auth/refresh`
  - Refresh coordinator/session tokens.

- `POST /auth/select-server`
  - Given a server id, issue a short-lived token scoped to that community server.

- `GET /.well-known/jwks.json`
  - Publish public JWT verification keys for community servers.

### Community server endpoints

- `POST /shards/register`
  - Register a new community server and issue a server API key once.

- `POST /shards/heartbeat`
  - Server-authenticated heartbeat with version, player count, load, and status.

- `POST /shards/relay/push`
  - Server-authenticated push notification relay.

- `POST /shards/token/verify`
  - Optional debugging endpoint for verifying scoped auth tokens.

### Admin endpoints

- `GET /admin/shards`
  - View all registered servers, including pending/offline/disabled.

- `POST /admin/shards/:id/approve`
  - Approve a registered server.

- `POST /admin/shards/:id/disable`
  - Disable a server so users cannot connect through discovery.

- `POST /admin/shards/:id/rotate-key`
  - Rotate a community server API key.

- `POST /admin/jwt/rotate`
  - Rotate coordinator signing keys.

## Data model draft

### User

- `id`
- `firebaseUid`
- `username`
- `email`
- `createdAt`
- `updatedAt`
- `lastLoginAt`
- `status`

### Shard

- `id`
- `name`
- `description`
- `region`
- `publicHttpUrl`
- `publicWsUrl`
- `ownerName`
- `ownerContact`
- `apiKeyHash`
- `status`
- `version`
- `gitSha`
- `playerCount`
- `maxPlayers`
- `lastHeartbeatAt`
- `createdAt`
- `updatedAt`

### ServerSession or ServerSelection

- `id`
- `userId`
- `shardId`
- `issuedAt`
- `expiresAt`
- `lastUsedAt`

### PushRelayLog

- `id`
- `shardId`
- `targetUserId`
- `type`
- `status`
- `createdAt`

## Token model

The coordinator signs tokens. Community servers only verify tokens.

Recommended user token claims:

- `sub`: stable user id or Firebase UID
- `username`: display/current username
- `aud`: selected community server id
- `iss`: coordinator URL
- `exp`: short expiry
- `iat`: issued-at timestamp
- `scope`: permissions, for example `play:server`

Community servers must reject tokens if:

- Signature is invalid.
- Token is expired.
- `aud` does not match the server's own id.
- Issuer does not match the configured coordinator.

## Implementation phases

### Phase 1 - Repo scaffold

- [ ] Choose framework/runtime.
- [ ] Add package scripts for dev, build, start, lint, and type-check.
- [ ] Add environment variable validation.
- [ ] Add `GET /health`.
- [ ] Add database setup and migrations.
- [ ] Add structured logging.

### Phase 2 - Server registry

- [ ] Add `Shard` data model.
- [ ] Add shard registration flow.
- [ ] Store only hashed server API keys.
- [ ] Add heartbeat endpoint.
- [ ] Add active server list endpoint.
- [ ] Add stale/offline detection.

### Phase 3 - Auth and token minting

- [ ] Move login/register/oauth-login/password reset from the current backend.
- [ ] Verify Firebase tokens here.
- [ ] Generate asymmetric signing keys.
- [ ] Serve public keys through JWKS.
- [ ] Add server-scoped token issuing.
- [ ] Document token claims for community servers.

### Phase 4 - Push relay

- [ ] Move Firebase Admin credentials to coordinator only.
- [ ] Add server-authenticated push relay endpoint.
- [ ] Rate-limit push relay by server and by user.
- [ ] Log relay attempts without storing sensitive payloads.

### Phase 5 - Frontend and community server integration

- [ ] Frontend points login/register at coordinator.
- [ ] Frontend fetches server list from coordinator.
- [ ] Frontend lets users pick a server.
- [ ] Frontend sends gameplay REST/WebSocket traffic to selected server.
- [ ] Community server verifies coordinator-issued tokens with JWKS.
- [ ] Community server sends heartbeats to coordinator.
- [ ] Community server sends push requests through coordinator.

## Environment variables draft

```env
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://user:password@localhost:5432/misswars_coordinator

COORDINATOR_PUBLIC_URL=http://localhost:3000

JWT_ISSUER=http://localhost:3000
JWT_PRIVATE_KEY_BASE64=
JWT_PUBLIC_KEY_ID=local-dev-key-1

FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=

EMAIL_HOST=
EMAIL_PORT=587
EMAIL_SECURE=false
EMAIL_USER=
EMAIL_PASS=
EMAIL_FROM=

ADMIN_API_KEY=
```

## Open decisions

- Framework: Hono, Express, Fastify, or Next.js API routes.
- Database host: Neon for production, local Postgres for development.
- Key algorithm: RS256 for broad support or Ed25519 for smaller/faster tokens.
- Server admission: open public registration, invite-only, or admin approval.
- Chat model: global Firebase chat or per-server chat.
- Whether friends/economy stay global later or remain per-community.
- Exact token lifetime and refresh cadence.

## First build target

The first useful version should do only this:

1. Start a coordinator server.
2. Register a community server.
3. Accept heartbeats from that server.
4. Return that server from `GET /servers`.
5. Issue a placeholder server-scoped token for a selected server.

That proves the shape before moving the risky auth code.
