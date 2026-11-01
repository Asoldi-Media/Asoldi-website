# Record of processing: client personal data in the hub

This record lists every store on the hub's data disk that holds personal data about a client, what it holds, why, on which legal basis, how long it is kept and which processors touch it. The registry in `lib/personal-data.js` is the source: `GET /api/admin/system/personal-data-stores` (Superadmin) prints the same list with the retention texts as the code has them. A test (`scripts/personal-data-writers.test.mjs`) fails when a new data file is written through `writeDataJson` or `writeHotJson` without being registered here or listed as holding no client personal data.

Asoldi serves businesses. The personal data is that of the people at a client business (contact person, staff in photos, people in meetings) and of leads.

## Switches

Every part below that writes new data or deletes data is behind a switch in `automation-settings.json` (Superadmin, Automatisering). All are off by default.

| Switch | Off (default) | On |
|---|---|---|
| `privacy.archive.enabled` | Linking a recording writes nothing new. | A copy of the transcript is archived on link and deleted on unlink. |
| `privacy.purge.enabled` | No purge runs; the erase route answers 403. | The daily purge runs; the erase route works (a dry run unless `dryRun: false`). |
| `privacy.purge.mode` | `shadow`: the purge writes only a would-purge report. | `auto`: expired items are deleted. |
| `media.signedUrls.enabled` | The media routes answer 404 `{code:'disabled'}`. | The media manifest and its 24-hour signed download links work. |
| `media.rightsConfirm.enabled` | The portal shows no rights checkbox. | Each upload records "Vi har rett til å bruke disse bildene". |
| `fireflies.candidateRanker.enabled` | No candidates are shown. | Unlinked recordings show ranked client candidates; a person links with one click. The ranker never links. |
| `fireflies.autoLink.enabled` | Nothing links on its own beyond the booked Meet room. | A recording links only when an attendee e-mail equals one client's contact e-mail and a slot the hub booked for that client starts within 30 minutes. |

## Stores

| Store | Personal data | Purpose | Legal basis | Retention | Processors |
|---|---|---|---|---|---|
| Sales and client cards (`sales-clients.json`) | Contact person, e-mail, phone, business details, notes, meeting references | Sales follow-up and delivery | Legitimate interest (leads); contract (clients) | Leads 12 months after the last activity or a decline; clients while the contract runs and 12 months after it ends | Hostinger |
| Offers (`sales-offers.json`) | Offer e-mails, contract party, prices | Offers and the contract | Contract; bookkeeping law once signed | The signed contract as bookkeeping law requires; other offers follow the client card | Hostinger |
| Portal offers (`client-offers.json`) | Acceptance evidence (e-mail, IP address, browser) | Proof of acceptance | Contract | As the signed contract | Hostinger |
| Signed contracts (`inbox-contracts/<client>/`) | Signed contract documents | Proof of the agreement | Legal obligation | Five years after the end of the financial year | Hostinger |
| Client e-mail (`inbox-bot.json`) | Sender, subject, summary and text of client e-mails | Filing client material | Legitimate interest; contract | Follows the client card | Google, Anthropic |
| E-mail attachments (`inbox-bot-staging/<client>/`) | Images and documents sent by e-mail | Client material for the website | Contract | Follows the client card | Hostinger |
| Meeting recordings (`fireflies-meetings.json`, `fireflies-media/`) | Transcripts, attendees, summaries, audio and video | Meeting notes for offers, workshops and the website | Legitimate interest (leads); contract (clients) | One year after the last change | Fireflies |
| Transcript archive (`transcript-archive/<client>/<sha256>.json`) | Full transcripts and attendees | The meeting record behind the delivery brief | Legitimate interest (leads); contract (clients) | Leads 12 months after the last activity or a decline; deferred leads while follow-up runs, then 12 months; clients contract end plus 12 months | Hostinger |
| Delivery briefs (`delivery-briefs/<client>/`) | Facts and short quotes | The brief the website is built from | Contract | Latest version while active; older versions 90 days; all of it 12 months after the contract ends | Anthropic |
| Media manifest (`media-manifest/<client>.json`) | File names, checksums, rights answers | Handing client media to the build | Contract | Follows the client card; links last 24 hours | Hostinger |
| Media rights (`media-rights.json`, client `ext.mediaRights`) | Which uploads the client confirmed, and when | Using client images | Contract | Follows the client card | Hostinger |
| Portal uploads (`client-uploads/<user>/`) | Images, logos, documents | Client material | Contract | Follows the client card | Hostinger, Google |
| Client portal account | Account e-mail, business details, Kundedata, payment status | The portal and payments | Contract; bookkeeping law | While the account exists; the client deletes or deactivates it | Hostinger, Stripe |
| Hub site (`sites.json`) | Site contact e-mail, domain | Running the client site | Contract | While the contract runs | Hostinger |
| Workshop needs, developer requests, SEO client data | What the client asked for, messages, agreed keywords | Building the website | Contract | Follows the client card | Hostinger, DataForSEO |
| Delivery audit, Maker access log, recording link audit, migration reports | Ids only | Tracing changes and access | Legitimate interest | 24, 12 and 24 months (monthly files); the ten newest reports | Hostinger |
| E-mail log (`email-log/`) | Hashed and masked recipient, kind, status | Proof of sending; bounce handling | Legitimate interest; consent proof | 400 days after the month ends | Brevo, Resend |
| Snapshots and automatic backups | Copies of the stores above | Restoring after a failed update or write | Legitimate interest (data safety) | The newest copies; an erase removes the client from them | Hostinger |

AI processing: client data reaches Anthropic and Google only through the hub's LLM layer, and DeepSeek only for the data classes its policy allows (no transcripts).

## Data-subject requests

- **Export.** `GET /api/admin/sales/:id/personal-data-export` (Superadmin) returns one JSON file with every registered store's records and files for the client.
- **Erase.** `POST /api/admin/sales/:id/erase` (Superadmin) answers 403 while `privacy.purge.enabled` is off. It is a dry run unless the body says `dryRun: false`; the dry run lists, per store, what would be deleted, redacted, held or retained. A client with a running contract is erased only with `allowActiveContract: true`. The erase:
  - deletes the client card, unsigned offers, recordings, the transcript archive, briefs, the media manifest, uploads, attachments, workshop needs, developer requests and SEO client data;
  - removes the client from snapshots and automatic backups;
  - blanks the client's e-mail items (sender, subject, text) and keeps their ids;
  - keeps signed contracts, the sent offer of a signed client, accepted portal offers and the client portal account (bookkeeping law and the client's own account);
  - keeps ids-only logs, which are dropped by month;
  - records the erase in the delivery audit with ids only.

## Retention purge

`lib/delivery-retention.js` exports the delivery loop step `retention-purge` (daily). It asks every store with a purge rule for its expired items, using `retention.*`: in `shadow` mode it writes only a report under `privacy/purge-reports/` (ids and paths), in `auto` mode it deletes the items and reports what went. The transcript archive's date is recomputed from the client as it is when the purge runs (signing, a decline or the contract end move it). Nothing is purged while the sales store reads as empty. `GET /api/admin/system/retention-purge` shows the last run; `POST /api/admin/system/retention-purge/run` runs it once (403 while the switch is off).

## Transcript archive

With `privacy.archive.enabled` on, every link of a recording with talk (webhook, pull, paste, admin link, backfill) writes `transcript-archive/<client>/<sha256>.json`, once per transcript text; a newer copy of the same meeting replaces the older one, and an unlink or a move deletes it from the client it left. `node scripts/backfill-transcript-archive.mjs` lists the recordings on cards that have no archived copy (a dry run); `--apply` writes them.

## Recording candidates

With `fireflies.candidateRanker.enabled` on, recordings that are on no card and whose Meet room no client booked show up to five ranked client candidates in the unlinked recordings list (Tilbud), with a purpose pick (`sales`, `workshop`, `iteration`, `demo`). Nothing is linked until a person clicks; that link is the person's link and later automatic passes keep it. Signals: attendee e-mail equals the contact e-mail (+50), attendee domain equals the website domain and is not free mail (+30), within 3 hours of a slot the hub booked (+30), business name in the title (+20), the contact among the speakers (+15), client marked not sold (−20). The link audit (`fireflies-link-audit/`) holds ids only. `scripts/eval/fireflies-rank.mjs <labels.json>` measures top-1 accuracy on a labelled set kept outside this repository.
