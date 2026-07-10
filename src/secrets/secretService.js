import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { repo } from '../db/repository.js';

// ─────────────────────────────────────────────────────────────
// SecretService — the ONLY thing that touches credentials. The engine and
// ConnectionManager depend on this interface, never on a storage backend.
// Today: MongoEncryptedSecretStore (AES-256-GCM, ciphertext in Mongo).
// Later: AwsSecretsManagerStore / AzureKeyVaultStore / HashiCorpVaultStore —
// swap via SECRET_BACKEND, no engine change.
//
//   engine → ConnectionManager → SecretService → <backend>
//
// Interface: create(cred)→secretId · get(secretId)→cred · update(secretId,cred) · remove(secretId)
// ─────────────────────────────────────────────────────────────

class SecretService {
  async create(_credential) { throw new Error('not implemented'); }
  async get(_secretId) { throw new Error('not implemented'); }
  async update(_secretId, _credential) { throw new Error('not implemented'); }
  async remove(_secretId) { throw new Error('not implemented'); }
}

class MongoEncryptedSecretStore extends SecretService {
  // KMS swap point: replace this env read with a KMS Decrypt / data-key call.
  _key() {
    const b64 = process.env.MIGRATION_SECRET_KEY;
    if (!b64) throw new Error('MIGRATION_SECRET_KEY not set (base64 of 32 bytes). In production source it from a KMS.');
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) throw new Error('MIGRATION_SECRET_KEY must decode to 32 bytes (AES-256).');
    return key;
  }
  _encrypt(plaintext) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this._key(), iv);
    const ct = Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }
  _decrypt(packed) {
    const buf = Buffer.from(packed, 'base64');
    const d = createDecipheriv('aes-256-gcm', this._key(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  }

  async create(credential) {
    const doc = await repo('secrets').insertOne({ ciphertext: this._encrypt(JSON.stringify(credential)), rotatedAt: new Date() });
    return String(doc._id);
  }
  async get(secretId) {
    const doc = await repo('secrets').findOne({ _id: secretId });
    if (!doc || !doc.ciphertext) throw new Error(`secret not found or purged: ${secretId}`);
    return JSON.parse(this._decrypt(doc.ciphertext));
  }
  async update(secretId, credential) {
    await repo('secrets').updateOne({ _id: secretId }, { ciphertext: this._encrypt(JSON.stringify(credential)), rotatedAt: new Date() });
  }
  async remove(secretId) {
    await repo('secrets').updateOne({ _id: secretId }, { ciphertext: null, purgedAt: new Date() });
  }
}

let _svc = null;
export function getSecretService() {
  if (_svc) return _svc;
  const backend = process.env.SECRET_BACKEND || 'mongo';
  switch (backend) {
    case 'mongo': _svc = new MongoEncryptedSecretStore(); break;
    // case 'aws':   _svc = new AwsSecretsManagerStore(); break;
    // case 'vault': _svc = new HashiCorpVaultStore(); break;
    default: throw new Error(`Unknown SECRET_BACKEND: ${backend}`);
  }
  return _svc;
}

export { SecretService };
