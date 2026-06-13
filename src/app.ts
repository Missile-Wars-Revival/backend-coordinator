import express, { type Express } from "express";
import { getJwks } from "./keys";
import { sendError } from "./middleware";
import { setupAdminRoutes } from "./routes/admin";
import { setupAuthRoutes } from "./routes/auth";
import { setupPurchaseRoutes } from "./routes/purchases";
import { setupRelayRoutes } from "./routes/relay";
import { setupServerRoutes } from "./routes/servers";
import { setupShardRoutes } from "./routes/shards";

export function buildApp(): Express {
  const app = express();
  app.use(express.json({ limit: "100kb" }));

  // The coordinator is a public API consumed by browsers, the mobile app, and
  // shard servers from arbitrary origins.
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Admin-Key");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    next();
  });
  app.options(/.*/, (_req, res) => res.sendStatus(204));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, data: { service: "missile-wars-coordinator", time: Date.now() } });
  });

  app.get("/.well-known/jwks.json", async (_req, res) => {
    try {
      res.json(await getJwks());
    } catch (error) {
      console.error("[jwks]", error);
      sendError(res, 503, "KEYS_UNSET", (error as Error).message);
    }
  });

  setupShardRoutes(app);
  setupServerRoutes(app);
  setupAuthRoutes(app);
  setupPurchaseRoutes(app);
  setupRelayRoutes(app);
  setupAdminRoutes(app);

  app.use((_req, res) => sendError(res, 404, "NOT_FOUND", "Unknown route."));
  return app;
}

const app = buildApp();

export default app;
