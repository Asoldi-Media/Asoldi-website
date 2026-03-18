# Add CMS to a client site – step-by-step (including Hostinger)

Use this when you want to add the Client CMS to a **client website** (e.g. mongsushi.no) so they get **theirdomain.com/admin**. You already have the main Asoldi site with super-admin; here we set up one client from scratch.

---

## Summary

1. **Hub (main site):** Add the client in super-admin and copy the **site key**.
2. **Client project:** Install the CMS package, mount API routes, add `/admin` route.
3. **Hostinger (client):** Set env vars and deploy.

After that, **clientdomain.com/admin** shows the CMS with only the features you enabled in the hub for that site.

When the **Users** feature is enabled for a client, the client CMS must support **changing user role** (employee, client, none). See [CMS-USER-ROLES.md](CMS-USER-ROLES.md) for the contract.

---

## Step 1 – In the hub (main Asoldi site)

1. Open your main site’s **Admin → Manage clients**: e.g. `https://asoldi.com/admin`, then click **Manage clients** in the sidebar.
2. Log in (same credentials as before for /admin).
3. Click **Add site**:
   - **Name:** e.g. Mong Sushi
   - **Domain:** e.g. `mongsushi.no` (the client’s live domain, or test domain for staging).
4. Save, then **copy the site key** (long hex string). You will use this as `CMS_SITE_KEY` on the client.

---

## Step 2 – In the client website project (on your machine)

Do this in the **client’s repo** (e.g. the mongsushi.no project), not the main Asoldi repo.

### 2a. Configure npm for the private package (local + Hostinger)

So the client project can install `@damianhch/client-cms` from GitHub Packages:

**On your machine (local dev – one-time per machine or project):**

- Set the scope registry (PowerShell, use quotes):
  ```bash
  npm config set "@damianhch:registry" "https://npm.pkg.github.com"
  ```
- Log in:
  ```bash
  npm login --registry=https://npm.pkg.github.com
  ```
  Use your GitHub username and a **Personal Access Token** (with `read:packages`) as the password.

**In the client project repo (works on Hostinger too):**

- In the **root of the client project**, create or edit `.npmrc` with:
  ```ini
  legacy-peer-deps=true
  @damianhch:registry=https://npm.pkg.github.com
  //npm.pkg.github.com/:_authToken=${NPM_TOKEN}
  ```
  - Commit this file – it does **not** contain the token itself.
  - `NPM_TOKEN` will be provided as an env var on Hostinger.

Full details: **[PUBLISH-NPM-PACKAGE-WALKTHROUGH.md](PUBLISH-NPM-PACKAGE-WALKTHROUGH.md)** → Part E (steps 1–2).

### 2b. Install the CMS package

```bash
cd path\to\client-website
npm install @damianhch/client-cms
```

### 2c. Mount the CMS in the client app (you do this by hand)

Two places: the **server** (API) and the **React app** (route). Same steps for every client project.

---

**Part A – Server (API)**

1. Find the file where you create the Express `app` and define routes (often `server.js`, `app.js`, or `index.js` in the project root or a `server/` folder).
2. At the **top**, with the other imports, add:
   ```js
   import createCmsRoutes from '@damianhch/client-cms';
   ```
3. Ensure the server parses JSON bodies. If you already have `app.use(express.json());`, leave it. If not, add it once (e.g. right after `const app = express();`):
   ```js
   app.use(express.json());
   ```
4. Mount the CMS API **before** any `express.static(...)` or catch-all `app.get('*', ...)` so that `/api/cms/*` is handled by the CMS and not by static files or the SPA fallback. Add:
   ```js
   app.use('/api/cms', createCmsRoutes({
     hubUrl: process.env.CMS_HUB_URL || 'https://asoldi.com',
     siteKey: process.env.CMS_SITE_KEY,
     dataPath: './data',
   }));
   ```
   Put this right after `express.json()` and before `app.use(express.static(...))` (and before any `app.get('*', ...)`).

That’s the API. The CMS will use a `data/` folder in the project root (create it if it doesn’t exist; the package will write admin and users there).

---

**Part B – React app (route + hide client layout on /admin)**

1. Find the file where you define your routes (usually `App.jsx`, `App.tsx`, or a router file that uses `<Routes>` and `<Route>` from `react-router-dom`).
2. At the **top**, with the other imports, add:
   ```js
   import { ClientCMS } from '@damianhch/client-cms/ClientCMS';
   ```
   The package exports `ClientCMS` as a **named** export, so you must use `{ ClientCMS }` (not a default import).
3. In your existing React router file (e.g. `App.tsx`), add a small inner component so `useLocation` is called **inside** the router and the client navbar/footer are hidden on `/admin`. Example pattern (adjust names to your project):
   ```jsx
   function AppInner() {
     const [isMenuOpen, setIsMenuOpen] = useState(false);
     const { pathname } = useLocation();
     const isAdmin = pathname.startsWith('/admin');

     const toggleMenu = () => {
       setIsMenuOpen((open) => {
         const next = !open;
         document.body.style.overflow = next ? 'hidden' : 'unset';
         return next;
       });
     };

     return (
       <div className="min-h-screen bg-[#121212] font-sans selection:bg-[#E53935] selection:text-white">
         {!isAdmin && <Navbar onMenuToggle={toggleMenu} isMenuOpen={isMenuOpen} />}
         {!isAdmin && <MenuOverlay isOpen={isMenuOpen} onClose={toggleMenu} />}

         <main className="relative z-0">
           <Routes>
             <Route path="/admin" element={<ClientCMS />} />
             <Route path="/" element={<Home />} />
             <Route path="/meny" element={<Menu />} />
             <Route path="/om-oss" element={<About />} />
             <Route path="/blogg" element={<Blog />} />
             <Route path="/booking" element={<Booking />} />
           </Routes>
         </main>

         {!isAdmin && <Footer />}
       </div>
     );
   }

   function App() {
     return (
       <HelmetProvider>
         <Router>
           <ScrollToTop />
           <AppInner />
         </Router>
       </HelmetProvider>
     );
   }
   ```
   - Always add the `/admin` route with `<Route path="/admin" element={<ClientCMS />} />`.
   - The `AppInner` pattern is universal: `useLocation` stays inside the router and every client project hides its own layout on `/admin` so the CMS can take the whole page.

**Part C – Tailwind: include CMS styles (do this in every client that uses Tailwind)**

The CMS package uses Tailwind classes. By default your build only scans your own source files, so those classes get purged and the CMS looks unstyled (everything in a corner, no sidebar styling).

- Open the **main CSS file** where you `@import "tailwindcss"` (e.g. `app/styles.css` or `src/index.css`).
- Right **after** the tailwind import, add one line so Tailwind also scans the CMS package:
  ```css
  @import "tailwindcss";

  /* So CMS Tailwind classes are not purged */
  @source "../node_modules/@damianhch/client-cms/**/*.jsx";
  ```
- Path is relative to that CSS file: if your CSS is in `app/styles.css`, use `../node_modules/...`; if in `src/index.css`, use `../node_modules/...`; adjust if your structure differs.
- Rebuild. The CMS at `/admin` should then show with full layout and styling.

If the client project does **not** use Tailwind, skip this step (the CMS will still work but look very basic unless the package is changed to ship its own CSS).

---

After this, run the client site and set `CMS_HUB_URL` and `CMS_SITE_KEY` in env (or `.env`). Then open **yourclientdomain.com/admin** (or localhost/admin) to use the CMS.

---

## Step 3 – Env vars on Hostinger (client deployment)

On the **client’s** Hostinger (or other host), set these in the **environment variables** (or `.env` in production):

| Variable        | Example / value | Required | Used for |
|----------------|-----------------|----------|----------|
| `CMS_HUB_URL`  | `https://asoldi.com` or your main site URL (e.g. test URL) | Yes | Where the CMS talks to the hub API |
| `CMS_SITE_KEY` | The **site key** you copied from super-admin in Step 1 | Yes | Identifies this client in the hub |
| `NPM_TOKEN`    | `ghp_...` GitHub PAT with `read:packages` | Yes | Lets Hostinger install `@damianhch/client-cms` |

- **CMS_HUB_URL** – Base URL of the main Asoldi site (the hub). The client CMS calls `{CMS_HUB_URL}/api/hub/site-config` (or equivalent) to get features. Use your production URL when the hub is on asoldi.com, or the test URL for staging.
- **CMS_SITE_KEY** – Identifies this client in the hub. Paste the key you copied when you added the site in Admin → Manage clients (main site).
- **NPM_TOKEN** – GitHub Personal Access Token with `read:packages` (and `repo` if the package repo is private). This is read by `.npmrc` so Hostinger’s `npm install` can download `@damianhch/client-cms` without 401 errors.

If the client CMS package also has its own **admin login** (separate from the hub), you may need to set admin credentials on the client host as well (e.g. `CMS_ADMIN_USERNAME`, `CMS_ADMIN_PASSWORD`). Check the **@damianhch/client-cms** README or docs for that. For the hub connection and install, the three above are what you need.

---

## Preserve hub data when you deploy the main site

The hub stores client sites in **`data/sites.json`** on the **main site’s server**. That file is in `.gitignore`, so it is **not** in the repo. When you deploy updates to the main site (Asoldi):

- **Keep** the `data/` folder (and `data/sites.json`) on the server. Many hosts do not overwrite ignored files; if yours does a full clean deploy, back up `data/sites.json` before deploy and restore it after, or re-add each client in Admin → Manage clients and set **CMS_SITE_KEY** on each client again.
- If the list in Manage clients is empty after a deploy, the file was reset—add mongsushi.no (and any other clients) again, copy each site key, and update the client’s **CMS_SITE_KEY** env var so their CMS continues to work.

---

## Step 4 – Deploy the client site

Build and deploy the client project to Hostinger (or your usual process). Ensure the env vars from Step 3 are set in the Hostinger panel for that project.

After deployment:

- Open **clientdomain.com/admin**.
- You should see the Client CMS and only the features you enabled for that site in the hub (Users, Analytics, Ecommerce, etc.).

---

## Quick reference – which doc does what

| Doc | Use it for |
|-----|------------|
| **[PUBLISH-NPM-PACKAGE-WALKTHROUGH.md](PUBLISH-NPM-PACKAGE-WALKTHROUGH.md)** | Creating/publishing the npm package; **Part E** = installing it in a client (registry + login + `npm install`). |
| **[SETUP-HUB-AND-CLIENTS.md](SETUP-HUB-AND-CLIENTS.md)** | Hub vs client overview; adding a site in the hub; code snippet for mount + route (same as Step 2c above). |
| **This file (CLIENT-SITE-DEPLOYMENT.md)** | End-to-end: hub → client project → **Hostinger env** → deploy for one client site. |

---

## Changing domain later

If the client’s domain changes (e.g. mongsushi.no → newdomain.com):

1. In the hub (Admin → Manage clients), edit the site and set **Domain** to the new domain.
2. On the client host, you can leave **CMS_SITE_KEY** as is (sites are identified by key). Only update **CMS_HUB_URL** if the main Asoldi hub URL changes.
