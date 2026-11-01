# Email credential (emailKey) and hub ↔ CMS email calls

The client CMS never holds the Brevo key. It asks the hub to send, and the hub sends through
Brevo on its behalf. Those calls need a credential that only the hub and the site's own CMS server
know. The site key cannot be that credential: it is a public identifier (the Maker writes it into
published form HTML), so **the site key never authenticates an email call**.

Each site therefore gets an **emailKey**: 32 random bytes, base64url (43 characters), with a key id
`ek_<n>`. Code: `lib/email-site-auth.js`, `lib/email-hint.js`, routes in
`lib/routes/email-hub-routes.js`.

Everything here is off until a superadmin turns the email platform on (email setting `enabled`,
default `false`). While it is off, every `/api/hub/email/*` route answers `404 {"code":"disabled"}`
and writes nothing. One exception: once the relay has sent mail (a message log file exists), the
unsubscribe pages stay open even if the platform is switched off again, so the links in mail
already sent keep working. To pause sending, use `killSwitch` instead.

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
  or, for a site in the email rollout that has no key at all, the hub issues the first one on a
  credential-valid provision request.
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
- **Recover** (the CMS lost its key): the superadmin rotates; the CMS pulls and confirms as above.

## CMS → hub: `x-email-key`

Every CMS → hub email call sends `x-email-key: <emailKey>`. The hub checks it in constant time
against every site's current key and its previous key while that is inside its grace window
(`requireEmailKey()`), and refuses with `401 {"ok":false,"code":"unauthorized"}`:

- with the site key alone, with the site key and a valid site credential, or with any wrong key;
- when `x-site-key` is also sent and names another site.

## Hub → CMS: `x-asoldi-signature`

Every hub → CMS email call is signed with the site's current emailKey:

```
x-asoldi-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(emailKey, t + "." + body)>
x-asoldi-key-id:    ek_<n>
```

- `body` is the exact request body (the empty string for a GET).
- The CMS accepts a signature only when `t` is within **±300 s** of its own clock and the HMAC
  matches its committed key (compare in constant time). A call signed with the site key is refused.
- The hub sends these calls only to `https://<site domain>` (the domain set in the hub). It never
  uses the CMS admin URL that heartbeats report, never follows a redirect, and gives up after 10 s.
  A site without a public domain, or without a committed key, is skipped.

Calls:

| Method and path on the CMS | Body | Purpose |
|---|---|---|
| `POST /api/cms/email/hub-event` | `{"type":"suppression","siteId":"…","at":"…"}` | The opt-out list changed: pull `GET /api/hub/email/suppressions?since=` |
| `POST /api/cms/email/hub-event` | `{"type":"key-rotation","keyId":"ek_2","siteId":"…","at":"…"}` | A new key is pending: provision-request, then confirm |
| `GET /api/cms/email/suppressions[?since=<ISO>]` | (empty) | The CMS's mirror of its opt-out rows, used to rebuild a lost hub record. Answer `{"items":[{"email","scope","source","at"}],"next":<ISO or null>}` |

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
| `POST /api/hub/email/unsubscribe?t=` | public | Form submit and RFC 8058 one-click (`List-Unsubscribe=One-Click`). Records the opt-out for the site. |
| `POST /api/hub/email/resubscribe?t=` | public | Undo from the page: once per address and site, within 30 days. |
| `GET /api/admin/email/status`, `PUT /api/admin/email/settings` | superadmin | `enabled`, `rollout`, `killSwitch`, `brevo.sandbox`, `brevo.syncContacts`, `testRecipients` (and `devCmsTargets` in safe mode). |
| `POST /api/admin/email/sites/:id/provision` | superadmin | Issue the first key or rotate. Answers key ids only. |
| `POST /api/admin/email/suppressions/rebuild` | superadmin | Rebuild a lost opt-out record from the CMS mirrors (`{"force":true}` writes even if a mirror did not answer). |
| `GET /api/admin/email/owner-routing/preview`, `PUT /api/admin/email/owner-routing/default` | superadmin | Owner-routing default for form and order notices (see `docs/runtime-data.md`). |

The send pipeline (`relaySend` in `lib/email-relay.js`), the Brevo client (`lib/brevo.js`) and the
quota ledger (`lib/email-quota.js`) are library code; the CMS-facing send, contacts and quota
routes are added separately and use `requireEmailKey()`.
