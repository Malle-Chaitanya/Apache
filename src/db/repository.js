// ─────────────────────────────────────────────────────────────
// Repository layer — one interface, two adapters:
//   - MemoryAdapter  (in-process; zero dependencies; for demo/dev)
//   - MongoAdapter   (Mongoose; the real staging + control plane)
// The engine only ever talks to this interface, so switching stores
// is a config flag (STORE=memory|mongo), never an engine change.
// ─────────────────────────────────────────────────────────────
import { config } from '../config.js';
import { CONTROL_COLLECTIONS, STAGING_COLLECTIONS, EntitySchema } from './schemas.js';

// Naive query matcher shared by the memory adapter. Supports top-level
// equality and { $in: [...] } — the only shapes the engine uses.
function matches(doc, query) {
  return Object.entries(query).every(([k, v]) => {
    const dv = doc[k];
    if (v && typeof v === 'object' && Array.isArray(v.$in)) return v.$in.map(String).includes(String(dv));
    return String(dv) === String(v);
  });
}

let _oid = 0;
const newId = () => `mem_${Date.now().toString(36)}_${(_oid++).toString(36)}`;

class MemoryAdapter {
  constructor() { this.cols = new Map(); }
  _col(name) { if (!this.cols.has(name)) this.cols.set(name, new Map()); return this.cols.get(name); }

  async insertOne(name, doc) {
    const _id = doc._id || newId();
    const rec = { _id, createdAt: new Date(), updatedAt: new Date(), ...doc };
    this._col(name).set(_id, rec);
    return rec;
  }
  async insertMany(name, docs) { return Promise.all(docs.map((d) => this.insertOne(name, d))); }
  async find(name, query = {}, { limit } = {}) {
    const out = [];
    for (const d of this._col(name).values()) { if (matches(d, query)) out.push(d); if (limit && out.length >= limit) break; }
    return out;
  }
  async findOne(name, query = {}) { return (await this.find(name, query, { limit: 1 }))[0] || null; }
  async count(name, query = {}) { return (await this.find(name, query)).length; }
  async updateOne(name, query, patch) {
    const d = await this.findOne(name, query);
    if (!d) return null;
    Object.assign(d, patch, { updatedAt: new Date() });
    return d;
  }
  async upsert(name, query, doc) {
    const existing = await this.findOne(name, query);
    if (existing) { Object.assign(existing, doc, { updatedAt: new Date() }); return existing; }
    return this.insertOne(name, { ...query, ...doc });
  }
  async clear(name) { if (name) this._col(name).clear(); else this.cols.clear(); }
}

class MongoAdapter {
  constructor(mongoose) { this.models = new Map(); this.mongoose = mongoose; }
  _model(name) {
    if (this.models.has(name)) return this.models.get(name);
    const schema = CONTROL_COLLECTIONS[name] || EntitySchema.clone();
    const model = this.mongoose.models[name] || this.mongoose.model(name, schema, name);
    this.models.set(name, model);
    return model;
  }
  async insertOne(name, doc) { return (await this._model(name).create(doc)).toObject(); }
  async insertMany(name, docs) { return (await this._model(name).insertMany(docs)).map((d) => d.toObject()); }
  async find(name, query = {}, { limit } = {}) {
    let q = this._model(name).find(query);
    if (limit) q = q.limit(limit);
    return (await q.lean()).map(normalizeId);
  }
  async findOne(name, query = {}) { const d = await this._model(name).findOne(query).lean(); return d ? normalizeId(d) : null; }
  async count(name, query = {}) { return this._model(name).countDocuments(query); }
  async updateOne(name, query, patch) {
    return normalizeId(await this._model(name).findOneAndUpdate(query, { $set: patch }, { new: true }).lean());
  }
  async upsert(name, query, doc) {
    return normalizeId(await this._model(name).findOneAndUpdate(query, { $set: doc }, { new: true, upsert: true }).lean());
  }
  async clear(name) {
    if (name) return void this._model(name).deleteMany({});
    await Promise.all([...Object.keys(CONTROL_COLLECTIONS), ...STAGING_COLLECTIONS].map((n) => this._model(n).deleteMany({})));
  }
}

const normalizeId = (d) => { if (d && d._id) d._id = String(d._id); return d; };

let adapter = null;

export async function initStore() {
  if (adapter) return adapter;
  if (config.store === 'mongo') {
    const mongoose = (await import('mongoose')).default;
    await mongoose.connect(config.mongoUri);
    adapter = new MongoAdapter(mongoose);
  } else {
    adapter = new MemoryAdapter();
  }
  return adapter;
}

// Bound collection handle so callers write repo('tickets').find(...).
export function repo(name) {
  if (!adapter) throw new Error('Store not initialized — call initStore() first');
  return {
    insertOne: (d) => adapter.insertOne(name, d),
    insertMany: (d) => adapter.insertMany(name, d),
    find: (q, o) => adapter.find(name, q, o),
    findOne: (q) => adapter.findOne(name, q),
    count: (q) => adapter.count(name, q),
    updateOne: (q, p) => adapter.updateOne(name, q, p),
    upsert: (q, d) => adapter.upsert(name, q, d),
    clear: () => adapter.clear(name),
  };
}

export const clearAll = () => adapter.clear();
export const storeKind = () => config.store;
