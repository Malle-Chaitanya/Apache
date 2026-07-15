// ─────────────────────────────────────────────────────────────
// MongoDB schema (Mongoose) — production v2.
//
// Design (CloudFuze-style): a purpose-built, batch-oriented collection per
// concern. A single flexible "envelope" (EntitySchema) backs every staging
// collection — one per object type (PRD §8.2 Option B) — so payloads stay
// document-shaped and indexes/queries stay clean.
//
// WIRING RULE (fixes the ID-consistency problem): every cross-collection
// reference is a real `ObjectId` with a `ref` to its owning collection. The
// model name equals the collection name (see repository._model), so a ref is
// just the collection name. The repository stringifies ObjectIds on read, so
// the engine always sees string ids while Mongo stores/indexes real ObjectIds
// and `$lookup`/`populate` work correctly. See docs/DB-SCHEMA-V2-PROPOSAL.md.
//
// TENANCY: `appUsers → projects` IS the tenant boundary (PRD §2, "one project
// = one customer"). We deliberately do NOT add separate userWorkspaces/
// userConfig collections — that would be redundant complexity, not scale.
// ─────────────────────────────────────────────────────────────
import mongoose from 'mongoose';

const { Schema } = mongoose;
const opts = { timestamps: true, strict: false };

// A typed, indexed foreign key. `ref` names the owning collection/model.
const ref = (collection) => ({ type: Schema.Types.ObjectId, ref: collection });

// ═══════════════════════════════════════════════════════════════
// Layer 1 — Identity & session
// ═══════════════════════════════════════════════════════════════

// Portal login accounts — people who sign into the dashboard. NOT customer
// end-users. _id.toString() is the appUserId everything else is keyed by.
export const AppUserSchema = new Schema({
  email: { type: String, required: true },   // unique, lowercased/trimmed
  password: String,                           // bcrypt hash (10 rounds) — never plaintext
  name: String,
  role: { type: String, default: 'user', enum: ['admin', 'user'] },
  status: { type: String, default: 'active', enum: ['active', 'disabled'] },
  lastLoginAt: Date,
}, { timestamps: true });
AppUserSchema.index({ email: 1 }, { unique: true });

// Revocable sessions (gemco parity: authSessions/userSessions). JWT alone is
// stateless and can't be revoked; a session row lets us invalidate a token
// before it expires (logout-all, forced re-auth). TTL index auto-reaps expired
// rows so the collection never grows unbounded.
export const AuthSessionSchema = new Schema({
  appUserId: ref('appUsers'),
  jti: String,                 // JWT id embedded in the token
  userAgent: String,
  ip: String,
  expiresAt: Date,
  revokedAt: Date,
}, { timestamps: true });
AuthSessionSchema.index({ appUserId: 1 });
AuthSessionSchema.index({ jti: 1 }, { unique: true });
AuthSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL reaper

// ═══════════════════════════════════════════════════════════════
// Control plane
// ═══════════════════════════════════════════════════════════════

export const ProjectSchema = new Schema({
  appUserId: ref('appUsers'),    // owner — scopes all access
  name: String,
  source: { platform: String, subdomain: String },
  target: { platform: String, domain: String },
  plan: { sourceTier: String, targetTier: String },   // feature/plan gating detection
  options: {
    migrateConfig: { type: Boolean, default: true },
    migrateData: { type: Boolean, default: true },
    dryRun: { type: Boolean, default: false },
  },
  status: { type: String, default: 'created' },        // created|discovering|ready|running|paused|completed|failed
  currentPhase: { type: String, default: 'connect' },
  stats: { totalEntities: Number, migrated: Number, failed: Number, manual: Number },
  retention: { purgeAfterDays: Number, purgedAt: Date }, // staging PII retention (PRD §15)
}, opts);
ProjectSchema.index({ appUserId: 1, createdAt: -1 });

export const ConnectionSchema = new Schema({
  projectId: ref('projects'),
  side: String,                 // source|target
  platform: String,
  authType: String,             // oauth|api_key|api_token|instance_oauth|pat|basic
  secretId: ref('secrets'),     // pointer into SecretService — NEVER the secret itself
  instance: String,             // subdomain / instance identifier
  subdomain: String,
  domain: String,
  instanceUrl: String,
  scopes: [String],
  status: { type: String, default: 'pending' }, // pending|connected|reauth_required|expired
  error: String,
  lastValidatedAt: Date,
  rateLimit: { rpm: Number, burst: Number },
  detectedFeatures: Object,
}, opts);
ConnectionSchema.index({ projectId: 1, side: 1 }, { unique: true });

// Encrypted credentials. Ciphertext only — see src/secrets/secretService.js.
// Two access shapes coexist: SecretService keys by _id; vault.js keys by
// {projectId, side}. Both fields are declared so either path validates; the
// {projectId, side} index is sparse so _id-only secrets don't collide.
export const SecretSchema = new Schema({
  projectId: ref('projects'),
  side: String,
  ciphertext: String,
  rotatedAt: Date,
  purgedAt: Date,
}, opts);
SecretSchema.index({ projectId: 1, side: 1 }, { unique: true, sparse: true });

export const JobSchema = new Schema({
  projectId: ref('projects'),
  mode: { type: String, default: 'full' },  // dry_run|full
  phasesCompleted: [String],
  status: { type: String, default: 'pending' }, // pending|running|paused|completed|failed
  counts: { total: Number, migrated: Number, failed: Number, manual: Number, skipped: Number },
  checkpointId: ref('checkpoints'),
  error: String,
  startedAt: Date,
  finishedAt: Date,
}, opts);
JobSchema.index({ projectId: 1, createdAt: -1 });
JobSchema.index({ status: 1 });

// Resumable orchestrator state (gemco parity: checkpoints). On restart the
// orchestrator loads the latest checkpoint per project and continues instead
// of re-scanning every staging collection to infer where it was.
export const CheckpointSchema = new Schema({
  projectId: ref('projects'),
  jobId: ref('jobs'),
  phase: String,                // connect|discover|extract|transform|validate|load_config|load_data|verify|report
  cursor: Object,               // per-phase resume position
  completedTypes: [String],
  note: String,
}, opts);
CheckpointSchema.index({ projectId: 1, createdAt: -1 });

// The unit of enterprise bulk processing (PRD §8.1 / §12; fixes gap G1 — was
// documented but never modelled). Work is chunked; each batch retries alone.
export const BatchSchema = new Schema({
  projectId: ref('projects'),
  jobId: ref('jobs'),
  entityType: String,
  phase: String,                // extract|transform|load
  cursor: Object,               // pagination position (sourcePage / afterToken)
  size: Number,
  seq: Number,
  status: { type: String, default: 'pending' }, // pending|in_progress|done|failed|retrying
  attempts: { type: Number, default: 0 },
  counts: { in: Number, ok: Number, skipped: Number, failed: Number },
  startedAt: Date,
  finishedAt: Date,
}, opts);
BatchSchema.index({ jobId: 1, status: 1 });
BatchSchema.index({ projectId: 1, entityType: 1, phase: 1 });

// Immutable, append-only audit trail (gemco parity: agentAuditLog; PRD §15).
// Distinct from `events` (operational telemetry): auditLog records
// security-relevant actions — who connected, who ran, who resolved a conflict.
export const AuditLogSchema = new Schema({
  projectId: ref('projects'),
  appUserId: ref('appUsers'),
  action: String,               // connect|run|pause|resume|resolve_conflict|purge|login|logout
  target: String,               // what was acted on
  detail: Object,
  ip: String,
}, { timestamps: true });
AuditLogSchema.index({ projectId: 1, createdAt: -1 });
AuditLogSchema.index({ appUserId: 1, createdAt: -1 });

// ═══════════════════════════════════════════════════════════════
// Staging — one collection per object type, sharing this envelope (v2)
// ═══════════════════════════════════════════════════════════════
export const EntitySchema = new Schema({
  projectId: ref('projects'),
  domain: String,               // data|config
  entityType: String,
  sourceId: String,
  sourceRaw: Object,
  transformed: Object,
  targetId: String,

  // Full lifecycle (PRD §6 state machine + V2 §4). Superset of every status
  // the engine already writes, so existing code stays valid.
  status: {
    type: String,
    default: 'extracted',
    enum: ['queued', 'picking', 'extracting', 'extracted', 'transforming', 'transformed',
           'validated', 'loading', 'loaded', 'conflict', 'retrying', 'failed', 'skipped',
           'manual', 'paused', 'cancelled'],
  },

  // Claim/lease — the atomic "picking" mechanism so parallel workers can never
  // double-process a record, and a crashed worker's lease expires. See V2 §3.1.
  claim: { workerId: String, claimedAt: Date, leaseExpiresAt: Date },

  attempts: { type: Number, default: 0 },
  nextRetryAt: Date,            // per-record backoff scheduling
  lastError: { at: Date, code: String, message: String },

  dependsOn: [{ entityType: String, sourceId: String }],
  mappingRuleId: String,
  contentHash: String,          // idempotency / change detection
  errors: [{ at: Date, code: String, message: String }],
  batchId: ref('batches'),
}, { ...opts, suppressReservedKeysWarning: true }); // `errors` is intentional here
EntitySchema.index({ projectId: 1, sourceId: 1 }, { unique: true });
EntitySchema.index({ projectId: 1, status: 1, nextRetryAt: 1 }); // worker pickup

// ═══════════════════════════════════════════════════════════════
// Crosswalk & mapping
// ═══════════════════════════════════════════════════════════════

export const IdMapSchema = new Schema({
  projectId: ref('projects'),
  entityType: String,
  sourceId: String,
  targetId: String,
  targetType: String,
  preexisting: { type: Boolean, default: false }, // matched an existing target (dedup)
}, opts);
IdMapSchema.index({ projectId: 1, entityType: 1, sourceId: 1 }, { unique: true });

// DB-backed mapping matrix (fixes G8). JS files (matrix.js/valueMaps.js) remain
// the versioned defaults, seeded here at boot; a per-customer override is a row
// with a projectId, so it needs no code deploy.
export const MappingRuleSchema = new Schema({
  projectId: ref('projects'),   // null = global default
  sourceEntityType: String,
  targetEntityType: String,
  feasibility: String,          // auto|transform|manual|not_feasible
  fieldMap: [{ from: String, to: String }],
  valueMaps: [{ field: String, map: Object }],
  transformer: String,          // named deterministic fn
  notes: String,
  version: Number,
}, opts);
MappingRuleSchema.index({ projectId: 1, sourceEntityType: 1 });

export const ValueMapSchema = new Schema({
  projectId: ref('projects'),   // null = global default
  name: String,                 // status|priority|source|field_type
  map: Object,
  version: Number,
}, opts);
ValueMapSchema.index({ projectId: 1, name: 1 });

// ═══════════════════════════════════════════════════════════════
// Scale & resilience (V2 proposal §3.2–3.5)
// ═══════════════════════════════════════════════════════════════

// Denormalized rollup counters — $inc'd on every status transition so a
// dashboard never runs count() over a multi-hundred-thousand-row collection.
export const ProgressCounterSchema = new Schema({
  projectId: ref('projects'),
  entityType: String,
  counts: {
    queued: Number, picking: Number, inProgress: Number, loaded: Number,
    conflict: Number, retrying: Number, failed: Number, skipped: Number,
    manual: Number, cancelled: Number,
  },
}, opts);
ProgressCounterSchema.index({ projectId: 1, entityType: 1 }, { unique: true });

// Persisted token bucket — survives restarts and can be shared across workers.
export const RateLimitStateSchema = new Schema({
  projectId: ref('projects'),
  platform: String,             // zendesk|freshdesk
  tokens: Number,
  capacity: Number,
  refillPerMs: Number,
}, opts);
RateLimitStateSchema.index({ projectId: 1, platform: 1 }, { unique: true });

// Incremental/delta re-sync cursors (fixes G9). Without these every run is a
// full re-extract; this is the prerequisite for "resync tickets after cutover".
export const DeltaCursorSchema = new Schema({
  projectId: ref('projects'),
  entityType: String,
  mode: { type: String, default: 'full' }, // full|incremental
  cursor: Object,               // e.g. Zendesk incremental export token
  lastRunAt: Date,
  nextRunAt: Date,
}, opts);
DeltaCursorSchema.index({ projectId: 1, entityType: 1 }, { unique: true });

// Bulk retry actions ("retry all failed tickets") as trackable records
// (fixes G7 at scale), modelled on the reference DB's FileVersionRetryJobs.
export const RetryJobSchema = new Schema({
  projectId: ref('projects'),
  entityType: String,
  filter: Object,               // which failed records this retry targets
  status: { type: String, default: 'pending' }, // pending|running|completed
  requestedBy: ref('appUsers'),
  startedAt: Date,
  completedAt: Date,
  counts: { total: Number, retried: Number, stillFailing: Number, skipped: Number },
}, opts);
RetryJobSchema.index({ projectId: 1, status: 1 });

// ═══════════════════════════════════════════════════════════════
// Observability & resolution
// ═══════════════════════════════════════════════════════════════

export const ConflictSchema = new Schema({
  projectId: ref('projects'),
  entityType: String,
  sourceId: String,
  kind: String,                 // unmapped_field|no_api|dup_email|value_out_of_range|manual_step|attachment_too_large
  detail: String,
  suggestion: String,
  status: { type: String, default: 'open' }, // open|resolved|manual
  resolvedBy: ref('appUsers'),
  resolvedAt: Date,
}, opts);
ConflictSchema.index({ projectId: 1, status: 1 });

export const EventSchema = new Schema({
  projectId: ref('projects'),
  jobId: ref('jobs'),
  phase: String,
  entityType: String,
  sourceId: String,
  level: String,                // info|warn|error
  message: String,
}, opts);
EventSchema.index({ projectId: 1, createdAt: -1 });

export const ReportSchema = new Schema({
  projectId: ref('projects'),
  jobId: ref('jobs'),
  summary: Object,
}, opts);
ReportSchema.index({ projectId: 1, createdAt: -1 });

// ═══════════════════════════════════════════════════════════════
// Cloud accounts — user-scoped, reusable connected platform accounts
// (GEM_CO "Connect Clouds / Manage Clouds"). Connected ONCE per appUser and
// reused across every migration; credentials are never re-entered. A project
// references one account per side (project.source.accountId / target.accountId).
// ═══════════════════════════════════════════════════════════════
export const CloudAccountSchema = new Schema({
  appUserId: ref('appUsers'),   // owner
  platform: String,             // zendesk|freshdesk|jira|servicenow|freshservice
  authType: String,             // oauth|api_key|api_token|instance_oauth|pat|basic
  secretId: ref('secrets'),     // encrypted creds — NEVER the secret itself
  label: String,                // display name: subdomain / domain / instance URL
  subdomain: String,
  domain: String,
  instanceUrl: String,
  scopes: [String],
  status: { type: String, default: 'connected' }, // pending|connected|reauth_required|expired
  error: String,
  lastValidatedAt: Date,
}, opts);
CloudAccountSchema.index({ appUserId: 1, platform: 1 });

// ═══════════════════════════════════════════════════════════════
// AI migration guide — per-user chat with the right-side assistant
// (GEM_CO parity: chatHistory). One doc per appUser holds the rolling
// message history plus any pending confirmation (e.g. "go live?") so a
// destructive action survives the round-trip between turns. No sessions —
// the JWT-derived appUserId is the key.
// ═══════════════════════════════════════════════════════════════
export const AgentChatSchema = new Schema({
  appUserId: ref('appUsers'),                       // owner — one chat per user
  messages: [{ role: String, content: String, at: Date }],
  pendingAction: Object,                            // { tool, args } awaiting "Yes, proceed"
}, opts);
AgentChatSchema.index({ appUserId: 1 }, { unique: true });

// ═══════════════════════════════════════════════════════════════
// Registries — consumed by the repository adapter & bootstrap
// ═══════════════════════════════════════════════════════════════

// Every control-plane collection gets its own purpose-built schema.
export const CONTROL_COLLECTIONS = {
  // identity & session
  appUsers: AppUserSchema,
  authSessions: AuthSessionSchema,
  // control plane
  projects: ProjectSchema,
  cloudAccounts: CloudAccountSchema,
  connections: ConnectionSchema,
  secrets: SecretSchema,
  jobs: JobSchema,
  checkpoints: CheckpointSchema,
  batches: BatchSchema,
  auditLog: AuditLogSchema,
  // crosswalk & mapping
  idmap: IdMapSchema,
  mappingRules: MappingRuleSchema,
  valueMaps: ValueMapSchema,
  // scale & resilience
  progressCounters: ProgressCounterSchema,
  rateLimitState: RateLimitStateSchema,
  deltaCursors: DeltaCursorSchema,
  retryJobs: RetryJobSchema,
  // observability
  conflicts: ConflictSchema,
  events: EventSchema,
  reports: ReportSchema,
  // AI migration guide
  agentChats: AgentChatSchema,
};

// Staging collections — one per object type, all sharing EntitySchema.
export const STAGING_COLLECTIONS = [
  'tickets', 'ticketComments', 'attachments', 'users', 'organizations',
  'groups', 'agents', 'roles', 'ticketFields', 'ticketForms', 'macros',
  'triggers', 'automations', 'slaPolicies', 'businessHours', 'brands',
  'kbCategories', 'kbFolders', 'kbArticles', 'csat', 'tags',
];

// The complete set the app manages — used by the bootstrap to materialize
// every collection + index on startup (so they all appear in Studio 3T).
export const ALL_COLLECTIONS = [...Object.keys(CONTROL_COLLECTIONS), ...STAGING_COLLECTIONS];
