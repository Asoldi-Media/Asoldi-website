# Owner recipients and owner notices

Who at a client's business receives the site's notices (new orders, form submissions, checkouts
started, the daily digest and the SEO report), how a client CMS changes that list safely, and how
those notices are sent. Code: `lib/email-owner.js`, routes in `lib/routes/email-owner-routes.js`.
The resolver itself (`resolveOwnerRecipients`) is in `lib/owner-recipients.js`.

Everything here is off while the e-mail platform is off (email setting `enabled`, the default):
every route below answers `404 {"code":"disabled"}` before any other check and nothing is written.
One exception: the confirm and revert pages stay open while a change younger than 7 days that was
not reverted exists, so a revert link in a delivered change notice keeps working if the platform is
switched off again.

## Who receives a notice

Only **confirmed** owner addresses: the confirmed rows of the site's `ownerRecipients` in
`email-sites.json`, or, when there are none, `clientAdmin.email` (Asoldi entered it). A pending
address never receives a notice and is never a test recipient of the relay. The sales client's
contact address is not used. Without a confirmed owner a notice goes to Asoldi's inbox with the
subject prefixed `[Ingen eier-e-post satt]`, as client forms do; an SEO report is then not sent.

Notices go through the hub mailer (Resend, or SMTP; the safe-mode outbox in safe mode), never
through Brevo, and carry no unsubscribe link: they go to the business, not to its customers.

## CMS-facing routes

Both need the site's emailKey (`x-email-key`, see `docs/email-credential.md`; the site key alone gets
`401`), allow 120 requests a minute per site (then `429 rate_limited`), and answer
`403 {"code":"not_enabled"}` for a site outside the e-mail rollout.

### `PUT /api/hub/email/owner-recipients`

Body `{ "emails": ["eier@example.com", "ny@example.com"], "actor": { "username": "kari", "rank": "owner" } }`.
The CMS sends the signed-in user's name and rank; it calls this route only for an owner-rank user.

| Answer | When |
|---|---|
| `200 [{email, status}]` | The new list (same shape as `GET /api/hub/email/owner-recipients`). An unchanged list answers the same without a change record or mail. |
| `403 {"code":"forbidden"}` | `actor.rank` is not `owner` (an employee, or no actor). Nothing changes. |
| `400 {"code":"bad_recipient"}` | `emails` is not a list of valid addresses. |
| `400 {"code":"too_many","max":3}` | More than 3 distinct addresses. |
| `429 {"code":"change_rate","retryAt"}` | More than 10 changes for the site in one Oslo day. |

What a change does:

- An address that is already confirmed stays confirmed. Every other listed address becomes
  `pending` (`source: "owner"`) and receives a **confirm link**. Addresses not listed are removed.
- The **previous** confirmed owners (or `clientAdmin.email` when there were none) receive a change
  notice: who changed it, when, the list before and after, and a **revert link** ("Var det ikke
  deg? Angre endringen"). Without a previous owner there is no notice (logged).
- Both links are valid for **7 days**. The change is recorded in `email-owner.json` before the site
  row changes, so a change that took effect can always be reverted.
- A mail that cannot be sent is logged and does not fail the change.

### `POST /api/hub/email/owner-notify`

Body `{ "kind": "order", "subject": "Ny bestilling – 598 kr", "text": "…", "html": "…", "dedupeKey": "ord_123" }`.

- `kind`: `order`, `form`, `checkout-started` or `digest`. Anything else, `seo-report` included,
  gets `400 {"code":"bad_kind"}`.
- `subject`: 1–200 characters (control characters removed), else `400 bad_subject`. `text` is
  required (`400 empty_body`), at most 50 KB; `html` is optional, at most 200 KB (`413 too_large`).
- `dedupeKey`: required, control characters removed, at most 120 characters (`400 bad_ref`). A key
  already sent for the site and kind in the last 30 days answers `409 {"code":"duplicate"}` and
  sends nothing (a CMS treats it as sent).
- Links: every link and image in the `html` must be on the site's own hosts (its domain, the
  `www` variant, and the superadmin's `allowHosts`), and the markup the relay refuses (`script`,
  `iframe`, `svg`, …) is refused here too: `422 {"code":"link_not_allowed","host","reason"}`. An
  address that is only text, such as one a visitor typed into a form, is not checked.
- At most **50 sent notices per site per Oslo day**; the 51st gets
  `429 {"code":"owner_rate","retryAt"}` (the next Oslo midnight). Duplicates do not count.
- A send that fails answers `502 {"code":"provider_unavailable"}` and gives its count and dedupe key
  back, so the CMS can try again.
- Success: `200 {"ok":true}`.

## The confirm and revert pages

`GET` and `POST /api/hub/email/owner-recipients/confirm?t=` and `…/revert?t=`. GET shows a page with a
button; only the POST (the button) changes state. Pages are Norwegian, load nothing external and
send `noindex`. The POSTs allow 10 requests per link and 300 per client address in 10 minutes.

- Confirm: the pending address becomes confirmed (`200`); a repeat answers the same page. A link
  whose change was reverted, or whose address is no longer on the list, answers `400`; an expired
  link `410`.
- Revert: the site's list becomes exactly the list from before the change; that change and every
  later change of the site are marked reverted (their confirm links stop working). A second click
  answers "allerede angret" without a write; an expired link `410`.

Tokens are `v1.<payload>.<mac>`: the payload holds the action, the site id, the change id, the
expiry and (for a confirm) the first 32 hex characters of sha256 of the address, never the address
itself. The mac is HMAC-SHA256 with a key derived from `secrets/email-unsub-key`; deleting that file
voids every link.

## What is stored

- `email-sites.json`: the owner rows keep their shape `{email, status, confirmedAt, source}`.
- `email-owner.json`: `{ changes: [{id, siteId, at, actor:{username, rank}, previous, next,
  revertedAt}], notices: { <siteId>: { day, count, changes:{day, count}, keys:{<hash>: <ms>},
  seoReportAt } } }`. Change records and dedupe keys older than 30 days are dropped on the next
  write. It is written only once the platform is on and a CMS uses these routes.

## SEO report (hub-internal)

The hub's SEO report builder sends its monthly notice through the same path, as a function, never
through the site route:

```js
import { sendOwnerNotice } from './lib/email-owner.js';
const result = await sendOwnerNotice(site, {
  kind: 'seo-report',
  subject: 'SEO-rapport for november',            // at most 150 characters
  text: 'Se rapporten: https://<site domain>/admin/…', // a link to the CMS analytics panel on the site's own host
  html: '<p>…</p>',                                // optional; links only to the site's own hosts
  dedupeKey: 'seo-report:2026-11',                 // seo-report:<period>
});
// { status: 200, body: { ok: true } } or { status, body: { ok: false, code } }
```

- Confirmed owners only: without one the answer is `409 {"code":"no_owner"}` and nothing is sent
  (no fallback to Asoldi's inbox).
- At most one per site per 7 days: `429 {"code":"too_soon","retryAt"}`. It also counts towards the
  50 notices a day, and the same `dedupeKey` twice is `409 duplicate`.
- No attachments. Same mailer and the same answers as the site route above.
- The function does not read the e-mail platform switch; the caller's own switch decides whether a
  report is sent at all.
