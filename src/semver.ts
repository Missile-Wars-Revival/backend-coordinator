// Phase 12: minimal semantic-version comparison for shard auto-update policy.
// We compare versions, never strings — "1.10.0" must outrank "1.9.0". Only the
// numeric major.minor.patch core is used; a pre-release suffix (e.g. -rc.1) is
// stripped and ignored, which is fine for the release-gating decisions here.

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemver(version: string | undefined | null): SemVer | null {
  if (typeof version !== "string") return null;
  const core = version.trim().replace(/^v/i, "").split(/[-+]/)[0] ?? "";
  const parts = core.split(".");
  if (parts.length < 1) return null;
  const major = Number(parts[0]);
  const minor = Number(parts[1] ?? "0");
  const patch = Number(parts[2] ?? "0");
  if (![major, minor, patch].every((n) => Number.isInteger(n) && n >= 0)) return null;
  return { major, minor, patch };
}

// Returns <0 if a<b, 0 if equal, >0 if a>b. Unparseable versions sort lowest
// so a shard reporting a garbage version is treated as "behind".
export function compareSemver(a: string | undefined | null, b: string | undefined | null): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}

export function isAtLeast(version: string | undefined | null, minimum: string | undefined | null): boolean {
  if (!minimum) return true;
  return compareSemver(version, minimum) >= 0;
}
