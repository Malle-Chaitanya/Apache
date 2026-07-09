# PRD — ITSM Migrator (Zendesk → Freshdesk)

**Product Requirements Document · v0.1 · 2026-07-09**
**Owner:** Migration Platform Team · **Audience:** Engineering, Product, Sales

---

## Table of contents
1. [Summary & vision](#1-summary--vision)
2. [The enterprise "under-admin" migration model](#2-the-enterprise-under-admin-migration-model)
3. [Goals, non-goals & success metrics](#3-goals-non-goals--success-metrics)
4. [Competitive landscape & differentiation](#4-competitive-landscape--differentiation)
5. [Scope — Zendesk → Freshdesk v1](#5-scope--zendesk--freshdesk-v1)
6. [Solution architecture](#6-solution-architecture)
7. [Tech stack](#7-tech-stack)
8. [Database schema (MongoDB)](#8-database-schema-mongodb)
9. [Object mapping matrix (data + config)](#9-object-mapping-matrix-data--config)
10. [Configuration automation — how we rebuild config](#10-configuration-automation--how-we-rebuild-config)
11. [Write operations in Freshdesk (per object)](#11-write-operations-in-freshdesk-per-object)
12. [Batch / enterprise processing model](#12-batch--enterprise-processing-model)
13. [Constraints & limitations](#13-constraints--limitations)
14. [Solution architecture per hard problem](#14-solution-architecture-per-hard-problem)
15. [Security & compliance](#15-security--compliance)
16. [Delivery roadmap](#16-delivery-roadmap)
17. [Risks & mitigations](#17-risks--mitigations)

---

## 1. Summary & vision

**Problem.** Companies that switch helpdesk platforms (Zendesk → Freshdesk) can pay a vendor to move their *data* (tickets, contacts, KB). But every vendor leaves them to **rebuild the configuration by hand** — the groups, agents, SLAs, ticket fields, forms, automations, macros, business hours, brands. For an enterprise that is weeks of manual admin work and a common reason migrations stall or fail.

**Our product.** A migration platform that moves the **entire application** — *data* **and** *environment/configuration* — from Zendesk to Freshdesk, and **rebuilds the configuration automatically** on the target through a deterministic, rule-driven engine. Runs at enterprise scale (batched, resumable, reconciled), under a single admin credential per side.

**Positioning.** *"Competitors move your tickets. We move your whole helpdesk — including the setup they make you rebuild by hand."*

**Guiding rule.** The write path is **100% deterministic**. No LLM decides what to write or which API to call — a hallucination in a migration means silent data corruption. AI is used only for *assistive, human-approved* tasks (e.g. suggesting a match for an unmapped custom field, or the existing Copilot↔Gemini content-transform on KB bodies), never in the authoritative write path.

---

## 2. The enterprise "under-admin" migration model

This is how enterprise migration differs from a per-user tool.

| | Per-user model (wrong for us) | Enterprise admin model (ours) |
|---|---|---|
| Auth | each user logs in | **one admin credential per side** (account-wide scope) |
| Unit of work | one user's data | **the whole account, migrated in batches** by object type |
| Users/agents | the thing being migrated one-by-one | just **one object type** among many, bulk-migrated |
| Scale | tens of records | 100k–10M+ records; must paginate, throttle, resume |

**Flow under admin:**
1. Admin on the **source** (Zendesk) issues an **API token / OAuth** with global read scope.
2. Admin on the **target** (Freshdesk) issues an **admin API key** with global write scope.
3. Our tool authenticates once per side and **enumerates every object across the account** via bulk/incremental export APIs.
4. Objects are staged in MongoDB, transformed, then **bulk-written** into Freshdesk in dependency order, in throttled batches.
5. Reconciliation compares source vs target counts and relationships and produces a report + manual checklist.

This is the same operating model as Help Desk Migration (Relokia), CloudFuze, etc. — our differentiation is the **config-automation layer**, not the connection model.

---

## 3. Goals, non-goals & success metrics

### Goals (v1)
- Migrate all **data objects** Zendesk→Freshdesk (tickets + conversations + attachments, users→contacts, orgs→companies, KB, CSAT, tags).
- Migrate & **auto-rebuild config objects** wherever an API allows (groups, agents, ticket/contact/company fields, SLAs, business hours, brands→products, macros, triggers/automations → Dispatch'r/Observer/Supervisor).
- **Enterprise scale:** batched, throttled, resumable, idempotent.
- **Dry-run + mapping preview** before any write.
- **Reconciliation report** + **manual checklist** for non-API items.

### Non-goals (v1)
- Reverse direction (Freshdesk→Zendesk) — later.
- Other platforms (ServiceNow, Jira SM, Intercom) — later, though schema is platform-agnostic by design.
- Live/continuous sync (delta re-runs) — v1 is one-way, one-time (delta re-run is a v2 goal).
- Migrating third-party app installations, SSO/security config (checklist only).

### Success metrics
- **Data fidelity ≥ 99.9%** (reconciled record counts, relationship integrity).
- **Config coverage:** ≥ 90% of config objects auto-created; remainder on a clear checklist.
- **Resumability:** kill at any point → resume with zero duplicates.
- **Throughput:** sustains platform rate limits without 429 storms; large tenant completes within SLA.

---

## 4. Competitive landscape & differentiation

| Capability | Help Desk Migration / Relokia | CloudFuze | **Us** |
|---|---|---|---|
| Tickets, contacts, KB data | ✅ | ✅ | ✅ |
| **Configuration migration (fields, SLAs, forms, brands)** | ⚠️ partial / manual | ⚠️ partial | ✅ **automated** |
| **Automation/trigger/macro translation** | ❌ manual rebuild | ❌ | ✅ **rule-based translator** |
| Dry-run + feasibility preview | ⚠️ | ⚠️ | ✅ |
| Reconciliation report + manual checklist | ⚠️ | ⚠️ | ✅ |
| Deterministic (no hallucination risk) | ✅ | ✅ | ✅ |

**Moat:** the deterministic **configuration-automation engine** (§10) + the **mapping matrix** (§9) — the accumulated, versioned knowledge of how every Zendesk object becomes a Freshdesk object.

---

## 5. Scope — Zendesk → Freshdesk v1

**Data objects:** Tickets, Ticket comments/conversations (public+private), Attachments, Inline images, Users (agents + end-users), Organizations, Groups membership, Tags, Satisfaction ratings (CSAT), Help Center Categories/Sections/Articles (+translations, +article attachments/inline images).

**Config objects:** Groups, Agents, Roles, Ticket fields (system+custom), Ticket forms, User/Organization custom fields, Triggers, Automations, Macros, SLA policies, Business hours (schedules), Brands, Support addresses/channels, Views (best-effort), Webhooks/Targets (best-effort), Dynamic content.

Feasibility per object is in **§9**.

---

## 6. Solution architecture

```
                         ┌─────────────────────────────────────────────┐
                         │              CONTROL PLANE (Mongo)            │
                         │   projects · jobs · batches · tasks · state   │
                         └─────────────────────────────────────────────┘
                                              │ orchestrator (state machine)
   SOURCE (Zendesk)                           ▼                       TARGET (Freshdesk)
 ┌──────────────────┐  extract   ┌────────────────────────┐  load  ┌──────────────────┐
 │ Zendesk Connector│──────────▶ │   MongoDB STAGING       │──────▶ │ Freshdesk        │
 │ admin token,     │            │   entities per type     │        │ Connector        │
 │ cursor/incr.     │◀── verify  │   idmap (crosswalk)     │ verify │ admin API key,   │
 │ export, throttle │            │   mappingRules          │◀────── │ page pagination, │
 └──────────────────┘            │   conflicts · events    │        │ throttle, retry  │
                                  └────────────────────────┘        └──────────────────┘
        Workers:  [Extractor] → [Transformer] → [Validator] → [Loader] → [Reconciler]
        API + Dashboard (Express): connect · discover · mapping preview · run · verify · report
```

**Pipeline (ETL, staged in Mongo so each phase is resumable & auditable):**

```
CONNECT → DISCOVER → EXTRACT → TRANSFORM → VALIDATE(dry-run)
       → LOAD(config: groups→agents/roles→fields→forms→SLAs→business hours→brands→automations/macros)
       → LOAD(data: orgs→companies→users→contacts→KB(cat→folder→article)→tickets→comments→attachments→CSAT)
       → VERIFY(reconcile) → REPORT
```

Config loads **before** data because tickets reference groups/agents/fields — those must exist (and their new IDs captured in `idmap`) first.

**Per-entity state machine:** `DISCOVERED → EXTRACTED → TRANSFORMED → VALIDATED → LOADED`, with side states `SKIPPED` / `FAILED(retry+backoff)` / `MANUAL(no API → checklist)`. Every transition persisted.

---

## 7. Tech stack

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | **Node.js 20+ (ESM)** | your standard; strong async I/O for API-bound work; no Python |
| DB | **MongoDB** (Mongoose ODM) | document-shaped source/target payloads; the staging + control plane |
| API/server | **Express** | thin REST for the dashboard |
| Job/queue | **BullMQ + Redis** (or Mongo-backed queue for v1) | batch workers, retries, backoff, concurrency control |
| HTTP | **undici / axios** + token-bucket limiter (`bottleneck`) | per-connector rate limiting |
| Front-end | Self-contained dashboard served by Express (no build step) | runs on a laptop for sales demos |
| Config | **dotenv** / secrets store | credentials never in DB plaintext |
| Deploy | Docker (per your preference); MongoDB via Docker or managed | reproducible; you'll supply DB via Studio3T/Docker |

---

## 8. Database schema (MongoDB)

**Design style (CloudFuze-like):** separate, purpose-built collections; batch/enterprise-oriented (a `batches` collection drives bulk processing); every migrated object is a document with source payload, transformed payload, and a target crosswalk.

### 8.1 Control-plane collections

**`projects`** — one migration engagement (one customer).
```jsonc
{
  _id, name,                       // "Acme Corp Zendesk→Freshdesk"
  source: { platform: "zendesk", subdomain, connectionId },
  target: { platform: "freshdesk", domain, connectionId },
  plan: { sourceTier, targetTier }, // feature/plan gating detection
  options: { migrateConfig: true, migrateData: true, dryRun: false },
  status: "created|discovering|ready|running|paused|completed|failed",
  currentPhase: "connect|discover|extract|transform|validate|load_config|load_data|verify|report",
  stats: { totalEntities, migrated, failed, manual },
  createdAt, updatedAt
}
```

**`connections`** — credential references (NOT plaintext secrets).
```jsonc
{ _id, projectId, side: "source|target", platform, baseUrl,
  authType: "api_token|oauth|api_key", secretRef, rateLimit: { rpm, burst },
  detectedFeatures: { multipleForms, customStatuses, skillRouting }, createdAt }
```

**`jobs`** — a run of the pipeline for a project (supports re-runs).
```jsonc
{ _id, projectId, mode: "dry_run|full", phasesCompleted: [...],
  startedAt, finishedAt, status, error }
```

**`batches`** — the unit of enterprise bulk processing. Work is chunked; each batch is retriable independently.
```jsonc
{ _id, jobId, projectId,
  entityType: "ticket",            // one object type
  phase: "extract|transform|load",
  cursor: { sourcePage, afterToken }, // pagination position
  size: 100, seq: 42,
  status: "pending|in_progress|done|failed|retrying",
  attempts, counts: { in, ok, skipped, failed },
  startedAt, finishedAt }
```

**`tasks`** *(optional finer grain)* — a single object's processing record, if we need per-record retry telemetry. Often folded into `entities.status` + `events`.

### 8.2 Staging collections (the ITSM objects)

Two viable shapes; the PRD proposes **B** (separate collection per major type) to match the CloudFuze "collection-per-concern" style and keep indexes/queries clean.

**Option A — unified `entities`** (one collection, `entityType` discriminator). Simplest; fine for smaller catalogs.

**Option B — per-type collections (recommended):**
`tickets`, `ticketComments`, `attachments`, `users`, `organizations`, `groups`, `agents`, `roles`, `ticketFields`, `ticketForms`, `macros`, `triggers`, `automations`, `slaPolicies`, `businessHours`, `brands`, `kbCategories`, `kbFolders`, `kbArticles`, `csat`, `tags`.

Every staging document shares this **common envelope**:
```jsonc
{
  _id,
  projectId,
  domain: "data|config",
  entityType: "ticket",
  sourceId: "360012345",          // Zendesk id (string)
  sourceRaw: { ...zendesk payload as extracted... },
  transformed: { ...freshdesk-shaped payload... },
  targetId: null,                 // Freshdesk id once loaded
  status: "extracted|transformed|validated|loaded|skipped|failed|manual",
  dependsOn: [ { entityType:"group", sourceId:"200" },
               { entityType:"user",  sourceId:"55" } ],
  mappingRuleId,
  contentHash,                    // idempotency / change detection
  errors: [ { at, code, message } ],
  batchId, createdAt, updatedAt
}
```

### 8.3 Mapping & crosswalk collections

**`idmap`** — the crosswalk that solves ID re-mapping. Written the instant any object loads; read during every transform.
```jsonc
{ _id, projectId, entityType, sourceId, targetId, targetType,
  preexisting: false,             // true if matched an existing target (dedup)
  createdAt }
// unique index: { projectId, entityType, sourceId }
```

**`mappingRules`** — the deterministic matrix as versioned data (drives the transformer).
```jsonc
{ _id, sourceEntityType: "trigger", targetEntityType: "dispatcher_rule",
  feasibility: "auto|transform|manual|not_feasible",
  fieldMap: [ { from:"subject", to:"subject" }, ... ],
  valueMaps: [ { field:"priority", map:{ "normal":"medium" } } ],
  transformer: "translateTriggerToDispatcher",   // named deterministic fn
  notes, version, updatedAt }
```

**`valueMaps`** — reusable enum translations (status, priority, source, field types) referenced by rules.

### 8.4 Observability & resolution collections

**`conflicts`** — anything needing human resolution or the manual checklist.
```jsonc
{ _id, projectId, entityType, sourceId, kind:"unmapped_field|no_api|dup_email|value_out_of_range",
  detail, suggestion, status:"open|resolved|manual", createdAt }
```

**`events`** — append-only audit log (every state transition, every API call outcome). The report is reproducible from this + `idmap`.

**`reports`** — snapshotted reconciliation summaries for the dashboard.

### 8.5 Key indexes
- `tickets` etc.: `{ projectId, sourceId }` **unique**; `{ projectId, status }`.
- `idmap`: `{ projectId, entityType, sourceId }` **unique**.
- `batches`: `{ jobId, status }`, `{ projectId, entityType, phase }`.
- `events`: `{ projectId, createdAt }`.

---

## 9. Object mapping matrix (data + config)

Feasibility legend: **AUTO** = 1:1 via API · **TRANSFORM** = logic/value translation · **MANUAL** = no write API, goes to checklist · **PARTIAL** = plan-gated or lossy.

### 9.1 Data objects
| Zendesk | Freshdesk | Feasibility | Notes |
|---|---|---|---|
| Ticket | Ticket | TRANSFORM | status/priority/source enum maps; created_at/updated_at preserved on import |
| Ticket comment (public) | Ticket reply (`/reply`) | AUTO | author re-linked via idmap |
| Ticket comment (private) | Ticket note (`/notes`, private) | AUTO | |
| Attachment | Attachment | TRANSFORM | re-upload, then attach; size limits apply |
| Inline image (in body) | Inline image | TRANSFORM | rehost + rewrite `src` |
| End-user | Contact | AUTO | dedup by email |
| Agent | Agent | PARTIAL | requires agent seat on target; role mapping (§9.2) |
| Organization | Company | AUTO | |
| Org membership | Contact.company_id | TRANSFORM | via idmap |
| Tag | Tag | AUTO | |
| Satisfaction rating (CSAT) | CSAT | PARTIAL | historical CSAT import is limited |
| HC Category | Solution Category | AUTO | |
| HC Section | Solution Folder | AUTO | Zendesk 2-level (cat→section) → FD 2-level (cat→folder) |
| HC Article | Solution Article | TRANSFORM | HTML sanitize, rehost images, author/section re-link |
| Article translation | Article (per language) | PARTIAL | FD multilingual is plan-gated |

### 9.2 Configuration objects
| Zendesk | Freshdesk | Feasibility | Notes |
|---|---|---|---|
| Group | Group | AUTO | |
| Role (custom) | Role | MANUAL/PARTIAL | FD roles typically **not creatable via API** → map to nearest existing role; extras → checklist |
| Ticket field (custom) | Ticket field (custom) | TRANSFORM | field-type map (§10.2); dropdown options carried |
| Ticket field (system) | System field | AUTO | mapped, not created |
| Ticket form | Ticket form | PARTIAL | FD multiple forms = Enterprise plan only |
| User/Org field | Contact/Company field | TRANSFORM | field-type map |
| **Trigger** | **Dispatch'r** (create) / **Observer** (update) | TRANSFORM | condition/action grammar translation (§10.1) |
| **Automation** (time-based) | **Supervisor** | TRANSFORM | time/SLA conditions |
| **Macro** | **Scenario Automation** (+ Canned Response) | TRANSFORM | actions map; reply text → canned response |
| SLA policy | SLA policy | PARTIAL | target/metric maps; write API plan-gated |
| Business hours (schedule) | Business hours | PARTIAL | holidays + timezone; write limited |
| Brand | Product | TRANSFORM | brand→product; support address mapped |
| Support address / channel | Email config | PARTIAL | DNS/verification is manual |
| View | (Ticket view / scenario) | PARTIAL/MANUAL | best-effort |
| Webhook / Target | (Automation webhook) | MANUAL | secrets re-entered manually |
| Dynamic content | Canned/placeholders | PARTIAL | |
| Apps / integrations | — | MANUAL | reinstall from marketplace (checklist) |
| SSO / security | — | MANUAL | admin re-config (checklist) |

### 9.3 Value maps (deterministic)
**Status:** `new→Open(2)`, `open→Open(2)`, `pending→Pending(3)`, `hold→Pending(3)` *(or custom status on Enterprise)*, `solved→Resolved(4)`, `closed→Closed(5)`.
**Priority:** `low→Low(1)`, `normal→Medium(2)`, `high→High(3)`, `urgent→Urgent(4)`.
**Source:** `email→1`, `web→2(Portal)`, `phone→3`, `chat→7`, `api→normalize`.

---

## 10. Configuration automation — how we rebuild config

This is the differentiator. It's a **deterministic rule-translation engine**, not AI. Each config object type has a named transformer function referenced by `mappingRules.transformer`.

### 10.1 Automation logic translation (the hard one)
Zendesk expresses automation as **Triggers** (event-driven, on create/update), **Automations** (time-based), and **Macros** (agent-applied). Freshdesk splits event-driven rules into **Dispatch'r** (on create), **Observer** (on update), **Supervisor** (time-based), plus **Scenario Automations** (≈ macros).

**Translation algorithm (per Zendesk trigger):**
1. **Parse** the trigger into an intermediate representation (IR): `{ when: [conditions], then: [actions] }`.
2. **Classify** by trigger point → Dispatch'r (create-only conditions) or Observer (update conditions). A trigger that fires on both is **split into two** FD rules.
3. **Map conditions** field-by-field through `valueMaps` (e.g. Zendesk `status is open` → FD `status is Open`). Conditions referencing objects (group/agent/field) resolve IDs via `idmap`.
4. **Map actions** (set field, add tag, notify group, assign) to FD action grammar.
5. **Unmappable clause** (e.g. a condition with no FD equivalent) → the rule is still created with the mappable clauses, and the dropped clause is written to `conflicts` as a checklist item with the exact original text. **Never silently dropped.**
6. **Order preserved** — Zendesk trigger execution order → FD rule order where the API allows.

The IR makes this testable: golden-file tests assert `trigger X → FD rule JSON Y`.

### 10.2 Field-type translation
| Zendesk field type | Freshdesk field type | Note |
|---|---|---|
| text | custom_text | |
| textarea | custom_paragraph | |
| integer/decimal | custom_number / custom_decimal | |
| date | custom_date | |
| checkbox | custom_checkbox | |
| dropdown (tagger) | custom_dropdown | options + tags carried |
| multiselect | custom_dropdown (multi) | PARTIAL — FD multi-select gating |
| regex | custom_text + validation note | no FD regex type → validation to checklist |
| lookup relationship | — | MANUAL |

### 10.3 SLA / business hours / brands
- **SLA:** map metric (first_reply, resolution) + priority targets + business/calendar hours flag. Write via SLA API where plan allows; else emit an importable spec + checklist.
- **Business hours:** timezone + weekly schedule + holidays; attach to SLA/groups.
- **Brand→Product:** create product, map support email, re-link tickets/articles via idmap.

### 10.4 Human-in-the-loop (assistive AI, non-authoritative)
For an **unmatched** custom field or ambiguous mapping, the tool may *suggest* a target using AI, but it is written to `conflicts` with `status:"open"` and **requires admin approval** before the transformer uses it. AI never auto-commits.

> **Enforcement of translated rules on Freshdesk:** because Freshdesk exposes no public API to create native automation rules, the translated IR is enforced via a **Freshworks Custom App** (serverless `onTicketCreate`/`onTicketUpdate`/scheduled handlers) as the primary path, with scripted UI automation as an opt-in fallback and a guided spec as the safety net. This is validated against how **Salto** does same-platform config deployment (and why Salto's approach *can't* close this gap for us). See **[CONFIG-FEASIBILITY.md](./CONFIG-FEASIBILITY.md)**.

---

## 11. Write operations in Freshdesk (per object)

Freshdesk API v2, base `https://{domain}.freshdesk.com/api/v2`, Basic auth (`apiKey:X`). Load order = §6. All writes check `idmap` first (idempotency) and record `targetId` on success.

| Order | Object | Method + endpoint | Key payload / dependency |
|---|---|---|---|
| 1 | Group | `POST /groups` | name, description |
| 2 | Agent | `POST /agents` | email, role_ids, group_ids (idmap), seat required |
| 3 | Ticket field | `POST /admin/ticket_fields` | type (§10.2), label, choices |
| 4 | Contact/Company field | `POST /contact_fields`, `/company_fields` | |
| 5 | Ticket form | `POST /admin/forms` *(Enterprise)* | fields[] |
| 6 | Business hours | `POST /business_hours` *(gated)* | tz, schedule, holidays |
| 7 | SLA policy | `POST /sla_policies` *(gated)* | targets by priority, BH ref |
| 8 | Product (brand) | `POST /products` | name, support email |
| 9 | Automation rule | Dispatch'r/Observer/Supervisor *(API limited — see §13)* | translated IR |
| 10 | Canned response / Scenario | *(limited API)* | macro translation |
| 11 | Company | `POST /companies` | name, domains, custom_fields |
| 12 | Contact | `POST /contacts` | name, email (dedup), company_id (idmap) |
| 13 | Solution category | `POST /solutions/categories` | name, visibility |
| 14 | Solution folder | `POST /solutions/categories/{id}/folders` | category via idmap |
| 15 | Solution article | `POST /solutions/folders/{id}/articles` | title, description (rehosted HTML), status |
| 16 | Ticket | `POST /tickets` | requester_id/email, group_id, responder_id, status, priority, source, type, tags, custom_fields, **created_at/updated_at** (import), company_id — all FKs via idmap |
| 17 | Ticket reply (public) | `POST /tickets/{id}/reply` | body, user_id (idmap) |
| 18 | Ticket note (private) | `POST /tickets/{id}/notes` | body, private:true |
| 19 | Attachment | multipart on ticket/note create | file bytes from staging |
| 20 | CSAT | *(limited)* | historical import constraints |

**Idempotency contract for every write:** `if idmap has (type, sourceId) → skip (already loaded)`. On create success → insert `idmap` in the **same** logical step; on 429 → backoff+retry; on 4xx validation → mark entity `failed` + write `conflicts`, continue batch.

---

## 12. Batch / enterprise processing model

- **Extraction** uses **incremental/cursor export** on Zendesk (e.g. `/incremental/tickets/cursor.json`) for large tenants; each page → one `batches` doc with the cursor position (resumable).
- **Concurrency:** worker pool per object type; global **token-bucket rate limiter** per connector (respect Zendesk & Freshdesk per-plan RPM). 429 → exponential backoff.
- **Batch size** tuned per object (e.g. 100 tickets/batch). A failed batch retries independently; a failed record within a batch is isolated (marked `failed`, batch continues).
- **Resumability:** on restart, orchestrator loads incomplete `batches` + entities not `loaded` and continues. `idmap` guarantees no duplicate creates.
- **Dry-run:** phases 1–5 only; produces mapping preview + conflict list; **zero** target writes.
- **Reconciliation:** post-load counts per type source vs target + spot relationship checks (e.g. sampled tickets have correct requester/group) → `reports`.

---

## 13. Constraints & limitations

| # | Constraint | Impact | Mitigation |
|---|---|---|---|
| C1 | **Freshdesk API rate limits** (per plan, e.g. 100–700 rpm) | throttled throughput | token-bucket + backoff; schedule large runs |
| C2 | **Some config has no write API** (roles, some automations, SSO, apps, DNS/email verification) | can't auto-create | detect → `conflicts` **manual checklist** with exact source spec; never silent |
| C3 | **Plan gating** (multiple ticket forms, custom statuses, multilingual KB, SLA write = Enterprise) | feature may be absent on target | detect target plan at CONNECT; degrade gracefully + flag |
| C4 | **ID changes** across platforms | relationships break | `idmap` crosswalk (§14.1) |
| C5 | **Enum mismatch** (statuses, priorities, field types, regex) | lossy mapping | deterministic value maps + `conflicts` for out-of-range |
| C6 | **Historical timestamps** | tickets must keep original created/updated | use Freshdesk import fields (created_at/updated_at on create) |
| C7 | **Attachment/size limits & inline image URLs** | broken images/files | rehost + rewrite + size checks |
| C8 | **Duplicate contacts** (email already on target) | dup users | dedup by email → mark `preexisting` in idmap |
| C9 | **No public API creates Freshdesk automation rules, roles, business hours, products, scenarios** | can't natively auto-create them | Translate to IR, then enforce via a **Freshworks Custom App (serverless event handlers)** as primary; scripted UI automation as opt-in fallback; guided spec as safety net. Full analysis + Salto comparison in **[CONFIG-FEASIBILITY.md](./CONFIG-FEASIBILITY.md)**. |
| C10 | **Large tenants** (millions of records) | long runs, memory | streaming extract, batched staging, no full in-memory loads |

> **Honesty principle for sales:** C2/C9 are stated plainly. We claim *"automated where an API exists; a short, exact checklist for the handful that don't"* — not "100% automatic". That's still far ahead of competitors who leave *all* config manual.

---

## 14. Solution architecture per hard problem

**14.1 ID re-mapping** → `idmap` crosswalk; config loads first to populate it; transformer resolves every FK through it; load is idempotent against it.

**14.2 Dependency ordering** → static dependency graph; orchestrator topologically loads config→data in the §6 order; each entity carries `dependsOn` and won't load until deps are `loaded`.

**14.3 Automation translation** → parse to IR → classify (Dispatch'r/Observer/Supervisor) → map conditions/actions via valueMaps+idmap → split multi-trigger → emit rule; unmappable clauses → `conflicts`. Golden-file tested.

**14.4 Attachments & inline images** → download to staging store → re-upload → rewrite URLs in HTML/body before load; size/type validated.

**14.5 Rate limits & scale** → per-connector token bucket + backoff; incremental export; batch workers; streaming.

**14.6 Idempotency & resume** → unique `(projectId, entityType, sourceId)`; `contentHash` for change detection; `idmap` guard before every create; incomplete `batches` resumed.

**14.7 Dedup** → match contacts/companies by email/domain; reuse target, record `preexisting:true`.

**14.8 Reconciliation** → per-type source vs target counts + sampled relationship assertions → `reports` + dashboard verify panel.

**14.9 Non-feasible config** → `conflicts` collection becomes a printable **manual checklist** with exact original config text and target instructions.

---

## 15. Security & compliance

- **Secrets:** admin tokens/keys stored in an encrypted secret store or env; DB holds only `secretRef`. **Never** paste live credentials into chat/logs/tickets. *(Action item: rotate the Mongo credential that was shared in chat.)*
- **Least privilege:** source token read-scoped; target key write-scoped to needed objects.
- **PII:** staging DB contains customer PII (ticket bodies, emails) → encryption at rest, access controls, retention policy (purge staging N days post-migration).
- **Audit:** append-only `events`; immutable report.
- **Isolation:** one project = one logical namespace; no cross-tenant data mixing.

---

## 16. Delivery roadmap

| Phase | Deliverable |
|---|---|
| **M0 — this PRD** | agreed architecture, schema, mapping, constraints ← *you are here* |
| **M1 — schema + connectors** | Mongo collections/indexes; Zendesk read connector; Freshdesk write connector; rate limiting |
| **M2 — data migration** | extract→transform→load for users/orgs/tickets/KB; idmap; reconciliation |
| **M3 — config automation** | groups/agents/fields/forms/SLAs/business hours/brands + trigger/macro translator + conflicts checklist |
| **M4 — dashboard** | connect · discover · mapping preview · run · verify · report (sales-demo ready) |
| **M5 — hardening** | large-tenant scale, resume, dry-run polish, docs |

---

## 17. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Freshdesk automation write API too limited (C9) | High | IR + importable spec + guided steps; official API; sanctioned UI fallback |
| Target plan lacks a feature (C3) | Medium | detect at CONNECT; degrade + flag; sell plan upgrade path |
| Rate limits stretch large migrations | Medium | throttle, schedule, parallel object types |
| Enum/field lossiness disputes | Medium | mapping preview sign-off before write |
| Scope creep to other platforms | Medium | schema/engine already platform-agnostic; gate by roadmap |

---

*End of PRD v0.1. Next step: your review — approve/adjust the schema (§8), mapping (§9), and config-automation approach (§10) before we cut collections and connectors in M1.*
