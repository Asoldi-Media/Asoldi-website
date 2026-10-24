# Delivery flow (sign → live)

How a signed client moves from contract to a live site, and the switches that control it. Batch 0 (vocabulary,
forward-compatible data, snapshots, automation settings, test clients) and batch 2 (tier matrix, offer plans,
site plans, the delivery state machine, Maker events, the backfill) are in place; the rest of the flow lands
batch by batch, and each batch updates this file. Runbooks: [delivery-runbooks.md](delivery-runbooks.md).

**Status of the parts below**

| Part | Code | Status |
|---|---|---|
| Shared vocabulary | `packages/suite/core/delivery/vocab.js` (Maker copy: `lib/suite/core/delivery/vocab.js`) | in place |
| Forward-compatible normalizers | `data/normalize-ext.js` | in place |
| Snapshots and restore | `lib/delivery-snapshots.js`, `scripts/delivery-snapshot.mjs`, `scripts/restore-delivery-snapshot.mjs` | in place |
| Automation settings | `data/automation-settings.js`, Superadmin routes in `lib/routes/delivery-routes.js` | in place |
| Test clients | `lib/test-clients.js` | in place |
| Tier service matrix | `TIER_MATRIX` in the vocabulary, `lib/website-tiers.js` | in place |
| Offer plans | `lib/offer-from-quote.js`, `data/sales-offers.js` | in place |
| Site plans | `lib/site-plan-model.js`, `lib/site-plan.js`, writers in `data/sales.js` | in place (written by the backfill; signing writes them in a later batch) |
| Delivery state | `lib/delivery-state.js`, writers in `data/sales.js`, audit in `lib/delivery-audit.js` | in place (stored by the backfill; the loop is a later batch) |
| Maker events | `lib/maker-events.js`, `lib/maker-events-hub.js` | in place, off (`development.makerEvents`) |
| Backfill | `lib/delivery-backfill.js`, `scripts/backfill-*.mjs`, routes in `lib/routes/delivery-routes.js` | in place, off (`migrations.deliveryBackfill`) |
| Gate, emails, job queue, Maker worker | later batches | planned |

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

- **Blog on every tier.** Clients write posts on every tier (WS6 features `blog` and `blog.posts`). Auto-written posts (WS6 feature `blog.autoPosts`; the older name `blog.localPosts` is read as an alias) come with the `seo` service only, so tier 2 and up (`SERVICE_FEATURE_ANCHORS`, `SERVICE_EXCLUSIVE_FEATURES`, `exclusiveServicesFor`, `FEATURE_KEY_ALIASES`; vocabulary version 2). The WS6 `blog` bundle does not entitle `blog.autoPosts`, and the CMS must not treat the legacy `features.blog` flag (on for tier 1 now) as permission to pull auto posts. The hub's local-blog brief already gates on the service: `GET /api/hub/local-blog-brief` returns `blogEnabled: true` only when `features.blog` is on **and** the site has the `seo` service (`localBlogAutoPostsEnabled` in `lib/local-blog-brief.js`: `planSource.services` when it lists any, otherwise the tier's services, and for a `custom` plan the `analytics` flag). The CMS local-blog job skips when `blogEnabled` is false, so a tier-1 or site-only site never gets automatic posts, whatever the legacy flag says.
- **Backlink network** is its own service (`backlinks`, feature `seo.linkNetwork`), on by default for tier 2 and up.
- **Cancellation stops hub services** (`CANCELLATION_EFFECTS`: `cms-updates`, `auto-posts`, `backlink-network`, `hub-email`, `change-requests`) after the paid period plus `CANCELLATION_GRACE_DAYS` (30). There is no standalone mode; `thirdpartyhost` is SEO and change work for a site hosted elsewhere.
- **Soft budgets never block.** Reaching a budget is the warning `budget-soft-limit`. Only a runaway (`budget-runaway`, more than 5× expected) or a loop (`loop-detected`) stops a job.

`legacyFlagsForServices(services)` (also exported as `featuresFromServices`) gives the 7 legacy CMS flags of a service list. Tier 2 and 3 match `featuresFromPlan`; tier 1 gains `blog: true` (the owner decision above) once a site's flags come from its plan's services (the plan apply, a later batch). Until then `featuresFromPlan` (`data/hub-model.js`) keeps its old output for every plan: it delegates to the matrix through `legacyTierFlagsForServices`, where the legacy `blog` flag follows the `seo` service (it meant automatic posts). A golden test pins it.

**Tier matrix.** `TIER_MATRIX` (versioned with `TIER_MATRIX_VERSION`) holds per tier its services, `changesPerMonth` (4) and page cap; every entry of `WEBSITE_TIERS` carries `services` and `changesPerMonth` from it. The sales calculator and the offer builder list a tier's bundled services with `calculatorServiceIdsForTier(tier)` (the tier's services limited to the calculator's add-on ids), so there is no second copy of the matrix. `quoteServiceToPlanService` maps the calculator's `hosting`, `contact`, `meeting`, `domain` and `webdesign` to `site`.

---

## Plans

**Offer plan (per alternative).** `buildOfferFromMeetingQuote` gives every alternative a `plan` `{tierId, services, pages, oneTimeAddOns, billing, catalogType, derived, needsConfirmation}` and a `pricing` snapshot `{oneTimeMultiplier, source}`. A named tier brings its services plus the add-ons ticked on top; a custom package is `site` plus every ticked service. Both are explicit (`derived: false`). Plans come only from the server's own quote build: `updateSalesOffer` drops `plan` and `pricing` from every patch and keeps the stored ones, and only the meeting-quote rebuild (`applyMeetingQuoteToOffer`) passes `quotePlans` to replace them. `offerContentHash` includes plan, pricing and DPA version only when an offer stores them, so offers sent before plans existed keep their hash. Products, prices and offer lines are unchanged (a golden test compares them with the code before plans).

**Offer-scoped plan.** `planFromOfferAlternative(offer, index)` returns the plan of one alternative: a dual offer needs the chosen index (`needsChoice` otherwise, and nothing changes); a single offer uses the offer's own products and tier. A stored plan whose tier or billing no longer matches the alternative is replaced by one derived from the offer text (`derivePlanFromOfferAlternative`: exact calculator service lines give services; tier base lines, the custom header, extra pages, the one-time note and fees are neutral; any other line and every custom offer set `needsConfirmation`). The portal paths keep `chosenWebsiteTier` (the offer's tier, then the meeting quote, then `portalTierId`), now in `lib/site-plan.js`.

**Site plan.** `client.sitePlan` (`lib/site-plan-model.js`) is the plan in force: version, `status` (`active`, `void` after un-signing, `ended` after cancellation), tier, services, pages, add-ons, billing, price, catalog type, languages, `changesPerMonth`, `serviceTerms.unlimited` (`{until}` for one-time plans with `unlimited`, six months from signing), `source` (`portal-accept`, `preview-accept`, `progression`, `inbox-contract`, `got-client`, `stripe-checkout`, `offer-upgrade`, `superadmin`, `backfill`), `evidence` for backfilled plans, the offer reference and hash, `signedAt`, confirmation fields, open `conflicts` and a `history` capped at 50. Only `setSalesSitePlan` writes it (with a history entry when tier, services, billing or status change); `createSalesClient`, `updateSalesClient` and `patchSalesClientsById` drop `sitePlan` and `delivery` from their input. Unknown keys in a stored plan are kept, and so is a `status`, `source` or `evidence` value this code does not know (a later batch's value); only `active` puts a plan in force, so such a plan is neither read as the plan in force nor sent to the Maker.

**Resolver.** `resolveSitePlan(client, ctx)` returns the stored plan when there is one. For a client without one it ranks the evidence: the accepted portal alternative, a superadmin plan on the hub site (`planSource.kind: 'admin'`), the newest sent offer, an offer-kind `planSource`, the linked hub site's `websitePlan`, the portal payment plan, and the meeting quote only when the rep picked the tier (`meetingQuote.tierExplicit`, stored only when true; the implicit starter default is never evidence). Lower sources that disagree become `conflicts`. SSU clients never get a plan.

**Readers.** The developer board and website-due views read the tier with `websiteTierIdForClient` (the plan in force, then the offer, `portalTierId` and the meeting quote, as before). Analytics access (`planIdForProfile`) reads the applied hub site first, then a passed plan in force. The development GET shows `sitePlan` (summary) and `deliveryStage` / `deliveryOverlay` / `deliverySubState` only for clients with a stored plan or delivery record, so other items are unchanged; the stage there is derived from the client at read time (`deriveStage`), never the stored one, so it cannot fall behind before the delivery loop keeps the stored stage in sync.

**Maker handoff (contract `site-plan/1`).** `create-maker-run` adds `sitePlan` to the Maker request body when the client has a plan in force: `makerSitePlanPayload` gives `SITE_PLAN_HANDOFF_FIELDS` (schema, status, tier, services, pages, add-ons, billing, catalog type, languages, `changesPerMonth`, source, offer reference, `signedAt`, `needsConfirmation`, the 7 flags from the services and a `planHash`). The Maker treats a plan as known only with `source` and `signedAt`. Clients without a plan send the same body as before.

---

## Stages

Derived, never set by hand: `deriveStage` in `lib/delivery-state.js` (pure; the first matching row wins). `syncSalesDeliveryStage` stores `delivery.stage`, `overlay` and one `history` entry (capped at 50) only when the stage or overlay changed, so a second sync writes nothing; each stored change also goes to the audit log `<dataDir>/delivery-audit/<YYYY-MM>.jsonl` (ids and stage names only). Until the delivery loop (a later batch) runs, only the backfill stores stages.

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

Overlays shown on top of a stage: `paused` (payment failed past the grace period) and `cancelled` (also an `ended` plan).

Details of the derivation:

- **Un-signed.** A `void` plan with the contract unchecked goes back to `offer_sent` (or `sales_meeting`, `lead`), whatever else the record holds.
- **Signed** is the contract flag with a plan that is not `void`; a signed client without any plan (before the backfill) shows sub-state `plan-missing`.
- **Live** is a verified production go-live (`makerRun.goLive`), the identity-proven fallback check (`delivery.events.liveVerifiedAt`), or for clients that went live before this flow the `progression.live` flag the old go-live callback set (sub-state `legacy`, live since the hub site was created). Monthly plans move to `maintenance` 7 days after going live or after the site-live email.
- **Sub-states:** `workshop-booked` (gathering without the pre-workshop email), the job status while `developing` or `iterating`, `awaiting-accept` or `pushed` in `dev_review`, `approval-stale` in `client_preview` (a newer preview went out), `staging`, `production` or `staging-live` in `publishing` (blocking `needs-payment-setup` while the gate's `payment` line is missing).
- **Email stamps** have one source, `delivery.emails`. `stampDeliveryEmail` / `stampDeliveryEmails` write it and mirror `preWorkshopSentAt` and the data reminders into `workshop.deskEmails` in the same write; `deliveryEmailStamps` reads both, so a stamp only the old code wrote still counts.

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

`GET/PUT /api/admin/automation-settings` (Superadmin). PUT takes a partial object (deep-merged) or `{settings, reason}`. Every `paused` object and `releases` replace as a whole. The per-mailbox maps (`inbox.autoActions`, `inbox.autoReply`) merge per mailbox and always hold exactly one entry per listed mailbox: a PUT that names one mailbox leaves the others as they were, a newly listed mailbox starts at `false`, and removing a mailbox from `inbox.mailboxes` drops its entries; an entry sent for a mailbox that is not listed is an error; invalid input returns 400 with `errors[{path, message}]`. Every change is audited (last 50: who, when, what, why).

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
| Development | `development.autoQueue`, `development.directivesForAutoDev`, `development.defaultHostId`, `development.requireConfirmForCustom`, `development.previewJobs`, `development.seoJobs`, `development.makerEvents` (`off` or `record`; default `off`, see [Maker events](#maker-events)) |
| Migrations | `migrations.deliveryBackfill` (`off`, `dry-run` or `apply`; default `off`, see [Backfill](#backfill)) |
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

## Maker events

The Maker posts `run.materials.updated` and `run.autopilot.updated` (`MAKER_DELIVERY_EVENTS`) to the existing status callback (`POST /api/admin/sales/maker-status-callback`, same callback auth, same run-link check). With `development.makerEvents` set to `record` the hub stores them on the client: `makerRun.materials` (logo present, upload counts per field, totals, product and catalog counts, domain, latest ready step, custom-site edits, `pageKinds` as route and kind, `step1Qa`, a `siteIntelSummary` of at most 2 KB and the WS3 `needs` items) and `makerRun.autopilot` (`phase`, `status`, `blocked`, `at`), each with the `runId` the callback was checked against, and sets `delivery.dirtyAt` so the gate is checked again (only for signed website clients or clients with a plan in force; leads get no delivery record). A payload without any material field (for example `materials: {}`) is ignored and never replaces a stored snapshot. Every address in the payload is dropped, in values and in object keys: any `scheme:` that addresses something (`https:`, `mailto:`, `data:`, ...) or is followed by `/`, `//host`, host names with a port or a path (`cdn.example.no/x`, `host.example:3000`), IPv4 and IPv6 literals, `localhost` and Docker host names, backslash and UNC paths, `www.*`, and Maker or upload file paths (`/api/...`, `/uploads/...`, `/runs/...`, paths ending in a file extension other than `.html`, `.htm` or `.php`); page routes must start with `/`. Only the callback's recorder writes these keys (`setSalesMakerRunOwned`); a set-maker-run body or a generic update cannot. With the switch `off` (the default) these events take the old step-status path, exactly as before.

For the material dots and the workshop need-list the live Maker run fetch comes first (it carries the answers). When it fails and the switch is `record`, a materials snapshot of the run linked now (same `runId`) younger than 24 hours (`MATERIALS_SNAPSHOT_MAX_AGE_MS`) stands in for it (upload counts, logo, domain; text points then come from Kundedata, as they did when the fetch failed without a snapshot). `materialsPageKinds` and `materialsOpenNeeds` hand the page kinds and open placeholder slots to the gate and the missing-info emails (later batches).

---

## Backfill

`lib/delivery-backfill.js` gives existing clients the delivery data later batches rely on, in three idempotent steps:

1. **Site plans** (`scripts/backfill-site-plans.mjs`): `client.sitePlan` with source `backfill` for signed website clients from the resolver's evidence. SSU clients are skipped; dual offers without a chosen alternative (`needsChoice`) and clients without evidence are listed, not written.
2. **Plan source** (`scripts/backfill-plan-source.mjs`): `planSource {kind: 'backfill', salesClientId, tierId, derivedFeatures}` on hub sites linked to a sales client. `websitePlan` and the live flags are not touched and the planSource lists no services, so the automatic-post check keeps reading the site's tier; differences between the plan's flags and the live flags are reported as warnings (tier 1 shows `blog`, the owner decision).
3. **Delivery stage** (`scripts/backfill-delivery-stage.mjs`): the derived stage for signed website clients, and email stamps (with the legacy mirror, listed in `delivery.emails.backfilled`) for clients whose stage is strictly past the last stage at which that email can still be due (`PRESTAMP_AFTER_STAGE`: pre-workshop after `gathering`, post-workshop after `gate`, preview-ready after `client_preview`, staging-ready after `publishing`, site-live after `live`, or at `live` for legacy live clients). So no new email kind goes to a client past it, and an email that is still due (for example the pre-workshop email of a client in `gathering` with a booked workshop) is never marked as sent. `progression.live` and `domainConnected` are never written.

Every run plans first. `dry-run` (the default of `node scripts/backfill-delivery.mjs`, the per-step scripts and `POST /api/admin/system/delivery-backfill`) writes only the report; `apply` (`--apply`, `{dryRun:false}`) takes a delivery snapshot, applies, and plans again to prove nothing is left. Reports (ids, tiers, counts; no names) go to `<dataDir>/migrations/delivery-backfill-<time>-<mode>.json`, the newest 10 are kept, and `GET /api/admin/system/delivery-backfill` lists them. At boot the backfill runs only when `migrations.deliveryBackfill` is `dry-run` or `apply`; an unchanged report is not written again. **A boot apply is one-time:** every apply (route, script or boot) is recorded as `lastApply` in `<dataDir>/migrations/delivery-backfill-state.json` with the delivery schema version, and a boot in `apply` mode skips the run while an apply is recorded for the current schema version, so restarts never re-plan or pre-stamp clients that moved on since. Set the switch back to `off` after the apply. Only an apply that changed something adds a line to the delivery audit log; dry runs write only their report. The backfill sends no email and makes no external call.

---

## Data safety

- **Forward-compatible keys.** `data/normalize-ext.js` lists what later batches store on sales clients (`sitePlan`, `delivery`, `nurture`, `isTest`, ...), `makerRun`, `hubSite`, hub sites (`planSource`, `stagingDomain`, `featureSpec`, ...), `site.cms` and offers (`plan`, `pricing`, `dpaVersion`), plus a reserved `ext` object. Normalizers pass them through unchanged from the stored record; the code that owns a key normalizes it itself. An incoming patch cannot write them: `mergeMakerRunPatch` drops future `makerRun` keys and step tokens from a patch (for example a set-maker-run body), so a value such as `makerRun.goLive` only ever comes from the batch that owns it. `updateSalesOffer` does the same for offers (`withoutFutureOfferPatchKeys`): `plan`, `pricing`, `dpaVersion`, `ext` and `products[].services` / `oneTimeAddOns` / `ext` in a patch (a rep's composer body, an admin edit, a meeting-quote rebuild, a contract summary) are dropped, and a product edit keeps the keys the stored product with the same id carries (alternatives: the stored one at the same index). `offerPatchFromBody` also normalizes body products in strict mode. `updateSite` drops the heartbeat-derived `site.cms` keys (`effective`, `featuresRev`, ...) from a `cms` patch. `offerContentHash` counts `plan`, `pricing` and `dpaVersion` only when an offer stores them (batch 2), so no existing offer hash changes. `site.deliveryPhase` keeps `cancelled` and `archived`.
- **Owned keys (batch 2).** The keys stay in the forward-compatible lists (so the previous batch still keeps them) and their owners normalize them: `client.sitePlan` and `client.delivery` (writers in `data/sales.js`, never from an update), offer and alternative `plan` and `pricing` (only from the quote build), and `makerRun.materials`, `makerRun.autopilot` and `makerRun.previewPush` (only the callback recorder). A stored value a normalizer cannot read is kept as it is; `null` clears it.
- **Snapshots.** `DELIVERY_SCHEMA_VERSION` (in `lib/delivery-snapshots.js`) goes up by one in every batch that adds or reshapes delivery data. On startup, when it is higher than `<dataDir>/delivery-schema.json`, the server copies the delivery stores (`DELIVERY_SNAPSHOT_FILES`) into `<dataDir>/snapshots/batch-<n>-<timestamp>/` before anything writes. The newest 3 snapshots are kept. A snapshot is built in `snapshots/.tmp-<id>/` and renamed into place; a failed attempt (disk full, EPERM, quota) removes its temporary folder and rethrows, and every prune also removes `.tmp-*` folders that have not changed for an hour, so a failing boot that retries never piles up folders. A snapshot holds the same data as the live stores, including personal data, site keys (`site_key`), client admin password hashes and blog token hashes from `sites.json`, so it is as sensitive as the stores themselves. It lives only inside the data dir, is never served and never leaves the server through any route (the list and restore routes return snapshot ids, counts, record ids and the names of changed keys, never values).
- **Restore** shows a per-record diff first and saves the current state as `pre-restore-<timestamp>` before it writes.
- **Test clients.** `client.isTest` and `site.isTest` are set from Superadmin (Testkunde / Testside). Test clients stay workable on the boards but are left out of offer counts and other reports, social proof, nurture, Myphoner sync (no copy out, no incoming rewrite, no call recording attached) and the gate evaluation set. A Myphoner lead, call or recording reaches a test client only through an explicit lead-id link (`myphonerMatchCandidates` leaves test clients out of every email, phone and name fallback), and that event is then skipped and logged; a real lead that merely shares a test client's phone or e-mail becomes or updates a real client. The public site-config never carries the flag.

**Definition of done for every delivery batch:** `node --test scripts/forward-compat-revert.test.mjs` with `FORWARD_COMPAT_REF=<last deployed commit>`, `node --test scripts/docs-delivery-coverage.test.mjs`, and `DELIVERY_SCHEMA_VERSION` bumped when the batch adds delivery data.
