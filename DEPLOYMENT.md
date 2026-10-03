# asoldi.com Hostinger deploy

The product split (hub vs client Git vs Hostinger disk) is in [docs/deployment-split.md](docs/deployment-split.md).

## Hub (this repo)

**Deploy by pushing `main`.** Hostinger is connected to this GitHub repo and auto-deploys that branch to asoldi.com. That has been the method since 2026-09-21.

Do **not** zip or archive-upload asoldi.com. Do **not** run `scripts/hostinger-asoldi-archive-deploy.mjs` (in the website-maker repo). An archive build beside the Git build fails with empty logs. Notes that say "disconnect the repository" or "archive-only" are obsolete.

**Environment variables:** add them only in hPanel → asoldi.com → **Environment variables**. That tab is the source of truth. Saving there restarts the app so `process.env` picks them up. After the app has booted once with the keys, a copy is stored in `~/.asoldi-website-data/production.env` (outside the deploy folder) so a wiped panel does not take the running app down.

Never use Hostinger’s “replace all env vars” API, and never Save an empty list in the env tab (both delete every key).

Audio, video, and CRM JSON live in `~/.asoldi-website-data`, not in Git. A Git deploy does not delete that folder.

Settings: Express, Node **22**, entry `server.js`, build script `build`, Vite in dependencies, `postinstall` → `vite build`, `publicDir: false` on production Vite.

After a push, confirm the Hostinger Git build completed, live JS is a new `assets/index-*.js`, and `/sales` + `/superadmin` return 200.

The `backups/` subfolder is only historical copies of those JSON files. The app never reads it. If Hostinger inodes are full, delete timestamped files in `backups/` (keep the sibling live `*.json` files, and keep `myphoner-audio` if present). After deploy, the app keeps at most `DATA_BACKUP_KEEP` dated copies per file (default 5).

## Client sites

Maker **Publish to GitHub**, then one hPanel Git import. See [docs/CLIENT-SITE-DEPLOYMENT.md](docs/CLIENT-SITE-DEPLOYMENT.md) and [docs/deployment-split.md](docs/deployment-split.md).
