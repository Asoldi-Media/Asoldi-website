# Hub and client CMS – quick setup

## This repo = hub + one client (this site)

- **Super-admin (you):** https://seashell-camel-446716.hostingersite.com/superadmin  
  When you move to asoldi.com, use https://asoldi.com/superadmin. Same login as this site’s /admin.
- **Client CMS (this site):** https://seashell-camel-446716.hostingersite.com/admin  
  Features are controlled from the hub (super-admin). No need to set `CMS_SITE_KEY` if you add this site in the hub with the same domain.

---

## 1. Use the hub (first time)

1. Deploy this repo to Hostinger (or your host) so it serves the main site.
2. Open **/superadmin** (e.g. https://seashell-camel-446716.hostingersite.com/superadmin).
3. Log in with the same credentials you use for **/admin** on this site.
4. Click **Add site**:
   - **Name:** e.g. Asoldi (or Mong Sushi for a client).
   - **Domain:** e.g. `seashell-camel-446716.hostingersite.com` for this site, or `mongsushi.no` for the client.
5. Save and **copy the site key** (long hex string). For client projects you’ll set it as `CMS_SITE_KEY` in env.

To have **this** site’s /admin driven by the hub, add a site in super-admin with domain = this site’s host (e.g. `seashell-camel-446716.hostingersite.com`). Then /admin will load config by domain and show only the features you turn on for that site in the hub.

---

## 2. Add CMS to a client (e.g. mongsushi.no)

**Full step-by-step (including Hostinger env):** see **[CLIENT-SITE-DEPLOYMENT.md](CLIENT-SITE-DEPLOYMENT.md)**.

Short version:

1. In the **hub** (/superadmin): Add site **Mong Sushi**, domain **mongsushi.no**. Copy the **site key**.
2. In the **mongsushi.no project**:
   - Configure npm for GitHub Packages and install: `npm install @damianhch/client-cms` (see [PUBLISH-NPM-PACKAGE-WALKTHROUGH.md](PUBLISH-NPM-PACKAGE-WALKTHROUGH.md) Part E).
   - In the server: mount the CMS routes at `/api/cms`. Example:
     ```js
     import createCmsRoutes from '@damianhch/client-cms';
     app.use('/api/cms', createCmsRoutes({
       hubUrl: process.env.CMS_HUB_URL || 'https://asoldi.com',
       siteKey: process.env.CMS_SITE_KEY,
       dataPath: './data',
     }));
     ```
   - In the React app: add `<Route path="/admin" element={<ClientCMS />} />` and import `ClientCMS` from `@damianhch/client-cms`.
   - On Hostinger (or host): set `CMS_HUB_URL` and `CMS_SITE_KEY=<paste key>` (see CLIENT-SITE-DEPLOYMENT.md).
3. Deploy mongsushi.no. Then **mongsushi.no/admin** will show the Client CMS and only the features you enabled in the hub for that site.

Repeat for each of your 10+ clients: add site in hub → install package + mount routes + route → set env → deploy.

---

## 3. Change domain later (universal)

When you move this site from the test URL to **asoldi.com**:

1. In the hub (still on test URL or already on asoldi.com), edit the site and set **Domain** to **asoldi.com**.
2. If the hub itself moves to asoldi.com, set **CMS_HUB_URL=https://asoldi.com** on every client host. **CMS_SITE_KEY** does not change.

Sites are identified by **site key** in the hub; domain is just for display and for lookup when the client doesn’t send a key. So changing domain in the hub does not break existing client installs.
