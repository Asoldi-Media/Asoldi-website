# What lives where (hub, GitHub, Hostinger)

This is the rule for **every new client website** and for **asoldi.com**. Do not mix the three layers.

```
asoldi.com /superadmin
  flags, plan, catalog type, site key, githubRepo
  (not client users, not client products)

GitHub (private repo per client)
  the website + CMS software
  (not CMS JSON)

Hostinger (that domain’s Node app disk)
  runtime + client-specific CMS files + CMS uploads
  ~/.asoldi-cms-data/<siteKey>
```

## Client sites (Maker → GitHub → Hostinger)

Use this for every new `clientdomain.com`.

| What | Where | Survives a deploy? |
|---|---|---|
| Generated website HTML/CSS/JS and page images from Maker | GitHub `public/` | Yes (it is the site) |
| Express + vendored CMS (`server.js`, `vendor/client-cms`, `cms.config.json`) | GitHub | Yes |
| Superadmin flags / plan / catalog / site key / `githubRepo` | Hub JSON on asoldi.com (`~/.asoldi-website-data`) | Yes (not in the client repo) |
| CMS users, products, notes | Hostinger `~/.asoldi-cms-data/<siteKey>` | Yes — **outside the Git clone** |
| CMS uploads (images, video, audio the client adds in `/admin`) | Hostinger `~/.asoldi-cms-data/<siteKey>` (or that site’s upload dir) | Yes — **outside Git** |
| Contact form posts | asoldi.com `/api/client-forms/:siteKey` | Yes |

Maker **Publish to GitHub** writes the repo. It does **not** SFTP and does **not** create a Hostinger website via API (that blocks Node.js on that domain).

**Once per domain, human in hPanel:** Websites → Add Website → Node.js web app → Import that GitHub repo. Framework **express**, entry **`server.js`**, **empty build**, Node **22**. Later Maker publishes are `git push` only; Hostinger auto-deploys `main`.

`package.json` must look like Express (no Vite/React). If Hostinger sees Vite, it never starts `server.js`.

Client website images that the published pages actually use belong in Git `public/`. That is the website. Unused intake/gallery dumps stay out of Git. Client **CMS** media (product shots, avatars, files the client uploads in `/admin`) belong on Hostinger disk, not in Git. The client repo must stay Express-only (no Vite/`lucide-react` install) so Hostinger does not fill inodes the way the hub did.

## Hub (asoldi.com)

asoldi.com is **not** a Maker client site. It is Vite + Express. Sales CRM and call recordings are production data.

| What | Where | Survives a deploy? |
|---|---|---|
| Hub source + built SPA | GitHub `Damianhch/Asoldi-website` (code) / Hostinger `nodejs/dist` (running SPA) | Code yes |
| Superadmin site list, flags, plans, keys | `~/.asoldi-website-data` | Yes — never in Git |
| Sales clients, notes, connections | `~/.asoldi-website-data` | Yes |
| Call recordings (wav) | `~/.asoldi-website-data/myphoner-audio` + `myphoner-recordings` | Yes — served at `/myphoner-audio/*`, `/myphoner-recordings/*` |
| Hub media library (marketing videos, lydklipp, images uploaded in Admin) | `~/.asoldi-website-data/media` | Yes — served at `/media/<name>` ahead of the Git copy in `public/media` |
| Hostinger Environment variables | hPanel + `~/.asoldi-website-data/production.env` snapshot | Yes — the app refills missing keys from the snapshot on boot |

**asoldi.com deploys from GitHub (auto-deploy on push to `main`), since 2026-09-21.** Do not zip or archive-upload the hub. That upload collides with the Git build and fails with empty logs. Audio/video is not in Git (`.gitignore`: `public/media/**/*.{mp4,webm,mov,m4v,mp3,wav,m4a,ogg,flac}`, `public/myphoner-audio/*`). New media goes in via **Admin → Manage website → Media**.

Proven green hub recipe: Express, Node 22, entry `server.js`, `npm run build` / postinstall Vite, Vite **not** copying `public/` into `dist/`.

## Quick checks

- Client live: `https://{domain}/api/cms/config` → real **name**, not `"Site"`, plus plan/catalog/features from superadmin.
- Client `/admin` → CMS (modules from hub flags). Users/products still there after a Git deploy.
- Hub: `https://asoldi.com/superadmin` → add/edit site with flags, plan, catalog type, site key, GitHub repo. Not client products.
- After Maker Publish: hub site has `githubRepo` like `Damianhch/website---{slug}`.
