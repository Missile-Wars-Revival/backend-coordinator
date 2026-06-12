#!/usr/bin/env node
// Generates the coordinator's RS256 signing keypair and prints the private
// key in the base64 form expected by JWT_PRIVATE_KEY_BASE64. The public key
// is served automatically at /.well-known/jwks.json — nothing to copy there.
const { generateKeyPairSync } = require("crypto");

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

console.log("Add this to the coordinator environment (.env or Vercel):\n");
console.log(`JWT_PRIVATE_KEY_BASE64=${Buffer.from(privateKey).toString("base64")}`);
console.log("\nPublic key (for reference only — shards fetch it from /.well-known/jwks.json):\n");
console.log(publicKey);
