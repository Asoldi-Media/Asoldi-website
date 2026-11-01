# Legal texts

One versioned source for Asoldi's terms (Vilkår), privacy policy (Personvern), data processing
agreement (Databehandleravtale) and its appendix, the contract lines per plan, the offer letter's
product lines and the sales page's "what's included" copy.

**Switch:** `legal.catalogTexts.enabled` in the automation settings (default `false`). While it is
off, every page, contract, offer letter and pricing card shows the static texts it showed before the
catalog existed, offers get no version stamps, signing records nothing new, the portal card is
hidden and every route below answers `404 {code:'disabled'}`. `scripts/contract-copy.test.mjs`
proves this against `scripts/fixtures/legal/dark-surface-baseline.json`, recorded from the code
before the catalog.

## Parts

| Part | Code |
|---|---|
| Clause catalog, versions | `lib/legal/catalog.js` (`CATALOG_VERSION`, `DPA_VERSION`) |
| Archive of each version | `lib/legal/archive/catalog-v<n>.json`, `lib/legal/archive.js` |
| Rendering | `lib/legal/render.js`, contract copy `lib/legal/contract.js`, API bodies `lib/legal/texts.js` |
| Subprocessor register | `lib/legal/hosts-register.json`, `lib/legal/subprocessors.js` |
| Host snapshots | `scripts/legal/hosts-{hub,maker,cms}.json`, written by `scripts/legal/scan-hosts.mjs` |
| DPA versions and signing | `lib/legal/dpa.js` |
| Version binding | `lib/legal/binding.js`; offers stamped in `data/sales-offers.js`, signing snapshot in `data/sales.js` |
| Terms update list and notice draft | `lib/legal/terms-update.js` (sends nothing) |
| Routes | `lib/routes/legal-routes.js` |
| Pages | `app/pages/legal/CatalogLegalPage.tsx`, `app/data/catalogLegalTexts.js`, `app/components/client/ClientLegalCard.tsx` |

## Catalog

A clause is `{id, version, kind, section, docs, covers, nb, en?}`. `docs` says where it renders
(`terms`, `contract`, `sales`, `privacy`, `dpa`); `covers` names the services, feature keys
(`a.*` children and `a.**` descendants are expanded against `data/cms-feature-tree.json`), one-time
add-ons, cancellation effects and billing kinds it describes. `nb` holds the Norwegian title and
texts; `en` holds English contract and sales lines. Texts can use `{changesPerMonth}`,
`{slaWorkDays}`, `{oneTimeMultiplier}`, `{oneTimeMonths}`, `{graceDays}`, `{pages}` and
`{dpaVersion}`, filled from the automation settings.

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
- An offer sent while the switch is on carries `dpaVersion` (also on each alternative) and
  `ext.legal.catalogVersion`. Its contract renders that version. An unsent offer renders the current
  version; an offer sent before the switch keeps the static texts.
- Signing an offer with a stamp records `client.ext.legal = {catalogVersion, dpaVersion, boundAt,
  offerId, source}`. A signed client without that snapshot keeps the static texts. A client moves to
  a newer version only by signing again; `GET /api/admin/legal/terms-update` lists who is on an
  older version with a draft notice for each and sends nothing.

## DPA

`dpaStatus(client)` answers `disabled` (switch off), `not-required`, `signed`, `accepted-with-contract`,
`outdated` or `missing`; `missing` is true for the last two. A client signs the current version in the
portal (`POST /api/client/dpa/sign`), which writes `client.ext.dpa = {version, signedAt, source,
userId, ip, userAgent}` and keeps every other field of `ext.dpa`. Signing again changes nothing.
Email functions on a client site stay off until the DPA is accepted.

## Subprocessors

`lib/legal/hosts-register.json` has a row for every outbound host the hub, Maker and CMS code can
reach: a processor with purpose, data categories and region, or `noPersonalData` with a reason.
`scripts/legal/scan-hosts.mjs <repo>` lists the hosts from a static scan (URL and host literals in
runtime code, the SDKs in `package.json`) plus, for the hub, the safe-mode egress allowlist.

```
node scripts/legal/scan-hosts.mjs . --name hub --egress --out scripts/legal/hosts-hub.json
node scripts/legal/scan-hosts.mjs ../website-maker --name maker --ref HEAD --out scripts/legal/hosts-maker.json
node scripts/legal/scan-hosts.mjs ../website-cms --name cms --ref HEAD --out scripts/legal/hosts-cms.json
```

`scripts/legal-hosts.test.mjs` fails on a host without a row, on a stale hub snapshot, and, when the
sibling checkouts exist (`../website-maker`, `../website-cms`, or `LEGAL_HOSTS_MAKER_REPO` and
`LEGAL_HOSTS_CMS_REPO`), on a stale Maker or CMS snapshot. It also checks that every AI provider the
data policy allows a personal-data class is named in the privacy policy and the DPA appendix.

Retention periods in the privacy policy come from the personal-data registry
(`lib/personal-data.js` `retentionText(storeId)`) when it exists and answers, else from the
`retention.*` settings.

## Routes

| Route | Auth | Answer |
|---|---|---|
| `GET /api/legal/texts/:doc?version=` | public | `vilkar`, `personvern`, `databehandleravtale` (`version=<n>` an archived version, `version=legacy` `{legacy:true}`), `salg`, `kontrakt?tier=<tier id>`, `dpa-vedlegg` |
| `GET /api/client/legal` | client | the bound version, the DPA status and links |
| `POST /api/client/dpa/sign` | client | signs the current DPA (idempotent) |
| `GET /api/admin/legal/terms-update` | admin | clients on an older version with a draft notice each; `sends: false` |

## Not in this part

- The terms-update notice mail and its email kind (sent by the release suite).
- Client-site legal pages built from the same clauses: they will read `GET /api/legal/texts/:doc`
  and the `consumerFacing` clauses.
