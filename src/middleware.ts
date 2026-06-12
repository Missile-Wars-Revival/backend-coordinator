import type { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "crypto";
import { requireAdminKey } from "./env";
import { getStore, hashApiKey, type ShardRecord } from "./store";

// Response shape used everywhere:
//   success: { ok: true, data: {...} }
//   failure: { ok: false, error: { code, message } }
export function sendError(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ ok: false, error: { code, message } });
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim();
  }
  return null;
}

// Shard-key auth for /shards/* — looks the key hash up in the key index, so a
// rotated/revoked key stops working immediately.
export async function shardAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const apiKey = bearerToken(req);
    if (!apiKey) {
      return sendError(res, 401, "MISSING_SHARD_KEY", "Send the shard API key as 'Authorization: Bearer <key>'.");
    }
    const store = getStore();
    const shardId = await store.getShardIdByKeyHash(hashApiKey(apiKey));
    const shard = shardId ? await store.getShard(shardId) : null;
    if (!shard) {
      return sendError(res, 401, "INVALID_SHARD_KEY", "Unknown or revoked shard API key.");
    }
    if (shard.status === "disabled") {
      return sendError(res, 403, "SHARD_DISABLED", "This shard has been disabled by the coordinator admin.");
    }
    (req as Request & { shard: ShardRecord }).shard = shard;
    next();
  } catch (error) {
    console.error("[shardAuth]", error);
    sendError(res, 500, "INTERNAL", "Shard authentication failed.");
  }
}

export function getAuthedShard(req: Request): ShardRecord {
  return (req as Request & { shard: ShardRecord }).shard;
}

// Admin auth for /admin/api/* — a single coordinator-held ADMIN_API_KEY.
export function adminAuth(req: Request, res: Response, next: NextFunction) {
  let expected: string;
  try {
    expected = requireAdminKey();
  } catch (error) {
    return sendError(res, 503, "ADMIN_KEY_UNSET", (error as Error).message);
  }
  const provided = bearerToken(req) ?? (req.headers["x-admin-key"] as string | undefined) ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return sendError(res, 401, "INVALID_ADMIN_KEY", "Invalid admin key.");
  }
  next();
}
