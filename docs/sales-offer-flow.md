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
profile) in the persistent data dir, so it survives deploys. Required for the `sales` role and for the admin
sender profile (Admin → Users → *Your sender profile*), optional for everyone else; server-side validation in
`POST/PUT /api/admin/users` and `PUT /api/admin/me/sender`. `data/store.js#seedKnownPhones` backfills known
numbers (alexander@asoldi.com → `+47 923 31 098`) on first read if the stored record has none.

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

* Fred (`fred@fireflies.ai`) is invited on the Google Calendar event only when the
  confirmation is actually sent — after a sales rep is assigned. Silent MyPhoner /
  unassigned calendar creates keep him off the attendee list so Google does not
  save-without-sending. If he was already saved on the event, confirmation send
  removes and re-adds him so Fireflies gets a real invite.
* Calendar sync often never lists sales-page events in Fireflies Upcoming (the
  confirmation From address is Resend, not the Google organizer). At meeting
  start Asoldi also calls Fireflies `addToLiveMeeting` with the Meet link so Fred
  joins even when Upcoming is empty. Retries stay under the API cap (3 / 20 min).
* Webhook `POST /api/webhooks/fireflies?token=…` (`lib/fireflies-webhook.js`) stores the meeting record and runs
  `lib/fireflies-client-match.js`: attendee e-mail = `contactEmail` (+70), attendee domain = client website (+30),
  host = client’s rep (+15), start within 45 min / 3 h of `meetingAt` (+35 / +25), contact name / business name in
  title or attendees (+25 / +20). `high ≥ 70`, `medium ≥ 40`; ties are downgraded so a human confirms.
  Matched meetings land in `client.meetings[]`; the notify e-mail still goes to `FIREFLIES_NOTIFY_EMAIL`.
  A failing notify e-mail no longer fails the webhook (record + match are the primary output).
* Media (video / audio / transcript) is downloaded in the background to `<data>/fireflies-media/<meetingId>/`
  (`lib/fireflies-media.js`, cap `FIREFLIES_MEDIA_MAX_MB`, default 400) and streamed to admins via
  `GET /api/admin/fireflies/meetings/:id/media/:kind?token=…`.
* Admin: list / link / unlink / refresh under `/api/admin/fireflies/meetings…`; UI in
  `MeetingDataPanel.tsx` (Tilbud → Møtedata tab and the unmatched list).

## Data

`data/sales-offers.js` → `sales-offers.json` in the persistent data dir. One active offer per client (the newest
non-sent one). Every transition is appended to `offer.history`.

## Routes

Sales (owner or admin): `GET/PUT /api/admin/sales/:id/offer`, `POST …/offer/new`, `POST …/offer/fill`,
`POST …/offer/preview`, `POST …/offer/approve-preview`, `POST …/offer/request-review`,
`GET …/offer/contract.pdf`, `POST …/offer/send`. Sender profile: `GET/PUT /api/admin/me/sender` (admin).

Admin only: `GET /api/admin/offers[?status=]`, `GET/PUT /api/admin/offers/:id`,
`POST …/:id/client-intent` (refresh the “hva kunden vil ha” briefing), `POST …/:id/reflect-contract`, `PUT …/:id/contract`, `POST …/:id/verify`, `POST …/:id/reopen` (`{toDraft}`),
`GET …/:id/contract.pdf`, `GET /api/admin/offers/contract-template/:tierId.pdf`,
`GET /api/admin/fireflies/meetings[?unmatched=1|clientId=]`, `GET/POST …/:meetingId[/link|/unlink|/refresh]`.

## Tests

`node scripts/sales-offers.test.mjs` (part of `npm test`) covers tiers, e-mail product injection + idempotence,
readiness, PDF generation, the matcher, the AI adapters (with an injected chat) and the store lifecycle.
