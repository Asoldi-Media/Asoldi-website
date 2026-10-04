# CMS contract — feelers, wiring, fleet push

Four layers. Do not mix them.

| Layer | What | Where | CMS-only fleet push |
|---|---|---|---|
| CMS software | Admin UI + `/api/cms/*` | `website-cms` → Maker vendor snapshot → each `website---` `vendor/client-cms` | **Replaced** |
| Site wiring | Forms and slots bound to CMS endpoints | Git `public/*.html` + `cms.site.json` | Untouched |
| Client content | Users, products, posts, leads, uploads, visual-editor patches | Hostinger `~/.asoldi-cms-data/<siteKey>` | Untouched |
| Hub flags | Which modules are on | asoldi.com superadmin | Untouched |

`/developer` is not the CMS. During development the CMS is the shared package. Live it is the same package inside the client repo.

## Hard rules

1. **One CMS for every client.** No per-client CMS routes, JSX, or schema in Hostinger JSON. Hub flags hide modules. A later richer CMS is a new version of the same package that still implements the old endpoints.
2. **Maker never edits CMS software.** Step 3 only stamps HTML and `cms.site.json`. New behaviour = add a feeler in `website-cms`, then bind the site to it.
3. **CMS-only fleet push never writes** `public/`, `cms.site.json`, or `cms.config.json`, and never touches Hostinger disk. Full Maker **Publish to GitHub** is the path that changes the website and the wiring.
4. **Feelers are additive.** New endpoints, slots, or schema keys may be added. Removing or renaming one is a major version; the fleet job refuses any site whose `cms.site.json` still uses it.
5. **Pushing `website-cms` `main` does nothing to clients.** Push the CMS repo, then Admin → Manage clients → Clients chooses who gets it.

The feeler catalog ships in the client CMS package (`server/capabilities.js`). Maker Step 3 reads it. The AI must not invent endpoints.

## How a new CMS version reaches live sites

1. Change CMS in `website-cms` (sync into Maker vendor with `node scripts/sync-client-cms.mjs`).
2. Push `website-cms` to GitHub if that repo is the source. Clients are unchanged.
3. Open Admin → Manage clients → **Clients**. Each card shows the running CMS version from the last heartbeat. Push that card, or select several and **Push CMS to selected**.
4. Confirm. The browser calls local Maker at `http://127.0.0.1:3000` (`GET/POST /api/cms-fleet`). asoldi.com does not push Git.
5. Maker replaces `vendor/client-cms` in each selected `website---` repo, commits, pushes `main`. Hostinger auto-deploys. Disk data stays.

## Related

- `docs/deployment-split.md` — Git vs Hostinger disk vs hub
