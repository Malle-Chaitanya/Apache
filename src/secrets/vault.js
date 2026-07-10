import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { repo } from '../db/repository.js';

// ─────────────────────────────────────────────────────────────
// Secrets vault. Credentials (API keys, OAuth refresh tokens) are encrypted
// with AES-256-GCM before they touch the database. The DB stores only a
// `secretRef`; the ciphertext lives in the `secrets` collection.
//
// PRODUCTION: the data-encryption key must come from a KMS (AWS KMS / GCP KMS /
// HashiCorp Vault), not a static env var. `getKey()` is the single swap point —
// replace the env read with a KMS `Decrypt` call and nothing else changes.
// ─────────────────────────────────────────────────────────────

function getKey() {
  const b64 = process.env.MIGRATION_SECRET_KEY;
  if (!b64) throw new Error('MIGRATION_SECRET_KEY is not set (base64-encoded 32 bytes). In production, source this from KMS.');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('MIGRATION_SECRET_KEY must decode to exactly 32 bytes (AES-256).');
  return key;
}

// Pack iv:tag:ciphertext as one base64 string.
export function encrypt(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decrypt(packed) {
  const buf = Buffer.from(packed, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// Store an arbitrary credential object; returns an opaque secretRef.
export async function storeSecret(projectId, side, credentialObj) {
  const ciphertext = encrypt(JSON.stringify(credentialObj));
  const doc = await repo('secrets').upsert(
    { projectId, side },
    { projectId, side, ciphertext, rotatedAt: new Date() },
  );
  return String(doc._id);
}

export async function readSecret(secretRef) {
  const doc = await repo('secrets').findOne({ _id: secretRef });
  if (!doc) throw new Error(`secret not found: ${secretRef}`);
  return JSON.parse(decrypt(doc.ciphertext));
}

// Purge a project's secrets (retention/GDPR on completion).
export async function purgeSecrets(projectId) {
  for (const s of await repo('secrets').find({ projectId })) {
    await repo('secrets').updateOne({ _id: s._id }, { ciphertext: null, purgedAt: new Date() });
  }
}
