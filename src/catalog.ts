// Phase 9 (DISTRIBUTED_HOSTING_PLAN.md): the *coordinator* owns the mapping
// from a store product identifier to what it grants. This must never be the
// client's decision — the old store.tsx read the coin amount out of the
// product description and called /api/addMoney with a client-chosen number,
// which any JWT holder could forge. Here the grant is fixed server-side and
// travels to the shard inside a signed voucher.
//
// Product identifiers match the RevenueCat product ids the app sells (see the
// frontend's api/store.ts `mapProductType`). Coin packs and premium weapons are
// all *consumables*, so they are verified against the subscriber's
// non-subscription transaction list, not entitlements.

export type Grant =
  | { kind: "coins"; amount: number }
  // The shard resolves the inventory category itself (resolveItemCategory),
  // so the voucher only needs to name the item — that keeps a single source of
  // truth for Missiles/Landmines/Other on the shard and avoids drift here.
  | { kind: "item"; itemName: string };

const PRODUCT_CATALOG: Record<string, Grant> = {
  Coins500_: { kind: "coins", amount: 500 },
  Coins1000_: { kind: "coins", amount: 1000 },
  Coins2000_: { kind: "coins", amount: 2000 },

  Amplifier: { kind: "item", itemName: "Amplifier" },
  Ballista: { kind: "item", itemName: "Ballista" },
  BigBertha: { kind: "item", itemName: "BigBertha" },
  BunkerBlocker: { kind: "item", itemName: "BunkerBlocker" },
  Buzzard: { kind: "item", itemName: "Buzzard" },
  ClusterBomb: { kind: "item", itemName: "ClusterBomb" },
  CorporateRaider: { kind: "item", itemName: "CorporateRaider" },
  GutShot: { kind: "item", itemName: "GutShot" },
  ShieldBreaker: { kind: "item", itemName: "ShieldBreaker" },
  Zippy: { kind: "item", itemName: "Zippy" },
};

export function resolveGrant(productId: string): Grant | null {
  return PRODUCT_CATALOG[productId] ?? null;
}
