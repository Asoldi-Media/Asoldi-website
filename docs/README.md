# Hub docs

One row per document in this folder. The code is the source of truth when a document and the code
disagree.

## Index

| Topic | File |
|---|---|
| What lives where: hub, GitHub, Hostinger disk | [deployment-split.md](deployment-split.md), [runtime-data.md](runtime-data.md), [../DEPLOYMENT.md](../DEPLOYMENT.md) |
| Security: disk secrets and rotation, Maker hosts, login tokens and limits, Open CMS as Asoldi, site credentials, public-repo scans | [security.md](security.md) |
| Safe mode: local and LAN hubs that never touch real systems, golden data | [safe-mode.md](safe-mode.md) |
| Hub AI layer: the facade, profiles, ledger, budgets, Maker run spend | [ai-layer.md](ai-layer.md) |
| Client CMS feature tree and cms-spec in site-config | [cms-feature-tree.md](cms-feature-tree.md) |
| seo-ops store (per-site SEO operations data) | [seo-ops-store.md](seo-ops-store.md) |
| Delivery flow from signed contract to live site: tier matrix, plans, stages, Maker events, backfill | [delivery-flow.md](delivery-flow.md) |
| Delivery runbooks (symptom, check, fix) | [delivery-runbooks.md](delivery-runbooks.md) |
| Sales offer flow (tilbud and kontrakt) | [sales-offer-flow.md](sales-offer-flow.md) |
| Fireflies recording of booked meetings | [fireflies-recording.md](fireflies-recording.md) |
| Client data gathering: onboarding and the AI assistant | [client-data-gathering.md](client-data-gathering.md) |
| Developer client brief | [developer-client-brief.md](developer-client-brief.md) |
| Local service posts | [local-blog.md](local-blog.md) |
| Shared tool suite (`packages/suite`) | [tool-suite.md](tool-suite.md) |
| Client CMS contract: feelers, wiring, fleet push | [cms-contract.md](cms-contract.md) |
| Client CMS on a client site | [CLIENT-SITE-DEPLOYMENT.md](CLIENT-SITE-DEPLOYMENT.md), [SETUP-HUB-AND-CLIENTS.md](SETUP-HUB-AND-CLIENTS.md), [CLIENT-CMS-IMPLEMENTATION.md](CLIENT-CMS-IMPLEMENTATION.md) |
| Client CMS user roles | [CMS-USER-ROLES.md](CMS-USER-ROLES.md) |
| Client portal and agency super-admin | [UNIVERSAL-CMS-STRATEGY.md](UNIVERSAL-CMS-STRATEGY.md) |
| Admin sign-in and password reset codes | [ADMIN-AND-OTP.md](ADMIN-AND-OTP.md) |
| Checkout and sales rollout checklist | [checkout-sales-rollout-checklist.md](checkout-sales-rollout-checklist.md), [client-flow-checklist.txt](client-flow-checklist.txt) |
| Publishing the client CMS package | [PUBLISH-NPM-PACKAGE-WALKTHROUGH.md](PUBLISH-NPM-PACKAGE-WALKTHROUGH.md) |

## Switches that ship off

Every switch below lives on the hub data disk and is changed by a superadmin, never through a
Hostinger env variable. With all of them at their defaults the hub sends no new email and makes
no new outgoing call.

| Switch | Default | Turn on | Where it is stored | Doc |
|---|---|---|---|---|
| Site credential enrollment | off (503 `enrollment-off`) | Manage clients → Security → Site credentials, or `PUT /api/hub/site-credentials/settings` `{"enrollment":"on"}`, together with the first client CMS 2.2.2 / 1.7.2 rollout | `site-credentials/settings.json` | [security.md](security.md#site-credential-client-cms--hub) |
| Maker hosts | none: only the legacy Maker token | System safety → Maker hosts → create, or `POST /api/admin/maker-hosts`; then put the token in the Maker `.env` and recreate the Maker container | `maker-hosts.json` | [security.md](security.md#maker-hosts-per-host-tokens) |
| Login address hops | 1 (the right-most public `X-Forwarded-For` entry) | `PUT /api/admin/security/login-address` `{"trustedHops":2}` only when every request passes that many public proxies | `security-settings.json` `loginTrustedHops` | [security.md](security.md#login-tokens) |
| Feature tree in site-config | off | `PUT /api/admin/cms-features/settings` `{"siteConfig":{"mode":"shadow"}}`, then `{"siteConfig":{"mode":"on","siteIds":["<id>"]}}` for a site whose CMS has enrolled, later `allSites` | `cms-feature-settings.json` | [cms-feature-tree.md](cms-feature-tree.md) |
| Maker access to cms-spec | off (403) | `PUT /api/admin/cms-features/settings` `{"cmsSpec":{"makerAccess":true}}` | `cms-feature-settings.json` | [cms-feature-tree.md](cms-feature-tree.md) |
| Maker delivery events | `off` (events take the step-status path) | `PUT /api/admin/automation-settings` `{"development":{"makerEvents":"record"}}` | `automation-settings.json` | [delivery-flow.md](delivery-flow.md#maker-events) |
| Delivery backfill | `off` | dry run: `POST /api/admin/system/delivery-backfill` `{}`; apply: `{"dryRun":false}` (or `migrations.deliveryBackfill` `apply` for one boot, then back to `off`) | `automation-settings.json`, `migrations/` | [delivery-flow.md](delivery-flow.md#backfill) |
| Hub AI profile | `legacy`: every call site sends its request as before the facade, which only records it | AI status card, or `PUT /api/admin/ai/routes` (`profile` `prod` after a live check); `{"facade":false}` turns the facade off | `ai-routes.override.json` | [ai-layer.md](ai-layer.md) |
