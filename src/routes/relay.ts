import type { Express, Request, Response } from "express";
import Expo, { type ExpoPushMessage } from "expo-server-sdk";
import { z } from "zod";
import { firebaseAvailable, rtdb } from "../firebase";
import { getAuthedShard, sendError, shardAuth } from "../middleware";

// Phase 5 push relay. Shards ask the coordinator to deliver pushes instead of
// holding players' Expo tokens themselves: the token and the user's
// notification preferences live in Firebase central (/notificationTokens,
// /notificationPreferences — written by clients per rtdbrules.json and seeded
// by the backend's migrate:social script).
//
// Rate-limited per shard so a hostile host can't spam the player base.

const expo = new Expo();

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 240; // pushes per shard per minute

const windows = new Map<string, { start: number; count: number }>();

function rateLimited(shardId: string): boolean {
  const now = Date.now();
  const window = windows.get(shardId);
  if (!window || now - window.start >= RATE_LIMIT_WINDOW_MS) {
    windows.set(shardId, { start: now, count: 1 });
    return false;
  }
  window.count++;
  return window.count > RATE_LIMIT_MAX;
}

// Mirrors the shard's NotificationService preference gating (see
// backend/runners/NotificationService.ts TYPE_PREFERENCE_MAP).
const TYPE_PREFERENCE_MAP: Record<string, string> = {
  incoming_entity: "incomingEntities",
  entity_damage: "entityDamage",
  airspace_alert: "entitiesInAirspace",
  elimination_reward: "eliminationReward",
  loot_drop: "lootDrops",
  friend_request: "friendRequests",
  league: "leagues",
};

const PushSchema = z.object({
  firebaseUID: z.string().min(1).max(128),
  title: z.string().max(200).optional(),
  body: z.string().max(2000).optional(),
  type: z.string().max(40).default("system"),
  data: z.record(z.unknown()).optional(),
  richContent: z.object({ image: z.string().url().optional() }).optional(),
  silent: z.boolean().default(false),
});

export function setupRelayRoutes(app: Express) {
  app.post("/relay/push", shardAuth, async (req: Request, res: Response) => {
    try {
      const shard = getAuthedShard(req);
      if (rateLimited(shard.id)) {
        return sendError(res, 429, "RATE_LIMITED", "Push relay rate limit exceeded for this shard.");
      }
      if (!firebaseAvailable()) {
        return sendError(res, 503, "FIREBASE_UNSET", "Coordinator has no Firebase credentials configured.");
      }

      const parsed = PushSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(res, 400, "INVALID_BODY", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      }
      const { firebaseUID, title, body, type, data, richContent, silent } = parsed.data;

      const [tokenSnap, prefsSnap] = await Promise.all([
        rtdb().ref(`notificationTokens/${firebaseUID}`).get(),
        rtdb().ref(`notificationPreferences/${firebaseUID}`).get(),
      ]);

      const token = tokenSnap.exists() ? (tokenSnap.val() as string) : null;
      if (!token || !Expo.isExpoPushToken(token)) {
        return res.json({ ok: true, data: { delivered: false, reason: "NO_TOKEN" } });
      }

      const prefKey = TYPE_PREFERENCE_MAP[type];
      if (prefKey && prefsSnap.exists() && prefsSnap.val()?.[prefKey] === false) {
        return res.json({ ok: true, data: { delivered: false, reason: "PREFERENCES" } });
      }

      // Same message shape as the shard's NotificationService — including
      // mutableContent, which the iOS notification-service extension requires
      // for communication (sender PFP) and rich-image treatments.
      const needsMutation = Boolean((data as Record<string, unknown> | undefined)?.communication) || Boolean(richContent?.image);
      const message: ExpoPushMessage = {
        to: token,
        channelId: "default",
        ...(silent ? { _contentAvailable: true } : { title, body, sound: "default" as const }),
        data: { type, ...(data ?? {}) },
        ...(richContent ? { richContent } : {}),
        ...(needsMutation ? { mutableContent: true } : {}),
      };

      const tickets = await expo.sendPushNotificationsAsync([message]);
      const ticket = tickets[0];
      if (ticket?.status === "error") {
        // Token is dead — remove it so clients re-register on next launch.
        if (ticket.details?.error === "DeviceNotRegistered") {
          await rtdb().ref(`notificationTokens/${firebaseUID}`).remove();
        }
        return res.json({ ok: true, data: { delivered: false, reason: ticket.details?.error ?? "EXPO_ERROR" } });
      }

      res.json({ ok: true, data: { delivered: true } });
    } catch (error) {
      console.error("[relay/push]", error);
      sendError(res, 500, "INTERNAL", "Push relay failed.");
    }
  });
}
