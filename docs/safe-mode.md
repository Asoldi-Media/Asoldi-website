# Hub safe mode

A hub that runs on a PC (or the office LAN box) has the same keys as asoldi.com. Safe mode keeps it from touching the real world.

## When it is on

| Where | Safe mode |
|---|---|
| asoldi.com (Hostinger) | **Off.** Detected by `HOSTINGER`, a cwd under `/domains/<site>/nodejs`, or a home/cwd under `/home/u<digits>`. |
| Any other machine | **On**, unless `HUB_SAFE_MODE=0`. |
| `HUB_SAFE_MODE=1` | On, anywhere. |

`APP_URL=https://asoldi.com` is not a production signal. A PC with the live `.env` also has it.

`GET /api/health` reports `safeMode`. The first log line says `[safe-mode] ON (<reason>) allow=<keys>`.

## What it does

- **Email.** Every send (`lib/email.js`: Resend, SMTP, the inbox bot's replies) goes to the outbox instead:
  - `<dataDir>/outbox/YYYY-MM-DD/<id>.eml` holds the full MIME with attachments inline.
  - `<dataDir>/outbox/index.jsonl` holds one line per email.
  - Items are deleted after 30 days. The outbox lives in the local data dir, which is never backed up to prod.
  - Brevo and Gmail have no hub send path yet. Their hosts are refused by the egress allowlist, and new senders must write to the outbox too (`writeOutboxEmail`).
- **External writes** are blocked. Each blocked attempt is recorded in `<dataDir>/safe-mode/intents.jsonl` and in counters:
  - calendar events and ACLs (the caller gets a `safe-…` stand-in event);
  - Fireflies live-join;
  - Myphoner POST, PATCH and DELETE;
  - WordPress writes;
  - Luca GraphQL mutations;
  - Stripe live keys, PayPal live, and Stripe webhook endpoint create/delete;
  - the prod logins and pushes to asoldi.com;
  - the cloudflared public tunnel.
  - The preview push URL handed to the Maker points back at this hub.
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
  - Luca GraphQL queries;
  - WordPress GET;
  - Stripe with test keys and PayPal sandbox.
  - Everything else is refused, and the refusal is recorded with its kind (`paidApi`, `aiCalls`, `prodPublish`, …).

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
- The safe override block comes last.
- `--substitute-test-keys` swaps the live Stripe keys for the Connect test key.

How `dev:safe` behaves:
- It refuses to start when safe mode would be off. `--unsafe-i-know` overrides this.
- It never uses port 3000, which belongs to the Maker.
- It never passes `.env` values to Vite.

Superadmin → **System safety** shows:
- the state, jobs and counters;
- the recent blocked attempts;
- the egress rules;
- the outbox.

Email previews render in a `sandbox=""` iframe, from a signed 10-minute URL that carries no staff token, with a `Content-Security-Policy: sandbox; default-src 'none'` header.

## Soak test

```
npm run soak:safe -- --minutes 20 --env-file <path to the live .env>
```

What it does:
1. Runs the API on port 3191 with a fresh `.local-data/soak`. The soak data is synthetic (`example.invalid` addresses).
2. Forces `HUB_SAFE_MODE=1` and an empty allow list.
3. Preloads `scripts/safe-mode/egress-audit.cjs`. This recorder shares no code with the guard.
4. Drives the prod publish, the Stripe webhook, the tunnel, the Infokort agent and a Fireflies refresh.

It fails on any connection to a host outside `scripts/safe-mode/soak-allowlist.json`. It also fails without:
- an outbox email for the seeded due reminder;
- the expected intents.

The recorder also refuses unlisted hosts, as a safety net. The report goes to `.local-data/soak/soak-report.json`.
