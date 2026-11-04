# SEO record, job gating and the DataForSEO ledger

Three parts of the hub's SEO operations. Each switch is in the automation settings (`GET` and `PUT /api/admin/automation-settings`, in the `seo` block) and is off by default. Each switch node also takes `paused` (`null`, or `{ reason }`); a paused switch counts as off.

## The SEO record

One record per sales client in `<dataDir>/seo-ops/clients/<salesClientId>.json`, written through `lib/seo-ops/store.js` (locks, atomic writes, backups, history capped at 200 rows). Code: `lib/seo-ops/record.js`.

| Field | What it holds |
|---|---|
| `agreedKeywords` | `[{ phrase, status, source, quoteRef?, flags?, at, by }]`; `status` is `proposed`, `approved` or `blocked`. At most 3 approved, 1-6 words each. A prescription-only substance is refused (400 `regulated`): a listed term matches at the start of a word, and a term of 8 letters or more also inside a compound (`melatonintabletter`), so `specialist` is not caught by `cialis`. The check applies to a new proposal and a new approval only: blocking such a phrase always works, and a stored row whose substance is listed later is kept (it can still be removed, blocked or moved back to proposed), while consumers and the contract line leave it out. Approving exactly the business name without its legal form, or a brand search from the plan, needs `allowBrand: true` (400 `brand` otherwise); a phrase that only resembles the name is approved as usual. Both are kept with `flags: ['brand']`. |
| `planSummary` | The Maker's summary of its keyword plan: locale, town, counts, up to 10 primaries, up to 50 candidates (phrase, volume, intent, role), brand searches, QA and spend. Raw provider responses are never kept. |
| `pageMap` | Optional `[{ route, kind, primary, indexable }]` from the Maker. |

**Ingest.** Both bundle routes (`POST /api/internal/maker/client-bundle` and the `run.client-bundle.updated` event on `POST /api/admin/sales/maker-status-callback`) store `bundle.keywordPlanSummary` before the portal sync, so a client without a portal user still gets a record. The answer keeps its status (404 when the portal sync finds no account) and adds `seoRecorded: true`, or `seoRecorded: false` with `seoReason` (`no-sales-client`, `unknown-sales-client`, `invalid-summary`, `busy`, `error`). A push without a summary is answered exactly as before. An unchanged summary writes nothing; agreed keywords are never touched by a push. The push waits at most 3 s for the client file when another writer holds it, and then answers `busy` (the Maker gives up on a push after 12 s and retries `busy` and `error` once).

**Bank merge.** A bundle push replaces only `bank.seo.keywordPlan`; other `bank.seo` fields are kept (`lib/maker-bundle-to-bank.js`). The portal normalizer (`data/client-portal.js`) still stores only `seo.keywordPlan`, so today the merge changes nothing that is saved; it takes effect once the normalizer keeps other `seo` fields.

**Routes** (`lib/routes/seo-record-routes.js`). Every answer carries `seoRecorded` (whether the client has a record).

| Route | Who | What |
|---|---|---|
| `GET /api/admin/sales-clients/:id/seo` | the sales rep who owns the client, a developer who sees it on the developer page, admin | the record, its contract line, the last 20 history rows, `guidesConsumers` and `linked` (see Consumers) |
| `PUT /api/admin/sales-clients/:id/seo` | the developer who works on the client, admin | `{ agreedKeywords: [...] }` replaces the list (duplicates collapse to the strongest status; a row may carry `allowBrand`) |
| `POST /api/admin/sales-clients/:id/seo/approve` | the developer who works on the client, admin | `{ phrase, source?, quoteRef?, allowBrand? }` |
| `POST /api/admin/sales-clients/:id/seo/block` | the developer who works on the client, admin | `{ phrase, reason? }` |
| `GET /api/internal/maker/seo-record?salesClientId=` | Maker host (`client-bundle` scope) | approved and blocked keywords and the page map; 404 `{code:'disabled'}` for every caller while `seo.recordPull.enabled` is off |

Access matches the other sales-client and developer routes: another rep's client answers 403 (`Not your sales client.`); a developer who cannot see the client gets 404, and one who sees it but may not work on it now (another developer's client, or either side of a handoff that is not accepted yet) gets 403 on a change. The developer page shows the record in the SEO panel (`app/pages/developer/DeveloperSeoPanel.tsx`, `AgreedKeywordsPicker.tsx`); the offer composer lists the agreed keywords read-only.

**For other code.** `agreedKeywordsFor(id)` (approved phrases), `freezeAgreedKeywords(id, { ref })` (a frozen snapshot with the contract line, noted in the history), `agreedKeywordsContractText(record)` in `lib/seo-ops/contract-text.js` (`Avtalte søkeord: a, b, c`, or `null`), and `tickSteps` (empty for now).

**Consumers.** Maps keywords (`buildMapsKeywords`) and analytics goals (`analyticsGoalsFromBank`, also in `GET /api/hub/site-config`) read the record of a portal profile's sales client (`seoRecordForProfile`) once a developer has approved or blocked a keyword. The bank's `makerLink.salesClientId` names the sales client, but a client can edit its own bank, so the record is used only when that sales client points back at the profile (`portalBusinessId`, or `portalUserId` for a sales client without a business id; the Maker bundle push sets both). Otherwise the consumers give their output without a record. Once a record is used: approved keywords first, then the page map's primaries, then the bank's plan. Blocked phrases and prescription-only substances are left out everywhere; phrases that look like the business's own name are left out of the page map and the plan, never from the approved keywords, so Maps and the goals track exactly the keywords the contract line lists. Until a keyword is decided their output is exactly as without a record.

The record view's `linked` says whether a portal profile uses the record: its bank names the sales client and the sales client points back at it. Until then (for example a client that has no portal account yet, or whose pushes never found one) the site config, the Maps keywords and the dashboard ignore the record, even with `guidesConsumers: true`; the developer page's SEO panel says so. It takes effect once the sales client is linked, usually by the next Maker bundle push that finds the portal account.

Cost: the site config is public and the client CMS calls it on every page load without caching, so `seoRecordForProfile` reads the record first and stops there unless a keyword is decided. Only then does it look up the link, in an index of every sales client's `portalBusinessId` and `portalUserId` that is rebuilt once per change of `sales-clients.json` (the sales store's in-process revision plus the file's mtime and size, so a file replaced from outside the hub is seen too).

## Job gating

`seo.jobGating` (`{ enabled, mode, paused }`, mode `shadow` or `auto`) chooses who decides two jobs (`lib/seo-ops/job-gating.js`):

| Job | Old gate | Feature-key gate |
|---|---|---|
| `blog-scheduler` (the `blogEnabled` flag of `GET /api/hub/local-blog-brief`) | blog flag on and a service that entitles automatic posts | `blog.autoPosts` (older name `blog.localPosts`), and the site's blog flag (`features.blog`) on |
| `rank-tracker.maps` (the Maps ranking loop; in auto also every other paid Maps refresh) | analytics access for the plan and flags | `seo.tracking.maps` |

- Off (`enabled: false`, the default): the old gate decides; the feature-key gate is not computed.
- Shadow: the old gate decides; each site where the feature-key gate differs gets a row in `<dataDir>/seo-ops/decision-diff.json` (removed when they agree again).
- Auto: the feature-key gate decides. Agency overrides go in `site.ext.seoFeatureOverrides`, for example `{"blog.autoPosts": false}`.
  - Automatic posts also need the site's blog flag, whatever the tier: the client CMS publishes them through its blog module, so a site with the blog off gets none, as before.
  - Maps ranking: the gate also applies inside `ensureMapsRanking`, so a dashboard refresh (`refresh=1` on the portal and site-credential routes) and the portal's refresh button make no DataForSEO call for a site whose `seo.tracking.maps` is off; the stored ranking is shown. In off and shadow those paths are unchanged.

Before auto, compare both decisions on a copy of the production data dir: `node scripts/seo-gating-diff.mjs --data <copy>` (only reads the copy; `--json`, `--all`). The sites it lists change behaviour when the switch moves to auto.

## DataForSEO ledger

`lib/seo-ops/dfs-ledger.js` books spend by month in `<dataDir>/seo-ops/dfs-ledger-YYYY-MM.json` (13 months kept). It never stops a call. Soft caps come from `seo-ops/settings.json` (`budgets.monthlyUsd`, `budgets.byPurpose`, `budgets.perSiteMonthlyUsd` by tier, `balanceFloorUsd`); a booking that takes a cap to 100 % records an alert in the month file once and logs it. A booking the store refuses (a month outside the 13 kept, an unknown purpose) is returned and logged as an error.

With `seo.dfsLedger.enabled` on, Maps ranking calls (`lib/dataforseo-maps.js`, purpose `maps`, per site) and Infokort searches (`lib/dataforseo-serp.js`, purpose `infokort`) are also booked there. The stops stay as they were: a Maps call is refused when the lifetime total in `dataforseo-maps-spend.json` (all months together) plus the call would pass `DATAFORSEO_MAPS_BUDGET_USD` (default $50), and Infokort keeps its lifetime and daily caps.

## Schedulers in safe mode

`lib/seo-ops/schedulers.js` lists the seo-ops schedulers (`id`, `purpose`, `allowSites`, `spendCapUsd`). With hub safe mode off every site runs as before. With it on, a scheduler runs only for the site keys in `settings.safeMode.allowSites` (or its own `settings.safeMode.schedulers[id]`), and its DataForSEO calls replay `scripts/fixtures/seo-ops/dfs/*.json` unless `settings.safeMode.live` is set; live calls stop at `spendCapUsd` for the process. The Maps ranking loop runs through it.
