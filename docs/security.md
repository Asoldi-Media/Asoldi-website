# Hub security: secrets, tokens, public-repo hygiene

This repo is public. Treat everything ever committed as published: the fix for a committed
secret is rotation, not a history rewrite. Secrets live in env (Hostinger panel, read only by
code) or on the hub data disk (`~/.asoldi-website-data`, which survives git deploys). No
change here needs a new Hostinger env variable.

## Secrets on the data disk

| File (under the data dir) | Holds | Made by |
|---|---|---|
| `secrets/admin-secret` | token signing secret, used when `ADMIN_SECRET` is unset, shorter than 16 characters or a known public default | `lib/auth-hardening.js` `resolveHubSecret` |
| `secrets/maker-callback-token` | Maker callback token when no env token is set | `server.js` `getMakerCallbackToken` |
| `secrets/initial-admin-password` | first admin password on an empty install | `ensureAdminExists` |
| `secrets/webhooks.json` | Fireflies webhook signing secret and URL token | `data/webhook-secrets.js` |
| `security-settings.json` | max token age, `revokedBefore` per class, one-time `migrations` | `data/security-settings.js` |
| `token-revocations.json` | per-user token versions ("log out everywhere") | `data/security-settings.js` |

Files are created in one step (temp file + hard link or rename), mode 0600, so two processes
booting together end with the same secret. The `secrets/` folder is 0700 on Linux; on Windows
(PC2 LAN hub, local dev) its ACL is reset to the account running the hub, with no inherited
entries, and every file inside inherits that one entry (`data/private-dir.js`). Changes to
`webhooks.json`, `security-settings.json` and `token-revocations.json` are a read-modify-write
on a fresh read under a short lock file (`<file>.lock`), so a change made by another hub
process a moment earlier is never lost (for example a rotation undone by a stale cache).
Status pages report the source of a secret, never the value.

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
- Failed logins are limited per account (10 per 15 minutes) and per client address (50). The
  address is the right-most `X-Forwarded-For` entry that is not an internal proxy address
  (`lib/auth-hardening.js` `clientIpFromRequest`): the left entries come from the client and
  can be forged, so changing them does not reset the count.
- Tokens are stamped with the user's token version from a fresh read of
  `token-revocations.json`, so a login served by one hub process right after a "log out
  everywhere" in another is not refused a second later.
- A data folder that refuses the lock file (no write access) makes a locked write fail within
  a fraction of a second; the boot migration then logs a warning and the hub starts.

Routes (admin token): `GET /api/admin/system/security`, `PUT /api/admin/security/token-settings`,
`POST /api/admin/security/revoke-tokens` (`{scope}` or `{userId}`). Client token:
`POST /api/client/account/logout-everywhere`.

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
(`lastHealthAlertAt`, `lastLiveJoinAlertAt`, `archiveEmptyAlertAt`). It is derived state, so an
unreadable one starts over (one 14-day scan, and an owner alert may go out once more) and keeps the
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
| `forged-token:*` | a token signed with an old public default secret gets 401 |
| `site-config` | `/api/hub/site-config?domain=<--site-domain>` answers 200 with no `passwordHash` / `pendingAdmin` / `clientAdmin`. A 404 fails (it would hide a leak), and `--site-domain` is required with `--expect-prod` |
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
