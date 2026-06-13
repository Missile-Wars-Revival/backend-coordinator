import { createPublicKey, type KeyObject } from "crypto";
import { SignJWT, exportJWK, importPKCS8, jwtVerify, type JWK, type JWTPayload, type KeyLike } from "jose";
import { env, requirePrivateKeyPem } from "./env";

// RS256 key handling. The coordinator holds the PRIVATE key (env var) and is
// the only party that signs tokens. Shards fetch the PUBLIC key from
// /.well-known/jwks.json and verify-only — see DISTRIBUTED_HOSTING_PLAN.md.

const ALG = "RS256";

let privateKey: KeyLike | null = null;
let publicJwk: JWK | null = null;

async function getPrivateKey(): Promise<KeyLike> {
  if (!privateKey) {
    privateKey = await importPKCS8(requirePrivateKeyPem(), ALG);
  }
  return privateKey;
}

export async function getJwks(): Promise<{ keys: JWK[] }> {
  if (!publicJwk) {
    // Derive the public half from the private PEM so only one env var exists.
    const publicKeyObject = createPublicKey(requirePrivateKeyPem());
    const jwk = await exportJWK(publicKeyObject);
    publicJwk = { ...jwk, kid: env.JWT_PUBLIC_KEY_ID, alg: ALG, use: "sig" };
  }
  return { keys: [publicJwk] };
}

export interface ShardTokenClaims {
  // Legacy pre-Firebase accounts have no firebaseUID; their stable subject
  // becomes "user:<username>" so `sub` is always present and non-empty.
  firebaseUID?: string;
  username: string;
  shardId: string;
}

export async function signShardToken(claims: ShardTokenClaims): Promise<{ token: string; expiresAt: number }> {
  const key = await getPrivateKey();
  const expiresAt = Date.now() + env.TOKEN_TTL_HOURS * 3600 * 1000;
  const token = await new SignJWT({ username: claims.username, scope: "play:server" })
    .setProtectedHeader({ alg: ALG, kid: env.JWT_PUBLIC_KEY_ID })
    .setSubject(claims.firebaseUID || `user:${claims.username}`)
    .setAudience(claims.shardId)
    .setIssuer(env.COORDINATOR_PUBLIC_URL)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt / 1000))
    .sign(key);
  return { token, expiresAt };
}

// Phase 9: a purchase grant voucher. Signed with the SAME RS256 private key as
// shard tokens, so shards verify it with the JWKS they already cache — no new
// secret reaches a shard. A distinct `scope` keeps it from being mistaken for a
// play token, and the short expiry bounds replay (the shard also dedupes on
// txId). `aud` locks the grant to one shard (one world); `sub` is the buyer.
export interface PurchaseVoucherClaims {
  firebaseUID: string;
  shardId: string;
  txId: string;
  productId: string;
  grant: Record<string, unknown>;
}

const VOUCHER_TTL_SECONDS = 10 * 60;

export async function signPurchaseVoucher(
  claims: PurchaseVoucherClaims
): Promise<{ voucher: string; expiresAt: number }> {
  const key = await getPrivateKey();
  const expiresAt = Date.now() + VOUCHER_TTL_SECONDS * 1000;
  const voucher = await new SignJWT({
    scope: "purchase:grant",
    txId: claims.txId,
    productId: claims.productId,
    grant: claims.grant,
  })
    .setProtectedHeader({ alg: ALG, kid: env.JWT_PUBLIC_KEY_ID })
    .setSubject(claims.firebaseUID)
    .setAudience(claims.shardId)
    .setIssuer(env.COORDINATOR_PUBLIC_URL)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt / 1000))
    .sign(key);
  return { voucher, expiresAt };
}

let publicKeyObject: KeyObject | null = null;

// Verifies one of our own shard tokens (signature, expiry, issuer). Used by
// /auth/refresh to reissue a still-valid token with the same identity.
export async function verifyShardToken(token: string): Promise<JWTPayload> {
  if (!publicKeyObject) {
    publicKeyObject = createPublicKey(requirePrivateKeyPem());
  }
  const { payload } = await jwtVerify(token, publicKeyObject, {
    algorithms: [ALG],
    issuer: env.COORDINATOR_PUBLIC_URL,
  });
  return payload;
}
