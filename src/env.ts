import "dotenv/config";
import { z } from "zod";

// All coordinator configuration in one place. Values that are only needed by
// specific features (signing keys, admin key, Firebase) are validated lazily
// at the call site so `GET /health` and local development work with a partial
// .env — but every consumer goes through these helpers, never process.env.

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().positive().default(3000),

  // Public base URL of this coordinator — used as the JWT `iss` claim.
  COORDINATOR_PUBLIC_URL: z.string().url().default("http://localhost:3000"),

  // RS256 signing key (PKCS8 PEM, base64-encoded) — generate with `npm run generate-keys`.
  JWT_PRIVATE_KEY_BASE64: z.string().optional(),
  JWT_PUBLIC_KEY_ID: z.string().default("coordinator-key-1"),
  TOKEN_TTL_HOURS: z.coerce.number().positive().default(12),

  // Gate for /admin and /admin/api/*.
  ADMIN_API_KEY: z.string().optional(),

  // Firebase Admin credentials (service-account fields). When unset, the
  // coordinator falls back to an in-memory store for local development.
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  FIREBASE_DATABASE_URL: z
    .string()
    .url()
    .default("https://missile-wars-432403-default-rtdb.firebaseio.com"),

  // A shard whose last heartbeat is older than this is hidden from discovery.
  STALE_HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(120),
});

export const env = EnvSchema.parse(process.env);

export function requireAdminKey(): string {
  if (!env.ADMIN_API_KEY || env.ADMIN_API_KEY.length < 16) {
    throw new Error(
      "ADMIN_API_KEY is unset or shorter than 16 characters — set it in the coordinator environment to use admin routes."
    );
  }
  return env.ADMIN_API_KEY;
}

export function requirePrivateKeyPem(): string {
  if (!env.JWT_PRIVATE_KEY_BASE64) {
    throw new Error(
      "JWT_PRIVATE_KEY_BASE64 is not set — run `npm run generate-keys` and put the private key in the coordinator environment."
    );
  }
  return Buffer.from(env.JWT_PRIVATE_KEY_BASE64, "base64").toString("utf8");
}

export function hasFirebaseCredentials(): boolean {
  return Boolean(env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY);
}
