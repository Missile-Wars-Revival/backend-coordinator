import type { Express, Request, Response } from "express";
import { z } from "zod";
import { signShardToken, verifyShardToken } from "../keys";
import { getAuthedShard, sendError, shardAuth } from "../middleware";
import { verifyFirebaseIdToken } from "../firebase";
import {
  bootstrapProfile,
  getProfileUsername,
  getUidByProfileUsername,
  isStaffUid,
  setProfileUsername,
} from "../social";
import { getStore, isShardListable, type ShardRecord } from "../store";

// Phase 7: every successful mint records the shard in the user's server
// history (/coordinator/users/<uid>/serverHistory/<shardId>) so the selector
// can offer a "recent servers" / continue flow. Non-fatal — history must
// never break a token mint.
async function recordServerUse(userId: string, shard: ShardRecord): Promise<void> {
  try {
    await getStore().recordServerUse(userId, shard);
  } catch (error) {
    console.error(`[auth] server-history write failed for ${userId}:`, (error as Error).message);
  }
}

// Server selection: the client proves identity with a Firebase ID token, and
// the coordinator mints a short-lived RS256 "shard token" (aud = shardId).
// Shards verify it against /.well-known/jwks.json — they never see Firebase
// credentials or coordinator secrets.

const SelectSchema = z.object({
  serverId: z.string().min(1),
});

// Same shape the shards have always enforced at /api/register. Lowercased for
// uniqueness, so "Alice" and "alice" cannot both be claimed through here.
const USERNAME_RE = /^[a-zA-Z0-9]{3,20}$/;

const ClaimUsernameSchema = z.object({
  username: z.string().regex(USERNAME_RE, "Username must be 3-20 letters and numbers."),
});

// A name is taken when the Phase 8 claim index has it (lowercased) or any
// existing profile carries it (accounts that predate central claims).
async function usernameOwnerUid(username: string): Promise<string | null> {
  const claimed = await getStore().getUsernameClaim(username.toLowerCase());
  if (claimed) return claimed;
  return getUidByProfileUsername(username);
}

async function uidFromIdTokenHeader(req: Request): Promise<{ uid: string } | null> {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  try {
    const decoded = await verifyFirebaseIdToken(header.slice("Bearer ".length).trim());
    return { uid: decoded.uid };
  } catch {
    return null;
  }
}

const ShardTokenSchema = z.object({
  username: z.string().min(1).max(64),
  firebaseUID: z.string().min(1).max(128).optional(),
});

export function setupAuthRoutes(app: Express) {
  // Phase 3 mint endpoint: a shard that has already validated a user (its own
  // Postgres lookup and/or Firebase idToken verify) asks the coordinator to
  // sign the session token. Auth is the shard's API key, and the audience is
  // always the calling shard — a shard can never mint tokens for another one.
  app.post("/auth/shard-token", shardAuth, async (req: Request, res: Response) => {
    try {
      const parsed = ShardTokenSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(res, 400, "INVALID_BODY", "Body must be { username, firebaseUID? }.");
      }
      const shard = getAuthedShard(req);
      const { username, firebaseUID } = parsed.data;

      const staff = firebaseUID ? await isStaffUid(firebaseUID) : false;
      const { token, expiresAt } = await signShardToken({ username, firebaseUID, shardId: shard.id, staff });
      const userId = firebaseUID ?? `user:${username}`;
      await getStore().addSession({
        userId,
        username,
        shardId: shard.id,
        issuedAt: Date.now(),
        expiresAt,
      });
      await bootstrapProfile(userId, username, shard.id);
      await recordServerUse(userId, shard);

      res.json({ ok: true, data: { token, expiresAt } });
    } catch (error) {
      console.error("[auth/shard-token]", error);
      sendError(res, 500, "INTERNAL", "Token mint failed.");
    }
  });

  // Lets a shard WITHOUT firebasecred.json (community hosts never get it)
  // verify a client's Firebase ID token. The shard sends the idToken it
  // received; the coordinator verifies it with the admin SDK and returns the
  // identity claims the shard's login/register handlers need.
  app.post("/auth/verify-id-token", shardAuth, async (req: Request, res: Response) => {
    try {
      const idToken = typeof req.body?.idToken === "string" ? req.body.idToken : null;
      if (!idToken) {
        return sendError(res, 400, "INVALID_BODY", "Body must be { idToken: string }.");
      }
      let decoded;
      try {
        decoded = await verifyFirebaseIdToken(idToken);
      } catch {
        return sendError(res, 401, "INVALID_ID_TOKEN", "Firebase ID token is invalid or expired.");
      }
      res.json({
        ok: true,
        data: {
          uid: decoded.uid,
          email: decoded.email ?? null,
          name: (decoded.name as string | undefined) ?? null,
          emailVerified: decoded.email_verified ?? false,
        },
      });
    } catch (error) {
      console.error("[auth/verify-id-token]", error);
      sendError(res, 500, "INTERNAL", "Token verification failed.");
    }
  });

  // Exchanges a still-valid shard token for a fresh one with the same
  // identity and audience. Expired tokens are rejected — the client must log
  // in again through its shard.
  app.post("/auth/refresh", async (req: Request, res: Response) => {
    try {
      const token = typeof req.body?.token === "string" ? req.body.token : null;
      if (!token) {
        return sendError(res, 400, "INVALID_BODY", "Body must be { token: string }.");
      }

      let payload;
      try {
        payload = await verifyShardToken(token);
      } catch {
        return sendError(res, 401, "INVALID_TOKEN", "Token is invalid or expired.");
      }
      const username = payload.username as string | undefined;
      const shardId = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
      if (!username || !payload.sub || !shardId) {
        return sendError(res, 401, "INVALID_TOKEN", "Token is missing required claims.");
      }

      // Refuse to extend sessions onto shards that were disabled since issue.
      const shard = await getStore().getShard(shardId);
      if (!shard || shard.status === "disabled") {
        return sendError(res, 403, "SHARD_DISABLED", "This server is no longer available.");
      }

      const subUid = payload.sub.startsWith("user:") ? null : payload.sub;
      const { token: newToken, expiresAt } = await signShardToken({
        username,
        firebaseUID: subUid ?? undefined,
        shardId,
        staff: subUid ? await isStaffUid(subUid) : false,
      });
      await bootstrapProfile(payload.sub, username, shardId);
      await recordServerUse(payload.sub, shard);
      res.json({ ok: true, data: { token: newToken, expiresAt } });
    } catch (error) {
      console.error("[auth/refresh]", error);
      sendError(res, 500, "INTERNAL", "Token refresh failed.");
    }
  });
  // Phase 8 coordinator-only auth: the app registers with Firebase alone, so
  // game usernames are allocated here instead of on a shard. Public — the
  // register form checks before creating the Firebase account.
  app.get("/auth/username-available", async (req: Request, res: Response) => {
    try {
      const username = typeof req.query.username === "string" ? req.query.username.trim() : "";
      if (!USERNAME_RE.test(username)) {
        return res.json({ ok: true, data: { username, available: false, reason: "INVALID_FORMAT" } });
      }
      const owner = await usernameOwnerUid(username);
      res.json({ ok: true, data: { username, available: owner === null } });
    } catch (error) {
      console.error("[auth/username-available]", error);
      sendError(res, 500, "INTERNAL", "Availability check failed.");
    }
  });

  // Claims a username for the authenticated Firebase account: transactional
  // claim in /coordinator/usernameIndex (lowercased) plus the profile write
  // that select-server and other players read. One-shot — renames still go
  // through a shard's /api/changeUsername, not here.
  app.post("/auth/claim-username", async (req: Request, res: Response) => {
    try {
      const identity = await uidFromIdTokenHeader(req);
      if (!identity) {
        return sendError(res, 401, "INVALID_ID_TOKEN", "Send a valid Firebase ID token as 'Authorization: Bearer <token>'.");
      }
      const parsed = ClaimUsernameSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(res, 400, "INVALID_USERNAME", "Username must be 3-20 letters and numbers.");
      }
      const { username } = parsed.data;
      const { uid } = identity;

      const existing = await getProfileUsername(uid);
      if (existing && existing !== username) {
        return sendError(res, 409, "USERNAME_ALREADY_SET", `This account already has the username "${existing}".`);
      }

      const owner = await usernameOwnerUid(username);
      if (owner && owner !== uid) {
        return sendError(res, 409, "USERNAME_TAKEN", "That username is already taken.");
      }
      if (!(await getStore().claimUsername(username.toLowerCase(), uid))) {
        return sendError(res, 409, "USERNAME_TAKEN", "That username is already taken.");
      }

      await setProfileUsername(uid, username);
      res.json({ ok: true, data: { username } });
    } catch (error) {
      console.error("[auth/claim-username]", error);
      sendError(res, 500, "INTERNAL", "Username claim failed.");
    }
  });

  app.post("/auth/select-server", async (req: Request, res: Response) => {
    try {
      const header = req.headers.authorization;
      if (typeof header !== "string" || !header.startsWith("Bearer ")) {
        return sendError(res, 401, "MISSING_ID_TOKEN", "Send a Firebase ID token as 'Authorization: Bearer <token>'.");
      }

      const parsed = SelectSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(res, 400, "INVALID_BODY", "Body must be { serverId: string }.");
      }

      let decoded;
      try {
        decoded = await verifyFirebaseIdToken(header.slice("Bearer ".length).trim());
      } catch {
        return sendError(res, 401, "INVALID_ID_TOKEN", "Firebase ID token is invalid or expired.");
      }

      const store = getStore();
      const shard = await store.getShard(parsed.data.serverId);
      if (!shard || !isShardListable(shard)) {
        return sendError(res, 404, "SERVER_UNAVAILABLE", "That server is not currently available.");
      }

      // The game username lives in RTDB profiles (bootstrapped on every mint,
      // synced on rename); token claims are only a fallback for accounts that
      // have never minted through the coordinator before.
      const username =
        (await getProfileUsername(decoded.uid)) ??
        (decoded.name as string | undefined) ??
        decoded.email?.split("@")[0] ??
        decoded.uid;

      const { token, expiresAt } = await signShardToken({
        firebaseUID: decoded.uid,
        username,
        shardId: shard.id,
        staff: await isStaffUid(decoded.uid),
      });

      await store.addSession({
        userId: decoded.uid,
        username,
        shardId: shard.id,
        issuedAt: Date.now(),
        expiresAt,
      });
      await bootstrapProfile(decoded.uid, username, shard.id);
      await recordServerUse(decoded.uid, shard);

      res.json({
        ok: true,
        data: {
          token,
          expiresAt,
          // Phase 8: the client logs in with email only, so this is where it
          // learns (and caches) its game username.
          username,
          server: {
            id: shard.id,
            name: shard.name,
            publicHttpUrl: shard.publicHttpUrl,
            publicWsUrl: shard.publicWsUrl,
            verified: shard.verified,
          },
        },
      });
    } catch (error) {
      console.error("[auth/select-server]", error);
      sendError(res, 500, "INTERNAL", "Server selection failed.");
    }
  });
}
