import { randomUUID, randomBytes } from "crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { getAuthedShard, sendError, shardAuth } from "../middleware";
import { getStore, hashApiKey, type ShardRecord } from "../store";

// Community-server endpoints. Open registration: anyone can register a shard,
// but new shards start unverified (and "pending" until their first heartbeat).
// The only secret a shard ever holds is the revocable API key issued here.

const RegisterSchema = z.object({
  name: z.string().min(3).max(40),
  description: z.string().max(300).optional(),
  region: z.string().min(2).max(40),
  publicHttpUrl: z.string().url().max(200),
  publicWsUrl: z.string().url().max(200).optional(),
  ownerContact: z.string().email().max(120),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
});

const HeartbeatSchema = z.object({
  playerCount: z.number().int().min(0).default(0),
  version: z.string().max(40).optional(),
  gitSha: z.string().max(64).optional(),
});

const NameAvailabilitySchema = z.object({
  name: z.string().min(3).max(40),
});

export function newShardApiKey(): string {
  return `mw_shard_${randomBytes(24).toString("hex")}`;
}

export function setupShardRoutes(app: Express) {
  app.get("/shards/name-available", async (req: Request, res: Response) => {
    try {
      const parsed = NameAvailabilitySchema.safeParse(req.query);
      if (!parsed.success) {
        return sendError(res, 400, "INVALID_QUERY", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      }
      const shardId = await getStore().getShardIdByName(parsed.data.name);
      res.json({ ok: true, data: { name: parsed.data.name, available: !shardId } });
    } catch (error) {
      console.error("[shards/name-available]", error);
      sendError(res, 500, "INTERNAL", "Name availability check failed.");
    }
  });

  app.post("/shards/register", async (req: Request, res: Response) => {
    try {
      const parsed = RegisterSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(res, 400, "INVALID_BODY", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      }
      const body = parsed.data;
      const store = getStore();

      if (await store.getShardIdByName(body.name)) {
        return sendError(res, 409, "NAME_TAKEN", "A shard with this name is already registered.");
      }

      const apiKey = newShardApiKey();
      const now = Date.now();
      const shard: ShardRecord = {
        id: randomUUID(),
        name: body.name,
        ...(body.description ? { description: body.description } : {}),
        region: body.region,
        publicHttpUrl: body.publicHttpUrl,
        publicWsUrl: body.publicWsUrl ?? body.publicHttpUrl.replace(/^http/, "ws"),
        ...(body.ownerContact ? { ownerContact: body.ownerContact } : {}),
        ...(body.lat !== undefined ? { lat: body.lat } : {}),
        ...(body.lon !== undefined ? { lon: body.lon } : {}),
        apiKeyHash: hashApiKey(apiKey),
        status: "pending",
        verified: false,
        playerCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      const created = await store.createShard(shard);
      if (!created) {
        return sendError(res, 409, "NAME_TAKEN", "A shard with this name is already registered. Pick another server name.");
      }

      // The raw key is returned exactly once; only its hash is stored.
      res.status(201).json({
        ok: true,
        data: {
          shardId: shard.id,
          apiKey,
          status: shard.status,
          verified: shard.verified,
          note:
            "Save this API key now — it is shown only once. Put it in your shard's .env as SHARD_API_KEY. " +
            "Your shard becomes discoverable after its first heartbeat; 'verified' status is granted by the project owner.",
        },
      });
    } catch (error) {
      console.error("[shards/register]", error);
      sendError(res, 500, "INTERNAL", "Registration failed.");
    }
  });

  app.post("/shards/heartbeat", shardAuth, async (req: Request, res: Response) => {
    try {
      const parsed = HeartbeatSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return sendError(res, 400, "INVALID_BODY", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      }
      const shard = getAuthedShard(req);
      const patch: Partial<ShardRecord> = {
        playerCount: parsed.data.playerCount,
        lastHeartbeatAt: Date.now(),
        ...(parsed.data.version ? { version: parsed.data.version } : {}),
        ...(parsed.data.gitSha ? { gitSha: parsed.data.gitSha } : {}),
      };
      // First heartbeat activates a pending shard; a resumed heartbeat brings
      // an offline shard back into discovery.
      if (shard.status === "pending" || shard.status === "offline") {
        patch.status = "active";
      }
      await getStore().updateShard(shard.id, patch);
      res.json({ ok: true, data: { shardId: shard.id, status: patch.status ?? shard.status } });
    } catch (error) {
      console.error("[shards/heartbeat]", error);
      sendError(res, 500, "INTERNAL", "Heartbeat failed.");
    }
  });
}
