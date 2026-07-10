# Enterprise Onboarding & Authentication Architecture (ITSM)

**v0.1 · 2026-07-09 · Author: Enterprise SaaS / OAuth architecture**
**Question:** Can our ITSM migration platform use the same enterprise onboarding model as our Google Workspace / M365 products (and CloudFuze / Fivetran) — *register our app once → customer admin clicks Connect → OAuth consent → we store tokens → migration runs → we never ship source code*?

## Verdict (one line)
**The onboarding *experience* can be identical — "Connect Source / Connect Destination" — but the *mechanism underneath is not uniform.* Two ITSM vendors support the register-once-OAuth-consent model; two do not (API-key only); one is OAuth-but-per-instance.** So we build **one onboarding UX over a pluggable per-connector auth strategy**, not a single OAuth flow.

> Why this matters: your Google/M365 model assumes an OAuth provider with a single global app + consent screen. That assumption holds for *some* ITSM vendors and breaks for others. Designing as if all five behave like Google would strand Freshdesk/Freshservice (your **first target's destination!**) and add friction on ServiceNow.

---

## Per-platform reality (verified)

| Platform | Register-once + customer OAuth consent? | How onboarding actually works | Token type |
|---|---|---|---|
| **Zendesk** | ✅ **Yes** | Request a **global OAuth client** from Zendesk (Marketplace portal). It works across *all* customer subdomains; the customer admin hits the Zendesk consent screen and grants scopes. Exactly your Google/M365 model. | OAuth access + refresh |
| **Jira Service Management** (Atlassian Cloud) | ✅ **Yes** | Register an **OAuth 2.0 (3LO)** app once in the Atlassian developer console (callback URL + scopes). Customer admin consents; you get access + refresh tokens. | OAuth access + refresh |
| **Freshdesk** | ❌ **No** | Freshdesk API v2 supports **HTTP Basic with an API key only — no OAuth** for the ticketing API. Customer admin generates an API key in their account and pastes it into our UI. | Long-lived API key |
| **Freshservice** | ❌ **No** | Same Freshworks pattern as Freshdesk — **API key + HTTP Basic**, no OAuth consent. | Long-lived API key |
| **ServiceNow** | ⚠️ **Partial** | OAuth 2.0 *is* supported, but there is **no global app / single consent screen**. Each customer admin does a **one-time Application Registry** setup *inside their own instance* (client id/secret + redirect + scopes), then we OAuth against that instance. (Basic auth with an integration user is the fallback.) | Per-instance OAuth (or basic) |

**Implication for your six migration pairs:**

| Pair | Source auth | Destination auth |
|---|---|---|
| Zendesk → Freshdesk *(v1)* | OAuth (global client) | **API key** |
| Zendesk → Jira SM | OAuth | OAuth (3LO) |
| ServiceNow → Jira SM | per-instance OAuth | OAuth (3LO) |
| ServiceNow → Freshservice | per-instance OAuth | **API key** |
| Freshdesk → Zendesk | **API key** | OAuth |
| Freshservice → ServiceNow | **API key** | per-instance OAuth |

Every pair mixes at least two of the three mechanisms. This is why the auth layer must be pluggable.

---

## The architecture: one UX, pluggable auth strategies

Keep the customer-facing flow identical to your existing products; vary only the credential acquisition step.

```
        ┌─────────────────────────────────────────────────────────┐
        │   Onboarding UI:  [ Connect Source ]  [ Connect Target ] │
        └─────────────────────────────────────────────────────────┘
                                   │  picks platform
                                   ▼
        ┌─────────────────────────────────────────────────────────┐
        │            AuthStrategy (interface per connector)         │
        │   begin(ctx) → { redirectUrl | promptForFields }          │
        │   complete(input) → normalized Credential                 │
        │   refresh(cred) → Credential      (OAuth only)            │
        └─────────────────────────────────────────────────────────┘
             │                    │                     │
   ┌─────────▼────────┐  ┌────────▼─────────┐  ┌────────▼──────────┐
   │ GlobalOAuth      │  │ ApiKeyStrategy   │  │ InstanceOAuth      │
   │ (Zendesk global, │  │ (Freshdesk,      │  │ (ServiceNow:       │
   │  Atlassian 3LO)  │  │  Freshservice)   │  │  guided per-inst.  │
   │  → consent screen│  │  → paste API key │  │  registry + OAuth) │
   └──────────────────┘  └──────────────────┘  └────────────────────┘
                                   │  normalized Credential
                                   ▼
        ┌─────────────────────────────────────────────────────────┐
        │  Secrets Vault:  AES-256-GCM at rest, key from KMS.       │
        │  DB stores only { connectionId, authType, secretRef }.    │
        │  Access tokens short-lived; refresh tokens rotated.       │
        └─────────────────────────────────────────────────────────┘
```

**Normalized `Credential`** (what the connector consumes, regardless of how it was obtained):
```jsonc
{ platform, authType: "oauth|api_key|instance_oauth",
  accessToken?, refreshToken?, expiresAt?,   // oauth
  apiKey?,                                    // api_key
  instanceUrl, subdomain?, scopes? }
```
The connectors already accept an injected creds object — the strategy layer just fills it. So `ZendeskSource`/`FreshdeskTarget` don't care *how* the credential was acquired.

### What we register vs. what the customer does

| Platform | We register once (dev side) | Customer admin does (one-time) | Ship source? |
|---|---|---|---|
| Zendesk | Global OAuth client (approved by Zendesk) | Click Connect → consent | **No** |
| Jira SM | 3LO app in Atlassian console | Click Connect → consent | **No** |
| Freshdesk / Freshservice | *nothing to register* | Generate API key → paste | **No** |
| ServiceNow | *nothing global* | Create Application Registry entry in their instance → we OAuth | **No** |

So your two core goals — **register once where possible** and **never ship source** — are fully met for all five. The only thing that changes is that Freshdesk/Freshservice/ServiceNow shift a small one-time setup step to the customer admin (paste a key, or add a registry entry) instead of a single click-consent.

---

## Security (mandatory, because two platforms use long-lived keys)
- **Encrypt at rest:** API keys and refresh tokens with **AES-256-GCM**, data-encryption key wrapped by a **KMS** (AWS KMS / GCP KMS / Vault). DB holds only `secretRef` — never the secret.
- **Least privilege:** request minimum OAuth scopes; for API-key platforms document the least-privileged admin the key needs.
- **Short-lived access tokens:** for OAuth platforms, store refresh token, mint access tokens on demand, auto-refresh before expiry.
- **Rotation & revocation:** support key rotation; on project completion, purge secrets per retention policy.
- **Audit:** every credential use logged (who/when/which connection), immutable.
- **Isolation:** one customer = one logical namespace; secrets never shared across projects.

---

## How Relokia (Help Desk Migration) validates this — carefully stated

Relokia runs a **single, uniform Migration Wizard** for all 90+ platforms:

```
Create Project → Select Source → Enter Source Credentials → Select Destination
→ Enter Destination Credentials → Discovery → Field Mapping → Demo/Test → Full Migration
```

On authentication, we state only what their public docs support (no over-claiming):
> **Relokia authenticates using whatever mechanism each platform exposes — commonly admin-level API credentials (token/key), with OAuth where the platform supports it.** Their wizard is admin-only, 2FA-protected, and strictly API-scoped ("cannot access data outside the permission granted by your API token or OAuth authorization"). We do **not** claim they use OAuth for any specific platform, because their production behavior isn't published.

**The real lesson is architectural, not "OAuth vs API key":** the *wizard* and the *migration engine* never change — only the *connector* and its *auth strategy* change. The engine is **auth-agnostic**:

```
Migration Wizard (never changes)
        │
        ▼
   Connector (per platform)
        │
        ▼
   Auth Strategy  ── OAuth | API Key | Instance OAuth | PAT | Basic
        │
        ▼
   Normalized Connection ──▶ Extractor → Transformer → Loader
```

Every connector simply asks `credential = authStrategy.getCredential(projectId)` and never knows whether it came from OAuth, an API key, a PAT, or a service account. Adding a new platform (Salesforce Service Cloud, Intercom, …) becomes *implementing a connector + strategy*, not touching the engine.

## Recommendation
1. Build the **ConnectionManager + AuthStrategy** abstraction now: `GlobalOAuth`, `ApiKey`, `InstanceOAuth`, plus `PAT` and `Basic` as future strategies — even though v1 is only Zendesk→Freshdesk. The engine calls `getCredential(projectId, side)` and stays auth-agnostic, so all six pairs (and future platforms) drop in as connector+strategy plugins.
2. Present the **identical "Connect" UX**; render the right step per platform (consent redirect vs. key-paste vs. guided instance setup).
3. Stand up the **encrypted secrets vault** (AES-256-GCM + KMS) before storing any real credential.
4. Apply for the **Zendesk global OAuth client** and register the **Atlassian 3LO app** early — approval/listing can take time.

**Bottom line:** *Yes*, you can reuse your enterprise onboarding architecture — with one adaptation: the auth step is pluggable per platform, not a single OAuth flow. The customer experience stays "click Connect," you register once where the vendor allows it, and you never ship source code.

---

### Sources
- Zendesk: [Set up a global OAuth client](https://developer.zendesk.com/documentation/marketplace/building-a-marketplace-app/set-up-a-global-oauth-client/) · [Managing global OAuth clients](https://developer.zendesk.com/documentation/apps/app-developer-guide/managing-global-oauth-clients-and-app-associations/) · [OAuth tokens with the API](https://developer.zendesk.com/documentation/api-basics/authentication/creating-and-using-oauth-tokens-with-the-api/)
- Freshdesk: [API key based authentication](https://support.freshdesk.com/en/support/solutions/articles/50000003346-api-key-based-authentication) · [Community: OAuth for Freshdesk API](https://community.freshworks.dev/t/how-to-use-oauth-authentication-mechanism-for-freshdesk-api/1691)
- Jira Service Management: [OAuth 2.0 (3LO) apps](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/) · [3LO for JSM](https://developer.atlassian.com/cloud/jira/service-desk/oauth-2-authorization-code-grants-3lo-for-apps/)
- ServiceNow: [OAuth 2.0 setup / Application Registry](https://www.servicenow.com/community/developer-articles/oauth-2-0-setup-in-servicenow/ta-p/3307347)
