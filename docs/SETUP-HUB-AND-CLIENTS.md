# Hub and client CMS – quick setup

Canonical split (GitHub vs Hostinger disk vs Superadmin): [deployment-split.md](deployment-split.md).

## This repo = the hub (asoldi.com)

- **Super-admin:** https://asoldi.com/superadmin  
  Same login as this site’s `/admin`. Stores **flags, plan, catalog type, site key, `githubRepo` only** — not client users or products.
- **This site’s own `/admin`:** https://asoldi.com/admin  
  Features come from the hub row whose domain is `asoldi.com`.

Push to `main` deploys asoldi.com. Hostinger auto-deploys that branch. Do not zip-upload the hub. Steps: [DEPLOYMENT.md](../DEPLOYMENT.md).

---

## 1. Use the hub (first time)

1. Deploy the hub per [DEPLOYMENT.md](../DEPLOYMENT.md).
2. Open **https://asoldi.com/superadmin**.
3. Log in with the same credentials as `/admin` on this site. Username is **`asoldi.com`**.
4. Click **Add site**:
   - **Name:** e.g. Mong Sushi
   - **Domain:** e.g. `mongsushi.no`
   - **Website plan:** Tier 1 / Tier 2 / Tier 3 / Custom
   - If ecommerce is included, pick **catalog type** (menu, tiers, or normal products)
   - **GitHub repo** (optional): Maker fills this on Publish (`Damianhch/website---{slug}`)
5. Save and **copy the site key**. Maker writes it into `cms.config.json`; you only need Hostinger env if that file is missing.

Edit the site later to toggle Users, Analytics, Ecommerce, Blog, and Social sync.

---

## 2. Add CMS to a new client (every new website)

1. In **https://asoldi.com/superadmin**: Add the site (or let Maker Publish register it). Copy the site key only if you will set env by hand.
2. **Website Creator → Publish to GitHub.** That private repo **is** the website: Express `server.js`, Maker HTML in `public/`, vendored CMS, `cms.config.json`. No SFTP. No Hostinger API “create website”.
3. **Once in hPanel:** Websites → Add Website → Node.js web app → Import that GitHub repo. Framework **express**, entry **`server.js`**, **empty build**, Node **22**.
4. Later publishes are `git push` only. Hostinger auto-deploys `main`.

Client CMS JSON and CMS-uploaded media (images, video, audio) live on that Hostinger disk at `~/.asoldi-cms-data/<siteKey>`. They are **not** in Git. Generated page images from Maker **are** in Git `public/` — that is the public website.

Hand-built React clients (Mong Sushi) keep their own `server.js` and classic Git until you choose to migrate. Do not recreate them as a Node.js web app while Vite is still in `package.json`. Full steps: [CLIENT-SITE-DEPLOYMENT.md](CLIENT-SITE-DEPLOYMENT.md).

---

## 3. Change a client domain later

Sites are identified by **site key**. Domain is for display and lookup when the client does not send a key.

1. In superadmin, edit the site and set **Domain** to the new host.
2. If the hub URL itself changes, set `CMS_HUB_URL` on every client host. **CMS_SITE_KEY** does not change.
