# Ticket Migration — QA Validation Report

**Scope:** Zendesk → Freshdesk · 2 scenario tickets · **Zendesk #17 → Freshdesk #14**, **Zendesk #18 → Freshdesk #15**
**Run date:** 2026-07-11 · **Mode:** Config + Data, `provenanceMode: clean` (default)
**Method:** each value pulled live from *both* platforms' APIs and compared (not eyeballed).

**Legend:** ✅ Pass · ❌ Fail · ⚠️ Partial / disclosed caveat · 🚫 Not exercised (needs dedicated fixture)

## Scoreboard
- ✅ **28** pass · ⚠️ **7** partial · ❌ **3** fail · 🚫 **behavioral set** not exercised
- **Fails:** #12 admin assignee (Ticket 2), #37 CC, #38 custom-field values
- **Top watch items:** assignee only works via a manual group-add today; emoji lost (platform); duplicate custom fields accumulating across re-runs

---

## A. Ticket Creation
| # | Case | Zendesk | Freshdesk | Result | Remarks |
|---|---|---|---|---|---|
| 1 | Ticket created / no dup | #17, #18 | #14, #15 (total tickets = 2) | ✅ | idmap crosswalk stored; audit count source 2 = dest 2 |
| 2 | Subject | `Cannot log in…` / `Billing issue 請求書 😀 —…` | identical / `…請求書 ? —…` | ⚠️ | #17 exact ✅. #18 **emoji `😀` → `?`** (Freshdesk utf8mb3 platform limit); Japanese/CJK preserved |
| 3 | Description | plain / rich HTML | rendered HTML (`<h2>/<strong>/<em>/<a>/<ul>`) | ✅ | rich text preserved via `html_body` |
| 4 | Type | incident / question | Incident / Question | ✅ | |
| 5 | Priority | high / urgent | High / Urgent | ✅ | |
| 6 | Status | open / solved | Open / **Resolved** | ✅ | Now correct both. ⚠️ *historically inconsistent (an earlier run showed Open for solved)* — recommend setting status **after** conversation load to make it deterministic |
| 7 | Tags | migration,urgent,vip / edge-case,rich-text,tier_2,unicode | identical | ✅ | |
| 8 | Source | api / api | Portal / Portal | ⚠️ | Freshdesk has no "API" source → mapped to Portal (lossy by necessity). Only `api` channel tested |

## B. Requester Mapping
| # | Case | Zendesk | Freshdesk | Result | Remarks |
|---|---|---|---|---|---|
| 9 | Customer name | Nina / Omar | Nina / Omar | ✅ | |
| 10 | Customer email | nina@… / omar@… | exact match | ✅ | |
| 11 | Company | Acme / Globex | Acme / Globex (ticket + contact both linked) | ✅ | org→company + contact-company association both correct |

## C. Agent Mapping
| # | Case | Zendesk | Freshdesk | Result | Remarks |
|---|---|---|---|---|---|
| 12 | Assignee / responder | abhilasha (agent) / Chaitanya (admin) | abhilasha / **(none)** | ❌ | **Ticket 2 admin assignee is null** (admins aren't extracted as agents). **Ticket 1 only shows abhilasha because she was manually added to the Support group during testing** — the tool does **not** yet migrate agent→group membership, so on a clean target both would be blank. *Real fix pending.* |
| 13 | Ticket creator | Nina / Omar | Chaitanya (API user) | ⚠️ | Expected — every migration-API record is authored by the token user. Original requester preserved separately |

## D. Conversation
| # | Case | Zendesk | Freshdesk | Result | Remarks |
|---|---|---|---|---|---|
| 14 | Conversation count | 5 comments (4 pub + 1 priv) | 4 items (3 replies + 1 note) | ✅ | Correct — the first comment becomes the **description** (not re-imported), so 5 → 4 by design (no duplicate opening) |
| 15 | Order | chronological | ascending by created_at | ✅ | |
| 16 | Customer replies | present | present | ✅ | |
| 17 | Agent replies | present | present | ✅ | |
| 18 | Private notes stay private | 1 internal | 1 private note | ✅ | routed to `/notes`; never public |
| 19 | Author attribution | customer / agent | contact / agent | ⚠️ | #17 correct. #18 admin replies attribute via **API-user fallback** (admin not in idmap) — visually correct here only because API user = that admin |

## E. Attachments
| # | Case | Zendesk | Freshdesk | Result | Remarks |
|---|---|---|---|---|---|
| 20 | Count | #17: pdf+png / #18: csv | #17: 2 / #18: 0 | ✅ | |
| 21 | Names | spec.pdf, screenshot.png | identical | ✅ | |
| 22 | Not corrupted | 240b / 70b | byte sizes match | ✅ | size preserved (open-test not automated) |
| 23 | Size | 240 / 70 | 240 / 70 | ✅ | |
| 24 | MIME | pdf / `application/unknown` (png) | application/pdf / **image/png** | ✅ | Freshdesk corrected the png MIME |
| 25 | Large attachment (>20 MB) | big-export.csv 22 MB | **skipped** (conflict) | ✅ | Correct — `attachment_too_large` conflict raised; ticket + other replies still migrated |

## F. Rich Content
| # | Case | Zendesk | Freshdesk | Result | Remarks |
|---|---|---|---|---|---|
| 26 | Unicode | 日本語 中文 العربية 😀 | CJK/Arabic ✅, emoji `?` | ⚠️ | BMP preserved; **emoji (4-byte) stripped by Freshdesk utf8mb3** |
| 27 | Markdown / headings / lists | `## / •` | rendered `<h2>/<ul>` | ✅ | |
| 28 | Hyperlinks | link | `<a href>` preserved | ✅ | |
| 29 | Line breaks | present | preserved | ✅ | |
| 30 | HTML escaping | — | no broken HTML | ✅ | |

## G. Metadata
| # | Case | Zendesk | Freshdesk | Result | Remarks |
|---|---|---|---|---|---|
| 31 | Created time | 2026-07-10 22:32 | migration-time | ⚠️ | Freshdesk rejects backdating on this plan; original preserved in migration report |
| 32 | Updated time | 2026-07-10 22:43 | migration-time | ⚠️ | same |
| 33 | Resolution time | present | not migrated | ⚠️ | deferred |

## H. Relationships
| # | Case | Zendesk | Freshdesk | Result | Remarks |
|---|---|---|---|---|---|
| 34 | Organization | Acme / Globex | correct | ✅ | |
| 35 | Group | Support | Support | ✅ | |
| 36 | Followers | none seeded | none | 🚫 | no follower data to test |
| 37 | CC / collaborators | #18: Priya | **dropped** | ❌ | `collaborator_ids`/`email_cc_ids` not mapped to Freshdesk `cc_emails` yet |
| 38 | Custom-field VALUES | 11 / 15 source values | **not migrated** (only provenance fields set) | ❌ | Deferred v2 (fields migrate; per-ticket values need source→target field-ID crosswalk). **Also flagged:** duplicate `cf_vip_flag*` fields accumulating across re-runs (config field idempotency) |
| 39 | ID mapping | 17 / 18 | 17→14, 18→15 stored per project | ✅ | idmap persisted (crosswalk works) |
| 40 | Re-run / no duplicate | source 2 | dest 2 | ✅ | Clean now (Freshdesk was wiped). ⚠️ *within a project idempotent; a fresh project + non-empty Freshdesk would duplicate tickets — content-dedup pending* |

---

## 🚫 Behavioral cases — NOT exercised by these 2 static tickets
These need dedicated fixtures / fault injection and are out of scope for this fixture set:

| Case | Why not covered |
|---|---|
| Deleted user / agent / org (source) | Requires deleting a source actor mid-migration |
| Ticket merge / spam / archived | No such source tickets seeded |
| Partial-migration resume (kill → restart) | Checkpoint infra exists; needs a controlled kill test |
| Rate-limit / token-expiry / network-failure | Retry/backoff observed (429 on `/tickets`, `/products` handled); full fault test pending |
| Full status matrix (new/pending/hold/closed) | Only open + solved seeded |
| Full priority matrix (low/normal) | Only high + urgent seeded |
| Full source matrix (email/web/phone/chat) | All fixtures are `api` channel |

---

## Open defects (ranked)
1. **#12 Assignee** — migrate agent→group membership + extract admins as agents (highest value; today only works via manual group-add).
2. **#37 CC** — map `collaborator_ids`/`email_cc_ids` → Freshdesk `cc_emails`.
3. **#38 Custom-field values** — apply source→target field-ID crosswalk (v2); also dedupe custom fields on re-run (config idempotency, same class as KB category 409).
4. **#6 Status determinism** — set final status *after* conversation load (currently order-dependent).
5. **Platform limits (not our defects):** emoji (utf8mb3), created/updated backdating, "created by" = API user, source `api`→Portal.

*Rerun this checklist after every migration feature. Validated against shipped code; when code and this report disagree, the code wins — update this report.*
