# CMS feature tree and cms-spec in the hub

The client CMS has one feature registry (website-cms `server/feature-tree.json`, resolved by `server/features.js`). The hub keeps a synced copy and uses it to tell each client CMS what its plan includes (`featureTree` in site-config) and which settings Asoldi wants it to apply (`pendingSettings`, from the site's cms-spec). Everything here ships **dark**: until Superadmin switches it on, `/api/hub/site-config` answers exactly as before.

## Files

| File | What it is |
|---|---|
| `data/cms-feature-tree.json` | Synced copy of website-cms `server/feature-tree.json` (85 keys, registry version 2.3.0). |
| `lib/cms-features.js` | Synced copy of website-cms `server/features.js`, the same bytes. It finds the tree in `data/`. If the tree is missing or invalid the import still works, `featureRegistryStatus()` reports the error, and site-config keeps its old answer. |
| `lib/cms-spec-schema.js` | The cms-spec section schemas and `validateCmsSpec`. Written in the hub first (WS6.8). website-cms takes it over as `server/cms-spec-schema.js` (WS6.9); from then on the sync copies it back. It has no imports, and the registry is passed in. |
| `scripts/fixtures/cms-feature-matrix.json` | The hand-written golden matrix from website-cms (12 profiles × 85 keys). |
| `data/cms-feature-tree.meta.json` | sha256 of each synced file, the source ref and commit, the registry version. |
| `lib/cms-entitlements.js` | Services, tier, lazy migration, resolved tree, site-config fields. |
| `lib/cms-spec.js` | Merge rules for cms-spec writes, history, the AI prompt. |
| `lib/routes/cms-feature-routes.js` | The routes below and the site-config hook. |
| `data/cms-feature-settings.js` | The switch, stored in `<dataDir>/cms-feature-settings.json`. |
| `lib/email-feature-keys.js` | Email send kinds mapped to feature keys (WS7.31). |

## Sync

```
node scripts/sync-cms-feature-tree.mjs --source ../website-cms --ref <tag or branch>
node scripts/sync-cms-feature-tree.mjs --source ../website-cms --ref <tag or branch> --check
```

- The script builds the new tree with the new resolver and checks it against `packages/suite/core/delivery/vocab.js` before it writes anything: service ids, one-time add-on ids, `TIER_SERVICES`, the alias rows and the service anchors (`blog.autoPosts` only in the `seo` bundle, `seo.linkNetwork` in `backlinks`). Any problem stops it and nothing is written.
- A second run with the same input changes nothing. `--check` exits 1 when the hub copy differs from the source.
- `scripts/cms-feature-tree.test.mjs` checks the recorded hashes, the vocabulary and the SEO feature map, and compares with a website-cms checkout when one is next to this repo (or `CMS_SOURCE_DIR`, plus `CMS_SOURCE_REF` for a branch or tag).
- **Release order:** the hub sync ships before any CMS version that adds keys or sections. website-cms `release-train.mjs check <version> --hub <hub repo>` verifies the pair.

## Feature keys for the blog

The registry names automatic posts `blog.autoPosts` (Tier 2+, `seo` bundle only) and the client-written blog `blog` and `blog.posts` (every tier). The older name `blog.localPosts` is a read alias everywhere: the registry `aliases`, the delivery vocabulary (`FEATURE_KEY_ALIASES`, version 2) and the SEO feature map. Writers send `blog.autoPosts`; the cms-spec validator refuses an alias and names the real key.

## The switch

`<dataDir>/cms-feature-settings.json`, edited with `PUT /api/admin/cms-features/settings`:

```json
{ "siteConfig": { "mode": "off", "siteIds": [], "allSites": false }, "cmsSpec": { "makerAccess": false } }
```

| `siteConfig.mode` | site-config |
|---|---|
| `off` (default, also when the file is missing) | Unchanged. Nothing is computed. |
| `shadow` | Unchanged. The tree is computed for every site-config call and the result (source, services, lost flags, errors) is shown by `GET /api/admin/cms-features`. |
| `on` | Sites in `siteIds` (or every site with `allSites`) get the tree; all other sites are shadowed. |

An error while computing the tree never changes the answer: the old config is returned and the error is recorded. The sales client list is read at most every 30 seconds for this. `cmsSpec.makerAccess` lets the Maker read and write cms-spec; until then only Superadmin can. A request that carries a Maker credential header (`x-maker-host-token`, `x-maker-callback-token` or `x-sales-callback-token`) is checked by the `makerAuth` middleware server.js passes to `registerCmsFeatureRoutes`: it answers 401 or 403 itself for a wrong credential, and only a request it lets through meets the switch (403 while `makerAccess` is off). Without `makerAuth`, every Maker request gets 401. The Maker writes `sections`, `force` and `featureSpec` `defaults` and `values`; a Maker write with `grantServices`, `revokeServices`, `grant`, `revoke` or `locks` is refused with 403, since services, keys and locks come from the plan and Superadmin.

## site-config with the tree

For a site that is switched on, `GET /api/hub/site-config` adds:

- `featureTree`: `{ v, registryVersion, rev, plan, tier, services, source, entitled, defaults, values, locks }`. `source` is `planSource`, `sitePlan` or `websitePlan`.
- `featureEnforcement`: `off`, `log` or `on` (default `log`).
- `pendingSettings`: `{ rev, sections, force }`, only while `cmsSpec.rev` is newer than the `settingsRevApplied` the CMS reported, and only for a `?site_key=` lookup whose caller is trusted with the site's admin data. `hub.getSiteConfig(key, false, { withFeatures, includeAdmin })` decides that: `includeAdmin` defaults to true for a site key lookup and gates the admin sync fields (`clientAdmin`, `pendingAdmin`) and `pendingSettings` together. A caller that holds only a public value passes `includeAdmin: false`; `/api/cms/config` does so for its `CMS_SITE_KEY` lookup. The hook and `siteConfigWithTree` add `pendingSettings` only when told `includeAdmin: true`.
- A domain lookup is public: with the tree on it returns only the fields in `PUBLIC_SITE_CONFIG_FIELDS` (`lib/cms-entitlements.js`), so it never has `pendingSettings` or an admin field, and a field added to site-config later stays out until it is listed. A new public site-config field must be added to that list, or switched-on sites lose it on domain lookups; `scripts/cms-entitlements.test.mjs` and `scripts/cms-features-boot.test.mjs` fail when a field of the dark domain answer is missing from it.
- The 7 legacy `features` come from the tree (`legacyFromTree`). Every flag that is on today stays on, except `socialSync`, which is always off (it only showed a placeholder tab). Tier 1 gains `blog` and `general`. `ecommerceCatalogType` and `analyticsLevel` follow the derived flags.

**Services** come from `site.planSource.services` (WS8.4), else the linked sales client's `sitePlan.services` and `oneTimeAddOns` (WS8.3), else the tier's services. Ids the registry does not know are logged once and dropped.

**Lazy migration.** A site without a `featureSpec` reads as `{ rev: 1 }` plus:
- `grantServices` for each legacy flag that is on and that the plan neither covers nor explains (`analytics → seo`, `ecommerce → ecom`, `blog → blog`, `emailMarketing → email`, `socialSync → social`, `users`/`general → site`). A plan explains a flag when `planSource.derivedFeatures` has it, or when the plan's services stand for it.
- `revoke` for a flag switched off on purpose: off while the plan's flags have it on, or a WS8 `featureOverrides` row (`analytics → analytics`, `ecommerce → shop`, `blog → blog`, `emailMarketing → email.campaigns, email.newsletter`).
- `defaults: {"blog.autoPosts": false}` when `seo` is granted only because of the analytics flag.
- `values: {"shop.catalog": ecommerceCatalogType}` for a site without a plan.

The first cms-spec write that sends `featureSpec` stores this spec with the change (rev 2) and notes the migration in the history.

## cms-spec endpoints

| Route | Who | What |
|---|---|---|
| `GET /api/hub/sites/:id/cms-spec` | Superadmin, or the Maker with `makerAccess` | The spec (lazily migrated when none is stored), the history, the resolved tree, the legacy flags, what the CMS reported, `pendingSettings`, the site-config mode. |
| `GET /api/hub/sites/:id/cms-spec/prompt` | same | `{ prompt, length }`: the resolved tree (the CMS `featurePromptBlock`) and every section field, at most 12,000 characters. |
| `PUT /api/hub/sites/:id/cms-spec` | same; `featureEnforcement` Superadmin only | Body `{ featureSpec?, sections?, force?, reason?, cmsSpecRev?, featureEnforcement? }`. |
| `GET /api/admin/cms-features` | Superadmin | Registry status, the switch, the shadow results. |
| `PUT /api/admin/cms-features/settings` | Superadmin | Change the switch (`{settings, reason}` or the settings object). |
| `GET /api/admin/cms-features/preview?siteId=` | Superadmin | Per site: today's flags next to the flags from the tree, lost flags, the tree, the effective keys. No site keys or admin fields. |

**Validation** returns 400 `{ errors: [{ path, message }] }` with exact paths, for example `featureSpec.defaults.shop.foo`, `featureSpec.grantServices[0]`, `sections.email.recovery.steps[1].delayMinutes`. Only canonical keys, service ids and enum values pass. A testimonial in `content.seed` needs `evidence` (`review` + `reviewId`, `quote` + `transcriptRef`, or `url` + an https `url`). Section and field names are matched as the schema's own names only (`toString` is an unknown section), and an object key named `__proto__`, `constructor` or `prototype` anywhere in the body is refused before anything else; merges skip those names too. So is any object or list nested more than 16 levels below the spec (`MAX_SPEC_DEPTH`; a section is level 2, and the deepest schema field needs 8), with the path of the first level too deep.

**Merge rules.** `featureSpec` lists replace the stored list (granting an id that was revoked removes it from the revoke list unless that list is sent too, and the other way round); `defaults` and `values` merge per key and `null` removes a key. Sections merge one at a time: objects merge, lists and plain values replace, `null` removes a field, a section set to `null` is removed; list-shaped sections (`customFields`, `contentTypes`, `wizards`) replace. `force` replaces. Each part's `rev` goes up only when it changed; an unchanged write is accepted and changes nothing. `featureSpec.rev` or `cmsSpecRev` in the body must equal the stored rev (409 otherwise). The stored cms-spec is at most 256 kB (413).

**History.** `site.cmsSpecHistory` keeps the last 20 changes: who, when, why, the resulting revs, which parts changed and what was sent (up to 16 kB, else a hash).

## Heartbeat

`POST /api/hub/heartbeat` also keeps, in `site.cms`, what a CMS 2.3+ reports: `featuresRev`, `clientFeaturesRev`, `settingsRevApplied`, `settingsConflicts`, `effective` (comma-separated), `effectiveHash`, `migrations` (the CMS migrations summary: the last 40 items, the failed, pending and pruned ids, status, lockedBy, firstBackup, hold, lastRun and lastRestore; at most 16 kB, or only status, failed and pending marked `truncated`), `packageBuild`, `initialAdminPending`, `loginAddressMode`, `loginForwardedFor`, `loginAddressFrom`, and the daily block counts (`featureBlocksDaily`) as `blockHistory` (one row per day, each day's top list at most 2 kB; only the 14 days up to today plus tomorrow by the hub's clock are kept, so rows a CMS dates far ahead or long ago are dropped, stored ones included). Values are typed and size-bounded; a field the CMS does not send is not added, so an older CMS leaves the site as it was. The heartbeat can never set `featureSpec`, `cmsSpec` or `featureEnforcement`. These report fields are applied only for a verified heartbeat: `hub.recordHeartbeat(siteKey, fields, { verified })` (default true) skips them when `verified` is false, so a caller that cannot prove it is the site cannot mark a settings revision as applied.

`recordHeartbeat` and the cms-spec write (`updateSiteSpecs`) read and write `sites.json` under one lock file (`sites.json.lock`, `data/atomic-json.js`), so a heartbeat and a spec write in two hub processes never overwrite each other. The other site writers do not take this lock yet.

## got-client

When the sales client has a `sitePlan`, the new hub site takes `websitePlan` from `sitePlan.tierId` and the request body's `websitePlan` is ignored.

## Email keys (WS7.31)

The email keys are rows of the same registry. `lib/email-feature-keys.js` maps the relay's send kinds to them (`cart-recovery → email.automations.abandonedCart`, `welcome`, `double-opt-in`, `back-in-stock`, `review-request`, `winback`, `campaign → email.campaigns`, `test → email`). `emailKindsFor` allows a kind when its key is entitled; before the tree reaches a site, the legacy flags decide (`emailMarketing` gives welcome, double-opt-in and test; `ecommerce` adds the four shop kinds). `campaign` needs the caller's `campaignsAllowed`. The cms-spec `email` section carries sender, identity, recovery steps (1 to 3, 30 to 43,200 minutes, increasing), discounts, welcome, winback, review requests, campaigns, owner notifications, evidence quotes and `email.*` feature values.
