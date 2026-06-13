# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
the Missile Wars backend coordinator.

## What this is

`backend-coordinator` is the trusted control plane for the distributed Missile
Wars backend network. It is an Express + TypeScript app deployed locally with
Node or on Vercel through `api/index.ts`. It stores coordinator state in
Firebase Realtime Database, verifies Firebase Auth ID tokens, mints RS256 shard
JWTs, publishes JWKS, tracks registered community shards, and relays Expo push
notifications.

It is deliberately not a gameplay server. Gameplay REST, WebSockets, Prisma, and
per-shard Postgres live in `../backend`. The distributed-hosting source of truth
is `../backend/DISTRIBUTED_HOSTING_PLAN.md`.

## Commands

```bash
npm install
npm run dev           # tsx watch src/index.ts
npm run build         # tsc
npm start             # node dist/src/index.js
npm run typecheck     # tsc --noEmit
npm run generate-keys # print JWT_PRIVATE_KEY_BASE64 for RS256 signing
```

There is no test suite at the moment. Use `npm run typecheck` as the basic
verification step after code edits.

## Environment

All config is parsed in `src/env.ts`. Required-for-production values:

- `COORDINATOR_PUBLIC_URL` - public HTTPS URL and JWT issuer.
- `JWT_PRIVATE_KEY_BASE64` - base64 PKCS8 RSA private key from
  `npm run generate-keys`.
- `JWT_PUBLIC_KEY_ID` - JWKS `kid`, defaults to `coordinator-key-1`.
- `TOKEN_TTL_HOURS` - shard token lifetime, defaults to 12.
- `ADMIN_API_KEY` - gates `/admin/api/*`; must be at least 16 chars.
- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`,
  `FIREBASE_DATABASE_URL` - Firebase Admin and RTDB.
- `STALE_HEARTBEAT_SECONDS` - discovery freshness cutoff, defaults to 120.
- `REVENUECAT_SECRET_KEY` - Phase 9. RevenueCat secret (`sk_...`) key, the only
  copy in any repo. Verifies purchases server-side in `/purchases/redeem`.
  Unset → redemption returns `PURCHASES_DISABLED`. `REVENUECAT_API_BASE`
  defaults to `https://api.revenuecat.com`.

Firebase credentials are lazy: `/health` and local development can run without
them. Without Firebase credentials, `src/store.ts` uses an in-memory store. That
is local-only and loses all state on restart.

Never add `DATABASE_URL`, Prisma, SQL migrations, or Neon setup here. That would
violate the coordinator/shard split.

## Architecture map

- `api/index.ts` - Vercel serverless entrypoint. Imports `buildApp()`.
- `src/index.ts` - local Node entrypoint. Builds the app and listens on `PORT`.
- `src/app.ts` - Express app construction, CORS, health, JWKS, route setup.
- `src/env.ts` - env parsing and feature-specific required-value helpers.
- `src/firebase.ts` - lazy Firebase Admin init, RTDB access, ID token verify.
- `src/store.ts` - coordinator state abstraction: Firebase RTDB store plus
  volatile in-memory fallback.
- `src/keys.ts` - RS256 signing, JWKS export, coordinator-token refresh verify.
- `src/middleware.ts` - response shape, shard API-key auth, admin auth.
- `src/social.ts` - profile bootstrap writes to Firebase central.
- `src/routes/shards.ts` - open registration and shard heartbeat.
- `src/routes/servers.ts` - public server discovery; with an optional Firebase
  ID token, `GET /servers` also returns the caller's server history.
- `src/routes/auth.ts` - shard token mint, Firebase ID token verify, refresh,
  client select-server flow, and Phase 8 username claim/availability
  (`POST /auth/claim-username`, `GET /auth/username-available`).
- `src/routes/relay.ts` - Expo push relay backed by Firebase central token and
  preference paths.
- `src/routes/purchases.ts` - Phase 9 `POST /purchases/redeem` (auth: Firebase
  ID token). Verifies a RevenueCat purchase (`src/revenuecat.ts`), claims the
  store transaction once in the RTDB ledger (`store.claimPurchase`), and mints
  a short-lived RS256 grant voucher (`signPurchaseVoucher` in `src/keys.ts`)
  the shard redeems. `src/catalog.ts` is the server-authoritative product →
  grant map; the client never names an amount.
- `src/routes/admin.ts` - admin API and self-contained `/admin` HTML page.
- `rtdbrules.json` - Firebase RTDB rules for coordinator and global social data.

## Auth and trust model

The core security law from the plan: a secret a community host's machine uses is
a secret the host can read. Therefore community shards never receive coordinator
private keys or Firebase Admin credentials.

Shard auth uses a revocable API key:

```text
Authorization: Bearer mw_shard_...
```

Only the SHA-256 hash is stored under `/coordinator/shardKeyIndex`. Rotating a
key deletes the old hash and writes the new one.

Player session auth uses coordinator-issued RS256 JWTs:

- `sub` is `firebaseUID`, or `user:<username>` for legacy non-Firebase accounts.
- `username` is included as a claim for existing shard code.
- `aud` is always the shard id.
- `iss` is `COORDINATOR_PUBLIC_URL`.
- Expiry defaults to 12 hours.

Shards fetch `/.well-known/jwks.json` and verify-only. They must not sign shared
network tokens themselves.

## Storage model

Coordinator control-plane state is under these RTDB paths:

- `/coordinator/shards`
- `/coordinator/shardKeyIndex`
- `/coordinator/shardNameIndex`
- `/coordinator/sessions`
- `/coordinator/users/<userId>/serverHistory/<shardId>` - Phase 7 per-user
  server history (`firstUsedAt`, `lastUsedAt`, `useCount` plus name/region/
  verified snapshots), written on every token mint; `userId` is the
  firebaseUID or `user:<username>` for legacy accounts
- `/coordinator/purchases/<sha256(txId)>` - Phase 9 purchase ledger. One
  record per redeemed RevenueCat/store transaction (`{txId, userId, shardId,
  productId, grant*, redeemedAt}`), written by `store.claimPurchase` so each
  purchase is granted exactly once. The key is hashed because store transaction
  ids contain RTDB-illegal characters. Admin-SDK only (under `/coordinator`).
- `/coordinator/usernameIndex/<usernameLower>` - Phase 8 global username
  claims (lowercased name -> firebaseUID), written transactionally by
  `POST /auth/claim-username`. Availability checks also consult `/profiles`
  for names that predate central claims. `/profiles` writes are locked to
  the Admin SDK in `rtdbrules.json` so this index cannot be bypassed.

Clients must not read or write `/coordinator/*` directly. Keep
`rtdbrules.json` aligned with any new Firebase paths.

Global social paths currently planned/used by the distributed design:

- `/profiles/<uid>`
- `/friends/<uid>`
- `/friendRequests/<uid>/<fromUid>`
- `/notificationPreferences/<uid>`
- `/notificationTokens/<uid>`
- existing chat paths: `/conversations/*`, `/users/<username>/*`

## Route conventions

Responses use one shape everywhere:

```ts
// success
{ ok: true, data: { ... } }

// failure
{ ok: false, error: { code: string, message: string } }
```

Use `sendError()` from `src/middleware.ts`; do not invent new error shapes.
Validate request bodies with zod at route boundaries. Keep route handlers
defensive and avoid leaking secrets in logs.

## Implementation gotchas

- This repo has no Prisma and should stay that way.
- `getStore()` chooses Firebase or memory at first use. If you change store
  behavior, think about both implementations.
- `JWT_PRIVATE_KEY_BASE64` is the only signing-key env var. The public JWK is
  derived from it; do not add a separate public-key copy path unless there is a
  real rotation design.
- `FIREBASE_PRIVATE_KEY` may arrive with literal `\n` sequences. `firebase.ts`
  normalizes them.
- The admin portal HTML is embedded in `src/routes/admin.ts`; keep it small and
  dependency-free unless a real frontend is introduced.
- CORS is intentionally open because mobile apps, browsers, and community
  shards call this service from arbitrary origins.
- Shards with no heartbeat, stale heartbeat, non-active status, or disabled
  status are hidden from public discovery.
- New shards start `pending` and `verified: false`; the first heartbeat makes
  them `active`, but only an admin can verify them.

## Before changing behavior

Read `../backend/DISTRIBUTED_HOSTING_PLAN.md` first. The coordinator is only the
control plane; if a proposed change puts gameplay state, local game economy,
Prisma, or live WebSocket traffic here, it probably belongs in `../backend`
instead.
