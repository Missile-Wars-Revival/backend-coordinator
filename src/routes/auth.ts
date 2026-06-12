import type { Express, Request, Response } from "express";
import { z } from "zod";
import { signShardToken, verifyShardToken } from "../keys";
import { getAuthedShard, sendError, shardAuth } from "../middleware";
import { verifyFirebaseIdToken } from "../firebase";
import { bootstrapProfile } from "../social";
import { getStore, isShardListable } from "../store";

// Server selection: the client proves identity with a Firebase ID token, and
// the coordinator mints a short-lived RS256 "shard token" (aud = shardId).
// Shards verify it against /.well-known/jwks.json — they never see Firebase
// credentials or coordinator secrets.

const SelectSchema = z.object({
  serverId: z.string().min(1),
});

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

      const { token, expiresAt } = await signShardToken({ username, firebaseUID, shardId: shard.id });
      await getStore().addSession({
        userId: firebaseUID ?? `user:${username}`,
        username,
        shardId: shard.id,
        issuedAt: Date.now(),
        expiresAt,
      });
      await bootstrapProfile(firebaseUID ?? `user:${username}`, username, shard.id);

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

      const { token: newToken, expiresAt } = await signShardToken({
        username,
        firebaseUID: payload.sub.startsWith("user:") ? undefined : payload.sub,
        shardId,
      });
      await bootstrapProfile(payload.sub, username, shardId);
      res.json({ ok: true, data: { token: newToken, expiresAt } });
    } catch (error) {
      console.error("[auth/refresh]", error);
      sendError(res, 500, "INTERNAL", "Token refresh failed.");
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

      // Usernames live in RTDB profiles; fall back to token claims.
      const username =
        (decoded.name as string | undefined) ?? decoded.email?.split("@")[0] ?? decoded.uid;

      const { token, expiresAt } = await signShardToken({
        firebaseUID: decoded.uid,
        username,
        shardId: shard.id,
      });

      await store.addSession({
        userId: decoded.uid,
        username,
        shardId: shard.id,
        issuedAt: Date.now(),
        expiresAt,
      });
      await bootstrapProfile(decoded.uid, username, shard.id);

      res.json({
        ok: true,
        data: {
          token,
          expiresAt,
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
