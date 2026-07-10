# DB schema v2 — proposal (draft, for review)

Companion to [PRD.md §8](./PRD.md#8-database-schema-mongodb). PRD §8 describes the target
shape; this doc is the gap-closing plan, informed by two references:

1. **GEM_CO** (`AI_Migration/GEM_CO`) — the Gemini→Copilot AI-migration schema: a
   `conversationStore` staging collection with a clean `fetched → migrating → migrated /
   failed / skipped` lifecycle, one doc per unit of work.
2. **CloudFuze content-migration DB** (`cloudfuze` — the flagship Drive/Box/SharePoint file
   migration product, read-only inspection, collection names + field shapes only, no
   customer data). Confirms the same fetch → stage → push → evidence pattern at a much
   larger scale (multi-million-row collections, real parallel workers), plus a few patterns
   our current schema doesn't have yet:
   - a `lock` boolean per work-unit so parallel workers can atomically claim it
     (`UsersContentMigInfo.lock`, `MoveWorkSpaceStatus.loadLockStatus`)
   - denormalized rollup counters per job (`AggregationDetails`, `UsersContentMigInfo`) —
     `processed / inProgress / notProcessed / conflict / retrying / suspended / inQueue` —
     updated with `$inc` on every transition, so a dashboard never runs `count()` over a
     720k-row collection
   - dedicated retry-job records (`FileVersionRetryJobs`, `FolderRetryTracker`) with their
     own progress snapshot, separate from the primary staging record
   - delta/incremental-sync cursor collections (`DriveChangeIdDetails`, `UserDriveChanges`)

## 1. What's already right — keep it

- One staging collection per object type, common envelope (`sourceRaw` / `transformed` /
  `targetId` / `status`) — this is the correct shape, matches both references.
- `idmap` crosswalk as the single source of truth for ID re-mapping, written the instant
  anything loads.
- `conflicts` as a durable, human-resolvable checklist rather than a swallowed error.
- Engine is store-agnostic (`repository.js` adapter) — schema changes below don't touch
  connector code.

## 2. Verified gaps (found in code, not hypothetical)

| # | Gap | Evidence |
|---|---|---|
| G1 | `batches` collection is fully schema'd but never written or read | `extractor.js`, `loader.js` — no `repo('batches')` call anywhere |
| G2 | Extract and load are single-record, sequential, one type at a time — no worker pool despite PRD §12 | `extractor.js:10` `for (const type of EXTRACT_ORDER)`; `loader.js:18` `for (const ent of entities)` |
| G3 | No claim/lock mechanism — nothing stops two workers from double-processing the same record if concurrency is added later | absent from `EntitySchema` |
| G4 | Rate limiter is in-memory, per-process, resets on restart | `rateLimiter.js:3` — plain class instance, no persistence |
| G5 | No live progress counters — `project.stats` is only computed once, in `reconcile()`, at the very end | `orchestrator.js:74-77` |
| G6 | `attachments`, `csat`, `tags` declared in `STAGING_COLLECTIONS` but never fetched or loaded by any connector/extractor code | `schemas.js:140` vs. no matching code in `extractor.js`/`freshdesk/index.js` |
| G7 | Ticket comments/replies have no independent retry state — a failed child reply is logged (`warn`) and dropped; parent ticket still marked `loaded` | `loader.js:45-50` |
| G8 | `mappingRules`/`valueMaps` documented as DB collections in PRD §8.3 but are hardcoded JS (`matrix.js`, `valueMaps.js`) — no per-customer override without a code deploy | `matrix.js:6` — plain exported object, not in `CONTROL_COLLECTIONS` |
| G9 | No delta/incremental-resync support — every run is a full re-extract; Zendesk's cursor export (`/incremental/tickets/cursor.json`, mentioned in PRD §12) isn't modeled anywhere | no cursor field is ever read/written outside the unused `batches.cursor` |

## 3. Proposed schema changes

### 3.1 Entity envelope v2 (extends `EntitySchema`)

Adds the fields needed to make G2/G3/G7 safe to build without another schema migration
later:

```js
export const EntitySchema = new Schema({
  projectId: Schema.Types.ObjectId,
  domain: String,
  entityType: String,
  sourceId: String,
  sourceRaw: Object,
  transformed: Object,
  targetId: String,

  // Fuller lifecycle — see §4 status taxonomy.
  status: {
    type: String,
    default: 'queued',
    enum: ['queued', 'picking', 'extracting', 'extracted', 'transforming', 'transformed',
           'validated', 'loading', 'loaded', 'conflict', 'retrying', 'failed', 'skipped',
           'manual', 'paused', 'cancelled'],
  },

  // Claim/lease — the "picking" mechanism. A worker claims atomically via
  // findOneAndUpdate({ status: 'queued', $or: [{ claim: null }, { 'claim.leaseExpiresAt': { $lt: new Date() } }] },
  //                   { $set: { status: 'picking', claim: { workerId, claimedAt: new Date(), leaseExpiresAt } } })
  // — the filter + atomic update means two workers can never both win the same doc,
  // and a crashed worker's lease expires so the record isn't stuck forever.
  claim: { workerId: String, claimedAt: Date, leaseExpiresAt: Date },

  attempts: { type: Number, default: 0 },
  nextRetryAt: Date,                 // backoff scheduling, per-record (not just per-batch)
  lastError: { at: Date, code: String, message: String },

  dependsOn: [{ entityType: String, sourceId: String }],
  mappingRuleId: String,
  contentHash: String,
  errors: [{ at: Date, code: String, message: String }],
  batchId: Schema.Types.ObjectId,
}, opts);
EntitySchema.index({ projectId: 1, sourceId: 1 }, { unique: true });
EntitySchema.index({ projectId: 1, status: 1, nextRetryAt: 1 });   // worker pickup query
```

This directly answers "picking status" — `picking` is a real, short-lived status a
worker sets the instant it wins the claim, distinct from `queued` (waiting) and
`loading`/`extracting` (worker confirmed and is actively calling the API).

### 3.2 `progressCounters` (new) — fixes G5

One doc per `{ projectId, entityType }`, `$inc`'d on every status transition instead of
ever running `count()` over the staging collection:

```js
export const ProgressCounterSchema = new Schema({
  projectId: Schema.Types.ObjectId,
  entityType: String,
  counts: {
    queued: Number, picking: Number, inProgress: Number, loaded: Number,
    conflict: Number, retrying: Number, failed: Number, skipped: Number,
    manual: Number, cancelled: Number,
  },
  updatedAt: Date,
}, opts);
ProgressCounterSchema.index({ projectId: 1, entityType: 1 }, { unique: true });
```

Dashboard reads this one small doc per type instead of scanning the staging collection —
matters once a tenant has hundreds of thousands of tickets (see `AggregationDetails` /
`UsersContentMigInfo` in the reference DB, which exist for exactly this reason).

### 3.3 `rateLimitState` (new) — fixes G4

Persists the token bucket so it survives restarts and can be shared if extract/load ever
run as more than one process:

```js
export const RateLimitStateSchema = new Schema({
  projectId: Schema.Types.ObjectId,
  platform: String,          // zendesk|freshdesk
  tokens: Number,
  capacity: Number,
  refillPerMs: Number,
  updatedAt: Date,
}, opts);
RateLimitStateSchema.index({ projectId: 1, platform: 1 }, { unique: true });
```

`RateLimiter.acquire()` reads/writes this doc (with a short-lived in-memory cache to
avoid a DB round-trip per call) instead of holding state purely in the class instance.

### 3.4 `deltaCursors` (new) — fixes G9

```js
export const DeltaCursorSchema = new Schema({
  projectId: Schema.Types.ObjectId,
  entityType: String,
  mode: { type: String, default: 'full' },   // full|incremental
  cursor: Object,             // e.g. Zendesk's incremental export cursor token
  lastRunAt: Date,
  nextRunAt: Date,
}, opts);
DeltaCursorSchema.index({ projectId: 1, entityType: 1 }, { unique: true });
```

Needed before "resync tickets updated after cutover" is possible at all — right now a
second run means a full re-extract of everything.

### 3.5 `retryJobs` (new) — fixes G7, generalizes retry beyond per-record `attempts`

Modeled on the reference DB's `FileVersionRetryJobs`/`FolderRetryTracker`: a **bulk** retry
action ("retry all failed tickets", "retry all conflict comments") gets its own trackable
record instead of being invisible:

```js
export const RetryJobSchema = new Schema({
  projectId: Schema.Types.ObjectId,
  entityType: String,
  filter: Object,             // which failed records this retry targets
  status: { type: String, default: 'pending' },  // pending|running|completed
  requestedBy: String,
  startedAt: Date,
  completedAt: Date,
  counts: { total: Number, retried: Number, stillFailing: Number, skipped: Number },
}, opts);
```

### 3.6 `mappingRules` / `valueMaps` as real collections — fixes G8

Seed from `matrix.js`/`valueMaps.js` at boot (keep the JS files as the versioned
*defaults*), but store the live, possibly customer-overridden copy in Mongo, exactly as
PRD §8.3 already describes:

```js
export const MappingRuleSchema = new Schema({
  projectId: Schema.Types.ObjectId,   // null = global default
  sourceEntityType: String,
  targetEntityType: String,
  feasibility: String,
  fieldMap: [{ from: String, to: String }],
  valueMaps: [{ field: String, map: Object }],
  transformer: String,
  version: Number,
}, opts);
```

This is what makes a per-customer field override possible without a code deploy — today
that requires editing `matrix.js` and redeploying.

### 3.7 Phantom collections — fixes G6

Either wire up real fetch/load code for `attachments` (PRD C7 explicitly flags attachment
handling as a real constraint — it needs one, given it's already promised), or drop
`attachments`/`csat`/`tags` from `STAGING_COLLECTIONS` until they're implemented, so the
schema stops describing collections that don't exist in practice. Recommend: implement
`attachments` (tickets without attachments migrated are a visible product gap); drop
`csat`/`tags` from v1 scope and re-add when actually built.

For `ticketComments`: give each comment its own staging doc at extract time (not embedded
in `ticket.sourceRaw.comments`), with its own `status`/`attempts`/`lastError` — so a failed
reply is a first-class retryable record, not a dropped warning.

## 4. Status taxonomy (full lifecycle, replaces the current 7-value enum)

```
queued → picking → extracting → extracted → transforming → transformed → validated
  → loading → loaded
                 ↘ conflict (needs human input, → conflicts collection)
                 ↘ retrying (attempts < max, nextRetryAt set) → back to queued
                 ↘ failed (attempts exhausted)
                 ↘ manual (no create API on target)
                 ↘ skipped
                 ↘ paused / cancelled (user-initiated, project-level pause propagates down)
```

This is the concrete answer to "processed, conflicts, not processed, picking status,
everything" — every one of those is now a named, indexed status value with its own
counter in `progressCounters`, not an inference from `attempts`/`errors`.

## 5. What this does *not* change

- Connector code (`zendesk/index.js`, `freshdesk/index.js`) — unaffected, they already
  return plain arrays/objects.
- `idmap`, `conflicts`, `events`, `reports` — already correctly shaped, no changes.
- The repository adapter interface — new collections just add entries to
  `CONTROL_COLLECTIONS`.

## 6. Sequencing note (not schema, but blocks it)

None of §3.1–3.3 (claim/lease, progress counters, persisted rate limiter) earn their
keep until `extractor.js`/`loader.js` actually run more than one worker concurrently. If
real parallelism isn't being built next, the highest-value fixes to land *first* are the
cheap, no-concurrency-required ones: G6 (attachments), G7 (comment retry state), G8
(DB-backed mapping rules), G9 (delta cursor) — all useful standalone, none require the
worker pool to exist yet.
