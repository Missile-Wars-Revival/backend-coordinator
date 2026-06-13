import type { Express, Request, Response } from "express";
import { z } from "zod";
import { resolveGrant, type Grant } from "../catalog";
import { hasRevenueCatKey } from "../env";
import { verifyFirebaseIdToken } from "../firebase";
import { signPurchaseVoucher } from "../keys";
import { sendError } from "../middleware";
import { getNonSubscriptionTransactions, transactionId } from "../revenuecat";
import { getStore, isShardListable, type PurchaseRecord } from "../store";

// Phase 9 (DISTRIBUTED_HOSTING_PLAN.md): real-money purchases are verified
// here, never trusted from the client. The flow:
//
//   1. App buys through RevenueCat (public SDK key, fine to ship).
//   2. App calls POST /purchases/redeem with its Firebase ID token, the
//      product id it bought, and the shard it is playing on.
//   3. The coordinator (sole holder of the RevenueCat *secret* key) confirms a
//      matching non-subscription transaction exists for that firebaseUID,
//      claims it once in the RTDB ledger, and mints a short-lived RS256 grant
//      voucher (aud = shard).
//   4. The app presents the voucher to the shard's /api/redeemPurchase, which
//      verifies it with the JWKS it already caches and credits the player.
//
// The coordinator decides what a product grants (src/catalog.ts) — the client
// never names an amount.

const RedeemSchema = z.object({
  serverId: z.string().min(1),
  productId: z.string().min(1).max(128),
});

function grantToClaims(grant: Grant): Record<string, unknown> {
  return grant.kind === "coins"
    ? { kind: "coins", amount: grant.amount }
    : { kind: "item", itemName: grant.itemName };
}

export function setupPurchaseRoutes(app: Express) {
  app.post("/purchases/redeem", async (req: Request, res: Response) => {
    try {
      const header = req.headers.authorization;
      if (typeof header !== "string" || !header.startsWith("Bearer ")) {
        return sendError(res, 401, "MISSING_ID_TOKEN", "Send a Firebase ID token as 'Authorization: Bearer <token>'.");
      }

      const parsed = RedeemSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(res, 400, "INVALID_BODY", "Body must be { serverId, productId }.");
      }

      const grant = resolveGrant(parsed.data.productId);
      if (!grant) {
        return sendError(res, 400, "UNKNOWN_PRODUCT", "That product is not redeemable.");
      }

      if (!hasRevenueCatKey()) {
        return sendError(res, 503, "PURCHASES_DISABLED", "Purchase verification is not configured on this coordinator.");
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

      // Verify the purchase server-side. Coin packs and premium weapons are
      // consumables → read the non-subscription transaction list, NOT
      // entitlements (the client bug we are deliberately not porting).
      let transactions;
      try {
        transactions = await getNonSubscriptionTransactions(decoded.uid, parsed.data.productId);
      } catch (error) {
        console.error("[purchases/redeem] RevenueCat lookup failed:", (error as Error).message);
        return sendError(res, 502, "VERIFY_FAILED", "Could not verify the purchase right now. Try again shortly.");
      }

      if (transactions.length === 0) {
        return sendError(res, 404, "NO_PURCHASE", "No matching purchase was found for this account.");
      }

      // Newest first: a fresh purchase is an unredeemed txId we claim; a retry
      // after a failed shard credit re-mints the same txId (owned-self). A
      // transaction already spent on another shard is skipped — the player may
      // still have an older unredeemed one for the same consumable product.
      for (const tx of transactions) {
        const txId = transactionId(tx);
        const record: PurchaseRecord = {
          txId,
          userId: decoded.uid,
          shardId: shard.id,
          productId: parsed.data.productId,
          grantKind: grant.kind,
          grantAmount: grant.kind === "coins" ? grant.amount : undefined,
          grantItem: grant.kind === "item" ? grant.itemName : undefined,
          redeemedAt: Date.now(),
        };

        const claim = await store.claimPurchase(txId, record);
        if (claim === "owned-other") continue;

        const { voucher, expiresAt } = await signPurchaseVoucher({
          firebaseUID: decoded.uid,
          shardId: shard.id,
          txId,
          productId: parsed.data.productId,
          grant: grantToClaims(grant),
        });

        return res.json({
          ok: true,
          data: { voucher, expiresAt, alreadyRedeemed: claim === "owned-self" },
        });
      }

      // Every matching transaction is already spent (on this or another shard).
      return sendError(res, 409, "ALREADY_REDEEMED", "This purchase has already been redeemed.");
    } catch (error) {
      console.error("[purchases/redeem]", error);
      sendError(res, 500, "INTERNAL", "Purchase redemption failed.");
    }
  });
}
