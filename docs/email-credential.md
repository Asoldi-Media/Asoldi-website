# Email credential (emailKey) and hub ↔ CMS email calls

The client CMS never holds the Brevo key. It asks the hub to send, and the hub sends through
Brevo on its behalf. Those calls need a credential that only the hub and the site's own CMS server
know. The site key cannot be that credential: it is a public identifier (the Maker writes it into
published form HTML), so **the site key never authenticates an email call**.

Each site therefore gets an **emailKey**: 32 random bytes, base64url (43 characters), with a key id
`ek_<n>`. Code: `lib/email-site-auth.js`, `lib/email-hint.js`, routes in
`lib/routes/email-hub-routes.js` (provisioning, unsubscribe pages, superadmin) and
`lib/routes/email-site-routes.js` (the site API the CMS calls with its key, and the wake).

Everything here is off until a superadmin turns the email platform on (email setting `enabled`,
default `false`). While it is off, every `/api/hub/email/*` route answers `404 {"code":"disabled"}`
and writes nothing. One exception: once Brevo has accepted a relay send (the relay then writes
`email-relay-sent.json` once), the unsubscribe pages stay open even if the platform is switched off
again, so the links in delivered mail keep working. Sandbox and safe-mode outbox sends do not count,
and neither does a line in the message log. To pause sending, use `killSwitch` instead.

## Provisioning is a pull

```
CMS                                                   hub
 │ POST /api/hub/email/provision-request               │
 │   x-site-key: <site key>                            │
 │   x-site-credential: <site credential>              │
 │ ───────────────────────────────────────────────────▶│ credential valid and a key pending?
 │◀─────────────────────────────────────────────────── │   {"ok":true,"keyId":"ek_1","emailKey":"…"}
 │                                                     │ otherwise {"ok":true}
 │ store the key as PENDING (private data folder)      │
 │ POST /api/hub/email/provision/confirm               │
 │   x-email-key: <pending key>                        │
 │ ───────────────────────────────────────────────────▶│ a pending key the hub issued?
 │◀─────────────────────────────────────────────────── │   200 {"ok":true,"keyId":"ek_1"}  → hub commits
 │ commit the key on 200                               │   401 {"ok":false,"code":"unauthorized"}
```

- The site credential is the one from site-credential enrollment (`lib/site-credentials.js`,
  header `x-site-credential`). Without a valid one the answer is always `{"ok":true}`, so a caller
  with only the public site key learns nothing and gets nothing.
- Where a pending key comes from: a superadmin issues it (`POST /api/admin/email/sites/:id/provision`),
  or the hub issues one on a credential-valid provision request for a site in the email rollout that
  has no pending key: its first key, or, when it already has a key, a new one (a rotation, below).
- At most **3 credential-valid provision requests per site and day** (Oslo day) are counted;
  later ones get `{"ok":true}`. Requests without a valid credential are not counted, so they
  cannot use up the site's allowance.
- A pending key authenticates nothing until it is confirmed.
- The confirm is idempotent for the current key (a CMS that lost the first answer can repeat it).
  A key the hub never issued, an expired previous key, the site key or the site credential all get
  `401`. When `x-site-key` is sent with the confirm, it must name the same site.

## Rotation and recovery

- **Rotate** (superadmin, the same provision route on a site that already has a key): the hub issues
  a new pending key and sends the CMS a signed `key-rotation` hint (signed with the current key).
  The CMS then pulls the new key with a provision request and confirms it. The current key keeps
  working until the confirm, and **for 10 minutes after it** (the previous key's grace window);
  then it gets `401`.
- **Recover or reconnect** (the CMS lost its key, the hub refused it, or the owner pressed "Koble
  til e-post på nytt"): the CMS sends a provision request with its site credential. For a site with a
  key and nothing pending, the hub issues a new pending key, as a rotation within the daily limit;
  the current key keeps working until the confirm and for 10 minutes after it. So the site
  credential alone is enough to recover, without a superadmin, and a CMS never has to give up its
  key to get a new one. A CMS keeps its own automatic requests to two a day, so the third stays for
  a hint or the owner.

## CMS → hub: `x-email-key`

Every CMS → hub email call sends `x-email-key: <emailKey>`. The hub checks it in constant time
against every site's current key and its previous key while that is inside its grace window
(`requireEmailKey()`), and refuses with `401 {"ok":false,"code":"unauthorized"}`:

- with the site key alone, with the site key and a valid site credential, or with any wrong key;
- when `x-site-key` is also sent and names another site.

## The site API (`lib/routes/email-site-routes.js`)

Every route below needs the emailKey (the 401 rules above). Each site may make **120 requests a
minute** across them; then `429 {"ok":false,"code":"rate_limited","retryAt"}` with `Retry-After`.
While the platform is off they answer `404 {"code":"disabled"}` like every other email route.

| Method and path | Body or query | Answer |
|---|---|---|
| `POST /api/hub/email/send` | the send body of `lib/email-relay.js` | `{ok, messageId, quota}` or the relay's error code |
| `POST /api/hub/email/contacts` | `{upsert:[{email}], remove:[email]}`, at most 500 | `{ok, synced, removed, sync}`; a no-op (`sync:false`) unless `brevo.syncContacts` is on |
| `DELETE /api/hub/email/contacts` | `{email}` | `{ok, erased, provider}`: the site's opt-out row moves to its tombstone key (`sha256:<hex>`, still blocking sends, no longer listed); Brevo's transactional log for the address is deleted, the address leaves the site list, and the Brevo contact is deleted only when no other list holds it |
| `GET /api/hub/email/quota` | | the site's own quota view, `campaigns {allowed, reason}`, `paused`, `suspended`; nothing about other sites |
| `GET /api/hub/email/suppressions` | `?since=<ISO>` | `{items:[{email, scope, source, at, updatedAt}], next}` |
| `GET /api/hub/email/stats` | `?campaignId=` or `?kind=&from=&to=` or `?refs=a,b` | `{byRef, totals}` for the site's own messages |
| `POST /api/hub/email/lint` | `{subject, html, text, kind}` | `{claims:[], claimsChecked:false, links:[{href, kind, ok, host, reason, tag}]}` (the relay's link check) |
| `GET /api/hub/email/owner-recipients` | | `[{email, status}]` |
| `POST /api/hub/email/campaigns`, `…/campaigns/:id/recipients`, `…/start`, `…/cancel`, `GET …/campaigns/:id`, `PUT /api/hub/email/owner-recipients`, `POST /api/hub/email/owner-notify` | | `501 {"code":"not_available"}` until those parts of the platform are built |

`POST /api/hub/email/brevo-webhook/:token` is the one `/api/hub/email/` route that takes another
credential: the hub's Brevo webhook token, in the path and in the `x-asoldi-webhook` header. Any
other token gets 404. Event handling is not built yet, so a valid call answers
`503 {"code":"not_ready"}` with `Retry-After`.

## The site-config `email` block

`GET /api/hub/site-config` (and `/api/cms/config`) carry an `email` block only for a site whose
email is on: the platform is on and the rollout lists the site. Every other site's answer is exactly
as before. For a listed site `email` is the **only** field that changes; it is on
`PUBLIC_SITE_CONFIG_FIELDS`, so a domain lookup carries it too. It never holds a key.

```json
"email": { "api": 1, "enabled": true, "provisioned": true,
           "kinds": ["cart-recovery","welcome","double-opt-in","back-in-stock","review-request","winback","campaign","test"],
           "campaigns": { "allowed": true, "reason": "" },
           "sender": { "mode": "asoldi", "fromName": "<the hub's name for the site>", "fromAddress": "kunder@asoldi.com" },
           "suspended": false, "paused": false }
```

- `enabled`: Brevo is configured, the data processing agreement is accepted or attested, and the
  site may send at least one kind. Otherwise `false` with `reason` `not_configured`, `dpa_missing`
  or `not_entitled`. A CMS treats `enabled:false` as "use the old behaviour".
- `provisioned`: the site's key is confirmed. A CMS that sees `false` pulls its key (provision
  request, confirm). A pending key alone is not provisioned.
- `kinds`: from the feature tree when the answer carries one, else from the legacy flags
  (`emailMarketing` gives welcome, double-opt-in and test; with `ecommerce` also cart-recovery,
  review-request, winback and back-in-stock). `campaign` only when campaigns are allowed.
- `campaigns.allowed`: the site is entitled to `email.campaigns`, the Brevo plan is known and not
  the free plan (or `brevo.campaignsOnFree` is on), and `brevo.termsConfirmedAt` is set. The relay
  applies the same rule to `kind: "campaign"`. `reason`: `not_entitled`, `free_plan`,
  `plan_unknown` or `terms_unconfirmed`.
- `paused`: the kill switch is on (a CMS holds its mail). When the site's email state cannot be
  read, the block says `paused:true` with `reason:"unavailable"`. The same holds while the email
  settings file exists but cannot be read (live file and backup): a site that the hub's last good
  read of the settings had switched on gets the paused block, so its CMS holds its mail instead of
  falling back after two answers without a block; a site it had not switched on gets no block.

## The wake

Every 5 minutes the hub calls `POST /api/cms/email/tick` on each site whose email is on (platform
on, kill switch off, in the rollout, key confirmed), signed like every hub → CMS call, four at a
time with a 10 s limit (`lib/email-wake.js`, lease `email-wake` so two hub workers do not both
wake). The CMS answers `{ran, dueSteps}` and runs its tick at most once a minute. Failed wakes are
counted per site in memory; three in a row are logged. `POST /api/admin/email/sites/:id/wake`
(superadmin) wakes one site now (`409 not_ready` when the site would not be woken).

## Hub → CMS: `x-asoldi-signature`

Every hub → CMS email call is signed with the site's current emailKey over its method, its path
with the query, and its body:

```
x-asoldi-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(emailKey, t + "." + METHOD + " " + path + "\n" + body)>
x-asoldi-key-id:    ek_<n>
```

- `METHOD` is the upper-case method; `path` is the request path with its query exactly as sent
  (for example `/api/cms/email/suppressions?since=2026-11-04T08%3A00%3A00.000Z`); `body` is the
  exact request body (the empty string for a GET).
- The CMS accepts a signature only when `t` is within **±300 s** of its own clock and the HMAC
  matches its committed key (or its previous key inside the grace window) for the method, path and
  body it received (compare in constant time). A call signed with the site key is refused, and a
  signature seen on one call opens no other path, query or method.
- The hub sends these calls only to `https://<site domain>` (the domain set in the hub). It never
  uses the CMS admin URL that heartbeats report, never follows a redirect, and gives up after 10 s.
  A site without a public domain, or without a committed key, is skipped.

Calls:

| Method and path on the CMS | Body | Purpose |
|---|---|---|
| `POST /api/cms/email/hub-event` | `{"type":"suppression","siteId":"…","at":"…"}` | The opt-out list changed: pull `GET /api/hub/email/suppressions?since=` |
| `POST /api/cms/email/hub-event` | `{"type":"key-rotation","keyId":"ek_2","siteId":"…","at":"…"}` | A new key is pending: provision-request, then confirm |
| `POST /api/cms/email/tick` | `{"type":"wake","siteId":"…","at":"…"}` | The wake: run the email tick now (at most once a minute); answer `{"ran":…,"dueSteps":…}` |
| `GET /api/cms/email/suppressions[?since=<ISO>]` | (empty) | The CMS's mirror of its opt-out rows, merged into the hub record by a rebuild. Answer `{"items":[{"email","scope","source","at","updatedAt"}],"next":<ISO or null>}` (`updatedAt` optional), at most 5 MB per page |

Hints carry no address. `verifyEmailSignature()` and `createReferenceCmsVerifier()` in
`lib/email-site-auth.js` are the reference implementation of the CMS side; the hub tests use them.

## Local tests: CMS target override

`devCmsTargets` in the email settings (`{"<siteId>":"http://127.0.0.1:<port>"}`) points hub → CMS
calls for a site at a local CMS. It is honoured only while `lib/runtime-mode.js` reports safe mode,
and only for loopback origins. A hub outside safe mode ignores it (and logs that once per site),
and the settings route refuses to store it there.

## Where the keys live

`secrets/email-secrets.json` (mode 0600, written through `data/email-store.js`):
`siteKeys[siteId] = { keyId, key, prevKeyId, prevKey, prevValidUntil, pending, seq }`. No route,
log line or data file outside `secrets/` holds a key; `email-sites.json` keeps only key ids and
times (`auth.keyId`, `auth.confirmedAt`, `auth.pendingKeyId`, `auth.provisionRequests`).

## Related email core routes

| Route | Who | Notes |
|---|---|---|
| `GET /api/hub/email/unsubscribe?t=` | public | Confirm page (nb/en, masked address, no external assets, `noindex`). Never changes state. |
| `POST /api/hub/email/unsubscribe?t=` | public | Form submit and RFC 8058 one-click (`List-Unsubscribe=One-Click`). Records the opt-out for the site. A repeat changes nothing (no write, no Brevo call, no hint). |
| `POST /api/hub/email/resubscribe?t=` | public | Undo from the page: once per address and site, within 30 days, and only for an opt-out made through a link. |

Both public POST routes allow 10 requests per token and 300 per client address in 10 minutes, then
answer 429 with `Retry-After`.
| `GET /api/admin/email/status`, `PUT /api/admin/email/settings` | superadmin | `enabled`, `rollout`, `killSwitch`, `brevo.sandbox`, `brevo.syncContacts`, `testRecipients` (and `devCmsTargets` in safe mode). |
| `POST /api/admin/email/sites/:id/provision` | superadmin | Issue the first key or rotate. Answers key ids only. |
| `POST /api/admin/email/suppressions/rebuild` | superadmin | Pull the CMS mirrors and merge them into the opt-out record (see below). `{"force":true}` writes even if a mirror did not answer; `{"base":{…}}` supplies a record for a lost one that has no snapshot. |
| `GET /api/admin/email/owner-routing/preview`, `PUT /api/admin/email/owner-routing/default` | superadmin | Owner-routing default for form and order notices (see `docs/runtime-data.md`). |

## Opt-out record: rows only get stronger

`email-suppressions.json` holds the client-site rows per site id, the global rows under `*` and
Asoldi's own marketing opt-outs under `asoldi`. Scopes rank `none` (resubscribed) < `marketing` <
`all`. An opt-out, a CMS mirror row or a pending row only adds a row or makes one stronger; it never
removes or weakens one, and the `asoldi` rows are never touched by client-site code.

- While the record cannot be read, opt-outs go to `email-suppressions-pending.jsonl`. Those rows
  count for every send check at once and are merged into the record as soon as it is readable
  again, however it came back (boot, the next opt-out or send, a rebuild). The file is then renamed
  `.applied-<time>`.
- A rebuild of a readable record merges the mirrors in. A lost record is rebuilt on top of its
  newest dated snapshot in `backups/` (or a superadmin-supplied record with an `asoldi` object),
  plus the mirrors and the pending rows. With no snapshot and no supplied record, or with no site to
  pull, nothing is written (`reason` `no_base` or `no_sites`) and every marketing send, Asoldi's
  included, stays blocked until the file is restored by hand.

## Link checks in relayed mail

The relay reads the HTML the way a browser's tokenizer does (comments, `<!…>` and `<?…>`
declarations, end tags with attributes, and `style`, `title` and `textarea` as text). It also
checks the tags inside comments (Outlook renders conditional comments), CSS `url()`, `@import` and
`image-set()`, `ping` and `srcset` lists, and every absolute URL anywhere in the HTML. It refuses
`script`, `noscript`, `iframe`, `svg`, `math`, `object`, `embed` and similar elements and
`meta` refresh outright (`422 link_not_allowed`, reason `markup`). The From name is the hub's name
for the site; the brand name the CMS sends appears only in the body.

The send pipeline (`relaySend` in `lib/email-relay.js`), the Brevo client (`lib/brevo.js`) and the
quota ledger (`lib/email-quota.js`) are library code; the site API above
(`lib/routes/email-site-routes.js`) puts them behind `requireEmailKey()`.
