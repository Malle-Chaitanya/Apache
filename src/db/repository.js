// ─────────────────────────────────────────────────────────────
// Repository layer — one interface, two adapters:
//   - MemoryAdapter  (in-process; zero dependencies; for demo/dev)
//   - MongoAdapter   (Mongoose; the real staging + control plane)
// The engine only ever talks to this interface, so switching stores
// is a config flag (STORE=memory|mongo), never an engine change.
// ─────────────────────────────────────────────────────────────
import { config } from '../config.js';
import { CONTROL_COLLECTIONS, STAGING_COLLECTIONS, ALL_COLLECTIONS, EntitySchema } from './schemas.js';

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
  async ensureCollections() { /* no-op: memory collections are created on first write */ }
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
  async insertOne(name, doc) { return normalizeId((await this._model(name).create(doc)).toObject()); }
  async insertMany(name, docs) { return (await this._model(name).insertMany(docs)).map((d) => normalizeId(d.toObject())); }
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
    await Promise.all(ALL_COLLECTIONS.map((n) => this._model(n).deleteMany({})));
  }

  // Materialize every collection + build its indexes up front, so the full
  // schema is visible in Studio 3T before any data flows (and so unique/TTL
  // indexes exist before the first write races them).
  async ensureCollections() {
    // Do all collections CONCURRENTLY — this runs on every boot (and every dev
    // restart), and a sequential loop over ~25 collections (a createCollection +
    // syncIndexes round-trip each) was the bulk of startup latency. Parallel turns
    // "sum of all round-trips" into "the single slowest one".
    await Promise.all(ALL_COLLECTIONS.map(async (name) => {
      const model = this._model(name);
      try { await model.createCollection(); } catch (e) { if (e.codeName !== 'NamespaceExists') throw e; }
      await model.syncIndexes();
    }));
  }
}

// Mongo returns ObjectId instances (from _id and every `ref` field). The engine
// keys everything by string, and the memory adapter uses string ids — so we
// stringify ALL ObjectId-valued top-level fields on read. This is the fix that
// makes relations wire up consistently across both adapters: Mongo stores real
// ObjectIds (efficient indexes, working $lookup/populate), the engine always
// sees strings, and Mongoose re-casts strings → ObjectId on write/query.
const isObjectId = (v) => v && typeof v === 'object' && typeof v.toHexString === 'function';
const normalizeId = (d) => {
  if (!d || typeof d !== 'object') return d;
  for (const k of Object.keys(d)) if (isObjectId(d[k])) d[k] = String(d[k]);
  return d;
};

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
  await adapter.ensureCollections();
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
