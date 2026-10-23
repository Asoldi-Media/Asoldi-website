# seo-ops store

`lib/seo-ops/store.js` keeps the hub's SEO operations data in the persistent data dir. One file per site and per client keeps every write small and every backup about one site.

| File | Content |
|---|---|
| `seo-ops/sites/<siteKey>.json` | Rank snapshots and monthly aggregates, reports, blog queue, AI visibility checks, local pack, backlink targets, live audit, PageSpeed, health. |
| `seo-ops/clients/<salesClientId>.json` | The SEO client record: agreed keywords, proposals, plan summary, showcase, compliance, history. |
| `seo-ops/settings.json` | Superadmin settings. Defaults are in code (`defaultSeoOpsSettings`); a stored file only overrides what it sets. |
| `seo-ops/link-network.json` | The client link network. |
| `seo-ops/health.json` | Derived health, rebuilt by its job. No backups. |
| `seo-ops/dfs-ledger-YYYY-MM.json` | DataForSEO spend per month. |

## API

```js
import { createSeoOpsStore, readSite, updateSite, readClient, updateClient } from '../lib/seo-ops/store.js';

const doc = readSite(siteKey);                           // a fresh empty document when none exists
await updateSite(siteKey, (doc) => { doc.reports.push(report); });   // fn may be async
await updateClient(salesClientId, (doc) => { doc.history.push(row); });
await updateGlobal('linkNetwork', (doc) => { ... });     // 'settings' | 'linkNetwork' | 'health'
await updateLedger('2026-11', (doc) => { doc.entries.push(entry); });
```

- The updater changes the draft or returns a new document; `null` skips the write.
- Keys become file-safe (`[a-z0-9_-]`): a key that already is stays as it is, anything else is cleaned and gets a short hash, so two keys never share a file and no key reaches outside the folder.
- One writer per key at a time in this process (async updaters included), a lock file against other processes, and a re-read: when another process changed the file meanwhile, the update runs again on the new content (up to 4 times).
- A file that is not a JSON object stops the update with code `corrupt` and is left for a person.
- Files are written whole (temp file and rename) as compact JSON.

## Backups

Each site and client file keeps its own backups under a path-qualified name in `<dataDir>/backups` (`seo-ops__sites__<siteKey>.json.<time>.json`, `seo-ops__clients__<id>.json.<time>.json`), so two files with the same name in different folders never share or prune each other's backups. The number kept is `DATA_BACKUP_KEEP`, at most 3 for these files; no `.latest.json` copy is made, and an unchanged write makes no backup. Settings and the link network keep 2. Only the current ledger month keeps backups. `deleteSite` and `deleteClient` remove a file and all of its backups.

`data/storage-path.js` `writeDataJson(path, data, { backupName, latest, atomic, keep, previous })` provides this; without options it works as before.

## Retention, applied on every write

| Data | Kept |
|---|---|
| Rank snapshots | 12 months in full; older ones become monthly aggregates (average and best organic position, average Maps position, AI Overview citations per keyword); aggregates go after 24 months |
| Reports | The last 26 |
| Blog queue | Every open item, plus the last 50 finished ones (`delivered`, `published`, `expired`, `failed`) |
| AI visibility checks | 12 months |
| Site file | Under 2 MB: if needed the oldest snapshots, reports and finished posts go first |
| Client history | The last 200 rows; older rows are counted in `historyArchivedCount` |
| Plan summary candidates | 50 |
| Ledger months | 13 |

A simulated year for 50 sites and 50 clients (weekly ranks, a report every two weeks, 3 posts a week) stays under `50 × 2 × (1 + backups kept) + 30` files in `seo-ops/` and its backups, with each site file under 2 MB (`scripts/seo-ops-store.test.mjs`).

## Safe mode

The store only reads and writes the local data dir. `seoOpsSafeModeGate(siteKey)` (or `store.safeModeGate`) tells a job whether it may run for a site: with hub safe mode off, always; with it on, only for sites in `settings.safeMode.allowSites`, with `settings.safeMode.live` deciding whether paid calls are real and `settings.safeMode.spendCapUsd` as the local cap.
