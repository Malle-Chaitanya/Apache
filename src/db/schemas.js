// ─────────────────────────────────────────────────────────────
// MongoDB schema (Mongoose). CloudFuze-style: a purpose-built,
// batch-oriented collection per concern. See docs/PRD.md §8.
// A single flexible "envelope" backs every staging collection
// (one per object type — Option B) so payloads stay document-shaped.
// ─────────────────────────────────────────────────────────────
import mongoose from 'mongoose';

const { Schema } = mongoose;
const opts = { timestamps: true, strict: false };

// ── Control-plane ──────────────────────────────────────────────
export const ProjectSchema = new Schema({
  name: String,
  source: { platform: String, subdomain: String },
  target: { platform: String, domain: String },
  options: { migrateConfig: { type: Boolean, default: true }, migrateData: { type: Boolean, default: true }, dryRun: { type: Boolean, default: false } },
  status: { type: String, default: 'created' },        // created|discovering|ready|running|paused|completed|failed
  currentPhase: { type: String, default: 'connect' },
  stats: { totalEntities: Number, migrated: Number, failed: Number, manual: Number },
}, opts);

export const ConnectionSchema = new Schema({
  projectId: Schema.Types.ObjectId,
  side: String,                 // source|target
  platform: String,
  baseUrl: String,
  authType: String,
  secretRef: String,            // NEVER the secret itself
  rateLimit: { rpm: Number },
  detectedFeatures: Object,
}, opts);

export const JobSchema = new Schema({
  projectId: Schema.Types.ObjectId,
  mode: { type: String, default: 'full' },  // dry_run|full
  phasesCompleted: [String],
  status: { type: String, default: 'pending' },
  error: String,
  startedAt: Date,
  finishedAt: Date,
}, opts);

export const BatchSchema = new Schema({
  jobId: Schema.Types.ObjectId,
  projectId: Schema.Types.ObjectId,
  entityType: String,
  phase: String,                // extract|transform|load
  cursor: Object,               // pagination position (resumable)
  seq: Number,
  size: Number,
  status: { type: String, default: 'pending' },
  attempts: { type: Number, default: 0 },
  counts: { in: Number, ok: Number, skipped: Number, failed: Number },
}, opts);

// ── Staging (one collection per object type shares this envelope) ──
export const EntitySchema = new Schema({
  projectId: Schema.Types.ObjectId,
  domain: String,               // data|config
  entityType: String,
  sourceId: String,
  sourceRaw: Object,
  transformed: Object,
  targetId: String,
  status: { type: String, default: 'extracted' }, // extracted|transformed|validated|loaded|skipped|failed|manual
  dependsOn: [{ entityType: String, sourceId: String }],
  mappingRuleId: String,
  contentHash: String,
  errors: [{ at: Date, code: String, message: String }],
  batchId: Schema.Types.ObjectId,
}, opts);
EntitySchema.index({ projectId: 1, sourceId: 1 }, { unique: true });
EntitySchema.index({ projectId: 1, status: 1 });

// ── Crosswalk + mapping ────────────────────────────────────────
export const IdMapSchema = new Schema({
  projectId: Schema.Types.ObjectId,
  entityType: String,
  sourceId: String,
  targetId: String,
  targetType: String,
  preexisting: { type: Boolean, default: false },
}, opts);
IdMapSchema.index({ projectId: 1, entityType: 1, sourceId: 1 }, { unique: true });

export const ConflictSchema = new Schema({
  projectId: Schema.Types.ObjectId,
  entityType: String,
  sourceId: String,
  kind: String,                 // unmapped_field|no_api|dup_email|value_out_of_range|manual_step
  detail: String,
  suggestion: String,
  status: { type: String, default: 'open' }, // open|resolved|manual
}, opts);

export const EventSchema = new Schema({
  projectId: Schema.Types.ObjectId,
  phase: String,
  entityType: String,
  sourceId: String,
  level: String,
  message: String,
}, opts);

export const ReportSchema = new Schema({
  projectId: Schema.Types.ObjectId,
  summary: Object,
}, opts);

// The full set of collections the app manages.
export const CONTROL_COLLECTIONS = {
  projects: ProjectSchema,
  connections: ConnectionSchema,
  jobs: JobSchema,
  batches: BatchSchema,
  idmap: IdMapSchema,
  conflicts: ConflictSchema,
  events: EventSchema,
  reports: ReportSchema,
};

// Staging collections — one per object type (Option B).
export const STAGING_COLLECTIONS = [
  'tickets', 'ticketComments', 'attachments', 'users', 'organizations',
  'groups', 'agents', 'roles', 'ticketFields', 'ticketForms', 'macros',
  'triggers', 'automations', 'slaPolicies', 'businessHours', 'brands',
  'kbCategories', 'kbFolders', 'kbArticles', 'csat', 'tags',
];
