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

// Phase 10: identity badges (staff / early-access / founder / debug) are
// account-level, not gameplay achievements, so they live in central Firebase
// and follow the player across shards — unlike league badges, which stay in
// each shard's Postgres `Statistics.badges`. Stored as a set under
// /profiles/<uid>/identityBadges/<Badge> = true so grant/revoke is atomic per
// badge and clients read it with their existing /profiles read access
// (writes are admin-SDK-only per rtdbrules.json). Assigned via the admin
// portal; the known set is fixed so the app always has matching artwork.
export const KNOWN_IDENTITY_BADGES = ["Founder", "Staff", "Early", "Debug"] as const;
export type IdentityBadge = (typeof KNOWN_IDENTITY_BADGES)[number];

export function isKnownIdentityBadge(badge: string): badge is IdentityBadge {
  return (KNOWN_IDENTITY_BADGES as readonly string[]).includes(badge);
}

export async function getIdentityBadges(uid: string): Promise<string[]> {
  if (!firebaseAvailable()) return [];
  try {
    const snap = await rtdb().ref(`profiles/${uid}/identityBadges`).get();
    if (!snap.exists()) return [];
    const val = snap.val() as Record<string, unknown>;
    return Object.entries(val)
      .filter(([, granted]) => granted === true)
      .map(([badge]) => badge);
  } catch (error) {
    console.error(`[social] identity-badge read failed for ${uid}:`, (error as Error).message);
    return [];
  }
}

// Phase: staff/debug authorization is Firebase-authoritative. A user is "staff"
// (gets debug-menu + privileged backend ops) if they hold the Staff or Debug
// identity badge. The coordinator stamps this into the minted shard JWT so the
// shard can authorize without Firebase creds of its own.
export async function isStaffUid(uid: string): Promise<boolean> {
  const badges = await getIdentityBadges(uid);
  return badges.includes("Staff") || badges.includes("Debug");
}

// THROWS on failure: an admin grant/revoke must not silently succeed.
export async function setIdentityBadge(uid: string, badge: IdentityBadge, granted: boolean): Promise<void> {
  if (!firebaseAvailable()) throw new Error("Firebase Admin credentials are not configured");
  await rtdb().ref(`profiles/${uid}/identityBadges/${badge}`).set(granted ? true : null);
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
