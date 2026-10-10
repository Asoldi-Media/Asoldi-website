---
name: infokort
description: >-
  Perfect a Sales client card: fill missing industry, address, Proff, website,
  Instagram, Facebook, and Google Maps, and check values already stored. Writes
  only 100% matches. Use when the user invokes /infokort, asks to prefill a
  client card, or asks to verify client links and industry.
disable-model-invocation: true
---

# Infokort

Build a complete sales client card. Fill empty fields. Check stored fields. Leave a field empty when nothing is certain. Do not invent a link, industry, or address to look finished.

This is the same bar as the four-client research pass (Mc Verksted, Intermat, Deles / TASS, Bakkes): the page itself must be that company. A guess stays off the card.

Do not run the pipeline. Do not call `POST /api/admin/sales/refresh-upcoming-links` or `discoverSalesLinks` as the writer — those can keep a weak match. Use them only as a search hint, then prove the page.

## Input

The user message is the job:

- One or more sales client **names** and/or **ids** (required). If none, ask and stop. Do not pick a random card.
- Optional mode: `fill` (empty fields only), `check` (stored fields only), or both (default).
- Optional field list: `industry`, `address`, `proff`, `website`, `instagram`, `facebook`, `google`, `other`. If omitted, do all of those.

Several names in one message = one card each, same rules.

## Load the card

Cards live on **asoldi.com**, not the local `sales-clients.json` copy unless the user says local.

1. Read `PROD_ADMIN_USERNAME` and `PROD_ADMIN_PASSWORD` from asoldi-website `.env` (or website-maker `.env`). Never print them.
2. `POST https://asoldi.com/api/admin/login` with `{ "username", "password" }`. Keep `token`.
3. Find the client:
   - Id given → `GET https://asoldi.com/api/admin/sales/<id>`
   - Name only → `GET https://asoldi.com/api/admin/sales`, match `businessName` (ignore `AS` / case). Exact one match, or one exact name among several → use it. Ambiguous → list ids and names, then stop.
4. Keep the live snapshot: `id`, `businessName`, `orgNumber`, `industry`, `meetingPlace`, `businessAddress`, `websiteDomain`, `contactPhone`, `details.instagramUrl`, `details.facebookUrl`, `details.proffUrl`, `details.googleBusinessProfile`, `details.otherLinks`.

Do not change contact person, emails, phone, meeting time, meeting mode, notes, product, owner, or progression.

## Certainty

Write a value only when the opened page is this company:

- Same legal or trading name **and** the same address **or** the same phone (or org.nr on Proff / Brønnøysund / the site).
- Instagram / Facebook: profile name + bio/About + address or phone or official website.
- Google Maps: place name + address or phone. Store `https://maps.google.com/?cid=<digits>` when you have a cid. A Maps pin for a **different** shop stays off, even if it was already on the card.
- Website: the page names this company (about / footer / org.nr). Store the **host** only (`tass.no`), not `https://`.
- Proff: `https://www.proff.no/selskap/x/x/x/<9-digit-orgnr>`. The page must be this org.nr. Fill `orgNumber` from that link when the card lacks it.

**Exclude** when: the page does not exist, the match is another business, you are more unsure than sure, or you only have a similar name in the same town.

Empty is a valid result. Bakkes with only Proff is correct if no public socials or Maps exist.

## Industry and address

**Industry** is what they sell or do, in one short Norwegian word or phrase (`dagligvare`, `motorsykkelverksted`, `markedsplass`, `bilverksted`). Use their own site, Instagram, Facebook, and the live Maps category.

Do **not** copy Brønnøysund `naeringskode` / Proff bransje when that code is leftover or wrong. Deles Are Terjesen is **markedsplass** (TASS), not `reklamebyrå`.

**Address** is the current business address shown on the card (`meetingPlace`, labeled “Business address (shown on map)”). Also set `businessAddress` to the same string when you correct it.

- Prefer the address that Maps + Facebook + the site + Brønnøysund **forretningsadresse** agree on.
- An old Google place with the same phone and a different street is **not** the card address (Meieriveien vs Vasøyveien).
- Tiny spelling drift on Facebook (`Innherrdsvegen`) is not a reason to overwrite a correct card street.

## Research

Per client, in this order:

1. **Registry.** If `orgNumber` or Proff has nine digits: `GET https://data.brreg.no/enhetsregisteret/api/enheter/<orgnr>`. Read name, `forretningsadresse`, `hjemmeside`. Ignore NACE as industry.
2. **Proff.** Open the canonical Proff URL. Confirm name, org.nr, address, phone.
3. **Web search.** Business name + town + org.nr. Open candidates. Do not trust a snippet alone.
4. **Maps.** Search name + street. Confirm the place. Keep cid only for that place.
5. **Site.** Open the homepage and about page when a domain exists.
6. **Instagram and Facebook.** Prefer the logged-in Website Creator browser (Docker `browser` / CDP, cookies in `.generated-runs/quickfill-sessions/instagram.json` and `facebook.json`). Search the business name, then open the profile. Logged-out walls are not proof a page is missing — say so if you could not log in. A logged-in search that finds nothing, plus a stored URL that 404s, is enough to **clear** that URL.
7. **Check mode.** Re-open every stored link. Keep only those that still match. Clear the rest.

`otherLinks`: extra URLs that are 100% theirs and are **not** Instagram, Facebook, Proff, Maps, email, or the website domain. One per line. No duplicates.

## Write

Only after the proof pass. `PUT https://asoldi.com/api/admin/sales/<id>` with the **current** card plus the allowed edits. Copy every other field from GET so contact and meeting stay identical (`lockMeetingSchedule` is already on this route; a changed email can still mail the client).

```json
{
  "product": "<existing>",
  "businessName": "<existing>",
  "contactPerson": "<existing>",
  "contactEmail": "<existing>",
  "websiteEmail": "<existing or empty>",
  "contactPhone": "<existing>",
  "meetingPlace": "<existing or corrected address>",
  "orgNumber": "<existing or from Proff>",
  "businessAddress": "<same as meetingPlace when you corrected address, else existing>",
  "industry": "<existing or corrected>",
  "websiteDomain": "<existing or host>",
  "notes": "<existing>",
  "details": {
    "instagramUrl": "",
    "facebookUrl": "",
    "proffUrl": "https://www.proff.no/selskap/x/x/x/<orgnr>",
    "otherLinks": "",
    "googleBusinessProfile": "https://maps.google.com/?cid=<digits>",
    "editEmailBeforeSend": "<existing boolean>"
  }
}
```

`fill`: write empty fields only. `check`: overwrite a stored value only when it is wrong or unproven. Default: both.

After PUT, read `thankYouSent` and `meetingChanged`. Both must be false. If either is true, say so at the top and stop further writes.

GET the client again. Re-open each URL you just saved. If a saved link fails that reopen, PUT once more to clear it.

## Reply

One short block per client. No code tour.

- Name and id
- Kept / wrote / cleared / left empty, for industry, address, Proff, website, Instagram, Facebook, Google, other
- One line of proof per write (name + address or phone)
- Why a stored value was cleared
- Social login skipped, if the Maker session was missing
