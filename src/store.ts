import { createHash } from "crypto";
import { env } from "./env";
import { firebaseAvailable, rtdb } from "./firebase";

// Coordinator control-plane state, backed by Firebase RTDB under /coordinator/*.
// Those paths are locked to the Admin SDK by rtdbrules.json — clients never
// read or write them directly. A volatile in-memory store is used as a local
// development fallback when Firebase credentials are not configured.

export type ShardStatus = "pending" | "active" | "disabled";

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
  lat?: number;
  lon?: number;
  lastHeartbeatAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface SessionRecord {
  userId: string;
  username: string;
  shardId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface Store {
  createShard(shard: ShardRecord): Promise<void>;
  getShard(id: string): Promise<ShardRecord | null>;
  getShardIdByKeyHash(apiKeyHash: string): Promise<string | null>;
  getShardIdByName(nameLower: string): Promise<string | null>;
  listShards(): Promise<ShardRecord[]>;
  updateShard(id: string, patch: Partial<ShardRecord>): Promise<void>;
  rotateShardKey(id: string, oldKeyHash: string, newKeyHash: string): Promise<void>;
  addSession(session: SessionRecord): Promise<void>;
}

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

// ---------------------------------------------------------------- RTDB store

const SHARDS = "coordinator/shards";
const KEY_INDEX = "coordinator/shardKeyIndex";
const NAME_INDEX = "coordinator/shardNameIndex";
const SESSIONS = "coordinator/sessions";

class RtdbStore implements Store {
  async createShard(shard: ShardRecord): Promise<void> {
    // Multi-path update keeps the record and both indexes consistent.
    await rtdb()
      .ref()
      .update({
        [`${SHARDS}/${shard.id}`]: shard,
        [`${KEY_INDEX}/${shard.apiKeyHash}`]: shard.id,
        [`${NAME_INDEX}/${nameKey(shard.name)}`]: shard.id,
      });
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

  async createShard(shard: ShardRecord): Promise<void> {
    this.shards.set(shard.id, shard);
    this.keyIndex.set(shard.apiKeyHash, shard.id);
    this.nameIndex.set(nameKey(shard.name), shard.id);
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
