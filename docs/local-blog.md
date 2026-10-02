# Local service posts

Each client site with Blog turned on can write up to 10 posts a month about its own services. The town from Kundedata is mentioned at most twice, and only when the sentence needs it. Posts are text only. A person adds a cover later in the client blog editor, from that site’s media library.

This is not a page of links to other clients. The client CMS asks Asoldi for its own brief and does not receive other customers.

## Who talks to whom

The client CMS calls:

`GET /api/hub/local-blog-brief`

Headers: `Authorization: Bearer <LOCAL_BLOG_TOKEN>` and `X-Site-Key: <site key>`.

The token is not the site key. Admin issues it with `POST /api/hub/sites/:id/local-blog-token` from the site card (Manage clients → Clients, when Blog is on). The plaintext is shown once. Asoldi stores only a hash (`lib/local-blog-token.js`). Replacing the token stops the previous Hostinger value.

The brief (`lib/local-blog-brief.js`) is that site’s business name, what they do, service names and descriptions, address, town, language, and hours. It is built from the sales client linked by `hubSite.siteKey`, then that client’s portal `clientDataBank`. It does not include email, phone, prices, media files, or any other client.

If Blog is off, or the brief has no service and no real description, the job writes nothing.

## Hostinger env

Nothing in this repo writes the Hostinger env tab. Paste these on that site:

- `DEEPSEEK_API_KEY`
- `DEEPSEEK_MODEL` optional, default `deepseek-chat`
- `LOCAL_BLOG_TOKEN` the token from the site card
- `LOCAL_BLOG_ENABLED=1` only while Blog is on

`hubUrl` and `siteKey` stay in the client repo’s `cms.config.json`.

The writer lives in the client CMS. It checks about every six hours and publishes at most one post that is due, spread across the month. Existing live sites get it only after a republish that ships that CMS, plus the env values above.

A new site with no `posts.json` yet also gets three published test posts (`Testinnlegg`) the first time the CMS starts, so the blog page can be opened immediately. Each test post has its own test image in the media library. A site that already has a posts file is left as it is. The monthly posts still have no image.
