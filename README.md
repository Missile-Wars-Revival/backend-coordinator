# Missile Wars Backend Coordinator

Central control plane for the distributed/community-hosted Missile Wars backend
network.

The coordinator is the small trusted service that knows which community shards
exist, which ones are verified, which ones are online, and which public key
players/shards should use for coordinator-issued JWTs. It does not run gameplay
loops, hold a gameplay database, or sit in the hot path for WebSocket play.

The canonical distributed-hosting design lives in
[`../backend/DISTRIBUTED_HOSTING_PLAN.md`](../backend/DISTRIBUTED_HOSTING_PLAN.md).
This repo implements the coordinator side of that plan.

## Responsibilities

- Register community shards and issue a shard-scoped API key once.
- Record shard heartbeats, status, player count, version, and verified state.
- Serve public server discovery through `GET /servers` and `GET /servers/best`.
- Mint short-lived RS256 shard JWTs with `aud` locked to one shard.
- Publish the JWT verification key at `/.well-known/jwks.json`.
- Verify Firebase ID tokens for shards that do not have Firebase Admin creds.
- Relay Expo push notifications without exposing player push tokens to shards.
- Provide a simple admin portal at `/admin` for verification, disabling, and
  shard API key rotation.

## Non-goals

- No Prisma, SQL, Neon, or shard gameplay database in this repo.
- No live gameplay state.
- No WebSocket gameplay proxying.
- No Firebase Admin credentials, email credentials, or JWT signing private keys
  are ever given to community shard hosts.

## Architecture

```
Expo app -> coordinator: discover servers, select server, refresh tokens
Expo app -> selected shard: gameplay REST + WebSocket

Community shard -> coordinator: register, heartbeat, mint token, verify ID token, relay push

Coordinator -> Firebase RTDB: /coordinator/* registry/session state
Coordinator -> Firebase Auth: ID token verification
Coordinator -> Expo Push: push delivery
```

Coordinator state is stored in Firebase Realtime Database under
`/coordinator/*`. When Firebase credentials are not configured, local
development falls back to an in-memory store. That fallback is volatile and must
not be used for production.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create environment

Create `backend-coordinator/.env`:

```env
NODE_ENV=development
PORT=3000

# Public URL of this coordinator. Used as the JWT issuer claim.
COORDINATOR_PUBLIC_URL=http://localhost:3000

# Generate with: npm run generate-keys
JWT_PRIVATE_KEY_BASE64=...
JWT_PUBLIC_KEY_ID=coordinator-key-1
TOKEN_TTL_HOURS=12

# Required for /admin and /admin/api/*
ADMIN_API_KEY=replace-with-a-random-32-byte-value

# Required for real coordinator storage, Firebase Auth verification, and push relay.
# If omitted, /health and local shard registration work against in-memory state only.
FIREBASE_PROJECT_ID=missile-wars-432403
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-...@missile-wars-432403.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_DATABASE_URL=https://missile-wars-432403-default-rtdb.firebaseio.com

# Shards with older heartbeats are hidden from discovery.
STALE_HEARTBEAT_SECONDS=120

# After 5-10 missed 30s heartbeat windows, active shards are marked offline.
SHARD_HEARTBEAT_INTERVAL_SECONDS=30
OFFLINE_AFTER_MISSED_HEARTBEATS=5
```

Generate the RS256 signing key:

```bash
npm run generate-keys
```

Copy the printed `JWT_PRIVATE_KEY_BASE64=...` value into `.env` or the Vercel
environment. The public key is derived automatically and served through JWKS.

For `ADMIN_API_KEY`, use a long random value:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Run locally

```bash
npm run dev
```

Health check:

```bash
curl http://localhost:3000/health
```

Build/type check:

```bash
npm run build
npm run typecheck
```

Start the compiled server:

```bash
npm start
```

## Firebase RTDB rules

Security rules live in [`rtdbrules.json`](rtdbrules.json). Deploy or merge them
into the Firebase project before using the coordinator for real traffic.

The important rule is that `/coordinator/*` is not client-readable or
client-writable. Only the Admin SDK, running inside this service, should touch
that state. The same rules file also includes the planned global social paths:
`/profiles`, `/friends`, `/friendRequests`, `/notificationPreferences`,
`/notificationTokens`, plus existing chat paths.

## Deploying to Vercel

This repo has a Vercel serverless entrypoint in [`api/index.ts`](api/index.ts).
[`vercel.json`](vercel.json) rewrites all routes to that entrypoint, and Express
handles routing.

Set the same environment variables from the setup section in Vercel, with:

- `COORDINATOR_PUBLIC_URL` set to the deployed HTTPS URL.
- `JWT_PRIVATE_KEY_BASE64` copied from `npm run generate-keys`.
- `ADMIN_API_KEY` set to a long secret.
- `FIREBASE_*` set from the Firebase service account and RTDB URL.

Then deploy with the Vercel CLI or the connected Git integration.

## Common flows

### Register a shard

Shard names are unique after coordinator normalization, so `Official Main`,
`official main`, and similar punctuation/spacing variants cannot be registered
twice. To check before registering:

```bash
curl "http://localhost:3000/shards/name-available?name=Official%20Main"
```

```bash
curl -X POST http://localhost:3000/shards/register \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Local Test Shard",
    "region": "local",
    "publicHttpUrl": "http://localhost:8080",
    "publicWsUrl": "ws://localhost:8080",
    "ownerContact": "you@example.com"
  }'
```

`ownerContact` must be a real email address. The response includes `shardId`
and `apiKey`. Save the API key immediately; only its hash is stored. In the
shard backend `.env`, set:

```env
COORDINATOR_URL=http://localhost:3000
SHARD_API_KEY=mw_shard_...
SHARD_ID=...
```

The one-click shard launcher in `../backend/docker/host.sh` and
`../backend/docker/host.ps1` can do this registration interactively.

### Send a heartbeat

```bash
curl -X POST http://localhost:3000/shards/heartbeat \
  -H "Authorization: Bearer mw_shard_..." \
  -H "Content-Type: application/json" \
  -d '{ "playerCount": 0, "version": "dev", "gitSha": "local" }'
```

The first valid heartbeat moves a shard from `pending` to `active`. Discovery
only returns active shards with fresh heartbeats.

### List public servers

```bash
curl http://localhost:3000/servers
curl "http://localhost:3000/servers/best?lat=51.5&lon=-0.1"
```

### Open the admin portal

Go to:

```text
http://localhost:3000/admin
```

Paste `ADMIN_API_KEY` into the page. From there you can verify/unverify, disable
or enable shards, and rotate a shard API key.

The same admin actions are available under `/admin/api/*` with either:

```text
Authorization: Bearer <ADMIN_API_KEY>
```

or:

```text
X-Admin-Key: <ADMIN_API_KEY>
```

## Route summary

- `GET /health` - service health.
- `GET /.well-known/jwks.json` - public JWT verification key.
- `GET /shards/name-available?name=` - check whether a shard name is unused.
- `POST /shards/register` - open shard registration; returns API key once; rejects duplicate names.
- `POST /shards/heartbeat` - shard-authenticated heartbeat.
- `GET /servers` - public list of online shards.
- `GET /servers/best?lat=&lon=` - nearest verified/least-loaded shard selection.
- `POST /auth/shard-token` - shard-authenticated token minting.
- `POST /auth/verify-id-token` - shard-authenticated Firebase ID token verify.
- `POST /auth/refresh` - refresh a still-valid coordinator-issued shard token.
- `POST /auth/select-server` - client flow using a Firebase ID token.
- `POST /relay/push` - shard-authenticated Expo push relay.
- `GET /admin` and `/admin/api/*` - admin portal and admin API.

## Related repos

- `../backend` - community shard/backend gameplay server.
- `../backend/DISTRIBUTED_HOSTING_PLAN.md` - source-of-truth plan.
- `../frontend` - Expo app with server discovery and shard picker.
- `../middle-earth` - shared message/type contract.
