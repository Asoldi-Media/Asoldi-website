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
| Legal texts | `lib/legal/`, routes in `lib/routes/legal-routes.js`, [legal-texts.md](legal-texts.md) | in place, off (`legal.catalogTexts.enabled`) |
| Delivery gate | `lib/delivery-gate.js`, `lib/site-plan-requirements.js`, `lib/page-kind-requirements.js`, routes in `lib/routes/gate-routes.js`, `scripts/eval/gate-f1.mjs` | in place, off (`gate.enabled`) |
| Post-workshop mail and data reminders | `lib/delivery-emails.js` | in place, off (they need the gate) |
| Delivery loop and Maker jobs | `lib/delivery-loop.js`, `lib/delivery-steps.js`, `lib/delivery-jobs.js`, `lib/delivery-alerts.js`, routes in `lib/routes/delivery-jobs-routes.js` | in place, off (`delivery.loop`, see [Delivery loop and Maker jobs](#delivery-loop-and-maker-jobs)) |
| Signing | `lib/contract-signing.js`, `lib/site-plan-apply.js`, `lib/golive-callback.js`, routes in `lib/routes/signing-routes.js`, card `app/pages/Admin/sections/SalesPlanCard.tsx` | in place, off (`signing`, see [Signing](#signing)) |

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

- **Blog on every tier.** Clients write posts on every tier (CMS features `blog` and `blog.posts`). Auto-written posts (CMS feature `blog.autoPosts`; the older name `blog.localPosts` is read as an alias) come with the `seo` service only, so tier 2 and up (`SERVICE_FEATURE_ANCHORS`, `SERVICE_EXCLUSIVE_FEATURES`, `exclusiveServicesFor`, `FEATURE_KEY_ALIASES`; vocabulary version 2). The CMS `blog` bundle does not entitle `blog.autoPosts`, and the CMS must not treat the legacy `features.blog` flag (on for tier 1 now) as permission to pull auto posts. The hub's local-blog brief already gates on the service: `GET /api/hub/local-blog-brief` returns `blogEnabled: true` only when `features.blog` is on **and** the site has the `seo` service (`localBlogAutoPostsEnabled` in `lib/local-blog-brief.js`: `planSource.services` when it lists any, otherwise the tier's services, and for a `custom` plan the `analytics` flag). The CMS local-blog job skips when `blogEnabled` is false, so a tier-1 or site-only site never gets automatic posts, whatever the legacy flag says.
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

**Maker handoff (contract `site-plan/1`).** `create-maker-run` adds `sitePlan` to the Maker request body when the client has a plan in force: `makerSitePlanPayload` gives `SITE_PLAN_HANDOFF_FIELDS` (schema, status, tier, services, pages, add-ons, billing, catalog type, languages, `changesPerMonth`, source, offer reference, `signedAt`, `needsConfirmation`, the 7 flags from the services and a `planHash`). The Maker treats a plan as known only with `source` and `signedAt`. Clients without a plan send the same body as before. For a client the signing switch runs in auto, a `void` or `ended` plan is sent too, with that status, so the Maker stops treating it as in force.

---

## Signing

One signer, `markContractSigned(clientId, {source, offerId, alternativeIndex, actor})` in `lib/contract-signing.js`, for every signing path: portal accept (`portal-accept`), the preview's contract accept (`preview-accept`), the Kontrakt tick on the sales card (`progression`), the signed contract from e-mail (`inbox-contract`, through `markClientSoldFromSignedContract`), got-client (`got-client`) and a Stripe checkout for an accepted offer (`stripe-checkout`).

**Switch.** `signing` (`signing.enabled`, `signing.mode`, `signing.paused`; default `{enabled: false, mode: 'shadow', paused: null}`). It is release-gated, and validation refuses `auto` while `pilotClientIds` is empty. Per client the mode comes from `spineModeForClient('signing', client)` (`lib/spine-mode.js`): `auto` reaches pilot clients only; every other client runs in shadow; a paused switch runs in shadow; a test client that is not a pilot runs as off.

- **off**: every path runs exactly as before. Responses, mails, `/api/hub/site-config` and the data folder are the same as without this code; the plan routes answer 404 `{code: 'disabled'}` and the sales card shows nothing new.
- **shadow**: every path runs as before, plus a `signing-shadow` line in the delivery audit log and `client.delivery.sitePlanShadow` (tier, services, offer, whether a hub site would be created). No `sitePlan`, hub site or `planSource` is written, and entitlements never read the shadow plan.
- **auto**: the signer runs under the lease `sign:<clientId>` (`acquireLease`, 30 s, renewed every 10 s while the signer works, so a slow mail or hook keeps it; a second process waits and then finds the client signed).

The shadow record never throws into the path around it, and a Superadmin site edit is saved whatever the plan-source step does.

**What the signer does (auto).**

1. A non-website product (SSU) gets only the signing stamp (`setSalesProgress`): no plan, site or mail.
2. A client already signed with a plan: an accepted offer that differs from the plan's offer or alternative becomes the plan (`offer-upgrade`, re-applied to the hub site, no mail); the same offer only makes sure the plan is applied. When the apply is refused (a site that belongs to another client), the result carries the warning `plan-apply:site-owned-elsewhere`, on a repeated call as on the first.
3. The plan comes from the offer the path names, else the newest sent offer, else the resolver's evidence; on got-client a tier in the body counts only for a superadmin. A dual offer without a chosen alternative returns `needsChoice` (409, with the two `alternatives`) and changes nothing; on the e-mail and Stripe paths, where nobody can be asked, a `signing-needs-choice` line in the delivery audit log and the server log say why the client is not signed, and the rep gets the next action "Velg tilbudsalternativ" (closed by the signing). The Kontrakt tick and got-client take `chosenOfferIndex` in the body.
4. `setSalesProgress('contractSigned')`: `contractSignedAt` and the Informasjon action. Fast track (the meeting and offer steps are ticked with it) on the e-mail, portal, preview, got-client and Stripe paths, as before the switch, and on the Kontrakt tick when a sent offer proves the meeting and the offer or the request asks for it.
5. `client.sitePlan` (status `active`, the path as `source`), then `applySitePlanToHub`, then the delivery stage (`signed`).
6. The accepted alternative's `dpaVersion` is copied to `client.ext.dpa.offerVersion`.
7. One pre-workshop mail (`sendPreWorkshopAfterContractSigned`; with `emails.preWorkshop.lines` set to `gate` and the gate module present, its `askableLines`), then the stage again (`gathering`). An optional SEO hook freezes the agreed keywords when `lib/seo-ops/record.js` exists.
8. A `signing` line in the delivery audit log.

**Apply to the hub (`applySitePlanToHub`, `lib/site-plan-apply.js`).** Finds the client's site by site key, then the linked site id, then the domain, or creates one (`deliveryPhase: 'development'`, a generated site key). It writes `websitePlan`, the catalog type and `planSource {kind: 'offer', salesClientId, offerId, alternativeIndex, tierId, services, billing, catalogType, derivedFeatures, appliedAt, appliedBy}` (`kind: 'admin'` for a superadmin's tier), links the site on the client (`hubSite`, `portalTierId`) and stamps `sitePlan.appliedAt` / `appliedSiteId`. Legacy flags: the first apply writes the plan's flags; a later apply writes them only when the plan changed and keeps every flag that differs from the previous plan's flags (a change made by hand); a site with a `featureSpec` gets no feature write. An unchanged plan writes nothing. A stored legacy string `planSource` is read as `{kind}`. A site the apply creates records `planSource.siteCreatedBy`. A site belongs to the client its `planSource` names; without one, to the only client whose hub link holds its key or id (`siteOwnerId`). Every match is checked, also one through the client's own link, since a link may have been copied from another client (an older got-client wrote the other client's key, id and domain for a lead with the same domain). A site found that belongs to another client, or that two clients link while its `planSource` names neither, is left alone for every claimant: the apply returns `site-owned-elsewhere`, writes a `site-owner-conflict` audit line and opens one `site_owner_conflict` task in the client's `delivery.tasks`, and readers (`findSiteForClient`) do not return that site. Got-client in auto takes its site only from `siteForGotClient` (the signer's site, the client's own site, or a new bare one when there is none), never from the old key or domain lookup, and under the client's signing lease, so it answers 409 `{code: 'site-owned-elsewhere'}` with the signed client and links no site on every call, retries included.

**Portal tier (auto).** Publish to the portal, connect-portal and the accept of a dual offer take the tier from the offer itself (`planFromOfferAlternative`; a custom plan maps to the smallest standard tier that covers its services), never from an older offer, the meeting quote or `portalTierId`. A tier-1 client who accepts a tier-2 offer gets tier 2.

**Entitlements (auto).** `lib/cms-entitlements.js` reads the linked client's `sitePlan` only while it is `active`, and for a site only when the plan was applied to that site (`sitePlan.appliedSiteId`), so a client whose link was copied from another client's site never gives that site its plan; for every other client the stored plan counts as before.

**Superadmin plan edit (auto).** A `websitePlan` change through `PUT /api/hub/sites/:id` on a site that belongs to an auto client (`siteOwnerId`) sets `planSource.kind` to `admin` with the new tier's services. A site two clients link, with no client in its `planSource`, gets no `planSource`.

**Stripe.** `checkout.session.completed` signs only when the session metadata carries `offerId` and `contractHash` (`offerContentHash`) of an offer of that client. Otherwise the payment is recorded as before and the rep gets the next action "Mangler tilbudsaksept"; for a client already signed on another tier the plan gets an open conflict (`source: 'stripe'`). The portal checkout does not put `offerId` or `contractHash` in the session metadata yet, so today a card payment never signs; the offer acceptance in the portal or the preview signs.

**Sales card.** `SalesPlanCard` (mounted once in the sales client form) shows the plan, its services, history and open conflicts, the shadow plan in shadow, and "Bekreft tjenester" for a derived plan or one that needs confirmation (Superadmin, auto). For an auto client not yet signed whose offer has two alternatives and none chosen, the view carries `choice` (`pendingSigningChoice`: both alternatives, and whether a contract or payment is waiting), and the card marks the contract signed with the alternative the rep picks (the Kontrakt tick with `chosenOfferIndex`). Open `site_owner_conflict` tasks show as a banner (`siteConflicts`), without naming the other client. It changes no tier of a signed plan and undoes no signing. Routes: `GET /api/admin/sales/:id/site-plan`, `POST /api/admin/sales/:id/site-plan/confirm`.

**Go-live callback, schema 2.** The Maker's `run.golive.updated` carries `schema: 2`, `target` (`staging` or `production`), `status` and `liveVerifiedAt` on top of the old fields (the old `ready` reads as `pushed`; statuses: `pushed`, `deploying`, `needs_import`, `deploy_failed`, `verify_failed`, `live`, `failed`). It reports status only; plan and feature fields in it are ignored. With the switch off, or without `schema: 2`, the callback is handled as before. Otherwise the hub stores `makerRun.goLive` (the newest record per target; a staging record never hides a production one, and a later production push keeps `liveVerifiedAt`), opens a `needs_import` task in `delivery.tasks` (closed by a later push or live status), and in auto sets `progression.live` and `domainConnected` only for a verified production `live` (through `setSalesProgress`, so the next actions tied to those goals close), and creates a missing hub site from the plan (`applySitePlanToHub`) instead of a bare one. In auto, a site the signer made with a key of the hub's own takes the Maker's key (`adoptSiteKey`, one locked write, a `site-key-adopted` audit line, the client link follows) while no client CMS has reported for it and it has no site credential; a site a CMS has reached keeps its key, and the Maker's key is flagged (`goLive.siteKeyMismatch` and a `site_key_mismatch` task). The callback's domain fills in a linked site that has none. In shadow only a pushed status links a site, as before. Today the Maker sends only `ready` and `failed`, with `target: 'production'` and an empty `liveVerifiedAt`; the hub reads `needs_import`, staging records and a verified `live`, but no Maker sends them yet, and the staging domain is kept only in `goLive`. Shared fixtures: `scripts/fixtures/golive-callback/` (the same files in the Maker).

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

### Evaluation

**Switch.** `gate` in the automation settings: `gate.enabled` (default `false`) and `gate.mode` (`shadow`; `auto` is refused for now), plus `gate.paused`. Every per-client decision goes through `spineModeForClient('gate', client)`. Off: nothing is evaluated, stored, shown or mailed, every gate route answers 404 `{code:'disabled'}`, the developer panel is hidden, and the pre-workshop and desk mails are exactly as before. Shadow: the lines are computed and shown to developers; the tick writes only delivery-audit rows; mails that would use the lines are recorded as shadow mails and never sent, while today's mails go out unchanged beside them, and the desk's manual mails keep today's lines. Paused: the views answer, every gate write answers 409 `{code:'paused'}` and nothing is written.

**Inputs.** `evaluateDeliveryGate(client, inputs)` is pure (no network, no writes). `gatherGateInputs(client)` reads stored data only: the Kundedata bank, the Maker materials snapshot of the linked run (`makerRun.materials`, any age), the inbox bot's filed and staged items, assistant skips (`bank.assistantIntake`, recorded as `declined`), the stored payment connections (`readStoredShopConnections`, no Stripe or PayPal call) and the page kinds. When their modules are present it also reads the delivery brief facts, the agreed keywords and the DPA status; `dpa-missing` appears only then. The default portal colours, opening hours and language of a new bank are never evidence.

**Statuses.** A line is `have` when there is evidence, else `waived` when a developer waived it, else `declined` when the client skipped it in the assistant, else `missing`. `missingDev` lists the required dev lines that are `missing` or `declined`; `missingReady` the same for the ready column. A line whose dev column is not required is a ready line (`gate: 'ready'`): tier-3 `shipping` never blocks development. `passed` is `devComplete` or an admin approval.

**Stored result.** `client.delivery.gate`: `{version, evaluatedAt, inputHash, inputs, tierId, services, devComplete, readyComplete, passed, missingDev, missingReady, approvedBy, approvedAt, note, waivers, lines, info}`. It is written by the tick only when the gate and the loop are both auto for the client; while the gate is in shadow only a person's action in the gate panel writes it (evaluate, waive, approve). The stage board of the deployed hub reads it: a stored gate with `devComplete` or an approval moves a client from `workshop_held` to `gate`, and a missing `payment` line shows `needs-payment-setup` on a staging site. Waivers, the approval and the note are kept across evaluations, also when one is stored while an evaluation is running. A waiver can carry a build directive ("Fjern teamsiden" gives `{action:'remove', pageKind:'team'}`; see `gateDirectives(gate)`).

**What changes while `gate.enabled` is true (also in shadow).** No mail reaches the transport that would not without the gate, but these data writes happen, and the deployed stage board reads some of them:
- A person's action in the gate panel (evaluate, waive, approve) stores `client.delivery.gate` (see above).
- Applying the first Prosjektdokument stores `delivery.emails.postWorkshopDueAt`. For a client without `client.delivery` that creates it, so the developer board starts showing a delivery stage for the client.
- `POST /api/admin/sales/:id/workshop/held` stores `workshop.heldAt` when it is missing, which moves the derived stage to `workshop_held` (or `gate` with a passed gate), and stores the due time.
- A change to a site's stored payment connection bumps `site.shopConnectionRev` and stores `delivery.dirtyAt` on the linked clients in delivery.
- Shadow mails are written to `<dataDir>/outbox` (channel `delivery-shadow`), keyed in `<dataDir>/delivery-email-shadow.json`, and listed in the delivery audit.

**Tick steps.** `lib/delivery-gate.js` exports `tickSteps` `[{name:'gate', scope:'client'}]`: with the gate and the loop both auto for the client it stores the gate when the input hash changed; otherwise it writes one delivery-audit record (`gate-shadow`) per input hash. The hash covers exactly the fields the evaluators read. A change to a site's stored payment connection bumps `site.shopConnectionRev` and marks the linked clients dirty while the gate is enabled, so the next tick re-evaluates the `payment` line. That line is `have` only when the shop can take payment, by the rule of the CMS payment status: Stripe once charges are enabled, PayPal once a payee is set and payments are receivable (or the payee is an email). Starting the Stripe onboarding is not enough.

**Page kinds.** From `makerRun.materials.pageKinds` when the run reported them, otherwise from the offer's page names, otherwise from the wanted pages in Kundedata (`pageKindFromLabel`).

**Askable lines.** `askableLines(gate, {max: 12})`: askable and `missing` lines only (never `declined`, `waived` or `have`), required dev lines first, then required ready lines, then optional ones, grouped as Merke, Innhold, Kontakt, Bilder, Nettbutikk and Synlighet. `gateMailRows` adds one row under Bilder for template pictures still on the site ("Vi bruker fortsatt 7 eksempelbilder, blant annet på /portfolio").

**Routes** (developer or admin token; 404 `{code:'disabled'}` while the switch is off): `GET /api/admin/delivery/gate` (clients in delivery with their stored gate), `GET /api/admin/delivery/gate/:clientId` (evaluated now, nothing written; for admins also the client's shadow mails with their text), `POST /api/admin/delivery/gate/:clientId/evaluate` (work access to the client), `PUT` and `DELETE /api/admin/delivery/gate/:clientId/waivers/:lineId` (`{option, reason}`; work access to the client), `POST /api/admin/delivery/gate/:clientId/approve` (admin), `POST /api/admin/sales/:id/workshop/held` (`{startedAt, endedAt, durationMinutes}`, optional ISO times that are not in the future and 1-600 minutes, otherwise 400; admin; answers the stored `heldAt`). Every write answers 409 while the gate is paused.

**Labels.** `scripts/eval/gate-f1.mjs <dir>` scores the gate against `gate-expected.json` label files (precision, recall and F1 per line; exit 1 below 0.9, and also when no client was scored or a label has no gate to score). The labels are derived from fixture facts, never written by hand; `scripts/fixtures/gate-labels/` holds the synthetic clients with neutral inputs.

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

**Gate mails** (only while the gate runs for the client):
- With `emails.preWorkshop.lines` set to `gate`, the pre-workshop mail on signing lists the gate's askable lines, grouped. The desk's Datainnsamling mails go through the real transport, so they use the gate's lines only once the pre-workshop mail is auto for the client (the gate and `emails.preWorkshop` both auto, which needs the pilot list); with the gate in shadow they keep today's lines. On this path the Reply-To becomes the rep's mailbox only when it is in `INBOX_MAILBOX_ALLOWLIST` and in `inbox.mailboxes` (so the inbox bot files the reply); otherwise today's Reply-To stays. The gate's version replaces today's mail only when the pre-workshop mail is auto for the client. In every other case, including a client that is not a pilot while the gate is auto for pilots, today's pre-workshop mail and workshop confirmation go out exactly as before (today's lines, sender and Reply-To, and only when `emails.preWorkshop` itself is auto). With the gate in shadow the gate's version is also written to the outbox as a shadow record (channel `delivery-shadow`, once per signing) with a delivery-audit row; it never reaches the mail transport, touches no calendar event and stamps nothing.
- **Post-workshop.** When the first Prosjektdokument sets `workshop.heldAt` (the end is the stored recording's `startedAt` plus `durationMinutes`, else the booked time plus the standard length), or on `POST .../workshop/held`, `delivery.emails.postWorkshopDueAt` is set to the workshop's end plus `emails.postWorkshop.delayMinutes` (120): a 10:00-11:00 workshop is due at 13:00. The `post-workshop` tick step sends (auto) or records (shadow) the mail once after that time; the ready variant goes to a client whose gate is complete. The time is stored, so a restart loses nothing. A due time more than 24 hours in the past when it is scheduled (a recording linked days after the workshop) is not stored (`reason: 'stale'`), so no thank-you goes out days late. With `emails.postWorkshop` off nothing is drafted. The desk kind `post-workshop` (`POST /api/admin/sales/:id/workshop/desk-email`, admin) follows the same mode: off or paused answers 409 `{code:'off'|'paused'}` and writes nothing; shadow records a shadow mail and sends nothing (once per client; `{force: true}` records a fresh one); only auto sends it at once and stamps it. Once it was sent the route answers 409 `{code:'already-sent'}` unless `force` is true, and two presses at once send once.
- **Data reminders.** The `data-reminder` step sends a Datainnsamling reminder `emails.dataReminder.afterDays` after the post-workshop mail (or the last reminder) while askable lines remain, at most `emails.dataReminder.max` times. It counts only from a post-workshop mail this flow scheduled or sent, never from a stamp the backfill wrote (`delivery.emails.backfilled`).
- Both steps skip a client that is cancelled or paused, or whose stage is past `developing`.
- A mail is `auto` only when the gate, its email kind and (in the loop) the delivery loop are all auto for the client; anything less is a shadow record.

---

## Switches

`GET/PUT /api/admin/automation-settings` (Superadmin). PUT takes a partial object (deep-merged) or `{settings, reason}`. Every `paused` object and `releases` replace as a whole. The per-mailbox maps (`inbox.autoActions`, `inbox.autoReply`) merge per mailbox and always hold exactly one entry per listed mailbox: a PUT that names one mailbox leaves the others as they were, a newly listed mailbox starts at `false`, and removing a mailbox from `inbox.mailboxes` drops its entries; an entry sent for a mailbox that is not listed is an error; invalid input returns 400 with `errors[{path, message}]`. Every change is audited (last 50: who, when, what, why).

**Modes.** Each email kind has `enabled`, `mode` and `paused`:

- `shadow`: the internal pre-release stage. The system computes and records what it would send; nothing is sent. (`approve` and `manual` are accepted as old names for `shadow`.)
- `auto`: sends, guarded.
- Effective state (`EFFECTIVE_MODES`): `off` (not enabled), `shadow`, `paused`, `auto`.

**Pre-release gate.** Release-gated switches (`RELEASE_GATED_SWITCHES`: every non-legacy email kind, `emails.preWorkshop.gate` for gate lines in the pre-workshop mail, `development.autoQueue`, `publish.staging`, `publish.production`, `signing`) can only be set to `auto` after the pre-release suite (golden clients, safe-mode outbox snapshots, the canary site) recorded a pass with `recordReleasePass`. A PUT cannot write `releases`. With `promotion.auto` on, a recorded pass promotes the switch to `auto` in the same write.

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
| Fireflies | `fireflies.candidateRanker.enabled` (default off; it ranks candidates and never links), `fireflies.candidateRanker.candidateMinScore`, `fireflies.autoLink.enabled`, `fireflies.autoLink.requireExactAttendeeEmail`, `fireflies.autoLink.slotWindowMinutes` |
| Development | `development.autoQueue`, `development.directivesForAutoDev`, `development.defaultHostId`, `development.requireConfirmForCustom`, `development.previewJobs`, `development.seoJobs`, `development.makerEvents` (`off` or `record`; default `off`, see [Maker events](#maker-events)) |
| Migrations | `migrations.deliveryBackfill` (`off`, `dry-run` or `apply`; default `off`, see [Backfill](#backfill)) |
| Publish | `publish.staging.mode`, `publish.staging.tiers`, `publish.production.mode` |
| Change requests | `changeRequests.enforce`, `changeRequests.slaWorkDays`, `changeRequests.countAt` (counted at acceptance) |
| Pricing | `pricing.oneTimeMultiplier`, `pricing.oneTimeMinExMva`, `pricing.oneTimeMonths` |
| Lifecycle | `lifecycle.paymentGraceDays`, `lifecycle.cancellationGraceDays` |
| Promotion | `promotion.auto` |
| Guards | `guards.errorRatePct`, `guards.bounceRatePct`, `guards.complaintsMax`, `guards.volumeSpikeFactor`, `guards.windowHours`, `guards.minSample` |
| Retention | `retention.leadMonths`, `retention.afterContractMonths`, `retention.briefOldVersionsDays`, `retention.changeRequestsMonths`, `retention.nurtureProofYears`, `retention.inboxSkipLogDays` |
| Privacy | `privacy.archive.enabled` (transcript archive on link; default off), `privacy.purge.enabled` (daily retention step and the erase route; default off), `privacy.purge.mode` (`shadow` writes only a would-purge report, `auto` deletes; default `shadow`). See [privacy-processing-record.md](privacy-processing-record.md). |
| Media | `media.signedUrls.enabled` (media manifest and signed downloads; default off), `media.rightsConfirm.enabled` (per-upload rights checkbox in the portal; default off) |
| Storage | `storage.budgetFiles`, `storage.budgetMb` |
| Alerts | `alerts.to`, `alerts.hostOfflineHours`, `alerts.jobBlockedHours`, `alerts.digestAt` |
| Legal texts | `legal.catalogTexts.enabled` (default `false`; see [legal-texts.md](legal-texts.md)) |
| SEO | `seo.jobGating.enabled`, `seo.jobGating.mode` (`shadow` or `auto`; default off, see [SEO record, job gating and the DataForSEO ledger](seo-record.md)), `seo.dfsLedger.enabled` (default off), `seo.recordPull.enabled` (default off); `seo.jobGating.paused`, `seo.dfsLedger.paused`, `seo.recordPull.paused` (`null` or `{reason}`; a paused switch counts as off) |
| Delivery loop | `delivery.loop.enabled` (default `false`), `delivery.loop.mode` (`shadow` or `auto`; `auto` needs at least one client in `pilotClientIds`), `delivery.loop.paused` (null or `{reason}`); see [Delivery loop and Maker jobs](#delivery-loop-and-maker-jobs) |
| Gate | `gate.enabled` (default `false`), `gate.mode` (`shadow` only for now), `gate.paused` (see [Gate](#gate)) |
| Signing | `signing.enabled`, `signing.mode` (`shadow` or `auto`; `auto` needs pilots), `signing.paused` (see [Signing](#signing)) |

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

## Delivery loop and Maker jobs

**The loop** (`lib/delivery-loop.js`) ticks every 60 s from the background plan (job `delivery`, on in safe mode too; its mail goes to the outbox there). It does nothing at all while `delivery.loop.enabled` is `false`: no lease, no file read beyond the settings, no write.

- **Scope.** Signed website clients, clients a fact change marked dirty (`markDirty(clientId)`, kept in `<dataDir>/delivery-hot/loop-dirty.json`), and clients in an active nurture.
- **Modes.** Per client the mode is `spineModeForClient('delivery.loop', client)` (`lib/spine-mode.js`): `auto` only for clients in `pilotClientIds`, `shadow` for everyone else, also while the pilot list is empty. In `shadow` a step writes delivery-audit records only (`kind: loop-shadow`), and only when its outcome for the client changed. With `delivery.loop.paused` set only the alert step runs, and Makers get no job (see the job queue below).
- **Steps.** A module plugs in by exporting `tickSteps = [{name, order, scope: 'client' | 'global', everyMs?, whenPaused?, run(ctx, client?)}]`. `lib/delivery-steps.js` imports a fixed list of modules when they exist (the gate, the brief, retention, the job queue, delivery emails, alerts, the SEO record), so a build without one simply has no such step. The loop's own steps: `stage` (order 80) stores the derived stage for auto clients in one write, and `phases` (order 90) runs the hub-site phase reconcile and the open-client owner rule for auto clients. For every other client the development board GET keeps doing both, exactly as before. The one-time owner seed stays in the GET for every client; until it has run, the loop gives its auto clients the same seed without marking it done.
- **Safety.** Each tick holds the lease `delivery-loop` (90 s, renewed every 30 s while the tick runs, so a slow step keeps it), so two hub processes on one data dir never tick together. A tick whose lease cannot be renewed stops after the step or client it is on and stores nothing more. Dirty marks and step schedules (`everyMs`) live in `delivery-hot/` and survive a restart; a dirty mark is cleared only after every step ran for the client without an error. A tick that changes nothing writes nothing (only the lease lock files change).
- **Health.** `delivery-hot/loop-health.json` (written at most every 5 minutes) holds the last tick, per-step timings, write flags and the last errors; Maker heartbeats return its `lastTickAt` as `hubLoopLastTickAt`. `GET /api/admin/system/delivery-loop` shows the live health, the registered steps, the dirty count, job counts and file counts and bytes per top-level store of the data dir (an async scan, at most one a minute; an older report is shown while a new one runs). In safe mode `POST /api/admin/system/delivery-loop/tick {now}` runs one tick on a given clock (404 everywhere else).

**The job queue** (`lib/delivery-jobs.js`, `<dataDir>/delivery-jobs.json`, written in place with no stamped backups, plus one dated copy a day in `snapshots/delivery-jobs/`, 7 kept):

- `enqueueJob` checks the kind (`assertJobKind`) and keeps one active job per client and kind. Behind the switches (`requestJob`): `delivery.loop` on, the kind switch on (`development.previewJobs` for `preview`, `development.seoJobs` for `seo.*`) and the client in `auto`; a `shadow` client gets an audit record and no job.
- **Only auto clients get work.** A job is offered and can be claimed only while its client runs in `auto`. While the loop is paused, in `shadow`, or the client is no longer a pilot, `GET /api/maker/jobs` lists nothing for it, a claim gets 409 `paused` or `not-auto`, the job stays queued and the client record is not written. A job already running gets `stop: 'paused' | 'not-auto'` in its heartbeat answer; the Maker cancels the pipeline steps it queued that have not started and fails the job as retryable, so it waits in the queue. Heartbeat, complete and fail keep working for claimed jobs; while the client is not in `auto` they record the status change in the delivery audit and leave the client record alone.
- **Routing.** The host that reports the client's run; with two, the handoff owner's host, then the most recently seen; else the host owned by the client's developer; else `development.defaultHostId`; else the first capable host that claims it. A job is offered only to a host whose heartbeat lists its kind in `capabilities.handlers`. An accepted developer handoff moves queued jobs to the new developer's host.
- **Pull API** (host token with the `jobs` scope; 404 `{code: 'disabled'}` while the loop is off): `GET /api/maker/jobs`, `POST /api/maker/jobs/:id/claim` (10-minute lease; 409 when taken), `POST …/heartbeat {progress, log}` (extends the lease; the last 50 log lines are kept), `POST …/complete {result, warnings}` (local and private-network URLs are removed from the result), `POST …/fail {error, blocking, retryable}` (a blocking code blocks; otherwise retries wait 5, 15, then 45 minutes until `maxAttempts`, default 4). The tick step `jobs-requeue-stale` returns jobs whose lease ran out. `client.delivery.job` mirrors a job only when its status changes: for a Maker report or a loop step only while the client is in `auto`, for an admin cancel or retry always.
- **Link-run.** `POST /api/maker/clients/:id/link-run {runId}` links a run to a client that has none, only for a run the calling host reports in its heartbeat and only when a job for the client is routed to that host. A linked run is never replaced (409 `already-linked`).
- **Developers.** `GET /api/admin/delivery/jobs?clientId=` (switch state, the client's mode, its jobs), `POST /api/admin/delivery/jobs {salesClientId, kind: 'preview'}` (the "Send preview-jobb til Maker" button on the developer card, shown only with `development.previewJobs` on and the client in `auto`), `POST /api/admin/delivery/jobs/:jobId/cancel` (an active, blocked or failed job; cancelling a failed job ends its `job-blocked` alert) and `/retry`. The existing "Create run" button is unchanged.
- **Hub capabilities.** While the loop is on, in `auto` with pilots and not paused, the heartbeat answer lists `delivery-jobs/1`; otherwise Makers do not poll for jobs.
- **Language.** A preview job for a client without a linked run carries the site language (the request's, else the client's, its run's or its site plan's first language); the Maker refuses to create a run without one (`needs-language`).

**Alerts** (`lib/delivery-alerts.js`, step `alerts`, also while paused): a Maker host with work routed to it unseen for more than `alerts.hostOfflineHours`; a job blocked or failed for more than `alerts.jobBlockedHours`; more than 15 minutes since the previous successful tick (so the first tick after an outage reports it; a success from before the loop was last off or switched on does not count); a step error in the last 15 minutes; more than 30 refused Maker requests in 10 minutes; a paused switch. A new alert mails `alerts.to` once (not again for the same alert within 6 hours, also when the alert state cannot be written) and a daily digest of the active alerts goes out after `alerts.digestAt` (Oslo time) unless every active alert was already mailed on its own that day after that time, only while the loop is configured for `auto`; in `shadow` alerts are recorded in `delivery-hot/alerts.json` and shown, never mailed. `GET /api/admin/system/delivery-alerts` lists the active, recent and live alerts.

---

## Maker events

The Maker posts `run.materials.updated` and `run.autopilot.updated` (`MAKER_DELIVERY_EVENTS`) to the existing status callback (`POST /api/admin/sales/maker-status-callback`, same callback auth, same run-link check). With `development.makerEvents` set to `record` the hub stores them on the client: `makerRun.materials` (logo present, upload counts per field, totals, product and catalog counts, domain, latest ready step, custom-site edits, `pageKinds` as route and kind, `step1Qa`, a `siteIntelSummary` of at most 2 KB and the branding `needs` items) and `makerRun.autopilot` (`phase`, `status`, `blocked`, `at`), each with the `runId` the callback was checked against, and sets `delivery.dirtyAt` so the gate is checked again (only for signed website clients or clients with a plan in force; leads get no delivery record). A payload without any material field (for example `materials: {}`) is ignored and never replaces a stored snapshot. Every address in the payload is dropped, in values and in object keys: any `scheme:` that addresses something (`https:`, `mailto:`, `data:`, ...) or is followed by `/`, `//host`, host names with a port or a path (`cdn.example.no/x`, `host.example:3000`), IPv4 and IPv6 literals, `localhost` and Docker host names, backslash and UNC paths, `www.*`, and Maker or upload file paths (`/api/...`, `/uploads/...`, `/runs/...`, paths ending in a file extension other than `.html`, `.htm` or `.php`); page routes must start with `/`. Only the callback's recorder writes these keys (`setSalesMakerRunOwned`); a set-maker-run body or a generic update cannot. With the switch `off` (the default) these events take the old step-status path, exactly as before.

For the material dots and the workshop need-list the live Maker run fetch comes first (it carries the answers). When it fails and the switch is `record`, a materials snapshot of the run linked now (same `runId`) younger than 24 hours (`MATERIALS_SNAPSHOT_MAX_AGE_MS`) stands in for it (upload counts, logo, domain; text points then come from Kundedata, as they did when the fetch failed without a snapshot). `materialsPageKinds` and `materialsOpenNeeds` hand the page kinds and open placeholder slots to the gate and the missing-info emails (later batches).

---

## Backfill

`lib/delivery-backfill.js` gives existing clients the delivery data later batches rely on, in three idempotent steps:

1. **Site plans** (`scripts/backfill-site-plans.mjs`): `client.sitePlan` with source `backfill` for signed website clients from the resolver's evidence. SSU clients are skipped; dual offers without a chosen alternative (`needsChoice`) and clients without evidence are listed, not written.
2. **Plan source** (`scripts/backfill-plan-source.mjs`): `planSource {kind: 'backfill', salesClientId, tierId, derivedFeatures}` on hub sites linked to a sales client. `websitePlan` and the live flags are not touched and the planSource lists no services, so the automatic-post check keeps reading the site's tier; differences between the plan's flags and the live flags are reported as warnings (tier 1 shows `blog`, the owner decision).
3. **Delivery stage** (`scripts/backfill-delivery-stage.mjs`): the derived stage for signed website clients, and email stamps (with the legacy mirror, listed in `delivery.emails.backfilled`) for clients whose stage is strictly past the last stage at which that email can still be due (`PRESTAMP_AFTER_STAGE`: pre-workshop after `gathering`, post-workshop after `gate`, preview-ready after `client_preview`, staging-ready after `publishing`, site-live after `live`, or at `live` for legacy live clients). So no new email kind goes to a client past it, and an email that is still due (for example the pre-workshop email of a client in `gathering` with a booked workshop) is never marked as sent. `progression.live` and `domainConnected` are never written.

Every run plans first. `dry-run` (the default of `node scripts/backfill-delivery.mjs`, the per-step scripts and `POST /api/admin/system/delivery-backfill`) writes only the report; `apply` (`--apply`, `{dryRun:false}`) takes a delivery snapshot, applies, and plans again to prove nothing is left. Reports (ids, tiers, counts; no names) go to `<dataDir>/migrations/delivery-backfill-<time>-<mode>.json`, the newest 10 are kept, and `GET /api/admin/system/delivery-backfill` lists them. At boot the backfill runs only when `migrations.deliveryBackfill` is `dry-run` or `apply`; an unchanged report is not written again. **A boot apply is one-time:** every apply (route, script or boot) is recorded as `lastApply` in `<dataDir>/migrations/delivery-backfill-state.json` with the delivery schema version, and a boot in `apply` mode skips the run while an apply is recorded for the current schema version, so restarts never re-plan or pre-stamp clients that moved on since. Set the switch back to `off` after the apply. Only an apply that changed something adds a line to the delivery audit log; dry runs write only their report. The backfill sends no email and makes no external call.

---

## Delivery brief

One versioned brief per client (`asoldi.delivery-brief/1`, schema in `scripts/schemas/delivery-brief.schema.json`, pinned by hash in `lib/delivery-brief/facts-contract.js`) that tells the Maker and the developer what was sold and what the client asked for. Code: `lib/delivery-brief/`, routes in `lib/routes/brief-routes.js`.

**Switch.** `brief.enabled` (default `false`) and `brief.mode` (`shadow` or `auto`; default `shadow`), resolved per client with `spineModeForClient('brief', client)`:

- off: nothing is built and every brief route answers 404 `{code:'brief-disabled'}` before any other check, so no log line or file is written.
- `shadow`: briefs are built and stored, and the developer board can read and review them. The Maker routes answer 404 `{code:'brief-disabled'}`.
- `auto`: the Maker can also fetch the brief and transcripts, but only for clients in `pilotClientIds`; every other client stays in shadow. A PUT refuses `auto` while `pilotClientIds` is empty, and `brief` is release-gated (`RELEASE_GATED_SWITCHES`), so `auto` also needs a recorded pre-release pass.

**How a brief is built.**

1. Inputs (`sources.js`): the plan in force, the newest offer, client data from the portal (Kundedata, including product catalogs), the Prosjektdokument todos, the linked meetings' transcripts (from the transcript archive when the build has one, else the stored Fireflies meetings), and, when the build has them, the gate snapshot, the media manifest, the agreed keywords and the CMS setup. Site keys and other credentials never go into a brief, at any depth of the CMS setup (lists included). A field counts as a credential by its name: tokens, secrets, passwords, credentials and keys named for what they open (`apiKey`, `siteKey`, `secret_key`, `x-api-key`, `privateKey`, ...); a bare `key` (a feature's id), `keywords` or `primaryKey` stays.
   - Live captions are never a transcript: a meeting whose stored Fireflies copy is still live, or partial without a final summary (`storedMeetingIsPartial`), is left out, and so is the archive's copy of it, until the final copy arrives. The Maker's transcript route never serves such a copy either. Once the stored copy is final, it wins over an archived copy of the same meeting with other text (the archive may still hold the captions it copied when the meeting was linked, without their live flags, until its next sync); that archived copy is then not served either. An archived copy is used when the stored copy is gone or has the same text.
   - The media manifest is read with `buildMediaManifest(clientId, { client, dataDir })` (the manifest's `name` is the file name; URL signatures are left out of the brief and its hash; `rightsConfirmed` is true or false as the client answered and absent while unanswered), and only while the media switch (`media.signedUrls`) is on, because building the manifest writes its id index. The loop builds it at most once per client per 10 minutes.
   - Agreed keywords come from the SEO record (`readSeoRecord(clientId).agreedKeywords`, phrase and status; else the approved phrases of `agreedKeywordsFor(clientId)`), else from the sales card. Only approved and blocked rows go into a brief, as in the record's Maker view; proposals stay out.
2. Map (`chunk.js`, `extract.js`): each transcript is cut into chunks of at most 9,000 characters on speaker lines, with up to 600 characters of overlap. One call per chunk through the hub LLM facade (task `brief.map`, or `brief.iteration` for iteration meetings), data class `transcript`, with a closed JSON schema and one prompt per meeting purpose (sales, demo, workshop, iteration). There is no other provider path: the data policy keeps transcripts on Claude. Results are cached per chunk sha and prompt hash under the client's folder.
   - An answer that would come out the same on a retry (refusal, output limit after the core's own retry, broken schema) is cached as a gap: the meeting completes without that chunk, `stats.chunks.gaps` counts it, and it is not paid for again until the prompt changes or a rebuild asks for `retryGaps`.
   - Any other failure (provider down, budget, safe mode) stops new calls for the rest of that rebuild, and the chunk backs off: 15 minutes after the first failure, doubling up to 24 hours (`chunkFailures` in `state.json`). After 6 failures in a row the chunk becomes a gap, so a stuck chunk costs at most 6 calls. A failure that stops before any provider answers (safe mode, the facade or route switched off, a route or budget configuration the core refuses, the data policy, the spend or loop guard, a rejected key) costs nothing and never becomes a gap: the chunk keeps backing off, at most once a day, and is extracted once the cause is gone.
3. Quotes (`verify-quotes.js`): every item needs a quote and a speaker. Quotes are compared as whole words (whitespace and case normalized, diacritics kept) inside one speaker turn of its own meeting, never across two turns. A quote passes when its words are a run of one turn's words and it has at least 3 words or is the whole turn, or when it has at least 4 words and differs from a run of one turn only by small words added or left out (hesitations, articles, pronouns, `og`, `at`, `som`, a few prepositions, forms of `være` and `ha`; `FILLER_WORDS`) or a repeated word left out, at most one such edit per ten words. A changed word never passes, and neither does a negation (`ikke`, `aldri`, `uten`, ...) or a number that was added or left out, so a quote that turns the statement around or names another thing is dropped. The speaker must be that turn's label. A kept item stores the transcript's own words for the matched run, never the model's copy. A stat also needs its number as a whole word of the quote ("20" is not in "2020"). Everything else is dropped and counted.
4. Reduce (`reduce.js`): duplicates (same key, or word Jaccard of at least 0.7) merge with precedence iteration > workshop > demo > sales; the loser keeps `supersededBy`. Above 40 items an optional merge call (task `brief.reduce`) groups remaining duplicates; its answer is cached and precedence still decides.
5. Assemble (`assemble.js`): client-confirmed data beats transcript data, a developer review beats both, and the sales card only fills gaps. `delivery.targetLaunchAt` comes from the launch date fact, else the due-date override.

**No transcript text in a brief.** Transcripts are referenced by sha256 and length; quotes are short; a final pass clips any string that repeats 20 words in a row from a transcript. A brief is at most 300 KB.

**Store** (`store.js`), under the data dir: `delivery-briefs/<clientId>/v<N>.json`, `latest.json`, `reviews.json`, `extraction.json`, `state.json` and `chunks/`, plus `delivery-briefs/.erased/<clientId>.json` for an erased client. The hash covers the brief without version, `generatedAt`, stats and URL signatures, so an unchanged input writes no new version. At most 10 versions and 2 MB per client. Reviews (`setDirectiveStatus`, `reviewFact`) survive rebuilds. A directive review is keyed by its id; a fact review by a single fact path (`contact.phone`) or by a transcript fact's id (`f-…`), never by a list position, which a rebuild can change. A fact review that would make the brief fail its schema is refused. After a complete rebuild, cached chunk and merge answers that no current transcript or merge uses are removed.

**Personal data.** When the build has the personal-data registry (`lib/personal-data.js`), the store registers its export and erase handlers once at boot for `delivery-briefs`. The registry's own row keeps its description and retention rule (`brief`) and only gets these handlers, the way the registry's other modules add theirs; a registry without such a row gets the brief's row with the same description. The export lists every file under the client's folder (versions, reviews, extraction, state and the chunk cache, JSON inline). The erase answers `{action: 'delete', records, files}`. A real erase first writes the marker `delivery-briefs/.erased/<clientId>.json` (the client id and the time), also when the client has no brief yet. From then on every brief writer refuses with `brief-erased`, checked right before it writes: a rebuild stops at its next model call or write, a review or re-assembly is refused (the board answers 410 `brief-erased`), and the loop step skips the client without touching its state. The erase then waits up to 15 seconds for the lease `brief:<clientId>` and deletes the folder, also when a rebuild still holds the lease, so it never leaves the brief behind. A marker older than 30 days is removed when the next erase writes one. The writers the registry's scan finds (`BRIEF_STORE_WRITERS`: the chunk cache, versions, latest copy, reviews and state, extraction, and the marker) are declared on the row; registering keeps the row's own writers too.

**Lease.** Every rebuild holds the lease `brief:<clientId>`, the loop step and the board's rebuild alike, so two runners never pay for the same chunks or interleave their writes. The lease is renewed before each LLM call and before anything is saved; a rebuild that lost it writes nothing. Every save (a rebuild, or a re-assembly after a review) assembles the brief inside the client's save lock from the reviews, and for a re-assembly the extraction, as they are at that moment, so a review saved while a rebuild runs is never lost and the reviews need no lease. A privacy erase waits at most 15 seconds for the lease; its marker stops the rebuild.

**Loop step** `brief-rebuild` (`tickSteps` in `lib/delivery-brief/index.js`, scope client): only for clients with a plan in force, a delivery stage from `signed` on, or (with a transcribed meeting) a place on `pilotClientIds`; a sales lead's meetings are never sent by the loop. It rebuilds when the client's input hash changed and stayed the same for 10 minutes, at most 2 starts per tick within 5 minutes of wall time. The input hash covers everything the brief shows (offer, plan, Kundedata, media rows, gate, keywords, CMS setup, feature availability, transcripts, prompts). A rebuild that runs out of time resumes from its cached chunks on the next tick; one whose chunk failed waits for that chunk's backoff (`retryAt`). A rebuild that throws backs off the same way for the same input. Nothing runs while the loop's mode is off.

**Routes.**

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /api/admin/development/:id/brief` (`?format=md`, `?version=N`) | developmentAuth | The brief as JSON or Norwegian markdown, with ETag and 304 |
| `GET /api/admin/development/:id/brief/versions` | developmentAuth | Stored versions |
| `POST /api/admin/development/:id/brief/rebuild` `{wait?, retryGaps?}` | developmentAuth (assigned developer or admin) | Rebuild now, without waiting for chunk backoffs; `retryGaps` also asks cached gaps again. 409 `{code:'brief-busy'}` while another runner holds the lease |
| `PATCH /api/admin/development/:id/brief/directives/:directiveId` `{status, note?, jobId?}` | developmentAuth (assigned developer or admin) | open, accepted, rejected or done |
| `PATCH /api/admin/development/:id/brief/facts` `{path, status, value?, note?}` | developmentAuth (assigned developer or admin) | Review a fact; 400 `bad-fact-path` for a list position or another path, 400 `invalid-review` when the value would break the schema |
| `GET /api/maker/clients/:id/brief` | Maker host token (scope `jobs`) with a routed job or the client's linked run | The newest brief, with ETag and 304 |
| `GET /api/maker/clients/:id/transcripts/:sha256` | same | One transcript, on demand |

Every Maker request for a client's brief or transcript is written to the Maker access log (ids only), allowed or refused. A host without a routed job or the client's run gets 403.

The ETag is the brief hash, which leaves URL signatures out. When the build signs media URLs (the media manifest's `signMediaUrl`, while `media.signedUrls` is on), each fetch signs the hub media items again with an expiry on the next full hour at least 24 hours away, so fetches within the same hour send the same links; the ETag also covers the signed URLs sent, so a client never keeps expired links through a 304.

**Dark by default, compared.** `DARK_COMPARE_REF=<earlier commit> node --test scripts/delivery-brief-dark-compare.test.mjs` boots that commit and this tree on the same seeded data, runs the same requests and compares the answers and the data dirs; with the switch off the only difference allowed is the `brief` node in the automation settings.

**Recall check** (not part of `npm test`): `node scripts/eval/brief-recall.mjs --input <dir> --report <file outside the repo>` runs the extractor on transcripts and expectations from a folder and reports recall per client. `--data-dir` (chunk cache and cassettes, which hold transcript text) must be outside the repository too.

---

## Data safety

- **Forward-compatible keys.** `data/normalize-ext.js` lists what later batches store on sales clients (`sitePlan`, `delivery`, `nurture`, `isTest`, ...), `makerRun`, `hubSite`, hub sites (`planSource`, `stagingDomain`, `featureSpec`, ...), `site.cms` and offers (`plan`, `pricing`, `dpaVersion`), plus a reserved `ext` object. Normalizers pass them through unchanged from the stored record; the code that owns a key normalizes it itself. An incoming patch cannot write them: `mergeMakerRunPatch` drops future `makerRun` keys and step tokens from a patch (for example a set-maker-run body), so a value such as `makerRun.goLive` only ever comes from the batch that owns it. `updateSalesOffer` does the same for offers (`withoutFutureOfferPatchKeys`): `plan`, `pricing`, `dpaVersion`, `ext` and `products[].services` / `oneTimeAddOns` / `ext` in a patch (a rep's composer body, an admin edit, a meeting-quote rebuild, a contract summary) are dropped, and a product edit keeps the keys the stored product with the same id carries (alternatives: the stored one at the same index). `offerPatchFromBody` also normalizes body products in strict mode. `updateSite` drops the heartbeat-derived `site.cms` keys (`effective`, `featuresRev`, ...) from a `cms` patch. `offerContentHash` counts `plan`, `pricing` and `dpaVersion` only when an offer stores them (batch 2), so no existing offer hash changes. `site.deliveryPhase` keeps `cancelled` and `archived`.
- **Owned keys (batch 2).** The keys stay in the forward-compatible lists (so the previous batch still keeps them) and their owners normalize them: `client.sitePlan` and `client.delivery` (writers in `data/sales.js`, never from an update), offer and alternative `plan` and `pricing` (only from the quote build), and `makerRun.materials`, `makerRun.autopilot` and `makerRun.previewPush` (only the callback recorder). A stored value a normalizer cannot read is kept as it is; `null` clears it.
- **Snapshots.** `DELIVERY_SCHEMA_VERSION` (in `lib/delivery-snapshots.js`) goes up by one in every batch that adds or reshapes delivery data. On startup, when it is higher than `<dataDir>/delivery-schema.json`, the server copies the delivery stores (`DELIVERY_SNAPSHOT_FILES`) into `<dataDir>/snapshots/batch-<n>-<timestamp>/` before anything writes. The newest 3 snapshots are kept. A snapshot is built in `snapshots/.tmp-<id>/` and renamed into place; a failed attempt (disk full, EPERM, quota) removes its temporary folder and rethrows, and every prune also removes `.tmp-*` folders that have not changed for an hour, so a failing boot that retries never piles up folders. A snapshot holds the same data as the live stores, including personal data, site keys (`site_key`), client admin password hashes and blog token hashes from `sites.json`, so it is as sensitive as the stores themselves. It lives only inside the data dir, is never served and never leaves the server through any route (the list and restore routes return snapshot ids, counts, record ids and the names of changed keys, never values).
- **Restore** shows a per-record diff first and saves the current state as `pre-restore-<timestamp>` before it writes.
- **Test clients.** `client.isTest` and `site.isTest` are set from Superadmin (Testkunde / Testside). Test clients stay workable on the boards but are left out of offer counts and other reports, social proof, nurture, Myphoner sync (no copy out, no incoming rewrite, no call recording attached) and the gate evaluation set. A Myphoner lead, call or recording reaches a test client only through an explicit lead-id link (`myphonerMatchCandidates` leaves test clients out of every email, phone and name fallback), and that event is then skipped and logged; a real lead that merely shares a test client's phone or e-mail becomes or updates a real client. The public site-config never carries the flag.

**Definition of done for every delivery batch:** `node --test scripts/forward-compat-revert.test.mjs` with `FORWARD_COMPAT_REF=<last deployed commit>`, `node --test scripts/docs-delivery-coverage.test.mjs`, and `DELIVERY_SCHEMA_VERSION` bumped when the batch adds delivery data.
