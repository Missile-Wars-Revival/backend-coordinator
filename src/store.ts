import { createHash } from "crypto";
import { env } from "./env";
import { firebaseAvailable, rtdb } from "./firebase";

// Coordinator control-plane state, backed by Firebase RTDB under /coordinator/*.
// Those paths are locked to the Admin SDK by rtdbrules.json — clients never
// read or write them directly. A volatile in-memory store is used as a local
// development fallback when Firebase credentials are not configured.

export type ShardStatus = "pending" | "active" | "offline" | "disabled";

export interface ShardRecord {
  id: string;
  name: string;
  description?: string;
  region: string;
  publicHttpUrl: string;
  publicWsUrl: string;
  ownerContact?: string;
  apiKeyHash: string;
  status: ShardStatus;
  verified: boolean;
  version?: string;
  gitSha?: string;
  playerCount: number;
  totalPlayerCount?: number;
  lat?: number;
  lon?: number;
  lastHeartbeatAt?: number;
  createdAt: number;
  updatedAt: number;
  // Phase 12 shard auto-update. updateStatus is recomputed from version vs the
  // latest release on each heartbeat and stored for admin visibility.
  // updateRequested is an admin "update on next heartbeat" flag, cleared once
  // the coordinator has told the shard. The lastUpdate* fields are reported
  // BY the shard's update agent.
  updateStatus?: ShardUpdateStatus;
  updateRequested?: boolean;
  autoUpdate?: boolean;
  lastUpdateAttemptAt?: number;
  lastUpdateError?: string;
}

export type ShardUpdateStatus = "current" | "update_available" | "update_required" | "blocked";

// Phase 12: the latest approved backend release, stored under
// /coordinator/releases/backend/latest. `version` is the source of truth
// (`backend/package.json`); the rest gate and describe the rollout.
export interface BackendRelease {
  version: string;
  gitSha?: string;
  imageDigest?: string;
  // Shards below this are hidden from discovery until they update (mandatory).
  minimumSupportedVersion?: string;
  // 0-100. Optional/gradual rollout for non-mandatory releases; a shard is in
  // the rollout when a stable hash of its id falls under this percentage.
  rolloutPercent?: number;
  migrationRequired?: boolean;
  // `critical` releases may update even while players are connected.
  critical?: boolean;
  publishedAt: number;
}

export interface SessionRecord {
  userId: string;
  username: string;
  shardId: string;
  issuedAt: number;
  expiresAt: number;
}

// Phase 7: per-user record of which shards they have played on, written only
// by the coordinator (Admin SDK) on every token mint. The display fields are
// snapshots so the selector can still render a server that has since gone
// offline or been delisted.
export interface ServerHistoryEntry {
  shardId: string;
  firstUsedAt: number;
  lastUsedAt: number;
  useCount: number;
  lastServerName: string;
  lastRegion: string;
  lastVerified: boolean;
}

export interface Store {
  createShard(shard: ShardRecord): Promise<boolean>;
  getShard(id: string): Promise<ShardRecord | null>;
  getShardIdByKeyHash(apiKeyHash: string): Promise<string | null>;
  getShardIdByName(nameLower: string): Promise<string | null>;
  listShards(): Promise<ShardRecord[]>;
  updateShard(id: string, patch: Partial<ShardRecord>): Promise<void>;
  rotateShardKey(id: string, oldKeyHash: string, newKeyHash: string): Promise<void>;
  addSession(session: SessionRecord): Promise<void>;
  recordServerUse(userId: string, shard: ShardRecord): Promise<void>;
  getServerHistory(userId: string): Promise<ServerHistoryEntry[]>;
  // Phase 8 coordinator-only auth: global username uniqueness. Claims are
  // keyed on the lowercased username; returns true when the name is now (or
  // was already) owned by this uid, false when another uid holds it.
  claimUsername(usernameLower: string, userId: string): Promise<boolean>;
  getUsernameClaim(usernameLower: string): Promise<string | null>;
  // Phase 12 release metadata + shard lifecycle.
  getLatestRelease(): Promise<BackendRelease | null>;
  setLatestRelease(release: BackendRelease): Promise<void>;
  // Permanently removes a shard and all coordinator-owned metadata for it
  // (record, key/name index, and serverHistory entries across all users).
  deleteShard(shard: ShardRecord): Promise<void>;
  // Phase 9 payment migration: a one-redemption-per-purchase ledger keyed on
  // the RevenueCat/store transaction id. Returns "claimed" when this call won
  // the txId, "owned-self" when the same user already redeemed it onto the same
  // shard (idempotent voucher re-mint after a failed shard credit), and
  // "owned-other" when it was redeemed onto a different shard (shards are
  // separate worlds — a purchase is spent in exactly one).
  claimPurchase(txId: string, record: PurchaseRecord): Promise<PurchaseClaimResult>;
}

export type PurchaseClaimResult = "claimed" | "owned-self" | "owned-other";

export interface PurchaseRecord {
  txId: string;
  userId: string;
  shardId: string;
  productId: string;
  grantKind: string;
  grantAmount?: number;
  grantItem?: string;
  redeemedAt: number;
}

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

// ---------------------------------------------------------------- RTDB store

const SHARDS = "coordinator/shards";
const KEY_INDEX = "coordinator/shardKeyIndex";
const NAME_INDEX = "coordinator/shardNameIndex";
const SESSIONS = "coordinator/sessions";
const USERS = "coordinator/users";
const USERNAME_INDEX = "coordinator/usernameIndex";
const PURCHASES = "coordinator/purchases";
const RELEASE_LATEST = "coordinator/releases/backend/latest";

// RevenueCat store transaction ids can contain "." (and other characters RTDB
// forbids in keys), so they are not safe as raw RTDB keys. Hash to a stable
// fixed-length key. Collisions are cryptographically negligible.
function purchaseKey(txId: string): string {
  return createHash("sha256").update(txId).digest("hex");
}

// userId is a firebaseUID or "user:<username>" for legacy accounts; the colon
// is a legal RTDB key character, so both forms can be used as-is.
function historyPath(userId: string, shardId: string): string {
  return `${USERS}/${userId}/serverHistory/${shardId}`;
}

function sortHistory(entries: ServerHistoryEntry[]): ServerHistoryEntry[] {
  return entries.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

class RtdbStore implements Store {
  async createShard(shard: ShardRecord): Promise<boolean> {
    const nameIndexRef = rtdb().ref(`${NAME_INDEX}/${nameKey(shard.name)}`);
    const claim = await nameIndexRef.transaction((current) => current ?? shard.id);
    if (!claim.committed || claim.snapshot.val() !== shard.id) {
      return false;
    }

    try {
      await rtdb()
        .ref()
        .update({
          [`${SHARDS}/${shard.id}`]: shard,
          [`${KEY_INDEX}/${shard.apiKeyHash}`]: shard.id,
        });
      return true;
    } catch (error) {
      await nameIndexRef.transaction((current) => (current === shard.id ? null : current));
      throw error;
    }
  }

  async getShard(id: string): Promise<ShardRecord | null> {
    const snap = await rtdb().ref(`${SHARDS}/${id}`).get();
    return snap.exists() ? (snap.val() as ShardRecord) : null;
  }

  async getShardIdByKeyHash(apiKeyHash: string): Promise<string | null> {
    const snap = await rtdb().ref(`${KEY_INDEX}/${apiKeyHash}`).get();
    return snap.exists() ? (snap.val() as string) : null;
  }

  async getShardIdByName(nameLower: string): Promise<string | null> {
    const snap = await rtdb().ref(`${NAME_INDEX}/${nameKey(nameLower)}`).get();
    return snap.exists() ? (snap.val() as string) : null;
  }

  async listShards(): Promise<ShardRecord[]> {
    const snap = await rtdb().ref(SHARDS).get();
    if (!snap.exists()) return [];
    return Object.values(snap.val() as Record<string, ShardRecord>);
  }

  async updateShard(id: string, patch: Partial<ShardRecord>): Promise<void> {
    await rtdb().ref(`${SHARDS}/${id}`).update({ ...patch, updatedAt: Date.now() });
  }

  async rotateShardKey(id: string, oldKeyHash: string, newKeyHash: string): Promise<void> {
    await rtdb()
      .ref()
      .update({
        [`${KEY_INDEX}/${oldKeyHash}`]: null,
        [`${KEY_INDEX}/${newKeyHash}`]: id,
        [`${SHARDS}/${id}/apiKeyHash`]: newKeyHash,
        [`${SHARDS}/${id}/updatedAt`]: Date.now(),
      });
  }

  async addSession(session: SessionRecord): Promise<void> {
    await rtdb().ref(SESSIONS).push(session);
  }

  async recordServerUse(userId: string, shard: ShardRecord): Promise<void> {
    const now = Date.now();
    await rtdb()
      .ref(historyPath(userId, shard.id))
      .transaction((current: Partial<ServerHistoryEntry> | null) => ({
        firstUsedAt: current?.firstUsedAt ?? now,
        lastUsedAt: now,
        useCount: (current?.useCount ?? 0) + 1,
        lastServerName: shard.name,
        lastRegion: shard.region,
        lastVerified: shard.verified,
      }));
  }

  async getServerHistory(userId: string): Promise<ServerHistoryEntry[]> {
    const snap = await rtdb().ref(`${USERS}/${userId}/serverHistory`).get();
    if (!snap.exists()) return [];
    const raw = snap.val() as Record<string, Omit<ServerHistoryEntry, "shardId">>;
    return sortHistory(Object.entries(raw).map(([shardId, entry]) => ({ ...entry, shardId })));
  }

  async claimUsername(usernameLower: string, userId: string): Promise<boolean> {
    const claim = await rtdb()
      .ref(`${USERNAME_INDEX}/${usernameLower}`)
      .transaction((current) => (current === null || current === userId ? userId : undefined));
    return claim.committed && claim.snapshot.val() === userId;
  }

  async getUsernameClaim(usernameLower: string): Promise<string | null> {
    const snap = await rtdb().ref(`${USERNAME_INDEX}/${usernameLower}`).get();
    return snap.exists() ? (snap.val() as string) : null;
  }

  async claimPurchase(txId: string, record: PurchaseRecord): Promise<PurchaseClaimResult> {
    const result = await rtdb()
      .ref(`${PURCHASES}/${purchaseKey(txId)}`)
      // Returning undefined aborts the transaction (keeps the existing value);
      // returning the record claims an unredeemed txId.
      .transaction((current: PurchaseRecord | null) => (current === null ? record : undefined));

    if (result.committed) return "claimed";
    const current = result.snapshot.val() as PurchaseRecord | null;
    if (current && current.shardId === record.shardId && current.userId === record.userId) {
      return "owned-self";
    }
    return "owned-other";
  }

  async getLatestRelease(): Promise<BackendRelease | null> {
    const snap = await rtdb().ref(RELEASE_LATEST).get();
    return snap.exists() ? (snap.val() as BackendRelease) : null;
  }

  async setLatestRelease(release: BackendRelease): Promise<void> {
    await rtdb().ref(RELEASE_LATEST).set(release);
  }

  async deleteShard(shard: ShardRecord): Promise<void> {
    // Remove the record, key index, and name index atomically.
    await rtdb()
      .ref()
      .update({
        [`${SHARDS}/${shard.id}`]: null,
        [`${KEY_INDEX}/${shard.apiKeyHash}`]: null,
        [`${NAME_INDEX}/${nameKey(shard.name)}`]: null,
      });

    // Sweep this shard out of every user's server history so it stops showing
    // up in Continue/Recent as an unavailable entry. Best-effort: a failure
    // here must not leave the shard record half-deleted (already gone above).
    try {
      const usersSnap = await rtdb().ref(USERS).get();
      if (usersSnap.exists()) {
        const updates: Record<string, null> = {};
        for (const userId of Object.keys(usersSnap.val() as Record<string, unknown>)) {
          updates[`${USERS}/${userId}/serverHistory/${shard.id}`] = null;
        }
        if (Object.keys(updates).length > 0) {
          await rtdb().ref().update(updates);
        }
      }
    } catch (error) {
      console.error(`[store] serverHistory sweep failed for deleted shard ${shard.id}:`, (error as Error).message);
    }
  }
}

// RTDB keys cannot contain . $ # [ ] / — normalize shard names for the index.
function nameKey(name: string): string {
  return name.toLowerCase().trim().replace(/[.$#[\]/\s]+/g, "-");
}

// ------------------------------------------------------------- memory store

class MemoryStore implements Store {
  private shards = new Map<string, ShardRecord>();
  private keyIndex = new Map<string, string>();
  private nameIndex = new Map<string, string>();
  private sessions: SessionRecord[] = [];
  private serverHistory = new Map<string, Map<string, ServerHistoryEntry>>();
  private usernameIndex = new Map<string, string>();
  private purchases = new Map<string, PurchaseRecord>();
  private latestRelease: BackendRelease | null = null;

  async createShard(shard: ShardRecord): Promise<boolean> {
    const key = nameKey(shard.name);
    if (this.nameIndex.has(key)) return false;
    this.shards.set(shard.id, shard);
    this.keyIndex.set(shard.apiKeyHash, shard.id);
    this.nameIndex.set(key, shard.id);
    return true;
  }

  async getShard(id: string): Promise<ShardRecord | null> {
    return this.shards.get(id) ?? null;
  }

  async getShardIdByKeyHash(apiKeyHash: string): Promise<string | null> {
    return this.keyIndex.get(apiKeyHash) ?? null;
  }

  async getShardIdByName(nameLower: string): Promise<string | null> {
    return this.nameIndex.get(nameKey(nameLower)) ?? null;
  }

  async listShards(): Promise<ShardRecord[]> {
    return [...this.shards.values()];
  }

  async updateShard(id: string, patch: Partial<ShardRecord>): Promise<void> {
    const existing = this.shards.get(id);
    if (!existing) return;
    this.shards.set(id, { ...existing, ...patch, updatedAt: Date.now() });
  }

  async rotateShardKey(id: string, oldKeyHash: string, newKeyHash: string): Promise<void> {
    this.keyIndex.delete(oldKeyHash);
    this.keyIndex.set(newKeyHash, id);
    await this.updateShard(id, { apiKeyHash: newKeyHash });
  }

  async addSession(session: SessionRecord): Promise<void> {
    this.sessions.push(session);
  }

  async recordServerUse(userId: string, shard: ShardRecord): Promise<void> {
    const now = Date.now();
    const userHistory = this.serverHistory.get(userId) ?? new Map<string, ServerHistoryEntry>();
    const current = userHistory.get(shard.id);
    userHistory.set(shard.id, {
      shardId: shard.id,
      firstUsedAt: current?.firstUsedAt ?? now,
      lastUsedAt: now,
      useCount: (current?.useCount ?? 0) + 1,
      lastServerName: shard.name,
      lastRegion: shard.region,
      lastVerified: shard.verified,
    });
    this.serverHistory.set(userId, userHistory);
  }

  async getServerHistory(userId: string): Promise<ServerHistoryEntry[]> {
    return sortHistory([...(this.serverHistory.get(userId)?.values() ?? [])]);
  }

  async claimUsername(usernameLower: string, userId: string): Promise<boolean> {
    const owner = this.usernameIndex.get(usernameLower);
    if (owner && owner !== userId) return false;
    this.usernameIndex.set(usernameLower, userId);
    return true;
  }

  async getUsernameClaim(usernameLower: string): Promise<string | null> {
    return this.usernameIndex.get(usernameLower) ?? null;
  }

  async claimPurchase(txId: string, record: PurchaseRecord): Promise<PurchaseClaimResult> {
    const current = this.purchases.get(txId);
    if (!current) {
      this.purchases.set(txId, record);
      return "claimed";
    }
    if (current.shardId === record.shardId && current.userId === record.userId) {
      return "owned-self";
    }
    return "owned-other";
  }

  async getLatestRelease(): Promise<BackendRelease | null> {
    return this.latestRelease;
  }

  async setLatestRelease(release: BackendRelease): Promise<void> {
    this.latestRelease = release;
  }

  async deleteShard(shard: ShardRecord): Promise<void> {
    this.shards.delete(shard.id);
    this.keyIndex.delete(shard.apiKeyHash);
    this.nameIndex.delete(nameKey(shard.name));
    for (const history of this.serverHistory.values()) {
      history.delete(shard.id);
    }
  }
}

// ------------------------------------------------------------------ factory

let store: Store | null = null;

export function getStore(): Store {
  if (store) return store;
  if (firebaseAvailable()) {
    store = new RtdbStore();
  } else {
    console.warn(
      "[store] Firebase credentials not configured — using a volatile in-memory store. " +
        "This is fine for local development only; set FIREBASE_* env vars for real deployments."
    );
    store = new MemoryStore();
  }
  return store;
}

export function isShardListable(shard: ShardRecord, now = Date.now()): boolean {
  if (shard.status !== "active") return false;
  if (!shard.lastHeartbeatAt) return false;
  return now - shard.lastHeartbeatAt <= env.STALE_HEARTBEAT_SECONDS * 1000;
}

export function isShardOfflineByHeartbeat(shard: ShardRecord, now = Date.now()): boolean {
  if (shard.status !== "active") return false;
  if (!shard.lastHeartbeatAt) return false;
  const offlineAfterMs = env.SHARD_HEARTBEAT_INTERVAL_SECONDS * env.OFFLINE_AFTER_MISSED_HEARTBEATS * 1000;
  return now - shard.lastHeartbeatAt > offlineAfterMs;
}

export async function reconcileOfflineShards(shards: ShardRecord[], now = Date.now()): Promise<ShardRecord[]> {
  const store = getStore();
  const reconciled = await Promise.all(
    shards.map(async (shard) => {
      if (!isShardOfflineByHeartbeat(shard, now)) return shard;
      await store.updateShard(shard.id, { status: "offline" });
      return { ...shard, status: "offline" as const, updatedAt: now };
    })
  );
  return reconciled;
}
