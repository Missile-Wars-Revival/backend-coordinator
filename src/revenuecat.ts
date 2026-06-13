import { env, requireRevenueCatKey } from "./env";

// Phase 9: server-side purchase verification via the RevenueCat REST API. The
// coordinator is the only holder of the secret key. We look the subscriber up
// by their app_user_id — which the app sets to the firebaseUID via
// Purchases.logIn(firebaseUID) — and read the *non-subscription* transactions
// (coin packs and premium weapons are consumables, not entitlements).
//
// https://www.revenuecat.com/docs/api-v1#tag/customers/operation/subscribers

export interface RcTransaction {
  // RevenueCat's own transaction id and the underlying store transaction id.
  // We dedupe on the store transaction id when present (one real purchase),
  // falling back to RevenueCat's id.
  id: string;
  storeTransactionId: string | null;
  purchaseDateMs: number;
}

interface RcNonSubscription {
  id?: string;
  store_transaction_id?: string;
  purchase_date?: string;
}

interface RcSubscriberResponse {
  subscriber?: {
    non_subscriptions?: Record<string, RcNonSubscription[]>;
  };
}

// Returns the subscriber's non-subscription transactions for a single product,
// newest first. Empty when the user never bought that product. Throws on an
// auth/transport error so the caller can surface a 502 rather than silently
// treating a verification outage as "no purchase".
export async function getNonSubscriptionTransactions(
  appUserId: string,
  productId: string
): Promise<RcTransaction[]> {
  const key = requireRevenueCatKey();
  const url = `${env.REVENUECAT_API_BASE}/v1/subscribers/${encodeURIComponent(appUserId)}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    // 404 means RevenueCat has never seen this app_user_id — treat as "no
    // purchases" rather than an error so a brand-new account redeeming nothing
    // gets a clean NO_PURCHASE, not a 502.
    if (response.status === 404) return [];
    const text = await response.text().catch(() => "");
    throw new Error(`RevenueCat API ${response.status}: ${text.slice(0, 200)}`);
  }

  const body = (await response.json()) as RcSubscriberResponse;
  const list = body.subscriber?.non_subscriptions?.[productId] ?? [];

  return list
    .map((tx) => ({
      id: tx.id ?? "",
      storeTransactionId: tx.store_transaction_id ?? null,
      purchaseDateMs: tx.purchase_date ? Date.parse(tx.purchase_date) : 0,
    }))
    .filter((tx) => Boolean(tx.storeTransactionId || tx.id))
    .sort((a, b) => b.purchaseDateMs - a.purchaseDateMs);
}

export function transactionId(tx: RcTransaction): string {
  return tx.storeTransactionId || tx.id;
}
