# ITSM Migrator — Zendesk → Freshdesk

Enterprise migration platform that moves the **whole helpdesk application** — *data* **and**
*configuration* — from Zendesk to Freshdesk, and **rebuilds configuration automatically**
through a deterministic, rule-driven engine.

> **Differentiator:** competitors move your tickets. We also migrate the *environment*
> (groups, agents, fields, SLAs, automations, macros, brands) — the setup they leave you
> to rebuild by hand. The write path is **100% deterministic** — no LLM decides what to write.

📄 **Design docs:** [`docs/PRD.md`](docs/PRD.md) · [`docs/CONFIG-FEASIBILITY.md`](docs/CONFIG-FEASIBILITY.md) (incl. Salto analysis) · [`docs/ONBOARDING-AUTH.md`](docs/ONBOARDING-AUTH.md)

---

## Prerequisites

- **Node 20+**
- **MongoDB** (local, Docker, or managed) — staging + control plane
- A 32-byte encryption key for the secret store
- Zendesk (source) + Freshdesk (target) **admin** credentials, supplied by the customer at connect time

## Configure

```bash
cp .env.example .env
# then set at minimum:
#   STORE=mongo
#   MONGO_USERNAME / MONGO_PASSWORD          # Docker Mongo root creds (compose reads these)
#   MIGRATION_SECRET_KEY=<base64 32 bytes>   # node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
#   JWT_SECRET=<long random string>          # signs portal session tokens
# MONGODB_URI defaults are wired for Docker (compose sets the in-network URI; .env's is
#   for running the app locally against the Docker Mongo on host port 27018).
# OAuth client ids/secrets are only needed for OAuth platforms (Zendesk global client, Jira 3LO).
```

## Run

### Docker (production-grade — app + MongoDB, like GEM_CO)

Fully self-contained — a clean `git clone` builds identically on any machine. The image
installs backend deps (`npm ci`) and builds the dashboard from `web/` in a multi-stage
build; you do **not** run `npm` on the host.

```bash
cp .env.example .env      # then set MONGO_PASSWORD, MIGRATION_SECRET_KEY, JWT_SECRET (see Configure)
docker compose up -d --build                             # app :4400 + mongo :27018 (auth)
# open http://localhost:4400   (login: admin@cloudfuze.com / CloudFuze@2026)
```

On first start the app auto-creates **all collections + indexes** (`initStore → ensureCollections`),
so the full schema is present in Mongo/Studio 3T with zero manual setup.

Stop/start: `docker compose stop` / `docker compose up -d`. Data persists in the `itsm_mongo_data` volume.
Studio3T: `mongodb://<MONGO_USERNAME>:<url-encoded-MONGO_PASSWORD>@localhost:27018/?authSource=admin`.

> **First build needs Docker Hub reachable once** to pull the pinned `node:20-slim` base
> image; after that it's cached locally. The base image is pinned by digest for reproducible
> builds. A transient `lookup auth.docker.io: no such host` is a local network hiccup — retry.

### Local (without Docker)
```bash
npm install
# set STORE, MONGODB_URI, MIGRATION_SECRET_KEY, JWT_SECRET in .env, then:
npm start                 # API + built dashboard on http://localhost:4400

# UI development with live reload:
cd web && npm install && npm run dev     # dashboard on http://localhost:5173 (proxies /api → :4400)
```

## Using it (the migration wizard)

1. **New migration** — name it, pick source + destination platforms.
2. **Connect** — enter each side's admin credentials (Freshdesk API key; Zendesk API token or OAuth).
   Credentials are encrypted at rest; the app stores only a `secretId`.
3. **Select data** — configuration and/or data.
4. **Pre-check** — dry run: full mapping preview + conflict list, no writes.
5. **Migrate** — configuration loads first, then data; batched, checkpointed, resumable.
6. **Report** — reconciliation totals, per-object status, and the manual checklist.

---

## Architecture

```
Zendesk ──extract──▶  MongoDB staging + control plane  ──load──▶ Freshdesk
                      (per-type collections, idmap crosswalk,
                       mappingRules, conflicts, events)

engine → ConnectionManager → SecretService → backend    (engine is auth-agnostic)
   Engine phases: extract → transform → validate → load(config→data) → verify → report
```

- **`src/auth/`** — `ConnectionManager`, `AuthStrategy` (OAuth / API-key / instance-OAuth / PAT / basic), normalized `Credential`
- **`src/secrets/`** — `SecretService` interface + Mongo AES-256-GCM store (KMS-swappable)
- **`src/db/`** — Mongoose schema + repository
- **`src/connectors/`** — Zendesk source, Freshdesk target, connector registry
- **`src/mapping/`** — deterministic matrix, value maps, transformers, trigger/macro→IR translator
- **`src/engine/`** — extractor, loader (idmap, dependency order, idempotent, resumable), reconciler, orchestrator
- **`src/api/`** — Express REST API · **`web/`** — React (Vite) migration wizard

## Configuration automation & the honest constraint

Freshdesk's public API cannot create some config (automation rules, roles, business hours,
products, scenarios). We translate those deterministically to an intermediate representation
and enforce them via a **Freshworks Custom App** (primary), scripted **UI automation** (opt-in),
or an exact **guided checklist** (always). Nothing is silently dropped — see
[`docs/CONFIG-FEASIBILITY.md`](docs/CONFIG-FEASIBILITY.md).

## Security

- Customer credentials are **encrypted (AES-256-GCM)** before storage; the DB holds only ciphertext + a `secretId`.
- Use a **KMS** for the encryption key in production (`SECRET_BACKEND`).
- OAuth access tokens auto-refresh; a rotated/revoked credential pauses the run (`reauth_required`)
  and resumes from the last checkpoint after reconnect — no duplicates (idempotent via `idmap`).
