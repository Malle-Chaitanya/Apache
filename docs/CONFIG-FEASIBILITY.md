# Configuration Migration — Feasibility, Salto Analysis & Alternatives

**Companion to [PRD.md](./PRD.md) §10, §13. · v0.1 · 2026-07-09**
**Questions this answers:**
1. How does **Salto** migrate configuration and automations, and **does their approach work for us?**
2. For each config object, can we deliver it automatically — and if Freshdesk's API can't, **what is the alternative, and is it feasible?**

> **Method note (anti-hallucination):** every API capability is tagged with a **confidence tier**. Where sources conflict it is **VERIFY-LIVE** — confirmed against a real Freshdesk trial in M1 before it enters any sales promise. No customer claim ships on an unverified API.

---

## 1. How Salto works (and the one sentence that matters)

Salto is **configuration-as-code** for SaaS apps (Zendesk, Okta, Salesforce, NetSuite, Jira). Model:

- **Adapters** authenticate to an app and **fetch** its configuration into **NaCl** — a declarative language that captures each config element *and the references between elements* (e.g. a trigger that points at a group/field).
- Fetch builds a **graph** of all config elements, diffed against the workspace state.
- **Deploy** computes the difference between environments and derives a **dependency-ordered execution plan** (maximum safe parallelism), then writes changes via the app's API. It shows an **environment comparison / preview** and flags conflicts before applying.
- Primary use case: **align environments of the *same* platform** — Zendesk sandbox → production, or account → account — for triggers, automations, macros, ticket fields, SLAs, etc.

**The decisive quote (Salto's own docs):**
> *"As a general rule, Salto uses the Zendesk API, so any limitation that the API has, Salto also has."*

### Does Salto's approach work for us? — Verdict: **pattern yes, gap no.**

| Aspect | Salto (Zendesk↔Zendesk) | Us (Zendesk→Freshdesk) | Implication |
|---|---|---|---|
| Platforms | **Same** on both sides | **Different** | Salto never translates; **we must** (trigger→Ticket-Creation rule, brand→product, field-type map). Salto has no cross-platform translation layer. |
| Config model | Identical | Divergent | A Salto "trigger" redeploys as a "trigger". Our trigger becomes a *different object* on Freshdesk. |
| Write capability | Zendesk API **can create** triggers/automations/macros | Freshdesk API **cannot create** automation rules (Tier-3, §3) | A Salto-style deploy against Freshdesk **hits the same wall we found.** Salto inherits the target API's limits — it does *not* remove them. |
| Interface | CLI / config-as-code, for engineers | Product for migration ops + sales | Different audience/packaging. |

**Conclusion:**
- ✅ **Adopt Salto's architecture pattern** — it independently validates our PRD: a **config graph with references**, **dependency-ordered planned deploy**, **environment diff/preview before write**, **conflict alerts**. We already have the equivalents (`mappingRules`, `idmap`, dependency graph, dry-run, `conflicts`). Salto confirms we're on the right track.
- ❌ **Salto does not solve our two hard problems** — cross-platform *translation* and the Freshdesk *automation-write gap*. By its own rule ("any API limitation, Salto also has"), Salto could not automate Freshdesk automations either. So we can't just "use Salto"; the gap is ours to close with §3 alternatives.
- 🎁 **Free reuse:** Salto is open-source ([github.com/salto-io/salto](https://github.com/salto-io/salto)). Their Zendesk adapter is an authoritative, maintained **catalog of every Zendesk config element and its API shape** — we mirror it to make our **extractor** exhaustive instead of rediscovering the object list ourselves.

**Strategic upshot:** Salto is a *same-platform config-management* tool, not a *cross-platform migration* tool. Our Zendesk→Freshdesk + config-automation product is a different, harder category — which is good for differentiation, but means the automation gap is real and we own it.

---

## 2. Freshdesk public-API capability — by confidence tier

### ✅ Tier 1 — CONFIRMED create API (build directly)
| Object | Create endpoint | Note |
|---|---|---|
| Tickets | `POST /api/v2/tickets` | supports `created_at`/`updated_at` for import |
| Conversations (reply/note) | `POST /tickets/{id}/reply`, `/notes` | |
| Contacts / Companies | `POST /contacts`, `/companies` | dedup by email/domain |
| Agents | `POST /agents` | needs seat; `active=false` until email confirm |
| Groups | `POST /groups` | |
| Skills | `POST /skills` | skill-based routing |
| Ticket / Contact / Company fields | `POST /admin/ticket_fields`, `/contact_fields`, `/company_fields` | field-type map (PRD §10.2) |
| Canned responses (+ folders, bulk) | `POST` canned-response endpoints | **macro reply text lands here** |
| Solutions: category/folder/article | `POST /solutions/...` | KB |

### ⚠️ Tier 2 — VERIFY-LIVE (sources conflict; confirm in sandbox)
| Object | Evidence | Plan |
|---|---|---|
| **SLA policies** | One source says create+update APIs exist; historically **update-only** (PUT default). | Test `POST /sla_policies` on a trial → Tier 1 or fall to §3. |
| **Ticket forms** | Create implied but **Enterprise-gated**. | Verify on Enterprise trial; detect plan at CONNECT. |

### ❌ Tier 3 — CONFIRMED read-only, NO create API → needs alternative (§3)
| Object | Evidence |
|---|---|
| **Automation rules** (Ticket Creation / Ticket Updates / Hourly Triggers = old Dispatch'r/Observer/Supervisor) | No create endpoint in any organic source; the one table claiming full CRUD is an AI-summary artifact — **rejected**. |
| **Roles (custom)** | Read-only; `role_ids` assignable to agents, roles not creatable. |
| **Business hours** | `GET` only. |
| **Products** (brand target) | `GET` only. |
| **Scenario automations** (macro target) | "List All" only — read-only. |

**Automation rules are the headline differentiator and have no native create API → §3.1 is the most important section here.**

---

## 3. Alternatives per no-API object (deterministic — no LLM in the decision path)

### 3.1 Automation rules — the big one
We translate each Zendesk trigger/automation to the IR (PRD §10.1). The only question is *how the translated rule is enforced on Freshdesk*:

| # | Alternative | How | Feasibility | Trade-off |
|---|---|---|---|---|
| **A** ⭐ | **Freshworks Custom App (serverless event handlers)** | Private Marketplace app whose FDK server methods subscribe to product events (`onTicketCreate`, `onTicketUpdate`) + scheduled events (time-based), each running the translated IR via the platform Request/Data APIs. | **FEASIBLE — recommended.** Sanctioned, supported, versionable, golden-file testable. Enforces the exact Zendesk logic. | Rules live in our app, not the native Admin→Workflows list; needs customer consent to install; time-based needs scheduled-event quota (VERIFY-LIVE). |
| **B** | **Scripted UI automation** (Playwright, deterministic — not AI) | Scripted browser flow creates each rule *natively* in Admin→Workflows→Automations from the IR, using stable selectors. | **FEASIBLE but brittle.** Produces native, admin-visible rules. | Breaks on UI change; slower; needs admin session + controlled runner; maintenance burden. This is where your original "UI-navigation" idea belongs — as opt-in fallback, never the primary engine. |
| **C** | **Guided rebuild spec** (checklist) | Emit each rule as a precise spec (conditions→actions, target names already resolved via `idmap`) into `conflicts`. | **ALWAYS FEASIBLE.** Zero platform risk; also the audit artifact. | Minutes of admin effort per rule. |
| ✗ | Undocumented/internal API | — | **REJECTED** | Unsupported, ToS risk, silent breakage — violates our reliability contract. |

**Recommendation:** **A** as default (with honest "rules live in-app" disclosure), **B** as paid/opt-in when native rules are required, **C** always generated as safety net + audit.

### 3.2 Custom roles — map to nearest default role via `role_ids` (A) + checklist for genuinely custom ones (C); UI automation (B) optional. Low volume → not a blocker.
### 3.3 Business hours — few per account → checklist (C) default, UI automation (A) optional; SLAs re-link via `idmap`.
### 3.4 Products (brands) — same as business hours; support-email/DNS verification is inherently manual regardless.
### 3.5 Scenario automations (macros) — reply text → **Canned Responses (Tier-1)** ✅; field actions → Custom App (§3.1-A) or checklist. Partial-automated.
### 3.6 SLA policies — if `POST` works → automated; else set **default** via `PUT` + UI automation/checklist for extras.

---

## 4. Feasibility verdict summary
| Config object | Automatable? | Primary method | Fallback |
|---|---|---|---|
| Groups, Agents, Skills, Fields, Canned responses, KB | ✅ Yes | Tier-1 API | — |
| Ticket forms | ✅ (Enterprise) | Tier-1 API (verify plan) | checklist |
| SLA policies | ⚠️ Verify | API if create exists; else default via PUT | UI automation / checklist |
| **Automation rules** | ✅ via alternative | **Custom App (serverless IR handlers)** | UI automation / spec |
| Custom roles | ◐ Partial | map to default roles | UI automation / checklist |
| Business hours | ◐ via alternative | checklist | UI automation |
| Products (brands) | ◐ via alternative | checklist | UI automation |
| Scenario automations | ◐ Partial | canned responses + Custom App | checklist |
| SSO / apps / email-DNS | ✗ Manual | — | checklist (inherently manual) |

**Bottom line:** with the Custom App strategy we can **truthfully claim automated migration of automations** — what competitors leave fully manual. The only genuinely manual residue (SSO, marketplace apps, DNS verification) requires the customer's own credentials/domain control and *no tool* can automate it → short, exact checklist. Salto, notably, could not automate the Freshdesk side at all — reinforcing our differentiation.

---

## 5. Required live verification (M1 spike — before any sales claim)
Stand up Freshdesk **Enterprise trial** + Zendesk **trial** and confirm empirically:
1. `POST /sla_policies` — create supported? (Tier-2)
2. `POST /admin/forms` — supported + plan? (Tier-2)
3. Custom App **product events** + **scheduled events** availability & quotas (validates §3.1-A)
4. Canned-response bulk limits & folders
5. Ticket **import** timestamps accepted on `POST /tickets`
6. Real rate-limit headers / RPM per plan (calibrate throttle)

No item leaves VERIFY-LIVE until observed on a real account.

---

### Sources
- Salto: [Salto for Zendesk overview](https://help.salto.io/en/articles/12266255-salto-for-zendesk-overview) · [Core concepts](https://help.salto.io/en/articles/6845018-core-concepts) · [Salto for Zendesk (solution)](https://www.salto.io/solution/zendesk) · [salto-io/salto (GitHub, open source)](https://github.com/salto-io/salto) · [User guide](https://github.com/salto-io/salto/blob/main/docs/user_guide.md)
- Freshdesk: [API docs](https://developers.freshdesk.com/api/) · [Automations overview](https://support.freshdesk.com/support/solutions/articles/207276-when-to-use-the-dispatch-r-the-supervisor-and-the-observer) · [User Management API (Stitchflow)](https://www.stitchflow.com/user-management/freshdesk/api) · [Canned Responses API release](https://support.freshdesk.com/support/discussions/topics/324566) · [SLA API thread](https://community.freshworks.dev/t/freshdesk-sla-api/773)
- Freshworks: [App SDK REST APIs](https://developers.freshworks.com/docs/app-sdk/v3.0/support_agent/rest-apis/)
