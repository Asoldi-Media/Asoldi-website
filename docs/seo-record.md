# SEO record, job gating and the DataForSEO ledger

Three parts of the hub's SEO operations. Each switch is in the automation settings (`GET` and `PUT /api/admin/automation-settings`, in the `seo` block) and is off by default.

## The SEO record

One record per sales client in `<dataDir>/seo-ops/clients/<salesClientId>.json`, written through `lib/seo-ops/store.js` (locks, atomic writes, backups, history capped at 200 rows). Code: `lib/seo-ops/record.js`.

| Field | What it holds |
|---|---|
| `agreedKeywords` | `[{ phrase, status, source, quoteRef?, flags?, at, by }]`; `status` is `proposed`, `approved` or `blocked`. At most 3 approved, 1-6 words each. A prescription-only substance is refused (400 `regulated`); a phrase with the business's own name is kept with `flags: ['brand']`. |
| `planSummary` | The Maker's summary of its keyword plan: locale, town, counts, up to 10 primaries, up to 50 candidates (phrase, volume, intent, role), brand searches, QA and spend. Raw provider responses are never kept. |
| `pageMap` | Optional `[{ route, kind, primary, indexable }]` from the Maker. |

**Ingest.** Both bundle routes (`POST /api/internal/maker/client-bundle` and the `run.client-bundle.updated` event on `POST /api/admin/sales/maker-status-callback`) store `bundle.keywordPlanSummary` before the portal sync, so a client without a portal user still gets a record. The answer keeps its status (404 when the portal sync finds no account) and adds `seoRecorded: true`, or `seoRecorded: false` with `seoReason` (`no-sales-client`, `unknown-sales-client`, `invalid-summary`, `busy`, `error`). A push without a summary is answered exactly as before. An unchanged summary writes nothing; agreed keywords are never touched by a push.

**Bank merge.** A bundle push replaces only `bank.seo.keywordPlan`; other `bank.seo` fields are kept (`lib/maker-bundle-to-bank.js`). The portal normalizer (`data/client-portal.js`) still stores only `seo.keywordPlan`.

**Routes** (`lib/routes/seo-record-routes.js`). Every answer carries `seoRecorded` (whether the client has a record).

| Route | Who | What |
|---|---|---|
| `GET /api/admin/sales-clients/:id/seo` | sales, developer, admin | the record, its contract line and the last 20 history rows |
| `PUT /api/admin/sales-clients/:id/seo` | developer, admin | `{ agreedKeywords: [...] }` replaces the list (duplicates collapse to the strongest status) |
| `POST /api/admin/sales-clients/:id/seo/approve` | developer, admin | `{ phrase, source?, quoteRef? }` |
| `POST /api/admin/sales-clients/:id/seo/block` | developer, admin | `{ phrase, reason? }` |
| `GET /api/internal/maker/seo-record?salesClientId=` | Maker host (`client-bundle` scope) | approved and blocked keywords and the page map; 404 `{code:'disabled'}` for every caller while `seo.recordPull.enabled` is off |

A developer sees and changes only the clients assigned to them. The developer page shows the record in the SEO panel (`app/pages/developer/DeveloperSeoPanel.tsx`, `AgreedKeywordsPicker.tsx`); the offer composer lists the agreed keywords read-only.

**For other code.** `agreedKeywordsFor(id)` (approved phrases), `freezeAgreedKeywords(id, { ref })` (a frozen snapshot with the contract line, noted in the history), `agreedKeywordsContractText(record)` in `lib/seo-ops/contract-text.js` (`Avtalte søkeord: a, b, c`, or `null`), and `tickSteps` (empty for now).

**Consumers.** Maps keywords (`buildMapsKeywords`) and analytics goals (`analyticsGoalsFromBank`, also in `GET /api/hub/site-config`) read the record of the bank's `makerLink.salesClientId` once a developer has approved or blocked a keyword: approved keywords first, then the page map's primaries, then the bank's plan; blocked phrases, prescription-only substances and the business's own name are left out. Until a keyword is decided their output is exactly as without a record.

## Job gating

`seo.jobGating` (`{ enabled, mode }`, mode `shadow` or `auto`) chooses who decides two jobs (`lib/seo-ops/job-gating.js`):

| Job | Old gate | Feature-key gate |
|---|---|---|
| `blog-scheduler` (the `blogEnabled` flag of `GET /api/hub/local-blog-brief`) | blog flag on and a service that entitles automatic posts | `blog.autoPosts` (older name `blog.localPosts`) |
| `rank-tracker.maps` (the Maps ranking loop) | analytics access for the plan and flags | `seo.tracking.maps` |

- Off (`enabled: false`, the default): the old gate decides; the feature-key gate is not computed.
- Shadow: the old gate decides; each site where the feature-key gate differs gets a row in `<dataDir>/seo-ops/decision-diff.json` (removed when they agree again).
- Auto: the feature-key gate decides. Agency overrides go in `site.ext.seoFeatureOverrides`, for example `{"blog.autoPosts": false}`.

Before auto, compare both decisions on a copy of the production data dir: `node scripts/seo-gating-diff.mjs --data <copy>` (only reads the copy; `--json`, `--all`). The sites it lists change behaviour when the switch moves to auto.

## DataForSEO ledger

`lib/seo-ops/dfs-ledger.js` books spend by month in `<dataDir>/seo-ops/dfs-ledger-YYYY-MM.json` (13 months kept). It never stops a call. Soft caps come from `seo-ops/settings.json` (`budgets.monthlyUsd`, `budgets.byPurpose`, `budgets.perSiteMonthlyUsd` by tier, `balanceFloorUsd`); a booking that takes a cap to 100 % records an alert in the month file once and logs it. A booking the store refuses (a month outside the 13 kept, an unknown purpose) is returned and logged as an error.

With `seo.dfsLedger.enabled` on, Maps ranking calls (`lib/dataforseo-maps.js`, purpose `maps`, per site) and Infokort searches (`lib/dataforseo-serp.js`, purpose `infokort`) are also booked there. The stops stay as they were: a Maps call is refused when the lifetime total in `dataforseo-maps-spend.json` (all months together) plus the call would pass `DATAFORSEO_MAPS_BUDGET_USD` (default $50), and Infokort keeps its lifetime and daily caps.

## Schedulers in safe mode

`lib/seo-ops/schedulers.js` lists the seo-ops schedulers (`id`, `purpose`, `allowSites`, `spendCapUsd`). With hub safe mode off every site runs as before. With it on, a scheduler runs only for the site keys in `settings.safeMode.allowSites` (or its own `settings.safeMode.schedulers[id]`), and its DataForSEO calls replay `scripts/fixtures/seo-ops/dfs/*.json` unless `settings.safeMode.live` is set; live calls stop at `spendCapUsd` for the process. The Maps ranking loop runs through it.
