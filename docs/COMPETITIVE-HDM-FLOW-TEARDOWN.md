# Competitive Teardown — Help Desk Migration (Relokia) Flow → CloudFuze Mapping Spec

**Purpose:** Capture the *entire* Help Desk Migration (HDM) Zendesk→Freshdesk wizard — every step, field, column, checkbox, dropdown, and report — so we can build our **own** equivalent mapping layer (differentiated, not a copy). HDM is the market benchmark for "looks like a real enterprise migration product." Our engine already does the hard part (deterministic transforms + `idmap`); this doc is about the **mapping/matching/preview UX layer** we're missing.

**Source:** Live HDM trial `migration/setup/98cc986f9a5e3c` (Zendesk `neutaratechnologieshelp` → Freshdesk `cloudfuze-help`), captured 2026-07-11 via 10 screenshots.
**Status:** Living — update as we capture the remaining sub-screens (see §9).

---

## 0. The one takeaway

HDM's product = **thin connectors + a deep mapping/preview UX**. The migration engine is table-stakes; the thing that *sells* is the wizard that lets an admin **see and control** exactly how every object and every field lands, then **prove it with a free demo migration + reconciliation report** before paying.

We already have the deterministic engine (matrix, transformers, `idmap`, conflicts). **What we lack is that visible control + trust layer.** This doc specs it.

---

## 1. Top-level wizard (the 5-step stepper)

HDM's whole flow is a fixed 5-step progress bar, always visible top-center:

| # | Step | What happens |
|---|---|---|
| 1 | **Migrate from** | Connect the **source** (Zendesk) — URL + OAuth. |
| 2 | **Migrate to** | Connect the **target** (Freshdesk) — URL + API key. |
| 3 | **Choose objects** | Object selection + **all mapping/matching/options/filters** (the core). |
| 4 | **Demo migration** | Free small test batch → reconciliation report. |
| 5 | **Full migration** | Paid; pre-flight checklist; run. |

Also persistent: a **Migration ID** (`#98CC986F9A5E3C`) with copy button (top-left), and a right-hand **Migration Guide** panel that changes contextually per step (setup instructions, prerequisites, "before you start" checklist, common issues accordion, helpful-guide links, live chat bubble).

---

## 2. Step 1 — "Migrate from" (connect source)

**Left (form):**
- Heading **"Migrate from:"** + a **Source platform dropdown** (Zendesk selected, "Select your Source" placeholder).
- Badge: **"Zendesk Authorized Solution Partner."**
- **URL** field — `https://neutaratechnologieshelp.zendesk.com`.
- **Continue ▸** button.
- **‹ Revoke access** link (right-aligned).
- Divider, then the greyed-out **Target** ("Migrate to: Freshdesk") preview below.
- Security note: *"We do not share your access credentials … Security Policy."* with lock icon.

**Right (Migration Guide):**
- **Setup instructions → ① URL** (type full Zendesk address). Info callout: multi-brand setups → enter the specific brand-mapped URL; wizard auto-selects the KB associated with that URL.
- **② Authorization** — "Sign in with Zendesk" → login popup with **Administrator** creds → **Allow Access** (review permissions) → window closes → connection verified.
- **Common issues** accordion. Links: *Get Started with HDM*, *General Data Migration Questions*.

**Auth model:** Zendesk = **OAuth** ("Sign in with Zendesk"). *(Matches our research: Zendesk supports OAuth.)*

---

## 3. Step 2 — "Migrate to" (connect target)

**Left:**
- Source now shows a green **"Zendesk is connected ✓"** banner + **‹ Edit Source**.
- Heading **"Migrate to:"** + **Target platform dropdown** (Freshdesk) + **Authorized Solution Partner** badge.
- **URL** field — `https://cloudfuze-help.freshdesk.com`.
- **API Key** field (masked).
- **Continue ▸**, **‹ Revoke access**, same security note.

**Right (Migration Guide):**
- **Prerequisites:** target account must have **Account Administrator role + Global Access scope**.
- **① URL** (`https://your-company.freshdesk.com/`).
- **② API Token:** log in → profile avatar (top-right) → **Profile Settings** → **Your API Key** section → **complete CAPTCHA to reveal** → copy.
- Note callout: *"API key will be displayed in profile settings only after your email is verified."*

**Auth model:** Freshdesk = **API key only**. *(Matches our research/memory: Freshdesk/Freshservice are API-key only.)*

---

## 4. Step 3 — "Choose objects" (THE CORE — mapping) ⭐

Heading **"MAPPING / Select Objects."** Two-column layout with **ZENDESK** (source) header (left) and **FRESHDESK** (target) header (right). Each row = a source object, a set of **action buttons** in the middle, and the target object name on the right.

### 4.1 Object rows & their controls

**HELP DESK OBJECTS**

| ☑ | Source (Zendesk) | Middle action buttons | Target (Freshdesk) |
|---|---|---|---|
| ☑ | **Agents** | **⚠ ⇄ Matching** (warning triangle = needs attention) | Agents |
| ☑ | **Organizations** | **⊢ Mapping** · **☰ Options** | Companies |
| ☑ | **Customers** | **⊢ Mapping** · **☰ Options** | Contacts |
| ☑ | **Tickets** | **⊢ Mapping** · **☰ Options** · **▼ Filters** | Tickets |

**KNOWLEDGE BASE OBJECTS** (all unchecked by default here)

| ☐ | Source | (arrow) | Target |
|---|---|---|---|
| ☐ | **Categories** | »» | Categories |
| ☐ | **Sections** | »» | Folders |
| ☐ | **Articles** | »» | Articles |

**MIGRATION OPTIONS** row (global add-ons): *"Select powerful add-ons to customize your data migration"* → **⚙ Options** button.

Bottom: **Start Demo Migration ▸**, and *"Have questions about field mapping? We are here to assist you!"* chat link.

**Observations:**
- Each object type has a **different set of available actions** — Agents get **Matching** (not field mapping); Orgs/Customers get **Mapping + Options**; only **Tickets** get **Filters**.
- The **⚠ warning triangle** on Agents flags that matching is incomplete/needs review — a nice "you must look here" signal.
- Objects are **individually toggleable** — customer picks the subset to migrate.

### 4.2 Right panel — "Before you start the Demo Migration" (their glossary)

Numbered explainer we should mirror conceptually:
1. **Matching** — link source agents to target counterparts; migrated tickets get assigned to the matched target agent → "keeping ownership and accountability intact."
2. **Mapping** — match source fields to target equivalents so data lands in the right place.
3. **Options** — add-ons: migrate inline images, tag migrated tickets, and more.
4. **Filters** — narrow which tickets migrate by filtering conditions.
5. **Customizations** — "no custom modifications applied … contact support for tailored adjustments" (their upsell hook).
6. **Specific requirements for Freshdesk** — (truncated in capture — **NEED SCREENSHOT**, §9).

---

## 5. The mapping modals (each button opens one)

### 5.1 Agents → **Matching** modal

Header: **ZENDESK AGENTS ⇄ FRESHDESK AGENTS** with both instance URLs.

- **"CHOOSE THE DEFAULT AGENTS ON THE TARGET"** — *"Will be used for unassigned tickets and those belonging to deleted or inactive agents."* → single **dropdown** (`abhilasha.kandakatla@cloudfuze.com`) + a **checkbox** (apply/confirm).
- **"AGENTS AVAILABLE FOR MATCHING"** — a row **per source agent**, each with a **target-agent dropdown**:
  - `Chaitanya.Malle@cloudfuze.com` → `Chaitanya.Malle@cloudfuze.com`
  - `abhilasha.kandakatla@cloudfuze.com` → `abhilasha.kandakatla@cloudfuze.com`
- Buttons: **Auto-match** (fuzzy-match by email/name) and **Save the matching ▸**.

**Why it matters:** this is HDM's answer to our #1 open bug (assignee/responder). They make the admin **explicitly match** source→target agents and pick a **fallback default agent** for unassigned/deleted. That's the mechanism that keeps ticket ownership intact. **We must build the equivalent** (we already migrate group membership; the missing piece is the *matching UI + default-agent fallback*).

### 5.2 Customers → **Mapping** modal (field mapping)

Header: **ZENDESK CUSTOMERS ➔◄ FRESHDESK CONTACTS**.

- Top control: **"Choose field to create ▾"** dropdown + **"➕ Add the same field on Freshdesk"** — lets the admin **create a new target field** on the fly if no equivalent exists.
- **Field grid** — each row: `☑/☐ | [src-field icon+name] | ✎ edit | [target-field icon+name]`:
  - ☑ **Name** → ✳ **Name** (✳ = required on target)
  - ☑ **Email** → ✳ **Email**
  - ☑ **Company** → **Company**
  - ☑ **Phone** → **Phone**
  - ☐ **Skip this field** → **Title** (target field with no source → "Skip")
  - ☐ **Skip this field** → **Mobile phone**
  - ☐ **Skip this field** → **Address**
  - ☐ **Time zone** → **Time zone** — *expandable into a **VALUE MAP*** (see below).
- **Value mapping (nested under Time zone):** each **source value** gets a **target-value dropdown** defaulting to **"No need to fill"**: `International Date Line West, American Samoa, Midway Island, Hawaii, Alaska, Arizona, Mazatlan, Pacific Time (US & Canada), Tijuana, Central America, …`.
- Footer: **⊙ Hide mapped fields (4 of 11)** toggle · **↺ Reload mapping** · **⏮ Reset mapping** · **Save mapping ▸**.

**Key concepts to steal (conceptually):**
1. **Field-level mapping** with source↔target on one row.
2. **"Skip this field"** as an explicit, first-class choice.
3. **"Create field on target"** inline.
4. **Required-field markers (✳)**.
5. **Value-level mapping** for enum/list fields (nested, expandable).
6. **"Hide mapped fields (N of M)"** so admins focus on the unmapped ones.
7. **Reload / Reset** mapping.

### 5.3 Customers → **Options** modal

Two checkboxes (both off by default), each with an info tooltip:
- ☐ **Retain multi-company contact associations** — keep a contact's links to multiple companies.
- ☐ **Migrate records associated with tickets** — pull in only the customers/orgs referenced by migrated tickets.
- **Save / Cancel ✕**.

### 5.4 Tickets → **Mapping** modal (the big one — **178 fields**)

Header: **ZENDESK TICKETS ➔◄ FRESHDESK TICKETS**. Footer shows **"Hide mapped fields (10 of 178)"** — i.e. tickets expose **178 mappable fields**. Rows seen:
- ☑ **Subject** → ✳ **Subject**
- ☑ **Tags** → ✳ **Tags**
- ☐ **Group** → **Group** — **value map**:
  - Support→**Support**, Billing Team→*Unassigned*, Sales Team→*Unassigned*, Technical Support→*Unassigned*, Presales→**Presales**, Tier 1 Support→*Unassigned*, Engineering→*Unassigned*, Billing→*Unassigned*.
  - *(Only groups that exist on the target auto-match; the rest fall to "Unassigned" — exactly our group-dependency problem, surfaced visually.)*
- ☐ **Type** → ✳ **Type** — **value map** incl. a **"Use for empty values"** default row:
  - Use for empty values→**Question**, Question→Question, Incident→Incident, Problem→Problem, **Task→Question** (no FD "task" type → folds to Question — same call we make in code).
- ☐ **Channel** → ✳ **Source** — value map (source/channel translation).
- Same footer controls (Reload / Reset / Save mapping).

**Takeaways:** (a) tickets are the field-heaviest object by far; (b) **"Use for empty values"** is a smart default-value concept we should adopt; (c) their **Group/Type/Channel value maps** are exactly our `valueMaps.js` — but **exposed and editable** by the admin instead of hard-coded. That editability is the enterprise feel.

### 5.5 Tickets → **Filters** modal — **NEED SCREENSHOT** (§9)
Right-panel says filters "narrow down which tickets get migrated by setting filtering conditions" (by date, status, group, tag, etc.). Not captured.

### 5.6 Global **Migration Options / add-ons** modal — **NEED SCREENSHOT** (§9)
Right-panel lists examples: **migrate inline images**, **tag migrated tickets**, and "more." Full list not captured.

### 5.7 Organizations → **Mapping / Options** — **NEED SCREENSHOT** (§9)
Same pattern as Customers presumably (Name→Name, Domains→Domains, value maps). Not captured.

---

## 6. Step 4 — Demo migration (the trust builder) ⭐

1. **"Generating migration preview"** — *"import a small portion of your data to Freshdesk as a test drive … usually takes up to 5 minutes."* Striped progress bar.
2. **"Demo is complete"** — reconciliation table:

| Zendesk | Available | Freshdesk | Migrated | Failed | Skipped |
|---|---|---|---|---|---|
| Agents | 2 | Agents | **3** | 0 | 0 |
| Organizations | 2 | Companies | 2 | 0 | 0 |
| Customers | 3 | Contacts | **2** | 0 | 0 |
| Tickets | 2 | Tickets | 2 | 0 | 0 |

   - Note the **discrepancies**: Agents 2→3 (the **default agent** added a third), Customers 3→2 (one source customer was likely also an agent/requester already present). A good reconciliation report **must explain these**, not just show counts.
   - Actions: **⭳ Download reports**, **↺ Rollback Demo**, **? How to check Demo results**.
3. **"Explore the migrated Tickets report"** modal — side-by-side **ORIGINAL RECORDS (Zendesk)** vs **MIGRATED RECORDS (Freshdesk)** with clickable IDs:
   - "Cannot log in to dashboard" → **17 (Open)** ↔ **16 (Open)**
   - "Billing issue 請求書 😛 — urgent review" → **18 (Open)** ↔ **17 (Open)**
   - Info: find source IDs in ORIGINAL column, target IDs in MIGRATED column; click **(Open)** for ID-based-URL platforms, else search by ID.
   - **⚑ Competitive datapoint:** their sample ticket #18 has **Japanese (請求書) + emoji (😛)** in the subject — the *exact* utf8mb3 edge case in our validation memory. **We must verify what HDM actually stored on the Freshdesk side** (did the emoji survive, get stripped, or replaced?). If HDM also loses the emoji, it **proves our "platform limit, not our tool" framing** — a direct sales counter. → action in §9.

**Right panel (Demo complete guide):** Setup migration (check migrated records; go back to adjust; download reports; verify Available counts) · Customizations (upsell) · **Ready to start full migration** (proceed with payment; **turn off triggers/automations on the target**; forward customer comms to target) · **Start Full Migration** ("do not change the migrated data during migration").

---

## 7. Step 5 — Full migration
- **Checkout ▸** (payment). Pre-flight checklist as above. Then the real run. (Pricing/checkout screen **NEED SCREENSHOT**, §9.)

---

## 8. Gap analysis — what HDM has that we DON'T (and our plan)

Our engine (`matrix.js`, `transformers/`, `valueMaps.js`, `idmap`, `conflicts`) already *does* most of this deterministically under the hood. The gap is **surfacing it as an interactive, admin-controlled UX + a demo/reconciliation loop**. Priority order:

| # | HDM capability | Our status today | Build (our version) | Priority |
|---|---|---|---|---|
| 1 | **Agent Matching + default fallback agent** | Engine migrates group membership; **no matching UI, no default-agent fallback** | Matching screen: auto-match by email, manual override dropdowns, **required default agent** for unassigned/deleted. Directly closes our assignee bug. | **P0** |
| 2 | **Object selection** (pick subset, per-object toggles) | Matrix migrates all; not user-selectable | Object-selection screen with per-type checkboxes + source→target labels. | **P0** |
| 3 | **Field mapping UI** (source↔target, skip, create-field, required markers, hide-mapped) | Transforms hard-coded | Field-mapping modal per object, driven by our matrix; allow skip + create-on-target. | **P0** |
| 4 | **Value mapping UI** (enum maps: group/type/channel/status/priority/timezone, "use for empty") | `valueMaps.js` hard-coded | Expose value maps as editable, with a **default/empty-value** row. | **P1** |
| 5 | **Demo migration + reconciliation report** (Available/Migrated/Failed/Skipped, source↔target ID table, download, rollback) | Engine is idempotent/dry-runnable; **no demo UX, no report artifact** | "Preview migration": small batch → report with counts **+ explanations for discrepancies** + rollback. | **P0** (biggest trust builder) |
| 6 | **Filters** (which tickets migrate: date/status/group/tag) | None | Ticket filter builder. | **P1** |
| 7 | **Per-object Options / add-ons** (inline images, tag migrated tickets, retain multi-company, migrate-associated-only) | Some behaviors exist in code, not toggleable | Options modals per object + a global add-ons list. | **P2** |
| 8 | **Persistent Migration ID + contextual guide panel + progress stepper** | None (we have a single-column wizard shell) | Add the stepper + right-side contextual help + migration ID. | **P1** |
| 9 | **Pre-flight checklist** (turn off target triggers, forward comms, don't edit during run) | None | Show before full run. | **P2** |

### Our differentiators to ADD on top (so it's ours, not a clone)
- **Configuration migration** — HDM's wizard is **data-only** (Agents/Orgs/Customers/Tickets/KB). We add a whole **"Configuration" object group**: Groups, Ticket Fields, Roles, SLAs, Business Hours, Macros→Canned, Triggers/Automations→rules. *This is the headline none of them have.*
- **Feasibility badges inline** — each config object shows Supported / Partial / Checklist (our matrix `feasibility`) right in the selection screen — honest and unique.
- **Guided-rebuild checklist export** for no-API objects — a deliverable HDM doesn't produce.
- **Deterministic + idempotent + resumable** messaging surfaced in the UI (re-run safe, zero dupes).

**Anti-copy guardrails:** our own brand (Poppins, Deep Blue #0129AC, teal), our own step names (e.g. *Connect → Select & Map → Preview → Migrate*, not "Migrate from/to"), single-column CloudFuze wizard aesthetic (per project convention), our own terminology ("Match agents," "Field & value mapping," "Preview migration," "Reconciliation report"). Same *concepts*, different *expression*.

---

## 9. Still-needed captures (please screenshot these — the flow gaps)

To make this teardown 100% complete, I need these sub-screens (not in the 10 shots):
1. **Tickets → Filters** modal (filter conditions available).
2. **Global Migration Options / add-ons** modal (full add-on list — inline images, tag migrated tickets, etc.).
3. **Organizations → Mapping** and **→ Options** modals.
4. **"Choose field to create"** dropdown expanded (what target field types can be created).
5. **Right panel "Specific requirements for Freshdesk"** (step 3, item 6 — was cut off).
6. **Checkout / pricing** screen (step 5).
7. **On the target Freshdesk:** open migrated ticket #17 (from source #18) and screenshot the **subject** — to confirm whether HDM kept/stripped the `請求書 😛` emoji (utf8mb3 proof point).
8. *(Optional)* the **Download reports** file (CSV/PDF) — to see their report schema for ours.

I **cannot** log into the live trial from here (no authenticated browser tool), so screenshots are the way — credentials won't help in this environment.

---

*This is a competitive analysis for building CloudFuze's own differentiated mapping layer. We replicate proven UX **concepts**, never their brand, copy, or code. Companion to [FEATURE-SUPPORT-MATRIX.md](./FEATURE-SUPPORT-MATRIX.md) and [PRD.md](./PRD.md).*
