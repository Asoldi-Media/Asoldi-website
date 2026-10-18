# Shared tool suite

One media categorizer, one mail/document/facts core, used by website-maker and by asoldi.com (AI assistant + inbox bot). Source of truth is `packages/suite` in **asoldi-website**. website-maker keeps a vendored copy at `lib/suite/`.

## Layers

| Layer | Path | May import | Holds |
|---|---|---|---|
| **Core** | `packages/suite/core/` | `node:*`, other core files, optional deps (`sharp`, `image-size`, `adm-zip`, `xlsx`) via lazy/dynamic import | Format conversion, Gemini vision client, merge math, IMAP/MIME, document text, inbox pipeline |
| **Harness** | `packages/suite/harness/asoldi/` | core + its own folder only | Data and prompt text: Kundedata schema, maker field map, Norwegian rules, inbox kinds, tone brief |
| **App** | `lib/ai-assistant/*`, `lib/inbox-bot/*`, website-maker `lib/media-transcript.js` | core + harness + the rest of that app | I/O, storage, sales match, send, calendar, contracts |

A boundary test (`scripts/suite-boundary.test.mjs`) fails if core mentions Asoldi/Kundedata, if `core/media` imports `fs`, or if the harness imports app code.

The categorizer stores nothing. `describeMedia` takes a buffer, converts formats in memory (SVG/GIF/AVIF → PNG/JPEG), calls Gemini, returns a ~1–2 KB JSON brief. Each app decides what to keep: website-maker writes `.generated-runs/` on the developer machine; asoldi.com keeps briefs in the client bank (capped). No extra media copies on Hostinger from this layer.

## Sync rule

Edit only `asoldi-website/packages/suite`. Then:

```bash
node scripts/sync-suite.mjs
```

That copies the folder to `../website-maker/lib/suite` and writes `suite.manifest.json` (sha256 per file) into both copies. Drift tests in both repos (`scripts/suite-drift.test.mjs`) recompute the hashes. Never edit the vendored copy.

website-maker tests that load the suite run **inside the Docker app container** (`docker exec website-maker-app-1 …`), where `sharp` is installed.

## What lives where

- **Media:** `core/media` (formats, measure, prompt, normalize, gemini, describe) + `harness/asoldi/media.js` (maker fields, Kundedata buckets, `productInfo`).
- **Mail:** `core/mail` (MIME, IMAP with credentials passed in, thread trim, zip/TNEF). Env lookup `INBOX_IMAP_*` stays in the app.
- **Documents:** `core/documents` (kind sniff + text). PDF subprocess and product OCR stay injected from the app.
- **Facts:** `core/facts` (add/replace/delete merge, English default prompt) + `harness/asoldi/facts.js` (Kundedata schema + Norwegian prompt text, shipped verbatim).
- **Inbox:** `core/inbox/pipeline.js` (adapters) + `harness/asoldi/inbox.js` (kinds, brief, categorize/decide prompt text). Sales match, `write.js`, contracts, calendar, Resend stay in the app.

## Standalone bot later (option B)

Do not rewrite the core. Add:

1. A new harness (`harness/<product>/`) with that business’s field schema, language, kinds, and tone.
2. App adapters: CRM match, calendar, sender, storage.
3. Move `packages/suite` into its own repo or npm package. website-maker and asoldi.com keep the same vendored copy (or switch the sync script to that package). The boundary tests stay.

## Production notes

- asoldi.com needs `GEMINI_API_KEY` and Hostinger `npm install` of `sharp` (prebuilt `@img/sharp-linux-x64`). First deploy after this change is the check.
- Real Outlook `winmail.dat` and Mac `.pages` were not re-tested against live files; the unpackers are the same as before the split.
