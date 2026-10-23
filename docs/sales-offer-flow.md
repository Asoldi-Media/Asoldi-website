# Sales offer flow (tilbud + kontrakt)

How a sales rep turns a client meeting into a sent offer e-mail with the matching contract PDF, and how the
admin reviews custom offers before they go out.

## Roles and pages

| Who | Where | What |
|-----|-------|------|
| Sales rep | `/sales` → client card → **Send tilbud** (also the `Send tilbud` next-action → **Åpne tilbud**) | Opens `/sales/offer?clientId=…` |
| Sales rep | `/sales/offer` (`SalesOfferComposer.tsx`) | Pick tier, AI-fill from the Fireflies meeting, edit the e-mail, preview the contract, send or request admin review |
| Admin | `/admin` → **Tilbud** tab (`OfferReviewSection.tsx`) | Queue of offers waiting for review, e-mail editor, product editor, contract summary editor, meeting data, verify |
| Admin | `/admin` → Tilbud → **ukoblede Fireflies-møter** | Link recorded meetings that could not be matched automatically |

## Status lifecycle

```
draft ──(request review)──▶ review-requested ──(verify)──▶ verified ──(send)──▶ sent
  ▲                                │   ▲                        │
  └──────── tilbake til selger ────┘   └──── åpne for redigering ┘
```

* `draft` – rep is editing; autosaves every 1.5 s. Tier 1–3 without the “Kjør via admin først” flag can be sent
  straight away.
* `review-requested` – rep clicked **Se gjennom tilbud (admin)**. Content is locked for the rep; admin gets an
  e-mail (`FIREFLIES_NOTIFY_EMAIL`, default `ansatte@asoldi.com`) and the offer shows in the Tilbud queue.
  Opening, refreshing or changing the Fireflies recording does **not** rewrite the e-mail or prices.
* `verified` – admin approved. Content stays locked forever for the rep (no visual editor, no “Generer på nytt”,
  no meeting-quote remake). Admin edits after this drop the offer back to `review-requested` until they verify
  again. The rep can still change **Til**, choose e-post/asoldi.com, and send. `/sales` shows **Tilbud verifisert**
  with a count and a list of business names.
* `sent` – e-mail + contract PDF delivered (BCC copy to the rep). **Nytt tilbud** starts a fresh draft.

**Custom tier (`Skreddersydd`) always requires verification.** Standard tiers require it only when the rep ticks
“Kjør via admin først”. The flag is derived from the server: choosing `custom` forces it on (checkbox locked);
switching from `custom` back to a tier 1–3 clears it; toggling it on a standard tier never changes the tier.

## Hard requirements before sending

`lib/offer-readiness.js` — the offer needs `businessName`, `orgNumber` (9 digits), an address, `contactPerson`,
and `contactEmail`. Org. nr is taken from the proff.no link on the client card (no link, no fetch). The address
is **Business address (shown on map)** (`meetingPlace`), with an older stored forretningsadresse only as fallback.
On the offer page, **Kontraktdata for dette tilbudet** can replace any of those for this send; the X on a field
clears that override. E-post there is the same value as **Til**. Empty overrides fall back to the card.
Enforced in the UI (amber banner) and on the `send` / `request-review` routes (HTTP 400 with the missing labels).

**During the meeting (Kun kontrakt).** Fireflies only finishes after everyone has left, so the transcript-filled
offer letter is often not ready while the client is still purchase-ready. On `/sales/offer`, **Hva som sendes →
Kun kontrakt** sends the agreement without those letter slots. E-post is a short note plus the contract PDF.
Asoldi.com shows the same agreement (the letter above it does not use the transcript). **Hele tilbudet** stays
the default and still refuses to send while template placeholders are open. Skreddersydd and “Kjør via admin
først” still have to be verified before either mode can go out. The sent record stores `sentContent: "contract"`.

**Preview gate.** A rep cannot send until they have opened **Forhåndsvis e-post** (modal with the fully merged
e-mail, subject, attachment name and signature) and clicked *Ser riktig ut – klar til sending*.
`POST …/offer/preview` returns the merged HTML + remaining template placeholders + the send blocker;
`POST …/offer/approve-preview` stores `previewHash` = `offerContentHash(offer)` (tier, products, MVA mode, subject,
preheader, html, contract summary). Any content change invalidates the approval (`offerPreviewIsCurrent`).
The `send` route refuses (400) while the preview is stale or `findOfferPlaceholders(html)` still finds
`[…]`-style template fields (`data-offer-placeholder`). The old “Forhåndsvis PC / telefon” buttons are gone — the
visual editor already has the desktop/phone switch.

**MVA mode.** `offer.mvaIncluded` (default `false` = prices ex. MVA + 25 % on top). When the rep/admin ticks
**Inkluder mva i prisen**, the same product prices are treated as incl. MVA: the e-mail totals show *Pris inkl.
mva / Herav MVA / eks. mva*, the product card says “inkl. mva/mnd”, and the contract PDF states the fee as incl.
MVA (`priceLineFor`). The flag rides along in `offerContentHash`, so flipping it requires a fresh preview.

**Signer phone.** `{{signerPhone}}` / `{{signerEmail}}` in the footer come from the sending account
(`lib/sales-sender.js` → `profile.phone`). Phone lives on `users.json` (per user) and `admin.json` (admin sender
profile) in the persistent data dir, so it survives deploys. The same inbox is treated as one person: a number
saved on the Users row for `damian@asoldi.com` is also used when that person sends as admin, and the other way
around. Required for the `sales` role and for the admin sender profile (Admin → Users → *Your sender profile*),
optional for everyone else; server-side validation in `POST/PUT /api/admin/users` and `PUT /api/admin/me/sender`.
`data/store.js#seedKnownPhones` backfills known numbers (alexander@asoldi.com → `+47 923 31 098`) on first read
if the stored record has none.

## Pricing source of truth

`lib/website-tiers.js` — the only place tier names, monthly ex-MVA prices, page counts (5 / 7 / 10), delivery
weeks and included features live. `app/data/websiteProducts.ts`, `app/data/clientWebsitePlans.ts`,
`app/pages/sales/websitePricing.ts`, `PackageDeals.tsx` and the server all derive from it. Prices are ex. MVA;
`withMva()` adds 25 %. Tier 2 lists Google + Google Maps ranking + AI; only Tier 3 is multilingual.

## E-mail template

`lib/offer-email.js` builds the branded offer e-mail (same layout as the confirmation mails via
`buildSalesLayoutEmail`). Marker elements survive the visual editor:

* `<div id="offer-products">…<div id="offer-products-end">` – the “Hva er inkludert” block. `applyOfferProducts`
  swaps it whenever products change (tier chosen, admin adds a product).
* `data-offer-slot="need|project|terms|benefits|delivery"` – the nuance slots filled by DeepSeek
  (`fillOfferSlots`) or by hand. Terms sit before “Hva er inkludert”. Benefits is one section
  (what they achieve, where the site is built, and why). “Hva som skjer fremover” is fixed copy.

Each product renders: name, “Opp til N sider”, included bullets, monthly price ex. MVA; the totals table shows
ex. MVA, MVA 25 % and incl. MVA **per month** (retainer). The shell has no envelope illustration and the
“Tilbud fra Asoldi” heading is left-aligned (`hideIllustration` / `titleAlign` view options in
`lib/sales-email-layout.js`); `refreshOfferShell` upgrades drafts created before that change on load.

## AI (DeepSeek)

`lib/deepseek.js` (`DEEPSEEK_API_KEY`, optional `DEEPSEEK_MODEL`) + `lib/offer-ai.js`:

* **Hva kunden vil ha** (admin Tilbud) → `summarizeClientIntent` reads transcript, product notes and the selected
  plan into a briefing at the top of the review screen. Regenerates when those sources change.
* **Fyll ut med kundedetaljer** → `fillOfferFromTranscript` reads the linked Fireflies transcript/summary and
  returns `need / project / terms / benefits` for the slots. Disabled (with hint) when no meeting is linked or
  DeepSeek isn’t configured. Nothing runs automatically on a locked offer.
* **Speil e-posten i kontrakten** (admin) → `reflectContractFromEmail` summarises the edited e-mail into a
  contract scope (title, scope sentence, per-product includes ≤ 8 bullets, extra terms, delivery weeks). Prices
  and page counts are re-anchored on the structured product list so the model cannot drift them. Admin can edit
  the summary before verifying.

## Contract PDF

`lib/offer-contract-pdf.js` (pdfkit). Sections follow the original “Web utviklings kontrakt” template: parties,
chosen tier/scope (including monthly SEO/ecommerce work and CMS reporting: none / basic every 14 days / advanced every 7 days), monthly fee ex./incl. MVA,
delivery, payment, ownership/offboarding, then Section 5 service meanings (design, domain, hosting, maintenance, forms, content changes, one-time guidance, SEO, social sync without stored passwords, email lists, analytics, ecommerce) plus the published
`asoldi.com/vilkar`, `asoldi.com/personvern` and `asoldi.com/databehandleravtale`. Late payment follows
Norwegian statutory interest/fees (no NOK 100/day). Liability is capped at six months of fees. The client
keeps permanent ownership of content, design and custom code; Asoldi sends website files within 7 business
days after the subscription ends. Asoldi’s handwritten signature is stamped above the Service Provider line
(`assets/asoldi-contract-signature.png`). Three blank tier templates: `GET /api/admin/offers/contract-template/<tierId>.pdf`.
For an offer: tier contract when only a tier is present; admin-verified summary when custom products exist.

## Fireflies meeting data

* Live join records every booked online meeting (`lib/fireflies-live-sessions.js`, a 60 s loop). Each sales
  meeting, workshop or iteration Møte and recorded Møte action with a real Meet link is one session (room +
  start time), built from the booking itself: no confirmation, calendar guest, "Møtet hatt" tick or done mark
  inside the meeting's window stops it. Two slots on one room and start share one bot.
  * The bot goes in with `addToLiveMeeting` (duration 120 min, the documented maximum) from 3 minutes before
    start. Fireflies' answer only means "dispatched": the bot is an anonymous guest someone in the Meet has to
    let in. Optional `FIREFLIES_LIVE_JOIN_ONE_BOT=1` (default off) is for a Fireflies plan that runs one bot at
    a time: the bot then leaves one minute before the next booked meeting's send, counting only meetings that
    start after this one's booked time.
  * From the first send the loop looks at Fireflies `active_meetings` once a minute. A bot not seen is sent
    again at T+1, T+5 and then every 10 minutes until T+30 (at most 5 sends), once more if it drops out early,
    and once near its end time while the meeting runs on. Never seen: `not-admitted`. A bot in the room before
    T-3 belongs to an earlier meeting there; one room gets at most one knock per 4 minutes, a rep's "send
    again" included. A rejoin after an early leave keeps the card on "ended" unless the bot is seen again.
  * Every send shares one account-wide budget of 3 calls per rolling 20 minutes (Fireflies' limit), kept with
    the sessions in `fireflies-live-sessions.json`. First sends go before retries; a retry or manual send waits
    while first sends due in the next 20 minutes need the budget. At the same start, a meeting the client was
    e-mailed goes first.
  * Request handlers only record the booking and kick the loop. A moved meeting keeps its Meet room; the new
    time is a new session, so the bot is sent in again.
  * The card gets `client.liveRecordings` (state per slot); `POST /api/admin/sales/:id/fireflies/live-join`
    (`{ slotKey }`) queues "send Fireflies again" through the same budget. The `live:` placeholder in
    `client.meetings` is written once per session, only after an accepted send, and carries the same
    `recording` state; intake's `missing`/`empty` and a rep's `declined` on it are never overwritten (only the
    bot back in the room, or an accepted "send again", reopens `missing`/`empty`). A send an older hub made
    (the slot's stamp or placeholder) is picked up and checked, not reported as never sent.
* Fred (`fred@fireflies.ai`) goes on a Google Calendar event only when the mailbox hosting it is known and owns
  the hub's Fireflies key (`lib/fireflies-key-owner.js`; asked once per 6 hours, damian@asoldi.com until then).
  On another rep's event he would start that rep's own Fireflies, whose recording the hub cannot read. He is
  still only added when the confirmation is actually sent, and recording never depends on him.
* Webhook `POST /api/webhooks/fireflies?token=…` (`lib/fireflies-webhook.js`) stores the meeting record and links
  it to a client by its Meet room (see "Fireflies matching" below). Matched meetings land in
  `client.meetings[]`; the notify e-mail still goes to `FIREFLIES_NOTIFY_EMAIL`.
  A failing notify e-mail no longer fails the webhook (record + match are the primary output).
  A V2 `meeting.bot_joined` event marks the live-join session on that room as recording (one cheap read
  finds the room).
* Media (video / audio / transcript) is downloaded in the background to `<data>/fireflies-media/<meetingId>/`
  (`lib/fireflies-media.js`, cap `FIREFLIES_MEDIA_MAX_MB`, default 400) and streamed to admins via
  `GET /api/admin/fireflies/meetings/:id/media/:kind?token=…`.
* Admin: list / link / unlink / refresh under `/api/admin/fireflies/meetings…`; UI in
  `MeetingDataPanel.tsx` (Tilbud → Møtedata tab and the unmatched list).

### Fireflies matching

Every link path (webhook, pull ingest, Tilbud paste, calendar session, admin, the meet-link backfill,
the watchdog) goes through `linkFirefliesMeeting` in server.js, which hands it to
`lib/fireflies-linking.js` (the same module unlinks, excludes, sets a purpose and runs the backfill).
`client.meetings` is the one record of who holds a recording; the stored record's `match` says the same.

* **Client.** `lib/fireflies-client-match.js`: a person's link first (a card that holds it as `manual`,
  `admin:*`, `sales:*` or `developer:*`, or with a picked purpose; else the stored `pin`), then the client
  whose booked Meet room Fireflies' `meeting_link` is. A room two clients hold goes to the one whose
  booked slot the recording started in; with none, existing links stay. A client in the stored
  `excludedClientIds` never gets it back automatically. Title, e-mail and host are never used. An
  automatic link that would break one of these rules is refused (`linkStoredTranscriptToClient` then
  answers null).
* **Slot and purpose.** `lib/fireflies-slots.js`: each booked meeting is a slot (`sales:<ms>`,
  `workshop:<ms>`, `iteration:<ms>`, `action:<id>`). The room decides the purpose; time only picks between
  slots sharing a room. A recording gets the slot key only when it starts inside the slot's session window
  (half an hour before the booked start to the session's end, as the watchdog). A room booked again days
  later (more than three hours from the recording and outside its window) does not take a recording off
  the purpose and slot it was linked with. The recording of the bot capture saw in a placeholder's session
  (`recording.ffMeetingId`) is that slot's. Without a booked room it keeps the purpose it was linked with;
  a person's link (Tilbud paste, admin) inside exactly one slot's window is that slot's, so a meeting held
  in another room covers its placeholder; an earlier room of the client is the sales meeting's only for a
  recording with no purpose; one with nothing takes the nearest slot's purpose within three hours, without
  a key. Purpose and `slotKey` are stored on the row and in `match`; the backfill re-tags rows linked
  before these rules.
* **Placeholders.** A live-join placeholder is dropped (and hidden on the card) only by a recording with
  talk on its own slot that starts in its window, one a person put on that slot, or the bot's own
  recording, and only when it has at least 10 sentences (the offer's `MIN_MEETING_CONTEXT_LINES`): a
  "hallo?" in an open room is a fragment, not the meeting. Live captions, a silent copy, a recording of
  another slot or of none never do, and a placeholder past its deadline stays (the watchdog marks it
  missing). A placeholder from before slots and start times (`live:<client>:open`) goes once a recording of
  its purpose has that much talk. A placeholder has no Fireflies link and is left out of meeting counts.
* **Card rows.** `presentClientMeetings` adds `placeholder`, `duplicateOf`, `partial` (live captions),
  `emptyFinal` (Fireflies finished it and nothing was said), `pendingTranscript` (still on its way, never
  for ever: `meetingTranscriptPending`, shared with the offer page) and the stored copy's `sentenceCount`.
  The activity log uses the card's `duplicateOf` as it is and gives placeholders `firefliesUrl` and `url` ''.
* **One meeting, two recordings.** Recordings in one room that start within 20 minutes, overlap, or follow
  within 5 minutes of the other's end are one meeting, unless they are two booked slots (the sales
  meeting and a Møte right after it); the one with the most talk (sentences, then minutes) is the primary
  and the rest carry `duplicateOf`. Offers seed one per meeting and only sales recordings (workshop and
  iteration ones are listed, not ticked), auto-fill and the meeting counts count meetings, and the
  workshop / iteration slots, Møte actions and the offer lock never move to a copy with less talk; the
  backfill moves a slot that already names a copy to its primary. A booked Møte action only takes a
  recording within three hours of its time.
* **People win.** The backfill never moves or unlinks a person's link, a pin brings a recording back to
  its client, and with no stored record nothing but the old hub's title and name links is cleaned up. A
  store with no records while cards hold recordings is not read as proof: the run is skipped (logged once).
* **Moves clean up.** The client a recording leaves loses it from its slots, actions, open offer and offer
  lock. The lock never names a placeholder or a recording without talk: it follows the sales recording
  with talk (one a person picked as the sales meeting first), and the backfill re-points a lock left on a
  silent fragment or on a recording the old hub moved to another client. The offer page only honours a
  lock that is on the card.
* **Routes.** `POST /api/admin/sales/:id/meetings/:meetingId/purpose` `{ purpose: 'sales' | 'workshop' |
  'iteration' | '' }` (the client's rep or admin) is a person's purpose pick, kept by every automatic pass
  (`''` goes back to automatic). It puts the recording on the booked slot of that purpose the same day (12
  hours either way, so it covers that slot's placeholder); a recording days from any such slot gets the
  purpose and no slot, so a follow-up never hides a booked meeting that was not recorded. A "Salgsmøte"
  pick of a recording with talk moves the offer lock to it. `POST
  /api/admin/fireflies/meetings/:meetingId/exclude` `{ clientId }` ("Ikke denne kunden", the client's rep
  or admin) takes it off that client for good, also a card row that was never stored (a bare stored record
  keeps the exclusion); the admin unlink does the same for the client that held it. A rep's Tilbud paste
  of a recording on another client answers 409 with that client's name, and a rep's title search only
  sees recordings on no card or this one.

### Fireflies transcript intake

The pull ingest (`lib/fireflies-ingest.js`, one tick a minute when `firefliesIngest` runs) is what
brings every recording in; the webhook only makes it sooner.

* **List.** The newest 20 transcripts every tick, stored in one write (none when nothing changed).
  Every 10 minutes, or at once when that page holds nothing known, it pages through
  `transcripts(fromDate)` from a day before the last good scan (14 days on the first run) until a
  page holds only known, unchanged ids, so an outage of any length is caught up.
  `fireflies-ingest-state.json` keeps where the scan left off.
* **Final copies.** Each stored meeting keeps Fireflies' `isLive`, `summaryStatus`, `silent` and a
  `final` flag. A copy is final when it is not live and `summary_status` is processed, skipped or
  failed. Without a status: a row stored before the hub kept this state is final only with a
  summary (otherwise it gets one fetch, which is how summaries that came after the old first
  fetch get in, however old the meeting); fetched talk is final 30 minutes after the hub had it.
  Copies that are not final are fetched again with a doubling pause (`fetch.nextFetchAt`; polls
  of a running meeting every 3 minutes do not count) and given up a week after first seen; a new
  `summary_status` in the list queues one fetch at once. Final copies are never fetched again,
  silent empty ones included. A live or still-processing copy never replaces finished text, and
  a client card that shows less than the stored copy (a summary that came later) is relinked.
* **Live captions.** `transcript(id)` on a running meeting (a live link pasted on Tilbud) returns
  partial captions. They are stored with `partial: true`, and stay so after the call, when
  Fireflies answers with no sentences for a few minutes (`liveEndedAt` marks the end), until a copy
  that is not live replaces them or Fireflies calls the meeting done. Partial copies are never
  final, never e-mailed, never linked to a client that does not already hold them, never the basis
  of a contract-letter fill, and get no media download while live.
* **E-mail.** The recording e-mail waits for the final copy (or 20 minutes after the hub had it as it
  is, counted from the end of the call for a pasted live link) and is retried up to five times, ten
  minutes apart, when the send fails (`fireflies-notified.json` keeps
  `{ at, state: 'sending' | 'sent' | 'failed', attempts }`).
* **Media.** `media.savedAt` is set only when a file is on disk. A failed download is retried with
  fresh signed links and a doubling pause for two days; `too-large` and `disabled` are final.
  Nothing downloads while the data disk has less than `FIREFLIES_MEDIA_MIN_FREE_MB` free (optional,
  default 2048, `0` turns the check off). `transcript.txt` and `summary.json` are written again
  once the summary is in. Nothing is deleted automatically.
* **Missing recordings.** `lib/fireflies-recording-watchdog.js` checks every live-join placeholder
  whose meeting is over. While capture still sees the bot (`recording.state = 'recording'` with a
  `lastSeenAt` under 10 minutes old) the meeting is on, however long it runs. It looks by the bot's
  id, else by the booked Meet link with a start between 30 minutes before the booked start and the
  session's end (sales rooms are reused, so a later meeting there is only offered as a candidate,
  like a same-title recording in another room). A transcript with talk is linked; live captions
  are only "not yet" and are not stored from here; a silent one sets `recording.state = 'empty'`,
  unless a recording on the room is still processing. The session ends at start + booked
  (`durationMinutes` on the placeholder, else 60) or later when capture saw the bot later
  (`lastSeenAt`, `endedAt`); nothing by that end + 90 minutes sets `'missing'` and e-mails
  `FIREFLIES_NOTIFY_EMAIL` and the owning rep once, and so does a recording Fireflies has still not
  finished three hours after that. A missing meeting is looked for hourly for 48 hours, so a late
  transcript still links. Rate limits and network errors never make a meeting missing.
  `POST /api/admin/sales/:id/fireflies/recording` `{ meetingId | slotKey, state: 'declined' }` is
  "Marker uten opptak" from the e-mail: the meeting was held without a recording, or not held.
* **Health.** `GET /api/admin/fireflies/ingest-status` (admin) returns `firefliesIngestStatus()`: last
  tick, last good pull, last error, failures in a row, the Fireflies rate-limit state, pending
  fetches, summaries still processing, missing recordings, the catch-up scan's and the watchdog
  lookups' last success and error, whether safe mode blocks the pull, and where each Fireflies
  file was read from. The owner (`FIREFLIES_ALERT_EMAIL`, optional, default `damian@asoldi.com`)
  gets one e-mail per 12 hours when the pull fails more than 10 times in a row, has not succeeded
  for 30 minutes, the catch-up scan or the watchdog lookups have failed for an hour (try-later
  pauses do not count), or the archive or the e-mail list cannot be read. The stamp is kept in
  memory and on disk, so a disk that refuses the write does not repeat the e-mail.
* While the archive cannot be read at all, the meet-link backfill does not run: an empty read would
  unlink every recording. Pasting a link on Tilbud while Fireflies asks the hub to wait answers
  "Fireflies ber oss vente litt" instead of "Fant ikke møtet".
* The contract-letter fill runs on its own loop behind the same safe-mode switch, and a client
  whose fill changes nothing waits longer each time until its recordings or offer change.

## Data

`data/sales-offers.js` → `sales-offers.json` in the persistent data dir. One active offer per client (the newest
non-sent one). Every transition is appended to `offer.history`.

## Routes

Sales (owner or admin): `GET/PUT /api/admin/sales/:id/offer`, `POST …/offer/new`, `POST …/offer/fill`,
`POST …/offer/preview`, `POST …/offer/approve-preview`, `POST …/offer/request-review`,
`GET …/offer/contract.pdf`, `POST …/offer/send`. Sender profile: `GET/PUT /api/admin/me/sender` (admin).
Fireflies on the card (owner or admin): `POST /api/admin/sales/:id/meetings/:meetingId/purpose`,
`POST /api/admin/fireflies/meetings/:meetingId/exclude` (`{clientId}`).

Admin only: `GET /api/admin/offers[?status=]`, `GET/PUT /api/admin/offers/:id`,
`POST …/:id/client-intent` (refresh the “hva kunden vil ha” briefing), `POST …/:id/reflect-contract`, `PUT …/:id/contract`, `POST …/:id/verify`, `POST …/:id/reopen` (`{toDraft}`),
`GET …/:id/contract.pdf`, `GET /api/admin/offers/contract-template/:tierId.pdf`,
`GET /api/admin/fireflies/meetings[?unmatched=1|clientId=]` (unmatched: on no client's card),
`GET/POST …/:meetingId[/link|/unlink|/refresh]`.

## Tests

`node scripts/sales-offers.test.mjs` (part of `npm test`) covers tiers, e-mail product injection + idempotence,
readiness, PDF generation, the matcher, the AI adapters (with an injected chat) and the store lifecycle.
