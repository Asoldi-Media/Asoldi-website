# Asoldi runtime data and LAN vs production

There are **two different things** to keep in sync. Mixing them is what made LAN `/sales` show 44 clients while `asoldi.com/sales` showed another number.

## 1) Code / structure → publish to asoldi.com

Product split (hub vs client Git vs disk): [deployment-split.md](deployment-split.md). Hub recipe: [DEPLOYMENT.md](../DEPLOYMENT.md).

1. Edit and test on LAN (`http://192.168.68.92:3200`)
2. Commit the **Asoldi-website** repo
3. `git push` — Hostinger auto-deploys `main` to **https://asoldi.com**. Audio/video is gitignored (`public/media/**/*.mp4|wav|…`, `public/myphoner-audio/*`), so the clone stays small. After the build, run `node scripts/hostinger-asoldi-env-check.mjs` (website-maker) if you want to confirm the Environment-variables tab still has every key.

Git never contains sales clients, Admin users, or media. A deploy does not copy LAN JSON onto production, and it does not copy production JSON onto LAN. Call recordings live under the persistent data dir `myphoner-audio` / `myphoner-recordings`; marketing videos, lydklipp and other uploads live in the **media library** (`~/.asoldi-website-data/media`, Admin → Manage website → Media) and are served at `/media/<name>` ahead of anything left in `nodejs/public/media`. `npm run media:pull` downloads the library into a local clone (`ASOLDI_ADMIN_USER` + `ASOLDI_ADMIN_PASS` or `ASOLDI_ADMIN_TOKEN`).

## 2) Sales / client data → production is the only source of truth

Live CRM data (MyPhoner winners, backfills, client records) lives on Hostinger:

`~/.asoldi-website-data/sales-clients.json` on **asoldi.com**

LAN Docker stores a **one-way mirror** of that data in:

`C:\hosted\asoldi-data` → container `/data` (`APP_DATA_DIR=/data`)

Rules:

- **MyPhoner webhooks stay on asoldi.com.** LAN must not register or steal them (`MYPHONER_WEBHOOK_RECONCILE_ENABLED=0` on the LAN compose).
- **Adding/editing a client on LAN only changes the LAN copy.** It does not update asoldi.com. The next production mirror overwrites that local edit.
- **Backfill / “fix the real website”** must be run against **https://asoldi.com**, not the LAN URL, unless you explicitly ask to change the LAN copy only.
- **Refresh LAN so it matches production:**

```bash
PROD_ADMIN_PASSWORD='your-admin-password' node scripts/sync-prod-runtime.mjs --out-dir C:\hosted\asoldi-data
```

That pulls Admin users + the full sales client list from asoldi.com. It **never writes back**.

Users-only (legacy):

```bash
PROD_ADMIN_PASSWORD='your-admin-password' node scripts/sync-prod-users.mjs --out C:\hosted\asoldi-data\users.json
```

## 3) Publishing a tested website to production

Website Maker owns the public snapshot. After draft phase, **Step 1** (and later steps or custom edits) uploads **that client only** to:

`https://asoldi.com/sales-preview/<sales-client-id>/`

Unchanged HTML/CSS/JS is skipped. There is no Sales “backfill” / “sync websites” button anymore — that was a one-time fill.

If the URL is not live yet, open the Maker run and click **Update public website now**. Do not wait for a 5-minute LAN timer.

Name, status, MyPhoner, and other CRM fields on production are left alone.

Requirements:

1. Production already has `POST /api/admin/sales/maker-preview-push` and `POST /api/admin/sales/:id/import-website-push`.
2. Maker env: `SALES_PREVIEW_PUSH_URL=https://asoldi.com/api/admin/sales/maker-preview-push`, plus a matching callback token / API key, or `PROD_ADMIN_PASSWORD` for the admin fallback.
3. Each finished Maker step pushes automatically within seconds.

Republish after you improve the run; it overwrites the previous production preview files for that client only.

## 3b) Public meeting preview (asoldi.com, any network)

The URL clients see in checkout, and the URL you should open on a meeting laptop, is the Hostinger snapshot:

`https://asoldi.com/sales-preview/<sales-client-id>/`

It is **not** the office LAN Maker (`192.168.68.92:3000`). After custom changes in Website Maker:

1. Wait a few seconds for Maker to push, or click **Update public website now** on the run.
2. In Sales, **Copy public URL** or bookmark **https://asoldi.com/previews**.
3. Open that link from any laptop / show the client. Offers attach the same URL.

This is a published snapshot, not a live tunnel into PC2.

Off the office network, use **New tunnel URL** only if you need to *edit* in Maker. Preview/show uses asoldi.com.

## Why the counts diverged

A workstation `~/.asoldi-website-data` folder (March 2026, ~45 clients) was copied onto LAN. Production had kept receiving MyPhoner winners (68 clients at last sync: 53 Asoldi + 15 SSU). Those are independent JSON files, not git.

## Do not overwrite LAN data on code updates

PC1 → PC2 code sync:

- `Asoldi-website` → `\\192.168.68.92\hosted\asoldi`
- `Website-creator` → `\\192.168.68.92\hosted\website-creator`

Never `/MIR` into `C:\hosted\asoldi-data` or into `C:\hosted\website-creator\.generated-runs`.

## 4) Website Maker client bundles / runs (also not in git)

Sales clients on asoldi.com and **Maker client bundles** are different files.

Maker stores bundles + uploads + generated sites in:

`C:\hosted\website-creator\.generated-runs`

That folder is gitignored (client media / PII, often hundreds of MB). Copy it from the laptop separately (skip `browser-profile`). Compose bind-mounts it into the Maker container. If you only sync the git tree, Maker shows `"clients":[]` and Sales **Open in maker** opens an empty draft.

See Website Maker `docs/other-pc-setup-checklist.md` section 7.

## Delivery phase (Sales → Development → Clients)

`sites.json` now has `deliveryPhase` (`development` | `client`) and an optional development checklist. `sales-clients.json` keeps the same contact/preview fields and adds `development` steps. Nothing is deleted when a signed contract leaves Sales/Clients — it is only shown on the Development board until **Nettside ferdig**.

Byneset Bydelskafe is forced into Development until that last step is checked.

## Password hashes

The public admin API does not return user password hashes. Existing local hashes are kept when the username already exists; brand-new LAN users get `LAN_USER_SYNC_PASSWORD` or `ADMIN_PASSWORD`.

Optional env (see `.env.example`):

- `PROD_ADMIN_URL` (default `https://asoldi.com`)
- `PROD_ADMIN_USERNAME` / `PROD_ADMIN_PASSWORD`
- `LAN_USER_SYNC_PASSWORD`

## 5) Hostinger `backups/` folder (inodes)

Every write to live JSON (`sales-clients.json`, `sites.json`, users, offers, …) also used to drop a **new timestamped copy** into `backups/` with **no cleanup**. That folder is never read by the app. Live data is the sibling `*.json` files in the parent directory.

Safe to delete on Hostinger:

- Everything inside `backups/` except optionally `*.latest.json`
- Or the whole `backups/` directory (it is recreated on the next save)

Do **not** delete:

- The parent folder’s live files (`sales-clients.json`, `sites.json`, `users.json`, `admin.json`, …)
- `myphoner-audio` (call-recording copy)

The app now keeps only `DATA_BACKUP_KEEP` dated snapshots per file (default 5) and prunes on startup. One-shot cleanup:

```bash
node scripts/prune-data-backups.mjs --dir /home/u439392007/domains/asoldi.com/.asoldi-website-data --wipe-stamped
```

## 6) Email data (opt-outs, owner routing, email log)

All in the same data dir, never in Git:

- `email-suppressions.json`: the legal opt-out record. The `asoldi` key holds people who unsubscribed from Asoldi marketing at `/email/avmeld`. Never delete it. If it is missing or corrupt, the app reads `backups/email-suppressions.json.latest.json` instead (reads never write; the next opt-out rewrites the live file), so keep that backup too. If neither can be read, Asoldi marketing sends are refused until it is fixed.
- `secrets/email-suppressions-created`: written once the opt-out record exists. If both `email-suppressions.json` and its backup are gone while this marker exists, the record counts as lost: every Asoldi marketing send is refused, new opt-outs return 503, and the log shows `[email-store] ALERT`. Restore the file from a dated snapshot in `backups/`. Delete the marker only if you know the record really is empty.
- The unsigned address form at `/email/avmeld` (old links without a signature) accepts at most 200 new addresses per hour and 5000 in total, hub-wide; after that it answers "for mange forsøk" and logs `[avmeld] ALERT`. Signed links in mail are never capped.
- `email-sites.json`: per-site email state. `ownerRouting` decides where client form and order notices go: unset = Asoldi inbox (old behaviour), `owner` = the client owner, `owner+asoldi-bcc` = the owner plus a copy to Asoldi for 30 days after the switch. Set it per site under Manage clients. The address field there lists confirmed owner addresses only; changing just the mode never confirms a pending address.
- `email-settings.json`: email platform settings (dark by default: rollout off).
- `email-log/`: monthly JSONL of sends and provider events. No plain recipient addresses. A month file is deleted once the month ended more than 400 days ago; its counters stay in `email-log/rollup.json`.
- `email-locks/`: short-lived lock, lease and fencing files. Safe to delete only while the app is stopped.
- `secrets/email-unsub-key`, `secrets/email-webhook-token`: generated once. Deleting the unsub key breaks the signed unsubscribe links in mail already sent (they fall back to a form that asks for the address).
