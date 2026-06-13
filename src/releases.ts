import { compareSemver, isAtLeast } from "./semver";
import type { BackendRelease, ShardUpdateStatus } from "./store";

// Phase 12: decide what a shard should do given its reported version and the
// latest approved release. Versions are compared numerically (never as strings)
// and optional/gradual rollout is gated by a stable hash of the shard id so the
// same shards are picked consistently across heartbeats.

function rolloutBucket(shardId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < shardId.length; i++) {
    hash ^= shardId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100;
}

export function computeUpdateStatus(
  shardId: string,
  shardVersion: string | undefined,
  release: BackendRelease | null
): ShardUpdateStatus {
  if (!release) return "current";
  // Below the mandatory floor → must update (also hidden from discovery).
  if (!isAtLeast(shardVersion, release.minimumSupportedVersion)) {
    return "update_required";
  }
  // At or ahead of the latest → nothing to do.
  if (compareSemver(shardVersion, release.version) >= 0) return "current";
  // Behind the latest but above the floor → optional, gated by rollout %.
  const rollout = release.rolloutPercent ?? 100;
  if (rollout >= 100 || rolloutBucket(shardId) < rollout) return "update_available";
  return "current";
}

// True when the shard is below the mandatory floor — used by discovery to hide
// outdated shards from player routing until they update.
export function isUpdateRequired(
  shardVersion: string | undefined,
  release: BackendRelease | null
): boolean {
  if (!release) return false;
  return !isAtLeast(shardVersion, release.minimumSupportedVersion);
}
