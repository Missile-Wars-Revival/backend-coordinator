import * as admin from "firebase-admin";
import { env, hasFirebaseCredentials } from "./env";

// Firebase Admin is the coordinator's only datastore (RTDB) and its identity
// provider (Firebase Auth). There is deliberately no SQL/Prisma here — see
// ../backend/DISTRIBUTED_HOSTING_PLAN.md ("Coordinator has no database of its own").

let initialized = false;

export function initFirebase(): boolean {
  if (initialized) return true;
  if (!hasFirebaseCredentials()) return false;

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: env.FIREBASE_PROJECT_ID,
      clientEmail: env.FIREBASE_CLIENT_EMAIL,
      // Vercel/dotenv store the key with literal \n sequences.
      privateKey: env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, "\n"),
    }),
    databaseURL: env.FIREBASE_DATABASE_URL,
  });
  initialized = true;
  return true;
}

export function firebaseAvailable(): boolean {
  return initialized || hasFirebaseCredentials();
}

export function rtdb(): admin.database.Database {
  if (!initFirebase()) {
    throw new Error("Firebase Admin credentials are not configured");
  }
  return admin.database();
}

export async function verifyFirebaseIdToken(idToken: string) {
  if (!initFirebase()) {
    throw new Error("Firebase Admin credentials are not configured");
  }
  return admin.auth().verifyIdToken(idToken);
}
