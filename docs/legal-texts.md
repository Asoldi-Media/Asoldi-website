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
snapshot needs an offer stamped while the switch was on.

Turning the switch off after an on-period stops new catalog contracts, but keeps what was sent: an
offer stamped while the switch was on keeps rendering its version (preview, PDF, the signed copy
stored at acceptance), and `GET /api/legal/texts/<vilkar|personvern|databehandleravtale>?version=<n>`
keeps answering once stamped offers exist, so the links in those contracts resolve.

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
| Terms update list, notice draft and notice record | `lib/legal/terms-update.js` (sends nothing) |
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

## Versions

- Every change to a clause, to the register or to a rendered document needs a new
  `CATALOG_VERSION`; a change to the DPA or its appendix also needs a new `DPA_VERSION`.
  `node scripts/legal-render.mjs --write` archives the new version and rewrites the generated files;
  it refuses to rewrite an archived version with different content. `--check` (part of
  `npm run test:legal`) fails when anything is stale.
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
  legal sentence and Section 4 from `lib/legal/contract.js`, under `contract`), so `--check` fails
  when that wording changes without a new `CATALOG_VERSION`.
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
`retention.*` defaults. The registry and the SEO record modules are loaded without blocking module
evaluation (`personalDataReady`, `seoModulesReady`), so they may import the data layer.

## Routes

| Route | Auth | Answer |
|---|---|---|
| `GET /api/legal/texts/:doc?version=` | public | `vilkar`, `personvern`, `databehandleravtale` (`version=<n>` an archived version, `version=legacy` `{legacy:true}`), `salg` (with `checkoutPromises`), `kontrakt?tier=<tier id>`, `dpa-vedlegg` |
| `GET /api/client/legal` | client | the bound version, the DPA status, the links to the texts in force and `canSign` |
| `POST /api/client/dpa/sign` | client (owner or admin of the business) | signs the current DPA (idempotent); `403 {code:'not-authorized'}` for other members |
| `GET /api/admin/legal/terms-update` | admin | clients on an older version with a draft notice each, `settingsDrift`; `sends: false` |

## Sales copy and portal

With the switch on, the pricing cards and the portal plan picker and checkout show the catalog's
"what's included". The checkout shows only the promises the terms back (`checkoutPromises`, none
today), so the static "30 dager penger tilbake", "Ingen oppstartsgebyr" and "24/7 support" promises
are not shown.

## Not in this part

- The terms-update notice mail and its email kind (sent by the release suite), and the DPA signing
  mail.
- Client-site legal pages built from the same clauses: they will read `GET /api/legal/texts/:doc`
  and the `consumerFacing` clauses.
