import type { Express, Request, Response } from "express";
import { sendError } from "../middleware";
import { getStore } from "../store";

// Phase 12: the latest approved backend release. Public so hosts can inspect
// what the coordinator considers current; the authoritative per-shard decision
// (current / update_available / update_required) is delivered in the heartbeat
// response. Published by an admin via POST /admin/api/releases/backend.

export function setupReleaseRoutes(app: Express) {
  app.get("/releases/backend/latest", async (_req: Request, res: Response) => {
    try {
      const release = await getStore().getLatestRelease();
      res.json({ ok: true, data: { release } });
    } catch (error) {
      console.error("[releases/latest]", error);
      sendError(res, 500, "INTERNAL", "Failed to read the latest release.");
    }
  });
}
