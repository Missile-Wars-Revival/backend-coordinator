import type { Express, Request, Response } from "express";
import { sendError } from "../middleware";
import { getStore, isShardListable, type ShardRecord } from "../store";

// Public server discovery. Only active shards with a fresh heartbeat are
// listed; the `verified` flag drives the frontend's badge / warning UI.

interface PublicServer {
  id: string;
  name: string;
  description?: string;
  region: string;
  publicHttpUrl: string;
  publicWsUrl: string;
  verified: boolean;
  playerCount: number;
  version?: string;
  lastHeartbeatAt?: number;
}

function toPublic(shard: ShardRecord): PublicServer {
  return {
    id: shard.id,
    name: shard.name,
    ...(shard.description ? { description: shard.description } : {}),
    region: shard.region,
    publicHttpUrl: shard.publicHttpUrl,
    publicWsUrl: shard.publicWsUrl,
    verified: shard.verified,
    playerCount: shard.playerCount,
    ...(shard.version ? { version: shard.version } : {}),
    ...(shard.lastHeartbeatAt ? { lastHeartbeatAt: shard.lastHeartbeatAt } : {}),
  };
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function setupServerRoutes(app: Express) {
  app.get("/servers", async (_req: Request, res: Response) => {
    try {
      const shards = (await getStore().listShards()).filter((s) => isShardListable(s));
      res.json({ ok: true, data: { servers: shards.map(toPublic) } });
    } catch (error) {
      console.error("[servers]", error);
      sendError(res, 500, "INTERNAL", "Failed to list servers.");
    }
  });

  app.get("/servers/best", async (req: Request, res: Response) => {
    try {
      const lat = Number(req.query.lat);
      const lon = Number(req.query.lon);
      const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);

      const listable = (await getStore().listShards()).filter((s) => isShardListable(s));
      if (listable.length === 0) {
        return sendError(res, 404, "NO_SERVERS", "No servers are currently online.");
      }

      // Nearest shard wins when both sides have coordinates; shards without a
      // location (and requests without one) fall back to lowest player count.
      const ranked = [...listable].sort((a, b) => {
        if (hasCoords) {
          const aDist = a.lat !== undefined && a.lon !== undefined ? haversineKm(lat, lon, a.lat, a.lon) : Infinity;
          const bDist = b.lat !== undefined && b.lon !== undefined ? haversineKm(lat, lon, b.lat, b.lon) : Infinity;
          if (aDist !== bDist) return aDist - bDist;
        }
        if (a.verified !== b.verified) return a.verified ? -1 : 1;
        return a.playerCount - b.playerCount;
      });

      res.json({ ok: true, data: { server: toPublic(ranked[0]) } });
    } catch (error) {
      console.error("[servers/best]", error);
      sendError(res, 500, "INTERNAL", "Failed to pick a server.");
    }
  });
}
