# ITSM Migrator — Zendesk → Freshdesk

AI-era migration platform that moves the **whole helpdesk application** — *data* **and**
*configuration* — from Zendesk to Freshdesk, and **rebuilds configuration automatically**
through a deterministic, rule-driven engine.

> **Differentiator:** competitors move your tickets. We also migrate the *environment*
> (groups, agents, fields, SLAs, automations, macros, brands) — the setup they leave you
> to rebuild by hand. The write path is **100% deterministic** — no LLM decides what to write.

📄 **Design docs:** [`docs/PRD.md`](docs/PRD.md) · [`docs/CONFIG-FEASIBILITY.md`](docs/CONFIG-FEASIBILITY.md) (incl. Salto analysis)

---

## Quick start (zero external services)

Runs out of the box in **memory store + mock connector** — no MongoDB, no Zendesk/Freshdesk creds.

```bash
# 1) backend deps
npm install

# 2a) headless end-to-end proof (prints a full migration report)
npm run demo

# 2b) or the full app: API + React dashboard
npm start                 # Express API + serves built dashboard on http://localhost:4000
# ── in another terminal, for live-reload React dev ──
cd web && npm install && npm run dev   # dashboard on http://localhost:5173 (proxies /api)
```

The dashboard: **Run migration** / **Dry run** → watch the pipeline stepper, KPIs,
object-mapping matrix (colour-coded by feasibility), the **configuration-automation panel**
(what auto-migrates vs. the exact manual checklist), and a live activity log.

---

## Going live (real migration)

Copy `.env.example` → `.env` and set:

```bash
STORE=mongo
MONGODB_URI=mongodb://localhost:27017/itsm_migrator   # DEV/local — never a prod credential
DRIVER=live
ZENDESK_SUBDOMAIN=... ZENDESK_EMAIL=... ZENDESK_API_TOKEN=...   # source admin token
FRESHDESK_DOMAIN=... FRESHDESK_API_KEY=...                       # target admin key
```

Then `npm start`. Same engine, same dashboard — only the store and connector drivers change.

---

## Architecture (see PRD for detail)

```
Zendesk ──extract──▶  MongoDB staging + control plane  ──load──▶ Freshdesk
                      (per-type collections, idmap crosswalk,
                       mappingRules, conflicts, events)
   Engine:  extract → transform → validate → load(config→data) → verify → report
```

- **`src/db/`** — schema (Mongoose) + repository (memory / mongo adapters)
- **`src/connectors/`** — Zendesk source, Freshdesk target (each mock + live)
- **`src/mapping/`** — the deterministic matrix, value maps, transformers, trigger/macro→IR translator
- **`src/engine/`** — extractor, loader (idmap, dependency order, idempotent, resumable), reconciler, orchestrator
- **`src/api/`** — Express REST API
- **`web/`** — React (Vite) dashboard

## Configuration automation & the honest constraint

Freshdesk's public API cannot create some config (automation rules, roles, business hours,
products, scenarios). We translate those deterministically to an intermediate representation
and enforce them via a **Freshworks Custom App** (primary), scripted **UI automation** (opt-in),
or an exact **guided checklist** (always). Nothing is silently dropped — see
[`docs/CONFIG-FEASIBILITY.md`](docs/CONFIG-FEASIBILITY.md).

## Status
M1 foundation, running in mock mode. Automation *enforcement* (Custom App / UI) is scoped but
deferred; automation *translation* to IR + checklist is implemented today.
