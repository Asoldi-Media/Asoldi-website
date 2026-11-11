# Site keys and rekeying

A hub site has one current `site_key`. When a site is published with a key the hub did not make (a
Maker run carries its own), `POST /api/admin/sites/rekey` gives the hub site that key.

## What it does

`hub.rekeySite(siteId, newKey)` (data/hub.js), under the `sites.json` lock:

- refuses a key another site holds, as its current key or as a live alias: 409 `site-key-held`, nothing
  written;
- stores the old key in `site.keyAliases` as `{ key, at, until }`, valid for 90 days;
- logs the change in `site.ext.keyHistory` (time, who, and short fingerprints of both keys, never the
  keys);
- asking for the key the site already has changes nothing.

Every lookup by site key follows a live alias: `getSiteByKey` (config, forms, site credentials, e-mail
and shop routes), the heartbeat, `findSiteByKeyConstantTime` and the redeem check of the Asoldi
sign-in (lib/cms-sso.js), the sales-client match for the local blog brief, and the stores keyed by site
key in data/client-analytics.js (traffic rows are read under the old and the new key together;
commerce, maps and Google business rows are found under either key). A site that was never rekeyed
has no alias and every lookup is a plain key match, as before.

## The route

`POST /api/admin/sites/rekey` with `{ event: 'run.sitekey.adopt', runId, siteId, salesClientId,
previousSiteKey, siteKey }`. The site is found by `siteId`, else `previousSiteKey`, else
`salesClientId`. Allowed: a Maker host token (`x-maker-host-token`, scope `callback`) or the
Superadmin token.

| Answer | Meaning |
|---|---|
| 404 `{ code: 'disabled' }` | the `siteRekey` switch is off or paused (the default); sent before any sign-in check, nothing read or written |
| 401 / 403 | no valid credential / a host token without the `callback` scope |
| 200 `{ ok: true }` | rekeyed, or the site already had the key |
| 400 `bad-key` / `bad-event` | malformed request |
| 409 `site-key-held` | another site holds the key |
| 422 `site-not-found` | no site matches the ids sent (deliberately not 404, which the Maker reads as "adopt unavailable") |

Once the switch is on, a Maker host with the `callback` scope (the default for new hosts) can rekey any site, as can a Superadmin. When the request names a sales client linked to the site, the client's stored site key link is updated too.
The switch is `siteRekey.enabled` in the automation settings (default `false`), with `siteRekey.paused`.
Tests: `npm run test:hub-rekey`.

## Maker read scope

A Maker host token with the `sales-read` scope may call `GET /api/admin/sales` and
`GET /api/admin/sales/:id/preview-files`, which the Maker handoff comparison and run adoption read.
The list then holds the client rows only (no calendar, sender or owner list). See docs/security.md for
the scope list.
