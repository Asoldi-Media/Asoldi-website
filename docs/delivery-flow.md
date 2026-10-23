# Delivery flow (sign → live)

How a signed client moves from contract to a live site, and the switches that control it. Batch 0 is in
place (vocabulary, forward-compatible data, snapshots, automation settings, test clients); the rest of the
flow lands batch by batch, and each batch updates this file. Runbooks: [delivery-runbooks.md](delivery-runbooks.md).

**Status of the parts below**

| Part | Code | Status |
|---|---|---|
| Shared vocabulary | `packages/suite/core/delivery/vocab.js` (Maker copy: `lib/suite/core/delivery/vocab.js`) | in place |
| Forward-compatible normalizers | `data/normalize-ext.js` | in place |
| Snapshots and restore | `lib/delivery-snapshots.js`, `scripts/delivery-snapshot.mjs`, `scripts/restore-delivery-snapshot.mjs` | in place |
| Automation settings | `data/automation-settings.js`, Superadmin routes in `lib/routes/delivery-routes.js` | in place |
| Test clients | `lib/test-clients.js` | in place |
| Stages, gate, emails, job queue, Maker worker | later batches | planned |

---

## Rules

- The hub never calls the Maker. The Maker pulls jobs and pushes callbacks.
- Schedules are persisted timestamps, never in-memory timers.
- Switches live in `<dataDir>/automation-settings.json`, edited from Superadmin. No Hostinger env vars, no new Maker env vars.
- **No approval queues.** Every automation switch is `shadow` or `auto` (see [Switches](#switches)).
- **Vocabulary is append-only.** Ids in `vocab.js` are never renamed or removed. Hub and Maker import the same file; edit it only in `packages/suite`, then run `node scripts/sync-suite.mjs`.
- **Data is forward-compatible.** Normalizers keep keys written by later batches (`data/normalize-ext.js`), so reverting a batch never deletes data.

---

## Services and tiers

Service ids (`SERVICE_CATALOG`): `site`, `changes`, `seo`, `social`, `email`, `blog`, `ecom`, `dashboard`, `multilingual`, `unlimited`, `catalog`, `booking`, `backlinks`.
Aliases (`SERVICE_ALIASES`) resolve `shop`, `ecommerce`, `nettbutikk` → `ecom`, `katalog` → `catalog`, `timebestilling` → `booking`, `epost`/`e-post` → `email`, `blogg` → `blog`, `backlink`/`linknetwork`/`lenkenettverk` → `backlinks`.
One-time add-ons: `pos`, `thirdpartyhost`.

| Tier | Services (`TIER_SERVICES`) |
|---|---|
| `tier-1-standard` | site, changes, blog |
| `tier-2-seo` | site, changes, blog, seo, social, email, backlinks |
| `tier-3-ecommerce` | site, changes, blog, seo, social, email, backlinks, ecom, dashboard, multilingual |
| `custom` | from the offer; `site` always brings `blog` (`IMPLIED_SERVICES`) |

Owner decisions built into the vocabulary:

- **Blog on every tier.** Clients write posts on every tier (WS6 feature `blog`; the master plan calls it `blog.posts`). Auto-written posts (WS6 feature `blog.localPosts`; the master plan calls it `blog.autoPosts`) come with the `seo` service only, so tier 2 and up (`SERVICE_FEATURE_ANCHORS`, `SERVICE_EXCLUSIVE_FEATURES`, `FEATURE_KEY_ALIASES`). The WS6 `blog` bundle must therefore not entitle `blog.localPosts`, and the CMS must not treat the legacy `features.blog` flag (on for tier 1 now) as permission to pull auto posts.
- **Backlink network** is its own service (`backlinks`, feature `seo.linkNetwork`), on by default for tier 2 and up.
- **Cancellation stops hub services** (`CANCELLATION_EFFECTS`: `cms-updates`, `auto-posts`, `backlink-network`, `hub-email`, `change-requests`) after the paid period plus `CANCELLATION_GRACE_DAYS` (30). There is no standalone mode; `thirdpartyhost` is SEO and change work for a site hosted elsewhere.
- **Soft budgets never block.** Reaching a budget is the warning `budget-soft-limit`. Only a runaway (`budget-runaway`, more than 5× expected) or a loop (`loop-detected`) stops a job.

`legacyFlagsForServices(services)` gives the 7 legacy CMS flags. Tier 2 and 3 match today's `featuresFromPlan`; tier 1 gains `blog: true` (the owner decision above) when the plan source switches to services.

---

## Stages

Derived, never set by hand (the first matching row wins in `deriveStage`, a later batch):

| Stage | Label (nb) | Meaning |
|---|---|---|
| `lead` | Lead | no meeting yet |
| `sales_meeting` | Salgsmøte | meeting held |
| `offer_sent` | Tilbud sendt | offer sent; also where an un-signed contract goes back to |
| `signed` | Signert | contract signed, `sitePlan` active |
| `gathering` | Innsamling | pre-workshop email sent or workshop booked |
| `workshop_held` | Workshop holdt | workshop recorded or noted |
| `gate` | Klar for utvikling? | post-workshop email sent or gate passed |
| `developing` | Utvikles | a `continue` job is queued or running |
| `dev_review` | Utviklerkontroll | the latest dev job is done |
| `client_preview` | Kundens forhåndsvisning | preview-ready sent after a fresh, accepted push |
| `iterating` | Iterasjon | an `iteration` or `change_request` job before approval |
| `approved` | Godkjent av kunden | client approval tied to the current preview hash |
| `publishing` | Publiseres | a `publish` job, or staging live and production not yet |
| `live` | Live | production live and verified |
| `maintenance` | Vedlikehold | monthly plan, live for 7 days |
| `handed_over` | Overlevert | one-time plan, handover checklist done |

Overlays shown on top of a stage: `paused` (payment failed past the grace period) and `cancelled`.

---

## Gate

Columns (`GATE_COLUMNS`): `dev` must be met before development starts; `ready` before the production publish.
Line statuses: `have`, `missing`, `waived`, `declined` (skipped in the assistant; never asked again).
Levels: `required`, `optional`. Origins: `service`, `page-kind`, `info`.

Service lines (`GATE_SERVICE_LINES`):

| Line | Service | dev | ready |
|---|---|---|---|
| `workshop` | site | required | – |
| `logo` | site | required (waive: text logo) | – |
| `business-what` | site | required | – |
| `contact` | site | required (registered business address, never a home address) | – |
| `hero-media` | site | optional | required |
| `opening-hours` | site, with a visit address | optional | optional |
| `domain` | site | – | required |
| `client-approval` | site | – | required |
| `keywords` | seo | required | – |
| `service-area` | seo | required for local/regional scope | – |
| `google-business` | seo | optional | optional |
| `products` | ecom | required | required |
| `seller` | ecom | required | required |
| `shipping` | ecom | optional | required |
| `returns` | ecom | optional | required |
| `payment` | ecom | – | required |
| `catalog-items` | catalog | required | required |
| `booking-services` | booking | required | required |
| `languages` | multilingual | required | – |

Page-kind lines (`GATE_PAGE_KIND_LINES`), on any tier when the page plan has the page:

| Line | Page kinds | dev | ready |
|---|---|---|---|
| `menu-items` | menu | required | required |
| `project-images` | portfolio, projects | optional | required |
| `staff` | team | optional | required |
| `price-list` | pricing | optional | required |
| `booking-services` | booking | required | required |
| `blog-topics` | blog-index | – | optional |
| `services-list` | services, service-detail | required | – |

Developer-only info lines (`GATE_INFO_LINES`, never sent to the client, never blocking): `step1Qa`, `needs-hard`, `dpa-missing`, `plan-changed-rerun`.

---

## Emails

| Kind | Sender | Legacy | Default |
|---|---|---|---|
| `preWorkshop` | scheduling (the client's rep) | yes | auto, legacy lines (today's autosend on signing) |
| `workshopReminders` | scheduling | yes | off (on with `WORKSHOP_DESK_EMAIL_AUTOSEND=1` or the setting) |
| `postWorkshop` | scheduling | no | shadow |
| `dataReminder` | scheduling | no | off |
| `previewReady` | scheduling | no | shadow |
| `stagingReady` | service | no | shadow |
| `siteLive` | service | no | shadow |
| `changeRequestAck` | service | no | shadow |
| `changeRequestDone` | service | no | shadow |
| `nurture` | scheduling | no | off (sends only with a recorded consent) |
| `dpaSigning` | service | no | shadow |

Scheduling mails go out from the client's rep with the rep's reply-to, so replies reach a mailbox the inbox bot reads. Service mails use `sender.service`.

---

## Switches

`GET/PUT /api/admin/automation-settings` (Superadmin). PUT takes a partial object (deep-merged) or `{settings, reason}`. The per-mailbox maps (`inbox.autoActions`, `inbox.autoReply`) and every `paused` object replace as a whole, and a PUT that changes `inbox.mailboxes` drops the map entries of a mailbox that is no longer listed; invalid input returns 400 with `errors[{path, message}]`. Every change is audited (last 50: who, when, what, why).

**Modes.** Each email kind has `enabled`, `mode` and `paused`:

- `shadow`: the internal pre-release stage. The system computes and records what it would send; nothing is sent. (`approve` and `manual` are accepted as old names for `shadow`.)
- `auto`: sends, guarded.
- Effective state (`EFFECTIVE_MODES`): `off` (not enabled), `shadow`, `paused`, `auto`.

**Pre-release gate.** Release-gated switches (`RELEASE_GATED_SWITCHES`: every non-legacy email kind, `emails.preWorkshop.gate` for gate lines in the pre-workshop mail, `development.autoQueue`, `publish.staging`, `publish.production`) can only be set to `auto` after the pre-release suite (golden clients, safe-mode outbox snapshots, the canary site) recorded a pass with `recordReleasePass`. A PUT cannot write `releases`. With `promotion.auto` on, a recorded pass promotes the switch to `auto` in the same write.

**Runtime guards.** `pauseAutomationSwitch(path, {reason})` pauses an email kind or a publish target (errors, bounces, complaints, volume spike, empty fields, wrong recipient class) and audits it with source `guard`. Resume with `resumeAutomationSwitch` or a PUT of `paused: null`. Thresholds live under `guards.*`.

**Pilots and test clients.** With `pilotClientIds` empty, automation applies to every client. With pilots listed, only pilots run in `auto` and everyone else runs in `shadow` (legacy kinds keep running). Test clients take part only when listed as pilots.

**Env overrides.** `WORKSHOP_DESK_EMAIL_AUTOSEND=1` still turns on workshop reminders and shows as `overriddenBy: 'env'`.

Settings keys (`SETTINGS_KEYS`, dotted paths in the file):

| Group | Keys |
|---|---|
| Pilots | `pilotClientIds` |
| Emails | `emails.<kind>.enabled`, `emails.<kind>.mode`, `emails.<kind>.paused`, `emails.preWorkshop.lines` (`legacy` or `gate`), `emails.postWorkshop.delayMinutes`, `emails.dataReminder.afterDays`, `emails.dataReminder.max`, `emails.nurture.cadenceDays` |
| Senders | `sender.scheduling`, `sender.service.accountKey`, `sender.service.replyTo` (must be one of the read mailboxes) |
| Inbox | `inbox.mailboxes` (only alexander@asoldi.com and damian@asoldi.com are allowed; default: alexander@ only, as today), `inbox.autoActions`, `inbox.autoReply`, `inbox.prefilter`, `inbox.internalDomains`, `inbox.internalSenders` |
| Fireflies | `fireflies.candidateRanker.enabled`, `fireflies.candidateRanker.candidateMinScore`, `fireflies.autoLink.enabled`, `fireflies.autoLink.requireExactAttendeeEmail`, `fireflies.autoLink.slotWindowMinutes` |
| Development | `development.autoQueue`, `development.directivesForAutoDev`, `development.defaultHostId`, `development.requireConfirmForCustom`, `development.previewJobs`, `development.seoJobs` |
| Publish | `publish.staging.mode`, `publish.staging.tiers`, `publish.production.mode` |
| Change requests | `changeRequests.enforce`, `changeRequests.slaWorkDays`, `changeRequests.countAt` (counted at acceptance) |
| Pricing | `pricing.oneTimeMultiplier`, `pricing.oneTimeMinExMva`, `pricing.oneTimeMonths` |
| Lifecycle | `lifecycle.paymentGraceDays`, `lifecycle.cancellationGraceDays` |
| Promotion | `promotion.auto` |
| Guards | `guards.errorRatePct`, `guards.bounceRatePct`, `guards.complaintsMax`, `guards.volumeSpikeFactor`, `guards.windowHours`, `guards.minSample` |
| Retention | `retention.leadMonths`, `retention.afterContractMonths`, `retention.briefOldVersionsDays`, `retention.changeRequestsMonths`, `retention.nurtureProofYears`, `retention.inboxSkipLogDays` |
| Storage | `storage.budgetFiles`, `storage.budgetMb` |
| Alerts | `alerts.to`, `alerts.hostOfflineHours`, `alerts.jobBlockedHours`, `alerts.digestAt` |

---

## Jobs and codes

Job kinds (`JOB_KINDS`; anything else is rejected by `assertJobKind`, which the job queue and the Maker handler registry call):

| Kind | Started by | Handled by |
|---|---|---|
| `preview` | sales page "Lag preview via Maker" (when `development.previewJobs` is on) | Maker autopilot, preview mode |
| `continue` | gate passed with auto-queue, or "Start utvikling" | Maker autopilot, delivery mode, then the canonical build chain |
| `iteration` | iteration meeting processed | autopilot plus the dev-agent session |
| `change_request` | "Utfør med AI" on a change request | dev-agent session |
| `dev_accept` | "Godkjenn og send preview" | dev agent ends the session and pushes the preview |
| `materials_sync` | new Kundedata or inbox media, or added services | Maker media sync |
| `publish` | staging or production publish (`input.target`) | Maker go-live |
| `seo.refresh` | brief change in tier, services, audience or agreed keywords (when `development.seoJobs` is on) | Maker SEO step |
| `seo.maintenance` | monthly for live tier 2+ clients (when `development.seoJobs` is on) | Maker SEO step |
| `cms-fleet` | Superadmin fleet start | Maker CMS fleet |
| `purge` | erase request | Maker deletes the client's brief cache and dev data |

Blocking codes (`BLOCKING_CODES`) stop a job; the fix is in [delivery-runbooks.md](delivery-runbooks.md#blocking-codes):
`needs-language`, `needs-pages`, `needs-template`, `needs-confirm`, `needs-brief-identity`, `needs-approval`, `needs-payment-setup`, `dns-not-switched`, `run-not-on-host`, `no-handler`, `maker-offline`, `step-failed` (stored as `step-failed:<target>`), `dev-agent-failed`, `budget-runaway`, `loop-detected`.

Warning codes (`WARNING_CODES`) never block: `dev-skipped`, `seo-deferred-no-domain`, `cms-review-pending`, `plan-changed-rerun`, `budget-soft-limit`.

---

## Data safety

- **Forward-compatible keys.** `data/normalize-ext.js` lists what later batches store on sales clients (`sitePlan`, `delivery`, `nurture`, `isTest`, ...), `makerRun`, `hubSite`, hub sites (`planSource`, `stagingDomain`, `featureSpec`, ...), `site.cms` and offers (`plan`, `pricing`, `dpaVersion`), plus a reserved `ext` object. Normalizers pass them through unchanged from the stored record; the code that owns a key normalizes it itself. An incoming patch cannot write them: `mergeMakerRunPatch` drops future `makerRun` keys and step tokens from a patch (for example a set-maker-run body), so a value such as `makerRun.goLive` only ever comes from the batch that owns it. `offerContentHash` ignores them, so no offer hash changes. `site.deliveryPhase` keeps `cancelled` and `archived`.
- **Snapshots.** `DELIVERY_SCHEMA_VERSION` (in `lib/delivery-snapshots.js`) goes up by one in every batch that adds or reshapes delivery data. On startup, when it is higher than `<dataDir>/delivery-schema.json`, the server copies the delivery stores (`DELIVERY_SNAPSHOT_FILES`) into `<dataDir>/snapshots/batch-<n>-<timestamp>/` before anything writes. The newest 3 snapshots are kept. A snapshot holds the same data as the live stores, including personal data, site keys (`site_key`), client admin password hashes and blog token hashes from `sites.json`, so it is as sensitive as the stores themselves. It lives only inside the data dir, is never served and never leaves the server through any route (the list and restore routes return snapshot ids, counts, record ids and the names of changed keys, never values).
- **Restore** shows a per-record diff first and saves the current state as `pre-restore-<timestamp>` before it writes.
- **Test clients.** `client.isTest` and `site.isTest` are set from Superadmin (Testkunde / Testside). Test clients stay workable on the boards but are left out of offer counts and other reports, social proof, nurture, Myphoner sync (no copy out, no incoming rewrite) and the gate evaluation set. The public site-config never carries the flag.

**Definition of done for every delivery batch:** `node --test scripts/forward-compat-revert.test.mjs` with `FORWARD_COMPAT_REF=<last deployed commit>`, `node --test scripts/docs-delivery-coverage.test.mjs`, and `DELIVERY_SCHEMA_VERSION` bumped when the batch adds delivery data.
