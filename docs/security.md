# Hub security: secrets, tokens, public-repo hygiene

This repo is public. Treat everything ever committed as published: the fix for a committed
secret is rotation, not a history rewrite. Secrets live in env (Hostinger panel, read only by
code) or on the hub data disk (`~/.asoldi-website-data`, which survives git deploys). No
change here needs a new Hostinger env variable.

## Secrets on the data disk

| File (under the data dir) | Holds | Made by |
|---|---|---|
| `secrets/admin-secret` | token signing secret, used when `ADMIN_SECRET` is unset, shorter than 16 characters or a known public default; rotatable from the Security card | `lib/auth-hardening.js` `createHubSecretHolder` |
| `secrets/maker-callback-token` | Maker callback token when no env token is set; rotatable from the Security card | `server.js` `getMakerCallbackToken` |
| `secrets/initial-admin-password` | first admin password on an empty install | `ensureAdminExists` |
| `secrets/webhooks.json` | Fireflies webhook signing secret and URL token | `data/webhook-secrets.js` |
| `security-settings.json` | max token age, `revokedBefore` per class, one-time `migrations`, `loginTrustedHops` | `data/security-settings.js` |
| `token-revocations.json` | per-user token versions ("log out everywhere") | `data/security-settings.js` |

Files are created in one step (temp file + hard link or rename), mode 0600, so two processes
booting together end with the same secret. The `secrets/` folder is 0700 on Linux; on Windows
(PC2 LAN hub, local dev) its ACL is reset to the account running the hub, with no inherited
entries, and every file inside inherits that one entry (`data/private-dir.js`). Changes to
`webhooks.json`, `security-settings.json` and `token-revocations.json` are a read-modify-write
on a fresh read under a short lock file (`<file>.lock`), so a change made by another hub
process a moment earlier is never lost (for example a rotation undone by a stale cache).
Status pages report the source of a secret, never the value.

## Rotating the disk secrets (no FTP, no deploy)

Admin → Manage clients → Security → **Rotate secrets** makes a new value on the data disk:

| Action | Route (admin token) | Effect |
|---|---|---|
| Make a new signing secret | `POST /api/admin/security/signing-secret/rotate` | `secrets/admin-secret` is replaced. Every admin, staff and client portal token, and any Google sign-in that is half-way (OAuth state), is refused at once. The admin who pressed it gets a fresh token. |
| Make a new Maker token | `POST /api/admin/security/maker-callback-token/rotate` | `secrets/maker-callback-token` is replaced and shown on the card (`callbackToken`, no-store); an admin can read the current token again with `GET /api/admin/system/maker-callback-token`. Paste it into the Maker `.env` as `WEBSITE_MAKER_STATUS_CALLBACK_TOKEN` and `SALES_MAKER_STATUS_CALLBACK_TOKEN`. Callbacks and preview pushes with the old token get 401, also from runs that were started with it. |

- Both need the admin's current password (`currentPassword`; wrong passwords count toward the
  login limits, and the right one clears the count for that address, as a sign-in does) and the
  typed word `ROTER` (`confirm`).
- Only the hub admin (`admin.json`) can rotate. Any other admin token (one that carries a
  `users.json` user id, or names another username) gets 403 with code `hub-admin-only` and a
  Norwegian message, before any password check, and the refusal counts toward no login limit.
  Such a user cannot confirm with their own password: the rotation answer signs a fresh hub
  admin token for the caller, and the hub admin's password is the one that guards the secrets.
- When the env value wins (`ADMIN_SECRET` of 16+ characters that is not a known default, or
  `WEBSITE_MAKER_STATUS_CALLBACK_TOKEN` / `SALES_MAKER_STATUS_CALLBACK_TOKEN`), the route answers
  409 with a Norwegian explanation and changes nothing: rotate the env value where it is set.
- The new value is written to a temp file and renamed over the old one under the file's lock.
  This process uses it at once; other hub processes re-read the file at most a second later
  (`lib/auth-hardening.js` `createHubSecretHolder`), so old tokens stop everywhere within about
  a second. A token or callback that does not match makes a process re-read the file once
  (`checkWithFreshSecret`, at most ten reads a second), so the fresh admin token and the new
  Maker token work in every process at once. Sign-ins and Google sign-in starts re-read the file
  before they sign (same limit), so no process signs with a replaced secret. A damaged or
  missing file never replaces a good value in memory. `HUB_SECRET_REFRESH_MS` changes the
  one-second interval; only tests set it. The interval runs on a monotonic clock, so a step of
  the server's wall clock (an NTP correction, for example) never delays a re-read.
- Audit: `security-settings.json` `secretRotations.<name>` = `{ at, by }` (the latest, shown on
  the card) and `secretRotationHistory` (the last 50 rotations of either, newest first, as
  `{ name, at, by }`), the counters `admin-secret-rotated` / `maker-callback-token-rotated`
  (in memory), and a `[security]` log line. No value is ever logged or stored outside
  `secrets/`. If the record cannot be written, the rotation still answers 200 with the new token
  and `auditSaved: false`, and the error is logged.

## Client CMS admin password (set from the hub)

`PUT /api/hub/sites/:id/client-admin` refuses a new password that is shorter than 8 characters
(spaces at the ends do not count), longer than 1024 (the longest the CMS sign-in accepts) or a
known default (`changeme`, `admin`, `password`, `passord`, `12345678` …), with a Norwegian
400 message that the admin dialog shows. The rule is `lib/client-admin-password.js` (the same as
the CMS); `data/hub.js` only re-exports it. `PUT /api/hub/sites/:id` never sets the password
hash or the sync flag.

## Login tokens

- Signed with HMAC-SHA256, compared in constant time.
- Max age: `AUTH_TOKEN_MAX_AGE_DAYS` env if set, else `security-settings.json`, else 30 days.
- Each token carries the user's token version (`tv`). A password change, role change,
  deactivation, deletion or "Logg ut overalt" (client portal → Innstillinger → Konto) bumps it,
  so every older token for that user is refused.
- The hub admin (`admin.json`) works the same way: changing the admin password logs the admin
  out on every device (old and new username); the browser that changed it gets a fresh token.
- One-time boot migration `adminSessionReset2026_10`, a reset of admin and staff sessions:
  the first boot of this code sets `revokedBefore.admin` and `revokedBefore.staff` to the boot
  time and records the migration. Admin and staff sign in again once (the Maker re-logs in on
  its own); client portal sessions are not touched. It runs exactly once per data dir, also when
  several processes boot together, and never moves a later cutoff backwards.
- Admin → Manage clients → Security can log out all clients, all staff, all admins (the admin
  pressing it gets a fresh token) or everyone.
- Sign-in attempts (admin, staff and client portal sign-ins, the password re-check of a
  rotation, and the current password of an admin password change) are counted per 15 minutes
  under three keys (`lib/auth-hardening.js` `createLoginLimiter`, the same structure as the
  client CMS 2.2):

  | Key | Counts | Limit |
  |---|---|---|
  | `p:` | one account from one client address | 10 |
  | `a:` | one account from every address | 100 |
  | `i:` | one client address, every account | 50 |

  A sign-in is refused with 429 while any of its three keys is full. So the right password from
  an address that is not blocked by its own `p:` or `i:` key gets in while the account's `a:` key
  is under 100: failures from other addresses cannot keep an account out on their own.
- An attempt is counted when it starts, before the password check (`beginLogin`, no await in
  between), so requests sent at the same moment cannot all pass a limit before the first wrong
  password lands. At most 2 password checks run at once per account and per address; another
  attempt meanwhile gets 429 with `Retry-After: 1`. A wrong password keeps the attempt counted.
  The right one takes it back and clears the `p:` key of that account and address; the `a:`
  and `i:` keys keep their other attempts. A request that ends without a verdict (an error, a
  closed connection) counts as a wrong password, and a check still running after 10 seconds
  stops holding its place.
- Accounts are kept as short hashes and the table holds at most 10 000 keys; when it is full,
  keys of accounts that do not exist in `admin.json` / `users.json` go first, then address keys,
  and keys of real accounts stay for their whole window (`lib/login-limits.js`). The counts live
  in memory per hub process: a restart clears them, and with several hub processes each one
  counts on its own (the limits are then per process).
- The address is the right-most `X-Forwarded-For` entry that is not an internal proxy address
  (`lib/auth-hardening.js` `readClientAddress`): the left entries come from the client, so
  changing them does not reset the count.
- Which source the limits use is logged once per process for each kind of source
  (`[security] login limits count each client by X-Forwarded-For entry 1 from the right …`,
  never an address). `GET /api/admin/system/security` adds `loginAddressMode` (the most common
  source of the last hour: `forwarded`, `forwarded-internal`, `socket`, or `none`) and
  `loginAddresses` (`distinctLastHour`, `attemptsLastHour`, `modesLastHour`, and `hopFromRight`
  and `peer` of the latest attempt, `trustedHops`, and `processId` / `processStartedAt`); the
  Security card shows it in one line. These figures belong to the hub process that answered the
  request, like the counts. Addresses are kept only as short hashes, for an hour. Many attempts
  with `distinctLastHour` 1 mean every client reaches the hub through one public proxy (a CDN in
  front of the hosting proxy, for example), so all of them share one per-address count.
- After a deploy, expect `loginAddressMode` `forwarded` with `peer` `internal`: the hosting proxy
  connects from an internal address and appends the client's address. `peer` `public` with
  `forwarded` means the hub is reached from a public address that sends `X-Forwarded-For`, so the
  counted entry may be written by the client; the Security card then warns, and the proxy in
  front of the hub needs checking.
- Then `PUT /api/admin/security/login-address` with `{ "trustedHops": 2 }` (1 to 5; `null` is
  the default, 1) makes the limits count the second public entry from the right. Raise it only
  when every request passes that many public proxies: a request that skips one decides which
  entry it is counted by. The value is `security-settings.json` `loginTrustedHops`, and every
  hub process reads it within a second.
- Tokens are stamped with the user's token version from a fresh read of
  `token-revocations.json`, so a login served by one hub process right after a "log out
  everywhere" in another is not refused a second later.
- A data folder that refuses the lock file (no write access) makes a locked write fail within
  a fraction of a second; the boot migration then logs a warning and the hub starts.

Routes (admin token): `GET /api/admin/system/security`, `PUT /api/admin/security/token-settings`,
`PUT /api/admin/security/login-address` (`{trustedHops}`),
`POST /api/admin/security/revoke-tokens` (`{scope}` or `{userId}`). Client token:
`POST /api/client/account/logout-everywhere`.

## Open CMS as Asoldi

`POST /api/hub/sites/:id/cms-sso` (admin token) returns a one-time sign-in link into a client
CMS (`lib/cms-sso.js`). The format follows the CMS version from the site's heartbeats: the newer
of the trusted version (from a heartbeat with the site credential) and the version the last
heartbeat without it reported. The format only decides whether the link works on that CMS:

- CMS 2.2.1 and later, and sites with no reported version: a random 32-byte token. The hub stores
  only its sha256 with the site id, who asked and the expiry (60 s) in
  `<dataDir>/cms-sso/tokens.json` (private folder, locked writes). The CMS checks it with
  `POST /api/cms/sso/redeem` (site key in the `x-site-key` header or the body, `{ token }`
  in the body) before it opens a session. The hub answers `{ ok: true, by }` once, for that
  site only, before expiry; anything else gets the same 401. The site key is compared with
  every site's key, as sha256 digests in constant time and without stopping at a match
  (`findSiteByKeyConstantTime`), so the answer time says nothing about the keys. Calls without a known site key
  are limited per address (30 per 15 minutes), and a known key with a live token of another
  site per site and address (10), with 429 and Retry-After above that. A known key with an
  unknown, used or expired token is not limited: a CMS passes on all its visitors' links from
  one server address, and the tokens cannot be guessed.
- CMS 2.0.0 up to 2.2.0: the earlier token signed with the site key, which those versions
  check themselves.
- CMS 1.x has no Asoldi sign-in: 409.

The link always goes to the site's stored domain over https. The address a CMS reports in its
heartbeat only picks the www or bare spelling of that host; a report for any other host is
ignored and noted in the audit (a loopback domain keeps http, for local runs). A site without a
domain gets 409.

Every link, every successful check and every refusal of a real token (another site's, used or
expired) is recorded in `<dataDir>/cms-sso/audit.json` (last 500 rows: site id, who, format, CMS
version, link origin, result), never the token. Calls without a known key and tokens that were
never issued are only counted in memory and logged at most once a minute.

The client admin password set from the hub follows the same rule as the CMS (see
"Client CMS admin password" above), so a synced admin is never replaced at the CMS's next start.

## Site credential (client CMS → hub)

The site key is a public identifier: the Maker writes it into each site's form HTML
(`/api/client-forms/<siteKey>`). A client CMS proves that a call comes from its own server with a
second value, its site credential (`lib/site-credentials.js`): 32 random bytes the CMS makes once
on its data disk and sends only to its configured hub, in the `x-site-credential` header. The hub
keeps `sha256` of it per site id in `<dataDir>/site-credentials/credentials.json` (private
folder, locked atomic writes), never the value.

**Enrollment** (`POST /api/hub/site-credential/enroll`, `{ siteKey, credential, nonce }`,
client CMS 2.2.2 and 1.7.2):

- Off until a superadmin switches it on (Manage clients → Security → Site credentials), because the
  proof is an outgoing call: 503 `enrollment-off` until then. In safe mode the proof call goes
  through the egress guard like any other.
- The site needs a public domain in the hub (409 `no-domain`; loopback, private and single-label
  hosts do not count).
- The hub asks `https://<stored domain>/api/cms/hub-enroll-proof?nonce=<nonce>` (5 s for the whole
  call, at most two redirects and only to https on the same host or its www twin, same port, path
  and nonce, 4 KB answer cap) and expects `HMAC-SHA256(credential, nonce)`. The CMS answers only
  for a nonce it sent itself in the last two minutes, so a site key holder elsewhere cannot enroll
  a credential of their own.
- Each nonce is accepted once (409 `nonce-used`). Attempts are limited per (site, address) (6 per
  15 minutes; an IPv6 address counts by its /64) and, for unknown site keys, per address (30 per
  15 minutes). An address whose proof for the site failed in the last hour also needs a share of
  20 retries an hour per site; an address without a failed proof never waits for that share, so
  callers who cannot prove anything cannot use up the enrollment of the site's own CMS.
- Proof calls for one site run one at a time. Later callers wait their turn (up to 10 s, then 429
  `enroll-busy` with Retry-After) instead of being turned away.
- A match stores the hash and is audited in `<dataDir>/site-credentials/audit.json` (site id,
  origin, address; never the credential or nonce). A new proof replaces an older credential
  (re-enrollment), which is audited and counted on the Security card, as are refusals and revokes.

**What needs it:**

| Route | Site key alone | With a valid credential |
|---|---|---|
| `/api/hub/shop/*` that move money, change a payee or read payment details (Stripe/PayPal connect, checkout, order, capture, session, invoice, subscription, cancel, refund, disconnect) | 401 `site-credential-required` | allowed |
| `GET /api/hub/shop/status`, `POST /api/hub/shop/document`, `GET /api/hub/analytics` | allowed only for a site that has never enrolled and whose trusted CMS version is 2.0.0 up to 2.2.1 (the versions that call these without a credential), for the shop routes only with the shop feature on; otherwise 401. A revoked site stays closed until it enrolls again | allowed |
| `GET /api/hub/analytics?refresh=1` (paid maps refresh) | stored ranking only, with `mapsRefreshSkipped: 'site-credential-required'` | refresh runs |
| `GET /api/hub/analytics/spend` | 401 | allowed |
| `GET /api/hub/site-config` (site key in `x-site-key` or `?site_key=`) | public fields only | adds `pendingAdmin` and the client admin contact |
| `POST /api/hub/heartbeat` | 30 a minute per (site, address); marks a site that has never enrolled as seen; version, admin address and name kept as `cms.unverified` (shown, not used; the same report within a minute is not written again); `adminApplied` ignored. An enrolled or revoked site is marked as seen only with its credential | acted on (`cms.packageVersion`, `cms.adminUrl`, `cms.lastVerifiedAt`) |

A wrong credential on site config or the heartbeat still gets the public answer. Every answer
carries `x-site-credential-status` (`valid`, `missing`, `invalid`, `not-enrolled`,
`unavailable`; a revoked site reads `not-enrolled`), so the CMS knows when to make a new
credential and enroll again. The shop's server notices go to the stored domain over https, like
sign-in links. In the data layer, `getSiteConfig` adds the admin fields and `recordHeartbeat` acts
on a report only when the caller asks for it (`includeAdmin`, `verified`); both are off by default.

A credentials file that exists but cannot be read is never taken as "nobody enrolled": every check
answers `unavailable` (503 where a credential is needed), enrollment and revoke refuse, the event is
counted (`site-credential-store-unreadable`) and logged, and the Security card offers to set the
file aside (`credentials.json.unreadable-<time>`, kept for repair) and start an empty store, after
which enrolled sites enroll again on their own.

Public endpoints stay on the site key, with payload checks and limits per site and address
(`lib/site-public-guards.js`; an IPv6 address counts by its /64). A call with the site's valid
credential (the CMS passing on its visitors) is limited per site only, in a bucket of its own that
calls without the credential cannot use up:

- `POST /api/client-forms/:siteKey`: 8 per (site, address) in 10 minutes. Past 120 forms for one
  site in 10 minutes they are still delivered, counted (`client-form-site-busy`) and logged once,
  so callers from many addresses cannot switch a site's form off; 1000 is the hard ceiling that
  protects the owner's inbox and the hub's mail sender. The site's server with its credential has
  600. At most 40 fields, 100 characters per name, 5000 per value, 20 000 in all (413 above).
- `POST /api/hub/analytics/collect`: 120 per (site, address) and 1200 per site a minute (the site's
  server with its credential: 1200 of its own, so others cannot crowd out an enrolled site); at most
  100 events per call, only the fields the CMS stores, with its lengths, and times in the last 35 days.
- `POST /api/hub/analytics/commerce`: 20 per (site, address) and 60 per site a minute; only the
  known summary fields, with bounded depth, list length, string length and finite numbers; 64 KB
  at most (413 above).

**Admin** (admin token): `GET /api/hub/site-credentials` (per site: enrolled or revoked, enrolled
at, proof domain and whether it still matches the stored domain, counts, whether the site key alone
still opens shop status, documents or the dashboard; never a hash; and whether the store can be
read), `PUT /api/hub/site-credentials/settings` (`{ enrollment: 'on' | 'off' }`),
`POST /api/hub/sites/:id/site-credential/revoke` (the site stays closed until its CMS makes a new
credential and enrolls again, which 2.2.2 and 1.7.2 do on their own),
`POST /api/hub/sites/:id/site-credential/reset` (for a site whose CMS went back to a version
without a credential: the row is forgotten, and a 2.0.0–2.2.1 version from the last heartbeat
without a credential becomes the trusted version; money routes still need a credential) and
`POST /api/hub/site-credentials/set-aside-unreadable`. Manage clients shows the state per site,
with Revoke and Reset buttons. Every action is audited and counted.

**Older client CMS versions** send no credential. They keep their public config and liveness. A
never-enrolled shop on 2.0.0 up to 2.2.1 keeps its shop status, documents and dashboard on the site
key alone; CMS 1.x never calls those routes. None of them gets a client admin password from the hub
or can use the money routes until it runs 1.7.2 or 2.2.2 and has enrolled. Switch enrollment on
together with the first rollout of 2.2.2 or 1.7.2.

## Fireflies webhook

The old `FIREFLIES_WEBHOOK_SECRET(S)` and `FIREFLIES_WEBHOOK_TOKEN` env values are retired: a
request signed with them, or carrying the old token, gets 401 and is counted. The trusted
secret and token are generated in `secrets/webhooks.json`.

Nothing depends on the webhook: the pull ingest asks the Fireflies API every 60 seconds with
`FIREFLIES_API_KEY` (or `FIREFLIES_API`, the same key under the name used in hPanel), stores
transcripts and links them to clients (see "Fireflies transcript intake" in
[sales-offer-flow.md](sales-offer-flow.md)). For meetings it brings in (started in the last 2
days, with a transcript or summary), `lib/fireflies-pull-followup.js` then does what only the
webhook did: the "recording ready" e-mail, once per meeting through the same
`fireflies-notified.json` claim (a webhook after the paste never sends a second one), and the
copy of video and audio to the data dir before the signed URLs expire. The e-mail waits until
Fireflies has finished the meeting (or 20 minutes), and a failed send is tried again up to five
times, ten minutes apart; downloads are retried with fresh links for two days.

`fireflies-meetings.json` and `fireflies-notified.json` are written with a lock and temp file +
rename (`lib/fireflies-store.js`). A file that does not parse is never replaced by an empty one:
reads use the newest readable backup, the next write rebuilds the file from it and keeps the
unreadable copy as `backups/<file>.unreadable-<time>`, and with no readable backup the write is
refused, the meet-link backfill stops (an empty archive would unlink every recording) and the
owner is e-mailed (`FIREFLIES_ALERT_EMAIL`, default `damian@asoldi.com`, at most every 12 hours).
`fireflies-ingest-state.json` says where the pull left off and holds the owner-alert stamps
(`lastHealthAlertAt`, `lastLiveJoinAlertAt` and one per live-join reason, `archiveEmptyAlertAt`).
It is derived state, so an unreadable one starts over (one 14-day scan, and an owner alert may go out once more) and keeps the
bad copy the same way.

To switch the push webhook to the new secret, whenever convenient:
1. Admin → Manage clients → Security → **Show secret for Fireflies**.
2. In Fireflies: Settings → Developer settings → Webhooks. URL `https://asoldi.com/api/webhooks/fireflies`
   (no `?token=`), secret from step 1.
3. The card shows "Last accepted webhook: data-signature" after the next meeting.
4. Optional: **Turn off ?token= URLs**.

**Make a new secret** rotates it (the previous disk secret stops at once).

## Secret and client-data scan

`scripts/security/secret-scan.mjs` blocks:

- credential patterns (private keys, Anthropic/OpenAI/DeepSeek, Google, GitHub, Brevo, Stripe,
  Resend, Slack, AWS, Supabase keys, service-role JWTs, passwords in URLs);
- any secret-like value from the local `.env` files (this clone, the sibling Maker and CMS
  repos, `~/.asoldi-website-data/production.env`), compared in memory;
- retired secrets: salted hashes in `~/.asoldi-secrets/retired.json` (never in a repo);
- client personal data: e-mail addresses outside `asoldi.com`/`example.*`/test domains, `+47`
  numbers, 8-digit mobile numbers without `+47` (grouped like `9xx xx xxx`, or unbroken when
  quoted on their own or on a line about a phone), fødselsnummer, card numbers. Numbers that look
  like fixtures (`1234`, `0000`, `99887766`) are skipped;
- paths for secrets and client data (`.env`, keys, data JSON, transcripts, `docs/daily-logs/`,
  `tmp/`, private fixtures).

Output names the path, line, rule and env key or retired label, never the value. Lines of any
length are scanned (a JSON dump or a minified bundle is one line); every rule is linear in the
line length.

```bash
npm run hooks:install       # once per clone: core.hooksPath=.githooks
npm run scan:secrets        # tracked files, secrets only
npm run scan:public         # tracked files, secrets + client data, counts per rule
node scripts/security/secret-scan.mjs --history --secrets-only   # every commit
```

- `pre-commit` scans the staged lines; `commit-msg` scans the message (commit messages are
  public too; the e-mail of a `Co-authored-by:` style trailer is skipped).
- `pre-push` scans every commit being pushed (a secret added and removed again is still
  caught), its message, and the lines written while resolving a merge (`--cc`), then runs
  `npm test`. A push to main deploys asoldi.com, so a failing test blocks it. When the remote
  sha is not in this clone, it scans everything that is on no remote-tracking branch.
  `npm test` runs with a throwaway `APP_DATA_DIR` (removed afterwards) and
  `PERSIST_PRODUCTION_ENV=0`: some older tests fall back to `~/.asoldi-website-data`, which on
  the operator PC is the local hub data. Run `npm test` by hand the same way.
- The diffs are read with `--no-renames` (a file moved into `secrets/` is a new file),
  fixed `a/` `b/` prefixes and `--text`, so `diff.noprefix`, `diff.mnemonicPrefix`,
  `diff.renames` or `diff.relative` in a user's git config cannot change what is scanned.

Test fixtures use `example.com` addresses and values that look fake (`fake`, `test`,
`0000` …). A fixture that must match a secret pattern goes in `.secret-scan-allowlist.json`
with a reason; the scan still reports an allowlisted hit whose value looks real.

After rotating a secret, record the old value so the scan keeps catching it:

```bash
node scripts/security/retire-secret.mjs --label "what it was" --stdin    # value on stdin
node scripts/security/retire-secret.mjs --label "…" --env-file <path> --key NAME
```

## Read-only probe

`scripts/security/probe-hub.mjs` checks a running hub with GET requests only:

| Check | Passes when |
|---|---|
| `dns` | the host resolves over DNS-over-HTTPS (1.1.1.1, then 8.8.8.8); skipped with `--no-doh` |
| `admin-token` | the `--admin-token-file` can be read (only when the flag is given) |
| `health` | `/api/health` answers; with `--expect-prod`, `safeMode` is not on |
| `default-secret-token:*` | a token signed with an old built-in default secret gets 401 |
| `site-config` | `/api/hub/site-config?domain=<--site-domain>` answers 200 with no `passwordHash` / `pendingAdmin` / `clientAdmin`. A 404 fails (it would hide what the body contains), and `--site-domain` is required with `--expect-prod` |
| `recordings` | `/myphoner-recordings/…` without a login gets exactly 401 (a 404 means the staff gate is gone) |
| `fireflies` | the Fireflies API key is present, so the pull ingest runs |
| `counters` | with an admin token: per-hour counts stay under the limits below |

Counter limits per hour: `maker-callback-rejected` 20, `maker-callback-missing-token` 50,
`login-throttled` 50, `fireflies-webhook-retired-credential` 200. The last one is high on
purpose: Fireflies keeps delivering with the retired secret until someone pastes the new one,
so normal meetings show up there.

The connection is pinned to the DoH address, so a filtering resolver cannot hide or redirect
the host; TLS still checks the real host name. When DoH fails, the HTTP checks still run with
the system resolver and the `dns` check fails.

Any failed check (DNS, an unreadable token file, a crash of the probe itself included) writes
`~/.asoldi-probes/alerts/<time>-<host>.json`, e-mails `--email-to` through Resend when
`RESEND_API_KEY` is set, and exits 1. Exit 2 means bad arguments.

```bash
node scripts/security/probe-hub.mjs --target https://asoldi.com --expect-prod \
  --site-domain <a live client domain> \
  --admin-token-file ~/.asoldi-secrets/probe-admin-token --email-to <ops address>
```

Run it from the operator PC every 15 minutes. Task Scheduler (one line, `cmd`):

```bat
schtasks /Create /SC MINUTE /MO 15 /TN "Asoldi probe-hub" /TR "node \"C:\Asoldi\asoldi code\asoldi-website\scripts\security\probe-hub.mjs\" --target https://asoldi.com --expect-prod --site-domain <a live client domain> --admin-token-file %USERPROFILE%\.asoldi-secrets\probe-admin-token --email-to <ops address>"
```

The task needs `RESEND_API_KEY` in its environment for the e-mail. The admin token expires
after the max token age (30 days by default) and on admin revocations; the `counters` check
then fails with HTTP 401, which is the signal to put a fresh token in the file.

## Client data that is not code

Lists with client contact data load from the data disk, for example
`<dataDir>/sales-contact-corrections.json` (see `data/sales-contact-corrections.js`).

The list that used to be bundled in the repo can be restored to a data disk with
`node scripts/export-sales-contact-corrections.mjs [--out <file>]` (default
`~/.asoldi-website-data/sales-contact-corrections.json`). It reads the old module from Git
history (commit `c3c22cf`), refuses any output path inside the repo and prints only the row
count. For asoldi.com, copy the file to the hub data dir by hand. Never commit the output.

## Tests that boot the hub

`scripts/security-boot.test.mjs` starts the real `server.js` and is part of `npm test`, so it
also runs in the `pre-push` hook from the main checkout, where `.env` holds live keys. It is
safe there because the child runs in an empty temp working directory (dotenv reads
`<cwd>/.env`, so it finds nothing), every credential-like env key is set to an empty string
(dotenv never overrides a key that is set), Myphoner reconcile and SSU sync are off, and
`scripts/security/loopback-only-egress.mjs` is preloaded so any connection to a non-loopback
host fails. The test fails if the hub even tries one. A new test that boots the hub must do
the same.
