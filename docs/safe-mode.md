# Hub safe mode

A hub that runs on a PC (or the office LAN box) has the same keys as asoldi.com. Safe mode keeps it from touching the real world.

## When it is on

| Where | Safe mode |
|---|---|
| asoldi.com (Hostinger) | **Off.** Detected by `HOSTINGER`, a cwd under `/domains/<site>/nodejs`, a home or cwd under `/home/u<digits>`, or `APP_DATA_DIR`/`DATA_DIR` under `/home/u<digits>/`. |
| Any other machine | **On**, unless `HUB_SAFE_MODE=0`. |
| `HUB_SAFE_MODE=1` | On, anywhere. |

`APP_URL=https://asoldi.com` is not a production signal. A PC with the live `.env` also has it.

`GET /api/health` reports `safeMode`. The first log line says `[safe-mode] ON (<reason>) allow=<keys>`.

## What it does

- **Email.** Every send (`lib/email.js`: Resend, SMTP, the inbox bot's replies) goes to the outbox instead:
  - `<dataDir>/outbox/YYYY-MM-DD/<id>.eml` holds the full MIME with attachments inline.
  - `<dataDir>/outbox/index.jsonl` holds one line per email.
  - Items are deleted after 30 days. The outbox lives in the local data dir, which is never backed up to prod.
  - Brevo and Gmail have no hub send path yet. Their hosts are refused by the egress allowlist. New senders must go through `outboxOrSend({ channel, allowKey, message, send })` in `lib/safe-mode-mail.js`, which writes to the outbox in safe mode and sends for real otherwise (for Brevo, `allowKey: 'brevoSend'`).
- **External writes** are blocked. Each blocked attempt is recorded in `<dataDir>/safe-mode/intents.jsonl` and in counters:
  - calendar events and ACLs (the caller gets a `safe-…` stand-in event);
  - Fireflies live-join;
  - Myphoner POST, PATCH and DELETE;
  - WordPress writes;
  - Luca GraphQL mutations;
  - Stripe live keys, PayPal live, and Stripe webhook endpoint create/delete;
  - the prod logins and pushes to asoldi.com (a safe-mode hub never treats itself as production, even when `APP_URL` equals `PROD_ADMIN_URL`);
  - the cloudflared public tunnel.
  - Routes answer a blocked action with **423**, not 500.
- **Maker handoff.** Unless `prodPublish` is allowed, the preview push URL and the status callback URL handed to the Maker point back at this hub on a local address:
  - `SALES_PREVIEW_PUSH_URL` / `WEBSITE_MAKER_STATUS_CALLBACK_URL` when their host is loopback, private LAN or `host.docker.internal`;
  - else `HUB_PUBLIC_URL_FOR_MAKER` when its host is local;
  - else `http://host.docker.internal:<PORT>` (the Maker runs in Docker, where 127.0.0.1 is the container itself).
  - `APP_URL` is never used for these, and prod values of the variables above are ignored.
  - The hub never takes the asoldi.com browser-handoff path (`requestIsPublicInternetHost` is false), so no response hands the browser an asoldi.com push, callback or upload URL. It creates the run server-to-server at the local Maker.
- **Listening address.** In safe mode the hub binds `127.0.0.1`, not `0.0.0.0`, so the LAN cannot reach a hub that holds live keys, client data and the outbox. `lan` in `HUB_SAFE_MODE_ALLOW` (the LAN box) keeps `0.0.0.0`, and `HUB_LISTEN_HOST` overrides it (for example inside another container). Docker Desktop still reaches it through `host.docker.internal`. Production binding is unchanged.
- **AI calls** (DeepSeek, Anthropic, Gemini) never leave the PC by default:
  - A cassette for the same request is replayed when one exists.
  - Otherwise the caller gets a deterministic stub, for example `{ "safeModeStub": true }`.
  - `HUB_SAFE_MODE_AI=replay|error` throws the provider's own "not available" error instead of returning a stub.
  - To record cassettes, run with `HUB_SAFE_MODE_ALLOW=aiCalls HUB_SAFE_MODE_AI_RECORD=1`.
- **Inbox.** IMAP sessions use `EXAMINE` and `BODY.PEEK`, so mail stays unread (`imapFlags` lifts this).
- **Background jobs.** Only these start:
  - the sales reminder and workshop desk email loops (their mail lands in the outbox);
  - three local backfills.
  - Fireflies ingest and live-join, the inbox bot, the Myphoner loops, geocoding, LAN autopublish, maps ranking and the network backfills stay off.
- **Egress allowlist.** `fetch`, `http(s).request` and every TCP/TLS socket are checked before connecting. Allowed:
  - loopback;
  - Google Calendar, Gmail and Business Profile reads, plus calendar freeBusy and OAuth token refresh;
  - Myphoner GET;
  - Luca GraphQL queries (a document with a mutation or subscription anywhere, or an `operationName` that is not one of its queries, counts as a write);
  - WordPress GET;
  - Stripe with test keys and PayPal sandbox.
  - Everything else is refused, and the refusal is recorded with its kind (`paidApi`, `aiCalls`, `prodPublish`, …).
  - The socket layer sees only host and port. For the hosts above, whose rules depend on method, path, headers or body, it only admits a socket opened for a request that `fetch` or `http(s).request` already approved (tracked with AsyncLocalStorage). A raw `tls.connect`, http2, or an HTTP client that skips the patched `fetch`/`http.request` gets nothing (intent kind `rawSocket`). Host-only keys (SMTP, IMAP, LAN) still pass on the host once allowed.
  - Child processes are outside the in-process guard; cloudflared is blocked semantically.

## Allow keys (`HUB_SAFE_MODE_ALLOW`, comma list)

| Key | Lets through |
|---|---|
| `emailRedirect` | Real sends, rewritten to `EMAIL_REDIRECT_TO`. The bcc is dropped and the subject becomes `[SAFE→original recipients] …`. |
| `brevoSend` | Brevo API |
| `calendarWrite` | Google Calendar writes |
| `firefliesLiveJoin` | Fireflies `addToLive` |
| `firefliesIngest` | Fireflies transcript queries, the ingest loop and its follow-ups |
| `myphonerWrite` / `myphonerSync` | Myphoner writes / the Myphoner loops |
| `paymentsLive` | Stripe live keys, PayPal live |
| `stripeWebhookAdmin` | Stripe webhook endpoint create/delete (a live account also needs `paymentsLive`) |
| `prodPublish` | asoldi.com logins and preview pushes, and LAN autopublish |
| `wordpressWrite`, `accountingWrite` | WordPress writes, Luca mutations |
| `inboxRead`, `imapFlags` | The inbox bot loop and IMAP hosts / IMAP flag changes |
| `aiCalls` | Real LLM calls |
| `paidApi` | DataForSEO, SerpAPI, Google Places/Geocoding, Deepgram, Brave |
| `publicRead` | GET to public websites (not APIs, not asoldi.com) |
| `lan` | Private LAN addresses |
| `publicTunnel` | cloudflared tunnel |
| `geocode`, `mapsRanking`, `startupBackfills` | Those loops |

`docker-compose.lan.yml` sets `HUB_SAFE_MODE_ALLOW: "prodPublish,lan"` so the office LAN autopublish keeps working.

## Running the hub on a PC

```
node scripts/env-sync.mjs --from <copy of production.env>   # or --from-prod (read-only FTPS via website-maker/scripts/prod-read.mjs)
node scripts/env-sync.mjs --check                          # drift report, key names only
node scripts/env-sync.mjs --archive-strays                 # move .env.bak-* and similar copies to ~/.asoldi-secrets/env-archive/
npm run dev:safe                                           # API http://127.0.0.1:3101, UI http://127.0.0.1:3100, data .local-data/default
npm run dev:safe -- --profile golden                       # data .local-data/golden
```

How the generated `.env` is built:
- It contains every prod key except `ADMIN_SECRET`. The local hub makes its own secret on disk.
- Keys the previous `.env` had are kept under `LOCAL EXTRA`.
- The safe override block comes last. It holds no host path (no `APP_DATA_DIR`): `docker-compose.lan.yml` loads `.env` into a Linux container, where a Windows path would silently become an empty relative data dir. `dev:safe` sets the data dir per profile.
- Every value is written so `dotenv` reads it back unchanged (checked per value, including multi-line JSON with literal `\n` escapes). A value no quoting can carry stops the run with an error naming the key, never the value.
- `--substitute-test-keys` swaps the live Stripe keys for the Connect test key.

How `dev:safe` behaves:
- It refuses to start when safe mode would be off. `--unsafe-i-know` overrides this.
- It never uses port 3000, which belongs to the Maker.
- Vite gets the shell environment only, not the `.env` values, plus `HUB_DEV_SAFE=1`, which makes `vite.config.ts` skip its `GEMINI_API_KEY` define.
- It sets `HUB_PUBLIC_URL_FOR_MAKER=http://host.docker.internal:3101`, so the Maker's pushes and status callbacks reach this hub.

A plain `node server.js` (or `npm run dev:api`) on the PC with the live `.env` is also in safe mode: email to the outbox, the guards and the egress allowlist on, local Maker URLs, `127.0.0.1` only. It still takes `PORT` and the default data dir (`~/.asoldi-website-data`) from that `.env`, so prefer `npm run dev:safe`.

Superadmin → **System safety** shows:
- the state, jobs and counters;
- the recent blocked attempts;
- the egress rules;
- the outbox.

Email previews render in a `sandbox=""` iframe, from a signed 10-minute URL that carries no staff token, with a `Content-Security-Policy: sandbox; default-src 'none'` header.

## Soak test

```
npm run soak:safe -- --minutes 20 --env-file <path to the live .env>
npm run soak:safe -- --minutes 20 --env-file <path to the live .env> --plain
```

What it does:
1. Runs the API on port 3191 with a fresh `.local-data/soak` (`--plain`: `.local-data/soak-plain`). The soak data is synthetic (`example.invalid` addresses).
2. Default: the `dev:safe` profile with `HUB_SAFE_MODE=1`. `--plain`: behaves like a plain `node server.js` with that `.env`, so `APP_URL` (https://asoldi.com with the live `.env`), `HUB_PUBLIC_URL_FOR_MAKER` and `HUB_SAFE_MODE` come from the file. Either way it refuses to run if safe mode would be off.
3. Always: an empty allow list, and a fake loopback Maker in the soak process (`WEBSITE_MAKER_LOCAL_URL`/`BASE_URL` point at it), so the real local Maker is never touched.
4. Preloads `scripts/safe-mode/egress-audit.cjs`. This recorder shares no code with the guard.
5. Drives the prod publish, the Stripe webhook, the tunnel, the Infokort agent, a Fireflies refresh, and two `create-maker-run` calls: one with the Maker URL typed in Sales, one that looks like it reached asoldi.com (`Host: asoldi.com`) with no Maker URL.

It fails on any connection to a host outside `scripts/safe-mode/soak-allowlist.json`. It also fails without:
- an outbox email for the seeded due reminder;
- the expected intents, and 423 for the prod publish, the Stripe webhook and the tunnel;
- both Maker runs created server-to-server, with no browser handoff and no off-machine URL in the Maker body or the responses.

The recorder also refuses unlisted hosts, as a safety net. The report goes to `.local-data/soak/soak-report.json` (or `soak-plain`).

Not covered yet: the synthetic data has no calendar tokens, Fireflies meetings or inbox mail, so those guards are exercised by the unit tests (`scripts/safe-mode-guards.test.mjs`, `scripts/safe-mode-egress.test.mjs`), not by the soak. Seed a booked client with calendar and Fireflies fixtures once WS0.21 lands.
