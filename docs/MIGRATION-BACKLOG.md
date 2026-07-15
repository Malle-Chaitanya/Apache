# Migration Feature Backlog — one task at a time

**How to use.** Pick the top open task in your stream, implement it, tick it here. **Definition of Done (every task):**
1. Transformer/loader change in the named file/function.
2. A unit test in the matching `test/*.test.js` that asserts the **real** behavior (not a placeholder).
3. `node --test` is fully green.
4. Move the row here to ✅ **and** update the matching row in [COVERAGE-COMPETITOR-TEST-MATRIX.md](./COVERAGE-COMPETITOR-TEST-MATRIX.md).

**Status:** ☐ Todo · 🔄 In progress · ✅ Done · 🚫 Won't build (platform-blocked)
**Test key:** `vm`=valueMaps · `tf`=transformers · `int`=engine.integration · `paths`=engine.paths

---

## Stream 1 — Contact & Org fidelity  *(independent — start anytime)*
| ID | Status | Task | Pri | File · function | Source → Target | Test |
|---|---|---|---|---|---|---|
| U1 | ☐ | Contact phone | P1 | `transformers.user` | `phone` → `phone` | tf |
| U2 | ☐ | Contact mobile | P1 | `transformers.user` | `phone`/`mobile` → `mobile` | tf |
| U3 | ☐ | Contact custom fields | P1 | `transformers.user` + `loader` (record FD field names) | `user_fields` → `custom_fields` | tf, paths |
| U4 | ☐ | Contact timezone (+ value map) | P2 | `transformers.user` + new map | `time_zone` → `time_zone` | vm |
| U5 | ☐ | Contact language | P2 | `transformers.user` | `locale` → `language` | tf |
| U6 | ☐ | Contact tags | P2 | `transformers.user` | `tags` → `tags` | tf |
| U7 | ☐ | Contact notes | P2 | `transformers.user` | `notes` → `description` *(verify FD field)* | tf |
| U8 | ☐ | Suspended/deleted user handling | P2 | `transformers.user` + extractor | `suspended`/`active` → skip/manual | tf |
| O1 | ☐ | Company notes | P1 | `transformers.organization` | `notes` → `note` | tf |
| O2 | ☐ | Company custom fields | P1 | `transformers.organization` + `loader` | `organization_fields` → `custom_fields` | tf |
| O3 | ☐ | Company details/tags | P2 | `transformers.organization` | `details` → `description` *(FD has no company tags — verify)* | tf |

## Stream 2 — Ticket enrichment  *(all edit `transformers.ticket` — ONE owner / serialize)*
| ID | Status | Task | Pri | File · function | Source → Target | Test |
|---|---|---|---|---|---|---|
| T1 | ☐ | Ticket due date | P1 | `transformers.ticket` | `due_at` → `due_by`, `fr_due_by` | tf |
| T2 | ☐ | Ticket form assignment | P1 | new form model + `transformers.ticket` | `ticket_form_id` → `ticket_form_id` | tf, paths |
| T3 | ☐ | CSAT / satisfaction ratings | P1 | new extractor + transformer | rating → FD survey *(verify creatable)* | tf |
| T4 | ☐ | Followers/watchers | P1 | extractor + `transformers.ticket` | `follower_ids` → watcher/cc *(verify)* | tf |
| T5 | ☐ | Submitter | P2 | `transformers.ticket` | `submitter_id` → *(no FD equiv — note/skip)* | tf |
| T6 | ☐ | Brand → product on ticket | P2 | `transformers.ticket` | `brand_id` → `product_id` | tf |

## Stream 3 — Custom-field VALUE crosswalk  *(edits `transformers.ticket` + `loader.js` — serialize after Stream 2)*
| ID | Status | Task | Pri | File · function | Source → Target | Test |
|---|---|---|---|---|---|---|
| CF1 | ☐ | Dropdown value crosswalk on tickets | P1 | `transformers.ticket` cfv + `loader.js` (store option map) | tagger value → `custom_fields.cf_*` | tf, paths |
| CF2 | ☐ | System field values | P2 | `transformers.ticket` cfv | system fields → best-effort | tf |
| CF3 | ☐ | Lookup field type | P2 | `transformers.ticketField` + `FIELD_TYPE` | `lookup` → conflict (not silent text) | tf |

## Stream 4 — KB completeness  *(independent — start anytime)*
| ID | Status | Task | Pri | File · function | Source → Target | Test |
|---|---|---|---|---|---|---|
| K1 | ☐ | Article inline-image rehost | P1 | `transformers.kbArticle` + loader rehost | `<img zendesk>` → uploaded + rewritten | tf |
| K6 | ☐ | Translations (multi-locale) | P1 | `transformers.kbArticle` + extractor | `translations` → FD translations | tf, int |
| K2 | ☐ | Article attachments | P2 | `transformers.kbArticle` + loader | attachments → FD article attachments | int |
| K3 | ☐ | Article author | P2 | `transformers.kbArticle` | `author_id` → resolve to agent | tf |
| K4 | ☐ | Article labels/tags | P2 | `transformers.kbArticle` | `label_names` → `tags` | tf |
| K5 | ☐ | Archived state | P2 | `transformers.kbArticle` | archived → status | tf |

## Stream 5 — Relationships (P2)  *(hold until Stream 2 & 3 land)*
| ID | Status | Task | Pri | File · function | Source → Target | Test |
|---|---|---|---|---|---|---|
| R1 | ☐ | Parent/child links | P2 | `transformers.ticket` + idmap edge | parent/child → related/note | tf |
| R2 | ☐ | Linked problem/incident | P2 | `transformers.ticket` | `problem_id` → note/tag | tf |
| R3 | ☐ | Merge history | P2 | extractor + transformer | merge audit → note | tf |
| R4 | ☐ | Side conversations | P2 | new extractor + child | side convos → notes | int |
| R5 | ☐ | @mention rewriting | P2 | `transformers.ticket` child body | `@mentions` → rewritten | tf |

---

## 🚫 Won't build — ship as guided checklist (Freshdesk API / platform blocks the write)
Views · Automations/Triggers create · Custom Roles create · Permissions · Business Hours create · Products create · Emoji (utf8mb3) · exact message-timestamp backdating · ticket Closed Time.

---

## Changelog
| Date | ID | What landed |
|---|---|---|
| 2026-07-12 | — | Backlog created; test suite baselined at 69 green. |
| 2026-07-12 | ENG | Wired `batches` collection into the load phase (`loader.loadType`): work is chunked into `config.batchSize` batches, each a checkpointed/retryable `batches` doc with `{in/ok/skipped/failed}` counts, attempts + timings; done-batch resume skip. 3 tests in `engine.batches.test.js`; suite now 72 green. |
| 2026-07-15 | SLA | Live 18-case edge sweep (full round-trip diffs on cloudfuze-help). Found + fixed: a sub-30s respond/resolve target (or stray 0) 400s the whole policy ("must be >= 30", proven live) → transformer now clamps to Freshdesk's 30s floor and reports it. +1 unit test (24 green). Verified live: full-field round-trip all MATCH, org/group/mixed scope round-trips, invalid ticket-type dropped, 365-day value preserved, disabled honored, duplicate-name upserts in place. Confirmed limitation: SLA `position` is not API-settable → source evaluation ORDER not reproducible (surfaced via notes/sortKey; recommend an ordering advisory). |
| 2026-07-15 | SLA | Fixed operator-blind SLA scoping (proven live on cloudfuze-help): a negation/comparison operator (`is_not`, `less_than`, …) on type/group/org no longer inverts the scope — such conditions now go MANUAL (faithful-or-manual). Added defensive non-array `policy_metrics` guard. +4 unit tests in `sla.test.js` (23 green); rewrote a stale `transformers.test.js` SLA test (pre-existing failure, not caused by the fix — proven via stash). Confirmed live: Case 2 → MANUAL, happy path creates+verifies, re-run reuses same id (idempotency already handled via PUT-on-duplicate). NOTE: Freshdesk has NO delete API for SLA policies (405) — re-runs upsert by unique name, no dup risk. |
| 2026-07-12 | ENG | Live progress/observability: `engine/progress.computeProgress` aggregates the `batches` records into per-type batch status, records/min throughput (real load-phase wall-clock), active batch and best-effort ETA (null when total unknown — no fabricated number). Exposed at `GET /projects/:id/progress`; live `Progress` dashboard shows throughput/ETA/active-batch/batches-done. Rate-limit backoff was already handled by `httpClient` (429/5xx + Retry-After), so this — not worker-scaling — was the real marginal value. 3 tests in `engine.progress.test.js`; suite now 75 green. |
