import { firebaseAvailable, rtdb } from "./firebase";

// Phase 4: the coordinator is the write authority for profile bootstrap.
// Whenever it mints a token it upserts /profiles/<uid> in central RTDB —
// username and last-known shard id. This is what cross-shard friend presence
// reads (clients fetch a friend's profile directly, per rtdbrules.json),
// instead of every shard duplicating friend lists.
//
// Non-fatal by design: token minting must keep working when Firebase is
// unreachable or unconfigured (local development uses the in-memory store).

export async function bootstrapProfile(uid: string, username: string, shardId: string): Promise<void> {
  if (!firebaseAvailable()) return;
  try {
    await rtdb().ref(`profiles/${uid}`).update({
      username,
      lastShardId: shardId,
      updatedAt: Date.now(),
    });
  } catch (error) {
    console.error(`[social] profile bootstrap failed for ${uid}:`, (error as Error).message);
  }
}
