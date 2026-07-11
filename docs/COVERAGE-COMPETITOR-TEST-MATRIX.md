# Coverage · Competitor · Test Matrix — Zendesk → Freshdesk

**Purpose.** One artifact that answers three questions at once: *what do competitors actually migrate?*, *what does our tool actually migrate (per the shipped code, not the pitch)?*, and *what must we test?* It is the product roadmap, the QA checklist, and the competitive analysis in one place.

**Grounding rules (important).**
- The **Our Tool** column is derived **only from the shipped code** — `src/mapping/transformers/index.js`, `valueMaps.js`, `loader.js`, `reconciler.js`, `extractor.js`. Where the code doesn't set a field, it's a ❌ here even if a doc claims otherwise. When code and any doc disagree, **the code wins**.
- The **Test** column points at the automated check that pins the behavior (`vm`=valueMaps.test, `tf`=transformers.test, `int`=engine.integration.test, `paths`=engine.paths.test). "manual/E2E" = needs a live-tenant validation, not yet automatable here.
- The **competitor** columns are from public product capability (my knowledge) and **must be verified against a live trial** before quoting to a customer. They describe *product category behavior*, not a guarantee of a specific field.

**Legend:** ✅ full · ◐ partial/caveated · ❌ not done · N/A not in that product's scope · 🚫 destination platform blocks it (no tool can).

---

## 0. Competitor positioning — they are NOT the same category

The single most important insight: our three "competitors" do **three different jobs**. Comparing them field-by-field only makes sense once you know which job each does.

| Product | Category | What it moves | What it does *not* | Overlap with us |
|---|---|---|---|---|
| **Help Desk Migration (Relokia)** | One-time **data** migration SaaS | Tickets (+fields, replies, notes, attachments, CC, tags, custom fields), Contacts, Organizations, Agents (with matching), KB (categories/sections/articles). Add-ons: inline images, CSAT, tags, time logs. | **Configuration** — triggers, automations, macros, SLAs, business hours, views, forms. Leaves them 100% manual. | **This is our real head-to-head on ticket/KB data.** |
| **Salto** | **Configuration**-as-code / environment management | Zendesk *config* between environments (sandbox↔prod / account↔account): fields, triggers, automations, macros, SLAs, business hours, views, groups, dynamic content, custom objects — versioned like Git. | **Transactional data** — tickets, users, orgs. Not a helpdesk-data migrator. | Overlaps our **config** story; but Salto is Zendesk↔Zendesk, not Zendesk→Freshdesk. |
| **Exalate** | Bi-directional **sync**/integration | Ongoing, scriptable, two-way sync of tickets/issues + comments + attachments + selected fields across Jira/Zendesk/ServiceNow/etc. | One-time full migration with reconciliation; KB; config/automations. | Overlaps ticket/comment movement, but as *continuous sync*, not a cutover. |

**Our differentiated position (verifiable from `matrix.js`):** we are the only one of the four that does **data *and* configuration in a single one-time Zendesk→Freshdesk cutover**, deterministically and idempotently, and hands the admin a **pre-filled checklist** for anything Freshdesk's API refuses to create. HDM ignores config; Salto ignores ticket data; Exalate is a sync engine, not a cutover.

> ⚠️ **Verify-before-quote:** confirm each competitor's exact field support against a live trial (HDM offers a free demo migration; Salto/Exalate have trials). This doc is the hypothesis to test, not the citation.

---

## 1. TICKETS — the field-heaviest object (HDM exposes ~178 mappable fields here)

| Field / behavior | HDM | Salto | Exalate | **Our Tool (code-verified)** | Test | Priority |
|---|---|---|---|---|---|---|
| Subject | ✅ | N/A | ✅ | ✅ placeholder `(no subject)` if empty | tf | — |
| Description (rich HTML) | ✅ | N/A | ✅ | ✅ from first comment `html_body`, HTML preserved | tf | — |
| Status | ✅ | N/A | ✅ | ✅ `mapStatus` (hold→pending) | vm,tf | — |
| Priority | ✅ | N/A | ✅ | ✅ `mapPriority` | vm,tf | — |
| Source / channel | ✅ | N/A | ◐ | ✅ `mapSource` (unknown→portal) | vm,tf | — |
| Type | ✅ | N/A | ◐ | ◐ Question/Incident/Problem; **task folds away** | tf | — |
| Group | ✅ | N/A | N/A | ✅ resolved via idmap (else null) | tf | — |
| Assignee / responder | ✅ (agent matching) | N/A | ◐ | ✅ resolved; unmatched → unassigned | tf | — |
| Requester | ✅ | N/A | ✅ | ✅ resolved; **conflict raised if unmigrated** | tf | — |
| Company / organization | ✅ | N/A | N/A | ✅ resolved | tf | — |
| Tags | ✅ | N/A | ◐ | ✅ verbatim | tf | — |
| CC / collaborators | ✅ | N/A | ◐ | ◐ `cc_emails` from `collaborator_emails` only | tf | P2 |
| Created / updated timestamps | ✅ | N/A | ◐ | ◐ best-effort on create, 400-retry drops them | manual/E2E | P1 |
| Public replies | ✅ | N/A | ✅ | ✅ → `/reply`, author preserved | tf,int | — |
| Private/internal notes | ✅ | N/A | ✅ | ✅ → `/notes` with `private:true` | tf,int | — |
| First-comment-as-description dedup | ✅ | N/A | — | ✅ no duplicate opening message | tf | — |
| Attachments | ✅ | N/A | ✅ | ✅ ≤20 MB; oversize → conflict | int | — |
| Inline images in body | ◐ add-on | N/A | ◐ | ◐ file re-uploaded as attachment + marker | tf | P1 |
| Custom-field values (safe types) | ✅ | N/A | ◐ | ✅ text/number/decimal/checkbox/date, coerced | tf | — |
| Custom-field values (dropdown/system) | ✅ | N/A | ◐ | ❌ skipped (no value crosswalk yet) | tf | **P1** |
| Emoji / 4-byte unicode | 🚫 (utf8mb3) | N/A | 🚫 | 🚫 Freshdesk `utf8mb3` limit | manual/E2E | — |
| **Followers / watchers** | ◐ | N/A | ✅ | ❌ **not extracted or set** | — | **P1** |
| **CSAT / satisfaction rating** | ◐ add-on | ❌ | ❌ | ❌ **not present** | — | **P1** |
| **Due date / SLA timers on ticket** | ◐ | N/A | ◐ | ❌ `due_by`/`fr_due_by` not set | — | **P1** |
| **Parent/child & linked problem/incident** | ◐ | N/A | ◐ | ❌ relationships not migrated | — | **P2** |
| **Merge history** | ◐ | N/A | ❌ | ❌ not migrated | — | P2 |
| **Side conversations** | ◐ | N/A | ◐ | ❌ not migrated | — | P2 |
| **Time tracking / time logs** | ◐ add-on | N/A | ❌ | ❌ not migrated | — | P2 |
| **Ticket form assignment** | ◐ | N/A | N/A | ❌ forms not modeled | — | **P1** |
| Audit / trigger / macro history | ❌ | N/A | ❌ | ❌ (out of scope for all) | — | — |

---

## 2. CONVERSATION / COMMENTS

| Field | HDM | Exalate | **Our Tool (code)** | Test | Priority |
|---|---|---|---|---|---|
| Author preserved | ✅ | ✅ | ✅ resolve user→agent | tf | — |
| Public vs private routing | ✅ | ✅ | ✅ split endpoints | tf | — |
| HTML formatting | ✅ | ✅ | ✅ `html_body` | tf | — |
| Empty-body guard | — | — | ✅ backfills `(no message text)` | tf | — |
| Original send time | ◐ | ◐ | ◐ forensic mode prefix (opt-in) | tf | — |
| Per-message attachments | ✅ | ✅ | ✅ downloaded+reuploaded | int | — |
| @mentions | ◐ | ◐ | ❌ not rewritten | — | P2 |
| Quoted-reply / email headers | ◐ | ◐ | ❌ | — | P2 |

---

## 3. USERS → CONTACTS

| Field | HDM | Exalate | **Our Tool (code)** | Test | Priority |
|---|---|---|---|---|---|
| Name | ✅ | ✅ | ✅ | tf | — |
| Email | ✅ | ✅ | ✅ (dedup by email) | tf,paths | — |
| Company link | ✅ | N/A | ✅ resolved | tf | — |
| **Phone / mobile** | ✅ | ◐ | ❌ **not set** | — | **P1** |
| **Job title** | ✅ | ◐ | ❌ | — | P2 |
| **Time zone / language** | ✅ | ◐ | ❌ | — | P2 |
| **Tags / notes** | ✅ | ◐ | ❌ | — | P2 |
| **Custom fields** | ✅ | ◐ | ❌ | — | **P1** |
| **Secondary emails / identities** | ◐ | ◐ | ❌ | — | P2 |
| **Avatar** | ◐ | ❌ | ❌ | — | P3 |
| Suspended / deleted state | ◐ | ❌ | ❌ | — | P2 |

---

## 4. ORGANIZATIONS → COMPANIES

| Field | HDM | **Our Tool (code)** | Test | Priority |
|---|---|---|---|---|
| Name | ✅ | ✅ (dedup by name) | tf,paths | — |
| Domains | ✅ | ✅ | tf | — |
| **Notes / details** | ✅ | ❌ | — | **P1** |
| **Org custom fields** | ✅ | ❌ | — | **P1** |
| **Tags** | ✅ | ❌ | — | P2 |
| Group associations | ◐ | ❌ | — | P2 |

---

## 5. AGENTS · GROUPS · ROLES (config)

| Field | HDM | Salto | **Our Tool (code)** | Test | Priority |
|---|---|---|---|---|---|
| Agent name/email | ✅ (match) | ✅ | ✅ | tf | — |
| Agent role | ◐ | ✅ | ◐ mapped to FD default role | vm,tf | — |
| Agent group membership | ◐ | ✅ | ✅ `group_ids` resolved + re-applied on reuse | tf | — |
| Ticket scope | ❌ | ✅ | ✅ derived from role | vm | — |
| Billing-admin nuance | ❌ | ◐ | ✅ surfaced as review conflict | tf | — |
| **Agent signature** | ❌ | ✅ | ❌ | — | P2 |
| **Agent skills / availability** | ❌ | ◐ | ❌ | — | P2 |
| Group name/description | ◐ | ✅ | ✅ | tf | — |
| Group business hours | ❌ | ✅ | ❌ (BH is best-effort separately) | — | P2 |
| Roles (custom) | ❌ | ✅ | ◐ mapped to nearest default + conflict (no FD create API) | tf | 🚫 |

---

## 6. KNOWLEDGE BASE

| Field | HDM | Salto | **Our Tool (code)** | Test | Priority |
|---|---|---|---|---|---|
| Categories | ✅ | ◐ | ✅ | tf | — |
| Sections → Folders | ✅ | ◐ | ✅ re-parented | tf | — |
| Articles | ✅ | ◐ | ✅ | tf | — |
| Draft/published state | ✅ | — | ✅ | tf | — |
| Inline images | ◐ | — | ❌ marker only (rehost is a separate step) | tf | **P1** |
| **Author** | ◐ | — | ❌ | — | P2 |
| **Translations / multi-locale** | ◐ | ◐ | ❌ | — | **P1** |
| **Article attachments** | ◐ | — | ❌ | — | P2 |
| **Tags / SEO meta** | ◐ | — | ❌ | — | P2 |
| **Internal-link rewriting** | ◐ | — | ❌ | — | P2 |
| Scheduled publishing / ordering | ❌ | — | ❌ | — | P3 |

---

## 7. CONFIGURATION (our differentiator — HDM = all ❌, Salto = ✅ but Zendesk↔Zendesk only)

| Object | **Our Tool (code)** | Feasibility (from `matrix.js`) | Test | Priority |
|---|---|---|---|---|
| Ticket fields (custom) | ✅ type+choices+required; dedup by label | transform | tf | — |
| Dependent/conditional fields | ❌ | — | — | P2 |
| Macros → canned responses | ✅ reply text; field actions → conflict | partial | tf | — |
| Triggers → rule IR | ◐ translated to IR + checklist (no FD create API) | manual | tf | 🚫 |
| Automations → rule IR | ◐ same | manual | tf | 🚫 |
| SLA policies | ◐ best-effort create → checklist | partial | tf | — |
| Business hours | ◐ best-effort (FD GET-only) | manual | tf | 🚫 |
| Brands → products | ◐ best-effort (FD read-only) | manual | tf | 🚫 |
| **Views** | ❌ not modeled | — | — | P2 |
| **Dynamic content** | ❌ | — | — | P2 |
| **Ticket forms** | ❌ | — | — | **P1** |
| **Custom objects** | ❌ | — | — | P3 |
| **Webhooks / targets** | ❌ | — | — | P3 |

---

## 8. Prioritized gap backlog (what we actually miss — code-verified)

**P0 — none open in the *data* path.** The core ticket/user/org/comment path is functionally complete and now regression-tested. (P0s live in the UX layer — agent-matching UI, object selection — tracked in the HDM teardown, not here.)

**P1 — enterprise-expected, feasible, closes real HDM parity gaps:**
1. **Dropdown / system custom-field VALUES on tickets** — build the option-value crosswalk (safe types already work).
2. **User phone/mobile + user custom fields** — cheap, high-visibility contact fidelity.
3. **Org notes + org custom fields.**
4. **Ticket followers/watchers.**
5. **CSAT / satisfaction ratings** (HDM ships this as an add-on).
6. **Due date / SLA timers on the ticket** (`due_by`, `fr_due_by`).
7. **Ticket form assignment** (model forms, map to FD ticket forms).
8. **KB inline-image rehosting** (already done conceptually for articles' marker — finish the upload) **+ KB translations.**

**P2 — differentiators / long-tail:** parent-child & linked ticket relationships, merge history, side conversations, time logs, @mention rewriting, agent signatures/skills, group business hours, views, dynamic content, KB author/attachments/tags/link-rewriting, suspended/deleted users.

**P3:** avatars, scheduled KB publishing, custom objects, webhooks/targets.

**🚫 Not our gap (Freshdesk API refuses the write) — ship as checklist, don't chase:** automation-rule create, custom-role create, business-hours create, products create, emoji/4-byte unicode (utf8mb3). These are the "not our tool" sales answers.

---

## 9. Test suite — current state & what's still manual

**Automated (this repo, `node --test`): 69 tests, all green.**

| File | Covers |
|---|---|
| `test/valueMaps.test.js` (15) | status/priority/source/field-type crosswalks + fallbacks; `mapAgentRole` (admin/billing/light/contributor/custom-role precedence); billing-safety invariant. |
| `test/transformers.test.js` (48) | every transformer + branch; custom-field coercion (int/decimal/checkbox/text-truncate/null/unmapped); inline-image handling; first-comment dedup; public/private routing; empty-body guard; forensic vs clean; value-map overrides + "use for empty"; requester-missing conflict. |
| `test/engine.integration.test.js` (1) | extract→load→reconcile happy path + oversized-attachment conflict + failed-child surfacing. |
| `test/engine.paths.test.js` (5) | dry-run (no writes), 409 idempotent reuse, re-run safety (zero dup creates), field-skips, reconcile totals. |

**Still needs live-tenant / E2E validation (cannot be unit-tested here):**
- Timestamp backdating: which Freshdesk plans accept `created_at` on create vs 400-retry.
- Emoji/utf8mb3: confirm what actually lands on Freshdesk (proves the "platform limit" framing).
- Real attachment download/upload round-trip and rate-limit (429) behavior under load.
- Idempotency against a *real* Freshdesk 409 body shape per object type.
- KB inline-image rehost end-to-end.
- Notification-suppression pre-flight actually preventing customer emails.

**Suggested next automated additions (P1-aligned, when features land):** contact phone/custom-field mapping test; org notes/custom-field test; ticket followers test; CSAT test; dropdown-value-crosswalk test; ticket-form assignment test.

---

*Companion to `FEATURE-SUPPORT-MATRIX.md` (sales-facing) and `COMPETITIVE-HDM-FLOW-TEARDOWN.md` (UX layer). This doc is engineering/QA-facing and code-grounded. Competitor cells are hypotheses to verify against live trials, not citations.*
