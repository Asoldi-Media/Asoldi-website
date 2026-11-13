# Legal texts

One versioned source for Asoldi's terms (Vilkår), privacy policy (Personvern), data processing
agreement (Databehandleravtale) and its appendix, the contract lines per plan, the offer letter's
product lines, the sales page's "what's included" copy and the client portal's plan cards.

**Switch:** `legal.catalogTexts.enabled` in the automation settings (default `false`). While it is
off, every page, contract, offer letter, pricing card and portal plan card shows the static texts it
showed before the catalog existed, offers get no version stamps, plans derived from offer text are
the same as before, the portal card is hidden and every route below answers `404 {code:'disabled'}`.
`scripts/contract-copy.test.mjs` proves this against `scripts/fixtures/legal/dark-surface-baseline.json`,
recorded from the code before the catalog (`node scripts/legal/dark-surface.mjs --write` run on an
export of that code). The baseline covers every contract fixture both as a sent offer and as an
unsent one (draft, review requested, verified), which is what the preview, the PDF attached at send
and the signed contract show. A hub that never turned the switch on writes no new data: the signing
snapshot needs an offer stamped while the switch was on. Before switching on,
`retention.analyticsTraffic` must be enabled in `auto` (the settings save refuses otherwise), and
each client CMS must also be running its own deletion rule for visit rows; the hub cannot see a
CMS's rule, so that is checked by hand per CMS. A later save may turn the deletion off, switch it
to shadow or pause it, and a pause must always work. While the legal texts stay on and
`retention.analyticsTraffic` is not running in auto, the settings screen shows a warning and the
retention job logs one.

Turning the switch off after an on-period stops new catalog contracts, but keeps what was sent: an
offer stamped while the switch was on keeps rendering its version (preview, PDF, the signed copy
stored at acceptance), and `GET /api/legal/texts/<vilkar|personvern|databehandleravtale>?version=<n>`
keeps answering once stamped offers exist, so the links in those contracts resolve.

## Contract period wording by signature time

Section 3 of a contract has two wordings for moving to a lower tier. Version 1, the sentence a
contract kept when it was signed before the current wording, says the client cannot downgrade once
higher-level functionality has been added (`Kunden kan ikke nedgradere til et lavere nivå etter at
funksjonalitet fra et høyere nivå er lagt til.` / `Clients cannot downgrade to a lower tier once
higher-level functionality has been added.`). Version 2, the current wording, says the client can
move down to a lower tier by agreement with Asoldi.

The time version 2 starts is stored once, in `contract-terms-cutover.json`, the first time the code
that carries the current wording starts. An offer that is not signed renders version 2. An offer
sent at or after that cut-over always renders version 2. A signed client with no recorded time
renders version 1 only for an offer sent before the cut-over (also when the offer has no send time,
or when no cut-over time is stored). Otherwise a signed offer renders version 1 when its signature
time is before the cut-over, and version 2 when the signature time is at or after it.

The signature time is the earliest recorded time at or after the offer's send time, chosen from the
client's `contractSignedAt` and the remembered earlier time `ext.contractSigning.earlierSignedAt`
(the earliest signature time that was recorded and later removed; a change of several clients in
one write does not record it). When the offer has no send time, the earliest of
those times is used. When every recorded time is before the send time, the offer counts as signed
only when the client's site plan names that offer; its time is then the latest `offer-upgrade`
entry in the plan history at or after the send time, or the send time when there is no such entry.
When nothing was recorded, the offer is signed with no time. A signed PDF already filed is never
rewritten.

**Limits.** The recorded time is when the hub recorded the signature, not the moment of signing, so
a contract signed before the cut-over but first recorded after it (no earlier tick; the arrival
time of a mail with the signed PDF is not read) renders version 2, and a tick set by mistake after the offer was sent and removed again still
counts as the first recorded time. When a release is rolled back to a build without the current
wording, delete `contract-terms-cutover.json` as part of the rollback; see
[runtime-data.md](runtime-data.md).

## Parts

| Part | Code |
|---|---|
| Clause catalog, versions | `lib/legal/catalog.js` (`CATALOG_VERSION`, `DPA_VERSION`) |
| Archive of each version | `lib/legal/archive/catalog-v<n>.json`, `lib/legal/archive.js` |
| Rendering | `lib/legal/render.js`, plan of a contract `lib/legal/plan.js`, contract copy `lib/legal/contract.js`, API bodies `lib/legal/texts.js` |
| Subprocessor register | `lib/legal/hosts-register.json`, `lib/legal/subprocessors.js` |
| Host snapshots | `scripts/legal/hosts-{hub,maker,cms}.json`, written by `scripts/legal/scan-hosts.mjs` |
| DPA versions and signing | `lib/legal/dpa.js` |
| Version binding | `lib/legal/binding.js`; offers stamped in `data/sales-offers.js`, signing snapshot in `data/sales.js` |
| Terms update list, notice draft and notice record | `lib/legal/terms-update.js` (drafts and records; does not send) |
| Terms update notice mail | `lib/legal/terms-update-send.js`, `POST /api/admin/legal/terms-update/:clientId/send` |
| Routes | `lib/routes/legal-routes.js` |
| Pages | `app/pages/legal/CatalogLegalPage.tsx`, `app/data/catalogLegalTexts.js`, `app/components/client/ClientLegalCard.tsx`, the portal plan picker and checkout |

## Catalog

A clause is `{id, version, kind, section, docs, covers, nb, en?}`. `docs` says where it renders
(`terms`, `contract`, `sales`, `privacy`, `dpa`); `covers` names the services, feature keys
(`a.*` children and `a.**` descendants are expanded against `data/cms-feature-tree.json`), one-time
add-ons, cancellation effects and billing kinds it describes. `nb` holds the Norwegian title and
texts; `en` holds English contract and sales lines. Texts can use `{changesPerMonth}`,
`{slaWorkDays}`, `{oneTimeMultiplier}`, `{oneTimeMonths}`, `{graceDays}`, `{pages}` and
`{dpaVersion}`.

`requiredCoverage()` is generated from the shared vocabulary (`SERVICE_CATALOG`, `TIER_MATRIX`,
`ONE_TIME_ADDON_CATALOG`, `CANCELLATION_EFFECTS`, `CANCELLATION_GRACE_DAYS`) and the feature tree's
bundles. `scripts/legal-catalog.test.mjs` fails when a service id, an entitled feature key, an
add-on, a cancellation effect or a billing kind has no contract clause or no terms clause.

Asoldi's own terms are between businesses. Clauses about what a client's site says to its own
consumers (shop, bookings, legal pages) are marked `consumerFacing` and follow Forbrukertilsynet's
standard terms of sale.

## What the clauses cover

Besides the services and add-ons, the catalog has clauses for: changing the plan (`general.planChange`: an upgrade is a new offer that applies from acceptance and never changes a signed offer; a downgrade is agreed with Asoldi; `general.term` says the same: a downgrade is by agreement, applies from the time Asoldi records it, and the higher-tier functions are removed from the site); the end of the agreement (SEO maintenance stops with the other running services at the end of the paid period, the site stays up for the grace days, the export that exists today); the self-booking link (`privacy.booking`: a signed single-use link that expires after three weeks; the nonce is kept with the client id, purpose and booked time until a later booking clears the log, at the earliest 60 days after the link expired); statistics without cookies or browser storage and click-to-load embeds (`privacy.siteAnalytics`: one stored row per event with the event type, a visitor key and a session key that change every day, the device class, the page address, on a click the address of the clicked link, the referrer, the host, the time on the page and the time, deleted automatically after 26 months, in the CMS and at Asoldi, also when the agreement ended before that; click-to-load covers third-party frames (iframe) only, other third-party content such as fonts, scripts and images loads without a click, and a remembered frame choice is a necessary cookie for 180 days); automatic mail from a client's site (`dpa.siteMail`: double opt-in, abandoned cart only with the buyer's consent, back in stock, review request, win-back, every mail with an unsubscribe link); and the retention schedule of the CMS (`dpa.cmsRetention`: report mode first, deletion only when Asoldi has turned it on for the site after reading the report, with a backup before the first deletion; orders and the other shop rows have no automatic deletion period; visit statistics are kept 26 months). The link network clause says links end with the subscription. `scripts/legal-catalog.test.mjs` checks that these clauses reach the rendered documents, and that the statistics clause names every field of a stored visit row (`lib/site-public-guards.js`, `data/client-analytics.js`) and that rows older than 26 months are removed by the retention job; `scripts/plan-change.test.mjs` checks the downgrade wording next to the downgrade itself. A stored field the clause does not name fails the test until the clause is updated.

## Versions

- Every change to a clause, to the register or to a rendered document needs a new
  `CATALOG_VERSION` once that version is released; a change to the DPA or its appendix also needs
  a new `DPA_VERSION`. `node scripts/legal-render.mjs --write` writes a missing archive and the other
  generated files, and refuses to change an archive that exists with other texts: bump
  `CATALOG_VERSION` first, then `--write`, and the previous file stays. Only while no client is bound
  to the version (catalog version 1 until the legal texts are switched on) may
  `--write --unreleased` rewrite that version's archive in place. `--check` (part of
  `npm run test:legal`) fails when anything is stale, and that failure still says to bump
  `CATALOG_VERSION`.
- Published texts never depend on stored settings. The archive is rendered with the code defaults of
  the automation settings and the personal-data registry's retention text
  (`archiveRenderOptions()` in `lib/legal/texts.js`), records those values under `published`
  (`changesPerMonth`, `slaWorkDays`, `oneTimeMultiplier`, `oneTimeMonths`, `graceDays` and the
  retention rows), and the API serves the current documents from it. A contract bound to a version
  is filled with that version's published values (`publishedParamsForVersion()`), never with
  today's code defaults or stored settings. `GET /api/admin/legal/terms-update` reports
  `settingsDrift`: stored settings (grace days, one-time multiplier and months, change time,
  retention) that differ from the published values. Publishing a new value needs a new version.
- The archive also holds the wording a catalog contract adds around the clauses (the introduction's
  legal sentence and Section 4 from `lib/legal/contract.js`, under `contract`). A contract bound to
  an older version renders that wording from the archive. The current version is rendered from the
  code, which is what `--check` compares with the archive, so a wording change fails `--check`
  until the current file is refreshed or a new `CATALOG_VERSION` is archived.
- Published Vilkår name each tier without a list price and say the price is in the offer. The
  price stays on the offer (stamped when it is sent) and on the pricing cards. A contract's own
  lines still come from the offer.
- An offer sent while the switch is on carries `dpaVersion` (also on each alternative) and
  `ext.legal = {catalogVersion, stampedAt, tiers, agreedKeywordsText?}`: what each tier contained
  and the client's agreed keywords at send. Its contract renders that version with that scope,
  whatever the switch is now. An unsent offer renders the current version while the switch is on and
  the static text while it is off; an offer sent before the switch keeps the static texts.
- An English catalog contract explains its services (Section 5) with the clauses' English texts, so
  it never mixes in the static English text.
- Contracts link the versions they incorporate (`/vilkar?versjon=<n>`, `/databehandleravtale?versjon=<n>`).
- When any writer turns `progression.contractSigned` on (`setSalesProgress`, the got-client route,
  a plain progression patch, the batch patch) and the client's latest sent offer carries a stamp,
  the client gets `client.ext.legal = {catalogVersion, dpaVersion, boundAt, offerId, source}`, also
  when the switch is off at that moment. A signed client without that snapshot keeps the static texts.
- A progression write on a client who is already signed records nothing, and the snapshot is taken
  from the client's latest sent offer. A signing step that knows which offer was accepted (an upgrade
  by a signed client, or a client with several sent offers) records it with
  `legalSnapshotPatch(client, acceptedOffer)` and writes the patch; that moves the client to the
  offer's version.
- A signed client moves to a newer version through a terms notice: the notice mail's
  sender (with the release suite) records the sent draft with `termsNoticePatch()` under
  `client.ext.legal.notice = {catalogVersion, dpaVersion, sentAt, effectiveFrom}`, and from
  `effectiveFrom` (30 days after the notice) the client is bound to that version. Until then the
  portal shows the pending version. `GET /api/admin/legal/terms-update` lists who is on an older
  version with a draft notice for each and sends nothing.

## DPA

`dpaStatus(client)` answers:

| Status | Meaning | `missing` |
|---|---|---|
| `disabled` | the switch is off | false |
| `not-required` | no signed website contract | false |
| `signed` | the current version was signed in the portal | false |
| `accepted-with-contract` | the signed offer carried the current version | false |
| `outdated` | an older version was signed or accepted; it stays in force | false |
| `accepted-legacy` | the service agreement was signed without a stamped offer; the static contract incorporates the DPA as published on the signing date | false |
| `missing` | bound to a catalog version with no DPA version recorded | true |

`upToDate` is true only for the current version; the portal card then offers "Signer versjon <n>"
without saying the DPA is missing. Every client signed before the switch is `accepted-legacy`.

The delivery gate decides its developer-only `dpa-missing` line at signing with
`dpaMissingAtSigning(offer, {alternativeIndex, client})`: true while the switch is on when the
accepted offer (or chosen alternative) carries no DPA version and the client has not signed the
current version in the portal.

A client signs the current version in the portal (`POST /api/client/dpa/sign`), which writes
`client.ext.dpa = {version, catalogVersion, signedAt, source, userId, ip, userAgent}` and keeps every
other field of `ext.dpa`. Signing again changes nothing. Signing binds the business, so only its
owner or an admin may sign (`403 {code:'not-authorized'}` for other members); the portal card
says so instead of showing the button.

## Subprocessors

`lib/legal/hosts-register.json` has a row for every outbound host the hub, Maker and CMS code can
reach: a processor with purpose, data categories and region, or `noPersonalData` with a reason.
`scripts/legal/scan-hosts.mjs <repo>` lists the hosts from a static scan plus, for the hub, the
safe-mode egress allowlist. The scan covers URL and host literals in runtime code, the SDKs in
`package.json`, the pages' HTML (script, iframe, image and media sources, stylesheet, preconnect and
preload links, form actions, CSS `url()` and inline scripts), and in React files what the browser
loads: call-like positions, image, media, icon, embed and stylesheet values, and the URL constants of
a file that starts an embedded widget. Links a person clicks are not outbound. Scratch files,
imported template sources and dot-files are not served and are skipped.

```
node scripts/legal/scan-hosts.mjs . --name hub --ref HEAD --egress --out scripts/legal/hosts-hub.json
node scripts/legal/scan-hosts.mjs ../website-maker --name maker --ref main --out scripts/legal/hosts-maker.json
node scripts/legal/scan-hosts.mjs ../website-cms --name cms --ref main --out scripts/legal/hosts-cms.json
```

With `--ref` every file, the egress allowlist included, is read from that commit through git only.
The Maker and CMS snapshots record the branch and the commit they were taken from (`ref`, `commit`).

`scripts/legal-hosts.test.mjs` fails on a host without a row and on a hub snapshot that differs from
a scan of the committed code (`HEAD`, never local changes). When a website-maker or website-cms
checkout sits next to this repository (or next to its main checkout; `LEGAL_HOSTS_MAKER_REPO` and
`LEGAL_HOSTS_CMS_REPO` name another), the test also checks, through git only, that the snapshot
equals a scan of its recorded commit (`LEGAL_HOSTS_<NAME>_REF` checks another ref instead) and that
every host the recorded branch reaches today has a register row; a branch that has moved on with new
hosts is reported with the command to regenerate. A checkout without the commit is skipped with a
message. The privacy policy names every processor that gets personal
data, for Asoldi's own processing and, in its own subsection, for processing on behalf of clients;
the test fails on one that is missing, and checks that every AI provider the data policy allows a
personal-data class is named in the privacy policy and the DPA appendix.

Retention periods in the privacy policy come from the personal-data registry
(`lib/personal-data.js` `retentionText(storeId)`) when it exists and answers, else from the
`retention.*` defaults. The registry text is used only for a store that one row lists: the leads and
the clients rows both read the sales store, so each keeps its own text. The registry renders with the
retention values the caller passes over the code defaults, never with the stored settings, so the
archive and `legal-render --check` do not depend on the data dir. Recordings and transcripts read
the transcript archive's rule. The registry and the SEO record modules are loaded without blocking
module evaluation (`personalDataReady`, `seoModulesReady`), so they may import the data layer.

## Routes

| Route | Auth | Answer |
|---|---|---|
| `GET /api/legal/texts/:doc?version=` | public | `vilkar`, `personvern`, `databehandleravtale` (`version=<n>` an archived version, `version=legacy` `{legacy:true}`), `salg` (with `checkoutPromises`), `kontrakt?tier=<tier id>`, `dpa-vedlegg` |
| `GET /api/client/legal` | client | the bound version, the DPA status, the links to the texts in force and `canSign` |
| `POST /api/client/dpa/sign` | client (owner or admin of the business that owns the resolved offer) | signs the current DPA (idempotent); `403 {code:'not-authorized'}` for a collaborator or an inactive membership |
| `GET /api/admin/legal/terms-update` | admin | clients on an older version with a draft notice each, `settingsDrift`; `sends: false` (this list sends nothing) |
| `POST /api/admin/legal/terms-update/:clientId/send` | admin | sends that client's terms-update notice; see below |

## Sales copy and portal

With the switch on, the pricing cards and the portal plan picker and checkout show the catalog's
"what's included". The checkout shows only the promises the terms back (`checkoutPromises`, none
today), so the static "30 dager penger tilbake", "Ingen oppstartsgebyr" and "24/7 support" promises
are not shown.

## Signing, older versions and English contracts

`canSign` is the membership of the business that owns the resolved offer (the offer's `businessId`,
or the portal profile linked to the offer's sales client), not the business that happens to be
active in the portal. An owner or admin of that business may sign. A collaborator, or a membership
that is not active, gets `canSign: false` and `403 {code:'not-authorized'}`. An account with no
business memberships may still sign, as before.

An English catalog contract explains Section 5 from the clauses' English texts for every tier,
including a custom plan. A custom plan with no services has no Section 5 lines. It does not fall
back to the static English service text.

With the switch off, unsent offers (draft, review requested, verified) stay on the static contract.
`scripts/contract-copy.test.mjs` compares them with the baseline, and a change to that static text
makes the comparison fail. The baseline file is not rewritten for that.

An accepted upgrade offer (`lifecycle.planChange` in auto, for a pilot) rebinds `client.ext.legal`
to the accepted offer's stamped catalog version, offer id and DPA version. The notice and any other
`ext` keys stay. An offer with no stamp changes nothing, whatever the legal switch is.

## Terms update notice

A staff member sends the notice. Nothing sends it on a timer.

`POST /api/admin/legal/terms-update/:clientId/send` (admin). While `legal.catalogTexts` is off the
route answers `404 {code:'disabled'}`, before authentication, like the other legal routes. Without
admin credentials it answers 401.

The client must be on an older version, and must not already have a pending notice for the current
version. Otherwise the route answers `409 {code:'no-update'}`. Other refusals have their own code:
`409 no-recipient` (the client has no contact e-mail), `409 busy` (another send holds the lease) and
`409 already-sent`. A mail transport that throws gives `502 {code:'send-failed'}` and records nothing.

The mail kind is `emails.termsUpdate` (service sender, not legacy, release-gated, default shadow).
Its mode is its own (`spineModeForClient('emails.termsUpdate')`), not the delivery gate. The service
sender is `sender.service`: account key `damian` is `damian@asoldi.com`, and the reply-to is the one
in settings (`alexander@asoldi.com`).

- off or paused: `409 {code:'off'|'paused'}`, nothing written.
- shadow: one draft in the safe-mode outbox (channel `delivery-shadow`). Nothing is recorded on the client.
- auto: sent through `deliverDeliveryEmail` (`lib/email.js`, so safe mode applies), then
  `termsNoticePatch` records `client.ext.legal.notice`, and a delivery-audit row is written. A second
  send is refused while that notice is pending. Auto still requires the client to be in `pilotClientIds`.

`PUT /api/admin/automation-settings` cannot set `emails.termsUpdate.mode` to `auto` until
`recordReleasePass('emails.termsUpdate', ...)` has recorded a pass.

The end-to-end release case is added when the release-suite harness is merged. It is not on this tree.

## Not in this part

- The DPA signing mail.
- Client-site legal pages built from the same clauses: they will read `GET /api/legal/texts/:doc`
  and the `consumerFacing` clauses.
