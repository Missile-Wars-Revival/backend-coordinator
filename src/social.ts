import { firebaseAvailable, rtdb } from "./firebase";

// Phase 4: the coordinator is the write authority for profile bootstrap.
// Whenever it mints a token it upserts /profiles/<uid> in central RTDB —
// username and last-known shard id. This is what cross-shard friend presence
// reads (clients fetch a friend's profile directly, per rtdbrules.json),
// instead of every shard duplicating friend lists.
//
// Non-fatal by design: token minting must keep working when Firebase is
// unreachable or unconfigured (local development uses the in-memory store).

// The canonical username for a Firebase account — written by bootstrapProfile
// on every mint and kept current by shard renames (util/socialStore.ts). The
// Phase 7 select-server flow prefers this over Firebase token claims, whose
// `name` is a display name that may never have been a game username.
export async function getProfileUsername(uid: string): Promise<string | null> {
  if (!firebaseAvailable()) return null;
  try {
    const snap = await rtdb().ref(`profiles/${uid}/username`).get();
    const value = snap.exists() ? snap.val() : null;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch (error) {
    console.error(`[social] profile username read failed for ${uid}:`, (error as Error).message);
    return null;
  }
}

// Reverse lookup over existing profiles (exact match; /profiles has
// .indexOn username). The username index only covers Phase 8 claims, so
// availability checks must also consult profiles — every account that ever
// minted a token (or was migrated) has one.
export async function getUidByProfileUsername(username: string): Promise<string | null> {
  if (!firebaseAvailable()) return null;
  const snap = await rtdb()
    .ref("profiles")
    .orderByChild("username")
    .equalTo(username)
    .limitToFirst(1)
    .get();
  if (!snap.exists()) return null;
  const owners = Object.keys(snap.val() as Record<string, unknown>);
  return owners[0] ?? null;
}

// Unlike bootstrapProfile this THROWS on failure: a username claim must not
// report success while the profile (what select-server and other players
// read) still lacks the name.
export async function setProfileUsername(uid: string, username: string): Promise<void> {
  if (!firebaseAvailable()) return;
  await rtdb().ref(`profiles/${uid}`).update({ username, updatedAt: Date.now() });
}

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
