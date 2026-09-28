# Client CMS: single per client + hub – implementation plan

This is the “how we do it” for **one CMS per website** that connects to your **hub** (super-admin). Example: add CMS to **mongsushi.no** and any future client.

---

## 1. Architecture in one picture

```
mongsushi.no (Hostinger)
├── Website (existing: design, SEO, etc.)
└── /admin → Client CMS (same codebase you copy per client)
              ├── Reads env: CMS_HUB_URL, CMS_SITE_KEY (or CMS_DOMAIN)
              ├── On load: GET hub → “features for this site?”
              └── Shows only: Analytics, Ecommerce, Blog, Social sync, Users (whatever hub returns)

hub.asoldi.com (one deployment – your super-admin)
├── You log in → list of sites, website plan, catalog type, turn features on/off per site
└── API: GET /api/hub/site-config?domain=mongsushi.no (or by site_key)
         → { features, ecommerceCatalogType, websitePlan, desiredCmsVersion, name, id }
```

- **Client CMS** only loads when someone visits **domain.com/admin**. Rest of the site is unchanged. No slowdown.
- **Hub** is one app; it only stores site list + feature flags. It does not store client products or analytics data; that stays on each client’s server.

---

## 2. What lives where

| What | Where |
|------|--------|
| Client CMS UI + API (users, products, etc.) | Inside each client’s repo (e.g. mongsushi.no project). Same codebase, copied or from template. |
| Client data (users, products, analytics config) | Same server as the client site (e.g. `data/` or DB on Hostinger). |
| List of sites + feature flags (ecommerce on/off, etc.) | Hub (super-admin). One deployment. |
| Your “turn on ecommerce for this client” UI | Hub (super-admin). |

---

## 3. Build order

**Step 1 – Client CMS “template” (this repo)**  
- Current `/admin` is the **client** CMS (not agency).  
- Add **feature flags from env** first (no hub yet): e.g. `CMS_FEATURES=users,analytics` or per flag.  
- Sidebar shows only enabled modules (e.g. Users, Analytics, Ecommerce).  
- So: one codebase that can run standalone with env, or later with hub.

**Step 2 – Hub (minimal)**  
- Small app (e.g. Express) or even a static JSON + serverless function.  
- Stores: `sites[]` with `domain`, `site_key`, `websitePlan`, `ecommerceCatalogType`, `features: { ecommerce, analytics, users, blog, socialSync }`.  
- API: `GET /api/hub/site-config?domain=mongsushi.no` or `?site_key=xxx` → returns features, catalog type, and plan.  
- `POST /api/hub/heartbeat` records client CMS `packageVersion` for fleet updates.  
- Optional: simple UI for you to add a site and toggle features (or edit JSON/file at first).  
- Deploy once (e.g. hub.asoldi.com or asoldi.com/superadmin).

**Step 3 – Client CMS calls hub**  
- If `CMS_HUB_URL` is set, on `/admin` load the CMS calls hub, gets features, and shows only those modules.  
- If not set, use env or default (e.g. users only).  
- So: same CMS code works with or without hub.

**Step 4 – Add CMS to mongsushi.no**  
- Copy the client CMS (same folder structure / files) into the mongsushi.no project.  
- In that project: add route `/admin`, env `CMS_HUB_URL`, `CMS_SITE_KEY` (or `CMS_DOMAIN=mongsushi.no`).  
- In hub: register site `mongsushi.no`, enable features you want.  
- Deploy mongsushi.no to Hostinger. When they go to mongsushi.no/admin they see only what you granted.

**Step 5 – Reuse for every new client**  
- New client = new site in hub + copy same CMS into their project + set env + deploy. Same as Step 4.

---

## 4. “Install” CMS on a new client (e.g. mongsushi.no)

**In the hub (you, once per client):**  
1. Add site: domain `mongsushi.no`, name “Mong Sushi”.  
2. Enable features: e.g. Users ✓, Analytics ✓, Ecommerce ✓ (or only what they need).  
3. Copy the **site key** (or use domain-based lookup).

**In the client project (mongsushi.no repo):**  
1. Add the client CMS files (copy from your “client CMS template” repo or use an npm package that bundles the CMS).  
2. Ensure the site has a backend that can serve the CMS (e.g. same Express that serves the site, or add the CMS routes to it).  
3. Set env (Hostinger or .env):
   - `CMS_HUB_URL=https://hub.asoldi.com`
   - `CMS_SITE_KEY=<key from hub>`  
   - Or `CMS_DOMAIN=mongsushi.no` if hub looks up by domain.  
4. Deploy.  
5. Client goes to **mongsushi.no/admin** → CMS loads → calls hub → gets features → shows only granted modules. No impact on the rest of the site; only loads when they open /admin.

**Copyable:** The “client CMS template” is one folder (or package): same UI, same API routes for users/products, same env contract. You don’t change code per client; only config (env) and hub registration.

---

## 5. Performance and “only load when needed”

- **CMS code (JS/CSS)** is only loaded when the user visits **domain.com/admin**. The rest of the site (home, menu, etc.) does not load the admin bundle. So no slowdown for normal visitors.  
- **Single per client:** Each site has its own server and data. mongsushi.no’s traffic doesn’t affect another client. No multi-tenant DB.  
- **Hub:** One lightweight request on /admin load (get config). Can be cached (e.g. 5 min) so you don’t hit the hub on every click. Fast enough.

---

## 6. Summary

- **Multi-tenant:** Not chosen; you want easy install, copyable, and no risk of slowing everyone down.  
- **Single per client + hub:** Each client gets the same CMS in their project; it connects to one hub that only stores “which features does this site have?”. Fast, simple to add to mongsushi.no and every future client, and plays nice with your flow (design → Cursor → deployment prompt → add or include CMS → domain.com/admin shows what you granted).

---

## Done in this repo

- **Hub API** – `GET /api/hub/site-config?site_key=xxx` or `?domain=xxx` returns `{ features, ecommerceCatalogType, websitePlan, desiredCmsVersion, name, id, domain }`. Sites stored in persistent `sites.json` (see `data/hub.js`). Website plan sets default flags: Tier 1 users; Tier 2 + blog + socialSync + analytics; Tier 3 + ecommerce + analytics. Ecommerce catalog type is `menu` | `tiers` | `normal`.
- **Heartbeat** – `POST /api/hub/heartbeat` with `site_key` + `packageVersion` + `adminUrl` (no admin JWT). Super-admin shows last-seen CMS version and optional GitHub repo for later fleet bumps.
- **Admin (hub + client CMS)** – **/admin** and **/superadmin**: same login. Sidebar: **Manage clients** (hub sites, site keys, plan, catalog type, feature badges), **Users**, Analytics, Ecommerce, Blog, Social sync (placeholders except client ecommerce which lives on each client domain). When **Users** is enabled, admins can create users and set each user’s role (employee, client, none). New users default to **none**; only **employee** can access the Ansatt page.
- **Client CMS** – On this site, **/admin** fetches `GET /api/cms/config` (lookup by `CMS_SITE_KEY` or by Host). Sidebar shows only modules according to hub. This site is a client of itself: add it in the hub with domain `asoldi.com` (or current host); optionally set `CMS_SITE_KEY` in env.
- **Installable** – **@damianhch/client-cms** npm package (from [website-cms](https://github.com/Damianhch/website-cms)): install in any project, mount routes at `/api/cms`, add route for `/admin` with `ClientCMS`. Set `CMS_HUB_URL` and `CMS_SITE_KEY` on the client host. Public catalog: `GET /api/cms/catalog`.
