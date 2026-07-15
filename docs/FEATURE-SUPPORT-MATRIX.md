# CloudFuze ITSM Migrator — In-Scope / Out-of-Scope

### Zendesk → Freshdesk (v1) · What our tool supports, what it doesn't, and **why**

**Audience:** Sales · Presales · Marketing · Account Management · Executive
**Owner:** Product/Engineering · **Status:** Living document — *append to this on every fix*
**Last updated:** 2026-07-11

> **How to read this doc.** This is a straight list of **what our tool does and does not migrate today** — graded against the shipped product, not the roadmap. Everything in **In-Scope** we do automatically. Everything in **Out-of-Scope** has a named **reason** — and in most cases the reason is *not our tool*, it's a Freshdesk platform limit or something no tool can automate. That reason is the sales answer when a customer asks "can you do X?"

---

## 0. The one-line positioning (for the CEO slide)

> **Our tool migrates the whole helpdesk — data *and* configuration — from Zendesk to Freshdesk.** Competitors move only tickets and contacts and leave every field, group, SLA, workflow and automation to be rebuilt by hand. We carry the customer's business setup across automatically, and where Freshdesk's own API won't allow a write, we hand the admin a ready-made, pre-filled checklist instead of a blank page.

Every write is **deterministic and idempotent** — reproducible, auditable, and safe to re-run (kill mid-migration → resume with zero duplicates). No AI guesses a write.

---

## 1. Status legend

| Badge | Meaning |
|---|---|
| ✅ **In-Scope — Supported** | Migrated automatically, end-to-end, today. |
| ◐ **In-Scope — Partial** | Migrated, with a named, disclosed caveat. |
| 🛠 **In-Scope — In progress** | Known gap with a proven fix identified; on the near-term board. |
| ⛔ **Out-of-Scope — platform limit** | Freshdesk's API/data layer makes it impossible. **Not our gap.** Best available fallback provided. |
| 🗓 **Out-of-Scope — deferred (v2)** | Feasible; intentionally not in v1. On the roadmap. |
| 🙅 **Out-of-Scope — inherently manual** | No tool can automate it; needs the customer's own domain/credentials. We shrink it to a short checklist. |

---

## 2. IN-SCOPE — Data our tool migrates

| Object | Freshdesk target | Status | What our tool does / the caveat |
|---|---|---|---|
| **Tickets** | Tickets | ✅ | Subject, description, status, priority, source, type, group, requester, company, tags — all mapped automatically. |
| **Status / priority / source / type** | built-in fields | ✅ | Deterministic value maps (e.g. Zendesk `solved` → Freshdesk `Resolved`). Unmappable values omitted, never rejected. |
| **Public replies** | conversations | ✅ | Author preserved; **rich text (HTML) preserved** (bold, headings, lists, links). Destination reads **native** (no per-message stamps) by default; an opt-in **forensic** mode prefixes each message with its original send time. |
| **Rich text / HTML formatting** | description + conversations | ✅ | Description and every reply/note migrate as HTML (`html_body`) — formatting survives, not flattened to markdown. |
| **Private notes** | conversations | ✅ | Routed to the correct notes endpoint (Freshdesk rejects `private` on public replies — we handle that split). |
| **Attachments** | file uploads | ✅ | Downloaded from Zendesk and re-uploaded onto the matching reply/note. |
| **Tags** | Tags | ✅ | Carried across verbatim. |
| **Organizations** | Companies | ✅ | Deduped by domain — safe to re-run without duplicates. |
| **Users (agents + end-users)** | Contacts | ✅ | Deduped by email; linked to their migrated company. |
| **Knowledge Base — Categories** | Solution Categories | ✅ | |
| **Knowledge Base — Sections** | Solution Folders | ✅ | Re-parented to the migrated category. |
| **Knowledge Base — Articles** | Solution Articles | ✅ | Draft/published state preserved; inline images rehosted to the target. |
| **Migration provenance** | custom fields + report | ✅ | **Clean-migration default** — destination looks native. Only two **searchable custom fields** land on the ticket (`Original Ticket ID`, `Source Platform`) so agents can look up a ticket by its old number (matches Help Desk Migration). Full created/updated/timeline history lives in the **CloudFuze migration report**, not on the ticket. |
| **Provenance modes** | engine option | ✅ | `provenanceMode: clean` (default, native) or `forensic` (adds per-message source-time stamps) for regulated/audit migrations. |
| **Assignee / responder** | responder_id | ✅ | Ticket owner migrated. Agent→group membership is migrated (and admins are treated as agents) so Freshdesk accepts the assignment; reused agents get membership re-applied. Absent/unmigrated assignees fall back to unassigned. |
| **CC / collaborators** | cc_emails | ✅ | Zendesk collaborators/CCs resolved to their emails and set as Freshdesk `cc_emails`. |
| **Custom-field VALUES (safe types)** | ticket custom_fields | ✅ | Text, paragraph, number, decimal, checkbox and date values migrate onto the matching Freshdesk field (by resolved `cf_` name). Best-effort: a value the target rejects is dropped and the ticket still migrates. |

### In-Scope data items still being finished (honest disclosure)

| Item | Status | What's happening |
|---|---|---|
| **Dropdown / system custom-field VALUES** | 🛠 In progress | Safe-typed values migrate today; dropdown option-value translation + Zendesk system fields (topic/sentiment/…) still need a value crosswalk. Skipped for now rather than risk a rejected ticket. |
| **Inline images in ticket bodies** | 🛠 In progress | Embedded images show a marker; ticket-body image rehosting (already done for KB articles) is the next step. |

---

## 3. IN-SCOPE — Configuration our tool migrates (the differentiator)

This is the setup competitors leave 100% manual.

| Config object | Freshdesk target | Status | What our tool does / the caveat |
|---|---|---|---|
| **Groups** | Groups | ✅ | Created automatically. |
| **Agents** | Agents | ✅ | Created with role + ticket-scope mapped, **and group membership migrated** (Zendesk group_memberships → FD `group_ids`, re-applied to reused agents) so ticket assignment works. Admins migrated as agents too. Billing-admin nuance surfaced for review (see §5). |
| **Ticket fields (custom)** | Custom ticket fields | ✅ | Field type translated (text, dropdown, number, date, checkbox…). Dropdown choices rebuilt in order. System fields skipped (already built-in). Regex fields → text + note. **Idempotent** — re-runs reuse a field by label instead of creating duplicates. |
| **Roles** | default roles | ◐ | Mapped to the nearest Freshdesk built-in role; genuinely custom ones checklisted (Freshdesk has no create-role API — see §6). |
| **Macros → reply text** | Canned Responses | ✅ | Every macro's reply body becomes a canned response automatically. |
| **Macros → field actions** | — | ◐ | Field-changing actions surfaced as a precise rebuild note (not API-creatable). |
| **Triggers** | Automation rules | ◐ | Logic translated automatically (conditions → actions, with IDs already remapped) — see §4. |
| **Automations** | Automation rules (time-based) | ◐ | Same automatic logic translation. |
| **SLA policies** | SLA policies | ◐ | Targets set where the API allows; remainder checklisted. |
| **Business hours** | Business hours | ⛔ | Freshdesk exposes GET-only — delivered as a checklist; SLAs re-link automatically once recreated. |
| **Brands** | Products | ⛔/◐ | Best-effort create; falls back to checklist (Freshdesk Products API is read-only). |

**Coverage we can claim:** the large majority of config is auto-created or auto-translated; the rest ships as a **pre-filled checklist** (target names/IDs already resolved), not a blank rebuild.

---

## 4. How our tool handles automations (read before pitching automations)

Zendesk **triggers/automations/macros** are the customer's business logic. Freshdesk's API **cannot create automation rules** (a platform limit — see §6). Our tool doesn't stop there: it **translates each rule automatically** into a platform-neutral form (event + conditions + actions, with every group/field reference already remapped to the new Freshdesk IDs), then delivers it one of three ways:

| Path | Output | Note |
|---|---|---|
| **A. Custom App (recommended)** | A Freshworks serverless app runs the exact translated logic on ticket-create/update/time events. | Automated. Disclosure: rules live in the app, not the native Admin list. |
| **B. Scripted recreation (opt-in)** | Deterministic script recreates rules natively in Admin → Workflows. | Native, admin-visible; opt-in. |
| **C. Guided rebuild spec (always generated)** | Exact conditions→actions checklist, names pre-resolved. | Zero-risk safety net + audit record. Minutes per rule, not hours. |

> **Sales line:** *"The customer's Zendesk automations don't just get thrown away — our tool translates them and gives you a working path to turn them back on in Freshdesk."*

---

## 5. OUT-OF-SCOPE — Freshdesk platform limits (not our tool)

These are the "why can't you migrate X?" answers. Lead with *whose* limit it is.

| Limitation | Why (root cause) | What our tool does instead |
|---|---|---|
| **Emoji / 4-byte characters in subject & body** | Freshdesk stores text as `utf8mb3` — it physically cannot hold 4-byte Unicode. Normal Unicode + accents are fine. | Everything except emoji migrates perfectly. A Freshdesk database limit — no tool can change it. |
| **Reply/note timestamps show migration time** | Freshdesk's API cannot backdate individual messages in a conversation. | The full original timeline is preserved in the migration report; optional **forensic** mode also stamps each message inline. |
| **Outbound notification emails during migration** | Freshdesk has **no reliable per-request notification suppression** (confirmed in the Freshworks dev community); migrating public replies would email requesters. | **Pre-flight gate**: before a live run the tool blocks with a checklist to disable Email Notifications + Automations at the account level (the industry-standard step), and reminds to re-enable after. |
| **"Created by" = the API user** | Any record created through a migration API is authored by the token's user — true for every migration vendor. | Original author preserved in provenance; agent authorship set on replies/notes where the agent exists on the target. |
| **Ticket backdating rejected on some plans** | `created_at`/`updated_at` on ticket create is plan-gated by Freshdesk. | Best-effort: sent, and if rejected we retry without them so the ticket still migrates; original times preserved in the note. |
| **No create API for: automation rules, custom roles, business hours, products, scenario automations** | Freshdesk exposes these as **read-only** (GET only). | Translated + checklisted + optional Custom App / scripted recreation (see §3–§4). |
| **Dropdown / system custom-field VALUES on tickets** | Dropdown values need an option-value crosswalk; Zendesk system fields (topic/sentiment/language) have no clean Freshdesk target. | Safe-typed values (text/paragraph/number/decimal/checkbox/date) **do** migrate now; these are skipped best-effort so a rejected value never sinks the ticket. |

---

## 6. OUT-OF-SCOPE — Roadmap & inherently-manual items

| Item | Bucket | Why it's out |
|---|---|---|
| **CSAT / satisfaction ratings** | 🗓 Deferred (v2) | Planned; not yet wired into the engine. |
| **Reverse direction (Freshdesk → Zendesk)** | 🗓 Deferred | v1 is one-way; engine is platform-agnostic, reverse is roadmap. |
| **Other platforms (ServiceNow, Jira SM, Intercom…)** | 🗓 Deferred | Engine already platform-agnostic by design; gated to roadmap. |
| **Live / continuous (delta) sync** | 🗓 Deferred | v1 is one-time, one-way; idempotent design makes delta a natural v2. |
| **SSO / security configuration** | 🙅 Inherently manual | Needs the customer's own IdP credentials + domain control. No tool can automate it. Short checklist provided. |
| **Third-party marketplace app installs** | 🙅 Inherently manual | Each app has its own per-vendor install/OAuth. Checklist. |
| **Email / DNS domain verification** | 🙅 Inherently manual | Requires DNS changes only the domain owner can make. Checklist. |

> **Key framing for the room:** everything 🙅 is manual for *every* competitor too — it needs the customer's own credentials. Our tool just reduces it to a short, exact checklist instead of leaving them guessing.

---

## 7. Success metrics our tool can quote

- **Data fidelity ≥ 99.9%** (reconciled record counts + relationship integrity).
- **High config coverage** — most objects auto-created/translated; remainder as a pre-filled checklist.
- **Resumability:** kill mid-run → resume with **zero duplicates** (idempotent).
- **Batch checkpointing:** load runs in `config.batchSize` batches, each a persisted `batches` record with per-batch `{in/ok/skipped/failed}` counts, attempt count and timings — a paused run shows exactly which batch it stopped on, and a done batch is skipped on resume.
- **Throughput:** honors platform rate limits — no 429 storms; large tenants complete within SLA.

---

## 8. CHANGELOG — *append here on every fix or new feature*

> **Process:** every time we close a gap or ship a capability, add a dated row here **and** move the item's badge in §2–§6. New capability → a fresh In-Scope entry. Removed limitation → strike it from Out-of-Scope. This is what keeps the pitch current.

| Date | Change | Moved from → to |
|---|---|---|
| 2026-07-11 | Document created; baseline captured from shipped code. | — |
| 2026-07-11 | Duplicate opening-message bug fixed (Zendesk first comment = description, no longer re-imported as a reply). | Out-of-Scope gap → ✅ In-Scope |
| 2026-07-11 | Per-message `[Originally sent …]` prefix + per-ticket provenance note shipped. | — → ✅ In-Scope |
| 2026-07-11 | Public replies no longer send `private` (Freshdesk `/reply` rejected it). | bug → ✅ In-Scope |
| 2026-07-11 | Best-effort ticket `created_at`/`updated_at` with 400-retry fallback shipped. | ⛔ → ◐ best-effort |
| 2026-07-11 | Searchable provenance custom fields (`Original Ticket ID`, `Source Platform`) written per ticket — look up a migrated ticket by its old Zendesk number (matches Help Desk Migration's primary method). | — → ✅ In-Scope |
| 2026-07-11 | Provenance moved fully to custom fields (added `Original Created`, `Original Updated`); in-thread migration note removed to keep the conversation clean. | ◐ note → ✅ fields-only |
| 2026-07-11 | Rich text / HTML preserved — description + replies/notes migrate via `html_body` (bold, headings, lists, links no longer flattened to markdown). | 🛠 → ✅ In-Scope |
| 2026-07-11 | **Clean-migration default** — destination reads native: per-message `[Originally sent]` prefix moved behind opt-in `provenanceMode: forensic`; provenance trimmed to 2 searchable fields (`Original Ticket ID`, `Source Platform`); timeline → migration report. | forensic-by-default → ✅ clean default |
| 2026-07-11 | **Notification pre-flight gate** — live runs block with a checklist to disable Freshdesk notifications/automations (no reliable per-request suppression exists), preventing emails to real customers. | ⛔ risk → ◐ gated |
| 2026-07-12 | **Batch checkpointing** — load phase now chunks each type into `config.batchSize` batches, each persisted as a `batches` record (status, attempts, `{in/ok/skipped/failed}` counts, timings). Done batches skip on resume; a paused run pinpoints the stopping batch. | schema-only → ✅ In-Scope |
| 2026-07-12 | **Live progress & ETA** — `GET /projects/:id/progress` + in-run dashboard surface records/min throughput, per-type batch status, the active batch and a best-effort ETA (honest null when the total isn't yet known), aggregated from the batch records. | — → ✅ In-Scope |
| 2026-07-11 | **Assignee fixed** — Zendesk `group_memberships` migrated onto agents (→ FD `group_ids`), admins extracted as agents, membership re-applied to reused agents via `afterReuse`. Ticket assignment now sticks on a clean target. | ❌ → ✅ In-Scope |
| 2026-07-11 | **CC / collaborators fixed** — collaborator user-ids resolved to emails at extraction, set as Freshdesk `cc_emails`. | ❌ → ✅ In-Scope |
| 2026-07-11 | **Custom-field VALUES (safe types) fixed** — text/paragraph/number/decimal/checkbox/date values migrate by resolved `cf_` name; ticket create strips a rejected custom field and retries (best-effort). | ❌ → ✅ In-Scope (safe types) |
| 2026-07-11 | **Ticket-field dedup** — reuse an existing custom field by label instead of creating `cf_vip_flag / cf_vip_flag643652 / …` duplicates on re-runs. | bug → ✅ fixed |
| 2026-07-12 | **No ticket lost to an unresolved reference** — requester with no email → `unique_external_id` placeholder contact; assignee/group/company that didn't map → dropped so the ticket lands unassigned; reply by a deleted/deactivated author → re-posted as the migrating agent. Ticket create now LOOPS to peel Freshdesk's sequential validation (group_id → timestamps → …). Verified: **124/124 tickets, 0 failed** (was 24 failing). | 🛠 → ✅ In-Scope |
| 2026-07-12 | **Self-throttle to the account's real API limit** — `FRESHDESK_RPM`/`ZENDESK_RPM`; trial Freshdesk is 50/min (read live from `x-ratelimit-total`), so the default now stays under it. Eliminated 429 storms (0 in a clean run). | bug → ✅ fixed |
| 2026-07-13 | **SLA client-hardening** (transformer extracted to `src/mapping/transformers/sla.js` + 12 unit tests). Constraints proven live, not assumed: all 4 priorities + respond/resolve/business_hours/escalation are mandatory. So (1) unset targets are defaulted AND **every default is reported** (audit) — never silent; (2) scope is only auto-created when **faithfully reproducible** (type/group/company) — policies using priority/brand/tags conditions, OR-logic, unmigrated groups, or applies-to-all are **checklisted, not broad-applied** (removed the fabricated "all groups" fallback that could apply a VIP SLA to everyone); (3) `applicable_to.ticket_types` validated against the target's real types; (4) business hours flagged (calendar not API-migratable). Upsert hardened (paginated, case-insensitive name match). Known limit: policy **order** isn't API-settable (`position` rejected) — flag to verify in Freshdesk. | ◐ → ✅ In-Scope (faithful + audited) |
| 2026-07-13 | **SLA re-run safety (upsert-by-name)** — Freshdesk enforces UNIQUE SLA names (proven live: a duplicate POST 400s "name already exists"), so duplicates are impossible but the old code hard-FAILED on re-runs the idmap didn't track. Connector now finds the policy by name → PUT-updates it. Verified live: same id, value updated, one policy — no fail, no dup. (Same-project tracked re-runs still idmap-skip; unchanged.) | bug → ✅ fixed |
| 2026-07-13 | **SLA policies now migrate** — real transformer (was a stub): Zendesk `policy_metrics` (flat array, minutes) → Freshdesk `sla_target` object (priority_1..4, seconds); `first_reply_time`→respond, `next_reply_time`/`periodic_update_time`→next-respond (≥30s or omitted), `agent_work_time`/`requester_wait_time`→resolve (documented proxy — Zendesk has no resolution SLA); filter → `applicable_to` (ticket_types/group_ids/company_ids, best-effort). **Live-verified: `POST /sla_policies` → 201 accepted** against cloudfuze-help. | ◐ partial → ✅ In-Scope |
| 2026-07-12 | **AI migration guide ("Fuze")** — right-side assistant panel (OpenAI/Azure OpenAI, streamed) that walks the user through the 7-step Zendesk→Freshdesk wizard in sequence and can drive it: navigate steps, set data scope, start dry run, and (on confirmation) go live. Fires a step-context prompt on every step change; live migration is gated behind an explicit "Yes, proceed". | — → ✅ In-Scope (guided migration UX) |

<!-- TEMPLATE — copy for each new entry:
| YYYY-MM-DD | <what changed, one line> | <badge before> → <badge after> |
-->

---

*Validated against the shipped codebase (`src/mapping/matrix.js`, `src/mapping/transformers/index.js`, `src/mapping/valueMaps.js`). When code and this doc disagree, the code wins — update this doc.*
